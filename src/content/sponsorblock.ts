// SponsorBlock: skip mid-video sponsor/intro/etc. segments using the public API.
// Segment fetch happens in the service worker (host_permissions); this module only
// finds the playing video, seeks the player, and reacts to YouTube SPA navigations.

import type { Message, YoutubeOptionsData } from '../shared/types.js';
import { MAX_SEGMENT_SHARE, type SponsorSegment } from '../shared/sponsorblock.js';
import { isYoutubeHost } from './youtube-ui.js';

export type { SponsorSegment } from '../shared/sponsorblock.js';
export { SPONSORBLOCK_SKIP_CATEGORIES } from '../shared/sponsorblock.js';

/** Resolves to the video's segments, or null when there was no answer worth trusting. */
export type SegmentFetcher = (videoId: string) => Promise<SponsorSegment[] | null>;

const TOAST_ID = 'quell-sponsorblock-toast';
/** Toast name of each category: its catalog key, and the English used without a catalog. */
const CATEGORY_LABEL: Record<string, [key: string, fallback: string]> = {
  sponsor: ['sponsorblock_toast_cat_sponsor', 'sponsor'],
  selfpromo: ['sponsorblock_toast_cat_selfpromo', 'self-promotion'],
  interaction: ['sponsorblock_toast_cat_interaction', 'interaction reminder'],
  intro: ['sponsorblock_toast_cat_intro', 'intro'],
  outro: ['sponsorblock_toast_cat_outro', 'outro'],
  preview: ['sponsorblock_toast_cat_preview', 'preview'],
  music_offtopic: ['sponsorblock_toast_cat_music_offtopic', 'non-music section'],
};

let active = false;
/** Segments of `loadedVideoId` in the categories of `loadedKey`, as far as they are known. */
let segments: SponsorSegment[] = [];
/** The video the segments belong to, or are being fetched for. */
let loadedVideoId: string | null = null;
/** The category set they were asked for; null when nothing was, so the next sync loads. */
let loadedKey: string | null = null;
let fetchGen = 0;
let tickTimer: number | null = null;
let spaHooked = false;
/** Running in a YouTube player embedded in some other site (see ownsPlayer). */
let embedded = false;
let getOpts: (() => YoutubeOptionsData | null) | null = null;
let fetchSegments: SegmentFetcher = requestSegmentsFromWorker;

/** A catalog string when the locale has one (`$1` filled from `subs`), else the English text. */
function t(key: string, fallback: string, subs: string[] = []): string {
  let text = '';
  try {
    text = chrome.i18n?.getMessage(key, subs) ?? '';
  } catch {
    /* no i18n in this context */
  }
  return text || subs.reduce((s, v, i) => s.replace(`$${i + 1}`, v), fallback);
}

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

/** How an undo remembers a segment: its UUID, or where it sits when the API sent none. */
function segmentKey(s: SponsorSegment): string {
  return s.UUID ?? `${s.category}@${s.segment[0]}-${s.segment[1]}`;
}

export interface SkipLookup {
  /** Seconds before a segment's start that already count, so short segments are not missed. */
  leadIn?: number;
  /** Segments the user undid (by segmentKey). Passed over, not in the way of others. */
  suppressed?: ReadonlySet<string>;
  /** Length of the video; a segment longer than MAX_SEGMENT_SHARE of it is never skipped. */
  duration?: number | null;
}

/** Pick the next skippable segment covering `t` (or starting within a small lead-in). */
export function findSkipSegment(
  segs: SponsorSegment[],
  t: number,
  { leadIn = 0.15, suppressed, duration }: SkipLookup = {},
): SponsorSegment | null {
  let best: SponsorSegment | null = null;
  for (const s of segs) {
    if (s.actionType && s.actionType !== 'skip') continue;
    const [start, end] = s.segment;
    if (!(Number.isFinite(start) && Number.isFinite(end)) || end <= start) continue;
    // Checked here, not on the pick: an undone segment used to win as the earliest cover and
    // then block every segment overlapping it until it ended.
    if (suppressed?.has(segmentKey(s))) continue;
    if (duration != null && duration > 0 && end - start > MAX_SEGMENT_SHARE * duration) continue;
    // Inside the segment, or just before the start (lead-in so we don't miss short ones).
    if (t + leadIn >= start && t < end - 0.05) {
      if (!best || start < best.segment[0]) best = s;
    }
  }
  return best;
}

function isShortsPage(): boolean {
  return /^\/shorts\//.test(location.pathname);
}

/**
 * The player showing the video being watched.
 *
 * On /shorts/ that is #shorts-player. Once the tab has opened a video, the watch page's
 * #movie_player stays in the document there too, paused and hidden (youtube.com, 2026-09), so
 * reading it on Shorts saw a paused video and never skipped. Everywhere else it is
 * #movie_player: the watch page, the miniplayer (YouTube moves that same element into
 * ytd-miniplayer) and /embed/ pages.
 */
