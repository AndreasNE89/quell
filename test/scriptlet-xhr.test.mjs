// XHR response-rewriting hook (json-prune-xhr-response / trusted-replace-xhr-response).
//
// Regression guard for a hook that was inert in every browser since the first commit: the
// readystatechange listener was registered `{ once: true }` and early-returned unless
// readyState was 4. A real async XHR fires 2 (HEADERS_RECEIVED) -> 3 (LOADING) -> 4 (DONE),
// so `once` discarded the listener at readyState 2 and the transform never ran. The fake XHR
// below replays that exact spec-shaped sequence — a fake that only fires DONE would pass
// against the broken implementation too, which is the whole point of driving 2 and 3 first.

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
    this._body = '';
    this._listeners = new Map();
  }
  // Accessors live on the prototype, as they do in a browser. That matters: the scriptlet
  // installs an *own* property to shadow them, so a reused object keeps returning the old
  // rewritten body unless the hook clears its override on the next send().
  get responseText() {
    return this._body;
  }
  get response() {
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
  open() {}
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
  globalThis.XMLHttpRequest = FakeXhr;
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

test('json-prune-xhr-response prunes after the full 2 -> 3 -> 4 sequence', () => {
  const body = JSON.stringify({ items: [1, 2], promotedMetadata: { adId: 'x' } });
  const xhr = roundTrip('json-prune-xhr-response', ['promotedMetadata', 'url:/timeline'], 'https://x.com/i/api/graphql/timeline', body);

  const out = JSON.parse(xhr.responseText);
  assert.equal(out.promotedMetadata, undefined, 'promoted payload survived the whole readyState walk');
  assert.deepEqual(out.items, [1, 2]);
});

test('the DONE-only sequence prunes as well (sync XHR)', () => {
  const body = JSON.stringify({ promotedMetadata: { adId: 'x' }, keep: 1 });
  const xhr = roundTrip('json-prune-xhr-response', ['promotedMetadata', 'url:/timeline'], 'https://x.com/i/api/graphql/timeline', body, [4]);
  assert.equal(JSON.parse(xhr.responseText).promotedMetadata, undefined);
});

test('a non-matching URL is left untouched', () => {
  const body = JSON.stringify({ promotedMetadata: { adId: 'x' } });
  const xhr = roundTrip('json-prune-xhr-response', ['promotedMetadata', 'url:/timeline'], 'https://x.com/other/endpoint', body);
  assert.equal(JSON.parse(xhr.responseText).promotedMetadata.adId, 'x');
});

test('responseText stays redefinable across reused XHR objects', () => {
  // Non-configurable getters made the second response on a reused object throw into the
  // silent catch, pinning it to the first transformed body.
  mod.runScriptlet('json-prune-xhr-response', ['ads', 'url:/feed']);
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
