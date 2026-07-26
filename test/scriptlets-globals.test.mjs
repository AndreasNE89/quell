// Global-patching scriptlets: popunder defuser, listener defuser, fetch/timer/eval guards.
//
// These recover ~2,391 shipped rules that were previously compiled away as unimplemented. The
// risk profile is the opposite of a missing scriptlet: one that misfires does not fail safe, it
// breaks the page. So every test here pins BOTH halves — the block on a match, and the
// untouched pass-through on a non-match.
//
// Driven through runScriptlet (the real entry point) so alias resolution is covered too.

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

// --- nano timer boosters --------------------------------------------------------------------

test('nano-sib scales a matching timer delay', () => {
  mod.runScriptlet('nano-sib', ['countdown', '', '0.02']);
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

test('an out-of-range boost falls back to the default instead of being trusted', () => {
  // A filter author writing boost=0 or 9999 must not stall or explode the page's timers.
  mod.runScriptlet('nano-stb', ['x', '', '0']);
  assert.equal(globalThis.window.setTimeout(function () { void 'x'; }, 1000).delay, 50, '1000 * 0.05');

  globalThis.window.setTimeout = (cb, delay) => ({ cb, delay });
  mod.runScriptlet('nano-stb', ['x', '', '9999']);
  assert.equal(globalThis.window.setTimeout(function () { void 'x'; }, 1000).delay, 50);
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

// --- abort-on-property-read on a dotted chain -----------------------------------------------

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
