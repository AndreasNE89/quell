// YouTube-only UI features (ISOLATED world): sponsored/promoted hide + Shorts block.
// Driven by settings toggles from the popup/options page.

import type { Settings, YoutubeOptionsData } from '../shared/types.js';
import { isAllowlistedHost } from '../shared/hostname.js';

const STYLE_ID = 'quell-youtube-features';

const SPONSORED_SELECTORS = [
  'ytd-ad-slot-renderer',
  'ytd-banner-promo-renderer',
  'ytd-promoted-sparkles-web-renderer',
  'ytd-promoted-sparkles-text-search-renderer',
  'ytd-promoted-video-renderer',
  'ytd-in-feed-ad-layout-renderer',
  'ytd-display-ad-renderer',
  'ytd-action-companion-ad-renderer',
  'ytd-player-legacy-desktop-watch-ads-renderer',
  'ytd-rich-item-renderer:has(ytd-ad-slot-renderer)',
  'ytd-rich-item-renderer:has(.badge-style-type-ad)',
  'ytd-video-renderer:has(.badge-style-type-ad)',
  'ytd-compact-video-renderer:has(.badge-style-type-ad)',
  'ytd-compact-movie-renderer:has(.badge-style-type-ad)',
  'ytd-watch-next-secondary-results-renderer ytd-promoted-sparkles-web-renderer',
  'ytm-promoted-sparkles-text-search-renderer',
  'ytm-promoted-sparkles-web-renderer',
  '.ytp-ad-module',
  '.ytp-ad-player-overlay',
  '.ytp-ad-overlay-container',
  'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"]',
];

/** Keep in sync with common uBO “hide Shorts” lists (YouTube DOM churns often). */
const SHORTS_SELECTORS = [
  // Shelves / sections
  'ytd-rich-shelf-renderer[is-shorts]',
  'ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts])',
  'ytd-reel-shelf-renderer',
  'ytd-shorts',
  'ytd-reel-video-renderer',
  'ytd-reel-item-renderer',
  'ytd-rich-grid-slim-media[is-short]',
  'grid-shelf-view-model:has(ytm-shorts-lockup-view-model)',
  'grid-shelf-view-model:has(ytm-shorts-lockup-view-model-v2)',
  'ytd-rich-item-renderer:has(ytm-shorts-lockup-view-model)',
  'ytd-rich-item-renderer:has(ytm-shorts-lockup-view-model-v2)',
  'ytd-rich-item-renderer:has(a[href*="/shorts/"])',
  'ytd-grid-video-renderer:has(a[href*="/shorts/"])',
  'ytd-video-renderer:has(a[href*="/shorts/"])',
  'ytd-video-renderer:has(ytd-thumbnail-overlay-time-status-renderer[overlay-style="SHORTS"])',
  'ytd-rich-item-renderer:has([overlay-style="SHORTS"])',
  'ytd-compact-video-renderer:has(a[href*="/shorts/"])',
  // Nav / chips / tabs
  'ytd-guide-entry-renderer:has(a[title="Shorts"])',
  'ytd-mini-guide-entry-renderer:has(a[title="Shorts"])',
  'ytd-guide-entry-renderer:has(.ytd-guide-entry-renderer[title="Shorts"])',
  'ytd-mini-guide-entry-renderer:has(.ytd-mini-guide-entry-renderer[title="Shorts"])',
  'ytd-mini-guide-entry-renderer:has(a[href*="/shorts"])',
  'a[href="/shorts"]',
  'a[href^="/shorts/"]',
  'a[href^="/shorts?"]',
  'ytd-guide-entry-renderer[aria-label="Shorts"]',
  'ytd-mini-guide-entry-renderer[aria-label="Shorts"]',
  'yt-icon-button[aria-label="Shorts"]',
  'yt-tab-shape[tab-title="Shorts"]',
  'tp-yt-paper-tab:has(div[tab-identifier="FEshorts"])',
  'yt-chip-cloud-chip-renderer:has([aria-label="Shorts"])',
  'ytm-chip-cloud-chip-renderer:has([aria-label="Shorts"])',
  // Mobile
  'ytm-reel-shelf-renderer',
  'ytm-pivot-bar-item-renderer:has(.pivot-shorts)',
  'ytm-rich-section-renderer:has(ytm-reel-shelf-renderer)',
  'ytm-rich-section-renderer:has(ytm-shorts-lockup-view-model)',
  'ytm-shorts-lockup-view-model',
  'ytm-shorts-lockup-view-model-v2',
];

/** GDPR / consent hosts look like *.youtube.com but are not YouTube UI. */
function isConsentHost(hostname: string): boolean {
  return /^(consent|accounts)\./i.test(hostname);
}

export function isYoutubeHost(hostname: string): boolean {
  if (isConsentHost(hostname)) return false;
  return /(^|\.)youtube\.com$|(^|\.)youtube-nocookie\.com$|(^|\.)youtu\.be$|(^|\.)youtubekids\.com$/i.test(
    hostname,
  );
}

function isValidSelector(sel: string): boolean {
  try {
    document.createDocumentFragment().querySelector(sel);
    return true;
  } catch {
    return false;
  }
}

