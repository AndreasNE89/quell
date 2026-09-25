// SponsorBlock's skip toast and frame ownership in a real page (Playwright Chromium).
//
// The fake-DOM tests cannot show what a user can click or tab to, where a click goes after
// the toast fades, or which frames run at all. This file loads src/content/sponsorblock.ts
// into pages routed to youtube.com and friends, fakes only the <video> clock, and drives the
// module's 200 ms tick with Playwright's clock.
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
      contents: `import * as sb from './src/content/sponsorblock.ts'; window.__sb = sb;`,
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

const PLAYER = `<div id="movie_player" class="html5-video-player" style="width:640px;height:360px;background:#000"><video class="html5-main-video"></video></div>`;
const WATCH = `<!doctype html><html><body style="margin:0;height:2000px">${PLAYER}
<a id="lnk" href="#clicked" style="position:fixed;left:0;right:0;bottom:40px;height:100px;display:block;background:#eef">a comment link along the bottom of the page</a>
</body></html>`;

/** Fake the clock of the page's <video>s; seeks are logged in window.__seeks. */
const FAKE_VIDEO = `
  window.__seeks = [];
  window.__paused = false;
  window.__fakeVideo = (v, duration = 600) => {
    let t = 0;
    Object.defineProperty(v, 'paused', { get: () => window.__paused, configurable: true });
    Object.defineProperty(v, 'duration', { get: () => duration, configurable: true });
    Object.defineProperty(v, 'currentTime', {
      get: () => t,
      set: (x) => { window.__seeks.push([t, x]); t = x; },
      configurable: true,
    });
    window.__setT = (x) => { t = x; };
  };
  window.__startSb = (segs, extra = {}) => {
    __fakeVideo(document.querySelector('#movie_player video'));
    window.__fetches = [];
    const opts = {
      paused: false, allowlisted: false, youtubeBlockSponsored: true, youtubeBlockShorts: false,
      youtubeSponsorBlock: true, sponsorBlockCategories: ['sponsor', 'selfpromo'], ...extra,
    };
    window.__sb.startSponsorBlock({
      getOpts: () => opts,
      fetchSegments: async (id) => { __fetches.push(id); return segs[id] ?? []; },
    });
  };`;

/** Open `pages` (full URL → HTML) at `url`, with the module and the fake video helpers loaded. */
async function open(t, url, pages) {
  if (!browser) {
    t.skip(`Chromium unavailable: ${launchError?.message ?? 'unknown'}`);
    return null;
  }
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    const html = pages[u.origin + u.pathname];
    if (html === undefined) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: 'text/html', body: html });
  });
  await page.clock.install({ time: 1_000_000 });
  await page.goto(url);
  for (const frame of page.frames()) {
    await frame.addScriptTag({ content: `${bundle}\n${FAKE_VIDEO}` });
  }
  return page;
}

const SPONSOR = { category: 'sponsor', actionType: 'skip', segment: [10, 20], UUID: 's1' };
const seeks = (page) => page.evaluate(() => window.__seeks);

/** Where the Undo button sits, and what a click there would hit. */
function undoHit(page) {
  return page.evaluate(() => {
    const toast = document.getElementById('quell-sponsorblock-toast');
    const button = toast.querySelector('button');
    const r = button.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    const cs = getComputedStyle(toast);
    return { x, y, hitsUndo: document.elementFromPoint(x, y) === button, visibility: cs.visibility, pointerEvents: cs.pointerEvents };
  });
}

