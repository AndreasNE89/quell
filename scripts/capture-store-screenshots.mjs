/**
 * Capture the five Chrome Web Store screenshots (1280×800, 24-bit PNG, no alpha).
 *
 *   npm run build:store
 *   npm run store-screenshots
 *
 * Two passes:
 *   1. The real extension from dist/ runs in Playwright's Chromium (a temp profile, never
 *      .cws-chrome-profile) against fictional *.example pages from scripts/store-shots/. Every
 *      piece of product UI in the shots is captured from it at 2x: the page with its ad slots
 *      really hidden by the shipped lists, the popup reporting on the tab beside it, the picker
 *      the service worker injects, the sponsor-skip notice, and Settings.
 *   2. A plain browser composites those captures into the paper frame (store-shots/frame.css,
 *      store-shots/shots.mjs) and screenshots it at exactly 1280×800.
 *
 * Nothing leaves the machine: every hostname resolves to the local fixture server or to
 * nothing, and the one SponsorBlock lookup is answered by a route, not the network.
 *
 * Playwright's Chromium, because official Chrome 137+ ignores --load-extension.
 */

// Playwright routes requests made by a service worker only when this is set before the worker
// attaches, and the sponsor-skip shot needs the extension worker's SponsorBlock lookup answered
// locally. It is read at attach time, so setting it here (after the hoisted imports) is enough.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHOTS, frameHtml } from './store-shots/shots.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'dist');
const FIXTURES = join(ROOT, 'scripts', 'store-shots');
const OUT = join(ROOT, 'store', 'screenshots');
const W = 1280;
const H = 800;

/** Fictional hosts → fixture page. */
const PAGES = {
  'news.example': 'news.html',
  'recipes.example': 'recipes.html',
  'shop.example': 'shop.html',
  // Sponsor skipping only runs on YouTube hosts, so the grey player fixture is served under
  // one (see player.html). The hostname appears nowhere in the shots.
  'www.youtube.com': 'player.html',
};
const VIDEO_ID = 'demo-video1';

if (!existsSync(join(EXT, 'manifest.json'))) {
  console.error('Missing dist/ — run `npm run build:store` first.');
  process.exit(1);
}

// ---- fonts ---------------------------------------------------------------------------------
// The frame text is Lato (SIL OFL 1.1), as in the promo tiles. It is not vendored: point
// STAMPSTACK_LATO_DIR at a folder holding Lato-Regular/Bold.ttf (or LatoWeb-*) if it is not
// installed somewhere usual. Without it the frame falls back to the system sans.
function findLato() {
  const dirs = [
    process.env.STAMPSTACK_LATO_DIR,
    process.env.WINDIR && join(process.env.WINDIR, 'Fonts'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'),
    join(homedir(), 'Library', 'Fonts'),
    '/Library/Fonts',
    join(homedir(), '.local', 'share', 'fonts'),
    '/usr/share/fonts/truetype/lato',
  ].filter(Boolean);
  const pick = (names) => {
    for (const d of dirs) for (const n of names) if (existsSync(join(d, n))) return join(d, n);
    return null;
  };
  return {
    400: pick(['Lato-Regular.ttf', 'LatoWeb-Regular.ttf']),
    700: pick(['Lato-Bold.ttf', 'LatoWeb-Bold.ttf']),
  };
}
const LATO = findLato();
if (!LATO[400] || !LATO[700]) {
  console.warn('! Lato not found; the frame text falls back to the system sans. Set STAMPSTACK_LATO_DIR.');
}

// ---- local server --------------------------------------------------------------------------
/** UI captures from pass 1 (name → { buf, src, w, h } in CSS px), served to pass 2. */
const captures = new Map();
let currentFrame = '';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
};
function send(res, status, body, type = 'text/plain') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}
function sendFile(res, file) {
  if (!file || !existsSync(file)) return send(res, 404, 'not found');
  send(res, 200, readFileSync(file), TYPES[extname(file)] ?? 'application/octet-stream');
}
const leaf = (p) => p.split('/').pop(); // no traversal out of the served folders

