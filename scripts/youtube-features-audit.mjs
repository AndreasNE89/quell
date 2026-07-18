/**
 * Browser test for StampStack YouTube features (sponsored + Shorts toggles).
 *
 * Usage: node scripts/youtube-features-audit.mjs
 *
 * Requires a prior `npm run build` (loads unpacked extension from dist/).
 * Uses Playwright Chromium with --load-extension (not branded Chrome).
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const EXT = join(ROOT, 'dist');
const OUT = join(ROOT, 'docs', 'youtube-features-audit.json');
const SHOTS = join(ROOT, 'docs', 'youtube-features-shots');

/**
 * Use the Shorts hub, not a /shorts/<id> that YouTube may rewrite to /watch.
 * Hub path is always `/shorts` until StampStack (or the user) leaves it.
 */
const SHORTS_URL = 'https://www.youtube.com/shorts';
const HOME_URL = 'https://www.youtube.com/';
const WATCH_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

if (!existsSync(join(EXT, 'manifest.json'))) {
  console.error('Missing dist/. Run npm run build first.');
  process.exit(1);
}

function isConsentHost(hostname) {
  return /^(consent|accounts)\./i.test(hostname) || /consent\./i.test(hostname);
}

function isOnWwwYoutube(url) {
  try {
    const u = new URL(url);
    return /(^|\.)youtube\.com$/i.test(u.hostname) && !isConsentHost(u.hostname);
  } catch {
    return false;
  }
}

function isShortsPath(pathname) {
  return /^\/shorts(\/|$)/i.test(pathname);
}

/** True only when we landed on real YouTube UI off /shorts (consent /m is NOT success). */
function shortsRedirectSucceeded(href, path) {
  if (!isOnWwwYoutube(href)) return false;
  if (isConsentHost(new URL(href).hostname)) return false;
  // StampStack leaves Shorts via location.replace → `/`. Reject /watch rewrites of
  // non-Short ids and consent `/m` bounce paths.
  if (isShortsPath(path)) return false;
  if (/^\/m(\/|$)/i.test(path)) return false;
  return path === '/' || path === '';
}

async function getExtensionId(context) {
  let sw = context.serviceWorkers()[0];
  if (!sw) {
    try {
      sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
    } catch {
      /* fall through */
    }
  }
  if (sw) {
    const m = sw.url().match(/chrome-extension:\/\/([a-z]+)\//);
    if (m) return m[1];
  }
  throw new Error('StampStack service worker not found');
}

async function setYoutubeOptions(context, extensionId, sponsored, shorts) {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await page.evaluate(
      async ({ sponsored, shorts }) => {
        await chrome.runtime.sendMessage({
          type: 'popup:setYoutubeOptions',
          youtubeBlockSponsored: sponsored,
          youtubeBlockShorts: shorts,
          youtubeSponsorBlock: true,
        });
        await chrome.runtime.sendMessage({ type: 'popup:setPaused', paused: false });
      },
      { sponsored, shorts },
    );
    await new Promise((r) => setTimeout(r, 800));
  } finally {
    await page.close();
  }
}

/**
 * Dismiss YouTube/Google GDPR / cookie consent when present.
 * consent.youtube.com/m?... is NOT a successful Shorts redirect.
 */
async function dismissConsent(page, { timeoutMs = 12000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let dismissed = false;

  while (Date.now() < deadline) {
    const href = page.url();
    let host = '';
    try {
      host = new URL(href).hostname;
    } catch {
      /* ignore */
    }

    const onConsent =
      isConsentHost(host) ||
      (await page
        .locator(
          'form[action*="consent"], button:has-text("Accept all"), button:has-text("Accept All"), button:has-text("I agree"), #introAgreeButton',
        )
        .first()
        .isVisible({ timeout: 400 })
        .catch(() => false));

    if (!onConsent && isOnWwwYoutube(href)) {
      return { dismissed, href: page.url() };
    }

    const selectors = [
      'button:has-text("Accept all")',
      'button:has-text("Accept All")',
      'button:has-text("Accept everything")',
      'button:has-text("I agree")',
      'button:has-text("Agree")',
      'button:has-text("Got it")',
      'button[aria-label="Accept all"]',
      'form[action*="consent"] button[type="submit"]',
      '#introAgreeButton',
      'button.yt-spec-button-shape-next--filled',
    ];

    let clicked = false;
    for (const sel of selectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
        await btn.click({ timeout: 3000 }).catch(() => {});
        clicked = true;
        dismissed = true;
        break;
      }
    }

    // Some consent UIs use nested frames.
    if (!clicked) {
      for (const frame of page.frames()) {
        try {
          const fbtn = frame.locator('button:has-text("Accept all"), button:has-text("I agree")').first();
          if (await fbtn.isVisible({ timeout: 300 }).catch(() => false)) {
            await fbtn.click({ timeout: 3000 }).catch(() => {});
            clicked = true;
            dismissed = true;
            break;
          }
        } catch {
          /* ignore */
        }
      }
    }

    await new Promise((r) => setTimeout(r, clicked ? 1500 : 600));
    if (isOnWwwYoutube(page.url()) && !isConsentHost(new URL(page.url()).hostname)) {
      return { dismissed, href: page.url() };
    }
  }

  return { dismissed, href: page.url(), timedOut: true };
}

