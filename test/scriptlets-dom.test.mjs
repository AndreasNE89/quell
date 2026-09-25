// Scriptlets against a real DOM (Playwright Chromium).
//
// The unit tests drive the library through fake `window`/`document` literals, and that is how
// acs/aost shipped replacing `document.createElement` with `undefined` on 2,391 domains: on a
// fake object every member is an own property, while in a browser almost every target lives on
// a prototype (Document.prototype, Node.prototype, EventTarget.prototype) or is a native
// accessor. Only a real page shows that, so this file loads the bundled scriptlets runtime the
// way the extension does — compiled rule data, then the runtime, MAIN world, before any page
// script — and runs real inline, external and data: scripts against it.
//
// Skips (does not fail) when Chromium cannot be launched, e.g. on a machine without the
// Playwright browser download.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScriptletShards } from '../scripts/lib/scriptlet-shards.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://stampstack.test';
/** Hand-off name for these tests; the real one comes from compile-filters. */
const KEY = '__ssDomTest';

let bundle = '';
let host;
let browser;
let launchError;

before(async () => {
  // Same entry and format as scripts/build.mjs produces for dist/scriptlets-runtime.js, with the
  // generated hand-off key swapped for this file's.
  const out = await build({
    entryPoints: [join(ROOT, 'src/content/scriptlets-runtime.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    write: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'runtime-key',
        setup(b) {
          b.onResolve({ filter: /scriptlet-runtime\.json$/ }, (a) => ({ path: a.path, namespace: 'key' }));
          b.onLoad({ filter: /.*/, namespace: 'key' }, () => ({
            contents: JSON.stringify({ key: KEY, version: 'test' }),
            loader: 'json',
          }));
        },
      },
    ],
  });
  bundle = out.outputFiles[0].text;
  const hostname = await build({
    entryPoints: [join(ROOT, 'src/shared/hostname.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
  });
  host = await import(
    `data:text/javascript;base64,${Buffer.from(hostname.outputFiles[0].text).toString('base64')}`
  );
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
 * The compiled data files for `rules`, as compile-filters writes them: `domains` defaults to
 * stampstack.test. `fallback` adds the marker the service worker's executeScript sends.
 */
function dataFiles(rules, { fallback = false } = {}) {
  const scriptlets = rules.map((r) => ({
    domains: r.domains ?? { include: ['stampstack.test'], exclude: [] },
    name: r.name,
    args: r.args,
  }));
  const { files, index } = buildScriptletShards(
    { test: { scriptlets, exceptions: [] } },
    ['test'],
    host,
    { key: KEY },
  );
  return files
    .filter((f) => fallback || f.path !== index.fallback)
    .map((f) => f.content)
    .join('');
}

/**
 * Open `html` at https://stampstack.test/ with `rules` applied at document start, exactly like
 * the extension's MAIN-world injection (named so its frames carry their own script URL).
 * `pages` serves more paths, on this origin or others (full URLs); `url` opens one of them
 * instead.
 */
async function openWithRules(rules, html, files = {}, { pages = {}, fallback = false, url = `${ORIGIN}/` } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    const other = pages[url.origin + url.pathname];
    if (other !== undefined) return route.fulfill({ contentType: 'text/html', body: other });
    if (url.origin !== ORIGIN) return route.fulfill({ status: 404, body: '' });
    const path = url.pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: html });
    const file = files[path];
    if (file !== undefined) {
      const isJson = path.startsWith('/api/');
      return route.fulfill({ contentType: isJson ? 'application/json' : 'text/javascript', body: file });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.addInitScript({
    content: `${dataFiles(rules, { fallback })}\n${bundle}\n//# sourceURL=stampstack-scriptlets.js`,
  });
  await page.goto(url, { waitUntil: 'load' });
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

// REVIEW_2026-09-24 B2/B24: the registered runtime acts where excludeMatches is the top page's
// decision (the top frame, same-host frames, about:blank/srcdoc frames of the page) and leaves
// frames on other hosts to the service worker, which knows whether the top page is switched off.
test('the registered runtime serves the page and its own frames, not frames of other hosts', async (t) => {
  if (!browser) return t.skip(`Chromium unavailable: ${launchError?.message ?? 'unknown'}`);
  const probe = `<script>
  try { void window.adblockProbe; window.probe = 'read-ok'; } catch (e) { window.probe = 'aborted'; }
</script>`;
  const include = ['stampstack.test', 'other.test'];
  const rules = [{ name: 'aopr', args: ['adblockProbe'], domains: { include, exclude: [] } }];
  const html = `<!doctype html><html><head>${probe}</head><body>
<iframe id="same" src="${ORIGIN}/same"></iframe>
<iframe id="cross" src="https://other.test/cross"></iframe>
<iframe id="srcdoc" srcdoc="${probe.replace(/"/g, '&quot;')}"></iframe>
</body></html>`;
  const pages = {
    [`${ORIGIN}/same`]: `<!doctype html><html><head>${probe}</head></html>`,
    'https://other.test/cross': `<!doctype html><html><head>${probe}</head></html>`,
  };
  const results = async (page) => {
    const out = {};
    for (const f of page.frames()) {
      const name = f === page.mainFrame() ? 'top' : await (await f.frameElement()).getAttribute('id');
      out[name] = await f.evaluate(() => ({
        probe: window.probe,
        leftovers: Object.getOwnPropertyNames(window).filter((n) => n.startsWith('__ss') || n.startsWith('__quell')),
      }));
    }
    return out;
  };

  const registered = await openWithRules(rules, html, {}, { pages });
  try {
    await registered.page.waitForTimeout(200);
    const r = await results(registered.page);
    assert.equal(r.top.probe, 'aborted', 'the top frame is served at document start');
    assert.equal(r.same.probe, 'aborted', 'a same-host frame follows the same switch');
    assert.equal(r.srcdoc.probe, 'aborted', 'a srcdoc frame has its creator\'s origin');
    assert.equal(r.cross.probe, 'read-ok', 'a frame on another host is left to the service worker');
    for (const [frame, { leftovers }] of Object.entries(r)) {
      assert.deepEqual(leftovers, [], `${frame}: the hand-off must not stay on the page`);
    }
  } finally {
    await registered.context.close();
  }

  // The worker's executeScript fallback carries the marker, and then the frame is served.
  const injected = await openWithRules(rules, html, {}, { pages, fallback: true });
  try {
    await injected.page.waitForTimeout(200);
    assert.equal((await results(injected.page)).cross.probe, 'aborted');
  } finally {
    await injected.context.close();
  }
});

test('a page that claims the hand-off name first gets nothing from it', async (t) => {
  if (!browser) return t.skip(`Chromium unavailable: ${launchError?.message ?? 'unknown'}`);
  // The executeScript fallback runs after page scripts, so a page could plant an accessor to
  // read or swallow the rules. The data files refuse to write through it.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('**/*', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head></html>' }),
  );
  await page.goto(`${ORIGIN}/`);
  try {
    const got = await page.evaluate(
      ({ KEY, script }) => {
        const seen = [];
        Object.defineProperty(window, KEY, { get: () => ({ push: (d) => seen.push(d) }), configurable: true });
        (0, eval)(script);
        let aborted = 'read-ok';
        try {
          void window.adblockProbe;
        } catch {
          aborted = 'aborted';
        }
        return { seen: seen.length, aborted };
      },
      { KEY, script: `${dataFiles([{ name: 'aopr', args: ['adblockProbe'] }], { fallback: true })}\n${bundle}` },
    );
    assert.deepEqual(got, { seen: 0, aborted: 'read-ok' });
  } finally {
    await context.close();
  }
});

// runScriptlet skips the list rewrites that have hung YouTube's player at 0:00. An about:blank
// or srcdoc frame has no hostname of its own and is matched as its creator (frame-scope.ts), so
// the skip must follow that host too: YouTube code that borrows JSON or fetch from such a frame
// would otherwise get the rewrites the top frame is spared.
test('YouTube list rewrites stay off in the page and in its about:blank and srcdoc frames', async (t) => {
  if (!browser) return t.skip(`Chromium unavailable: ${launchError?.message ?? 'unknown'}`);
  const domains = { include: ['youtube.com'], exclude: [] };
  const rules = [
    { name: 'set', args: ['probeFlag', 'true'], domains },
    { name: 'json-prune', args: ['adPlacements'], domains },
    // Not skipped on YouTube: shows the runtime did serve each frame.
    { name: 'aopr', args: ['adblockProbe'], domains },
  ];
  const YT = 'https://www.youtube.com/';
  const html = `<!doctype html><html><head></head><body>
<iframe id="blank"></iframe>
<iframe id="srcdoc" srcdoc="<p>x</p>"></iframe>
</body></html>`;
  const { context, page } = await openWithRules(rules, '', {}, { pages: { [YT]: html }, url: YT });
  try {
    const out = {};
    for (const f of page.frames()) {
      const name = f === page.mainFrame() ? 'top' : await (await f.frameElement()).getAttribute('id');
      out[name] = await f.evaluate(() => {
        let served = false;
        try {
          void window.adblockProbe;
        } catch {
          served = true;
        }
        return {
          served,
          set: Object.getOwnPropertyDescriptor(window, 'probeFlag') !== undefined,
          pruned: !('adPlacements' in JSON.parse('{"adPlacements":[1],"k":2}')),
        };
      });
    }
    const untouched = { served: true, set: false, pruned: false };
    assert.deepEqual(out, { top: untouched, blank: untouched, srcdoc: untouched });
  } finally {
    await context.close();
  }
});

// The registered runtime runs at document_start, before the parser has made <html>. The
// observer remove-attr/remove-class keep for later elements has to attach all the same, or
// only the DOMContentLoaded pass is left and anything a page adds afterwards keeps its attribute.
test('remove-attr and remove-class reach elements and attributes added after load', async (t) => {
  if (!browser) return t.skip(`Chromium unavailable: ${launchError?.message ?? 'unknown'}`);
  const rules = [
    { name: 'ra', args: ['onclick', 'a.ad', 'stay'] },
    { name: 'rc', args: ['popup', '.box', 'stay'] },
  ];
  const html = `<!doctype html><html><head></head><body>
<a class="ad" id="parsed" onclick="void 0">x</a>
<a class="ad" id="existing">x</a>
<a class="keep" id="keep" onclick="void 0">x</a>
</body></html>`;
  const { context, page } = await openWithRules(rules, html);
  try {
    await page.evaluate(() => {
      const a = document.createElement('a');
      a.id = 'late';
      a.className = 'ad';
      a.setAttribute('onclick', 'void 0');
      document.body.append(a);
      const box = document.createElement('div');
      box.id = 'box';
      box.className = 'box popup';
      document.body.append(box);
      document.getElementById('existing').setAttribute('onclick', 'void 0');
    });
    const state = () =>
      page.evaluate(() => ({
        parsed: document.getElementById('parsed').hasAttribute('onclick'),
        late: document.getElementById('late').hasAttribute('onclick'),
        existing: document.getElementById('existing').hasAttribute('onclick'),
        box: document.getElementById('box').classList.contains('popup'),
        keep: document.getElementById('keep').hasAttribute('onclick'),
      }));
    const want = { parsed: false, late: false, existing: false, box: false, keep: true };
    await page
      .waitForFunction(
        () =>
          !document.getElementById('late').hasAttribute('onclick') &&
          !document.getElementById('existing').hasAttribute('onclick') &&
          !document.getElementById('box').classList.contains('popup'),
        null,
        { timeout: 1500 },
      )
      .catch(() => {});
    assert.deepEqual(await state(), want);
  } finally {
    await context.close();
  }
});
