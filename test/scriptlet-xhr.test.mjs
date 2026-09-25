// XHR response-rewriting hook (json-prune-xhr-response / trusted-replace-xhr-response).
//
// Regression guard for a hook that was inert in every browser since the first commit: the
// readystatechange listener was registered `{ once: true }` and early-returned unless
// readyState was 4. A real async XHR fires 2 (HEADERS_RECEIVED) -> 3 (LOADING) -> 4 (DONE),
// so `once` discarded the listener at readyState 2 and the transform never ran. The fake XHR
// below replays that exact spec-shaped sequence — a fake that only fires DONE would pass
// against the broken implementation too, which is the whole point of driving 2 and 3 first.
//
// The hook now overrides the responseText/response getters and rewrites on the first read after
// DONE, so page handlers registered before send() — which a listener added inside send() always
// ran behind — see the rewritten body too.

import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let mod;

/** Minimal XMLHttpRequest good enough for the hook: real event dispatch + readyState walk. */
class FakeXhr {
  constructor() {
    this.readyState = 0;
    this.responseType = '';
    this._body = '';
    this._listeners = new Map();
  }
  // Accessors live on the prototype, as they do in a browser: that is where the hook overrides
  // them. `responseText` throws for non-text types, like the real one.
  get responseText() {
    if (this.responseType !== '' && this.responseType !== 'text') {
      throw new Error('InvalidStateError: responseText is only available for text responses');
    }
    return this._body;
  }
  get response() {
    if (this.responseType === 'json') {
      if (this.readyState !== 4) return null;
      this._parsed ??= JSON.parse(this._body);
      return this._parsed;
    }
    return this._body;
  }
  // `once` must be honored, or this fake cannot detect the bug it exists to guard: the old
  // hook registered `{ once: true }` and bailed unless readyState was 4, so the listener was
  // consumed by the readyState 2 event and DONE was never seen.
  addEventListener(type, fn, opts) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    const once = opts === true || (opts && opts.once);
    this._listeners.get(type).push({ fn, once });
  }
  removeEventListener(type, fn) {
    const l = this._listeners.get(type);
    if (!l) return;
    const i = l.findIndex((e) => e.fn === fn);
    if (i >= 0) l.splice(i, 1);
  }
  _emit(type) {
    for (const entry of [...(this._listeners.get(type) || [])]) {
      if (entry.once) this.removeEventListener(type, entry.fn);
      entry.fn.call(this);
    }
  }
  open() {
    this._parsed = undefined;
  }
  send() {}
  /** Replay the readyState sequence a real async XHR produces. */
  _deliver(body, states = [2, 3, 4]) {
    for (const s of states) {
      this.readyState = s;
      if (s === 4) this._body = body;
      this._emit('readystatechange');
    }
  }
}

let savedXhr;

before(async () => {
  const outfile = join(tmpdir(), `quell-xhr-${process.pid}.mjs`);
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
  savedXhr = globalThis.XMLHttpRequest;
  // A fresh subclass per test: the hook patches the prototype, and a shared class would carry
  // every earlier test's rule into the next one.
  globalThis.XMLHttpRequest = class extends FakeXhr {};
});

afterEach(() => {
  globalThis.XMLHttpRequest = savedXhr;
});

/** Install a scriptlet, then run one request through the patched prototype. */
function roundTrip(name, args, url, body, states) {
  mod.runScriptlet(name, args);
  const xhr = new globalThis.XMLHttpRequest();
  xhr.open('GET', url);
  xhr.send();
  xhr._deliver(body, states);
  return xhr;
}

const TIMELINE = ['promotedMetadata', '', 'propsToMatch', 'url:/timeline'];

test('json-prune-xhr-response prunes after the full 2 -> 3 -> 4 sequence', () => {
  const body = JSON.stringify({ items: [1, 2], promotedMetadata: { adId: 'x' } });
  const xhr = roundTrip('json-prune-xhr-response', TIMELINE, 'https://x.com/i/api/graphql/timeline', body);

  const out = JSON.parse(xhr.responseText);
  assert.equal(out.promotedMetadata, undefined, 'promoted payload survived the whole readyState walk');
  assert.deepEqual(out.items, [1, 2]);
});

