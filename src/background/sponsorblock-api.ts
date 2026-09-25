// SponsorBlock API client (service worker). Uses the privacy-preserving hash prefix
// endpoint so the full video id is not sent in the clear.

import {
  SPONSORBLOCK_SKIP_CATEGORIES,
  MAX_SEGMENT_SHARE,
  type SponsorSegment,
} from '../shared/sponsorblock.js';

const API_BASE = 'https://sponsor.ajay.app/api/skipSegments';
const CACHE_TTL_MS = 60 * 60 * 1000;
/** A community API is allowed to be slow; it is not allowed to hang the feature. */
const REQUEST_TIMEOUT_MS = 6000;
/**
 * Longest segment we will act on, in seconds, whatever the video. The share rule
 * (MAX_SEGMENT_SHARE) needs the segment's videoDuration, which older submissions report as 0;
 * this bounds those. Rejecting here keeps bad data out of the cache and the page payload.
 */
const MAX_SEGMENT_SECONDS = 3600;
const CACHE_MAX = 200;

interface CacheEntry {
  at: number;
  segments: SponsorSegment[];
}

const cache = new Map<string, CacheEntry>();

/**
 * The answer to a segment lookup. `ok: false` is "no answer" (timeout, network error, 429/5xx,
 * unreadable body): never cached, so the page retries it. An `ok` empty list is a real answer (a
 * 404, or a bucket without this video) and is cached like any other.
 */
export type SegmentLookup = { ok: true; segments: SponsorSegment[] } | { ok: false };

/**
 * Requests on the wire, by cache key. Tabs and embeds showing the same video ask at once, and
 * until the first answer was cached each of them was a request of its own (three per page load
 * in 2.2.2) to a volunteer-run API that rate-limits.
 */
const inFlight = new Map<string, Promise<SegmentLookup>>();

/** SHA-256 hex of videoId, first 4 chars (SponsorBlock privacy prefix). */
export async function videoIdHashPrefix(videoId: string): Promise<string> {
  const data = new TextEncoder().encode(videoId);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.slice(0, 4);
}

function pruneCache(): void {
  if (cache.size <= CACHE_MAX) return;
  const entries = [...cache.entries()].sort((a, b) => a[1].at - b[1].at);
  const drop = entries.length - CACHE_MAX;
  for (let i = 0; i < drop; i++) cache.delete(entries[i][0]);
}

export function normalizeSegments(raw: unknown): SponsorSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: SponsorSegment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const seg = o.segment;
    if (!Array.isArray(seg) || seg.length < 2) continue;
    const start = Number(seg[0]);
    const end = Number(seg[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (start < 0 || end - start > MAX_SEGMENT_SECONDS) continue;
    // The duration the submitter saw; 0 when the submission predates the field.
    const videoDuration = Number(o.videoDuration);
    if (videoDuration > 0 && end - start > MAX_SEGMENT_SHARE * videoDuration) continue;
    const category = typeof o.category === 'string' ? o.category : 'sponsor';
    const actionType = typeof o.actionType === 'string' ? o.actionType : 'skip';
    if (actionType !== 'skip') continue;
    out.push({
      category,
      actionType,
      segment: [start, end],
      UUID: typeof o.UUID === 'string' ? o.UUID : undefined,
    });
  }
  // Prefer earlier segments first for stable findSkipSegment.
  out.sort((a, b) => a.segment[0] - b.segment[0]);
  return out;
}

/**
 * Build the skipSegments URL. Categories/actionTypes must keep unencoded `[` `]` `"`
 * — Cloudflare on sponsor.ajay.app rejects fully URL-encoded JSON arrays.
 */
export function buildSkipSegmentsUrl(hashPrefix: string, categories: readonly string[]): string {
  const cats = JSON.stringify([...categories]);
  const actions = JSON.stringify(['skip']);
  return `${API_BASE}/${hashPrefix}?categories=${cats}&actionTypes=${actions}`;
}

interface HashBucket {
  videoID?: string;
  segments?: unknown;
}

function remember(cacheKey: string, segments: SponsorSegment[]): SegmentLookup {
  cache.set(cacheKey, { at: Date.now(), segments });
  pruneCache();
  return { ok: true, segments };
}

async function requestSegments(
  videoId: string,
  categories: readonly string[],
  cacheKey: string,
): Promise<SegmentLookup> {
  const prefix = await videoIdHashPrefix(videoId);
  const url = buildSkipSegmentsUrl(prefix, categories);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      // SW fetch: host_permissions cover sponsor.ajay.app; no CORS dance needed.
      credentials: 'omit',
      cache: 'no-store',
      // Without this a stalled socket leaves the promise pending forever, and the content
      // script awaits it — so one hung connection silently disabled skipping for that video
      // with no error to retry on. Chrome 120+ has AbortSignal.timeout.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false };
  }

  // 404 = no segments known for this hash bucket / video.
  if (res.status === 404) return remember(cacheKey, []);
  // 429 and 5xx above all: an answer that says nothing about the video.
  if (!res.ok) return { ok: false };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false };
  }
  // Hash endpoint returns [{ videoID, segments: [...] }, ...]
  if (!Array.isArray(body)) return { ok: false };
  const bucket = (body as HashBucket[]).find((b) => b && b.videoID === videoId);
  return remember(cacheKey, bucket ? normalizeSegments(bucket.segments) : []);
}

/**
 * Look up skippable segments for a video id (cached, one request in flight per video and
 * category set).
 *
 * `categories` narrows the request to what the user actually wants skipped, so a user who only
 * wants sponsors does not download intro/outro data — less to send, less to parse, and the
 * request itself discloses less about what we do with the answer.
 */
export async function lookupSponsorSegments(
  videoId: string,
  categories: readonly string[] = SPONSORBLOCK_SKIP_CATEGORIES,
): Promise<SegmentLookup> {
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return { ok: true, segments: [] };
  // Nothing enabled: never contact the API at all. An empty category list would also be a 400.
  if (!categories.length) return { ok: true, segments: [] };

  // Cache is keyed by video AND category set — a narrower earlier request must not be served
  // back to a later, wider one.
  const cacheKey = `${videoId}|${[...categories].sort().join(',')}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ok: true, segments: hit.segments };

  let pending = inFlight.get(cacheKey);
  if (!pending) {
    pending = requestSegments(videoId, categories, cacheKey).finally(() => {
      inFlight.delete(cacheKey);
    });
    inFlight.set(cacheKey, pending);
  }
  const result = await pending;
  // An expired entry is still a real answer, and better than none while the API is down.
  if (!result.ok && hit) return { ok: true, segments: hit.segments };
  return result;
}
