// content.js as Chrome runs it: a real extension (Playwright Chromium, new headless) whose
// service worker is a stub answering cosmetic:get from a per-host table.
//
// These cases need the real content-script world: about:blank and document.write frames,
// back/forward-cache restores, a stylesheet the browser injects, and messages from the worker.
//
// Skips (does not fail) when Chromium cannot load an extension.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://site.test';

let extDir;
let profileDir;
let context;
let sw;
let launchError;

// Playwright can evaluate in the worker before its script has run, so the script must not
// overwrite a configuration the test already set.
const STUB_WORKER = `
self.cfg ??= { hosts: {}, fail: false, allowlisted: false };
self.log ??= [];
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  self.log.push({ type: msg.type, hostname: msg.hostname, topHost: msg.topHost, frameId: sender.frameId, refetch: msg.refetch });
  if (msg.type !== 'cosmetic:get' || self.cfg.fail) {
    sendResponse(null);
    return;
  }
  const h = self.cfg.hosts[msg.hostname] ?? {};
  sendResponse({
    allowlisted: self.cfg.allowlisted,
    hide: h.hide ?? [],
    unhide: h.unhide ?? [],
    procedural: h.procedural ?? [],
    actions: h.actions ?? [],
    disableGeneric: false,
    disableSpecific: false,
  });
});
self.pageCollect = async () => {
  const [tab] = await chrome.tabs.query({ active: true });
  return chrome.tabs.sendMessage(tab.id, { type: 'page:collect' }, { frameId: 0 });
};
self.refresh = async () => {
  const [tab] = await chrome.tabs.query({ active: true });
  return chrome.tabs.sendMessage(tab.id, { type: 'cosmetic:refresh' });
};
`;

before(async () => {
  try {
    extDir = mkdtempSync(join(tmpdir(), 'ss-ext-'));
    profileDir = mkdtempSync(join(tmpdir(), 'ss-prof-'));
    const out = await build({
      entryPoints: [join(ROOT, 'src/content/content.ts')],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'chrome120',
      write: false,
      logLevel: 'silent',
      define: { __STAMPSTACK_DEV__: 'true' },
    });
    writeFileSync(join(extDir, 'content.js'), out.outputFiles[0].text);
    writeFileSync(join(extDir, 'background.js'), STUB_WORKER);
    // A browser-injected author sheet, like the registered generic one.
    writeFileSync(join(extDir, 'generic.css'), '.bait { display: none !important; }\n');
    writeFileSync(
      join(extDir, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        name: 'StampStack content test',
        version: '1.0',
        background: { service_worker: 'background.js' },
        permissions: ['storage', 'tabs'],
        host_permissions: ['<all_urls>'],
        content_scripts: [
          { matches: ['<all_urls>'], css: ['generic.css'], run_at: 'document_start', all_frames: true },
          {
            matches: ['<all_urls>'],
            js: ['content.js'],
            run_at: 'document_start',
            all_frames: true,
            match_about_blank: true,
          },
        ],
      }),
    );
    const { chromium } = await import('playwright');
    context = await chromium.launchPersistentContext(profileDir, {
      channel: 'chromium',
      headless: true,
      // Playwright turns the back/forward cache off by default; one case needs it.
      ignoreDefaultArgs: ['--disable-back-forward-cache'],
      args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
    });
    sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15000 }));
  } catch (e) {
    launchError = e;
    await context?.close().catch(() => {});
    context = undefined;
  }
});

after(async () => {
  await context?.close().catch(() => {});
  for (const d of [extDir, profileDir]) {
    try {
      if (d) rmSync(d, { recursive: true, force: true });
    } catch {
      /* Chrome may still hold the profile on Windows */
    }
  }
});

function skip(t) {
  if (context) return false;
  t.skip(`Chromium extension unavailable: ${launchError?.message ?? 'unknown'}`);
  return true;
}

async function configure(cfg) {
  await sw.evaluate((c) => {
    self.cfg = { hosts: {}, fail: false, allowlisted: false, ...c };
    self.log = [];
  }, cfg);
}

async function openPage(pages) {
  const page = await context.newPage();
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = pages[path];
    if (body === undefined) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body });
  });
  return page;
}

const wait = (page, ms) => page.evaluate((n) => new Promise((r) => setTimeout(r, n)), ms);

/** Poll until `fn` returns the expected value or time runs out; returns the last value. */
async function until(fn, expected, ms = 3000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (JSON.stringify(last) === JSON.stringify(expected)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  return last;
}

const display = (frameOrPage, sel) =>
  frameOrPage.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? getComputedStyle(el).display : 'missing';
  }, sel);

