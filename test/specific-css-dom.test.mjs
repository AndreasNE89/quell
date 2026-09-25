// The site-specific cosmetic sheet in a real browser (Playwright Chromium).
//
// specific-css.test.mjs checks the serializer under a stub document whose querySelector never
// throws; the failures here only show in a real CSS parser: a selector querySelector accepts can
// still swallow the whole rule it is joined into, Blink ignores selectors past 8,192 components
// in one rule, and an exception written as `display: revert` overrides the site's own CSS.
//
// Skips (does not fail) when Chromium cannot be launched.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let bundle = '';
let browser;
let launchError;

before(async () => {
  const out = await build({
    stdin: {
      contents: `export * from './src/content/specific-css.ts';`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    globalName: '__css',
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

async function open(html) {
  const page = await browser.newPage();
  await page.setContent(html);
  await page.addScriptTag({ content: bundle });
  return page;
}

function skip(t) {
  if (browser) return false;
  t.skip(`Chromium unavailable: ${launchError?.message ?? 'unknown'}`);
  return true;
}

const display = (page, sel) =>
  page.$$eval(sel, (els) => els.map((e) => `${e.id}:${getComputedStyle(e).display}`));

test('one unbalanced selector no longer cancels every other hide (B19)', async (t) => {
  if (skip(t)) return;
  const page = await open(`<div class="ad" id="ad">a</div><div class="keep" id="keep">k</div>
    <div title="Sponsored" id="t">s</div>`);
  try {
    await page.evaluate(() =>
      __css.injectSpecificCss(
        // Unclosed quote, unclosed bracket, unclosed paren, trailing backslash — each passes
        // querySelector, which closes them at end of input.
        ['div[title="Sponsored', 'a[href*="promo"', 'div:not(.foo', '.keep\\', '.ad'],
        [],
      ),
    );
    assert.deepEqual(await display(page, '#ad, #keep, #t'), ['ad:none', 'keep:block', 't:block']);
    assert.deepEqual(
      await page.evaluate(() =>
        __css.validSelectors(['div[title="x', '.a', 'a[b', ':is(.x', '.c\\', '.d\\\\', '', '.e,', '.f']),
      ),
      ['.a', '.d\\\\', '.f'],
    );
  } finally {
    await page.close();
  }
});

test('a huge selector set is split so Blink applies all of it (B16)', async (t) => {
  if (skip(t)) return;
  const page = await open(`<div><div><span class="c2999" id="last">x</span></div></div>`);
  try {
    await page.evaluate(() => {
      const sels = [];
      for (let i = 0; i < 3000; i++) sels.push(`div > div > span.c${i}`);
      __css.injectSpecificCss(sels, []);
    });
    assert.deepEqual(await display(page, '#last'), ['last:none']);
  } finally {
    await page.close();
  }
});

test('an exception still cancels a hide of the generic sheet', async (t) => {
  if (skip(t)) return;
  // Stand-in for the browser-injected generic sheet.
  const page = await open(`<style>.bait { display: none !important; }</style>
    <div class="bait" id="bait">b</div>`);
  try {
    await page.evaluate(() => __css.injectSpecificCss([], ['.bait']));
    assert.deepEqual(await display(page, '#bait'), ['bait:block']);
    // Refreshing to a payload without it puts the generic hide back.
    await page.evaluate(() => __css.injectSpecificCss(['.other'], []));
    assert.deepEqual(await display(page, '#bait'), ['bait:none']);
  } finally {
    await page.close();
  }
});

test('the sheet comes back when the page removes it or rewrites the document', async (t) => {
  if (skip(t)) return;
  const page = await open(`<div class="ad" id="ad">a</div><iframe id="f"></iframe>`);
  try {
    await page.evaluate(() => __css.injectSpecificCss(['.ad'], []));
    await page.evaluate(() => document.querySelector('style[data-StampStack]').remove());
    await page.evaluate(() => new Promise((r) => setTimeout(r, 20)));
    assert.deepEqual(await display(page, '#ad'), ['ad:none']);

    // A friendly-iframe ad: about:blank frame, then document.open()/write().
    const frame = page.frames().find((f) => f !== page.mainFrame());
    await frame.addScriptTag({ content: bundle });
    await frame.evaluate(() => __css.injectSpecificCss(['.ad'], []));
    await page.evaluate(() => {
      const d = document.getElementById('f').contentDocument;
      d.open();
      d.write('<!doctype html><html><head></head><body><div class="ad" id="fad">ad</div></body></html>');
      d.close();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 20)));
    assert.equal(
      await frame.evaluate(() => getComputedStyle(document.getElementById('fad')).display),
      'none',
    );
  } finally {
    await page.close();
  }
});