/** Build options from persisted settings (fast path before SW round-trip). */
export function youtubeOptsFromSettings(
  settings: Partial<Settings>,
  hostname: string,
): YoutubeOptionsData {
  return {
    paused: !!settings.paused,
    allowlisted: isAllowlistedHost(hostname, settings.allowlist ?? []),
    youtubeBlockSponsored: settings.youtubeBlockSponsored !== false,
    youtubeBlockShorts: !!settings.youtubeBlockShorts,
    youtubeSponsorBlock: settings.youtubeSponsorBlock !== false,
  };
}

// Cache the built CSS by the only inputs that matter (the two toggles) so the 800ms SPA
// poll doesn't re-run isValidSelector over ~55 selectors and re-serialize every tick.
let cssCache: { key: string; css: string } | null = null;

function buildCss(opts: YoutubeOptionsData): string {
  const key = `${opts.youtubeBlockSponsored ? 1 : 0}${opts.youtubeBlockShorts ? 1 : 0}`;
  if (cssCache && cssCache.key === key) return cssCache.css;
  const chunks: string[] = [];
  if (opts.youtubeBlockSponsored) {
    const sels = SPONSORED_SELECTORS.filter(isValidSelector);
    if (sels.length) chunks.push(`${sels.join(',\n')} { display: none !important; }`);
  }
  if (opts.youtubeBlockShorts) {
    const sels = SHORTS_SELECTORS.filter(isValidSelector);
    if (sels.length) chunks.push(`${sels.join(',\n')} { display: none !important; }`);
  }
  const css = chunks.join('\n');
  cssCache = { key, css };
  return css;
}

function applyStyle(css: string): void {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!css) {
    el?.remove();
    return;
  }
  // No-op when unchanged: replacing a live <style>'s text node invalidates the stylesheet
  // and forces a style recompute; the 800ms poll would otherwise trigger that every tick.
  if (el && el.textContent === css) return;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    el.setAttribute('data-quell', 'youtube-features');
    (document.head || document.documentElement).appendChild(el);
  }
  el.textContent = css;
}

function isShortsPath(pathname: string = location.pathname): boolean {
  return /^\/shorts(\/|$)/i.test(pathname);
}

let leavingShorts = false;
let clicksHooked = false;

function leaveShortsPage(): void {
  if (!isYoutubeHost(location.hostname) || !isShortsPath()) {
    leavingShorts = false;
    return;
  }
  if (leavingShorts) return;
  leavingShorts = true;
  // If replace is blocked or slow, allow a later poll to retry.
  window.setTimeout(() => {
    leavingShorts = false;
  }, 2000);
  try {
    location.replace(`${location.origin}/`);
  } catch {
    leavingShorts = false;
  }
}

/** Redirect a /shorts URL to the homepage. Used by the click handler below. */
function redirectIfShortsUrl(url: string | URL | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = typeof url === 'string' ? new URL(url, location.origin) : url;
    if (!isYoutubeHost(u.hostname) || !isShortsPath(u.pathname)) return false;
    leavingShorts = true;
    location.replace(`${u.origin}/`);
    return true;
  } catch {
    return false;
  }
}

// NOTE: we deliberately do NOT wrap history.pushState/replaceState here. The content script
// runs in the ISOLATED world, so overriding those methods is invisible to YouTube's own
// MAIN-world SPA router — it never fired. SPA Shorts navigations are handled event-driven by
// the yt-navigate-start / yt-navigate-finish listeners (→ leaveShortsPage) in watchYoutubeSpa,
// plus this capture-phase click handler for direct link clicks.
function hookShortsClicks(getOpts: () => YoutubeOptionsData | null): void {
  if (clicksHooked) return;
  clicksHooked = true;

  // Clicks on Shorts links before SPA navigation.
  document.addEventListener(
    'click',
    (ev) => {
      const opts = getOpts();
      if (!opts?.youtubeBlockShorts || opts.paused || opts.allowlisted) return;
      const t = ev.target;
      if (!(t instanceof Element)) return;
      const a = t.closest('a[href*="/shorts"]');
      if (!a) return;
      const href = a.getAttribute('href');
      if (!href) return;
      if (redirectIfShortsUrl(href)) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    },
    true,
  );
}

/**
 * Apply YouTube sponsored/Shorts features for the current page.
 * Safe to call repeatedly; no-ops off YouTube or when allowlisted/paused.
 */
export function applyYoutubeFeatures(opts: YoutubeOptionsData): void {
  if (!isYoutubeHost(location.hostname) || opts.paused || opts.allowlisted) {
    applyStyle('');
    leavingShorts = false;
    return;
  }

  applyStyle(buildCss(opts));

  if (opts.youtubeBlockShorts) {
    leaveShortsPage();
  } else {
    leavingShorts = false;
  }
}

/** Watch SPA navigations so Shorts redirects keep working on YouTube. */
export function watchYoutubeSpa(getOpts: () => YoutubeOptionsData | null): void {
  if (!isYoutubeHost(location.hostname)) return;

  hookShortsClicks(getOpts);

  const run = (): void => {
    const opts = getOpts();
    if (!opts) return;
    applyYoutubeFeatures(opts);
  };

  document.addEventListener('yt-navigate-finish', run, true);
  document.addEventListener('yt-navigate-start', run, true);
  document.addEventListener('yt-page-data-updated', run, true);
  window.addEventListener('popstate', run);
  // Poll: YouTube sometimes mutates the path without custom events (embeds / partial nav).
  setInterval(run, 800);
}
