// Integration test for the per-site blocking toggle, driven through the real service worker.
//
// "Turning blocking off for one site does nothing, but Pause everywhere works" was reported
// against 2.1.0. Every layer looked correct in isolation, and the reason it could still fail
// was structural: handleToggleSite awaited Promise.all([syncAllowlist, syncRegisteredScripts]).
// Cosmetic registration carries one match pattern per generichide exception plus the user's
// allowlist — thousands in a single call — and if it rejected, Promise.all rejected, the
// message handler answered null, and the popup's render(null) threw inside an async listener.
// The allowlist was already written and the network layer already off, but nothing said so
// and the switch stayed where the user left it. Pause escaped it by unregistering instead.
//
// So this asserts the toggle reports success and writes its DNR rule even when the cosmetic
// half fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// license.ts imports extpay, which does not resolve on platform:'neutral'.
const stubDir = mkdtempSync(join(tmpdir(), 'stampstack-extpay-'));
const extpayStub = join(stubDir, 'extpay.js');
writeFileSync(
  extpayStub,
  'export default function ExtPay(){return{getUser:async()=>({paid:false}),' +
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

const noopEvent = () => ({ addListener() {}, removeListener() {} });

/**
 * Load a fresh service worker against a fake chrome.
 * `failRegistration` simulates chrome.scripting rejecting a pattern batch.
 */
async function bootServiceWorker({ host, failRegistration = false }) {
  const store = {};
  let dynamicRules = [];
  let registered = [];
  let enabledRulesets = [];
  let listener = null;

  const chrome = {
    runtime: {
      getManifest: () => ({ version: '0.0.0-test' }),
      onMessage: { addListener: (fn) => (listener = fn) },
      onInstalled: noopEvent(),
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
        set: async (o) => Object.assign(store, o),
        remove: async (k) => {
          for (const key of Array.isArray(k) ? k : [k]) delete store[key];
        },
      },
      onChanged: noopEvent(),
    },
    declarativeNetRequest: {
      DYNAMIC: 'dynamic',
      SESSION: 'session',
      getDynamicRules: async () => dynamicRules.slice(),
      updateDynamicRules: async ({ removeRuleIds = [], addRules = [] }) => {
        dynamicRules = dynamicRules.filter((r) => !removeRuleIds.includes(r.id)).concat(addRules);
      },
      getEnabledRulesets: async () => enabledRulesets.slice(),
      updateEnabledRulesets: async ({ enableRulesetIds = [], disableRulesetIds = [] }) => {
        enabledRulesets = enabledRulesets
          .filter((id) => !disableRulesetIds.includes(id))
          .concat(enableRulesetIds.filter((id) => !enabledRulesets.includes(id)));
      },
    },
    scripting: {
      getRegisteredContentScripts: async () => registered.map((r) => ({ ...r })),
      registerContentScripts: async (s) => {
        if (failRegistration) throw new Error('simulated: pattern batch rejected');
        registered.push(...s);
      },
      unregisterContentScripts: async ({ ids = [] } = {}) => {
        registered = registered.filter((r) => !ids.includes(r.id));
      },
      updateContentScripts: async (s) => {
        if (failRegistration) throw new Error('simulated: pattern batch rejected');
        for (const n of s) {
          const i = registered.findIndex((r) => r.id === n.id);
          if (i >= 0) registered[i] = n;
        }
      },
      executeScript: async () => [],
    },
    tabs: {
      query: async () => [{ id: 1, url: `https://${host}/a/page` }],
      sendMessage: async () => null,
      onRemoved: noopEvent(),
      onUpdated: noopEvent(),
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    management: { getSelf: async () => ({ installType: 'normal' }) },
    commands: { onCommand: noopEvent() },
    webNavigation: { onBeforeNavigate: noopEvent() },
  };

  globalThis.chrome = chrome;
  // Cache-bust so each test gets its own module instance bound to its own fake.
  const url =
    'data:text/javascript;base64,' +
    Buffer.from(`${bundle}\n//${Math.random().toString(36).slice(2)}`).toString('base64');
  await import(url);

  assert.ok(listener, 'service worker registered no onMessage listener');
  // The handlers read chrome.* when they run, not at import, so the fake has to be the live
  // global for the whole call — not just while the module was loading.
  const send = (msg) => {
    globalThis.chrome = chrome;
    return new Promise((resolve) => {
      if (listener(msg, {}, resolve) !== true) resolve(undefined);
    });
  };

  return {
    send,
    settings: () => store['stampstack.settings'],
    rules: () => dynamicRules,
    script: (id) => registered.find((r) => r.id === id),
  };
}

const HOST = 'www.theguardian.com';

test('toggling blocking off writes the allowlist and an allowAllRequests rule', async () => {
  const sw = await bootServiceWorker({ host: HOST });
  await sw.send({ type: 'popup:get' });

  const data = await sw.send({ type: 'popup:toggleSite', hostname: HOST, enabled: false });
  assert.ok(data, 'toggle must not answer null');
  assert.equal(data.allowlisted, true);

  // www is stripped, so the stored host also covers the bare domain.
  assert.deepEqual(sw.settings().allowlist, ['theguardian.com']);

  const allow = sw.rules().filter((r) => r.action?.type === 'allowAllRequests');
  assert.equal(allow.length, 1);
  assert.deepEqual(allow[0].condition.requestDomains, ['theguardian.com']);
  // allowAllRequests is only valid for frame types, and must out-rank every static block rule
  // (the compiler caps those well below this).
  assert.deepEqual(allow[0].condition.resourceTypes, ['main_frame', 'sub_frame']);
  assert.ok(allow[0].priority > 3500);
});

test('the allowlisted host is excluded from generic cosmetics', async () => {
  const sw = await bootServiceWorker({ host: HOST });
  await sw.send({ type: 'popup:get' });
  await sw.send({ type: 'popup:toggleSite', hostname: HOST, enabled: false });

  const excl = sw.script('quell-generic-cosmetic')?.excludeMatches ?? [];
  for (const pattern of [
    '*://theguardian.com/*',
    '*://*.theguardian.com/*',
    '*://www.theguardian.com/*',
  ]) {
    assert.ok(excl.includes(pattern), `missing exclude ${pattern}`);
  }
});

test('a cosmetic registration failure still leaves network blocking off for the site', async () => {
  // Note what this does and does not prove. syncRegisteredScripts already swallows its own
  // errors, so it cannot reject and the handler cannot answer null through this path — this
  // passes with or without the allSettled change in handleToggleSite. What it does pin is that
  // a cosmetic failure never costs the user the network allowlist, and that the failure is
  // invisible to them: nothing in the returned PopupData says cosmetics are stale, so element
  // hiding would continue on a site they just switched off with no way to tell.
  const sw = await bootServiceWorker({ host: HOST, failRegistration: true });
  await sw.send({ type: 'popup:get' });

  const data = await sw.send({ type: 'popup:toggleSite', hostname: HOST, enabled: false });
  assert.ok(data);
  assert.equal(data.allowlisted, true);
  assert.deepEqual(sw.settings().allowlist, ['theguardian.com']);
  assert.equal(sw.rules().filter((r) => r.action?.type === 'allowAllRequests').length, 1);
  // The stale-cosmetics state is currently unreportable. If that ever becomes a field on
  // PopupData, this is the test that should start asserting it.
  assert.equal('cosmeticsStale' in data, false);
});

test('toggling blocking back on removes the allowlist entry and the rule', async () => {
  const sw = await bootServiceWorker({ host: HOST });
  await sw.send({ type: 'popup:get' });
  await sw.send({ type: 'popup:toggleSite', hostname: HOST, enabled: false });

  const data = await sw.send({ type: 'popup:toggleSite', hostname: HOST, enabled: true });
  assert.ok(data);
  assert.equal(data.allowlisted, false);
  assert.deepEqual(sw.settings().allowlist, []);
  assert.equal(sw.rules().filter((r) => r.action?.type === 'allowAllRequests').length, 0);
});

test('a parent-domain entry is dropped when re-enabling a subdomain', async () => {
  // example.com allowlists sub.example.com, so deleting only the exact host would let the
  // toggle spring back with no explanation.
  const sw = await bootServiceWorker({ host: 'sub.example.com' });
  await sw.send({ type: 'popup:get' });
  await sw.send({ type: 'popup:toggleSite', hostname: 'example.com', enabled: false });
  assert.deepEqual(sw.settings().allowlist, ['example.com']);

  await sw.send({ type: 'popup:toggleSite', hostname: 'sub.example.com', enabled: true });
  assert.deepEqual(sw.settings().allowlist, []);
});

test.after(() => rmSync(stubDir, { recursive: true, force: true }));