function activePlayer(): HTMLElement | null {
  return document.getElementById(isShortsPage() ? 'shorts-player' : 'movie_player');
}

function findPlayerVideo(): HTMLVideoElement | null {
  const player = activePlayer();
  if (player) {
    return (
      player.querySelector<HTMLVideoElement>('video.html5-main-video') ??
      player.querySelector<HTMLVideoElement>('video')
    );
  }
  // On Shorts any other video belongs to a player that is not the one on screen.
  if (isShortsPage()) return null;
  // The hover-preview player (ytd-video-preview) also uses .html5-main-video, and it can
  // precede the real player in document order — a class-first lookup could grab a thumbnail
  // preview and "skip" inside that instead of the video being watched.
  const main = document.querySelector<HTMLVideoElement>('ytd-player video');
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
  const p = activePlayer();
  return !!p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting'));
}

/**
 * The video the player is playing: the one in the URL, or else the miniplayer's.
 *
 * The miniplayer keeps a video playing while the URL moves on to wherever the user browses.
 * YouTube then sets `miniplayer-is-active` on ytd-app and keeps the watch page in the
 * document, hidden, still naming its video (youtube.com, 2026-09). Going by the URL alone
 * dropped the segments there, so the rest of the video played its sponsors.
 */
function playingVideoId(): string | null {
  const fromUrl = extractYoutubeVideoId();
  if (fromUrl) return fromUrl;
  if (!document.querySelector('ytd-app')?.hasAttribute('miniplayer-is-active')) return null;
  const id = document.querySelector('ytd-watch-flexy')?.getAttribute('video-id');
  return id && isVideoId(id) ? id : null;
}

/**
 * Segments the user undid, by segmentKey, for the video in `suppressedFor`. Keyed to the video
 * rather than to a load, so an undo survives a pause, a settings change or the miniplayer, and
 * never carries over to the next video.
 */
const skipSuppressed = new Set<string>();
let suppressedFor: string | null = null;
let toastTimer: number | null = null;

function suppress(videoId: string, key: string): void {
  if (suppressedFor !== videoId) {
    skipSuppressed.clear();
    suppressedFor = videoId;
  }
  skipSuppressed.add(key);
}

const TOAST_SHOWN = {
  opacity: '1',
  visibility: 'visible',
  pointerEvents: 'auto',
  transition: 'opacity 120ms ease',
};
/**
 * Faded AND out of hit-testing and the tab order. At opacity 0 alone the toast stayed
 * clickable: a click on whatever showed through, 72px above the bottom edge, hit its Undo and
 * seeked the video back. visibility flips when the fade has run, delayed by its length.
 */
const TOAST_HIDDEN = {
  opacity: '0',
  visibility: 'hidden',
  pointerEvents: 'none',
  transition: 'opacity 120ms ease, visibility 0s linear 120ms',
};

function hideToast(): void {
  if (toastTimer != null) window.clearTimeout(toastTimer);
  toastTimer = null;
  const el = document.getElementById(TOAST_ID);
  if (el) Object.assign(el.style, TOAST_HIDDEN);
}

/**
 * Toast for a completed skip, with an Undo.
 *
 * A wrong skip was previously unrecoverable — the user had to scrub back by hand and then
 * fight the skip firing again. Undo seeks back and suppresses that segment for the rest of the
 * video, which is the behavior SponsorBlock users expect.
 */
function showToast(hit: SponsorSegment, from: number, videoId: string): void {
  const [labelKey, fallback] = CATEGORY_LABEL[hit.category] ?? ['', hit.category];
  const label = labelKey ? t(labelKey, fallback) : fallback;
  let el = document.getElementById(TOAST_ID) as HTMLDivElement | null;
  if (!el) {
    el = document.createElement('div');
    el.id = TOAST_ID;
    el.setAttribute('data-quell', 'sponsorblock-toast');
    // A skip moves the playhead with no other cue, so screen readers announce it.
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
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
      ...TOAST_HIDDEN,
    });
    // In fullscreen the toast sits inside the player, where a click toggles pause and a double
    // click leaves fullscreen; the page's keyboard shortcuts listen above it too.
    for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup']) {
      el.addEventListener(type, (ev) => ev.stopPropagation());
    }
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
  text.textContent = t('sponsorblock_toast_skipped', 'Skipped $1', [label]);
  const undo = document.createElement('button');
  undo.type = 'button';
  undo.textContent = t('sponsorblock_toast_undo', 'Undo');
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
    hideToast();
    // Bound to the video it was shown for: on the next video the same seek would jump to this
    // one's timestamp.
    if (playingVideoId() !== videoId) return;
    suppress(videoId, segmentKey(hit));
    const video = findPlayerVideo();
    if (video) {
      try {
        video.currentTime = from;
      } catch {
        /* media not ready */
      }
    }
  });
  el.append(text, undo);

  Object.assign(el.style, TOAST_SHOWN);
  if (toastTimer != null) window.clearTimeout(toastTimer);
  // Longer than before: the toast is now something to act on, not just read.
  toastTimer = window.setTimeout(hideToast, 4000);
}

