// StampStack content script (ISOLATED world, document_start).
//
// Generic element-hiding arrives as a browser-injected stylesheet (registered by the
// service worker, allowlist-aware). This script handles site-specific hide selectors,
// procedural cosmetic filters, and asks the SW to inject list-scoped MAIN scriptlets.

import type {
  Message,
  CosmeticResponse,
  ScriptletsResponse,
  YoutubeOptionsData,
  Settings,
} from '../shared/types.js';
import { STORAGE_KEY } from '../shared/constants.js';
import { queryProcedural } from '../engine/procedural.js';
import {
  applyYoutubeFeatures,
  watchYoutubeSpa,
  youtubeOptsFromSettings,
  isYoutubeHost,
} from './youtube-ui.js';
import { refreshSponsorBlock, startSponsorBlock } from './sponsorblock.js';
import type { SponsorSegment } from '../shared/sponsorblock.js';
import { startDarkModeSmart } from './dark-mode-smart.js';

if (location.protocol === 'http:' || location.protocol === 'https:' || location.protocol === 'about:') {
  void start();
}

// Paid dark mode: already-dark detect + smart CSS (independent of pause/allowlist).
if (location.protocol === 'http:' || location.protocol === 'https:') {
  startDarkModeSmart();
}

let youtubeOpts: YoutubeOptionsData | null = null;

function onYoutubeStorageChanged(host: string): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEY]) return;
    void refreshYoutubeOpts(host);
  });
}

