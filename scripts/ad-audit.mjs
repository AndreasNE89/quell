/**
 * Headed Chromium audit: load StampStack from dist/, visit ad-heavy sites with
 * blocking ON then OFF, and report whether ad traffic / ad UI drops.
 *
 * Usage: node scripts/ad-audit.mjs
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const EXT = join(ROOT, 'dist');
const OUT = join(ROOT, 'docs', 'ad-audit-results.json');
const SHOTS = join(ROOT, 'docs', 'ad-audit-shots');

if (!existsSync(join(EXT, 'manifest.json'))) {
  console.error('Missing dist/. Run npm run build first.');
  process.exit(1);
}

/** Ad / tracker host fragments we expect StampStack to reduce. */
const AD_HOST_RE =
  /(?:^|\.)(?:doubleclick\.net|googlesyndication\.com|googleadservices\.com|googletagservices\.com|pagead2\.googlesyndication\.com|adservice\.google|adsystems\.google|amazon-adsystem\.com|adsrvr\.org|adnxs\.com|ads-twitter\.com|facebook\.com\/tr|connect\.facebook\.net\/.*\/fbevents|scorecardresearch\.com|outbrain\.com|taboola\.com|criteo\.com|moatads\.com|pubmatic\.com|openx\.net|rubiconproject\.com|casalemedia\.com|2mdn\.net|media\.net|adsafeprotected\.com|quantserve\.com|yieldmo\.com|smartadserver\.com|serving-sys\.com|adform\.net|lijit\.com|sharethrough\.com|teads\.tv|spot\.im|zergnet\.com)/i;

const SITES = [
  {
    id: 'youtube',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    waitMs: 8000,
    notes: 'YouTube first-party ads often bypass EasyList; expect weak network blocking',
  },
  {
    id: 'google-search',
    url: 'https://www.google.com/search?q=best+wireless+headphones+buy',
    waitMs: 5000,
    notes: 'Sponsored results are first-party HTML — DNR rarely removes them',
  },
  {
    id: 'cnn',
    url: 'https://www.cnn.com/',
    waitMs: 7000,
  },
  {
    id: 'forbes',
    url: 'https://www.forbes.com/',
    waitMs: 8000,
  },
  {
    id: 'weather',
    url: 'https://weather.com/',
    waitMs: 7000,
  },
  {
    id: 'speedtest',
    url: 'https://www.speedtest.net/',
    waitMs: 6000,
  },
  {
    id: 'imdb',
    url: 'https://www.imdb.com/',
    waitMs: 6000,
  },
  {
    id: 'twitch',
    url: 'https://www.twitch.tv/',
    waitMs: 7000,
  },
];

function isAdUrl(url) {
  try {
    const u = new URL(url);
    return AD_HOST_RE.test(u.hostname + u.pathname);
  } catch {
    return false;
  }
}