test('a faded toast is out of the way: clicks reach the page and Tab skips it (B62)', async (t) => {
  const page = await open(t, 'https://www.youtube.com/watch?v=AAAAAAAAAAA', {
    'https://www.youtube.com/watch': WATCH,
  });
  if (!page) return;
  await page.evaluate((s) => __startSb({ AAAAAAAAAAA: [s] }), SPONSOR);
  await page.clock.runFor(250);
  await page.evaluate(() => __setT(10.5));
  await page.clock.runFor(250);
  assert.deepEqual(await seeks(page), [[10.5, 20]]);
  assert.equal((await undoHit(page)).hitsUndo, true, 'a visible toast takes its clicks');

  await page.clock.runFor(4200);
  await page.waitForTimeout(300); // the fade itself runs on real time
  const hidden = await undoHit(page);
  assert.equal(hidden.hitsUndo, false, 'the invisible Undo still caught clicks');
  assert.deepEqual([hidden.visibility, hidden.pointerEvents], ['hidden', 'none']);
  const focusable = await page.evaluate(() => {
    const b = document.querySelector('#quell-sponsorblock-toast button');
    b.focus();
    return document.activeElement === b;
  });
  assert.equal(focusable, false, 'Tab still reached the invisible Undo');

  await page.evaluate(() => __setT(300));
  await page.mouse.click(hidden.x, hidden.y);
  assert.equal(await page.evaluate(() => location.hash), '#clicked');
  assert.deepEqual(await seeks(page), [[10.5, 20]], 'a click on the page seeked the video back');
});

test('Undo does not reach the player, which would toggle pause (B62)', async (t) => {
  const page = await open(t, 'https://www.youtube.com/watch?v=AAAAAAAAAAA', {
    'https://www.youtube.com/watch': WATCH,
  });
  if (!page) return;
  await page.evaluate((s) => {
    // Fullscreen: the toast moves into the fullscreened player.
    const player = document.getElementById('movie_player');
    Object.defineProperty(document, 'fullscreenElement', { get: () => player, configurable: true });
    window.__playerClicks = 0;
    for (const type of ['click', 'mousedown', 'pointerdown', 'dblclick']) {
      player.addEventListener(type, () => window.__playerClicks++);
    }
    __startSb({ AAAAAAAAAAA: [s] });
  }, SPONSOR);
  await page.clock.runFor(250);
  await page.evaluate(() => __setT(10.5));
  await page.clock.runFor(250);
  const hit = await undoHit(page);
  assert.equal(await page.evaluate(() => document.getElementById('quell-sponsorblock-toast').parentElement.id), 'movie_player');
  await page.mouse.click(hit.x, hit.y);
  assert.deepEqual(await seeks(page), [[10.5, 20], [20, 10.5]], 'Undo seeks back');
  assert.equal(await page.evaluate(() => window.__playerClicks), 0);
});

test('an Undo left over from the last video does not seek the next one (B62)', async (t) => {
  const page = await open(t, 'https://www.youtube.com/watch?v=AAAAAAAAAAA', {
    'https://www.youtube.com/watch': WATCH,
  });
  if (!page) return;
  await page.evaluate((s) => __startSb({ AAAAAAAAAAA: [s] }), SPONSOR);
  await page.clock.runFor(250);
  await page.evaluate(() => __setT(10.5));
  await page.clock.runFor(250);
  assert.deepEqual(await seeks(page), [[10.5, 20]]);

  await page.evaluate(() => {
    history.pushState({}, '', '/watch?v=BBBBBBBBBBB');
    document.dispatchEvent(new Event('yt-navigate-finish'));
    __setT(300);
  });
  await page.clock.runFor(250);
  await page.waitForTimeout(300);
  const visibility = await page.evaluate(
    () => getComputedStyle(document.getElementById('quell-sponsorblock-toast')).visibility,
  );
  assert.equal(visibility, 'hidden', 'the last video’s toast stayed up');
  await page.evaluate(() => document.querySelector('#quell-sponsorblock-toast button').click());
  assert.deepEqual(await seeks(page), [[10.5, 20]], 'video B was sent to video A’s timestamp');
});