test('about:blank, srcdoc and document.write frames get the page host cosmetics (B25)', async (t) => {
  if (skip(t)) return;
  await configure({ hosts: { 'site.test': { hide: ['.my-ad2'] } } });
  const page = await openPage({
    '/': `<!doctype html><body>
      <iframe id="src" srcdoc="<div class='my-ad2' id='s'>srcdoc ad</div>"></iframe>
      <script>
        const f = document.createElement('iframe');
        f.id = 'written';
        document.body.appendChild(f);
        f.contentDocument.open();
        f.contentDocument.write('<!doctype html><body><div class="my-ad2" id="w">written ad</div></body>');
        f.contentDocument.close();
      </script></body>`,
  });
  try {
    await page.goto(`${ORIGIN}/`);
    const written = await (await page.$('#written')).contentFrame();
    const srcdoc = await (await page.$('#src')).contentFrame();
    assert.equal(await until(() => display(written, '#w'), 'none'), 'none', 'document.write frame');
    assert.equal(await until(() => display(srcdoc, '#s'), 'none'), 'none', 'srcdoc frame');
    const hosts = await sw.evaluate(() =>
      self.log.filter((l) => l.type === 'cosmetic:get' && l.frameId !== 0).map((l) => l.hostname),
    );
    assert.ok(hosts.length >= 2 && hosts.every((h) => h === 'site.test'), JSON.stringify(hosts));
  } finally {
    await page.close();
  }
});

test('about:blank, srcdoc and document.write frames ask for dark mode with the page host (B25)', async (t) => {
  if (skip(t)) return;
  await configure({ hosts: {} });
  const page = await openPage({
    '/': `<!doctype html><body>
      <iframe id="src" srcdoc="<p>srcdoc</p>"></iframe>
      <iframe id="blank"></iframe>
      <script>
        const f = document.createElement('iframe');
        document.body.appendChild(f);
        f.contentDocument.open();
        f.contentDocument.write('<!doctype html><body><p>written</p></body>');
        f.contentDocument.close();
      </script></body>`,
  });
  try {
    await page.goto(`${ORIGIN}/`);
    const asked = () =>
      sw.evaluate(() =>
        self.log.filter((l) => l.type === 'darkmode:get' && l.frameId !== 0).map((l) => l.hostname),
      );
    // Three frames; before B25 none of them asked at all.
    const threeAsked = await until(async () => (await asked()).length >= 3, true);
    const hosts = await asked();
    assert.equal(threeAsked, true, `dark mode asked from ${JSON.stringify(hosts)}`);
    assert.ok(hosts.every((h) => h === 'site.test'), JSON.stringify(hosts));
  } finally {
    await page.close();
  }
});

test('an exception cancels a hide of the browser-injected sheet', async (t) => {
  if (skip(t)) return;
  await configure({ hosts: { 'site.test': { unhide: ['.bait'] }, 'other.test': {} } });
  const page = await openPage({ '/': `<!doctype html><body><div class="bait" id="bait">b</div></body>` });
  try {
    await page.goto(`${ORIGIN}/`);
    assert.equal(await until(() => display(page, '#bait'), 'block'), 'block');
  } finally {
    await page.close();
  }
});

test('a failed refresh keeps the hides; an allowlisted one clears them (P3)', async (t) => {
  if (skip(t)) return;
  await configure({
    hosts: { 'site.test': { hide: ['.ad'], procedural: [{ expr: '.card:has-text(Sponsored)' }] } },
  });
  const page = await openPage({
    '/': `<!doctype html><body><div class="ad" id="ad">ad</div><div class="card" id="card">Sponsored</div></body>`,
  });
  try {
    await page.goto(`${ORIGIN}/`);
    assert.equal(await until(() => display(page, '#ad'), 'none'), 'none');
    assert.equal(await until(() => display(page, '#card'), 'none'), 'none');

    await sw.evaluate(() => {
      self.cfg.fail = true;
    });
    await sw.evaluate(() => self.refresh());
    await wait(page, 1200); // five retries with back-off
    assert.equal(await display(page, '#ad'), 'none', 'no answer is not "nothing to hide"');
    assert.equal(await display(page, '#card'), 'none');

    await sw.evaluate(() => {
      self.cfg.fail = false;
      self.cfg.allowlisted = true;
    });
    await sw.evaluate(() => self.refresh());
    assert.equal(await until(() => display(page, '#ad'), 'block'), 'block');
    assert.equal(await until(() => display(page, '#card'), 'block'), 'block');
    // Asking again, the document says so: a worker that slept has forgotten what it inserted.
    const asks = await sw.evaluate(() => self.log.filter((l) => l.type === 'cosmetic:get').map((l) => l.refetch));
    assert.equal(asks[0], undefined);
    assert.ok(asks.length > 1 && asks.slice(1).every((r) => r === true), JSON.stringify(asks));
  } finally {
    await page.close();
  }
});

