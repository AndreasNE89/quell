// Paid dark mode is switched on automatically once — at the first unlock — and never again.
//
// Every unpaid→paid transition reaches the service worker's unlock listener: a first purchase,
// but also a buyer whose 14-day offline grace ran out and was re-verified, or a refund followed
// by a re-purchase. The listener used to set darkModeEnabled = true unconditionally, so a user
// who had turned dark mode off got it forced back on by nothing more than a spell offline.
//
// Driven through the real service worker against a fake chrome, like test/site-toggle.test.mjs,
// with a controllable ExtensionPay stub standing in for the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SETTINGS_KEY = 'stampstack.settings';
const LICENSE_KEY = 'stampstack.license';
const AUTO_ENABLE_KEY = 'stampstack.darkAutoEnable.v1';
const DAY = 24 * 60 * 60 * 1000;

// getUser() answers whatever the test last put in globalThis.__extpayUser; an Error is thrown,
// which is how refreshLicense sees an outage.
const stubDir = mkdtempSync(join(tmpdir(), 'stampstack-unlock-'));
const extpayStub = join(stubDir, 'extpay.js');
writeFileSync(
  extpayStub,
  'export default function ExtPay(){return{' +
    'getUser:async()=>{const u=globalThis.__extpayUser;if(u instanceof Error)throw u;return u;},' +
    'onPaid:{addListener(){}},openPaymentPage(){},openLoginPage(){},startBackground(){}};}\n',
);

const bundle = (
  await build({
    entryPoints: ['src/background/service-worker.ts'],
    bundle: true,
    format: 'esm',
    write: false,
    platform: 'neutral',
    alias: { extpay: extpayStub },
    logLevel: 'silent',
  })
).outputFiles[0].text;

let moduleSeq = 0;
const noopEvent = () => ({ addListener() {}, removeListener() {} });

async function bootServiceWorker(seed = {}) {
  const store = { ...seed };
  let registered = [];
  let listener = null;
  let onInstalled = null;
  let initsDone = 0;

  const chrome = {
    runtime: {
      getManifest: () => ({ version: '0.0.0-test' }),
      onMessage: { addListener: (fn) => (listener = fn) },
      onInstalled: { addListener: (fn) => (onInstalled = fn) },
      onStartup: noopEvent(),
      id: 'test',
    },
    storage: {
      local: {
        get: async (k) => {
          if (k == null) return { ...store };
          const out = {};
          for (const key of Array.isArray(k) ? k : [k]) if (key in store) out[key] = store[key];
          return out;
        },
        set: async (o) => Object.assign(store, structuredClone(o)),
        remove: async (k) => {
          for (const key of Array.isArray(k) ? k : [k]) delete store[key];
        },
      },
      onChanged: noopEvent(),
    },
    declarativeNetRequest: {
      DYNAMIC: 'dynamic',
      SESSION: 'session',
      getDynamicRules: async () => [],
      updateDynamicRules: async () => {},
      getEnabledRulesets: async () => [],
      updateEnabledRulesets: async () => {},
    },
    scripting: {
      getRegisteredContentScripts: async () => registered.map((r) => ({ ...r })),
      registerContentScripts: async (s) => void registered.push(...s),
      unregisterContentScripts: async ({ ids = [] } = {}) => {
        registered = registered.filter((r) => !ids.includes(r.id));
      },
      updateContentScripts: async (s) => {
        for (const n of s) {
          const i = registered.findIndex((r) => r.id === n.id);
          if (i >= 0) registered[i] = n;
        }
      },
      executeScript: async () => [],
      removeCSS: async () => {},
    },
    tabs: {
      query: async () => [{ id: 1, url: 'https://example.com/' }],
      sendMessage: async () => null,
      onRemoved: noopEvent(),
      onUpdated: noopEvent(),
    },
    // init() ends here, so counting calls is how a test knows a start has finished.
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => void initsDone++,
    },
    management: { getSelf: async () => ({ installType: 'normal' }) },
    commands: { onCommand: noopEvent() },
    webNavigation: { onBeforeNavigate: noopEvent() },
  };

  globalThis.chrome = chrome;
  const file = join(stubDir, `sw-${moduleSeq++}.mjs`);
  writeFileSync(file, bundle);
  await import(pathToFileURL(file).href);

  const inits = async (n) => {
    for (let i = 0; i < 500 && initsDone < n; i++) await new Promise((r) => setTimeout(r, 1));
    assert.ok(initsDone >= n, `service worker init #${n} never finished`);
  };
  await inits(1); // the module-scope wake

  const send = (msg) => {
    globalThis.chrome = chrome;
    return new Promise((resolve) => {
      if (listener(msg, {}, resolve) !== true) resolve(undefined);
    });
  };

  return {
    send,
    store,
    darkEnabled: () => store[SETTINGS_KEY]?.darkModeEnabled,
    /** Simulate chrome.runtime.onInstalled (an extension update), i.e. init('full'). */
    update: async () => {
      globalThis.chrome = chrome;
      onInstalled({ reason: 'update' });
      await inits(2);
    },
  };
}