async function getExtensionId(context) {
  // Prefer existing workers; then wait; then probe chrome://extensions via CDP.
  let sw = context.serviceWorkers()[0];
  if (!sw) {
    try {
      sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
    } catch {
      /* fall through */
    }
  }
  if (sw) {
    const m = sw.url().match(/chrome-extension:\/\/([a-z]+)\//);
    if (m) return m[1];
  }

  // Fallback: open a blank page and list extension targets.
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  const { targetInfos } = await session.send('Target.getTargets');
  await page.close();
  const ext = targetInfos.find(
    (t) =>
      t.url?.startsWith('chrome-extension://') &&
      (t.type === 'service_worker' || t.type === 'background_page'),
  );
  if (ext) {
    const m = ext.url.match(/chrome-extension:\/\/([a-z]+)\//);
    if (m) return m[1];
  }
  console.error(
    'Targets seen:',
    targetInfos.map((t) => `${t.type} ${t.url}`).join('\n'),
  );
  throw new Error('Could not find StampStack service worker — extension failed to load');
}

async function setPaused(context, extensionId, paused) {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await page.evaluate(async (p) => {
      await chrome.runtime.sendMessage({ type: 'popup:setPaused', paused: p });
    }, paused);
    // Give DNR ruleset enable/disable time to settle.
    await new Promise((r) => setTimeout(r, 1200));
  } finally {
    await page.close();
  }
}

async function measurePage(context, site, mode, extensionId) {
  const page = await context.newPage();
  const adHits = [];
  const blockedAds = [];
  const allFailed = [];

  page.on('request', (req) => {
    if (isAdUrl(req.url())) adHits.push({ url: req.url(), type: req.resourceType() });
  });
  page.on('requestfailed', (req) => {
    const url = req.url();
    const err = req.failure()?.errorText || '';
    allFailed.push({ url, err });
    if (isAdUrl(url) || /BLOCKED_BY_CLIENT|ERR_FAILED|net::ERR_ABORTED/i.test(err)) {
      if (isAdUrl(url) || /BLOCKED_BY_CLIENT/i.test(err)) {
        blockedAds.push({ url, err });
      }
    }
  });

  let navError = null;
  try {
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    navError = String(e.message || e);
  }
  await new Promise((r) => setTimeout(r, site.waitMs));

  // Best-effort dismiss cookie banners so layout is visible.
  try {
    for (const sel of [
      'button:has-text("Accept all")',
      'button:has-text("Accept All")',
      'button:has-text("I agree")',
      'button:has-text("Agree")',
      '#onetrust-accept-btn-handler',
      'button:has-text("Got it")',
    ]) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
        await btn.click({ timeout: 2000 }).catch(() => {});
        break;
      }
    }
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 1500));

  const dom = await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const st = getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
    };

    const iframes = [...document.querySelectorAll('iframe')].filter(visible);
    const adIframes = iframes.filter((f) => {
      const s = `${f.src} ${f.id} ${f.className} ${f.title}`.toLowerCase();
      return /ad|sponsor|doubleclick|googlesyndication|adservice|taboola|outbrain|amazon-adsystem/.test(
        s,
      );
    });

    const adLike = [...document.querySelectorAll('[class*="ad-"],[class*="ads-"],[id*="ad-"],[id*="google_ads"],[data-ad],[data-ad-slot],ins.adsbygoogle,.advertisement,.ad-container,.ad-slot')].filter(
      visible,
    );

    // YouTube player ad cues
    const ytAd =
      !!document.querySelector('.ad-showing, .ytp-ad-module, .video-ads, ytd-ad-slot-renderer, ytd-promoted-sparkles-web-renderer, ytd-display-ad-renderer');

    const ytAdShowing = !!document.querySelector('.ad-showing');

    return {
      title: document.title,
      iframeCount: iframes.length,
      adIframeCount: adIframes.length,
      adLikeVisible: adLike.length,
      ytAdUi: ytAd,
      ytAdShowing,
      bodyTextSample: (document.body?.innerText || '').slice(0, 200),
    };
  });

  mkdirSync(SHOTS, { recursive: true });
  const shotPath = join(SHOTS, `${site.id}-${mode}.png`);
  await page.screenshot({ path: shotPath, fullPage: false }).catch(() => {});

  await page.close();

  // Dedupe ad hit URLs by hostname
  const hosts = [...new Set(adHits.map((h) => {
    try {
      return new URL(h.url).hostname;
    } catch {
      return h.url;
    }
  }))];

  return {
    mode,
    navError,
    adRequestCount: adHits.length,
    adHosts: hosts,
    blockedAdCount: blockedAds.filter((b) => isAdUrl(b.url)).length,
    blockedByClient: allFailed.filter((f) => /BLOCKED_BY_CLIENT/i.test(f.err)).length,
    dom,
    screenshot: shotPath,
  };
}

