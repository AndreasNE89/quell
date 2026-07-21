// SponsorBlock API client (service worker). Uses the privacy-preserving hash prefix
// endpoint so the full video id is not sent in the clear.

import { SPONSORBLOCK_SKIP_CATEGORIES, type SponsorSegment } from '../shared/sponsorblock.js';

const API_BASE = 'https://sponsor.ajay.app/api/skipSegments';
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 200;

interface CacheEntry {
  at: number;
  segments: SponsorSegment[];
}

const cache = new Map<string, CacheEntry>();

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

function normalizeSegments(raw: unknown): SponsorSegment[] {
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

/** Fetch skippable segments for a video id (cached). */
export async function fetchSponsorSegments(videoId: string): Promise<SponsorSegment[]> {
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return [];

  const hit = cache.get(videoId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.segments;

  const prefix = await videoIdHashPrefix(videoId);
  const url = buildSkipSegmentsUrl(prefix, SPONSORBLOCK_SKIP_CATEGORIES);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      // SW fetch: host_permissions cover sponsor.ajay.app; no CORS dance needed.
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    return hit?.segments ?? [];
  }

  // 404 = no segments known for this hash bucket / video.
  if (res.status === 404) {
    cache.set(videoId, { at: Date.now(), segments: [] });
    pruneCache();
    return [];
  }
  if (!res.ok) return hit?.segments ?? [];

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return hit?.segments ?? [];
  }

  // Hash endpoint returns [{ videoID, segments: [...] }, ...]
  let segments: SponsorSegment[] = [];
  if (Array.isArray(body)) {
    const bucket = (body as HashBucket[]).find((b) => b && b.videoID === videoId);
    if (bucket) segments = normalizeSegments(bucket.segments);
  }

  cache.set(videoId, { at: Date.now(), segments });
  pruneCache();
  return segments;
}
