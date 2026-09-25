// Pure helpers from the scriptlet library (bundled via esbuild like engine.test.mjs).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import { SUPPORTED_SCRIPTLET_NAMES } from '../scripts/lib/scriptlet-safe.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let mod;

before(async () => {
  const outfile = join(tmpdir(), `quell-scriptlets-${process.pid}.mjs`);
  await build({
    stdin: {
      contents: `
        export {
          parsePrunePaths,
          pruneObject,
          stripYoutubeAdKeys,
          scrubInlineYoutubePlayerResponse,
          tickYoutubeAdSkipAssist,
          installYoutubeEarlyHooks,
          abortCurrentInlineScript,
          runScriptlet,
          urlMatchesNeedle,
          scriptletAliasNames,
          scriptletIsImplemented,
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

test('parsePrunePaths splits space-separated dotted paths', () => {
  assert.deepEqual(mod.parsePrunePaths('adPlacements playerResponse.adSlots'), [
    ['adPlacements'],
    ['playerResponse', 'adSlots'],
  ]);
  assert.deepEqual(mod.parsePrunePaths('entries.[-].ad'), [['entries', '[-]', 'ad']]);
});

test('pruneObject deletes leaf keys and [-] removes the whole matching entry', () => {
  const obj = {
    adPlacements: [1],
    keep: true,
    entries: [{ ad: 1, x: 2 }, { y: 3 }],
  };
  mod.pruneObject(obj, mod.parsePrunePaths('adPlacements entries.[-].ad'));
  assert.equal(obj.adPlacements, undefined);
  assert.equal(obj.keep, true);
  // uBO: `[-]` removes the entry that has the rest of the path. Stripping only the marker left
  // X and Facebook promoted items in the feed, rendered as organic posts.
  assert.deepEqual(obj.entries, [{ y: 3 }]);
});

test('pruneObject supports {-}, [], {} and * like uBO', () => {
  const pins = { pins: { a: { promo: 1 }, b: { x: 1 } } };
  mod.pruneObject(pins, mod.parsePrunePaths('pins.{-}.promo'));
  assert.deepEqual(pins, { pins: { b: { x: 1 } } }, '{-} removes the member holding the path');

  const list = { data: [{ vast_url: 'u' }, { vast_url: 'v', id: 2 }] };
  mod.pruneObject(list, mod.parsePrunePaths('data.[].vast_url'));
  assert.deepEqual(list, { data: [{}, { id: 2 }] }, '[] walks every entry and keeps it');

  const any = { a: { adserverDomain: 'x', k: 1 }, b: { k: 2 } };
  mod.pruneObject(any, mod.parsePrunePaths('*.adserverDomain'));
  assert.deepEqual(any, { a: { k: 1 }, b: { k: 2 } }, 'a * segment walks every member');

  const leaf = { data: { getTaboolaAds: { a: 1, b: 2 } } };
  mod.pruneObject(leaf, mod.parsePrunePaths('data.getTaboolaAds.*'));
  assert.deepEqual(leaf, { data: { getTaboolaAds: {} } }, 'a trailing * empties the owner');
});

/** Run `fn` with JSON.parse and Response#json restored afterwards (json-prune patches both). */
async function withJsonHooks(fn) {
  const nativeParse = JSON.parse;
  const nativeJson = Response.prototype.json;
  try {
    return await fn();
  } finally {
    JSON.parse = nativeParse;
    Response.prototype.json = nativeJson;
  }
}

test('json-prune prunes only when every needle path exists', () =>
  withJsonHooks(() => {
    // chip.de: `json-prune, enabled, force_disabled` removed `enabled` from every JSON document.
    mod.runScriptlet('json-prune', ['enabled', 'force_disabled']);
    assert.deepEqual(JSON.parse('{"enabled":true}'), { enabled: true });
    assert.deepEqual(JSON.parse('{"enabled":true,"force_disabled":1}'), { force_disabled: 1 });
  }));

test('json-prune also prunes bodies read with Response#json', () =>
  withJsonHooks(async () => {
    // Like the browser's native json(), which never goes through the page's JSON.parse. (Node's
    // own implementation does call it, which would hide a missing hook.)
    Response.prototype.json = async function () {
      return new Function(`return (${await this.text()});`)();
    };
    mod.runScriptlet('json-prune', ['ads']);
    const obj = await new Response('{"ads":[1],"k":2}').json();
    assert.deepEqual(obj, { k: 2 });
  }));

/** Swap in a fake window whose fetch() answers with `body`. */
async function withFetch(body, fn) {
  const saved = globalThis.window;
  globalThis.window = {
    fetch: async () => new Response(body, { headers: { 'content-type': 'application/json' } }),
  };
  try {
    return await fn();
  } finally {
    globalThis.window = saved;
  }
}

test('json-prune-fetch-response picks requests by propsToMatch', () =>
  withFetch(JSON.stringify({ ads: 1, k: 2 }), async () => {
    mod.runScriptlet('json-prune-fetch-response', ['ads', '', 'propsToMatch', 'url:/api/feed']);
    assert.deepEqual(await (await globalThis.window.fetch('https://x.test/api/feed')).json(), { k: 2 });
    assert.deepEqual(await (await globalThis.window.fetch('https://x.test/other')).json(), { ads: 1, k: 2 });
  }));

test('json-prune-fetch-response with only prune paths applies to every response', () =>
  withFetch(JSON.stringify({ ads: 1, k: 2 }), async () => {
    // The prune path used to double as the URL needle, so this only pruned URLs containing "ads".
    mod.runScriptlet('json-prune-fetch-response', ['ads']);
    assert.deepEqual(await (await globalThis.window.fetch('https://x.test/api/feed')).json(), { k: 2 });
  }));

test('a response rewrite of an NDJSON body is kept when every line stays valid', () =>
  withFetch('{"node":{"role":"SEARCH_ADS","x":1}}\n{"node":{"role":"ORGANIC"}}\n', async () => {
    // Facebook's SEARCH_ADS rule: the body never parses as one document, so the old validity
    // check reverted every rewrite.
    mod.runScriptlet('trusted-replace-fetch-response', [
      '/\\{"node":\\{"role":"SEARCH_ADS"[^\\n]+/',
      '{}',
      '/api/graphql',
    ]);
    const text = await (await globalThis.window.fetch('https://www.facebook.com/api/graphql/')).text();
    assert.equal(text, '{}\n{"node":{"role":"ORGANIC"}}\n');
  }));

test('quotes the parser left in an argument are literal, never stripped a second time', () =>
  withFetch('{"adPlacements":[1],"note":"see adPlacements docs"}', async () => {
    // uBO's `'"adPlacements"'` reaches the scriptlet as `"adPlacements"` (splitArgs removed the
    // outer quotes) and means the JSON key with its quotes. Unquoting again rewrote the text
    // inside every string value as well.
    mod.runScriptlet('trusted-replace-fetch-response', ['"adPlacements"', '"no_ads"', 'x.test']);
    const text = await (await globalThis.window.fetch('https://x.test/player')).text();
    assert.equal(text, '{"no_ads":[1],"note":"see adPlacements docs"}');
  }));

test('a rewrite that breaks an NDJSON line is still reverted', () =>
  withFetch('{"a":1}\n{"b":2}\n', async () => {
    mod.runScriptlet('trusted-replace-fetch-response', ['"b":2}', '"b":2', '/feed']);
    const text = await (await globalThis.window.fetch('https://x.test/feed')).text();
    assert.equal(text, '{"a":1}\n{"b":2}\n');
  }));

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

test('the YouTube skip assist outlives 10 minutes and observes only the player', () => {
  // YouTube is a single-page app: one document serves every video in the tab, so the old
  // 10-minute cutoff ended skipping for every later pre-roll and mid-roll.
  const g = globalThis;
  const saved = {
    setTimeout: g.setTimeout,
    setInterval: g.setInterval,
    now: Date.now,
    document: Object.getOwnPropertyDescriptor(g, 'document'),
    MutationObserver: g.MutationObserver,
    XMLHttpRequest: g.XMLHttpRequest,
    window: g.window,
  };
  let clock = 0;
  const timers = [];
  let adShowing = false;
  const player = { id: 'movie_player', classList: { contains: (c) => c === 'ad-showing' && adShowing } };
  const video = { duration: 30, currentTime: 1 };
  const observed = [];
  const root = { nodeName: 'HTML' };
  try {
    g.setTimeout = (fn, ms) => timers.push({ fn, at: clock + (ms || 0) });
    g.setInterval = () => 0;
    Date.now = () => clock;
    g.MutationObserver = class {
      observe(target) {
        observed.push(target);
      }
      disconnect() {}
    };
    Object.defineProperty(g, 'document', {
      configurable: true,
      writable: true,
      value: {
        documentElement: root,
        getElementById: (id) => (id === 'movie_player' ? player : null),
        querySelectorAll: () => [],
        querySelector: (sel) => {
          if (sel === '.html5-video-player') return player;
          if (String(sel).includes('video')) return video;
          return null;
        },
      },
    });
    g.window = { fetch: async () => new Response('') };
    g.XMLHttpRequest = class {
      get responseText() {
        return '';
      }
      get response() {
        return '';
      }
      open() {}
      send() {}
    };

    mod.installYoutubeEarlyHooks();
    const runUntil = (t) => {
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        if (!timers.length || timers[0].at > t) break;
        const next = timers.shift();
        clock = next.at;
        next.fn();
      }
      clock = t;
    };
    runUntil(11 * 60_000);
    assert.ok(timers.length > 0, 'the poll must still be scheduled after 10 minutes');
    adShowing = true;
    runUntil(11 * 60_000 + 1500);
    assert.equal(video.currentTime, 30, 'a mid-roll at minute 11 is still seeked past');
    assert.deepEqual(observed, [player], 'the observer watches the player, not the whole document');
  } finally {
    delete g.__quellYtEarly;
    g.setTimeout = saved.setTimeout;
    g.setInterval = saved.setInterval;
    Date.now = saved.now;
    if (saved.document) Object.defineProperty(g, 'document', saved.document);
    else delete g.document;
    g.MutationObserver = saved.MutationObserver;
    g.XMLHttpRequest = saved.XMLHttpRequest;
    g.window = saved.window;
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

// --- abort-current-script (acs) ------------------------------------------------------------

/**
 * Minimal window/document for acs: window is globalThis, and `script(src, text)` builds the
 * element document.currentScript points at while a "script" runs.
 */
function withAcsEnv(fn) {
  const g = globalThis;
  const prevWindow = Object.getOwnPropertyDescriptor(g, 'window');
  const prevDocument = Object.getOwnPropertyDescriptor(g, 'document');
  const prevHTMLScript = g.HTMLScriptElement;
  class FakeHTMLScriptElement {}
  g.HTMLScriptElement = FakeHTMLScriptElement;
  const doc = { currentScript: null };
  Object.defineProperty(g, 'document', { value: doc, configurable: true, writable: true });
  Object.defineProperty(g, 'window', { value: g, configurable: true, writable: true });
  const script = (src, text) => {
    const el = new FakeHTMLScriptElement();
    Object.defineProperty(el, 'src', { value: src });
    Object.defineProperty(el, 'textContent', { value: text });
    return el;
  };
  g.__acsProbe = 'initial';
  try {
    fn({ g, doc, script });
  } finally {
    delete g.__acsProbe;
    delete g.__acsAliasProbe;
    delete g.__acsDoc;
    if (prevWindow) Object.defineProperty(g, 'window', prevWindow);
    else delete g.window;
    if (prevDocument) Object.defineProperty(g, 'document', prevDocument);
    else delete g.document;
    if (prevHTMLScript) g.HTMLScriptElement = prevHTMLScript;
    else delete g.HTMLScriptElement;
  }
}

test('abort-current-inline-script setter retains assigned values', () =>
  withAcsEnv(({ g }) => {
    mod.abortCurrentInlineScript(['__acsProbe']);
    g.__acsProbe = 'after-assign';
    assert.equal(g.__acsProbe, 'after-assign');
  }));

test('acs short name aliases to abort-current-inline-script (uBO lists use acs, not acis)', () =>
  withAcsEnv(({ g, doc, script }) => {
    g.__acsAliasProbe = 'initial';
    // Without the `acs` alias, runScriptlet no-ops and the assignment below would
    // just set a data property — the trap proves the scriptlet actually ran.
    mod.runScriptlet('acs', ['__acsAliasProbe']);
    g.__acsAliasProbe = 'after-assign';
    assert.equal(g.__acsAliasProbe, 'after-assign');
    doc.currentScript = script('', 'trigger');
    assert.throws(() => g.__acsAliasProbe, /aborted current script/);
  }));

test('acs keeps inherited methods and accessors working for other scripts', () =>
  withAcsEnv(({ g }) => {
    // What document.createElement and document.cookie look like: a method and an accessor on a
    // prototype, not own properties. Both used to read back as undefined for every script.
    class Base {
      constructor() {
        this.jar = '';
      }
      get cookie() {
        return this.jar;
      }
      set cookie(v) {
        this.jar = v;
      }
      make(tag) {
        return { tag };
      }
    }
    g.__acsDoc = new (class extends Base {})();
    mod.runScriptlet('acs', ['__acsDoc.make', 'admiral']);
    mod.runScriptlet('acs', ['__acsDoc.cookie', 'admiral']);
    assert.deepEqual(g.__acsDoc.make('div'), { tag: 'div' });
    g.__acsDoc.cookie = 'a=1';
    assert.equal(g.__acsDoc.jar, 'a=1', 'a write must reach the real setter');
    assert.equal(g.__acsDoc.cookie, 'a=1');
  }));

test('acs aborts a matching script that writes the property', () =>
  withAcsEnv(({ g, doc, script }) => {
    mod.runScriptlet('acs', ['__acsProbe', 'adblock']);
    doc.currentScript = script('', 'if (adblock) window.__acsProbe = 1;');
    assert.throws(() => {
      g.__acsProbe = 1;
    }, /aborted current script/);
  }));

test('acs without a needle aborts external scripts too; with one, their empty text never matches', () =>
  withAcsEnv(({ g, doc, script }) => {
    mod.runScriptlet('acs', ['__acsProbe']);
    doc.currentScript = script('https://cdn.test/ads.js', '');
    assert.throws(() => g.__acsProbe, /aborted current script/);

    g.__acsAliasProbe = 'v';
    mod.runScriptlet('acs', ['__acsAliasProbe', 'adblock']);
    assert.equal(g.__acsAliasProbe, 'v');
  }));

test('acs context limits the rule to matching script URLs, decoding data: scripts', () =>
  withAcsEnv(({ g, doc, script }) => {
    // 2tencb.*##+js(acs, WebAssembly, atob, /^data:/)
    mod.runScriptlet('acs', ['__acsProbe', 'atob', '/^data:/']);
    doc.currentScript = script(`data:text/javascript;base64,${btoa('var x = atob("eA==");')}`, '');
    assert.throws(() => g.__acsProbe, /aborted current script/, 'base64 data: body matches');
    doc.currentScript = script(`data:text/javascript,${encodeURIComponent('atob(1)')}`, '');
    assert.throws(() => g.__acsProbe, /aborted current script/, 'URL-encoded data: body matches');
    doc.currentScript = script('', 'atob(1)');
    assert.equal(g.__acsProbe, 'initial', 'an inline script is outside the data: context');
  }));

test('the compile-time supported list matches the runtime alias map exactly', () => {
  // compile-filters.mjs drops scriptlet rules whose name has no handler. If that list drifts
  // from the runtime map, either working rules get discarded (list too small) or dead rules
  // keep shipping (list too large). Both are silent, so assert equality here.
  const runtime = new Set(mod.scriptletAliasNames());
  const compile = SUPPORTED_SCRIPTLET_NAMES;

  const missingFromCompile = [...runtime].filter((n) => !compile.has(n));
  const staleInCompile = [...compile].filter((n) => !runtime.has(n));

  assert.deepEqual(
    missingFromCompile,
    [],
    'implemented scriptlets missing from SUPPORTED_SCRIPTLET_NAMES — their rules are being dropped',
  );
  assert.deepEqual(
    staleInCompile,
    [],
    'SUPPORTED_SCRIPTLET_NAMES lists scriptlets the runtime cannot run',
  );
});

test('every supported alias resolves to a real handler', () => {
  for (const name of SUPPORTED_SCRIPTLET_NAMES) {
    assert.equal(mod.scriptletIsImplemented(name), true, name);
  }
  assert.equal(mod.scriptletIsImplemented('abort-current-script'), true, "uBO's canonical acs name");
  // Still unimplemented — the next tranche worth closing, by shipped rule count.
  for (const name of ['xml-prune', 'nobab', 'nofab', 'trusted-set', 'definitely-not-real']) {
    assert.equal(mod.scriptletIsImplemented(name), false, name);
  }
});
