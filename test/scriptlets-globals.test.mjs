// Global-patching scriptlets: popunder defuser, listener defuser, fetch/timer/eval guards.
//
// These recover ~2,391 shipped rules that were previously compiled away as unimplemented. The
// risk profile is the opposite of a missing scriptlet: one that misfires does not fail safe, it
// breaks the page. So every test here pins BOTH halves — the block on a match, and the
// untouched pass-through on a non-match.
//
// Driven through runScriptlet (the real entry point) so alias resolution is covered too. The
// fake `window` here has only own properties; test/scriptlets-dom.test.mjs covers the inherited
// and native members a real page has.

import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let mod;

/** Saved so a patched prototype cannot leak into node internals or the next test. */
let savedAddEventListener;
let savedWindow;

before(async () => {
  const outfile = join(tmpdir(), `quell-globals-${process.pid}.mjs`);
  await build({
    stdin: {
      contents: `export { runScriptlet } from './src/scriptlets/library.js';`,
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

beforeEach(() => {
  savedAddEventListener = EventTarget.prototype.addEventListener;
  savedWindow = globalThis.window;
  // A minimal window the scriptlets can patch. Each test gets a fresh one so patches from a
  // previous test cannot bleed across.
  globalThis.window = {
    open: (...a) => ({ real: true, args: a }),
    fetch: (...a) => Promise.resolve({ real: true, args: a }),
    setTimeout: (cb, delay, ...rest) => ({ real: true, cb, delay, rest }),
    setInterval: (cb, delay, ...rest) => ({ real: true, cb, delay, rest }),
    eval: (code) => ({ real: true, code }),
  };
});

afterEach(() => {
  EventTarget.prototype.addEventListener = savedAddEventListener;
  globalThis.window = savedWindow;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- no-window-open-if / nowoif -------------------------------------------------------------

test('nowoif returns a decoy, never null, for a matching URL', () => {
  mod.runScriptlet('nowoif', ['/ads/']);
  const handle = globalThis.window.open('https://x.test/ads/pop.html');
  assert.ok(handle, 'a null handle is exactly what a popup blocker returns');
  assert.equal(handle.real, undefined, 'the real window.open must not have run');
  // Anti-adblock scripts test for null to detect blocking, so the decoy has to look like a
  // window and absorb the pokes a popunder does on its handle.
  assert.equal(handle.closed, false);
  assert.equal(typeof handle.close, 'function');
  assert.equal(typeof handle.focus, 'function');
  assert.equal(typeof handle.postMessage, 'function');
  handle.close();
  assert.equal(handle.closed, true, 'close() must flip closed');
});

test('nowoif leaves a non-matching URL alone', () => {
  mod.runScriptlet('nowoif', ['/ads/']);
  const handle = globalThis.window.open('https://x.test/legit/page.html');
  assert.equal(handle.real, true, 'the real window.open must still run');
});

test('nowoif with an empty pattern blocks every popup', () => {
  mod.runScriptlet('nowoif', []);
  assert.equal(globalThis.window.open('https://anything.test/').real, undefined);
});

test('nowoif supports regex and negated patterns', () => {
  mod.runScriptlet('no-window-open-if', ['/pop[0-9]+/']);
  assert.equal(globalThis.window.open('https://x.test/pop42').real, undefined);
  assert.equal(globalThis.window.open('https://x.test/popup').real, true);

  globalThis.window.open = (...a) => ({ real: true, args: a });
  mod.runScriptlet('no-window-open-if', ['!good.test']);
  assert.equal(globalThis.window.open('https://bad.test/x').real, undefined, 'negated: blocks others');
  assert.equal(globalThis.window.open('https://good.test/x').real, true, 'negated: allows the match');
});

test('nowoif matches the target and features, not only the URL', () => {
  // 97 shipped rules are `nowoif, _blank`: the target is the only thing they can match.
  mod.runScriptlet('nowoif', ['_blank']);
  assert.equal(globalThis.window.open('https://pop.ads.test/x', '_blank').real, undefined);
  assert.equal(globalThis.window.open('https://site.test/next', '_self').real, true);
});

test('a negated _self rule lets same-tab navigation through', () => {
  // Shipped shape: `!/^\/|_self|alexsports|nativesurge/`. Matching the URL alone inverted it and
  // swallowed the site's own window.open(url, '_self') navigation.
  mod.runScriptlet('nowoif', ['!/^\\/|_self|alexsports/']);
  assert.equal(globalThis.window.open('https://site.test/next', '_self').real, true);
  assert.equal(globalThis.window.open('https://pop.test/x', '_blank').real, undefined);
});

test('a path-like pattern is a literal, not a regex with bogus flags', () => {
  mod.runScriptlet('nowoif', ['/api/graphql']);
  assert.equal(globalThis.window.open('https://x.test/api/graphql?q=1').real, undefined);
  assert.equal(globalThis.window.open('https://x.test/other').real, true);
});

test('the nowoif delay is in seconds', async () => {
  // `nowoif, , 10` closed the decoy after 10 ms instead of 10 s, so a popunder polling
  // handle.closed saw an instantly closed popup and retried.
  mod.runScriptlet('nowoif', ['', '0.2']);
  const handle = globalThis.window.open('https://pop.test/');
  await sleep(40);
  assert.equal(handle.closed, false, 'still open well before 0.2 s');
  await sleep(260);
  assert.equal(handle.closed, true, 'closed once the delay has passed');
});

test('the blank decoy opens about:blank for real', () => {
  mod.runScriptlet('nowoif', ['ads', '0', 'blank']);
  const handle = globalThis.window.open('https://ads.test/pop', 'pop');
  assert.equal(handle.real, true);
  assert.deepEqual(handle.args, ['about:blank', 'pop']);
});

// --- popads-dummy ----------------------------------------------------------------------------

test('popads-dummy pins non-writable stubs the loader cannot replace', () => {
  mod.runScriptlet('popads-dummy', []);
  assert.deepEqual(globalThis.window.PopAds, {});
  assert.equal(Reflect.set(globalThis.window, 'PopAds', { loader: 'real' }), false);
  assert.equal(Reflect.set(globalThis.window, 'popns', true), false);
  assert.deepEqual(globalThis.window.PopAds, {});
});

// --- addEventListener-defuser / aeld --------------------------------------------------------

test('aeld drops a listener when type and handler both match', () => {
  mod.runScriptlet('aeld', ['click', 'showAd']);
  const target = new EventTarget();
  let fired = 0;
  target.addEventListener('click', function handler() {
    void 'showAd';
    fired++;
  });
  target.dispatchEvent(new Event('click'));
  assert.equal(fired, 0, 'the matching listener should never have registered');
});

test('aeld keeps listeners whose handler does not match', () => {
  mod.runScriptlet('aeld', ['click', 'showAd']);
  const target = new EventTarget();
  let fired = 0;
  target.addEventListener('click', () => {
    fired++;
  });
  target.dispatchEvent(new Event('click'));
  assert.equal(fired, 1, 'an unrelated click listener must still work');
});

test('aeld keeps listeners of a different type', () => {
  mod.runScriptlet('aeld', ['click', '']);
  const target = new EventTarget();
  let fired = 0;
  target.addEventListener('scroll', () => {
    fired++;
  });
  target.dispatchEvent(new Event('scroll'));
  assert.equal(fired, 1);
});

test('aeld matches a literal type exactly', () => {
  // `click` must not also take dblclick, nor `load` unload/loadeddata.
  mod.runScriptlet('aeld', ['click', '']);
  const target = new EventTarget();
  const fired = [];
  target.addEventListener('dblclick', () => fired.push('dblclick'));
  target.addEventListener('click', () => fired.push('click'));
  target.dispatchEvent(new Event('dblclick'));
  target.dispatchEvent(new Event('click'));
  assert.deepEqual(fired, ['dblclick']);
});

test('aeld with an empty type matches any type', () => {
  mod.runScriptlet('aeld', ['', 'trackMe']);
  const target = new EventTarget();
  let fired = 0;
  target.addEventListener('custom', function h() {
    void 'trackMe';
    fired++;
  });
  target.dispatchEvent(new Event('custom'));
  assert.equal(fired, 0);
});

test('aeld with neither a type nor a pattern drops nothing', () => {
  // uBO only logs in that case; matching both wildcards would remove every listener on the page.
  mod.runScriptlet('aeld', ['', '']);
  const target = new EventTarget();
  let fired = 0;
  target.addEventListener('click', () => fired++);
  target.dispatchEvent(new Event('click'));
  assert.equal(fired, 1);
});

test('aeld judges a listener object by its handleEvent source', () => {
  mod.runScriptlet('aeld', ['click', 'showAd']);
  const target = new EventTarget();
  let fired = 0;
  target.addEventListener('click', {
    handleEvent() {
      void 'showAd';
      fired++;
    },
  });
  target.dispatchEvent(new Event('click'));
  assert.equal(fired, 0);
});

test('aeld treats a leading ! as text, as uBO does', () => {
  // Shipped: `aeld, click, !adShown` targets handlers containing `if (!adShown)`. As a negation
  // it would have dropped every OTHER click listener on the site.
  mod.runScriptlet('aeld', ['click', '!adShown']);
  const target = new EventTarget();
  const fired = [];
  target.addEventListener('click', function gate() {
    const adShown = globalThis.adShown;
    if (!adShown) fired.push('gate');
  });
  target.addEventListener('click', () => fired.push('nav'));
  target.dispatchEvent(new Event('click'));
  assert.deepEqual(fired, ['nav']);
});

test('aeld honors the elements restriction', () => {
  // `link.paid4link.com##+js(aeld, click, , elements, #get-link-button)` removed every click
  // listener on the site, navigation included.
  mod.runScriptlet('aeld', ['click', '', 'elements', '#get-link-button']);
  class FakeElement extends EventTarget {
    constructor(id) {
      super();
      this.id = id;
    }
    matches(sel) {
      return sel === `#${this.id}`;
    }
  }
  const button = new FakeElement('get-link-button');
  const nav = new FakeElement('nav');
  const fired = [];
  button.addEventListener('click', () => fired.push('button'));
  nav.addEventListener('click', () => fired.push('nav'));
  button.dispatchEvent(new Event('click'));
  nav.dispatchEvent(new Event('click'));
  assert.deepEqual(fired, ['nav']);
});

// --- no-fetch-if ----------------------------------------------------------------------------

test('no-fetch-if resolves an empty 200 rather than rejecting', async () => {
  mod.runScriptlet('no-fetch-if', ['/track']);
  const res = await globalThis.window.fetch('https://x.test/track?id=1');
  // A rejection is observable; several anti-adblock scripts count fetch failures.
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '');
});

test('no-fetch-if passes a non-matching request through', async () => {
  mod.runScriptlet('no-fetch-if', ['/track']);
  const res = await globalThis.window.fetch('https://x.test/api/data');
  assert.equal(res.real, true);
});

test('no-fetch-if honors a method: constraint', async () => {
  mod.runScriptlet('no-fetch-if', ['url:/beacon method:POST']);
  assert.equal((await globalThis.window.fetch('https://x.test/beacon')).real, true, 'GET passes');
  const blocked = await globalThis.window.fetch('https://x.test/beacon', { method: 'POST' });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.real, undefined);
});

test('no-fetch-if can synthesize the documented body shapes', async () => {
  mod.runScriptlet('no-fetch-if', ['/a', 'emptyObj']);
  assert.equal(await (await globalThis.window.fetch('https://x.test/a')).text(), '{}');

  globalThis.window.fetch = () => Promise.resolve({ real: true });
  mod.runScriptlet('no-fetch-if', ['/b', 'emptyArr']);
  assert.equal(await (await globalThis.window.fetch('https://x.test/b')).text(), '[]');
});

test('no-fetch-if matches any request property, not just url and method', async () => {
  // `mode:no-cors` was read as a URL substring, so the 9 shipped rules never matched.
  mod.runScriptlet('no-fetch-if', ['mode:no-cors']);
  assert.equal((await globalThis.window.fetch('https://x.test/px')).real, true, 'no mode given');
  const blocked = await globalThis.window.fetch('https://x.test/px', { mode: 'no-cors' });
  assert.equal(blocked.real, undefined);
  assert.equal(blocked.status, 200);
});

test('no-fetch-if fakes a body of the requested length', async () => {
  mod.runScriptlet('no-fetch-if', ['googlesyndication', 'length:10']);
  const res = await globalThis.window.fetch('https://pagead2.googlesyndication.com/x.js');
  assert.equal((await res.text()).length, 10);
});

test('the faked Response carries the request URL and the requested type', async () => {
  mod.runScriptlet('no-fetch-if', ['doubleclick', '', '{"type": "opaque"}']);
  const res = await globalThis.window.fetch('https://ad.doubleclick.net/x');
  assert.equal(res.url, 'https://ad.doubleclick.net/x');
  assert.equal(res.type, 'opaque');
  assert.equal(res.statusText, 'OK');
});

test('no-fetch-if with no properties blocks nothing', async () => {
  // uBO only logs then; matching everything would take every fetch() on the site down.
  mod.runScriptlet('no-fetch-if', []);
  assert.equal((await globalThis.window.fetch('https://x.test/api')).real, true);
});

// --- nano timer boosters --------------------------------------------------------------------

test('nano-sib boosts only 1000 ms timers when no delay is given', () => {
  // uBO's default. Treating an omitted delay as "any" sped up every timer on 181 sites.
  mod.runScriptlet('nano-sib', ['countdown', '', '0.02']);
  const tick = function () {
    void 'countdown tick';
  };
  assert.equal(globalThis.window.setInterval(tick, 1000).delay, 20, '1000 * 0.02');
  assert.equal(globalThis.window.setInterval(tick, 5000).delay, 5000, 'not the default delay');
  assert.equal(globalThis.window.setInterval(tick, 16).delay, 16, 'an animation interval is left alone');
});

test('nano-sib with * boosts a matching timer of any delay', () => {
  mod.runScriptlet('nano-sib', ['countdown', '*', '0.02']);
  const call = globalThis.window.setInterval(function () {
    void 'countdown tick';
  }, 5000);
  assert.equal(call.delay, 100, '5000 * 0.02');
});

test('nano-stb leaves a non-matching timer untouched', () => {
  mod.runScriptlet('nano-stb', ['countdown']);
  const call = globalThis.window.setTimeout(() => {}, 5000);
  assert.equal(call.delay, 5000);
});

test('nano booster only fires on an exact delay when one is given', () => {
  mod.runScriptlet('nano-stb', ['wait', '1000', '0.1']);
  assert.equal(globalThis.window.setTimeout(function () { void 'wait'; }, 1000).delay, 100);
  assert.equal(globalThis.window.setTimeout(function () { void 'wait'; }, 2000).delay, 2000);
});

test('an out-of-range boost is clamped into [0.001, 50], as uBO does', () => {
  mod.runScriptlet('nano-stb', ['x', '1000', '0']);
  assert.equal(globalThis.window.setTimeout(function () { void 'x'; }, 1000).delay, 1, '1000 * 0.001');

  globalThis.window.setTimeout = (cb, delay) => ({ cb, delay });
  mod.runScriptlet('nano-stb', ['x', '1000', '9999']);
  assert.equal(globalThis.window.setTimeout(function () { void 'x'; }, 1000).delay, 50000, '1000 * 50');
});

// --- prevent-setTimeout ---------------------------------------------------------------------

test('a /g needle matches every call, not every other one', () => {
  // A global regex keeps lastIndex between test() calls: the second haystack was searched from
  // where the first match ended and missed.
  mod.runScriptlet('nostif', ['/adCheck/g']);
  const first = globalThis.window.setTimeout(function () {
    void 'some padding text before the adCheck';
  }, 10);
  const second = globalThis.window.setTimeout(function adCheck() {}, 10);
  assert.equal(first, 0);
  assert.equal(second, 0);
});

// --- prevent-eval-if / noeval ---------------------------------------------------------------

test('noeval-if swallows matching code without running it', () => {
  mod.runScriptlet('noeval-if', ['adblock']);
  assert.equal(globalThis.window.eval('if (adblock) alert(1)'), undefined);
});

test('noeval-if passes non-matching code to the original', () => {
  mod.runScriptlet('noeval-if', ['adblock']);
  assert.equal(globalThis.window.eval('1 + 1').real, true);
});

test('plain noeval neuters everything', () => {
  mod.runScriptlet('noeval', []);
  assert.equal(globalThis.window.eval('anything at all'), undefined);
});

// --- nowebrtc -------------------------------------------------------------------------------

test('nowebrtc replaces the peer-connection constructor with a stub', () => {
  const saved = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = function Real() {
    return { real: true };
  };
  globalThis.window.RTCPeerConnection = globalThis.RTCPeerConnection;
  try {
    mod.runScriptlet('nowebrtc', []);
    const pc = new globalThis.window.RTCPeerConnection();
    assert.equal(pc.real, undefined, 'the real constructor must not run');
    assert.equal(typeof pc.close, 'function');
    assert.equal(typeof pc.createDataChannel, 'function');
  } finally {
    globalThis.RTCPeerConnection = saved;
  }
});

// --- dotted chains: aopr / aopw / set -------------------------------------------------------

test('aopr traps a dotted chain whose intermediate object does not exist yet', () => {
  // The bug this fixes: at document_start the script that creates `_sp_` has not run, so the
  // old walk bailed and 282 shipped rules — including the Sourcepoint CMP hooks on major news
  // sites — were silent no-ops.
  mod.runScriptlet('aopr', ['_sp_._networkListenerData']);

  // The site creates the object afterwards, exactly as it does on a real page load.
  globalThis.window._sp_ = { _networkListenerData: { ok: true } };

  assert.throws(
    () => globalThis.window._sp_._networkListenerData,
    /aborted property access/,
    'reading the property should abort once the chain exists',
  );
  delete globalThis.window._sp_;
});

test('aopr still works when the chain already exists', () => {
  globalThis.window.already = { there: 1 };
  mod.runScriptlet('aopr', ['already.there']);
  assert.throws(() => globalThis.window.already.there, /aborted property access/);
  delete globalThis.window.already;
});

test('aopr on an unrelated chain leaves the page object alone', () => {
  globalThis.window.keep = { value: 42 };
  mod.runScriptlet('aopr', ['other.value']);
  assert.equal(globalThis.window.keep.value, 42);
  delete globalThis.window.keep;
});

test('aopr re-arms when a middle object is created after the root', () => {
  // `window.a = {}; a.b = {c: 1}` — the root exists before the leaf's owner does.
  mod.runScriptlet('aopr', ['a.b.c']);
  globalThis.window.a = {};
  globalThis.window.a.b = { c: 1 };
  assert.throws(() => globalThis.window.a.b.c, /aborted property access/);
});

test('aopr re-arms when the middle object arrives after an existing root', () => {
  globalThis.window._sp_ = { config: {} };
  mod.runScriptlet('aopr', ['_sp_.mms.startMsg']);
  globalThis.window._sp_.mms = { startMsg: () => 'shown' };
  assert.throws(() => globalThis.window._sp_.mms.startMsg, /aborted property access/);
});

test('aopw traps a leaf whose owner is built step by step', () => {
  mod.runScriptlet('aopw', ['a.b.c']);
  globalThis.window.a = {};
  globalThis.window.a.b = {};
  assert.throws(() => {
    globalThis.window.a.b.c = 1;
  }, /aborted property access/);
});

test('two rules on the same missing root both stay armed', () => {
  // Each rule used to replace the previous one's root trap, so only the last rule worked.
  mod.runScriptlet('aopr', ['_sp_.first']);
  mod.runScriptlet('aopr', ['_sp_.second']);
  globalThis.window._sp_ = { first: 1, second: 2 };
  assert.throws(() => globalThis.window._sp_.first, /aborted property access/);
  assert.throws(() => globalThis.window._sp_.second, /aborted property access/);
});

test('set reaches a leaf three levels down when the middle is created later', () => {
  mod.runScriptlet('set', ['cfg.ads.enabled', 'false']);
  globalThis.window.cfg = {};
  globalThis.window.cfg.ads = { enabled: true };
  assert.equal(globalThis.window.cfg.ads.enabled, false);

  mod.runScriptlet('set', ['deep.a.b.c', 'false']);
  globalThis.window.deep = { a: {} };
  globalThis.window.deep.a.b = { c: true };
  assert.equal(globalThis.window.deep.a.b.c, false);
});

test('a chain through Object.prototype arms instance writes and stays out of enumeration', () => {
  // Shipped on howtogeek, makeuseof, cbr, gamerant and 27 more. The missing `ads` link lands on
  // Object.prototype: an enumerable trap there put `ads` in every for…in and naive clone on the
  // page, and a write through an instance bypassed the trap, so the rule never applied.
  globalThis.window.Object = Object;
  try {
    mod.runScriptlet('set', ['Object.prototype.ads.nopreroll_', 'true']);
    const keys = [];
    for (const k in {}) keys.push(k);
    assert.deepEqual(keys, [], 'nothing new enumerates on a plain object');
    const arrKeys = [];
    for (const k in ['x']) arrKeys.push(k);
    assert.deepEqual(arrKeys, ['0']);
    assert.equal(JSON.stringify({ ...{ a: 1 } }), '{"a":1}');

    const o = {};
    o.ads = { nopreroll_: false };
    assert.equal(o.ads.nopreroll_, true, 'the object assigned on the instance is armed');
    assert.deepEqual(Object.keys(o), ['ads'], 'the instance gets an ordinary own property');
    assert.equal({}.ads, undefined, "one instance's value must not leak to other objects");
  } finally {
    delete Object.prototype.ads;
  }
});

test('a leaf rule on Object.prototype does not show up in for…in', () => {
  globalThis.window.Object = Object;
  try {
    mod.runScriptlet('set', ['Object.prototype.hideAds', 'true']);
    assert.equal({}.hideAds, true);
    const keys = [];
    for (const k in { a: 1 }) keys.push(k);
    assert.deepEqual(keys, ['a']);
  } finally {
    delete Object.prototype.hideAds;
  }
});

test('set on an existing page object keeps its keys until the site assigns the link', () => {
  // The missing `ads` link used to appear in Object.keys(cfg) as `undefined`, so code that
  // walks a config and dereferences its values threw.
  globalThis.window.cfg = { theme: 'dark' };
  mod.runScriptlet('set', ['cfg.ads.enabled', 'false']);
  assert.deepEqual(Object.keys(globalThis.window.cfg), ['theme']);
  assert.equal(JSON.stringify(globalThis.window.cfg), '{"theme":"dark"}');
  globalThis.window.cfg.ads = { enabled: true };
  assert.equal(globalThis.window.cfg.ads.enabled, false);
  assert.deepEqual(Object.keys(globalThis.window.cfg), ['theme', 'ads'], 'an assigned link is visible');
});

test('a built-in root is walked, never shadowed by an accessor', () => {
  // An accessor on window.Math / window.Object would slow every global lookup on the page.
  const nativeRound = Object.getOwnPropertyDescriptor(Math, 'round');
  globalThis.window.Math = Math;
  try {
    mod.runScriptlet('aost', ['Math.round', 'zzNeverMatches']);
    const desc = Object.getOwnPropertyDescriptor(globalThis.window, 'Math');
    assert.equal(desc.value, Math, 'window.Math must stay a plain data property');
    assert.equal(Math.round(1.4), 1, 'the trapped method still works');
  } finally {
    Object.defineProperty(Math, 'round', nativeRound);
  }
});

// --- remove-node-text / replace-node-text ---------------------------------------------------
// 980 shipped rules, 99% targeting inline <script>. These edit a script's text before it runs.
// The DOM here is a hand-rolled stand-in: node.textContent, nodeName, a TreeWalker, readyState
// and a MutationObserver are the entire surface the scriptlet touches, and modelling them
// directly keeps the test about the rewrite logic rather than about jsdom. The parser timing
// itself is covered in a real browser by test/scriptlets-dom.test.mjs.

class FakeNode {
  constructor(nodeName, text) {
    this.nodeName = nodeName;
    this.textContent = text;
  }
}

function installFakeDom() {
  const nodes = [];
  const observers = [];
  const root = { nodeName: 'HTML', textContent: '', querySelectorAll: () => nodes };
  // An EventTarget so the scriptlet's readystatechange listener is real.
  const doc = new EventTarget();
  Object.assign(doc, {
    documentElement: root,
    readyState: 'loading',
    currentScript: null,
    createTreeWalker: () => {
      let i = -1;
      return { nextNode: () => nodes[++i] ?? null };
    },
  });
  globalThis.document = doc;
  globalThis.MutationObserver = class {
    constructor(cb) {
      this.cb = cb;
      this.active = false;
      observers.push(this);
    }
    observe() {
      this.active = true;
    }
    disconnect() {
      this.active = false;
    }
    takeRecords() {
      return [];
    }
  };
  return {
    nodes,
    /** Simulate the parser inserting a node the observer then sees before it executes. */
    insert(node) {
      nodes.push(node);
      for (const o of observers) {
        if (o.active) o.cb([{ type: 'childList', addedNodes: [node], target: node }]);
      }
      return node;
    },
    /** Advance the document's readyState the way the parser does. */
    setReadyState(state) {
      doc.readyState = state;
      doc.dispatchEvent(new Event('readystatechange'));
    },
  };
}

/** Run `fn` against a fresh fake DOM, restoring the real globals afterwards. */
function withFakeDom(fn) {
  const savedDocument = globalThis.document;
  const savedObserver = globalThis.MutationObserver;
  try {
    return fn(installFakeDom());
  } finally {
    globalThis.document = savedDocument;
    globalThis.MutationObserver = savedObserver;
  }
}

test('rmnt blanks a matching inline script and leaves others alone', () =>
  withFakeDom((dom) => {
    mod.runScriptlet('rmnt', ['script', 'adblockDetected']);

    const target = dom.insert(new FakeNode('SCRIPT', 'if (adblockDetected()) { paywall(); }'));
    const other = dom.insert(new FakeNode('SCRIPT', 'renderArticle();'));
    const notAScript = dom.insert(new FakeNode('DIV', 'adblockDetected mentioned in text'));

    assert.equal(target.textContent, '', 'the matching script should be blanked');
    assert.equal(other.textContent, 'renderArticle();', 'unrelated scripts must be untouched');
    assert.equal(notAScript.textContent, 'adblockDetected mentioned in text', 'nodeName must gate');
  }));

test('rmnt processes nodes that already existed when it ran', () =>
  withFakeDom((dom) => {
    // A scriptlet can be injected after some of the document is parsed.
    dom.nodes.push(new FakeNode('SCRIPT', 'var x = antiAdblock;'));
    mod.runScriptlet('remove-node-text', ['script', 'antiAdblock']);
    assert.equal(dom.nodes[0].textContent, '');
  }));

test('rpnt replaces only the matched run, not the whole script', () =>
  withFakeDom((dom) => {
    // Blanking everything would delete the unrelated code sharing the script.
    mod.runScriptlet('rpnt', ['script', 'blocked=true', 'blocked=false']);
    const n = dom.insert(new FakeNode('SCRIPT', 'init(); var blocked=true; render();'));
    assert.equal(n.textContent, 'init(); var blocked=false; render();');
  }));

test('rpnt supports a regex pattern', () =>
  withFakeDom((dom) => {
    // Character class rather than \d: keeps the pattern free of backslash escaping so the
    // test asserts the regex path, not the test file's own quoting.
    mod.runScriptlet('replace-node-text', ['script', '/detect[0-9]+/g', 'noop']);
    const n = dom.insert(new FakeNode('SCRIPT', 'detect1(); detect2();'));
    assert.equal(n.textContent, 'noop(); noop();');
  }));

test('a /re/ pattern without g replaces the first match only', () =>
  withFakeDom((dom) => {
    // uBO uses a regex's own flags. Defaulting to g rewrote `R.other = 10` along with the
    // countdown the rule was written for.
    mod.runScriptlet('rpnt', ['script', '/10|20/', '0']);
    const n = dom.insert(new FakeNode('SCRIPT', 'wait(10); other(20);'));
    assert.equal(n.textContent, 'wait(0); other(20);');
  }));

test('a nodeName regex is honored, and a non-match is left alone', () =>
  withFakeDom((dom) => {
    mod.runScriptlet('rmnt', ['/^(script|style)$/i', 'ads']);
    const s = dom.insert(new FakeNode('SCRIPT', 'ads()'));
    const st = dom.insert(new FakeNode('STYLE', '.ads{}'));
    const p = dom.insert(new FakeNode('P', 'ads'));
    assert.equal(s.textContent, '');
    assert.equal(st.textContent, '');
    assert.equal(p.textContent, 'ads', 'P is outside the nodeName pattern');
  }));

test('a literal nodeName matches exactly, case-insensitively', () =>
  withFakeDom((dom) => {
    mod.runScriptlet('rmnt', ['script', 'adblock']);
    const ns = dom.insert(new FakeNode('NOSCRIPT', 'adblock notice'));
    assert.equal(ns.textContent, 'adblock notice', '`script` is not `noscript`');

    mod.runScriptlet('rpnt', ['P', 'unsafe', 'safe']);
    const p = dom.insert(new FakeNode('P', 'Your data is unsafe.'));
    assert.equal(p.textContent, 'Your data is safe.', 'an uppercase nodeName must match too');
  }));

test('missing arguments are a no-op rather than a wildcard', () =>
  withFakeDom((dom) => {
    // A rule with no pattern must not blank every script on the page.
    mod.runScriptlet('rmnt', ['script']);
    const n = dom.insert(new FakeNode('SCRIPT', 'important();'));
    assert.equal(n.textContent, 'important();');
  }));

test('rpnt condition limits the rewrite to scripts containing it', () =>
  withFakeDom((dom) => {
    // tech8s.net##+js(rpnt, script, /false;/gm, true;, condition, isSubscribed)
    mod.runScriptlet('rpnt', ['script', '/false;/gm', 'true;', 'condition', 'isSubscribed']);
    const other = dom.insert(new FakeNode('SCRIPT', 'window.loggedIn = false;'));
    const gate = dom.insert(new FakeNode('SCRIPT', 'var isSubscribed = false;'));
    assert.equal(other.textContent, 'window.loggedIn = false;');
    assert.equal(gate.textContent, 'var isSubscribed = true;');
  }));

test('rmnt excludes spares scripts that contain the exclusion', () =>
  withFakeDom((dom) => {
    mod.runScriptlet('rmnt', ['script', 'admiral', 'excludes', '__NEXT_DATA__']);
    const cfg = dom.insert(new FakeNode('SCRIPT', '{"__NEXT_DATA__": {"admiral": 1}}'));
    const boot = dom.insert(new FakeNode('SCRIPT', 'window.admiral = load();'));
    assert.equal(cfg.textContent, '{"__NEXT_DATA__": {"admiral": 1}}');
    assert.equal(boot.textContent, '');
  }));

test('sedCount stops after that many edits', () =>
  withFakeDom((dom) => {
    // 247sports: a stub prepended to every inline script broke the __NEXT_DATA__ JSON block.
    mod.runScriptlet('rpnt', ['script', '/^/', 'stub();', 'sedCount', '1']);
    const first = dom.insert(new FakeNode('SCRIPT', 'a();'));
    const second = dom.insert(new FakeNode('SCRIPT', '{"json": true}'));
    assert.equal(first.textContent, 'stub();a();');
    assert.equal(second.textContent, '{"json": true}');
  }));

test('the observer stops at interactive unless stay is given', () =>
  withFakeDom((dom) => {
    mod.runScriptlet('rmnt', ['script', 'lateAd']);
    mod.runScriptlet('rmnt', ['script', 'stayAd', 'stay', '1']);
    dom.setReadyState('interactive');
    const late = dom.insert(new FakeNode('SCRIPT', 'lateAd();'));
    const stayed = dom.insert(new FakeNode('SCRIPT', 'stayAd();'));
    assert.equal(late.textContent, 'lateAd();', 'inserted after interactive: not the target');
    assert.equal(stayed.textContent, '', 'stay keeps watching');
  }));

test('a /g pattern is matched from the start of every script', () =>
  withFakeDom((dom) => {
    // kogap.xyz: with lastIndex carried over, the middle of three matching scripts was skipped.
    mod.runScriptlet('rpnt', ['script', '/android/gi', 'false']);
    const a = dom.insert(new FakeNode('SCRIPT', 'var padding_padding_padding = /android/;'));
    const b = dom.insert(new FakeNode('SCRIPT', 'android'));
    assert.equal(a.textContent, 'var padding_padding_padding = /false/;');
    assert.equal(b.textContent, 'false');
  }));

// --- no-xhr-if -------------------------------------------------------------------------------
// The failure mode that matters is NOT "the request went through" — it is hanging the page. The
// site holds the XHR object and waits on its events, so a blocked request must still complete.

class EventfulXhr extends EventTarget {
  constructor() {
    super();
    this.readyState = 0;
    this.sent = null;
  }
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  send(body) {
    this.sent = body ?? true;
  }
}

test('no-xhr-if never sends a matching request', async () => {
  globalThis.XMLHttpRequest = EventfulXhr;
  mod.runScriptlet('no-xhr-if', ['doubleclick']);
  const x = new globalThis.XMLHttpRequest();
  x.open('GET', 'https://doubleclick.net/track');
  x.send();
  assert.equal(x.sent, null, 'the real send must not run');
});

test('a blocked XHR still completes so the page does not hang', async () => {
  globalThis.XMLHttpRequest = EventfulXhr;
  mod.runScriptlet('no-xhr-if', ['doubleclick']);
  const x = new globalThis.XMLHttpRequest();
  x.open('GET', 'https://doubleclick.net/track');

  const seen = [];
  x.addEventListener('readystatechange', () => seen.push('rsc:' + x.readyState));
  x.addEventListener('load', () => seen.push('load'));
  x.addEventListener('loadend', () => seen.push('loadend'));
  x.send();

  // Events are async, exactly like a real request: a site assigning onload after send() must
  // still be called.
  assert.deepEqual(seen, [], 'nothing should fire synchronously inside send()');
  await sleep(10);

  assert.deepEqual(seen, ['rsc:2', 'rsc:3', 'rsc:4', 'load', 'loadend']);
  assert.equal(x.readyState, 4);
  assert.equal(x.status, 200);
  assert.equal(x.responseText, '');
});

test('no-xhr-if leaves a non-matching request alone', () => {
  globalThis.XMLHttpRequest = EventfulXhr;
  mod.runScriptlet('no-xhr-if', ['doubleclick']);
  const x = new globalThis.XMLHttpRequest();
  x.open('POST', 'https://example.test/api');
  x.send('payload');
  assert.equal(x.sent, 'payload', 'the real send must run');
});

test('a blocked synchronous XHR is DONE when send() returns', () => {
  // It showed readyState 1 with status 200: a sync caller reads the result right after send().
  class SyncXhr extends EventfulXhr {}
  globalThis.XMLHttpRequest = SyncXhr;
  mod.runScriptlet('no-xhr-if', ['doubleclick', 'emptyObj']);
  const x = new globalThis.XMLHttpRequest();
  x.open('GET', 'https://doubleclick.net/track', false);
  x.send();
  assert.equal(x.readyState, 4);
  assert.equal(x.status, 200);
  assert.equal(x.responseText, '{}');
});

test('a blocked json XHR gets an object response', async () => {
  class JsonXhr extends EventfulXhr {}
  globalThis.XMLHttpRequest = JsonXhr;
  mod.runScriptlet('no-xhr-if', ['doubleclick']);
  const x = new globalThis.XMLHttpRequest();
  x.responseType = 'json';
  x.open('GET', 'https://doubleclick.net/track');
  x.send();
  await sleep(10);
  assert.deepEqual(x.response, {});
});

// --- abort-on-stack-trace --------------------------------------------------------------------

test('aost throws only when the stack matches', () => {
  globalThis.window.probe = { value: 42 };
  mod.runScriptlet('aost', ['probe.value', 'stampstackMarkerFn']);

  // Ordinary access: unrelated stack, so the property must keep working. This is the whole
  // point of aost over aopr — the shipped rules target hot built-ins that a blanket abort
  // would take the entire site down with.
  assert.equal(globalThis.window.probe.value, 42);

  // Access from a function whose name appears in the stack.
  function stampstackMarkerFn() {
    return globalThis.window.probe.value;
  }
  assert.throws(stampstackMarkerFn, /aborted by stack trace/);

  // Still fine afterwards from an unrelated caller.
  assert.equal(globalThis.window.probe.value, 42);
  delete globalThis.window.probe;
});

test('aost with missing arguments is a no-op', () => {
  globalThis.window.keep = { v: 1 };
  mod.runScriptlet('aost', ['keep.v']);
  assert.equal(globalThis.window.keep.v, 1, 'no needle must not mean abort-everything');
  delete globalThis.window.keep;
});

test('aost keeps an inherited method working for non-matching callers', () => {
  // The value used to come from the own descriptor only, so a method on the prototype (as
  // document.createElement is) became undefined for every caller.
  class Base {
    createElement(tag) {
      return { tag };
    }
  }
  globalThis.window.doc = new (class extends Base {})();
  mod.runScriptlet('aost', ['doc.createElement', 'zzNeverMatches']);
  assert.deepEqual(globalThis.window.doc.createElement('div'), { tag: 'div' });
  delete globalThis.window.doc;
});

test('aost matches the uBO stack form: injectedScript for eval/Function code', () => {
  globalThis.window.probe = { value: 42 };
  mod.runScriptlet('aost', ['probe.value', 'injectedScript']);
  assert.equal(globalThis.window.probe.value, 42);
  const injected = new Function('return globalThis.window.probe.value;');
  assert.throws(injected, /aborted by stack trace/);
  delete globalThis.window.probe;
});

test("aost does not match against the scriptlet's own frames", () => {
  // The trap's frames carry the bundle's URL (scriptlets-runtime.js in the extension); uBO's never show
  // up, so a needle like `/(?=^(?!.*\.js))/` or a file name must not see them.
  globalThis.window.probe = { value: 42 };
  mod.runScriptlet('aost', ['probe.value', 'quell-globals']);
  assert.equal(globalThis.window.probe.value, 42);
  delete globalThis.window.probe;
});

test('aost also guards writes from a matching stack', () => {
  globalThis.window.probe = { value: 42 };
  mod.runScriptlet('aost', ['probe.value', 'stampstackWriterFn']);
  function stampstackWriterFn() {
    globalThis.window.probe.value = 1;
  }
  assert.throws(stampstackWriterFn, /aborted by stack trace/);
  globalThis.window.probe.value = 7;
  assert.equal(globalThis.window.probe.value, 7, 'other writers still land');
  delete globalThis.window.probe;
});

test('an aost rule on a method the stack check itself uses does not recurse', () => {
  // The check matches needles with String#includes; trapping that method must not re-enter
  // the check until the stack overflows.
  const native = Object.getOwnPropertyDescriptor(String.prototype, 'includes');
  globalThis.window.String = String;
  try {
    mod.runScriptlet('aost', ['String.prototype.includes', 'zzNeverMatches']);
    assert.equal('abc'.includes('b'), true);
  } finally {
    Object.defineProperty(String.prototype, 'includes', native);
  }
});

// --- set-cookie / set-local-storage-item -----------------------------------------------------
// A filter list must not be able to write arbitrary content to the user's origin, so values are
// restricted to a known vocabulary exactly as uBO does.

test('set-cookie writes only known-safe values', () => {
  const written = [];
  globalThis.document = { set cookie(v) { written.push(v); }, get cookie() { return ''; } };
  mod.runScriptlet('set-cookie', ['ADBp', 'yes']);
  mod.runScriptlet('set-cookie', ['popunder_stop', '1']);
  assert.equal(written.length, 2);
  assert.match(written[0], /^ADBp=yes;/);
  assert.match(written[1], /^popunder_stop=1;/);
  assert.match(written[0], /path=\/;/);
});

test('set-cookie refuses arbitrary values and bad names', () => {
  const written = [];
  globalThis.document = { set cookie(v) { written.push(v); }, get cookie() { return ''; } };
  mod.runScriptlet('set-cookie', ['tracker', 'someArbitraryPayload']);
  mod.runScriptlet('set-cookie', ['bad name; injected=1', 'yes']);
  assert.deepEqual(written, [], 'neither an unsafe value nor an injectable name may be written');
});

test('set-local-storage-item applies the same value restriction', () => {
  const store = new Map();
  globalThis.localStorage = { setItem: (k, v) => store.set(k, v) };
  mod.runScriptlet('set-local-storage-item', ['adblock', 'false']);
  mod.runScriptlet('set-local-storage-item', ['payload', 'arbitrary-junk']);
  assert.equal(store.get('adblock'), 'false');
  assert.equal(store.has('payload'), false);
});
