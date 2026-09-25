// Integration test for the per-site blocking toggle, driven through the real service worker.
//
// "Turning blocking off for one site does nothing, but Pause everywhere works" was reported
// against 2.1.0. These tests were written while hunting that, and they all passed — because the
// actual cause was upstream of everything here: the popup's switch had no clickable area, so
// popup:toggleSite was never sent. See test/popup-controls.test.mjs, which is the test that
// would have caught it.
//
// Kept anyway. This file pins the whole allowlist path end to end through the real service
// worker — storage, the allowAllRequests rule, its priority relative to static rules, and the
// cosmetic excludes — none of which had coverage before. It is also a standing reminder that a
// green service-worker suite says nothing about whether the UI can reach it.
//
// The chrome.scripting fake follows Chrome where it matters (REVIEW_2026-09-24 B3/B4): it
// honors `{ids}`, rejects a whole call over one unknown id or one pattern Chrome cannot parse,
// and treats updateContentScripts as a patch of a live id. A lenient fake is why an invalid
// exclude pattern taking down generic hiding for every zh-* install went unnoticed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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

let moduleSeq = 0;

const noopEvent = () => ({ addListener() {}, removeListener() {} });

/**
 * The part of Chrome's match-pattern parser (extensions/common/url_pattern.cc) that decides
 * whether a host is acceptable. Host canonicalization is the WHATWG URL parser's, which applies
 * Chrome's rule that a host ending in a number is IPv4: `www.10.0.0` fails, and so does the
 * whole registerContentScripts call that carries it. test/hostname-patterns.test.mjs holds the
 * full model and checks it against what a real Chromium accepted.
 */