function enabled(opts: YoutubeOptionsData | null): opts is YoutubeOptionsData {
  if (!opts) return false;
  // Skipping seeks the page's player: the repair ladder's script-patch rung stops it too (B32).
  if (opts.paused || opts.allowlisted || opts.scriptletsOff) return false;
  return !!opts.youtubeSponsorBlock;
}

/**
 * Retry state for a segment load that got no answer.
 *
 * A cold service worker losing the race on the first video of a session, a 429 or a timeout
 * all used to come back as an empty list, so the video was "loaded" with nothing to skip for
 * the rest of the page. The fetcher now answers null for those, and the load is retried with
 * backoff. The budget belongs to one load (a video and its categories): a video that used it
 * up does not leave the next one without retries.
 */
let loadFailed = false;
let retryAttempt = 0;
let nextRetryAt = 0;
const MAX_RETRIES = 3;

async function loadForVideo(
  videoId: string,
  key: string,
  cats: readonly string[],
  retry: boolean,
): Promise<void> {
  const gen = ++fetchGen;
  if (!retry) retryAttempt = 0;
  if (videoId !== loadedVideoId) {
    segments = [];
    hideToast();
  } else {
    // The same video with other categories: a category switched off stops skipping now, and
    // the rest keep working until the new answer is in.
    const keep = new Set(cats);
    segments = segments.filter((s) => keep.has(s.category));
  }
  loadedVideoId = videoId;
  loadedKey = key;
  loadFailed = false;
  let next: SponsorSegment[] | null;
  try {
    next = await fetchSegments(videoId);
  } catch {
    next = null;
  }
  if (gen !== fetchGen) return;
  if (next) {
    // The worker reads the categories from storage itself; never skip one the page's options
    // no longer include, whichever of the two saw a change first.
    const keep = new Set(cats);
    segments = next.filter((s) => keep.has(s.category));
    return;
  }
  // Bounded and backed off: an unreachable API costs a few requests, not a poll loop.
  if (retryAttempt < MAX_RETRIES) {
    retryAttempt++;
    loadFailed = true;
    nextRetryAt = Date.now() + 1000 * 2 ** (retryAttempt - 1);
  }
}

/**
 * When the page stopped naming the loaded video. Opening the miniplayer moves the URL off the
 * video a moment before YouTube marks the miniplayer active (youtube.com, 2026-09), so the
 * segments are kept for a second before they count as gone rather than fetched again.
 */
let videoLostAt: number | null = null;
const VIDEO_LOST_GRACE_MS = 1000;

/** Forget the loaded segments (nothing playing, or SponsorBlock off here). */
function drop(): void {
  videoLostAt = null;
  if (loadedVideoId === null && loadedKey === null && !segments.length) return;
  fetchGen++;
  segments = [];
  loadedVideoId = null;
  loadedKey = null;
  loadFailed = false;
}

/**
 * Bring the segments in line with the page: the video playing, the options, the categories.
 * Loads only when one of those changed, or to retry a load that got no answer. Every settings
 * write (another site's switch, a filter edit, dark mode) re-reads the options in every YouTube
 * tab, and a page load does it twice; reloading on each threw the segments away and sent the
 * API the same request three times.
 */
function sync(): void {
  if (!active) return;
  const opts = getOpts?.() ?? null;
  const on = enabled(opts);
  const videoId = on ? playingVideoId() : null;
  if (!on || !videoId) {
    if (on && loadedVideoId !== null) {
      videoLostAt ??= Date.now();
      if (Date.now() - videoLostAt < VIDEO_LOST_GRACE_MS) return;
    }
    drop();
    return;
  }
  videoLostAt = null;
  const cats = opts.sponsorBlockCategories ?? [];
  const key = [...cats].sort().join(',');
  if (!cats.length) {
    // Every category off: nothing to skip, and nothing to ask SponsorBlock. An empty key is a
    // real key here, never "unknown", or the segments of the last category would stay.
    if (loadedVideoId !== videoId || loadedKey !== '') {
      drop();
      loadedVideoId = videoId;
      loadedKey = '';
    }
    return;
  }
  if (videoId !== loadedVideoId || key !== loadedKey) {
    // An embed asks SponsorBlock only once its video plays: an article can carry several
    // players nobody starts, and each would be a request naming a video the user never watched.
    if (embedded && videoId !== loadedVideoId && (findPlayerVideo()?.paused ?? true)) return;
    void loadForVideo(videoId, key, cats, false);
  } else if (loadFailed && Date.now() >= nextRetryAt) {
    void loadForVideo(videoId, key, cats, true);
  }
}