test('after Undo on one segment, a segment overlapping it still skips', async (t) => {
  const page = await open(t, 'https://www.youtube.com/watch?v=AAAAAAAAAAA', {
    'https://www.youtube.com/watch': WATCH,
  });
  if (!page) return;
  const a = { category: 'sponsor', actionType: 'skip', segment: [100, 130], UUID: 'a' };
  const b = { category: 'selfpromo', actionType: 'skip', segment: [110, 200], UUID: 'b' };
  await page.evaluate((segs) => __startSb({ AAAAAAAAAAA: segs }), [a, b]);
  await page.clock.runFor(250);
  await page.evaluate(() => __setT(100.5));
  await page.clock.runFor(200);
  assert.deepEqual(await seeks(page), [[100.5, 130]]);
  await page.evaluate(() => document.querySelector('#quell-sponsorblock-toast button').click());
  assert.deepEqual((await seeks(page)).at(-1), [130, 100.5]);
  await page.clock.runFor(200);
  assert.equal((await seeks(page)).length, 2, 'the undone segment was skipped again');

  await page.evaluate(() => __setT(110.5));
  await page.clock.runFor(200);
  assert.deepEqual((await seeks(page)).at(-1), [110.5, 200], 'the self-promo the user never undid played');
});

test('the toast speaks the page’s language and is announced', async (t) => {
  const page = await open(t, 'https://www.youtube.com/watch?v=AAAAAAAAAAA', {
    'https://www.youtube.com/watch': WATCH,
  });
  if (!page) return;
  await page.evaluate((s) => {
    const catalog = {
      sponsorblock_toast_cat_sponsor: '赞助',
      sponsorblock_toast_skipped: '已跳过：$1',
      sponsorblock_toast_undo: '撤销',
    };
    window.chrome = window.chrome ?? {};
    window.chrome.i18n = {
      getMessage: (key, subs = []) => (catalog[key] ?? '').replace('$1', subs[0] ?? ''),
    };
    __startSb({ AAAAAAAAAAA: [s] });
  }, SPONSOR);
  await page.clock.runFor(250);
  await page.evaluate(() => __setT(10.5));
  await page.clock.runFor(250);
  const toast = await page.evaluate(() => {
    const el = document.getElementById('quell-sponsorblock-toast');
    return { text: el.querySelector('span').textContent, undo: el.querySelector('button').textContent, role: el.getAttribute('role') };
  });
  assert.deepEqual(toast, { text: '已跳过：赞助', undo: '撤销', role: 'status' });
});

const EMBED = `<!doctype html><html><body style="margin:0">${PLAYER}</body></html>`;

test('an embedded player on another site skips too, youtube-nocookie included (M11)', async (t) => {
  const page = await open(t, 'https://news.example/story', {
    'https://news.example/story': `<!doctype html><h1>Story</h1><iframe src="https://www.youtube-nocookie.com/embed/AAAAAAAAAAA" width="640" height="360"></iframe>`,
    'https://www.youtube-nocookie.com/embed/AAAAAAAAAAA': EMBED,
  });
  if (!page) return;
  const embed = page.frames().find((f) => f.url().includes('youtube-nocookie'));
  await embed.evaluate((s) => {
    window.__paused = true;
    __startSb({ AAAAAAAAAAA: [s] });
  }, SPONSOR);
  await page.clock.runFor(1000);
  assert.deepEqual(await embed.evaluate(() => window.__fetches), [], 'an embed nobody started asked SponsorBlock');
  await embed.evaluate(() => {
    window.__paused = false;
  });
  await page.clock.runFor(250);
  await embed.evaluate(() => __setT(10.5));
  await page.clock.runFor(250);
  assert.deepEqual(await embed.evaluate(() => window.__fetches), ['AAAAAAAAAAA']);
  assert.deepEqual(await embed.evaluate(() => window.__seeks), [[10.5, 20]]);
});

test('frames inside YouTube’s own pages leave the player to the top frame', async (t) => {
  const page = await open(t, 'https://www.youtube.com/', {
    'https://www.youtube.com/': `<!doctype html><iframe src="https://www.youtube.com/embed/AAAAAAAAAAA"></iframe><iframe src="https://www.youtube.com/live_chat"></iframe>`,
    'https://www.youtube.com/embed/AAAAAAAAAAA': EMBED,
    'https://www.youtube.com/live_chat': EMBED,
  });
  if (!page) return;
  for (const frame of page.frames().filter((f) => f !== page.mainFrame())) {
    await frame.evaluate((s) => __startSb({ AAAAAAAAAAA: [s] }), SPONSOR);
    await page.clock.runFor(250);
    assert.deepEqual(await frame.evaluate(() => window.__fetches), [], frame.url());
  }
});