function patternIsValid(pattern) {
  if (pattern === '<all_urls>') return true;
  const m = /^(\*|https?|file|ftp):\/\/([^/]*)\//.exec(pattern);
  if (!m) return false;
  let host = m[2].replace(/:(\*|\d+)$/, '');
  if (host === '*') return true;
  if (host.startsWith('*.')) host = host.slice(2);
  if (!host || host.includes('*') || /[\u0000-\u0020#%/:<>?@\\^|\u007f]/.test(host)) return false;
  try {
    return !!new URL(`http://${host}/`).hostname;
  } catch {
    return false;
  }
}

function assertScriptsValid(scripts) {
  for (const s of scripts) {
    for (const key of ['matches', 'excludeMatches']) {
      (s[key] ?? []).forEach((p, i) => {
        if (!patternIsValid(p)) {
          const field = key === 'matches' ? 'matches' : 'exclude_matches';
          throw new Error(
            `Script with ID '${s.id}' has invalid value for ${field}[${i}]: Invalid host.`,
          );
        }
      });
    }
  }
}

/** What Chrome said when a long Windows profile path broke updateDynamicRules (diagnosis C11). */
const DNR_INTERNAL_ERROR = 'Internal error while updating dynamic rules.';

/**
 * Load a fresh service worker against a fake chrome.
 * `failRegistration` simulates chrome.scripting rejecting every payload; the returned
 * `failNext(ids)` rejects only the next payload for each listed script id.
 * `refuseDynamicRules` makes every updateDynamicRules call reject, as Chrome does, without
 * changing anything; the returned `refuseDynamicRules(bool)` switches that later.
 * `settings`, `dynamicRules` and `registered` seed state left behind by an earlier build.
 */
async function bootServiceWorker({
  host,
  failRegistration = false,
  refuseDynamicRules = false,
  settings,
  license,
  dynamicRules: seedRules = [],
  registered: seedScripts = [],
  session: seedSession = {},
}) {
  const store = {};
  const sessionStore = structuredClone(seedSession);
  let fullReads = 0;
  if (settings) store['stampstack.settings'] = settings;
  if (license) store['stampstack.license'] = license;
  let dynamicRules = seedRules.map((r) => structuredClone(r));
  let registered = seedScripts.map((r) => structuredClone(r));
  let enabledRulesets = [];
  let listener = null;
  const executed = [];
  const registerLog = [];
  let rejectNext = new Set();
  let refuseDynamic = refuseDynamicRules;
  // Every fake chrome call bumps this, so settle() can tell when the worker has gone quiet.
  let activity = 0;
  const rejectPayload = (scripts) => {
    if (failRegistration) throw new Error('simulated: pattern batch rejected');
    const hit = scripts.find((s) => rejectNext.has(s.id));
    if (hit) {
      rejectNext.delete(hit.id);
      throw new Error(`simulated: Chrome rejected '${hit.id}'`);
    }
    assertScriptsValid(scripts);
  };

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
      session: {
        get: async (k) => {
          activity++;
          const out = {};
          for (const key of Array.isArray(k) ? k : [k]) if (key in sessionStore) out[key] = structuredClone(sessionStore[key]);
          return out;
        },
        set: async (o) => {
          activity++;
          Object.assign(sessionStore, structuredClone(o));
        },
        remove: async (k) => {
          activity++;
          for (const key of Array.isArray(k) ? k : [k]) delete sessionStore[key];
        },
      },
      onChanged: noopEvent(),
    },
    declarativeNetRequest: {
      DYNAMIC: 'dynamic',
      SESSION: 'session',
      getDynamicRules: async () => {
        activity++;
        return dynamicRules.map((r) => structuredClone(r));
      },
      updateDynamicRules: async ({ removeRuleIds = [], addRules = [] }) => {
        activity++;
        // Chrome applies an update whole or not at all.
        if (refuseDynamic) throw new Error(DNR_INTERNAL_ERROR);
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
      getRegisteredContentScripts: async ({ ids } = {}) => {
        activity++;
        if (!ids) fullReads++;
        return registered
          .filter((r) => !ids || ids.includes(r.id))
          .map((r) => structuredClone(r));
      },
      registerContentScripts: async (s) => {
        activity++;
        registerLog.push(...s.map((n) => n.id));
        rejectPayload(s);
        for (const n of s) {
          if (registered.some((r) => r.id === n.id)) {
            throw new Error(`Duplicate script ID '${n.id}'`);
          }
        }
        registered.push(...s.map((n) => structuredClone(n)));
      },
      unregisterContentScripts: async ({ ids } = {}) => {
        activity++;
        // All or nothing: one id that is not registered fails the whole call.
        for (const id of ids ?? []) {
          if (!registered.some((r) => r.id === id)) throw new Error(`Nonexistent script ID '${id}'`);
        }
        registered = ids ? registered.filter((r) => !ids.includes(r.id)) : [];
      },
      updateContentScripts: async (s) => {
        activity++;
        for (const n of s) {
          if (!registered.some((r) => r.id === n.id)) {
            throw new Error(`Script with ID '${n.id}' does not exist or is not fully registered`);
          }
        }
        rejectPayload(s);
        for (const n of s) {
          const i = registered.findIndex((r) => r.id === n.id);
          registered[i] = { ...registered[i], ...structuredClone(n) };
        }
      },
      executeScript: async (details) => {
        activity++;
        executed.push(structuredClone(details));
        return [];
      },
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
  // Import from a real file, not a data: URL. These tests deliberately make the service worker
  // log an error, and with a data: URL every frame of that stack trace embeds the whole ~4 MB
  // base64 bundle. Locally that is merely ugly; on a CI runner the log writer stalls for half
  // an hour on the multi-megabyte lines. A temp file keeps stack frames to a path.
  // The unique filename is also what gives each test its own module instance.
  const file = join(stubDir, `sw-${moduleSeq++}.mjs`);
  writeFileSync(file, bundle);
  await import(pathToFileURL(file).href);

  assert.ok(listener, 'service worker registered no onMessage listener');
  // The handlers read chrome.* when they run, not at import, so the fake has to be the live
  // global for the whole call — not just while the module was loading.
  const send = (msg, sender = {}) => {
    globalThis.chrome = chrome;
    return new Promise((resolve) => {
      if (listener(msg, sender, resolve) !== true) resolve(undefined);
    });
  };

  /** Wait until the worker has made no chrome call for several macrotask turns. */
  const settle = async () => {
    let seen = -1;
    let quiet = 0;
    for (let turns = 0; quiet < 10 && turns < 1000; turns++) {
      globalThis.chrome = chrome;
      await new Promise((r) => setTimeout(r, 0));
      if (activity === seen) {
        quiet++;
      } else {
        quiet = 0;
        seen = activity;
      }
    }
    assert.equal(quiet, 10, 'the service worker never went quiet');
  };

  return {
    send,
    settle,
    settings: () => store['stampstack.settings'],
    rules: () => dynamicRules,
    script: (id) => registered.find((r) => r.id === id),
    scripts: () => registered,
    executed: () => executed,
    registerLog: () => registerLog,
    session: () => sessionStore,
    fullReads: () => fullReads,
    failNext: (ids) => (rejectNext = new Set(ids)),
    refuseDynamicRules: (on) => (refuseDynamic = on),
  };
}

/** Run `fn` with console.error captured; returns what was logged, one string per call. */
async function capturingErrors(fn) {
  const logged = [];
  const origError = console.error;
  console.error = (...args) => logged.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.error = origError;
  }
  return logged;
}

const HOST = 'www.theguardian.com';

test('toggling blocking off writes the allowlist and an allowAllRequests rule', async () => {
  const sw = await bootServiceWorker({ host: HOST });
  await sw.send({ type: 'popup:get' });

  const data = await sw.send({ type: 'popup:toggleSite', hostname: HOST, enabled: false });
  assert.ok(data, 'toggle must not answer null');
  assert.equal(data.applied, true);
  assert.equal(data.allowlisted, true);

  // www is stripped, so the stored host also covers the bare domain.
  assert.deepEqual(sw.settings().allowlist, ['theguardian.com']);

  const allow = sw.rules().filter((r) => r.action?.type === 'allowAllRequests');
  assert.equal(allow.length, 1);
  assert.deepEqual(allow[0].condition.requestDomains, ['theguardian.com']);
  // allowAllRequests is only valid for frame types, and must out-rank every static block rule
  // (the compiler caps those well below this). main_frame alone: that already allows the whole
  // frame tree of an allowlisted page. sub_frame would also allow theguardian.com iframes
  // embedded on every OTHER site (B7).
  assert.deepEqual(allow[0].condition.resourceTypes, ['main_frame']);
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
  // Note what this does and does not prove. syncRegisteredScripts swallows its own errors, so
  // it cannot reject and the handler cannot answer null through this path. What this pins is
  // that a cosmetic failure never costs the user the network allowlist, and that the failure is
  // invisible to them: nothing in the returned PopupData says cosmetics are stale, so element
  // hiding would continue on a site they just switched off with no way to tell.
  const sw = await bootServiceWorker({ host: HOST, failRegistration: true });
  await sw.send({ type: 'popup:get' });

  const data = await sw.send({ type: 'popup:toggleSite', hostname: HOST, enabled: false });
  assert.ok(data);
  assert.equal(data.applied, true, 'the network switch did take effect');
  assert.equal(data.allowlisted, true);
  assert.deepEqual(sw.settings().allowlist, ['theguardian.com']);
  assert.equal(sw.rules().filter((r) => r.action?.type === 'allowAllRequests').length, 1);
  // The stale-cosmetics state is currently unreportable. If that ever becomes a field on
  // PopupData, this is the test that should start asserting it.
  assert.equal('cosmeticsStale' in data, false);
});

test('a switch Chrome refuses is reported as not applied, and nothing is stored (C11)', async () => {
  // updateDynamicRules used to be logged and forgotten: the popup then said "off for this site"
  // while every request was still blocked, so the user's way out silently did nothing.
  const sw = await bootServiceWorker({ host: HOST });
  await sw.settle();
  const before = structuredClone(sw.script('quell-generic-cosmetic'));
  sw.refuseDynamicRules(true);

  let data;
  const logged = await capturingErrors(async () => {
    data = await sw.send({ type: 'popup:toggleSite', hostname: HOST, enabled: false });
    await sw.settle();
  });
  assert.ok(data, 'the toggle must still answer');
  assert.equal(data.applied, false);
  assert.equal(data.allowlisted, false, 'the popup must show blocking as still on');
  assert.equal(data.hostname, HOST);
  assert.deepEqual(sw.settings()?.allowlist ?? [], [], 'a refused switch must not be stored');
  assert.equal(sw.rules().filter((r) => r.action?.type === 'allowAllRequests').length, 0);
  // Element hiding stays on too, so the layers agree with each other and with the popup.
  assert.deepEqual(sw.script('quell-generic-cosmetic'), before);
  assert.ok(logged.some((l) => l.includes(DNR_INTERNAL_ERROR)), 'the cause is logged');

  // Chrome accepts it again: the same switch goes through.
  sw.refuseDynamicRules(false);
  const retry = await sw.send({ type: 'popup:toggleSite', hostname: HOST, enabled: false });
  assert.equal(retry.applied, true);
  assert.equal(retry.allowlisted, true);
  assert.deepEqual(sw.settings().allowlist, ['theguardian.com']);
  assert.equal(sw.rules().filter((r) => r.action?.type === 'allowAllRequests').length, 1);
});

test('turning blocking back on that Chrome refuses leaves the site switched off, and says so', async () => {
  const sw = await bootServiceWorker({ host: HOST, settings: { allowlist: ['theguardian.com'] } });
  await sw.settle();
  assert.equal(sw.rules().filter((r) => r.action?.type === 'allowAllRequests').length, 1);
  sw.refuseDynamicRules(true);

  let data;
  await capturingErrors(async () => {
    data = await sw.send({ type: 'popup:toggleSite', hostname: HOST, enabled: true });
  });
  assert.equal(data.applied, false);
  assert.equal(data.allowlisted, true, 'blocking is still off, and the popup says so');
  assert.deepEqual(sw.settings().allowlist, ['theguardian.com']);
  assert.equal(sw.rules().filter((r) => r.action?.type === 'allowAllRequests').length, 1);
});

test('Options > Add a site gets the same answer when Chrome refuses', async () => {
  // Options sends popup:toggleSite with the host it validated; it must learn the rule is not in
  // force so it can keep the entry and say why.
  const sw = await bootServiceWorker({ host: HOST });
  await sw.settle();
  sw.refuseDynamicRules(true);
  let data;
  await capturingErrors(async () => {
    data = await sw.send({ type: 'popup:toggleSite', hostname: 'news.example', enabled: false });
  });
  assert.equal(data.applied, false);
  const rules = await sw.send({ type: 'sitefix:list' });
  assert.deepEqual(rules.allowlist, [], 'the Settings list must not show a rule that is not in force');
});

test('a refused allowlist resync on wake is logged and does not stop the other layers', async () => {
  const logged = await capturingErrors(async () => {
    const sw = await bootServiceWorker({
      host: HOST,
      refuseDynamicRules: true,
      settings: { allowlist: ['theguardian.com'] },
    });
    await sw.settle();
    assert.ok(sw.script('quell-generic-cosmetic'), 'generic hiding was not registered');
    assert.ok(sw.script('quell-scriptlets-youtube'), 'YouTube hooks were not registered');
  });
  assert.ok(logged.some((l) => l.includes('updateDynamicRules (allowlist) failed')));
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

test('an allow rule an older build wrote with sub_frame is rewritten on wake (B7)', async () => {
  // syncAllowlist skips the write when the live band already matches. Keyed on the host alone,
  // every existing install would keep sub_frame forever, and its embeds unblocked everywhere.
  const sw = await bootServiceWorker({
    host: HOST,
    settings: { allowlist: ['youtube.com'] },
    dynamicRules: [
      {
        id: 1_000_000,
        priority: 1_000_000,
        action: { type: 'allowAllRequests' },
        condition: { requestDomains: ['youtube.com'], resourceTypes: ['main_frame', 'sub_frame'] },
      },
    ],
  });
  await sw.settle();

  const allow = sw.rules().filter((r) => r.action?.type === 'allowAllRequests');
  assert.equal(allow.length, 1);
  assert.deepEqual(allow[0].condition.requestDomains, ['youtube.com']);
  assert.deepEqual(allow[0].condition.resourceTypes, ['main_frame']);
});

test('Options refuses a partial IP like 10.0.0, and generic hiding survives the attempt (B3)', async () => {
  // Options > Add a site sends exactly these messages with whatever the user typed. `10.0.0` used
  // to be stored, and its `*://www.10.0.0/*` exclude made Chrome reject the generic sheet.
  const sw = await bootServiceWorker({ host: HOST });
  await sw.settle();
  assert.ok(sw.script('quell-generic-cosmetic'), 'precondition: generic sheet registered on wake');

  for (const typed of ['10.0.0', '192.168.1', '192.168']) {
    await sw.send({ type: 'popup:toggleSite', hostname: typed, enabled: false });
    await sw.send({ type: 'sitefix:set', hostname: typed, level: 'cosmetics' });
  }
  await sw.settle();

  assert.deepEqual(sw.settings().allowlist, []);
  assert.deepEqual(sw.settings().siteFixes ?? {}, {});
  assert.equal(sw.rules().filter((r) => r.action?.type === 'allowAllRequests').length, 0);
  assert.ok(sw.script('quell-generic-cosmetic'), 'generic cosmetic registration was lost');
  assert.ok(sw.script('quell-scriptlets-youtube'), 'YouTube hooks registration was lost');
});

test('with every list on, the generic sheet and YouTube hooks register and every exclude parses (B3)', async () => {
  // EasyList China ships `@@||192.168.*.1/$generichide`; the compiler cut it to `192.168` and
  // applyLocaleDefaults turns China on for every zh-* install. The union of all lists holds
  // every exclude any combination of them can produce, so this covers each combination; the
  // single-list toggles below go through the Options path as well.
  const meta = JSON.parse(readFileSync('src/generated/meta.json', 'utf8'));
  const lists = meta.lists.map((l) => l.id);
  const sheets = meta.lists.filter((l) => l.genericCssFile).length;
  const sw = await bootServiceWorker({
    host: HOST,
    settings: { enabledLists: Object.fromEntries(lists.map((id) => [id, true])) },
  });
  await sw.settle();

  const generic = sw.script('quell-generic-cosmetic');
  assert.ok(generic, 'Chrome rejected the generic cosmetic registration');
  assert.ok(sw.script('quell-scriptlets-youtube'), 'YouTube hooks were not registered');
  assert.equal(generic.css.length, sheets);
  assert.deepEqual(generic.excludeMatches.filter((p) => !patternIsValid(p)), []);

  for (const id of lists) {
    await sw.send({ type: 'lists:setEnabled', id, enabled: false });
    await sw.send({ type: 'lists:setEnabled', id, enabled: true });
  }
  await sw.settle();
  assert.equal(sw.script('quell-generic-cosmetic')?.css.length, sheets);
});

test('switching off localhost also drops the generic sheet and YouTube hooks there (B31)', async () => {
  const sw = await bootServiceWorker({ host: 'localhost:3000' });
  await sw.settle();
  await sw.send({ type: 'popup:toggleSite', hostname: 'localhost', enabled: false });
  await sw.settle();

  assert.deepEqual(sw.settings().allowlist, ['localhost']);
  for (const id of ['quell-generic-cosmetic', 'quell-scriptlets-youtube']) {
    const excl = sw.script(id)?.excludeMatches ?? [];
    assert.ok(excl.includes('*://localhost/*'), `${id} still runs on localhost`);
  }
});

test('a rejected generic sheet keeps its working registration and does not skip YouTube (B4)', async () => {
  const sw = await bootServiceWorker({ host: HOST });
  await sw.settle();
  const before = structuredClone(sw.script('quell-generic-cosmetic'));
  assert.ok(before, 'precondition: generic sheet registered on wake');
  assert.ok(sw.script('quell-scriptlets-youtube'), 'precondition: YouTube hooks registered on wake');

  // Chrome now refuses the generic payload, for whatever reason. The allowlist change must still
  // reach the YouTube hooks, and generic hiding must stay as it was rather than vanish.
  sw.failNext(['quell-generic-cosmetic']);
  const logged = [];
  const origError = console.error;
  console.error = (...args) => logged.push(args.map(String).join(' '));
  try {
    await sw.send({ type: 'popup:toggleSite', hostname: HOST, enabled: false });
    await sw.settle();
  } finally {
    console.error = origError;
  }

  assert.ok(
    sw.script('quell-scriptlets-youtube')?.excludeMatches?.includes('*://*.theguardian.com/*'),
    'the YouTube sync was skipped because the generic sync failed',
  );
  assert.deepEqual(
    sw.script('quell-generic-cosmetic'),
    before,
    'the working generic sheet was deleted',
  );
  const report = logged.join('\n');
  assert.match(
    report,
    /Chrome rejected 'quell-generic-cosmetic'/,
    'the original error was not logged',
  );
  assert.doesNotMatch(report, /does not exist/);
});

/** Minimal Chrome match-pattern test: scheme, `*.` host wildcard, and `*` in path+query. */
function patternMatchesUrl(pattern, url) {
  const m = /^(\*|https?):\/\/([^/]+)(\/.*)$/.exec(pattern);
  if (!m) return false;
  const u = new URL(url);
  if (m[1] !== '*' && `${m[1]}:` !== u.protocol) return false;
  const host = m[2];
  if (host.startsWith('*.')) {
    const base = host.slice(2);
    if (u.hostname !== base && !u.hostname.endsWith(`.${base}`)) return false;
  } else if (host !== '*' && host !== u.hostname) {
    return false;
  }
  const body = m[3]
    .split('*')
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`).test(u.pathname + u.search);
}

test('EasyList search-page exceptions exclude the results page, not the whole site (B17)', async () => {
  // `@@||duckduckgo.com/?q=$generichide`: dropping the path turned generic hiding on over the
  // results; keying it by host would turn it off on every DuckDuckGo page.
  const sw = await bootServiceWorker({ host: HOST });
  await sw.settle();
  const excl = sw.script('quell-generic-cosmetic')?.excludeMatches ?? [];
  const excluded = (url) => excl.some((p) => patternMatchesUrl(p, url));
  assert.ok(excl.includes('*://*.duckduckgo.com/?q=*'));
  assert.equal(excluded('https://duckduckgo.com/?q=shoes&ia=web'), true);
  assert.equal(excluded('https://duckduckgo.com/about'), false);
  assert.equal(excluded('https://yandex.com/search/?text=shoes'), true);
  assert.equal(excluded('https://yandex.com/maps/'), false);
  assert.deepEqual(excl.filter((p) => !patternIsValid(p)), []);

  // google.* has no match pattern; the results page reverts generic hiding per page instead.
  const frame = (url) => ({ frameId: 0, url, tab: { id: 1, url } });
  const serp = await sw.send(
    { type: 'cosmetic:get', hostname: 'www.google.de' },
    frame('https://www.google.de/search?q=schuhe'),
  );
  assert.equal(serp.disableGeneric, true);
  assert.ok(serp.unhide.length > 1000, 'the generic set is reverted on the results page');
  const maps = await sw.send(
    { type: 'cosmetic:get', hostname: 'www.google.de' },
    frame('https://www.google.de/maps'),
  );
  assert.equal(maps.disableGeneric, false);
});

test('a frame follows the switch of the page it is on, not its own host (B7)', async () => {
  const sw = await bootServiceWorker({ host: HOST, settings: { allowlist: ['youtube.com'] } });
  await sw.settle();
  const sub = (frameUrl, topUrl) => ({ frameId: 7, url: frameUrl, tab: { id: 1, url: topUrl } });
  const ask = async (hostname, sender) => ({
    cosmetic: (await sw.send({ type: 'cosmetic:get', hostname }, sender)).allowlisted,
    scriptlets: (await sw.send({ type: 'scriptlets:get', hostname }, sender)).allowlisted,
    youtube: (await sw.send({ type: 'youtube:getOptions', hostname }, sender)).allowlisted,
  });
  const on = { cosmetic: false, scriptlets: false, youtube: false };
  const off = { cosmetic: true, scriptlets: true, youtube: true };

  // A YouTube embed on another site is filtered although youtube.com is switched off…
  assert.deepEqual(
    await ask('www.youtube.com', sub('https://www.youtube.com/embed/x', 'https://news.example/a')),
    on,
  );
  // …youtube.com itself is not…
  const top = 'https://www.youtube.com/watch?v=x';
  assert.deepEqual(await ask('www.youtube.com', { frameId: 0, url: top, tab: { id: 1, url: top } }), off);
  // …and neither is a third-party frame on it.
  assert.deepEqual(await ask('disqus.com', sub('https://disqus.com/embed', top)), off);
  // A prerendered page is not the tab's page yet: its frames fall back to their own host.
  const pre = { ...sub('https://www.youtube.com/embed/x', 'https://news.example/a'), documentLifecycle: 'prerender' };
  assert.deepEqual(await ask('www.youtube.com', pre), off);
});

test('YouTube embeds keep their hooks when youtube.com is switched off (B7)', async () => {
  const sw = await bootServiceWorker({ host: HOST });
  await sw.settle();
  await sw.send({ type: 'popup:toggleSite', hostname: 'www.youtube.com', enabled: false });
  await sw.settle();

  const top = sw.script('quell-scriptlets-youtube');
  assert.equal(top.allFrames, false, 'top-level hooks: the frame URL is the page');
  assert.ok(top.excludeMatches.includes('*://*.youtube.com/*'));
  const frames = sw.script('quell-scriptlets-youtube-frames');
  assert.ok(frames, 'embed hooks are registered');
  assert.deepEqual(frames.js, ['scriptlets-youtube-frames.js']);
  assert.equal(frames.allFrames, true);
  assert.equal(frames.world, 'MAIN');
  assert.deepEqual(frames.excludeMatches ?? [], [], 'embeds must not be excluded by their own URL');
  assert.deepEqual(frames.matches, top.matches);

  // Both follow Pause and the sponsored toggle.
  await sw.send({ type: 'popup:setPaused', paused: true });
  await sw.settle();
  assert.equal(sw.script('quell-scriptlets-youtube-frames'), undefined);
  assert.equal(sw.script('quell-scriptlets-youtube'), undefined);
});

test('the embed hook script only acts in subframes', () => {
  const src = readFileSync('src/content/scriptlets-youtube-frames.ts', 'utf8');
  assert.match(src, /if \(window !== window\.top\) installYoutubeEarlyHooks\(\);/);
  const build = readFileSync('scripts/build.mjs', 'utf8');
  assert.match(build, /'content\/scriptlets-youtube-frames\.ts', 'scriptlets-youtube-frames\.js'/);
});

/** A cached paid license young enough that a wake does not re-check it with ExtPay. */
const PAID = () => ({ paid: true, provider: 'extpay', verifiedAt: Date.now() });

test('a dark-mode override on an IP address keeps dark mode registered (B3)', async () => {
  // Overrides are exact-host patterns plus a www. twin. `*://www.192.168.1.1/*` does not parse,
  // so one router-page override used to cost a paying user dark mode everywhere.
  const sw = await bootServiceWorker({
    host: HOST,
    license: PAID(),
    settings: { darkModeEnabled: true, darkModeSiteOverrides: { '192.168.1.1': 'off' } },
  });
  await sw.settle();

  const dark = sw.script('quell-dark-mode');
  assert.ok(dark, 'Chrome rejected the dark-mode registration');
  assert.deepEqual(dark.excludeMatches, ['*://192.168.1.1/*']);
});

test('one dark-mode registration failing does not skip the other (B4)', async () => {
  const sw = await bootServiceWorker({
    host: HOST,
    license: PAID(),
    settings: { darkModeEnabled: false, darkModeSiteOverrides: { 'example.org': 'on' } },
  });
  await sw.settle();
  assert.ok(sw.script('quell-dark-mode-force'), 'precondition: force-on script registered');

  // Turning dark mode on everywhere registers the global script and retires the force-on one.
  // The first failing must not leave the second behind.
  sw.failNext(['quell-dark-mode']);
  const origError = console.error;
  console.error = () => {};
  try {
    await sw.send({ type: 'darkmode:setEnabled', enabled: true });
    await sw.settle();
  } finally {
    console.error = origError;
  }
  assert.equal(sw.script('quell-dark-mode-force'), undefined);
});

test('the 0.1.0 global scriptlet registration is removed on wake', async () => {
  // It was registered with persistAcrossSessions, MAIN world, on every URL. The cleanup asked
  // Chrome to remove it together with an id no build ever registered, and Chrome rejects the
  // whole call when any id is missing, so it survived every sync.
  const sw = await bootServiceWorker({
    host: HOST,
    registered: [
      {
        id: 'quell-scriptlets',
        js: ['scriptlets.js'],
        matches: ['<all_urls>'],
        runAt: 'document_start',
        allFrames: true,
        world: 'MAIN',
        persistAcrossSessions: true,
      },
    ],
  });
  await sw.settle();
  assert.equal(sw.script('quell-scriptlets'), undefined);
  assert.ok(sw.script('quell-generic-cosmetic'));
});

// ---------------------------------------------------------------------------
// List scriptlets (REVIEW_2026-09-24 B2, B24, B26)
// ---------------------------------------------------------------------------

const SHARDS = JSON.parse(readFileSync('src/generated/scriptlet-shards.json', 'utf8'));
const shardScripts = (sw) => sw.scripts().filter((s) => s.id.startsWith('quell-sl-'));
/** A registration's data files and runtime, its bundle opened up. */
const partsOf = (s) =>
  s.js.flatMap((f) => Object.values(SHARDS.bundles ?? {}).find((b) => b.file === f)?.parts ?? [f]);
/** The registration that carries worldfreeware.com, whose `aopr, require` the review tested. */
const worldfreeware = (sw) =>
  shardScripts(sw).find((s) => s.matches.includes('*://*.worldfreeware.com/*'));

test('list scriptlets are registered to run at document start, before the page (B2)', async () => {
  // They used to be fetched by message and injected with executeScript once the page had
  // already run its inline <head> scripts, so `worldfreeware.com##+js(aopr, require)` never
  // aborted the script it was written for.
  const sw = await bootServiceWorker({ host: HOST });
  await sw.settle();
  const shards = shardScripts(sw);
  assert.ok(shards.length > 2, 'no scriptlet registrations');
  for (const s of shards) {
    assert.equal(s.world, 'MAIN', s.id);
    assert.equal(s.runAt, 'document_start', s.id);
    assert.equal(s.allFrames, true, s.id);
    // about:blank / srcdoc frames a page creates for itself (friendly-iframe ads).
    assert.equal(s.matchOriginAsFallback, true, s.id);
    assert.equal(s.persistAcrossSessions, true, s.id);
    assert.deepEqual(s.matches.filter((p) => !patternIsValid(p)), [], s.id);
    assert.match(partsOf(s).at(-1), /^scriptlets-runtime(-broad)?\.js$/, `${s.id} ends with the runtime`);
    // One file: in a sandboxed frame without allow-scripts, Chrome logs an error per file.
    assert.deepEqual(s.js, [SHARDS.bundles[s.id].file], `${s.id} injects its bundle`);
  }
  const hit = worldfreeware(sw);
  assert.ok(hit, 'worldfreeware.com is not matched by any registration');
  assert.ok(partsOf(hit).some((f) => f.startsWith('generated/scriptlets/ubo-filters.')));

  // They follow the switches: the site's own switch, Pause, and the list toggle.
  await sw.send({ type: 'popup:toggleSite', hostname: 'worldfreeware.com', enabled: false });
  await sw.settle();
  for (const s of shardScripts(sw)) {
    assert.ok(s.excludeMatches?.includes('*://*.worldfreeware.com/*'), `${s.id} still runs there`);
  }
  await sw.send({ type: 'lists:setEnabled', id: 'ubo-filters', enabled: false });
  await sw.settle();
  for (const s of shardScripts(sw)) {
    assert.ok(!partsOf(s).some((f) => f.includes('/ubo-filters.')), `${s.id} still carries a disabled list`);
  }
  await sw.send({ type: 'popup:setPaused', paused: true });
  await sw.settle();
  assert.deepEqual(shardScripts(sw), []);
});

test('with every list on, the scriptlet registrations all parse and the runtime files differ', async () => {
  const meta = JSON.parse(readFileSync('src/generated/meta.json', 'utf8'));
  const sw = await bootServiceWorker({
    host: HOST,
    settings: { enabledLists: Object.fromEntries(meta.lists.map((l) => [l.id, true])) },
  });
  await sw.settle();
  const shards = shardScripts(sw);
  assert.ok(shards.some((s) => s.id === 'quell-sl-broad'), 'entity rules (`example.*`) need the broad script');
  // Chrome injects a file once per document: a page matched by a bucket and by the broad script
  // would otherwise never run the second one's data.
  const broad = shards.find((s) => s.id === 'quell-sl-broad');
  const bucket = shards.find((s) => s.id !== 'quell-sl-broad');
  assert.notEqual(broad.js.at(-1), bucket.js.at(-1));
  assert.notEqual(partsOf(broad).at(-1), partsOf(bucket).at(-1));
  for (const s of shards) assert.deepEqual(s.matches.filter((p) => !patternIsValid(p)), [], s.id);
});

test('an unchanged wake neither rewrites nor reads back the scriptlet registrations', async () => {
  // Every registerContentScripts call reloads the extension's scripts in every renderer, and
  // reading them back returns all ~22k patterns.
  const sw = await bootServiceWorker({ host: HOST });
  await sw.settle();
  const before = structuredClone(shardScripts(sw));

  const wake = await bootServiceWorker({ host: HOST, registered: sw.scripts(), session: sw.session() });
  await wake.settle();
  assert.deepEqual(wake.registerLog().filter((id) => id.startsWith('quell-sl-')), []);
  assert.equal(wake.fullReads(), 0, 'the state the last sync stored is enough');
  assert.deepEqual(shardScripts(wake), before);
  // …and a top frame's request is answered from it too.
  const top = { frameId: 0, documentId: 'D', url: 'https://worldfreeware.com/', tab: { id: 1, url: 'https://worldfreeware.com/' } };
  await wake.send({ type: 'scriptlets:get', hostname: 'worldfreeware.com', topHost: 'worldfreeware.com', registered: true }, top);
  assert.equal(wake.fullReads(), 0);
  assert.equal(wake.executed().length, 0);

  // After a browser restart storage.session is empty: Chrome is asked, and nothing is rewritten.
  const restart = await bootServiceWorker({ host: HOST, registered: sw.scripts() });
  await restart.settle();
  assert.deepEqual(restart.registerLog().filter((id) => id.startsWith('quell-sl-')), []);
  assert.deepEqual(shardScripts(restart), before);

  // A settings change is not hidden by the stored state.
  await wake.send({ type: 'popup:toggleSite', hostname: 'news.example', enabled: false });
  await wake.settle();
  assert.ok(shardScripts(wake).every((s) => s.excludeMatches?.includes('*://*.news.example/*')));
});

/** A frame on `frameUrl` inside a tab showing `topUrl`, as chrome.runtime reports it. */
const frameSender = (frameUrl, topUrl, extra = {}) => ({
  frameId: 7,
  documentId: 'DOC-7',
  url: frameUrl,
  origin: new URL(frameUrl).origin,
  tab: { id: 1, url: topUrl },
  ...extra,
});

test('a frame the registrations cannot serve gets one injection, into its own document (B26)', async () => {
  const sw = await bootServiceWorker({ host: HOST });
  await sw.settle();
  const resp = await sw.send(
    { type: 'scriptlets:get', hostname: 'worldfreeware.com', topHost: 'news.example', registered: false },
    frameSender('https://worldfreeware.com/embed', 'https://news.example/a'),
  );
  assert.deepEqual(resp, { allowlisted: false, injected: true });
  const calls = sw.executed();
  assert.equal(calls.length, 1, 'data and runtime land in one executeScript');
  const [call] = calls;
  // documentIds, not frameIds: a frame that navigated away since it asked, or a prerendered page
  // activated in between (its frameId changes, its documentId does not), must not get these.
  assert.deepEqual(call.target, { tabId: 1, documentIds: ['DOC-7'] });
  assert.equal(call.world, 'MAIN');
  assert.equal(call.injectImmediately, true);
  assert.equal(call.files.at(-1), 'scriptlets-runtime.js');
  assert.equal(call.files.at(-2), SHARDS.fallback, 'the runtime is told it is the fallback');
  assert.ok(call.files.some((f) => partsOf(worldfreeware(sw)).includes(f)), 'the host\'s own bucket data');
});

test('a frame on a switched-off or paused page gets nothing from the worker (B24)', async () => {
  const sw = await bootServiceWorker({ host: HOST, settings: { allowlist: ['news.example'] } });
  await sw.settle();
  const ask = (sender, topHost = 'news.example') =>
    sw.send({ type: 'scriptlets:get', hostname: 'worldfreeware.com', topHost, registered: false }, sender);

  assert.equal((await ask(frameSender('https://worldfreeware.com/e', 'https://news.example/a'))).allowlisted, true);
  // A prerendered page is not the tab's page yet; its frames say which page they are on.
  const prerendered = frameSender('https://worldfreeware.com/e', 'https://elsewhere.example/', {
    documentLifecycle: 'prerender',
  });
  assert.equal((await ask(prerendered)).allowlisted, true);
  assert.equal(sw.executed().length, 0);

  // The same embed on a page that is on is served.
  await ask(frameSender('https://worldfreeware.com/e', 'https://other.example/'), 'other.example');
  assert.equal(sw.executed().length, 1);
});

test('a frame the registrations serve gets nothing more, unless its registration is missing', async () => {
  const top = { frameId: 0, documentId: 'TOP', url: 'https://worldfreeware.com/', tab: { id: 1, url: 'https://worldfreeware.com/' } };
  const msg = { type: 'scriptlets:get', hostname: 'worldfreeware.com', topHost: 'worldfreeware.com', registered: true };

  const sw = await bootServiceWorker({ host: HOST });
  await sw.settle();
  assert.deepEqual(await sw.send(msg, top), { allowlisted: false, injected: false });
  assert.equal(sw.executed().length, 0, 'Chrome already ran them at document start');

  // Chrome refused the registrations: the worker fills the gap for that page.
  const origError = console.error;
  console.error = () => {};
  try {
    const broken = await bootServiceWorker({ host: HOST, failRegistration: true });
    await broken.settle();
    assert.deepEqual(await broken.send(msg, top), { allowlisted: false, injected: true });
    assert.deepEqual(broken.executed()[0].target, { tabId: 1, documentIds: ['TOP'] });
  } finally {
    console.error = origError;
  }
});

test('a registration left behind is filled in without re-running what a live bundle already ran', async () => {
  // yts.mx has rules in its bucket and, through `yts.*`, in the broad registration.
  const top = { frameId: 0, documentId: 'TOP', url: 'https://yts.mx/', tab: { id: 1, url: 'https://yts.mx/' } };
  const msg = { type: 'scriptlets:get', hostname: 'yts.mx', topHost: 'yts.mx', registered: true };
  const sw = await bootServiceWorker({ host: HOST });
  await sw.settle();
  const bucket = shardScripts(sw).find((s) => s.matches.includes('*://*.yts.mx/*'));
  const broad = sw.script('quell-sl-broad');
  assert.deepEqual(bucket.js, [SHARDS.bundles[bucket.id].file]);
  // A restart finds the host's bucket in place and every other shard from an older build, and
  // Chrome refuses their replacements: only the bucket is live.
  const seeded = sw.scripts().map((s) =>
    s.id.startsWith('quell-sl-') && s.id !== bucket.id ? { ...s, js: [`generated/scriptlets/${s.id}.old.js`] } : s,
  );
  const logged = await capturingErrors(async () => {
    const broken = await bootServiceWorker({ host: HOST, registered: seeded, failRegistration: true });
    await broken.settle();
    assert.deepEqual(shardScripts(broken).map((s) => s.id), [bucket.id]);
    assert.deepEqual(await broken.send(msg, top), { allowlisted: false, injected: true });
    const [call] = broken.executed();
    // The broad data only: the bucket's bundle ran its own data files at document start.
    assert.deepEqual(call.files, [...partsOf(broad).slice(0, -1), SHARDS.fallback, 'scriptlets-runtime.js']);
  });
  assert.ok(logged.length > 0, 'the refused registrations were reported');
});

test('a host without scriptlet rules costs no injection', async () => {
  const sw = await bootServiceWorker({ host: HOST });
  await sw.settle();
  await sw.send(
    { type: 'scriptlets:get', hostname: 'nothing-listed.example', topHost: 'news.example', registered: false },
    frameSender('https://nothing-listed.example/', 'https://news.example/'),
  );
  assert.equal(sw.executed().length, 0);
});

test.after(() => rmSync(stubDir, { recursive: true, force: true }));