function tick(): void {
  sync();
  const videoId = loadedVideoId;
  if (!active || !videoId || !segments.length) return;

  const video = findPlayerVideo();
  if (!video || video.paused) return;

  // During an ad the element clock is the ad's, not the video's — nothing may skip.
  if (playerShowingAd()) return;

  const t = video.currentTime;
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
  // Scrubbing into a segment skips it, same as the official SponsorBlock. An earlier draft
  // tried to detect deliberate scrubs from media-time jumps between ticks; adversarial review
  // killed it with executed repros — background tabs throttle setInterval to once a minute,
  // so every tick read as a 60s scrub and sponsors silently played, and an arrow-key nudge is
  // indistinguishable from a scrub anyway. Undo on the toast is the escape hatch.
  const hit = findSkipSegment(segments, t, {
    suppressed: suppressedFor === videoId ? skipSuppressed : undefined,
    duration,
  });
  if (!hit) return;

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
      showToast(hit, from, videoId);
    } catch {
      /* seek can throw if media not ready */
    }
  }
}

let unhookSpa: (() => void) | null = null;

function hookSpa(): void {
  if (spaHooked) return;
  spaHooked = true;
  const run = (): void => {
    sync();
  };
  const events = ['yt-navigate-finish', 'yt-navigate-start', 'yt-page-data-updated'];
  for (const e of events) document.addEventListener(e, run, true);
  window.addEventListener('popstate', run);
  unhookSpa = () => {
    for (const e of events) document.removeEventListener(e, run, true);
    window.removeEventListener('popstate', run);
    spaHooked = false;
  };
}

/**
 * Segments from the service worker, which holds the host permission. Null when there is no
 * answer: the worker could not be reached (that rejects), its handler failed, or it reports the
 * lookup `failed` (SponsorBlock slow, rate-limiting or down). A real answer, even an empty one,
 * is a list.
 */
export async function requestSegmentsFromWorker(videoId: string): Promise<SponsorSegment[] | null> {
  const msg: Message = { type: 'sponsorblock:getSegments', videoId };
  const raw: unknown = await chrome.runtime.sendMessage(msg);
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as { segments?: unknown; failed?: unknown };
  if (data.failed === true || !Array.isArray(data.segments)) return null;
  return data.segments as SponsorSegment[];
}

/**
 * Whether this frame runs SponsorBlock. The top frame does, and so does a YouTube /embed/ player
 * on some other site, the only player there: the page around it is not YouTube, so nothing else
 * would skip for it. Frames inside YouTube's own pages do not; the top frame has the player.
 */
function ownsPlayer(): boolean {
  if (window === window.top) return true;
  if (!/^\/embed\//.test(location.pathname)) return false;
  let top: string | null = null;
  try {
    const origins = location.ancestorOrigins;
    const last = origins?.[origins.length - 1];
    if (last && last !== 'null') top = new URL(last).hostname;
  } catch {
    /* unreadable: treat as a foreign page */
  }
  return !top || !isYoutubeHost(top);
}

/** Stand down for good: an updated extension's content script has taken over this page. */
export function stopSponsorBlock(): void {
  active = false;
  drop();
  if (tickTimer != null) window.clearInterval(tickTimer);
  tickTimer = null;
  if (toastTimer != null) window.clearTimeout(toastTimer);
  toastTimer = null;
  unhookSpa?.();
  unhookSpa = null;
  document.getElementById(TOAST_ID)?.remove();
}

/**
 * Start SponsorBlock skipping in the frame that owns the player (see ownsPlayer).
 * Safe to call repeatedly; no-ops elsewhere and off YouTube.
 */
export function startSponsorBlock(options: {
  getOpts: () => YoutubeOptionsData | null;
  fetchSegments?: SegmentFetcher;
}): void {
  if (!isYoutubeHost(location.hostname)) return;
  if (typeof window !== 'undefined' && !ownsPlayer()) return;

  embedded = typeof window !== 'undefined' && window !== window.top;
  getOpts = options.getOpts;
  fetchSegments = options.fetchSegments ?? requestSegmentsFromWorker;
  active = true;
  hookSpa();
  if (tickTimer == null) {
    tickTimer = window.setInterval(tick, 200);
  }
  sync();
}

/**
 * Re-apply after settings change (pause / allowlist / toggle / categories). Only a change that
 * matters here reloads anything (see sync).
 */
export function refreshSponsorBlock(): void {
  sync();
}