function verdict(on, off, site) {
  const issues = [];
  const notes = [];

  const adReqDrop = off.adRequestCount - on.adRequestCount;
  const iframeDrop = off.dom.adIframeCount - on.dom.adIframeCount;
  const adLikeDrop = off.dom.adLikeVisible - on.dom.adLikeVisible;
  const blockedOk = on.blockedByClient > 0 || on.blockedAdCount > 0;

  if (site.id === 'youtube') {
    if (on.dom.ytAdShowing || on.dom.ytAdUi) {
      issues.push({
        severity: 'high',
        fix: 'YouTube in-player / companion ads still present with StampStack ON — need better YouTube-specific filters/scriptlets (MV3 cannot match uBO fully; consider known yt ad scriptlets + cosmetics).',
      });
    } else {
      notes.push('No obvious YouTube ad-showing UI detected (may still miss mid-roll).');
    }
  }

  if (site.id === 'google-search') {
    notes.push(
      'Google sponsored results are first-party; expect limited DNR impact. Cosmetic hide of .uEierd / commercial-unit may help.',
    );
  }

  if (off.adRequestCount === 0 && on.adRequestCount === 0) {
    notes.push('No matched third-party ad hosts observed in either mode (site may use first-party / uncommon CDNs).');
  } else if (adReqDrop <= 0 && on.blockedByClient === 0) {
    issues.push({
      severity: 'high',
      fix: `Third-party ad requests not reduced with StampStack ON (on=${on.adRequestCount}, off=${off.adRequestCount}). Check list enablement, DNR coverage for hosts: ${[...new Set([...on.adHosts, ...off.adHosts])].slice(0, 8).join(', ')}`,
    });
  } else if (adReqDrop > 0 || blockedOk) {
    notes.push(
      `Network: ad-ish requests on=${on.adRequestCount} off=${off.adRequestCount}; BLOCKED_BY_CLIENT≈${on.blockedByClient}.`,
    );
  }

  if (off.dom.adIframeCount > 0 && on.dom.adIframeCount >= off.dom.adIframeCount) {
    issues.push({
      severity: 'medium',
      fix: `Ad iframes still visible with StampStack ON (on=${on.dom.adIframeCount}, off=${off.dom.adIframeCount}). Need stronger cosmetic/element hiding or scriptlet anti-ad-recovery.`,
    });
  } else if (iframeDrop > 0) {
    notes.push(`Ad iframes reduced: ${off.dom.adIframeCount} → ${on.dom.adIframeCount}.`);
  }

  if (off.dom.adLikeVisible >= 3 && on.dom.adLikeVisible >= off.dom.adLikeVisible) {
    issues.push({
      severity: 'medium',
      fix: `Ad-like DOM nodes not reduced (on=${on.dom.adLikeVisible}, off=${off.dom.adLikeVisible}). Site-specific cosmetics likely missing.`,
    });
  }

  const ok = issues.filter((i) => i.severity === 'high').length === 0;
  return { ok, issues, notes, deltas: { adReqDrop, iframeDrop, adLikeDrop, blockedOk } };
}

async function main() {
  const userData = mkdtempSync(join(tmpdir(), 'StampStack-audit-'));
  console.log('Launching Chromium with StampStack from', EXT);
  console.log('Profile:', userData);

  // Official Chrome 137+ dropped --load-extension; use Playwright Chromium
  // (or Chrome for Testing) where the flag still works.
  const context = await chromium.launchPersistentContext(userData, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--no-first-run',
      '--disable-search-engine-choice-screen',
    ],
    viewport: { width: 1400, height: 900 },
    ignoreDefaultArgs: ['--disable-extensions'],
  });
  console.log('Browser:', await context.browser()?.version?.() || 'chromium persistent');

  const extensionId = await getExtensionId(context);
  console.log('Extension id:', extensionId);

  const only = new Set(process.argv.slice(2).filter((a) => !a.startsWith('-')));
  const selected = only.size ? SITES.filter((s) => only.has(s.id)) : SITES;
  if (!selected.length) {
    console.error('No matching sites. Known:', SITES.map((s) => s.id).join(', '));
    process.exit(1);
  }

  const results = [];

  for (const site of selected) {
    console.log(`\n=== ${site.id} ===`);
    console.log('  StampStack ON…');
    await setPaused(context, extensionId, false);
    const on = await measurePage(context, site, 'on', extensionId);
    console.log(
      `    adReqs=${on.adRequestCount} blockedClient=${on.blockedByClient} adIframes=${on.dom.adIframeCount} adLike=${on.dom.adLikeVisible}`,
    );

    console.log('  StampStack OFF (paused)…');
    await setPaused(context, extensionId, true);
    const off = await measurePage(context, site, 'off', extensionId);
    console.log(
      `    adReqs=${off.adRequestCount} blockedClient=${off.blockedByClient} adIframes=${off.dom.adIframeCount} adLike=${off.dom.adLikeVisible}`,
    );

    const v = verdict(on, off, site);
    console.log(v.ok ? '  ✓ looks effective (no high issues)' : '  ✗ gaps found');
    for (const i of v.issues) console.log(`    [${i.severity}] ${i.fix}`);
    for (const n of v.notes) console.log(`    note: ${n}`);

    results.push({
      site: site.id,
      url: site.url,
      siteNotes: site.notes || null,
      on,
      off,
      verdict: v,
    });
  }

  // Leave blocker on
  await setPaused(context, extensionId, false);

  const summary = {
    generatedAt: new Date().toISOString(),
    extensionId,
    sites: results,
    fixList: results.flatMap((r) =>
      r.verdict.issues.map((i) => ({
        site: r.site,
        severity: i.severity,
        fix: i.fix,
      })),
    ),
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log('\nWrote', OUT);
  console.log('Screenshots in', SHOTS);
  console.log('\n=== FIX LIST ===');
  if (!summary.fixList.length) console.log('(no automated high/medium issues)');
  else for (const f of summary.fixList) console.log(`- [${f.severity}] ${f.site}: ${f.fix}`);

  await context.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
