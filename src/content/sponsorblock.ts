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
  // #movie_player first: the hover-preview player (ytd-video-preview) also uses
  // .html5-main-video, and it can precede the real player in document order — so the old
  // class-first lookup could grab a thumbnail preview and "skip" inside that instead of the
  // video being watched.
  const main =
    document.querySelector<HTMLVideoElement>('#movie_player video.html5-main-video') ||
    document.querySelector<HTMLVideoElement>('#movie_player video') ||
    document.querySelector<HTMLVideoElement>('ytd-player video');
  if (main) return main;
  for (const v of document.querySelectorAll<HTMLVideoElement>('video')) {
    if (!v.closest('ytd-video-preview')) return v;
  }
  return null;
}

/**
 * True while the main player is running an ad. During an ad the element's clock is the AD's
 * — currentTime counts 0..30s through the ad — so every early-video segment "matches" and a
 * skip fires at what looks like a random moment. Nothing may be skipped until content time
 * is back on the clock.
 */
function playerShowingAd(): boolean {
  const p = document.getElementById('movie_player');
  return !!p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting'));
}


/** Segments the user undid; keyed by UUID so the same one is not re-skipped on this video. */
const skipSuppressed = new Set<string>();
let toastTimer: number | null = null;

/**
 * Toast for a completed skip, with an Undo.
 *
 * A wrong skip was previously unrecoverable — the user had to scrub back by hand and then
 * fight the skip firing again. Undo seeks back and suppresses that segment for the rest of the
 * video, which is the behavior SponsorBlock users expect.
 */
function showToast(hit: SponsorSegment, from: number): void {
  const label = CATEGORY_LABEL[hit.category] ?? hit.category;
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
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      padding: '8px 10px 8px 14px',
      borderRadius: '8px',
      background: 'rgba(20, 20, 20, 0.88)',
      color: '#f2f2f2',
      font: '13px/1.3 system-ui, sans-serif',
      // Interactive now, so it must accept clicks — but only over the toast itself.
      pointerEvents: 'auto',
      opacity: '0',
      transition: 'opacity 120ms ease',
    });
  }
  // Re-parent on every show: while the player is fullscreen, only the fullscreened element
  // renders, so a toast on <html> announced nothing — skips looked like random glitches with
  // no explanation and no reachable Undo. A <video> cannot render children; use its parent.
  const fs = document.fullscreenElement;
  const root =
    fs && fs.tagName !== 'VIDEO' ? fs : (fs?.parentElement ?? document.documentElement ?? document.body);
  if (el.parentElement !== root) root.appendChild(el);
  el.textContent = '';

  const text = document.createElement('span');
  text.textContent = `Skipped ${label}`;
  const undo = document.createElement('button');
  undo.type = 'button';
  undo.textContent = 'Undo';
  Object.assign(undo.style, {
    background: 'transparent',
    border: '1px solid rgba(255,255,255,0.35)',
    borderRadius: '6px',
    color: '#f2f2f2',
    font: 'inherit',
    padding: '2px 8px',
    cursor: 'pointer',
  });
  undo.addEventListener('click', () => {
    skipSuppressed.add(hit.UUID ?? `${hit.segment[0]}`);
    const video = findPlayerVideo();
    if (video) {
      try {
        video.currentTime = from;
      } catch {
        /* media not ready */
      }
    }
    if (el) el.style.opacity = '0';
  });
  el.append(text, undo);

  el.style.opacity = '1';
  if (toastTimer != null) window.clearTimeout(toastTimer);
  // Longer than before: the toast is now something to act on, not just read.
  toastTimer = window.setTimeout(() => {
    if (el) el.style.opacity = '0';
  }, 4000);
}

function enabled(): boolean {
  const opts = getOpts?.();
  if (!opts) return false;
  if (opts.paused || opts.allowlisted) return false;
  return !!opts.youtubeSponsorBlock;
}

/**
 * Retry state for a failed segment load.
 *
 * The previous version latched `currentVideoId` before awaiting the fetch, so a single failure
 * — most commonly losing the race with a cold service worker on the first video of a session —
 * left `segments` empty with the video still marked as loaded. `tick` then saw "same video, no
 * segments" and returned forever: SponsorBlock silently did nothing for that entire page load.
 */
let loadFailed = false;
let retryAttempt = 0;
let nextRetryAt = 0;
const MAX_RETRIES = 3;

async function loadForVideo(videoId: string): Promise<void> {
  const gen = ++fetchGen;
  const isNewVideo = videoId !== currentVideoId;
  currentVideoId = videoId;
  segments = [];
  loadFailed = false;
  // "Suppressed for the rest of the video" means exactly that — a retry on the same video must
  // keep the user's undos, but moving to a new video must not inherit them. The fallback key is
  // a start time, which can collide across videos.
  if (isNewVideo) skipSuppressed.clear();
  if (!fetchSegments) return;
  try {
    const next = await fetchSegments(videoId);
    if (gen !== fetchGen || currentVideoId !== videoId) return;
    segments = next;
    retryAttempt = 0;
  } catch {
    if (gen !== fetchGen) return;
    segments = [];
    // Mark it retryable rather than silently giving up. Backoff is bounded and capped so a
    // genuinely unreachable API costs a few requests, not a poll loop for the whole session.
    if (retryAttempt < MAX_RETRIES) {
      loadFailed = true;
      retryAttempt++;
      nextRetryAt = Date.now() + 800 * retryAttempt;
    }
  }
}

/** True when the last load failed and enough time has passed to try again. */
function shouldRetryLoad(): boolean {
  return loadFailed && Date.now() >= nextRetryAt;
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
  if (videoId !== currentVideoId || shouldRetryLoad()) {
    void loadForVideo(videoId);
    return;
  }
  if (!segments.length) return;

  const video = findPlayerVideo();
  if (!video || video.paused) return;

  // During an ad the element clock is the ad's, not the video's — nothing may skip.
  if (playerShowingAd()) return;

  const t = video.currentTime;
  // Scrubbing into a segment skips it, same as the official SponsorBlock. An earlier draft
  // tried to detect deliberate scrubs from media-time jumps between ticks; adversarial review
  // killed it with executed repros — background tabs throttle setInterval to once a minute,
  // so every tick read as a 60s scrub and sponsors silently played, and an arrow-key nudge is
  // indistinguishable from a scrub anyway. Undo on the toast is the escape hatch.
  const hit = findSkipSegment(segments, t);
  if (!hit) return;
  if (skipSuppressed.has(hit.UUID ?? `${hit.segment[0]}`)) return;

  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
  let end = hit.segment[1];
  // A segment must not be able to end the video: land just short, so playback continues
  // instead of firing `ended`. Clamp rather than refuse — the old early-return for anything
  // ending near the credits meant outro segments, whose normal shape runs to the very end,
  // never skipped at all even when the category was opted on. The clamped landing point sits
  // inside the segment; the t < end - 0.02 check below keeps that from looping.
  if (duration != null) end = Math.min(end, duration - 0.25);
  if (t < end - 0.02) {
    const from = t;
    try {
      video.currentTime = end;
      showToast(hit, from);
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