test('a page restored from the back/forward cache picks up the new state (P3)', async (t) => {
  if (skip(t)) return;
  await configure({ hosts: { 'site.test': { hide: ['.ad'] } } });
  const page = await openPage({
    '/a': `<!doctype html><body><div class="ad" id="ad">ad</div><a id="go" href="/b">b</a></body>`,
    '/b': `<!doctype html><body>b</body>`,
  });
  try {
    await page.goto(`${ORIGIN}/a`);
    assert.equal(await until(() => display(page, '#ad'), 'none'), 'none');
    await page.evaluate(() => {
      window.__marker = 1;
    });
    await page.click('#go');
    await page.waitForURL(`${ORIGIN}/b`);
    await sw.evaluate(() => {
      self.cfg.allowlisted = true;
    });
    // A back/forward-cache restore fires no load event.
    await page.goBack({ waitUntil: 'commit' });
    await page.waitForURL(`${ORIGIN}/a`, { waitUntil: 'commit' });
    const restored = await page.evaluate(() => window.__marker === 1);
    if (!restored) return t.skip('this Chromium did not restore the page from the back/forward cache');
    assert.equal(await until(() => display(page, '#ad'), 'block'), 'block');
  } finally {
    await page.close();
  }
});

test('the hidden-elements count is per slot, visible-checked and current (P3)', async (t) => {
  if (skip(t)) return;
  await configure({
    hosts: {
      'site.test': {
        hide: ['#a', 'div#a', '.box', '.box .inner', '.overridden'],
        procedural: [{ expr: '.card:has-text(Sponsored)' }, { expr: '.gone:has-text(x):remove()' }],
      },
    },
  });
  const page = await openPage({
    '/': `<!doctype html><body>
      <div id="a">a</div>
      <div class="box"><span class="inner">i</span></div>
      <div class="overridden" style="display:block !important">page wins</div>
      <div class="card">Sponsored</div><div class="card">Organic</div>
      <div class="gone">x</div>
    </body>`,
  });
  try {
    await page.goto(`${ORIGIN}/`);
    assert.equal(await until(() => display(page, '.card'), 'none'), 'none');
    // #a (two selectors, one element), .box (its hidden child is the same slot), one card,
    // one removed element. The overridden element is not hidden, so it does not count.
    assert.equal(await until(async () => (await sw.evaluate(() => self.pageCollect())).hiddenCount, 4), 4);
    await page.evaluate(() => document.querySelector('.box').remove());
    assert.equal((await sw.evaluate(() => self.pageCollect())).hiddenCount, 3);
  } finally {
    await page.close();
  }
});

test('action records from the worker restyle instead of hiding (B12)', async (t) => {
  if (skip(t)) return;
  await configure({
    hosts: {
      'site.test': {
        actions: [
          { expr: '.hero:style(margin-top: 0 !important)', selector: '.hero', procedural: false, action: 'style', arg: 'margin-top: 0 !important' },
          {
            expr: '.pi-btn:watch-attr(disabled):remove-class(is-locked)',
            selector: '.pi-btn:watch-attr(disabled)',
            procedural: true,
            action: 'remove-class',
            arg: 'is-locked',
          },
        ],
      },
    },
  });
  const page = await openPage({
    '/': `<!doctype html><head><style>.hero{margin-top:50px}</style></head><body>
      <div class="hero" id="hero">h</div><button class="pi-btn is-locked" id="play">Play</button></body>`,
  });
  try {
    await page.goto(`${ORIGIN}/`);
    const state = () =>
      page.evaluate(() => [
        getComputedStyle(document.getElementById('hero')).marginTop,
        document.getElementById('play').className,
        getComputedStyle(document.getElementById('play')).display,
      ]);
    assert.deepEqual(await until(state, ['0px', 'pi-btn', 'inline-block']), ['0px', 'pi-btn', 'inline-block']);
  } finally {
    await page.close();
  }
});

test('dark mode asks with the top host, and only YouTube pages ask for YouTube options (B27)', async (t) => {
  if (skip(t)) return;
  await configure({ hosts: {} });
  const page = await openPage({ '/': `<!doctype html><body>page</body>` });
  try {
    await page.goto(`${ORIGIN}/`);
    const asked = () =>
      sw.evaluate(() => self.log.filter((l) => l.frameId === 0).map((l) => `${l.type}:${l.topHost ?? ''}`).sort());
    const want = ['cosmetic:get:site.test', 'darkmode:get:site.test', 'scriptlets:get:site.test'];
    assert.deepEqual(await until(asked, want), want);
  } finally {
    await page.close();
  }
});
