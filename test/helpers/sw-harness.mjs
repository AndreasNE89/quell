// The real service worker against a fake chrome, shared by the service-worker test files.
//
// Lives under test/, so `node --test` also loads it as a test file of its own: it must do
// nothing at import. The bundle is built on first use.
//
// The chrome.scripting fake follows Chrome where it matters (REVIEW_2026-09-24 B3/B4): it
// honors `{ids}`, rejects a whole call over one unknown id or one pattern Chrome cannot parse,
// and treats updateContentScripts as a patch of a live id. A lenient fake is why an invalid
// exclude pattern taking down generic hiding for every zh-* install went unnoticed.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { cosmeticDataFiles } from '../../scripts/lib/cosmetic-files.mjs';

// SS_SW_ROOT points the harness at another checkout, to confirm a new test fails on old code.
const ROOT = process.env.SS_SW_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let prepared = null;

/**
 * Bundle the worker once. license.ts imports extpay, which does not resolve on
 * platform:'neutral', so a stub stands in; its getUser and onPaid are the test's
 * (`extpay` option of bootServiceWorker), read from globalThis when called.
 */
async function prepare() {
  if (prepared) return prepared;
  const stubDir = mkdtempSync(join(tmpdir(), 'stampstack-extpay-'));
  process.on('exit', () => rmSync(stubDir, { recursive: true, force: true }));
  const extpayStub = join(stubDir, 'extpay.js');
  writeFileSync(
    extpayStub,
    'export default function ExtPay(){const x=()=>globalThis.__ssExtPay??{};return{' +
      'getUser:(...a)=>(x().getUser?x().getUser(...a):Promise.resolve({paid:false})),' +
      'onPaid:{addListener(fn){(x().paidListeners??=[]).push(fn);}},' +
      'openPaymentPage:(...a)=>x().openPaymentPage?.(...a),' +
      'openLoginPage:(...a)=>x().openLoginPage?.(...a),startBackground(){}};}\n',
  );
  const bundle = (
    await build({
      entryPoints: [join(ROOT, 'src/background/service-worker.ts')],
      bundle: true,
      format: 'esm',
      write: false,
      platform: 'neutral',
      alias: { extpay: extpayStub },
      logLevel: 'silent',
    })
  ).outputFiles[0].text;
  // The package files the worker fetches (scripts/lib/cosmetic-files.mjs), as the build writes them.
  const packageFiles = new Map(
    cosmeticDataFiles(JSON.parse(readFileSync(join(ROOT, 'src/generated/cosmetic.json'), 'utf8'))).map(
      (f) => [f.path, f.content],
    ),
  );
  prepared = { stubDir, bundle, packageFiles, seq: 0 };
  return prepared;
}

const noopEvent = () => ({ addListener() {}, removeListener() {} });

/**
 * The part of Chrome's match-pattern parser (extensions/common/url_pattern.cc) that decides
 * whether a host is acceptable. Host canonicalization is the WHATWG URL parser's, which applies
 * Chrome's rule that a host ending in a number is IPv4: `www.10.0.0` fails, and so does the
 * whole registerContentScripts call that carries it. test/hostname-patterns.test.mjs holds the
 * full model and checks it against what a real Chromium accepted.
 */