async function refreshYoutubeOpts(host: string): Promise<void> {
  try {
    const raw = await send({ type: 'youtube:getOptions', hostname: host });
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

/** Shorts redirect + hide must start before cosmetic:get (can take hundreds of ms). */
function bootstrapYoutube(host: string): void {
  if (!isYoutubeHost(host)) return;
  watchYoutubeSpa(() => youtubeOpts);
  startSponsorBlock({
    getOpts: () => youtubeOpts,
    fetchSegments: fetchSponsorSegments,
  });
  onYoutubeStorageChanged(host);
  void chrome.storage.local.get(STORAGE_KEY).then((stored) => {
    const partial = stored[STORAGE_KEY] as Partial<Settings> | undefined;
    if (!partial) return;
    youtubeOpts = youtubeOptsFromSettings(partial, host);
    applyYoutubeFeatures(youtubeOpts);
    refreshSponsorBlock();
  });
  void refreshYoutubeOpts(host);
}

async function start(): Promise<void> {
  const host = location.hostname;

  bootstrapYoutube(host);

  // Before any await: the popup can be opened while the cosmetic round-trip is still in
  // flight, and a listener registered later would make the report read "reload the page".
  startPageReport();

  // Kick scriptlets immediately — do not wait on cosmetics. YouTube/player
  // pages need MAIN-world hooks as early as the SW round-trip allows. Use the same
  // SW-wake retry as cosmetics: a bare send() that races SW cold-start would otherwise
  // silently drop scriptlets (anti-adblock defusers) for that page load with no retry.
  const scriptletsP = sendWithRetry<ScriptletsResponse>({
    type: 'scriptlets:get',
    hostname: host,
  }).then((s) => {
    if (!s || s.allowlisted || !s.scriptlets.length) return;
    return send({ type: 'scriptlets:inject', scriptlets: s.scriptlets });
  });

  const ytOptsP = refreshYoutubeOpts(host);

  const resp = await sendWithRetry<CosmeticResponse>({ type: 'cosmetic:get', hostname: host });
  const allowlisted = !!resp?.allowlisted;

  if (!allowlisted && resp) {
    injectSpecificCss(resp.hide, resp.unhide);
    // After injection so the count reflects the selectors that actually shipped. Deferred to
    // DOMContentLoaded because at document_start almost nothing exists to match yet.
    const countHides = (): void => countSpecificHides(resp.hide);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', countHides, { once: true });
    } else {
      countHides();
    }
    if (resp.procedural.length) {
      const exprs = resp.procedural.map((p) => p.expr);
      // attributes:true wakes the observer on every class/style change page-wide; only
      // the attribute/style-sensitive ops actually need it, so scope it to those.
      const watchAttributes = exprs.some((e) => /:(?:watch-attr|matches-attr|matches-css)/.test(e));
      runProcedural(exprs);
      observe(() => runProcedural(exprs), watchAttributes);
    }
  }

  await Promise.all([scriptletsP.catch(() => {}), ytOptsP.catch(() => {})]);
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

/** Is `sel` a syntactically valid CSS selector? Guards against CSS breakout. */
function isValidSelector(sel: string): boolean {
  try {
    document.createDocumentFragment().querySelector(sel);
    return true;
  } catch {
    return false;
  }
}

/** Insert a <style> with the hostname-specific hide selectors (+ unhide overrides). */
function injectSpecificCss(hide: string[], unhide: string[]): void {
  const safeHide = hide.filter(isValidSelector);
  const safeUnhide = unhide.filter(isValidSelector);
  if (!safeHide.length && !safeUnhide.length) return;
  let css = '';
  if (safeHide.length) css += `${safeHide.join(',\n')} { display: none !important; }\n`;
  if (safeUnhide.length) css += `${safeUnhide.join(',\n')} { display: revert !important; }\n`;

  // Replace rather than stack: reapplyCosmetics can run many times per page as the user edits
  // their filters, and appending a sheet each time would leave stale hides in force forever.
  const existing = document.querySelector('style[data-StampStack="cosmetic"]');
  const style = existing instanceof HTMLStyleElement ? existing : document.createElement('style');
  style.setAttribute('data-StampStack', 'cosmetic');
  style.textContent = css;
  if (!existing) (document.head || document.documentElement).appendChild(style);
}

/** Re-fetch and re-apply cosmetics for this page (used after the user's filters change). */
async function reapplyCosmetics(): Promise<void> {
  const resp = await sendWithRetry<CosmeticResponse>({
    type: 'cosmetic:get',
    hostname: location.hostname,
  });
  if (!resp || resp.allowlisted) return;
  injectSpecificCss(resp.hide, resp.unhide);
}

const hidden = new WeakSet<Element>();

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
let hiddenCount = 0;

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

function startPageReport(): void {
  collectPageHosts();
  // Re-scan a few times over the first seconds: most trackers are injected after load.
  let scans = 0;
  const timer = setInterval(() => {
    collectPageHosts();
    if (++scans >= 6) clearInterval(timer);
  }, 1500);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const type = (msg as { type?: string })?.type;
    if (type === 'page:collect') {
      collectPageHosts();
      sendResponse({
        hosts: [...seenHosts],
        hiddenCount,
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
    return undefined;
  });
}

/** Count what the site-specific stylesheet actually matched, for the page report. */
function countSpecificHides(selectors: string[]): void {
  for (const sel of selectors) {
    try {
      hiddenCount += document.querySelectorAll(sel).length;
    } catch {
      /* invalid selector — already filtered, but never let counting throw */
    }
  }
}

function runProcedural(exprs: string[]): void {
  for (const expr of exprs) {
    let els: Element[];
    try {
      els = queryProcedural(expr);
    } catch {
      continue;
    }
    for (const el of els) {
      if (hidden.has(el)) continue;
      hidden.add(el);
      hiddenCount++;
      // `:remove()` ops already detach nodes; others get display:none.
      if (el.isConnected) {
        (el as HTMLElement).style?.setProperty?.('display', 'none', 'important');
      }
    }
  }
}

/** Re-run procedural matching as the page mutates, throttled to once per frame. */
function observe(run: () => void, watchAttributes: boolean): void {
  let scheduled = false;
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      run();
    });
  };
  const obs = new MutationObserver(schedule);
  const attach = (): void =>
    obs.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: watchAttributes,
    });
  if (document.documentElement) attach();
  else document.addEventListener('DOMContentLoaded', attach, { once: true });
  document.addEventListener('DOMContentLoaded', run, { once: true });
}
