// StampStack content script (ISOLATED world, document_start).
//
// Generic element-hiding arrives as a browser-injected stylesheet (registered by the
// service worker, allowlist-aware). This script handles site-specific hide selectors and
// procedural cosmetic filters. List scriptlets are registered MAIN-world content scripts; this
// script only reports the frame to the SW, which fills in the frames those cannot serve.

import type {
  Message,
  CosmeticResponse,
  ScriptletsResponse,
  YoutubeOptionsData,
  Settings,
} from '../shared/types.js';
import { STORAGE_KEY } from '../shared/constants.js';
import { injectSpecificCss } from './specific-css.js';
import { ProceduralRunner, type ProceduralRuleInput } from './procedural-runner.js';
import {
  applyYoutubeFeatures,
  watchYoutubeSpa,
  youtubeOptsFromSettings,
  isYoutubeHost,
  stopYoutubeFeatures,
} from './youtube-ui.js';
import { refreshSponsorBlock, startSponsorBlock, stopSponsorBlock } from './sponsorblock.js';
import type { SponsorSegment } from '../shared/sponsorblock.js';
import { startDarkModeSmart, stopDarkModeSmart } from './dark-mode-smart.js';
import { frameScope } from '../shared/frame-scope.js';

/** Marks this extension context's copy in the frame (content scripts share one world per context). */
const INSTANCE_KEY = '__stampstackContent';
/** Sent by a copy that starts, so a copy left behind by an update stands down. */
const TAKEOVER_EVENT = 'stampstack:takeover';

/** Undo everything this copy put on the page (orphanTeardown). */
const teardowns: (() => void)[] = [];

/** Cut off from the worker: the extension was updated, reloaded or removed since this copy ran. */
function orphaned(): boolean {
  try {
    return !chrome.runtime?.id;
  } catch {
    return true;
  }
}

function orphanTeardown(): void {
  for (const undo of teardowns.splice(0)) {
    try {
      undo();
    } catch {
      /* keep undoing the rest */
    }
  }
}

/**
 * One live copy per frame (REVIEW_2026-09-24 M2). After an install or update the worker runs
 * content.js again in every open tab, so a frame can hold two copies:
 *   - the manifest's and the worker's, both of this version, when a page loaded just then. They
 *     share an isolated world, so the second sees the first's marker and does not start;
 *   - the old version's and the new one's. An update gives the new copy a world of its own
 *     (checked in Chromium 131), and the old one, whose chrome.runtime.id is gone, can no longer
 *     reach the worker but still holds its sheets, observers and timers. The new copy announces
 *     itself with a DOM event, which crosses worlds, and the old one takes all of it down. A page
 *     can send the same event, so a copy only acts on it when it is itself orphaned.
 */
function claimFrame(): boolean {
  const g = globalThis as { [INSTANCE_KEY]?: boolean };
  if (g[INSTANCE_KEY]) return false;
  g[INSTANCE_KEY] = true;
  document.dispatchEvent(new CustomEvent(TAKEOVER_EVENT));
  const onTakeover = (): void => {
    if (orphaned()) orphanTeardown();
  };
  document.addEventListener(TAKEOVER_EVENT, onTakeover);
  teardowns.push(() => document.removeEventListener(TAKEOVER_EVENT, onTakeover));
  return true;
}

let youtubeOpts: YoutubeOptionsData | null = null;

function onYoutubeStorageChanged(host: string): void {
  try {
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
      if (area !== 'local' || !changes[STORAGE_KEY]) return;
      void refreshYoutubeOpts(host);
    };
    chrome.storage.onChanged.addListener(onChanged);
    teardowns.push(() => chrome.storage.onChanged.removeListener(onChanged));
  } catch {
    /* storage closed to content scripts: youtube:refresh from the worker covers it */
  }
}

