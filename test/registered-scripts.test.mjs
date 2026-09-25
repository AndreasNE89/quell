// chrome.scripting registration sync.
//
// The bug this guards: updateContentScripts is a DELTA update, so a property omitted from the
// payload keeps its previous value. Every call site passed `excludeMatches: xs.length ? xs :
// undefined`, meaning an exclude set that shrank to empty was never applied — and
// persistAcrossSessions carried the stale value across browser restarts. Concretely:
// allowlist youtube.com from the popup, then un-allowlist it, and the YouTube MAIN-world ad
// hooks stay excluded from YouTube for the life of the profile.
//
// The fake below implements the real delta semantics of updateContentScripts. That is what
// makes the test meaningful: a fake that replaced the whole record would pass against the
// broken implementation too.
//
// B4 (REVIEW_2026-09-24): replacing a registration means unregister, then register. When Chrome
// rejected the new payload (one invalid exclude pattern fails the whole call), the old code
// "patched" the id it had just removed, which threw "does not exist" over the real error and
// left the working script deleted for good. The fake models that rejection too.

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let mod;
let store;
let calls;

/**
 * Model the extension IDL boundary: a dictionary member whose value is `undefined` is treated
 * as NOT PRESENT, so it never reaches the delta merge. This is precisely why passing
 * `excludeMatches: xs.length ? xs : undefined` could never clear an exclude set.
 */
function overIpc(script) {
  const out = {};
  for (const [k, v] of Object.entries(script)) if (v !== undefined) out[k] = v;
  return out;
}

/** Chrome's wording when a pattern in a registerContentScripts payload does not parse. */
const INVALID_HOST =
  "Script with ID 'quell-scriptlets-youtube' has invalid value for exclude_matches[0]: Invalid host.";

function installFakeChrome({
  registerThrows = false,
  rejectPattern = null,
  rejectAll = false,
} = {}) {
  store = new Map();
  calls = [];
  globalThis.chrome = {
    scripting: {
      async getRegisteredContentScripts({ ids } = {}) {
        calls.push(['get', ids]);
        const all = [...store.values()];
        return ids ? all.filter((s) => ids.includes(s.id)) : all;
      },
      async registerContentScripts(scripts) {
        calls.push(['register', scripts.map((s) => s.id)]);
        // Chrome validates the whole batch before registering any of it.
        const bad = scripts.some(
          (s) => rejectAll || (rejectPattern && (s.excludeMatches ?? []).includes(rejectPattern)),
        );
        if (bad) throw new Error(INVALID_HOST);
        if (registerThrows) {
          // Model the real race: a concurrent sync claimed the id between our unregister and
          // our register, so the id is live again (with someone else's shape) and register
          // fails as a duplicate.
          for (const s of scripts) store.set(s.id, structuredClone({ ...s, excludeMatches: ['*://stale.example/*'] }));
          throw new Error('duplicate id');
        }
        for (const s of scripts) {
          if (store.has(s.id)) throw new Error(`duplicate id ${s.id}`);
          store.set(s.id, structuredClone(overIpc(s)));
        }
      },
      async updateContentScripts(scripts) {
        calls.push(['update', scripts.map((s) => s.id)]);
        for (const s of scripts) {
          const prev = store.get(s.id);
          if (!prev) throw new Error(`no such id ${s.id}`);
          // Delta semantics: only properties PRESENT in the payload are changed.
          store.set(s.id, structuredClone({ ...prev, ...overIpc(s) }));
        }
      },
      async unregisterContentScripts({ ids }) {
        calls.push(['unregister', ids]);
        for (const id of ids) store.delete(id);
      },
    },
  };
}

const script = (over = {}) => ({
  id: 'quell-scriptlets-youtube',
  js: ['scriptlets-youtube.js'],
  matches: ['*://*.youtube.com/*'],
  excludeMatches: [],
  runAt: 'document_start',
  allFrames: true,
  world: 'MAIN',
  persistAcrossSessions: true,
  ...over,
});

