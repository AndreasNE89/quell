// SponsorBlock: skip mid-video sponsor/intro/etc. segments using the public API.
// Segment fetch happens in the service worker (host_permissions); this module only
// parses the video id, seeks the player, and reacts to YouTube SPA navigations.

import type { YoutubeOptionsData } from '../shared/types.js';
import type { SponsorSegment } from '../shared/sponsorblock.js';
import { isYoutubeHost } from './youtube-ui.js';

export type { SponsorSegment } from '../shared/sponsorblock.js';
export { SPONSORBLOCK_SKIP_CATEGORIES } from '../shared/sponsorblock.js';

const TOAST_ID = 'quell-sponsorblock-toast';
const CATEGORY_LABEL: Record<string, string> = {
  sponsor: 'sponsor',
  selfpromo: 'self-promo',
  interaction: 'interaction reminder',
  intro: 'intro',
  outro: 'outro',
  preview: 'preview',
  music_offtopic: 'non-music',
};

let active = false;
let segments: SponsorSegment[] = [];
let currentVideoId: string | null = null;
let fetchGen = 0;
let tickTimer: number | null = null;
let spaHooked = false;
let getOpts: (() => YoutubeOptionsData | null) | null = null;
let fetchSegments: ((videoId: string) => Promise<SponsorSegment[]>) | null = null;

/** Extract an 11-char YouTube video id from a watch/shorts/embed/live URL. */
export function extractYoutubeVideoId(
  href: string = typeof location !== 'undefined' ? location.href : '',
): string | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (!isYoutubeHost(u.hostname) && u.hostname !== 'youtu.be') return null;

  const v = u.searchParams.get('v');
  if (v && isVideoId(v)) return v;

  const path = u.pathname;
  const m =
    path.match(/^\/(?:shorts|embed|live|v)\/([a-zA-Z0-9_-]{11})(?:\/|$)/) ||
    (u.hostname === 'youtu.be' ? path.match(/^\/([a-zA-Z0-9_-]{11})(?:\/|$)/) : null);
  return m && isVideoId(m[1]) ? m[1] : null;
}

function isVideoId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{11}$/.test(id);
}

/** Pick the next skippable segment covering `t` (or starting within a small lead-in). */
export function findSkipSegment(
  segs: SponsorSegment[],
  t: number,
  leadIn = 0.15,
): SponsorSegment | null {
  let best: SponsorSegment | null = null;
  for (const s of segs) {
    if (s.actionType && s.actionType !== 'skip') continue;
    const [start, end] = s.segment;
    if (!(Number.isFinite(start) && Number.isFinite(end)) || end <= start) continue;
    // Inside the segment, or just before the start (lead-in so we don't miss short ones).
    if (t + leadIn >= start && t < end - 0.05) {
      if (!best || start < best.segment[0]) best = s;
    }
  }
  return best;
}

function findPlayerVideo(): HTMLVideoElement | null {
  return (
    document.querySelector<HTMLVideoElement>('video.html5-main-video') ||
    document.querySelector<HTMLVideoElement>('#movie_player video') ||
    document.querySelector<HTMLVideoElement>('ytd-player video') ||
    document.querySelector<HTMLVideoElement>('video')
  );
}

function showToast(category: string): void {
  const label = CATEGORY_LABEL[category] ?? category;
  let el = document.getElementById(TOAST_ID) as HTMLDivElement | null;
  if (!el) {
    el = document.createElement('div');
    el.id = TOAST_ID;
    el.setAttribute('data-quell', 'sponsorblock-toast');
    Object.assign(el.style, {
      position: 'fixed',
      left: '50%',
      bottom: '72px',
      transform: 'translateX(-50%)',
      zIndex: '2147483646',
      padding: '8px 14px',
      borderRadius: '8px',
      background: 'rgba(20, 20, 20, 0.88)',
      color: '#f2f2f2',
      font: '13px/1.3 system-ui, sans-serif',
      pointerEvents: 'none',
      opacity: '0',
      transition: 'opacity 120ms ease',
    });
    (document.documentElement || document.body).appendChild(el);
  }
  el.textContent = `Skipped ${label}`;
  el.style.opacity = '1';
  window.setTimeout(() => {
    if (el) el.style.opacity = '0';
  }, 1600);
}

function enabled(): boolean {
  const opts = getOpts?.();
  if (!opts) return false;
  if (opts.paused || opts.allowlisted) return false;
  return !!opts.youtubeSponsorBlock;
}

async function loadForVideo(videoId: string): Promise<void> {
  const gen = ++fetchGen;
  currentVideoId = videoId;
  segments = [];
  if (!fetchSegments) return;
  try {
    const next = await fetchSegments(videoId);
    if (gen !== fetchGen || currentVideoId !== videoId) return;
    segments = next;
  } catch {
    if (gen !== fetchGen) return;
    segments = [];
  }
}

function tick(): void {
  if (!active || !enabled()) return;
  if (!isYoutubeHost(location.hostname)) return;

  const videoId = extractYoutubeVideoId();
  if (!videoId) {
    if (currentVideoId) {
      currentVideoId = null;
      segments = [];
      fetchGen++;
    }
    return;
  }
  if (videoId !== currentVideoId) {
    void loadForVideo(videoId);
    return;
  }
  if (!segments.length) return;

  const video = findPlayerVideo();
  if (!video || video.paused) return;

  const hit = findSkipSegment(segments, video.currentTime);
  if (!hit) return;
  const end = hit.segment[1];
  if (video.currentTime < end - 0.02) {
    try {
      video.currentTime = end;
      showToast(hit.category);
    } catch {
      /* seek can throw if media not ready */
    }
  }
}

function syncFromLocation(): void {
  if (!active || !enabled()) {
    segments = [];
    currentVideoId = null;
    return;
  }
  const videoId = extractYoutubeVideoId();
  if (!videoId) {
    currentVideoId = null;
    segments = [];
    return;
  }
  if (videoId !== currentVideoId) void loadForVideo(videoId);
}

function hookSpa(): void {
  if (spaHooked) return;
  spaHooked = true;
  const run = (): void => {
    syncFromLocation();
  };
  document.addEventListener('yt-navigate-finish', run, true);
  document.addEventListener('yt-navigate-start', run, true);
  document.addEventListener('yt-page-data-updated', run, true);
  window.addEventListener('popstate', run);
}

/**
 * Start SponsorBlock skipping on the top YouTube frame.
 * Safe to call repeatedly; no-ops in subframes / off YouTube.
 */
export function startSponsorBlock(options: {
  getOpts: () => YoutubeOptionsData | null;
  fetchSegments: (videoId: string) => Promise<SponsorSegment[]>;
}): void {
  // Only the top frame owns the main player; iframes would double-skip / waste API.
  if (typeof window !== 'undefined' && window !== window.top) return;
  if (!isYoutubeHost(location.hostname)) return;

  getOpts = options.getOpts;
  fetchSegments = options.fetchSegments;
  active = true;
  hookSpa();
  if (tickTimer == null) {
    tickTimer = window.setInterval(tick, 200);
  }
  syncFromLocation();
}

/** Re-apply after settings change (pause / allowlist / toggle). */
export function refreshSponsorBlock(): void {
  if (!active) return;
  if (!enabled()) {
    segments = [];
    currentVideoId = null;
    fetchGen++;
    return;
  }
  syncFromLocation();
}