/** Grace runs out offline, then the provider confirms the purchase again. */
async function loseAndRegain(sw) {
  sw.store[LICENSE_KEY] = { ...sw.store[LICENSE_KEY], verifiedAt: Date.now() - 15 * DAY };
  globalThis.__extpayUser = new Error('offline');
  const lapsed = await sw.send({ type: 'license:refresh' });
  assert.equal(lapsed.paid, false, 'grace should have expired while offline');
  assert.equal(sw.store[LICENSE_KEY].paid, false);

  globalThis.__extpayUser = { paid: true, email: 'buyer@example.com' };
  const back = await sw.send({ type: 'license:refresh' });
  assert.equal(back.paid, true, 're-verification should unlock again');
}

test('the first unlock switches dark mode on', async () => {
  globalThis.__extpayUser = { paid: false };
  const sw = await bootServiceWorker();
  assert.notEqual(sw.darkEnabled(), true);

  globalThis.__extpayUser = { paid: true, email: 'buyer@example.com' };
  const lic = await sw.send({ type: 'license:refresh' });
  assert.equal(lic.paid, true);
  assert.equal(sw.darkEnabled(), true, 'a new buyer should see what they paid for');
  assert.equal(sw.store[AUTO_ENABLE_KEY], true);
});

test('losing and regaining the license keeps dark mode off if the user turned it off', async () => {
  globalThis.__extpayUser = { paid: false };
  const sw = await bootServiceWorker();
  globalThis.__extpayUser = { paid: true, email: 'buyer@example.com' };
  await sw.send({ type: 'license:refresh' });
  assert.equal(sw.darkEnabled(), true);

  const off = await sw.send({ type: 'darkmode:setEnabled', enabled: false });
  assert.equal(off.enabled, false);

  await loseAndRegain(sw);
  assert.equal(sw.darkEnabled(), false, 'regaining the license must not override the choice');
});

test('a buyer from before the flag existed is not auto-enabled again after an update', async () => {
  // Paid, dark mode deliberately off, and no flag: the state an existing customer upgrades into.
  globalThis.__extpayUser = { paid: true, email: 'buyer@example.com' };
  const sw = await bootServiceWorker({
    [LICENSE_KEY]: { paid: true, provider: 'extensionpay', verifiedAt: Date.now() },
    [SETTINGS_KEY]: { darkModeEnabled: false },
  });
  await sw.update();
  assert.equal(sw.store[AUTO_ENABLE_KEY], true, 'the update should record the spent auto-enable');
  assert.equal(sw.darkEnabled(), false);

  await loseAndRegain(sw);
  assert.equal(sw.darkEnabled(), false);
});

test.after(() => {
  delete globalThis.__extpayUser;
  rmSync(stubDir, { recursive: true, force: true });
});
