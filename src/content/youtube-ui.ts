// YouTube-only UI features (ISOLATED world): sponsored/promoted hide + Shorts block.
// Driven by settings toggles from the popup/options page.

import type { YoutubeOptionsData } from '../shared/types.js';

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

const SHORTS_SELECTORS = [
  'ytd-rich-shelf-renderer[is-shorts]',
  'ytd-reel-shelf-renderer',
  'ytd-shorts',
  'ytd-reel-video-renderer',
  'ytd-reel-item-renderer',
  'ytd-rich-grid-slim-media[is-short]',
  'ytd-rich-item-renderer:has(a[href*="/shorts/"])',
  'ytd-grid-video-renderer:has(a[href*="/shorts/"])',
  'ytd-video-renderer:has(a[href*="/shorts/"])',
  'ytd-guide-entry-renderer:has(a[title="Shorts"])',
  'ytd-mini-guide-entry-renderer:has(a[title="Shorts"])',
  'ytd-guide-entry-renderer a[title="Shorts"]',
  'ytd-mini-guide-entry-renderer a[title="Shorts"]',
  'ytd-guide-entry-renderer:has(a[href*="/shorts"])',
  'ytd-mini-guide-entry-renderer:has(a[href*="/shorts"])',
  'tp-yt-paper-tab:has(div[tab-identifier="FEshorts"])',
  '#items > ytd-guide-entry-renderer:has([title="Shorts"])',
  'ytm-pivot-bar-item-renderer:has(.pivot-shorts)',
  'ytm-rich-section-renderer:has(ytm-reel-shelf-renderer)',
];

/** GDPR / consent hosts look like *.youtube.com but are not YouTube UI. */
function isConsentHost(hostname: string): boolean {
  return /^(consent|accounts)\./i.test(hostname);
}

function isYoutubeHost(hostname: string): boolean {
  if (isConsentHost(hostname)) return false;
  return /(^|\.)youtube\.com$|(^|\.)youtube-nocookie\.com$|(^|\.)youtu\.be$|(^|\.)youtubekids\.com$/i.test(
    hostname,
  );
}

function buildCss(opts: YoutubeOptionsData): string {
  const chunks: string[] = [];
  if (opts.youtubeBlockSponsored) {
    chunks.push(`${SPONSORED_SELECTORS.join(',\n')} { display: none !important; }`);
  }
  if (opts.youtubeBlockShorts) {
    chunks.push(`${SHORTS_SELECTORS.join(',\n')} { display: none !important; }`);
  }
  return chunks.join('\n');
}

function applyStyle(css: string): void {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!css) {
    el?.remove();
    return;
  }
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

function leaveShortsPage(): void {
  if (!isYoutubeHost(location.hostname) || !isShortsPath() || leavingShorts) return;
  leavingShorts = true;
  try {
    location.replace(`${location.origin}/`);
  } catch {
    leavingShorts = false;
  }
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
  setInterval(run, 1200);
}
