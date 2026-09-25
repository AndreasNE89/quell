// Scriptlets against a real DOM (Playwright Chromium).
//
// The unit tests drive the library through fake `window`/`document` literals, and that is how
// acs/aost shipped replacing `document.createElement` with `undefined` on 2,391 domains: on a
// fake object every member is an own property, while in a browser almost every target lives on
// a prototype (Document.prototype, Node.prototype, EventTarget.prototype) or is a native
// accessor. Only a real page shows that, so this file loads the bundled scriptlets entry the
// way the extension does — MAIN world, before any page script — and runs real inline, external
// and data: scripts against it.
//
// Skips (does not fail) when Chromium cannot be launched, e.g. on a machine without the
// Playwright browser download.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, rmSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://stampstack.test';

let bundle = '';
let browser;
let launchError;

before(async () => {
  const outfile = join(tmpdir(), `quell-dom-${process.pid}.js`);
  // Same entry and format as scripts/build.mjs produces for dist/scriptlets.js.
  await build({
    entryPoints: [join(ROOT, 'src/content/scriptlets-main.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    outfile,
    logLevel: 'silent',
  });
  bundle = readFileSync(outfile, 'utf8');
  rmSync(outfile, { force: true });
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    launchError = e;
  }
});

after(async () => {
  await browser?.close();
});

/**
 * Open `html` at https://stampstack.test/ with `rules` applied at document start, exactly like
 * the extension's MAIN-world injection (named so its frames carry their own script URL).
 */
async function openWithRules(rules, html, files = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: html });
    const file = files[path];
    if (file !== undefined) {
      const isJson = path.startsWith('/api/');
      return route.fulfill({ contentType: isJson ? 'application/json' : 'text/javascript', body: file });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.addInitScript({
    content: `window.__quellPendingScriptlets = ${JSON.stringify(rules)};\n${bundle}\n//# sourceURL=stampstack-scriptlets.js`,
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  return { context, page };
}

const RECORDER = `<script>
  window.results = { errors: [] };
  window.addEventListener('error', (e) => results.errors.push(String(e.message)));
</script>`;

test('acs on inherited DOM members keeps them working and still aborts the matching script', async (t) => {
  if (!browser) return t.skip(`Chromium unavailable: ${launchError?.message ?? 'unknown'}`);
  const rules = [
    // The shipped EasyPrivacy rule from the bug report (arstechnica, nypost, nbcnews, …).
    { name: 'acs', args: ['document.createElement', 'admiral'] },
    // Inherited accessors, an own accessor with a setter, and an inherited method on window.
    { name: 'acs', args: ['document.cookie', 'zzNeverMatches'] },
    { name: 'acs', args: ['document.readyState', 'zzNeverMatches'] },
    { name: 'acs', args: ['onload', 'zzNeverMatches'] },
    { name: 'acs', args: ['addEventListener', 'zzNeverMatches'] },
  ];
  const html = `<!doctype html><html><head>${RECORDER}
<script>
  results.createElementType = typeof document.createElement;
  results.div = document.createElement('div').tagName;
  results.readyState = document.readyState;
  document.cookie = 'ssprobe=1; path=/';
  results.cookie = document.cookie.includes('ssprobe=1');
  results.addEventListenerType = typeof addEventListener;
  window.onload = () => { results.onloadFired = true; };
</script>
<script>
  /* admiral bootstrap */
  results.admiralStarted = true;
  document.createElement('script');
  results.admiralFinished = true;
</script>
</head><body></body></html>`;
  const { context, page } = await openWithRules(rules, html);
  try {
    const r = await page.evaluate(() => window.results);
    assert.equal(r.createElementType, 'function', 'document.createElement must stay a function');
    assert.equal(r.div, 'DIV');
    assert.equal(r.readyState, 'loading', 'readyState must stay live, not a snapshot or undefined');
    assert.equal(r.cookie, true, 'cookie writes must reach the real cookie jar');
    assert.equal(r.addEventListenerType, 'function');
    assert.equal(r.onloadFired, true, "the page's own onload handler must still run");

    assert.equal(r.admiralStarted, true);
    assert.equal(r.admiralFinished, undefined, 'the matching inline script must be aborted');
    assert.ok(
      r.errors.some((m) => /aborted current script/.test(m)),
      `expected the abort to surface as an error, got ${JSON.stringify(r.errors)}`,
    );

    // Later callers, long after injection.
    assert.equal(await page.evaluate(() => document.createElement('span').tagName), 'SPAN');
    assert.equal(await page.evaluate(() => document.readyState), 'complete');
  } finally {
    await context.close();
  }
});

test('acs honors its context argument and judges data: scripts by their decoded body', async (t) => {
  if (!browser) return t.skip(`Chromium unavailable: ${launchError?.message ?? 'unknown'}`);
  const rules = [{ name: 'acs', args: ['__dataProbe', 'atob', '/^data:/'] }];
  const dataSrc =
    'data:text/javascript,' +
    encodeURIComponent('results.dataStarted = true; void atob; window.__dataProbe; results.dataFinished = true;');
  const b64Src =
    'data:text/javascript;base64,' +
    Buffer.from('results.b64Started = true; void atob; window.__dataProbe; results.b64Finished = true;').toString('base64');
  const html = `<!doctype html><html><head>${RECORDER}
<script>window.__dataProbe = 1;</script>
<script src="${dataSrc}"></script>
<script src="${b64Src}"></script>
<script>results.inlineStarted = true; void atob; window.__dataProbe; results.inlineFinished = true;</script>
</head><body></body></html>`;
  const { context, page } = await openWithRules(rules, html);
  try {
    const r = await page.evaluate(() => window.results);
    assert.equal(r.dataStarted, true);
    assert.equal(r.dataFinished, undefined, 'the data: script matching needle and context must abort');
    assert.equal(r.b64Started, true);
    assert.equal(r.b64Finished, undefined, 'a base64 data: script is decoded before matching');
    assert.equal(r.inlineFinished, true, 'an inline script is outside the /^data:/ context');
  } finally {
    await context.close();
  }
});

test('aost matches uBO-normalized stacks and keeps inherited members for other callers', async (t) => {
  if (!browser) return t.skip(`Chromium unavailable: ${launchError?.message ?? 'unknown'}`);
  const rules = [
    // Shipped as `123moviess.*##+js(aost, document.createElement, inlineScript)`.
    { name: 'aost', args: ['document.getElementById', 'inlineScript'] },
    // A needle that matches nothing: the inherited method must be untouched.
    { name: 'aost', args: ['document.querySelector', 'zzNeverMatches'] },
  ];
  const html = `<!doctype html><html><head>${RECORDER}
<script>
  try { document.getElementById('x'); results.inline = 'ran'; } catch (e) { results.inline = e.name; }
  results.qs = typeof document.querySelector('head');
</script>
<script src="/ext.js"></script>
</head><body></body></html>`;
  const files = {
    '/ext.js': "try { document.getElementById('x'); results.external = 'ran'; } catch (e) { results.external = e.name; }",
  };
  const { context, page } = await openWithRules(rules, html, files);
  try {
    const r = await page.evaluate(() => window.results);
    assert.equal(r.inline, 'ReferenceError', 'a call from an inline script is `inlineScript` in uBO terms');
    assert.equal(r.external, 'ran', 'a call from an external file must not match inlineScript');
    assert.equal(r.qs, 'object', 'document.querySelector must keep working');
  } finally {
    await context.close();
  }
});

test('rmnt edits a parser-inserted script before it runs and matches nodeName exactly', async (t) => {
  if (!browser) return t.skip(`Chromium unavailable: ${launchError?.message ?? 'unknown'}`);
  const rules = [{ name: 'rmnt', args: ['script', 'adblockCheck'] }];
  const html = `<!doctype html><html><head>${RECORDER}
<script>results.checkRan = true; /* adblockCheck */</script>
<script>results.otherRan = true;</script>
</head><body><noscript id="ns">adblockCheck</noscript></body></html>`;
  const { context, page } = await openWithRules(rules, html);
  try {
    const r = await page.evaluate(() => window.results);
    assert.equal(r.checkRan, undefined, 'the matching script must be blanked before it executes');
    assert.equal(r.otherRan, true);
    const ns = await page.evaluate(() => document.getElementById('ns').textContent);
    assert.equal(ns, 'adblockCheck', '`script` must not also match <noscript>');
  } finally {
    await context.close();
  }
});

test('response rewrites reach early XHR handlers, json XHRs and Response#json', async (t) => {
  if (!browser) return t.skip(`Chromium unavailable: ${launchError?.message ?? 'unknown'}`);
  const rules = [
    { name: 'json-prune-xhr-response', args: ['promotedMetadata', '', 'propsToMatch', 'url:/api/timeline'] },
    { name: 'json-prune', args: ['ads'] },
  ];
  const html = `<!doctype html><html><head>${RECORDER}
<script>
(async () => {
  const early = new XMLHttpRequest();
  // Registered before send(), so it runs ahead of anything the scriptlet could add in send().
  early.onreadystatechange = () => { if (early.readyState === 4) results.xhrEarly = early.responseText; };
  early.open('GET', '/api/timeline');
  early.send();
  await new Promise((r) => { early.onloadend = r; });

  const json = new XMLHttpRequest();
  json.responseType = 'json';
  json.open('GET', '/api/timeline');
  json.send();
  await new Promise((r) => { json.onloadend = r; });
  results.xhrJson = json.response;

  const res = await fetch('/api/feed');
  results.fetchJson = await res.json();
  results.done = true;
})().catch((e) => { results.failed = String(e); results.done = true; });
</script>
</head><body></body></html>`;
  const files = {
    '/api/timeline': JSON.stringify({ items: [1], promotedMetadata: { adId: 'x' } }),
    '/api/feed': JSON.stringify({ ads: [1], k: 2 }),
  };
  const { context, page } = await openWithRules(rules, html, files);
  try {
    await page.waitForFunction(() => window.results && window.results.done === true);
    const r = await page.evaluate(() => window.results);
    assert.equal(r.failed, undefined);
    assert.deepEqual(JSON.parse(r.xhrEarly), { items: [1] }, 'a handler set before send() sees the pruned body');
    assert.deepEqual(r.xhrJson, { items: [1] }, "responseType 'json' is pruned too");
    assert.deepEqual(r.fetchJson, { k: 2 }, 'Response#json never calls JSON.parse, so it needs its own hook');
  } finally {
    await context.close();
  }
});
