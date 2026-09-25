// YouTube's own features (src/content/youtube-ui.ts) in a real page (Playwright Chromium): the
// Shorts link handling, and how the repair steps reach the hide CSS and the Shorts redirect.
//
// Skips (does not fail) when Chromium cannot be launched.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let bundle = '';
let browser;
let launchError;

before(async () => {
  const out = await build({
    stdin: {
      contents: `import * as yt from './src/content/youtube-ui.ts'; window.__yt = yt;`,
      resolveDir: ROOT,
      loader: 'ts',
    },
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

// YouTube's router, in miniature: it leaves modified clicks to the browser and turns plain ones
// into an SPA navigation.
const WATCH = `<!doctype html><html><body>
<ytd-rich-shelf-renderer is-shorts id="shelf">Shorts shelf</ytd-rich-shelf-renderer>
<a id="short" href="/shorts/BBBBBBBBBBB" style="display:block !important;padding:20px">a Short linked from a comment</a>
<script>
  window.routerClicks = 0;
  document.getElementById('short').addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    window.routerClicks++;
    e.preventDefault();
    history.pushState({}, '', e.currentTarget.getAttribute('href'));
  });
</script>
</body></html>`;
const PLAIN = '<!doctype html><title>page</title>';

const OPTS = {
  paused: false,
  allowlisted: false,
  cosmeticsOff: false,
  scriptletsOff: false,
  youtubeBlockSponsored: true,
  youtubeBlockShorts: true,
  youtubeSponsorBlock: true,
  sponsorBlockCategories: ['sponsor'],
};

/** Open `url` on a youtube.com routed to fixtures, with youtube-ui.ts started on `opts`. */
async function open(t, url, opts = OPTS) {
  if (!browser) {
    t.skip(`Chromium unavailable: ${launchError?.message ?? 'unknown'}`);
    return null;
  }
  const context = await browser.newContext();
  t.after(() => context.close());
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.origin !== 'https://www.youtube.com') return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: 'text/html', body: u.pathname === '/watch' ? WATCH : PLAIN });
  });
  const page = await context.newPage();
  await page.goto('https://www.youtube.com/results?search_query=x');
  await page.goto(url);
  await page.addScriptTag({ content: bundle });
  await page.evaluate((o) => {
    window.__opts = o;
    __yt.watchYoutubeSpa(() => window.__opts);
    __yt.applyYoutubeFeatures(o);
  }, opts);
  return { context, page };
}

const WATCH_URL = 'https://www.youtube.com/watch?v=AAAAAAAAAAA&t=754';

test('Ctrl- and Shift-clicking a Shorts link leaves this tab where it is', async (t) => {
  const opened = await open(t, WATCH_URL);
  if (!opened) return;
  const { context, page } = opened;
  for (const modifiers of [['Control'], ['Shift']]) {
    const before = await page.evaluate(() => history.length);
    const popup = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
    await page.click('#short', { modifiers });
    await page.waitForTimeout(300);
    assert.equal(page.url(), WATCH_URL, `${modifiers}: the video being watched was replaced`);
    assert.equal(await page.evaluate(() => history.length), before);
    const other = await popup;
    assert.ok(other, `${modifiers}: the browser opened no tab or window`);
    await other.close();
  }
});

test('a plain click on a Shorts link goes nowhere, and YouTube’s router never sees it', async (t) => {
  const opened = await open(t, WATCH_URL);
  if (!opened) return;
  const { page } = opened;
  const before = await page.evaluate(() => history.length);
  await page.click('#short');
  await page.waitForTimeout(300);
  assert.equal(page.url(), WATCH_URL);
  assert.equal(await page.evaluate(() => history.length), before);
  assert.equal(await page.evaluate(() => window.routerClicks), 0);

  // Block Shorts off: the link is the page's again.
  await page.evaluate(() => {
    window.__opts = { ...window.__opts, youtubeBlockShorts: false };
  });
  await page.click('#short');
  assert.equal(await page.evaluate(() => window.routerClicks), 1);
  assert.equal(new URL(page.url()).pathname, '/shorts/BBBBBBBBBBB');
});

test('the repair steps reach YouTube’s hide CSS and the Shorts redirect (B32)', async (t) => {
  const hiding = await open(t, WATCH_URL);
  if (!hiding) return;
  const shelf = (page) => page.evaluate(() => getComputedStyle(document.getElementById('shelf')).display);
  assert.equal(await shelf(hiding.page), 'none');

  const cosmeticsOff = await open(t, WATCH_URL, { ...OPTS, cosmeticsOff: true });
  assert.notEqual(await shelf(cosmeticsOff.page), 'none', '"Stop hiding elements here" left the Shorts shelf hidden');
  assert.equal(await cosmeticsOff.page.evaluate(() => document.querySelector('style[data-quell]')), null);

  const redirected = await open(t, 'https://www.youtube.com/shorts/BBBBBBBBBBB');
  await redirected.page.waitForURL('https://www.youtube.com/');

  const kept = await open(t, 'https://www.youtube.com/shorts/BBBBBBBBBBB', {
    ...OPTS,
    cosmeticsOff: true,
    scriptletsOff: true,
  });
  await kept.page.waitForTimeout(500);
  assert.equal(kept.page.url(), 'https://www.youtube.com/shorts/BBBBBBBBBBB', 'script patches off, yet Shorts redirected');
});

test('scripts/youtube-features-audit.mjs checks the <style> the feature injects', async (t) => {
  const opened = await open(t, WATCH_URL);
  if (!opened) return;
  const audit = readFileSync(join(ROOT, 'scripts/youtube-features-audit.mjs'), 'utf8');
  const ids = [...audit.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length, 'the audit no longer looks the style up by id');
  for (const id of ids) {
    assert.ok(await opened.page.evaluate((i) => !!document.getElementById(i), id), `no element #${id} on the page`);
  }
});
