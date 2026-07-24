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

function installFakeChrome({ registerThrows = false } = {}) {
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
      contents: `export { syncOneRegisteredScript, registrationShape, forApi }
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

  assert.deepEqual(calls.map((c) => c[0]), ['get', 'unregister', 'register', 'update']);
  assert.deepEqual(
    store.get('quell-scriptlets-youtube').excludeMatches,
    ['*://fresh.example/*'],
    'the update fallback must still land our shape, not the racer\'s',
  );
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