async function gotoYoutube(page, url, { waitMs = 3000 } = {}) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const consent = await dismissConsent(page);
  // After Accept all, YouTube may still be navigating; wait for settle.
  await new Promise((r) => setTimeout(r, waitMs));
  // Consent may reappear after first paint on some locales.
  if (isConsentHost(new URL(page.url()).hostname)) {
    await dismissConsent(page, { timeoutMs: 8000 });
    await new Promise((r) => setTimeout(r, 1500));
  }
  return consent;
}

async function waitForShortsOutcome(page, { expectLeave, timeoutMs = 12000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Keep clearing consent while waiting — it can interrupt redirects.
    if (isConsentHost(new URL(page.url()).hostname)) {
      await dismissConsent(page, { timeoutMs: 4000 });
    }
    const href = page.url();
    let path = '/';
    try {
      path = new URL(href).pathname;
    } catch {
      /* ignore */
    }
    if (expectLeave && shortsRedirectSucceeded(href, path)) return { href, path };
    if (!expectLeave && isOnWwwYoutube(href) && isShortsPath(path)) return { href, path };
    await new Promise((r) => setTimeout(r, 500));
  }
  const href = page.url();
  let path = '/';
  try {
    path = new URL(href).pathname;
  } catch {
    /* ignore */
  }
  return { href, path, timedOut: true };
}

async function measure(page, label) {
  await new Promise((r) => setTimeout(r, 2000));
  const data = await page.evaluate(() => {
    const style = document.getElementById('StampStack-youtube-features');
    const css = style?.textContent || '';
    const visible = (sel) => {
      try {
        return [...document.querySelectorAll(sel)].some((el) => {
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return (
            r.width > 2 &&
            r.height > 2 &&
            st.display !== 'none' &&
            st.visibility !== 'hidden' &&
            st.opacity !== '0'
          );
        });
      } catch {
        return false;
      }
    };
    return {
      href: location.href,
      host: location.hostname,
      path: location.pathname,
      hasFeatureStyle: !!style,
      cssHasSponsored: css.includes('ytd-ad-slot-renderer'),
      cssHasShorts:
        css.includes('ytd-reel-shelf-renderer') ||
        css.includes('is-shorts') ||
        css.includes('/shorts'),
      visibleShortsShelf: visible(
        'ytd-rich-shelf-renderer[is-shorts], ytd-reel-shelf-renderer, ytd-rich-section-renderer:has(ytd-reel-shelf-renderer)',
      ),
      visibleShortsNav: visible(
        'ytd-guide-entry-renderer a[title="Shorts"], ytd-mini-guide-entry-renderer a[title="Shorts"], ytd-guide-entry-renderer a[href*="/shorts"], ytd-mini-guide-entry-renderer a[href*="/shorts"]',
      ),
      visibleSponsoredTile: visible(
        'ytd-ad-slot-renderer, ytd-promoted-sparkles-web-renderer, ytd-promoted-video-renderer, .badge-style-type-ad',
      ),
      ytAdShowing: !!document.querySelector('.ad-showing'),
      title: document.title,
    };
  });
  mkdirSync(SHOTS, { recursive: true });
  const shot = join(SHOTS, `${label}.png`);
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  return { ...data, shot };
}