async function refreshYoutubeOpts(host: string): Promise<void> {
  try {
    const raw = await send({ type: 'youtube:getOptions', hostname: host, topHost: frameScope().top });
    youtubeOpts = raw as YoutubeOptionsData | null;
    if (youtubeOpts) applyYoutubeFeatures(youtubeOpts);
    refreshSponsorBlock();
  } catch {
    /* SW may be asleep; storage bootstrap already applied */
  }
}

async function fetchSponsorSegments(videoId: string): Promise<SponsorSegment[]> {
  try {
    const raw = await send({ type: 'sponsorblock:getSegments', videoId });
    const data = raw as { segments?: SponsorSegment[] } | null;
    return Array.isArray(data?.segments) ? data.segments : [];
  } catch {
    return [];
  }
}

/**
 * Host of the page this frame belongs to, for the storage fast path below. The service worker
 * decides the same way from the tab: a YouTube embed follows the site it is embedded in.
 */
function pageHost(): string {
  if (window === window.top) return location.hostname;
  try {
    const origins = location.ancestorOrigins;
    const top = origins?.[origins.length - 1];
    if (top && top !== 'null') return new URL(top).hostname;
  } catch {
    /* opaque or unavailable: fall back to this frame */
  }
  return location.hostname;
}

/** Shorts redirect + hide must start before cosmetic:get (can take hundreds of ms). */
function bootstrapYoutube(host: string): void {
  if (!isYoutubeHost(host)) return;
  watchYoutubeSpa(() => youtubeOpts);
  startSponsorBlock({
    getOpts: () => youtubeOpts,
    fetchSegments: fetchSponsorSegments,
  });
  teardowns.push(stopYoutubeFeatures, stopSponsorBlock);
  onYoutubeStorageChanged(host);
  try {
    void chrome.storage.local
      .get(STORAGE_KEY)
      .then((stored) => {
        const partial = stored[STORAGE_KEY] as Partial<Settings> | undefined;
        if (!partial) return;
        youtubeOpts = youtubeOptsFromSettings(partial, pageHost());
        applyYoutubeFeatures(youtubeOpts);
        refreshSponsorBlock();
      })
      .catch(() => {});
  } catch {
    /* storage closed to content scripts: youtube:getOptions below answers instead */
  }
  void refreshYoutubeOpts(host);
}

async function start(): Promise<void> {
  const host = location.hostname;
  // The manifest's copy runs while the document is still loading; the worker's, after an update,
  // into a page that may still hold sheets the previous version's worker inserted.
  const late = document.readyState !== 'loading';

  bootstrapYoutube(host);

  // Before any await: the popup can be opened while the cosmetic round-trip is still in
  // flight, and a listener registered later would make the report read "reload the page".
  startPageReport();

  // List scriptlets already ran at document_start where the registered scripts serve this
  // frame. The SW injects them here when they cannot: a frame on another host than the top
  // page, which follows that page's switch, or a registration that is missing. Sent before
  // waiting on cosmetics, with the same SW-wake retry, since this path is late by nature.
  const scope = frameScope();
  const scriptletsP = scope.host
    ? sendWithRetry<ScriptletsResponse>({
        type: 'scriptlets:get',
        hostname: scope.host,
        topHost: scope.top,
        registered: scope.registered,
      })
    : Promise.resolve(null);

  // A back/forward-cache restore brings back a document that missed every cosmetic:refresh sent
  // while it was cached (an allowlist change, a repair step, an edited filter).
  const onPageShow = (e: PageTransitionEvent): void => {
    if (e.persisted) void reapplyCosmetics();
  };
  window.addEventListener('pageshow', onPageShow);
  // So does a prerendered page when it is shown: the worker's refreshes reach only tabs on
  // screen, and until now it was matched against the top host it reported (B27).
  const onActivated = (): void => {
    void reapplyCosmetics();
    if (isYoutubeHost(host)) void refreshYoutubeOpts(host);
  };
  document.addEventListener('prerenderingchange', onActivated, { once: true });
  teardowns.push(() => {
    window.removeEventListener('pageshow', onPageShow);
    document.removeEventListener('prerenderingchange', onActivated);
  });

  const resp = await fetchCosmetics(late);
  if (resp && !orphaned()) applyCosmetics(resp);

  await scriptletsP.catch(() => {});
}