export function patternIsValid(pattern) {
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
export const DNR_INTERNAL_ERROR = 'Internal error while updating dynamic rules.';

/** The popup, as chrome.runtime reports it to the worker: an extension page, no tab. */
export const POPUP = Object.freeze({ id: 'test', url: 'chrome-extension://test/popup.html' });

const META = JSON.parse(readFileSync(join(ROOT, 'src/generated/meta.json'), 'utf8'));

/**
 * Load a fresh service worker against a fake chrome.
 * `failRegistration` simulates chrome.scripting rejecting every payload; the returned
 * `failNext(ids)` rejects only the next payload for each listed script id.
 * `refuseDynamicRules` makes every updateDynamicRules call reject, as Chrome does, without
 * changing anything; the returned `refuseDynamicRules(bool)` switches that later.
 * `settings`, `dynamicRules` and `registered` seed state left behind by an earlier build.
 * `tabs` are the open tabs (default: one on `host`); `tabMessage(tabId, msg)` answers
 * chrome.tabs.sendMessage (default: null). `extpay` stands in for ExtensionPay (`getUser`).
 * `ruleRoom` is the static-rule pool left (getAvailableStaticRuleCount); enabling past it
 * throws, as Chrome does. `enabledRulesets` seeds what Chrome has on (the manifest defaults
 * after an update, for instance); `rulesetDelay` makes each updateEnabledRulesets take that
 * long, and `registerDelay` each registerContentScripts. `missingFiles` are package paths
 * fetch() answers 404 for; `packageJson(path, value)` sees (and may wrap) each parsed package
 * file. `onInstalled` / `onStartup` capture those listeners.
 */
export async function bootServiceWorker({
  host,
  failRegistration = false,
  refuseDynamicRules = false,
  settings,
  license,
  dynamicRules: seedRules = [],
  registered: seedScripts = [],
  session: seedSession = {},
  local: seedLocal = {},
  tabs: seedTabs,
  tabMessage = async () => null,
  extpay,
  ruleRoom,
  enabledRulesets: seedRulesets = [],
  rulesetDelay = 0,
  registerDelay = 0,
  missingFiles = [],
  packageJson = (_path, value) => value,
}) {
  const { stubDir, bundle, packageFiles } = await prepare();
  const fetched = [];
  /** fetch() for the extension's own package files; anything else is not the worker's to read. */
  const fetchPackage = async (url) => {
    activity++;
    const base = 'chrome-extension://test/';
    const path = String(url).startsWith(base) ? String(url).slice(base.length) : null;
    fetched.push(path ?? String(url));
    const body = path != null && !missingFiles.includes(path) ? packageFiles.get(path) : undefined;
    if (body === undefined) {
      return { ok: false, status: 404, json: async () => Promise.reject(new Error('not found')) };
    }
    return { ok: true, status: 200, json: async () => packageJson(path, JSON.parse(body)) };
  };
  const store = { ...structuredClone(seedLocal) };
  const sessionStore = structuredClone(seedSession);
  let fullReads = 0;
  if (settings) store['stampstack.settings'] = settings;
  if (license) store['stampstack.license'] = license;
  let dynamicRules = seedRules.map((r) => structuredClone(r));
  let registered = seedScripts.map((r) => structuredClone(r));
  let enabledRulesets = [...seedRulesets];
  let room = ruleRoom;
  let localAccess = 'TRUSTED_AND_UNTRUSTED_CONTEXTS';
  let listener = null;
  const installed = [];
  const started = [];
  const executed = [];
  const registerLog = [];
  const rulesetCalls = [];
  const cssCalls = [];
  const tabMessages = [];
  let rejectNext = new Set();
  let refuseDynamic = refuseDynamicRules;
  const tabs = seedTabs ?? [{ id: 1, url: `https://${host}/a/page`, active: true }];
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
  const ruleCount = (id) => META.lists.find((l) => l.id === id)?.ruleCount ?? 0;

  const chrome = {
    runtime: {
      getManifest: () => ({
        version: '0.0.0-test',
        content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'], all_frames: true }],
      }),
      getURL: (p = '') => `chrome-extension://test/${p}`,
      onMessage: { addListener: (fn) => (listener = fn) },
      onInstalled: { addListener: (fn) => installed.push(fn), removeListener() {} },
      onStartup: { addListener: (fn) => started.push(fn), removeListener() {} },
      id: 'test',
    },
    storage: {
      local: {
        get: async (k) => {
          activity++;
          if (k == null) return { ...store };
          const out = {};
          for (const key of Array.isArray(k) ? k : [k]) if (key in store) out[key] = structuredClone(store[key]);
          return out;
        },
        set: async (o) => {
          activity++;
          Object.assign(store, structuredClone(o));
        },
        remove: async (k) => {
          for (const key of Array.isArray(k) ? k : [k]) delete store[key];
        },
        setAccessLevel: async ({ accessLevel }) => {
          localAccess = accessLevel;
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
      getEnabledRulesets: async () => {
        activity++;
        return enabledRulesets.slice();
      },
      ...(ruleRoom === undefined
        ? {}
        : {
            getAvailableStaticRuleCount: async () => {
              activity++;
              return room;
            },
          }),
      updateEnabledRulesets: async ({ enableRulesetIds = [], disableRulesetIds = [] }) => {
        activity++;
        // Chrome re-indexes on every change; with ~120k rules that is not instant.
        if (rulesetDelay) await new Promise((r) => setTimeout(r, rulesetDelay));
        rulesetCalls.push({ enableRulesetIds: [...enableRulesetIds], disableRulesetIds: [...disableRulesetIds] });
        const adding = enableRulesetIds.filter((id) => !enabledRulesets.includes(id));
        const freed = disableRulesetIds.filter((id) => enabledRulesets.includes(id));
        if (room !== undefined) {
          const need = adding.reduce((n, id) => n + ruleCount(id), 0);
          const free = room + freed.reduce((n, id) => n + ruleCount(id), 0);
          // Chrome applies the call whole or not at all.
          if (need > free) throw new Error('The number of enabled static rules exceeds the global limit.');
          room = free - need;
        }
        enabledRulesets = enabledRulesets.filter((id) => !disableRulesetIds.includes(id)).concat(adding);
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
        if (registerDelay) await new Promise((r) => setTimeout(r, registerDelay));
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
      insertCSS: async (details) => {
        activity++;
        cssCalls.push({ op: 'insert', ...structuredClone(details) });
      },
      removeCSS: async (details) => {
        activity++;
        cssCalls.push({ op: 'remove', ...structuredClone(details) });
      },
    },
    tabs: {
      query: async (q = {}) => {
        activity++;
        const urls = q.url ? (Array.isArray(q.url) ? q.url : [q.url]) : null;
        return tabs
          .filter((t) => !q.active || t.active)
          .filter((t) => !urls || urls.some((p) => patternCoversUrl(p, t.url)))
          .map((t) => structuredClone(t));
      },
      sendMessage: (tabId, msg, opts) => {
        activity++;
        tabMessages.push({ tabId, msg: structuredClone(msg), opts });
        return Promise.resolve(tabMessage(tabId, msg, opts));
      },
      onRemoved: noopEvent(),
      onUpdated: noopEvent(),
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    management: { getSelf: async () => ({ installType: 'normal' }) },
    commands: { onCommand: noopEvent() },
    webNavigation: { onBeforeNavigate: noopEvent() },
  };

  globalThis.chrome = chrome;
  globalThis.__ssExtPay = extpay ?? {};
  globalThis.fetch = fetchPackage;
  // Import from a real file, not a data: URL. These tests deliberately make the service worker
  // log an error, and with a data: URL every frame of that stack trace embeds the whole ~4 MB
  // base64 bundle. Locally that is merely ugly; on a CI runner the log writer stalls for half
  // an hour on the multi-megabyte lines. A temp file keeps stack frames to a path.
  // The unique filename is also what gives each test its own module instance.
  const file = join(stubDir, `sw-${prepared.seq++}.mjs`);
  writeFileSync(file, bundle);
  await import(pathToFileURL(file).href);

  assert.ok(listener, 'service worker registered no onMessage listener');
  // The handlers read chrome.* when they run, not at import, so the fake has to be the live
  // global for the whole call — not just while the module was loading.
  const live = () => {
    globalThis.chrome = chrome;
    globalThis.__ssExtPay = extpay ?? {};
    globalThis.fetch = fetchPackage;
  };
  const send = (msg, sender = POPUP) => {
    live();
    return new Promise((resolve) => {
      if (listener(msg, sender, resolve) !== true) resolve(undefined);
    });
  };

  /** Wait until the worker has made no chrome call for several macrotask turns. */
  const settle = async () => {
    let seen = -1;
    let quiet = 0;
    for (let turns = 0; quiet < 10 && turns < 1000; turns++) {
      live();
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
    live,
    /** Fire chrome.runtime.onInstalled as Chrome does after an install or update. */
    install: (details) => {
      live();
      for (const fn of installed) fn(details);
    },
    startup: () => {
      live();
      for (const fn of started) fn();
    },
    settings: () => store['stampstack.settings'],
    local: () => store,
    localAccess: () => localAccess,
    rules: () => dynamicRules,
    script: (id) => registered.find((r) => r.id === id),
    scripts: () => registered,
    executed: () => executed,
    registerLog: () => registerLog,
    rulesetCalls: () => rulesetCalls,
    enabledRulesets: () => enabledRulesets,
    cssCalls: () => cssCalls,
    tabMessages: () => tabMessages,
    session: () => sessionStore,
    fullReads: () => fullReads,
    /** Package paths the worker fetched, in order. */
    fetched: () => fetched,
    failNext: (ids) => (rejectNext = new Set(ids)),
    refuseDynamicRules: (on) => (refuseDynamic = on),
  };
}

/** Match-pattern URL test for the tabs.query fake (scheme and host only). */
function patternCoversUrl(pattern, url) {
  const m = /^(\*|https?):\/\/([^/]+)\//.exec(pattern);
  if (!m || !url) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (m[1] !== '*' && `${m[1]}:` !== u.protocol) return false;
  if (m[1] === '*' && u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const h = m[2];
  if (h === '*') return true;
  if (h.startsWith('*.')) return u.hostname === h.slice(2) || u.hostname.endsWith(h.slice(1));
  return u.hostname === h;
}

/** Run `fn` with console.error captured; returns what was logged, one string per call. */
export async function capturingErrors(fn) {
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

/** Run `fn` with console.warn and console.info captured. */
export async function capturingWarnings(fn) {
  const logged = [];
  const orig = { warn: console.warn, info: console.info };
  console.warn = (...args) => logged.push(args.map(String).join(' '));
  console.info = (...args) => logged.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    Object.assign(console, orig);
  }
  return logged;
}

/** Size of the worker bundle as the tests load it (background.js without minification). */
export async function workerBundleBytes() {
  return Buffer.byteLength((await prepare()).bundle);
}