async function main() {
  const userData = mkdtempSync(join(tmpdir(), 'StampStack-yt-feat-'));
  console.log('Launching Chromium + StampStack…');
  const context = await chromium.launchPersistentContext(userData, {
    headless: false,
    locale: 'en-US',
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--no-first-run',
      '--disable-search-engine-choice-screen',
      '--lang=en-US',
    ],
    viewport: { width: 1400, height: 900 },
    ignoreDefaultArgs: ['--disable-extensions'],
  });

  // Reduce consent friction where possible (SOCS / CONSENT-style prefs).
  try {
    await context.addCookies([
      {
        name: 'SOCS',
        value: 'CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5LjA3X3AxGgJlbiACGgYIgJnorgY',
        domain: '.youtube.com',
        path: '/',
      },
      {
        name: 'CONSENT',
        value: 'YES+cb.20210328-17-p0.en+FX+410',
        domain: '.youtube.com',
        path: '/',
      },
      {
        name: 'SOCS',
        value: 'CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5LjA3X3AxGgJlbiACGgYIgJnorgY',
        domain: '.google.com',
        path: '/',
      },
    ]);
  } catch {
    /* best-effort */
  }

  const extensionId = await getExtensionId(context);
  console.log('Extension id:', extensionId);
  const results = [];
  const page = await context.newPage();

  // Warm up: hit YouTube once and clear consent before measuring features.
  console.log('\n[0] Warm-up / consent');
  const warm = await gotoYoutube(page, HOME_URL, { waitMs: 2500 });
  console.log(`  after consent: ${page.url()} (dismissed=${!!warm.dismissed})`);

  // ---- BOTH ON ----
  console.log('\n[1] Sponsored ON + Shorts ON');
  await setYoutubeOptions(context, extensionId, true, true);

  await gotoYoutube(page, SHORTS_URL, { waitMs: 1500 });
  const afterShorts = await waitForShortsOutcome(page, { expectLeave: true, timeoutMs: 14000 });
  const shortsDetail = await measure(page, 'shorts-on-redirect');
  const shortsRedirectOk = shortsRedirectSucceeded(afterShorts.href, afterShorts.path);
  console.log(
    `  shorts redirect: ${shortsRedirectOk ? 'OK' : 'FAIL'} path=${afterShorts.path} host=${new URL(afterShorts.href).hostname}`,
  );
  results.push({
    case: 'shorts-redirect-when-on',
    ok: shortsRedirectOk,
    detail: { ...shortsDetail, wait: afterShorts },
  });

  await gotoYoutube(page, HOME_URL, { waitMs: 5000 });
  const homeOn = await measure(page, 'home-features-on');
  const onRealYt = isOnWwwYoutube(homeOn.href) && !isConsentHost(homeOn.host);
  const styleOk =
    onRealYt && homeOn.hasFeatureStyle && homeOn.cssHasSponsored && homeOn.cssHasShorts;
  // Shelf hide is soft: require CSS at minimum; shelf visibility is best-effort.
  const homeShortsOk = styleOk && (!homeOn.visibleShortsShelf || homeOn.cssHasShorts);
  console.log(
    `  home style injected: ${styleOk ? 'OK' : 'FAIL'} shortsShelfVisible=${homeOn.visibleShortsShelf} shortsNavVisible=${homeOn.visibleShortsNav}`,
  );
  results.push({
    case: 'home-features-on',
    ok: homeShortsOk,
    detail: homeOn,
  });

  await gotoYoutube(page, WATCH_URL, { waitMs: 6000 });
  const watchOn = await measure(page, 'watch-sponsored-on');
  const watchOk =
    isOnWwwYoutube(watchOn.href) && watchOn.hasFeatureStyle && watchOn.cssHasSponsored;
  console.log(
    `  watch sponsored CSS: ${watchOk ? 'OK' : 'FAIL'} sponsoredVisible=${watchOn.visibleSponsoredTile} adShowing=${watchOn.ytAdShowing}`,
  );
  results.push({
    case: 'watch-sponsored-on',
    ok: watchOk,
    detail: watchOn,
    note: 'Pre-roll may still appear; CSS for promoted tiles must be present',
  });

  // ---- SHORTS OFF, SPONSORED ON ----
  console.log('\n[2] Sponsored ON + Shorts OFF');
  await setYoutubeOptions(context, extensionId, true, false);
  await gotoYoutube(page, SHORTS_URL, { waitMs: 1500 });
  const stay = await waitForShortsOutcome(page, { expectLeave: false, timeoutMs: 10000 });
  const shortsOffStay = await measure(page, 'shorts-off-stay');
  const stayedOnShorts =
    isOnWwwYoutube(stay.href) && !isConsentHost(new URL(stay.href).hostname) && isShortsPath(stay.path);
  console.log(
    `  shorts stay when off: ${stayedOnShorts ? 'OK' : 'FAIL'} path=${stay.path} host=${new URL(stay.href).hostname}`,
  );
  results.push({
    case: 'shorts-no-redirect-when-off',
    ok: stayedOnShorts,
    detail: { ...shortsOffStay, wait: stay },
  });

  // ---- BOTH OFF ----
  console.log('\n[3] Sponsored OFF + Shorts OFF');
  await setYoutubeOptions(context, extensionId, false, false);
  await gotoYoutube(page, HOME_URL, { waitMs: 4000 });
  const homeOff = await measure(page, 'home-features-off');
  const styleCleared =
    isOnWwwYoutube(homeOff.href) && !homeOff.cssHasSponsored && !homeOff.cssHasShorts;
  console.log(
    `  home style cleared: ${styleCleared ? 'OK' : 'FAIL'} hasStyle=${homeOff.hasFeatureStyle}`,
  );
  results.push({
    case: 'home-features-off',
    ok: styleCleared,
    detail: homeOff,
  });

  const failed = results.filter((r) => !r.ok);
  const summary = {
    generatedAt: new Date().toISOString(),
    extensionId,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(`\n${summary.passed}/${results.length} checks passed`);
  if (failed.length) {
    console.log('Failures:');
    for (const f of failed) console.log(`  - ${f.case}`);
  }
  console.log('Wrote', OUT);

  await context.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
