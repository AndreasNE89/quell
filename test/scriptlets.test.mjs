// Pure helpers from the scriptlet library (bundled via esbuild like engine.test.mjs).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let mod;

before(async () => {
  const outfile = join(tmpdir(), `quell-scriptlets-${process.pid}.mjs`);
  await build({
    stdin: {
      contents: `
        export {
          unquoteArg,
          parsePrunePaths,
          pruneObject,
          stripYoutubeAdKeys,
          abortCurrentInlineScript,
        } from './src/scriptlets/library.js';
      `,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile,
  });
  mod = await import(`file://${outfile}?t=${Date.now()}`);
  process.on('exit', () => {
    try {
      rmSync(outfile);
    } catch {
      /* ignore */
    }
  });
});

test('unquoteArg strips uBO quoting around replacement needles', () => {
  assert.equal(mod.unquoteArg(`'"adPlacements"'`), '"adPlacements"');
  assert.equal(mod.unquoteArg(`"adSlots"`), 'adSlots');
  assert.equal(mod.unquoteArg(`'no_ads'`), 'no_ads');
});

test('parsePrunePaths splits space-separated dotted paths', () => {
  assert.deepEqual(mod.parsePrunePaths('adPlacements playerResponse.adSlots'), [
    ['adPlacements'],
    ['playerResponse', 'adSlots'],
  ]);
  assert.deepEqual(mod.parsePrunePaths('entries.[-].ad'), [['entries', '[-]', 'ad']]);
});

test('pruneObject deletes leaf keys and walks [-] arrays', () => {
  const obj = {
    adPlacements: [1],
    keep: true,
    entries: [{ ad: 1, x: 2 }, { y: 3 }],
  };
  mod.pruneObject(obj, mod.parsePrunePaths('adPlacements entries.[-].ad'));
  assert.equal(obj.adPlacements, undefined);
  assert.equal(obj.keep, true);
  assert.deepEqual(obj.entries, [{ x: 2 }, { y: 3 }]);
});

test('stripYoutubeAdKeys clears nested player ad fields to empty arrays', () => {
  const obj = {
    videoDetails: { title: 'ok' },
    adPlacements: [{ id: 'a' }],
    nested: { playerAds: [{ x: 1 }], adSlots: [1], ok: true },
  };
  mod.stripYoutubeAdKeys(obj);
  assert.deepEqual(obj.adPlacements, []);
  assert.deepEqual(obj.nested.playerAds, []);
  assert.deepEqual(obj.nested.adSlots, []);
  assert.equal(obj.nested.ok, true);
  assert.equal(obj.videoDetails.title, 'ok');
});

test('abort-current-inline-script setter retains assigned values', () => {
  // Minimal document/window so the scriptlet can install a property trap.
  const g = globalThis;
  const prevWindow = Object.getOwnPropertyDescriptor(g, 'window');
  const prevDocument = Object.getOwnPropertyDescriptor(g, 'document');
  const prevHTMLScript = g.HTMLScriptElement;
  class FakeHTMLScriptElement {}
  g.HTMLScriptElement = FakeHTMLScriptElement;
  const doc = { currentScript: null };
  Object.defineProperty(g, 'document', { value: doc, configurable: true, writable: true });
  Object.defineProperty(g, 'window', { value: g, configurable: true, writable: true });
  g.__acisProbe = 'initial';
  try {
    mod.abortCurrentInlineScript(['__acisProbe']);
    g.__acisProbe = 'after-assign';
    assert.equal(g.__acisProbe, 'after-assign');
  } finally {
    delete g.__acisProbe;
    if (prevWindow) Object.defineProperty(g, 'window', prevWindow);
    else delete g.window;
    if (prevDocument) Object.defineProperty(g, 'document', prevDocument);
    else delete g.document;
    if (prevHTMLScript) g.HTMLScriptElement = prevHTMLScript;
    else delete g.HTMLScriptElement;
  }
});