async function sendWithRetry<T>(msg: Message, attempts = 5): Promise<T | null> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = (await send(msg)) as T | null;
      if (resp) return resp;
    } catch (e) {
      lastErr = e;
    }
    await sleep(50 * (i + 1));
  }
  if (lastErr) console.warn('[StampStack] sendMessage failed after retries', msg.type, lastErr);
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function send(msg: Message): Promise<unknown> {
  return chrome.runtime.sendMessage(msg);
}

// ---------------------------------------------------------------------------
// Cosmetics
// ---------------------------------------------------------------------------

let runner: ProceduralRunner | null = null;
/** The specific hide selectors now in the sheet, for the page report's count. */
let currentHide: string[] = [];

teardowns.push(() => {
  runner?.stop();
  runner = null;
  currentHide = [];
  injectSpecificCss([], []);
});

/**
 * Ask for this frame's cosmetics. about:blank, srcdoc and document.write frames have no host of
 * their own: they are the page that made them (its origin), so they get that page's rules —
 * friendly-iframe ads are written into exactly such frames. `refetch` tells the worker the
 * document may already hold sheets it inserted, in case it has slept since and forgotten them.
 */
function fetchCosmetics(refetch: boolean): Promise<CosmeticResponse | null> {
  const scope = frameScope();
  return sendWithRetry<CosmeticResponse>({
    type: 'cosmetic:get',
    hostname: scope.host || location.hostname,
    topHost: scope.top,
    isTop: scope.isTop,
    ...(refetch ? { refetch: true } : {}),
  });
}

function applyCosmetics(resp: CosmeticResponse): void {
  if (resp.allowlisted) {
    currentHide = [];
    injectSpecificCss([], []);
    runner?.stop();
    return;
  }
  currentHide = Array.isArray(resp.hide) ? resp.hide : [];
  injectSpecificCss(currentHide, Array.isArray(resp.unhide) ? resp.unhide : []);

  const rules: ProceduralRuleInput[] = [];
  for (const p of resp.procedural ?? []) rules.push(p);
  for (const a of resp.actions ?? []) {
    if (a && typeof a.selector === 'string') rules.push({ expr: a.selector, action: a.action, arg: a.arg });
  }
  if (!rules.length && !runner) return;
  runner ??= new ProceduralRunner();
  runner.setRules(rules);
  runner.start();
}

/** Re-fetch and re-apply cosmetics for this page (after the user's filters or site switches change). */
async function reapplyCosmetics(): Promise<void> {
  if (orphaned()) return;
  const resp = await fetchCosmetics(true);
  // No answer (worker restarting, handler error) is not "nothing to hide": keep what is applied.
  // Only an explicit allowlisted answer clears it.
  if (resp && !orphaned()) applyCosmetics(resp);
}

// ---------------------------------------------------------------------------
// Page report
// ---------------------------------------------------------------------------
// Chrome only exposes per-request match events to unpacked builds, so a store build can never
// count blocked requests. What it CAN do honestly is observe the page: which third-party hosts
// this document reached for, and how many elements our own rules hid. The service worker turns
// the host list into recognizable names; nothing here claims a request was blocked.

/** Third-party hosts this document referenced. Bounded so a busy SPA can't grow it forever. */
const seenHosts = new Set<string>();
const MAX_SEEN_HOSTS = 400;
/** Counting stops here: past it the number is a floor, and the popup must stay responsive. */
const MAX_COUNTED = 5000;