test('the DONE-only sequence prunes as well (sync XHR)', () => {
  const body = JSON.stringify({ promotedMetadata: { adId: 'x' }, keep: 1 });
  const xhr = roundTrip('json-prune-xhr-response', TIMELINE, 'https://x.com/i/api/graphql/timeline', body, [4]);
  assert.equal(JSON.parse(xhr.responseText).promotedMetadata, undefined);
});

test('a non-matching URL is left untouched', () => {
  const body = JSON.stringify({ promotedMetadata: { adId: 'x' } });
  const xhr = roundTrip('json-prune-xhr-response', TIMELINE, 'https://x.com/other/endpoint', body);
  assert.equal(JSON.parse(xhr.responseText).promotedMetadata.adId, 'x');
});

test('responseText follows each response on a reused XHR object', () => {
  // A reused object must not stay pinned to the first rewritten body.
  mod.runScriptlet('json-prune-xhr-response', ['ads', '', 'propsToMatch', 'url:/feed']);
  const xhr = new globalThis.XMLHttpRequest();

  xhr.open('GET', 'https://example.com/feed');
  xhr.send();
  xhr._deliver(JSON.stringify({ ads: 1, n: 1 }));
  assert.equal(JSON.parse(xhr.responseText).n, 1);

  xhr.open('GET', 'https://example.com/feed');
  xhr.send();
  xhr._deliver(JSON.stringify({ ads: 2, n: 2 }));
  assert.equal(JSON.parse(xhr.responseText).n, 2, 'second response was pinned to the first body');
  assert.equal(JSON.parse(xhr.responseText).ads, undefined);
});

test('a handler registered before send() already sees the rewritten body', () => {
  mod.runScriptlet('json-prune-xhr-response', TIMELINE);
  const xhr = new globalThis.XMLHttpRequest();
  let seen;
  xhr.addEventListener('readystatechange', () => {
    if (xhr.readyState === 4) seen = xhr.responseText;
  });
  xhr.open('GET', 'https://x.com/i/api/graphql/timeline');
  xhr.send();
  xhr._deliver(JSON.stringify({ promotedMetadata: { adId: 'x' }, keep: 1 }));
  assert.deepEqual(JSON.parse(seen), { keep: 1 });
  assert.deepEqual(JSON.parse(xhr.response), { keep: 1 }, '`response` agrees with `responseText`');
});

test("responseType 'json' responses are pruned too", () => {
  mod.runScriptlet('json-prune-xhr-response', TIMELINE);
  const xhr = new globalThis.XMLHttpRequest();
  xhr.responseType = 'json';
  xhr.open('GET', 'https://x.com/i/api/graphql/timeline');
  xhr.send();
  xhr._deliver(JSON.stringify({ promotedMetadata: { adId: 'x' }, keep: 1 }));
  assert.deepEqual(xhr.response, { keep: 1 });
});

test('json-prune-xhr-response honors needle paths', () => {
  mod.runScriptlet('json-prune-xhr-response', ['ads', 'config.adsEnabled', 'propsToMatch', '/feed']);
  const plain = roundTrip('json-prune-xhr-response', ['zz'], 'https://x.test/feed', JSON.stringify({ ads: 1 }));
  assert.equal(JSON.parse(plain.responseText).ads, 1, 'no needle path, no prune');

  const xhr = new globalThis.XMLHttpRequest();
  xhr.open('GET', 'https://x.test/feed');
  xhr.send();
  xhr._deliver(JSON.stringify({ ads: 1, config: { adsEnabled: true } }));
  assert.equal(JSON.parse(xhr.responseText).ads, undefined);
});

test('trusted-replace-xhr-response keeps an NDJSON rewrite whose lines stay valid', () => {
  // Facebook's SEARCH_ADS rewrite on a multi-document body was reverted by the validity check.
  const body = '{"node":{"role":"SEARCH_ADS","x":1}}\n{"node":{"role":"ORGANIC"}}';
  const xhr = roundTrip(
    'trusted-replace-xhr-response',
    ['/\\{"node":\\{"role":"SEARCH_ADS"[^\\n]+/g', '{}', '/api/graphql'],
    'https://www.facebook.com/api/graphql/',
    body,
  );
  assert.equal(xhr.responseText, '{}\n{"node":{"role":"ORGANIC"}}');
});