const server = createServer((req, res) => {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname);
  if (PAGES[host]) {
    // Any path serves the page (the player lives at /watch); fixtures have no sub-resources.
    return path === '/favicon.ico' ? send(res, 404, '') : sendFile(res, join(FIXTURES, PAGES[host]));
  }
  if (path === '/frame') return send(res, 200, currentFrame, TYPES['.html']);
  if (path === '/frame.css') return sendFile(res, join(FIXTURES, 'frame.css'));
  if (path.startsWith('/ui/')) {
    const c = captures.get(leaf(path).replace(/\.png$/, ''));
    return c ? send(res, 200, c.buf, TYPES['.png']) : send(res, 404, 'no capture');
  }
  if (path.startsWith('/brand/')) return sendFile(res, join(ROOT, 'store', 'brand', leaf(path)));
  if (path.startsWith('/icons/')) return sendFile(res, join(EXT, 'icons', leaf(path)));
  if (path === '/fonts/lato-400.ttf') return sendFile(res, LATO[400]);
  if (path === '/fonts/lato-700.ttf') return sendFile(res, LATO[700]);
  send(res, 404, 'not found');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;

// ---- pass 1: the real extension ------------------------------------------------------------
/** Keep a 2x PNG with its size in CSS px, which is what the frame lays out in. */
function keep(name, buf, w, h, extra = {}) {
  captures.set(name, { buf, src: `/ui/${name}.png`, w, h, ...extra });
}

/**
 * Poll `fn` in the page until it returns something truthy. page.waitForFunction cannot be used
 * on the extension's pages: once it has to poll it compiles the predicate with new Function,
 * which their CSP (script-src 'self') refuses. page.evaluate is not subject to that.
 */
async function until(page, fn, arg, timeout = 10_000) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(fn, arg)) return;
    if (Date.now() > end) throw new Error(`Timed out waiting on ${page.url()}: ${fn}`);
    await page.waitForTimeout(100);
  }
}

/** Clip (CSS px) from the top of `from` to the bottom of `to`, as wide as `widthOf`. */
function clipAround(page, { widthOf, from, to, padTop = 0, padBottom = 0 }) {
  return page.evaluate(
    ({ widthOf, from, to, padTop, padBottom }) => {
      const rect = (sel) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error(`missing ${sel}`);
        return el.getBoundingClientRect();
      };
      const box = rect(widthOf);
      const top = Math.max(0, rect(from).top - padTop);
      return { x: box.left, y: top, width: box.width, height: rect(to).bottom + padBottom - top };
    },
    { widthOf, from, to, padTop, padBottom },
  );
}

const PROFILE = mkdtempSync(join(tmpdir(), 'stampstack-shots-'));
const hostRules = [...Object.keys(PAGES).map((h) => `MAP ${h} 127.0.0.1:${PORT}`), 'MAP * ~NOTFOUND'];
const context = await chromium.launchPersistentContext(PROFILE, {
  // Full Chromium in new headless mode; Playwright's default headless shell cannot load
  // extensions.
  channel: 'chromium',
  headless: true,
  deviceScaleFactor: 2,
  locale: 'en-US',
  colorScheme: 'light',
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--lang=en-US',
    `--host-resolver-rules=${hostRules.join(', ')}`,
    // The fixtures are plain http; don't let Chromium try https on them first.
    '--disable-features=HttpsUpgrades',
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    // GPU rasterizing left ±3 levels of noise in gradients and shadows from run to run; software
    // rendering makes the shots byte-identical, so a diff means the UI really changed.
    '--disable-gpu',
    // Extension pages otherwise get LCD subpixel text: orange and blue fringes on every glyph,
    // which turn into halos once the store rescales the image for a Mac or a phone.
    '--disable-lcd-text',
  ],
});

