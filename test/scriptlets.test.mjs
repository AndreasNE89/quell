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
          scrubInlineYoutubePlayerResponse,
          tickYoutubeAdSkipAssist,
          abortCurrentInlineScript,
          runScriptlet,
          urlMatchesNeedle,
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
    nested: { playerAds: [{ x: 1 }], adSlots: [1], adParams: { z: 1 }, ok: true },
  };
  mod.stripYoutubeAdKeys(obj);
  assert.deepEqual(obj.adPlacements, []);
  assert.deepEqual(obj.nested.playerAds, []);
  assert.deepEqual(obj.nested.adSlots, []);
  assert.equal(obj.nested.adParams, undefined);
  assert.equal(obj.nested.ok, true);
  assert.equal(obj.videoDetails.title, 'ok');
});

test('should scrub inline ytInitialPlayerResponse without replacing the object', () => {
  const g = globalThis;
  const prev = g.ytInitialPlayerResponse;
  const blob = {
    videoDetails: { title: 'watch' },
    adPlacements: [{ renderer: {} }],
    adSlots: [1],
  };
  g.ytInitialPlayerResponse = blob;
  try {
    mod.scrubInlineYoutubePlayerResponse();
    assert.equal(g.ytInitialPlayerResponse, blob);
    assert.deepEqual(blob.adPlacements, []);
    assert.deepEqual(blob.adSlots, []);
    assert.equal(blob.videoDetails.title, 'watch');
  } finally {
    if (prev === undefined) delete g.ytInitialPlayerResponse;
    else g.ytInitialPlayerResponse = prev;
  }
});

test('should seek video to end when html5 player is ad-showing', () => {
  const g = globalThis;
  const prevDoc = Object.getOwnPropertyDescriptor(g, 'document');
  const player = {
    classList: { contains: (c) => c === 'ad-showing' },
  };
  const video = { duration: 15, currentTime: 1 };
  const doc = {
    querySelector: (sel) => {
      const s = String(sel);
      if (s.includes('ytp-ad-skip') || s.includes('skip-ad')) return null;
      if (s === '.html5-video-player') return player;
      if (s.includes('html5-main-video') || s.includes('video-player video')) return video;
      return null;
    },
  };
  Object.defineProperty(g, 'document', { value: doc, configurable: true });
  try {
    mod.tickYoutubeAdSkipAssist();
    assert.equal(video.currentTime, 15);
  } finally {
    if (prevDoc) Object.defineProperty(g, 'document', prevDoc);
    else delete g.document;
  }
});

test('urlMatchesNeedle treats path needles as literals, not broken regexes', () => {
  const fb = 'https://www.facebook.com/api/graphql';
  // Real uBO Facebook SEARCH_ADS / MarketplaceFeedAdStory replace needles.
  assert.equal(mod.urlMatchesNeedle(fb, '/api/graphql'), true);
  assert.equal(mod.urlMatchesNeedle('https://example.com/other', '/api/graphql'), false);
  // Other common path needles from ubo-filters that used to throw on RegExp flags.
  assert.equal(mod.urlMatchesNeedle('https://www.dailymotion.com/player/metadata/video/x', '/player/metadata'), true);
  assert.equal(mod.urlMatchesNeedle('https://api.bilibili.com/x/v2/feed/rcmd', '/feed/rcmd'), true);
});

test('urlMatchesNeedle still accepts /pattern/flags regex needles', () => {
  assert.equal(mod.urlMatchesNeedle('https://www.youtube.com/youtubei/v1/player?key=1', '/player/i'), true);
  assert.equal(mod.urlMatchesNeedle('https://cdn.example.com/static.js', '/player/i'), false);
  assert.equal(mod.urlMatchesNeedle('https://x.test/ADS', '/ads/i'), true);
  assert.equal(mod.urlMatchesNeedle('*anything*', '*'), true);
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

test('acs short name aliases to abort-current-inline-script (uBO lists use acs, not acis)', () => {
  const g = globalThis;
  const prevWindow = Object.getOwnPropertyDescriptor(g, 'window');
  const prevDocument = Object.getOwnPropertyDescriptor(g, 'document');
  const prevHTMLScript = g.HTMLScriptElement;
  class FakeHTMLScriptElement {}
  g.HTMLScriptElement = FakeHTMLScriptElement;
  const doc = { currentScript: null };
  Object.defineProperty(g, 'document', { value: doc, configurable: true, writable: true });
  Object.defineProperty(g, 'window', { value: g, configurable: true, writable: true });
  g.__acsAliasProbe = 'initial';
  try {
    // Without the `acs` alias, runScriptlet no-ops and the assignment below would
    // just set a data property — the trap proves the scriptlet actually ran.
    mod.runScriptlet('acs', ['__acsAliasProbe']);
    g.__acsAliasProbe = 'after-assign';
    assert.equal(g.__acsAliasProbe, 'after-assign');
    doc.currentScript = new FakeHTMLScriptElement();
    Object.defineProperty(doc.currentScript, 'src', { value: '' });
    Object.defineProperty(doc.currentScript, 'textContent', { value: 'trigger' });
    assert.throws(() => g.__acsAliasProbe, /aborted inline script/);
  } finally {
    delete g.__acsAliasProbe;
    if (prevWindow) Object.defineProperty(g, 'window', prevWindow);
    else delete g.window;
    if (prevDocument) Object.defineProperty(g, 'document', prevDocument);
    else delete g.document;
    if (prevHTMLScript) g.HTMLScriptElement = prevHTMLScript;
    else delete g.HTMLScriptElement;
  }
});
