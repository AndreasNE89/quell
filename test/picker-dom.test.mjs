// The element picker in a real page (Playwright Chromium).
//
// picker.js is bundled as the service worker injects it and run against a stand-in `chrome`
// object, with real (trusted) mouse and keyboard input from Playwright. Covers what the old
// document-listener picker got wrong: the page saw the pick's pointer events, an ad iframe could
// not be picked and swallowed the click, Esc stopped working once focus was in a frame, page
// scripts could pick with synthetic events, widening was lost on a 1px move, and structural
// selectors matched a dozen stories.
//
// Skips (does not fail) when Chromium cannot be launched.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://news.test';

let bundle = '';
let browser;
let launchError;

before(async () => {
  const out = await build({
    entryPoints: [join(ROOT, 'src/content/picker.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    write: false,
    logLevel: 'silent',
  });
  bundle = out.outputFiles[0].text;
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

const CHROME_STUB = `
  window.__sent = [];
  window.__cosmetic = { allowlisted: false };
  window.__addResult = { ok: true };
  window.chrome = {
    runtime: {
      sendMessage: async (m) => {
        window.__sent.push(m);
        if (m.type === 'cosmetic:get') return window.__cosmetic;
        if (m.type === 'customfilters:add') return window.__addResult;
        return null;
      },
    },
    i18n: { getMessage: () => '' },
  };`;

async function open(body) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.route('**/*', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><script>${CHROME_STUB}</script></head><body>${body}</body></html>`,
    }),
  );
  await page.goto(`${ORIGIN}/`);
  return page;
}

async function startPicker(page) {
  await page.addScriptTag({ content: bundle });
  // Let the up-front cosmetic:get check settle.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 20)));
}

async function center(page, sel) {
  const b = await page.locator(sel).first().boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

const overlayMounted = (page) => page.evaluate(() => !!document.getElementById('stampstack-picker-root'));
const added = (page) =>
  page.evaluate(() => window.__sent.filter((m) => m.type === 'customfilters:add').map((m) => m.line));

async function pickAt(page, sel) {
  const p = await center(page, sel);
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 20)));
}

function skip(t) {
  if (browser) return false;
  t.skip(`Chromium unavailable: ${launchError?.message ?? 'unknown'}`);
  return true;
}

test('the page never sees the pick pointer events (B40)', async (t) => {
  if (skip(t)) return;
  const page = await open(`<div id="ad" class="ad-box" style="width:300px;height:100px">ad</div>
    <script>
      window.seen = [];
      for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
        document.addEventListener(type, () => seen.push('doc:' + type), true);
        document.getElementById('ad').addEventListener(type, () => seen.push('ad:' + type));
      }
    </script>`);
  try {
    await startPicker(page);
    await pickAt(page, '#ad');
    assert.deepEqual(await added(page), ['news.test###ad']);
    assert.deepEqual(await page.evaluate(() => window.seen), []);
  } finally {
    await page.close();
  }
});

test('an ad iframe can be picked and does not receive the click (B40)', async (t) => {
  if (skip(t)) return;
  const page = await open(`<iframe id="adframe" style="width:300px;height:250px;border:0"
      srcdoc="<body style='margin:0'><a href='#' id='x' style='display:block;height:240px'>ad</a><script>window.clicks=0;document.addEventListener('click',()=>{clicks++;parent.postMessage('frame-click','*')},true)</script></body>"></iframe>
    <script>window.frameClicks = 0; addEventListener('message', (e) => { if (e.data === 'frame-click') frameClicks++; });</script>`);
  try {
    await page.waitForFunction(() => document.getElementById('adframe').contentDocument?.getElementById('x'));
    await startPicker(page);
    await pickAt(page, '#adframe');
    assert.deepEqual(await added(page), ['news.test###adframe']);
    assert.equal(await page.evaluate(() => window.frameClicks), 0);
    assert.equal(await overlayMounted(page), false);
  } finally {
    await page.close();
  }
});

test('Esc closes the picker even when an iframe had focus (B40)', async (t) => {
  if (skip(t)) return;
  const page = await open(`<iframe id="f" srcdoc="<input id='q'>"></iframe>`);
  try {
    const frame = await (await page.$('#f')).contentFrame();
    await frame.waitForSelector('#q');
    await frame.focus('#q');
    await startPicker(page);
    assert.equal(await overlayMounted(page), true);
    await page.keyboard.press('Escape');
    assert.equal(await overlayMounted(page), false);
  } finally {
    await page.close();
  }
});

test('synthetic page events cannot pick or cancel (B40)', async (t) => {
  if (skip(t)) return;
  const page = await open(`<nav id="decoy" style="height:50px">nav</nav><div id="nag" style="height:80px">nag</div>`);
  try {
    await startPicker(page);
    await page.evaluate(() => {
      const d = document.getElementById('decoy');
      const r = d.getBoundingClientRect();
      const opts = { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 };
      document.dispatchEvent(new MouseEvent('mousemove', opts));
      d.dispatchEvent(new MouseEvent('click', opts));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    assert.deepEqual(await added(page), []);
    assert.equal(await overlayMounted(page), true);
  } finally {
    await page.close();
  }
});

test('widening survives a 1px move before the click (P3)', async (t) => {
  if (skip(t)) return;
  const page = await open(`<section class="sponsor-box" style="padding:40px">
      <p class="sponsor-text" style="margin:0;height:40px">Sponsored</p></section>`);
  try {
    await startPicker(page);
    const p = await center(page, '.sponsor-text');
    await page.mouse.move(p.x, p.y);
    await page.keyboard.press('ArrowUp');
    await page.mouse.move(p.x + 1, p.y);
    await page.mouse.click(p.x + 1, p.y);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 20)));
    assert.deepEqual(await added(page), ['news.test##section.sponsor-box']);
  } finally {
    await page.close();
  }
});

test('a structural pick is made unique instead of matching every story (B41)', async (t) => {
  if (skip(t)) return;
  const story = (i) =>
    `<div class="css-a${i}1b2c3"><div class="css-b${i}1b2c3"><div class="css-c${i}1b2c3"><div class="css-d${i}1b2c3" style="height:20px">story ${i}</div></div></div></div>`;
  const stories = Array.from({ length: 12 }, (_, i) => story(i)).join('');
  const page = await open(`<main>${stories}</main>
    <aside><div class="css-aa11bb"><div class="css-cc22dd"><div class="css-ee33ff"><div class="css-gg44hh" id="x" style="height:30px">ad</div></div></div></div></aside>`);
  try {
    await page.evaluate(() => document.getElementById('x').removeAttribute('id'));
    await startPicker(page);
    await pickAt(page, 'aside .css-gg44hh');
    const lines = await added(page);
    assert.equal(lines.length, 1);
    const selector = lines[0].slice('news.test##'.length);
    const r = await page.evaluate((sel) => {
      const m = [...document.querySelectorAll(sel)];
      return { count: m.length, isAd: m[0]?.textContent };
    }, selector);
    assert.deepEqual(r, { count: 1, isAd: 'ad' }, selector);
    assert.doesNotMatch(selector, /^[a-z]+(?:\s*>\s*[a-z]+)*$/, 'no bare-tag chain');
  } finally {
    await page.close();
  }
});

test('a failed save leaves the element visible and the picker open (P3)', async (t) => {
  if (skip(t)) return;
  const page = await open(`<div id="ad" style="height:60px">ad</div>`);
  try {
    await page.evaluate(() => {
      window.__addResult = { ok: false, error: '"localhost" is not a hostname.' };
    });
    await startPicker(page);
    await pickAt(page, '#ad');
    assert.deepEqual(await added(page), ['news.test###ad']);
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('ad')).display), 'block');
    assert.equal(await overlayMounted(page), true);
  } finally {
    await page.close();
  }
});

test('the picker refuses where element hiding is off (P3)', async (t) => {
  if (skip(t)) return;
  const page = await open(`<div id="ad" style="height:60px">ad</div>`);
  try {
    await page.evaluate(() => {
      window.__cosmetic = { allowlisted: true };
    });
    await startPicker(page);
    await pickAt(page, '#ad');
    assert.deepEqual(await added(page), []);
    assert.equal(await overlayMounted(page), false, 'a click closes the refusal');
  } finally {
    await page.close();
  }
});

test('attribute values with backslashes and newlines stay valid CSS (B19)', async (t) => {
  if (skip(t)) return;
  const page = await open(`<div class="css-9x8y7z" style="height:60px">ad</div>`);
  try {
    await page.evaluate(() => document.querySelector('div').setAttribute('aria-label', 'Close\\\nad'));
    await startPicker(page);
    await pickAt(page, 'div[aria-label]');
    const [line] = await added(page);
    const selector = line.slice('news.test##'.length);
    const count = await page.evaluate((sel) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(`${sel}, .probe {}`);
      return [sheet.cssRules.length, document.querySelectorAll(sel).length];
    }, selector);
    assert.deepEqual(count, [1, 1], selector);
  } finally {
    await page.close();
  }
});