try {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 20_000 }));
  const id = sw.url().match(/^chrome-extension:\/\/([a-z]+)\//)?.[1];
  if (!id) throw new Error(`Unexpected service worker ${sw.url()}; did dist/ load?`);
  const extUrl = (file) => `chrome-extension://${id}/${file}`;
  console.log('Extension', id);

  const open = async (url, viewport) => {
    const page = await context.newPage();
    await page.setViewportSize(viewport);
    await page.goto(url, { waitUntil: 'load' });
    return page;
  };

  // A dev build shows Dev unlock and the dev-only counters; neither may reach the listing.
  const probe = await open(extUrl('options.html'), { width: 600, height: 400 });
  const build = await probe.evaluate(async () => {
    const [dark, stats] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'darkmode:get' }),
      chrome.runtime.sendMessage({ type: 'stats:get' }),
    ]);
    return { unpacked: dark?.license?.unpacked, statsReliable: stats?.statsReliable, generatedAt: stats?.listsGeneratedAt };
  });
  if (build.unpacked !== false || build.statsReliable !== false) {
    throw new Error('dist/ is a dev build (Dev unlock and dev-only stats would show). Run `npm run build:store`.');
  }
  // Shot 2's state: step one of the repair ladder in use on shop.example, set through the same
  // message the popup's repair button sends.
  await probe.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'sitefix:set', hostname: 'shop.example', level: 'cosmetics' }),
  );
  await probe.close();

  // One sponsor segment for the fixture video, in the API's hash-prefix response shape.
  await context.route('https://sponsor.ajay.app/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { videoID: VIDEO_ID, segments: [{ category: 'sponsor', actionType: 'skip', segment: [1, 600], UUID: 'store-shot' }] },
      ]),
    }),
  );

  /**
   * The popup describes "the active tab in the current window". Opened as a tab it would
   * describe itself, so it loads in the background while the fixture tab is in front, and is
   * brought forward only to be photographed; popup.ts never re-queries the tab after that.
   */
  const popupFor = async (tab, host) => {
    const popup = await open(extUrl('popup.html'), { width: 344, height: 1000 });
    await tab.bringToFront();
    await popup.reload();
    await until(popup, (h) => document.getElementById('host')?.textContent === h, host);
    await until(popup, () => !!document.getElementById('reportSummary')?.textContent);
    await popup.bringToFront();
    // A background tab runs no transitions, so the switches animate into place only now.
    await popup.waitForTimeout(400);
    return popup;
  };

  // Shot 1: the news page with its ad slots hidden, and the popup's report on it.
  const news = await open('http://news.example/', { width: 1100, height: 770 });
  await news.waitForTimeout(1500); // the report re-scans for late tags; let the first pass land
  const shown = await news.$$eval('[data-shot-ad]', (els) =>
    els.filter((el) => getComputedStyle(el).display !== 'none').map((el) => el.id || el.className),
  );
  if (shown.length) throw new Error(`Ad slots the shipped lists did not hide: ${shown.join(', ')}`);
  // End the capture across the photo, the way a window cuts a page, and not through a line of
  // text: the frame's before picture covers the lower-left corner and would leave the stub of a
  // sliced caption beside it.
  const newsHeight = await news.evaluate(() => Math.ceil(document.querySelector('figure svg').getBoundingClientRect().bottom) - 24);
  keep('news', await news.screenshot({ clip: { x: 0, y: 0, width: 1100, height: newsHeight } }), 1100, newsHeight);

  // Shot 1's inset: the same page in a browser without StampStack, so the frame can show what
  // was taken out. Same host rules, so its ad and tracker tags still resolve to nothing.
  const plain = await chromium.launch({ args: [`--host-resolver-rules=${hostRules.join(', ')}`, '--disable-features=HttpsUpgrades', '--disable-gpu', '--disable-lcd-text'] });
  try {
    const page = await plain.newPage({ viewport: { width: 1100, height: 720 }, deviceScaleFactor: 2 });
    await page.goto('http://news.example/', { waitUntil: 'load' });
    const missing = await page.$$eval('[data-shot-ad]', (els) => els.filter((el) => getComputedStyle(el).display === 'none').length);
    if (missing) throw new Error(`${missing} ad slot(s) hidden without the extension; the inset would prove nothing`);
    keep('newsPlain', await page.screenshot(), 1100, 720);
  } finally {
    await plain.close();
  }

  const popup = await popupFor(news, 'news.example');
  console.log('  On this page:', await popup.textContent('#reportSummary'));
  let clip = await clipAround(popup, { widthOf: 'body', from: 'body', to: '#report', padBottom: 12 });
  keep('popupReport', await popup.screenshot({ clip }), clip.width, clip.height);

  // Shot 4, popup half: the YouTube group, opened.
  await popup.click('details.group summary');
  await popup.waitForTimeout(400);
  clip = await clipAround(popup, { widthOf: 'body', from: 'details.group', to: 'details.group', padTop: 12, padBottom: 12 });
  keep('popupYoutube', await popup.screenshot({ clip }), clip.width, clip.height);
  await popup.close();
  await news.close();

  // Shot 2: the repair panel on a site where step one is already in use.
  const shop = await open('http://shop.example/', { width: 900, height: 600 });
  const repair = await popupFor(shop, 'shop.example');
  await repair.click('#repairOpen');
  await repair.waitForTimeout(400);
  clip = await clipAround(repair, { widthOf: 'body', from: 'body', to: '#repairPanel', padBottom: 12 });
  keep('popupRepair', await repair.screenshot({ clip }), clip.width, clip.height);
  await repair.close();
  await shop.close();

  // Shot 3: the picker, injected by the service worker exactly as the popup's button asks.
  // 516 tall ends the page at the foot of the photo, so no line of text is sliced by the frame.
  const recipes = await open('http://recipes.example/', { width: 760, height: 516 });
  const helper = await open(extUrl('popup.html'), { width: 344, height: 600 });
  await recipes.bringToFront();
  const started = await helper.evaluate(() => chrome.runtime.sendMessage({ type: 'picker:start' }));
  if (!started?.ok) throw new Error(`picker:start failed: ${started?.error}`);
  await helper.close();
  // Park the pointer on the bar's own background, between its text and the e-mail field, so
  // the picker outlines the whole strip.
  const pointer = await recipes.evaluate(() => {
    const q = (s) => document.querySelector(s).getBoundingClientRect();
    const bar = q('#newsletter-bar');
    return [Math.round((q('#newsletter-bar strong').right + q('#newsletter-bar .field').left) / 2), Math.round(bar.top + bar.height / 2)];
  });
  await recipes.mouse.move(pointer[0], pointer[1]);
  await recipes.waitForTimeout(300);
  keep('picker', await recipes.screenshot(), 760, 516, { pointer });
  await recipes.close();

  // Shot 4: the skip notice, drawn by the shipped content script over a grey player.
  const player = await open(`http://www.youtube.com/watch?v=${VIDEO_ID}`, { width: 400, height: 225 });
  await until(player, () => document.getElementById('quell-sponsorblock-toast')?.style.opacity === '1', null, 15_000);
  await player.waitForTimeout(300); // past the 120ms fade-in
  keep('player', await player.screenshot(), 400, 225);
  await player.close();

  // Settings. The clock is pinned to two days after the lists were stamped, so the list-age
  // line reads the same on every run instead of drifting with the calendar.
  const options = await context.newPage();
  await options.setViewportSize({ width: 760, height: 1000 });
  if (build.generatedAt) await options.clock.setFixedTime(Date.parse(build.generatedAt) + 2 * 86_400_000);
  await options.goto(extUrl('options.html'), { waitUntil: 'load' });
  await until(options, () => !!(document.querySelector('#lists .list-item') && document.querySelector('#sponsorCategories .list-item')));
  // Whole page in one viewport, so a clip never needs scrolling; the width sets the line breaks.
  const fitHeight = async (width) => {
    await options.setViewportSize({ width, height: 1000 });
    await options.setViewportSize({ width, height: await options.evaluate(() => document.documentElement.scrollHeight) });
    await options.waitForTimeout(200);
  };
  // Shot 4, Settings half: the segment picker's heading and its first three rows (sponsors on,
  // the rest off by default).
  await fitHeight(760);
  clip = await clipAround(options, {
    widthOf: '#sponsorCategories',
    from: 'h3[data-i18n="options_which_segments_to_skip"]',
    to: '#sponsorCategories .list-item:nth-child(3)',
  });
  keep('segments', await options.screenshot({ clip }), clip.width, clip.height);
  // Shot 5: the page's own "no account, no telemetry" subtitle, then the filter lists with their
  // rule counts and the list-age line (the five lists that are on by default).
  await fitHeight(620);
  clip = await clipAround(options, { widthOf: '#lists', from: 'header.page-head', to: '.tagline' });
  keep('optionsHead', await options.screenshot({ clip }), clip.width, clip.height);
  clip = await clipAround(options, { widthOf: '#lists', from: 'section:has(#lists)', to: '#lists .list-item:nth-child(5)' });
  keep('lists', await options.screenshot({ clip }), clip.width, clip.height);
  await options.close();
} finally {
  await context.close().catch(() => {});
  rmSync(PROFILE, { recursive: true, force: true });
}

// ---- pass 2: the frames --------------------------------------------------------------------
mkdirSync(OUT, { recursive: true });
const ui = Object.fromEntries(captures);
const browser = await chromium.launch({ args: ['--disable-lcd-text'] });
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  for (const shot of SHOTS) {
    currentFrame = frameHtml(shot, ui);
    await page.goto(`http://127.0.0.1:${PORT}/frame`, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const png = await page.screenshot({ type: 'png' });
    // The store rejects screenshots with alpha. Chromium writes an opaque page as colour type 2
    // (8-bit RGB); check the IHDR rather than trust that.
    const [w, h, depth, type] = [png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]];
    if (w !== W || h !== H || depth !== 8 || type !== 2) {
      throw new Error(`${shot.file}: ${w}x${h}, depth ${depth}, colour type ${type}; expected ${W}x${H} 8-bit RGB`);
    }
    writeFileSync(join(OUT, shot.file), png);
    console.log(`  ok store/screenshots/${shot.file}  ${W}x${H} RGB, ${png.length} bytes`);
  }
} finally {
  await browser.close();
  server.close();
}
console.log('Upload them in order: dashboard → Store listing → Screenshots. See store/screenshots/README.md.');