before(async () => {
  const outfile = join(tmpdir(), `quell-regscripts-${process.pid}.mjs`);
  await build({
    stdin: {
      contents: `export { syncOneRegisteredScript, syncRegisteredScriptGroup, registrationShape, forApi }
                 from './src/background/registered-scripts.js';`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile,
  });
  mod = await import(`file://${outfile}?t=${process.pid}`);
  process.on('exit', () => {
    try {
      rmSync(outfile);
    } catch {
      /* ignore */
    }
  });
});

beforeEach(() => installFakeChrome());

test('registers when absent, and omits empty arrays the API treats as "none"', async () => {
  await mod.syncOneRegisteredScript(script(), true);
  const live = store.get('quell-scriptlets-youtube');
  assert.ok(live);
  assert.equal('excludeMatches' in live, false, 'empty excludeMatches should not be sent');
  assert.deepEqual(live.matches, ['*://*.youtube.com/*']);
});

test('a shrinking excludeMatches is actually applied (the H4 regression)', async () => {
  // 1. user allowlists youtube.com
  await mod.syncOneRegisteredScript(script({ excludeMatches: ['*://*.youtube.com/*'] }), true);
  assert.deepEqual(store.get('quell-scriptlets-youtube').excludeMatches, [
    '*://*.youtube.com/*',
  ]);

  // 2. user removes the allowlist entry — the exclude set is now empty
  await mod.syncOneRegisteredScript(script({ excludeMatches: [] }), true);

  const live = store.get('quell-scriptlets-youtube');
  assert.deepEqual(
    live.excludeMatches ?? [],
    [],
    'stale exclude survived: YouTube hooks would never register on YouTube again',
  );
  assert.deepEqual(live.matches, ['*://*.youtube.com/*']);
});

test('a growing excludeMatches is applied too', async () => {
  await mod.syncOneRegisteredScript(script(), true);
  await mod.syncOneRegisteredScript(script({ excludeMatches: ['*://a.example/*'] }), true);
  assert.deepEqual(store.get('quell-scriptlets-youtube').excludeMatches, ['*://a.example/*']);
});

test('an unchanged registration is not rewritten', async () => {
  await mod.syncOneRegisteredScript(script({ excludeMatches: ['*://a.example/*'] }), true);
  const before = calls.length;
  await mod.syncOneRegisteredScript(script({ excludeMatches: ['*://a.example/*'] }), true);
  const after = calls.slice(before).map((c) => c[0]);
  assert.deepEqual(after, ['get'], 'a no-op sync should not unregister/register');
});

test('match-order differences do not count as a change', async () => {
  await mod.syncOneRegisteredScript(script({ matches: ['*://a.example/*', '*://b.example/*'] }), true);
  const before = calls.length;
  await mod.syncOneRegisteredScript(script({ matches: ['*://b.example/*', '*://a.example/*'] }), true);
  assert.deepEqual(calls.slice(before).map((c) => c[0]), ['get']);
});

test('disabled unregisters, and is a no-op when already absent', async () => {
  await mod.syncOneRegisteredScript(script(), true);
  await mod.syncOneRegisteredScript(script(), false);
  assert.equal(store.has('quell-scriptlets-youtube'), false);

  const before = calls.length;
  await mod.syncOneRegisteredScript(script(), false);
  assert.deepEqual(calls.slice(before).map((c) => c[0]), ['get']);
});

test('a lost register race falls back to update instead of throwing', async () => {
  installFakeChrome({ registerThrows: true });
  store.set('quell-scriptlets-youtube', script({ excludeMatches: ['*://old.example/*'] }));

  await mod.syncOneRegisteredScript(script({ excludeMatches: ['*://fresh.example/*'] }), true);

  // The second get is how a lost race is told apart from a rejected payload: the id is live.
  assert.deepEqual(calls.map((c) => c[0]), ['get', 'unregister', 'register', 'get', 'update']);
  assert.deepEqual(
    store.get('quell-scriptlets-youtube').excludeMatches,
    ['*://fresh.example/*'],
    'the update fallback must still land our shape, not the racer\'s',
  );
});

test('a rejected payload puts the previous registration back and reports the error Chrome gave', async () => {
  const BAD = '*://www.192.168/*';
  installFakeChrome({ rejectPattern: BAD });
  await mod.syncOneRegisteredScript(script({ excludeMatches: ['*://a.example/*'] }), true);

  await assert.rejects(
    mod.syncOneRegisteredScript(script({ excludeMatches: ['*://a.example/*', BAD] }), true),
    (err) => err.message === INVALID_HOST,
    'the caller must see why Chrome refused, not a follow-up "does not exist"',
  );

  const live = store.get('quell-scriptlets-youtube');
  assert.ok(live, 'the working registration was deleted');
  assert.deepEqual(live.excludeMatches, ['*://a.example/*']);
  assert.deepEqual(live.js, ['scriptlets-youtube.js']);
  assert.equal(
    calls.some((c) => c[0] === 'update'),
    false,
    'nothing is registered under this id, so there is nothing to patch',
  );
});

test('a rejected first registration leaves nothing behind and reports the real error', async () => {
  installFakeChrome({ rejectAll: true });
  await assert.rejects(
    mod.syncOneRegisteredScript(script(), true),
    (err) => err.message === INVALID_HOST,
  );
  assert.equal(store.size, 0);
  assert.deepEqual(calls.map((c) => c[0]), ['get', 'register', 'get']);
});

test('when the restore fails too, the original error is still the one reported', async () => {
  installFakeChrome();
  await mod.syncOneRegisteredScript(script(), true);
  installFakeChrome({ rejectAll: true });
  store.set('quell-scriptlets-youtube', structuredClone(overIpc(script())));

  const logged = [];
  const origError = console.error;
  console.error = (...args) => logged.push(args);
  try {
    await assert.rejects(
      mod.syncOneRegisteredScript(script({ excludeMatches: ['*://a.example/*'] }), true),
      (err) => err.message === INVALID_HOST,
    );
  } finally {
    console.error = origError;
  }
  assert.deepEqual(calls.map((c) => c[0]), ['get', 'unregister', 'register', 'get', 'register']);
  assert.equal(logged.length, 1, 'the failed restore is logged, not swallowed');
});

test('registrationShape ignores ordering but not content', () => {
  const a = mod.registrationShape({ matches: ['x', 'y'], excludeMatches: [] });
  const b = mod.registrationShape({ matches: ['y', 'x'] });
  assert.equal(a, b, 'absent and empty arrays must compare equal');
  assert.notEqual(a, mod.registrationShape({ matches: ['x'] }));
});

test('forApi drops empty arrays but keeps populated ones', () => {
  const out = mod.forApi({ id: 'a', matches: ['*://x/*'], js: [], css: [], excludeMatches: ['e'] });
  assert.equal('js' in out, false);
  assert.equal('css' in out, false);
  assert.deepEqual(out.excludeMatches, ['e']);
});

test('registrationShape notices matchOriginAsFallback', () => {
  assert.equal(
    mod.registrationShape({ matches: ['x'] }),
    mod.registrationShape({ matches: ['x'], matchOriginAsFallback: false }),
  );
  assert.notEqual(
    mod.registrationShape({ matches: ['x'] }),
    mod.registrationShape({ matches: ['x'], matchOriginAsFallback: true }),
  );
});

// The list-scriptlet shards (REVIEW_2026-09-24 B2) are a group of registrations with thousands of
// patterns each, re-checked on every service-worker wake.

const shard = (id, over = {}) => {
  const built = { count: 0 };
  const s = {
    id,
    js: [`generated/scriptlets/list.${id}.v1.js`, 'scriptlets-runtime.js'],
    matches: () => {
      built.count++;
      return [`*://*.${id}.example/*`];
    },
    excludeMatches: [],
    runAt: 'document_start',
    allFrames: true,
    matchOriginAsFallback: true,
    world: 'MAIN',
    persistAcrossSessions: true,
    ...over,
  };
  return Object.assign(s, { built });
};

test('a script group registers what is missing and removes ids an older build left', async () => {
  store.set('quell-sl-99', { id: 'quell-sl-99', js: ['old.js'], matches: ['*://old.example/*'] });
  store.set('quell-generic-cosmetic', { id: 'quell-generic-cosmetic', css: ['a.css'], matches: ['<all_urls>'] });

  const live = await mod.syncRegisteredScriptGroup('quell-sl-', [shard('quell-sl-0'), shard('quell-sl-1')]);

  assert.deepEqual([...store.keys()].sort(), ['quell-generic-cosmetic', 'quell-sl-0', 'quell-sl-1']);
  assert.deepEqual(store.get('quell-sl-0').matches, ['*://*.quell-sl-0.example/*']);
  assert.equal(store.get('quell-sl-0').matchOriginAsFallback, true);
  assert.deepEqual([...live.keys()].sort(), ['quell-sl-0', 'quell-sl-1']);
  assert.deepEqual(live.get('quell-sl-1'), ['generated/scriptlets/list.quell-sl-1.v1.js', 'scriptlets-runtime.js']);
});

test('an unchanged script group is not rewritten, and its patterns are never built', async () => {
  await mod.syncRegisteredScriptGroup('quell-sl-', [shard('quell-sl-0'), shard('quell-sl-1')]);
  const before = calls.length;
  const again = [shard('quell-sl-0'), shard('quell-sl-1')];
  const live = await mod.syncRegisteredScriptGroup('quell-sl-', again);
  assert.deepEqual(calls.slice(before).map((c) => c[0]), ['get']);
  assert.deepEqual(again.map((s) => s.built.count), [0, 0]);
  assert.equal(live.size, 2);
});

test('script group changes reach Chrome as one unregister and one register call', async () => {
  // Each call makes Chrome reload the extension's scripts in every renderer.
  await mod.syncRegisteredScriptGroup('quell-sl-', [shard('quell-sl-0'), shard('quell-sl-1')]);
  const before = calls.length;
  const allowlisted = { excludeMatches: ['*://*.news.example/*'] };
  await mod.syncRegisteredScriptGroup('quell-sl-', [
    shard('quell-sl-0', allowlisted),
    shard('quell-sl-1', allowlisted),
    shard('quell-sl-2', allowlisted),
  ]);
  assert.deepEqual(calls.slice(before), [
    ['get', undefined],
    ['unregister', ['quell-sl-0', 'quell-sl-1']],
    ['register', ['quell-sl-0', 'quell-sl-1', 'quell-sl-2']],
  ]);
  for (const id of ['quell-sl-0', 'quell-sl-1', 'quell-sl-2']) {
    assert.deepEqual(store.get(id).excludeMatches, ['*://*.news.example/*']);
  }
});

test('a refused script group keeps what Chrome accepts, restores the rest, and reports why', async () => {
  const BAD = '*://www.192.168/*';
  installFakeChrome({ rejectPattern: BAD });
  await mod.syncRegisteredScriptGroup('quell-sl-', [shard('quell-sl-0'), shard('quell-sl-1')]);

  await assert.rejects(
    mod.syncRegisteredScriptGroup('quell-sl-', [
      shard('quell-sl-0', { js: ['generated/scriptlets/list.quell-sl-0.v2.js', 'scriptlets-runtime.js'] }),
      shard('quell-sl-1', { excludeMatches: [BAD] }),
    ]),
    (err) => err.message === INVALID_HOST,
  );
  assert.deepEqual(store.get('quell-sl-0').js[0], 'generated/scriptlets/list.quell-sl-0.v2.js');
  assert.ok(store.get('quell-sl-1'), 'the refused script lost its working registration');
  assert.equal('excludeMatches' in store.get('quell-sl-1'), false);
});