function noteUrl(raw: string | null | undefined): void {
  if (!raw || seenHosts.size >= MAX_SEEN_HOSTS) return;
  // Skip inline/blob/data references — they never leave the browser.
  if (/^(data|blob|javascript|about|mailto|tel|#):?/i.test(raw)) return;
  try {
    const u = new URL(raw, location.href);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    if (u.hostname === location.hostname) return; // first party
    seenHosts.add(u.hostname.toLowerCase());
  } catch {
    /* relative junk / malformed */
  }
}

/** Scan the DOM's outbound references plus anything Resource Timing already recorded. */
function collectPageHosts(): void {
  for (const el of document.querySelectorAll('script[src],iframe[src],img[src],link[href]')) {
    noteUrl(el.getAttribute('src') ?? el.getAttribute('href'));
  }
  try {
    // Catches dynamically-created requests the DOM scan cannot see. Cross-origin entries are
    // visible here by name even without Timing-Allow-Origin, which is all we need.
    for (const e of performance.getEntriesByType('resource')) noteUrl(e.name);
  } catch {
    /* Resource Timing unavailable */
  }
}

/**
 * Ad slots our site-specific and procedural rules hide right now: distinct elements that really
 * compute to display:none (a page `!important` can win), counted once per slot (a hidden
 * container's hidden child is the same slot), plus elements `:remove()` took out. Computed when
 * asked, so it follows SPA updates and refreshes. Generic hides are not counted: their selectors
 * live in the browser-injected sheet, which this script cannot read.
 */
function countHidden(): number {
  const found = new Set<Element>();
  const consider = (el: Element): void => {
    if (found.size >= MAX_COUNTED || found.has(el)) return;
    try {
      if (getComputedStyle(el).display === 'none') found.add(el);
    } catch {
      /* detached or exotic node */
    }
  };
  const fromRunner = runner?.hiddenElements();
  for (const sel of [...currentHide, ...(fromRunner?.plainSelectors ?? [])]) {
    try {
      for (const el of Array.from(document.querySelectorAll(sel))) consider(el);
    } catch {
      /* selector the sheet dropped as invalid */
    }
  }
  for (const el of fromRunner?.elements ?? []) consider(el);
  let slots = 0;
  for (const el of found) {
    let nested = false;
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (found.has(p)) {
        nested = true;
        break;
      }
    }
    if (!nested) slots++;
  }
  return slots + (fromRunner?.removed ?? 0);
}

function startPageReport(): void {
  collectPageHosts();
  // Re-scan a few times over the first seconds: most trackers are injected after load.
  let scans = 0;
  const timer = setInterval(() => {
    collectPageHosts();
    if (++scans >= 6) clearInterval(timer);
  }, 1500);
  teardowns.push(() => clearInterval(timer));

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const type = (msg as { type?: string })?.type;
    if (type === 'page:collect') {
      collectPageHosts();
      sendResponse({
        hosts: [...seenHosts],
        hiddenCount: countHidden(),
        truncated: seenHosts.size >= MAX_SEEN_HOSTS,
      });
      return undefined;
    }
    if (type === 'cosmetic:refresh') {
      // The user added or edited their own filters: re-apply without a reload, so a pick that
      // hid something stays hidden and an edit takes effect immediately.
      void reapplyCosmetics();
      sendResponse({ ok: true });
      return undefined;
    }
    if (type === 'youtube:refresh') {
      if (isYoutubeHost(location.hostname)) void refreshYoutubeOpts(location.hostname);
      sendResponse({ ok: true });
      return undefined;
    }
    return undefined;
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
// Last, after every module-level declaration above: start() reaches the page report's state
// (seenHosts) synchronously. At document_start the DOM is still empty, but the copy the worker
// injects into a loaded tab after an update (M2) scans a full one at once, and would stop at the
// first <img src> before asking for cosmetics.

const webPage = location.protocol === 'http:' || location.protocol === 'https:';
if ((webPage || location.protocol === 'about:') && claimFrame()) {
  void start();
  // Paid dark mode: already-dark detect + smart CSS (independent of pause/allowlist).
  if (webPage) {
    startDarkModeSmart();
    teardowns.push(stopDarkModeSmart);
  }
}
