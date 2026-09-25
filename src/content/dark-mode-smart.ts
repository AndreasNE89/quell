// Dark mode orchestration (ISOLATED world, every http/https frame).
// Gating/toggle plumbing; the actual recoloring is the dynamic engine (dark-mode-dynamic.ts),
// which recolors backgrounds/text per element and never touches media.
//
// Frames: the engine runs in EVERY frame (a dark host page with light iframes — or worse,
// a dark shell without recolored text — breaks embeds like Stripe/Disqus/login widgets).
// The service worker resolves darkmode:get against the TOP document's host (sender.tab.url),
// so all frames in a tab follow the top site's setting. Only the top frame paints the opaque
// charcoal canvas; subframes keep transparent backgrounds transparent (overlay iframes must
// not become opaque dark slabs).

import type { DarkModePageData, Message } from '../shared/types.js';
import { isExtensionRestrictedHostname } from '../shared/dark-mode.js';
import { frameScope } from '../shared/frame-scope.js';
import { applyDynamicDark, stopDynamicDark } from './dark-mode-dynamic.js';

let runGeneration = 0;
/** Undoes startDarkModeSmart's listeners (stopDarkModeSmart). */
let unlisten: (() => void) | null = null;

function isTopFrame(): boolean {
  try {
    return window.top === window.self;
  } catch {
    return false;
  }
}

export function startDarkModeSmart(): void {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  if (isExtensionRestrictedHostname(location.hostname)) return;
  const onMessage = (
    msg: Message,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (r: unknown) => void,
  ): true | undefined => {
    if (msg.type !== 'darkmode:refresh') return undefined;
    void run()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  };
  chrome.runtime.onMessage.addListener(onMessage);
  // bfcache: a toggle made while this page sat in the back/forward cache never reached it —
  // re-evaluate when the cached document is shown again.
  const onPageShow = (e: PageTransitionEvent): void => {
    if (e.persisted) void run();
  };
  window.addEventListener('pageshow', onPageShow);
  // A prerendered page decided against the host it reported (B27) and missed every refresh
  // sent while it waited, since the worker only reaches tabs that are shown.
  const onActivated = (): void => void run();
  document.addEventListener('prerenderingchange', onActivated, { once: true });
  unlisten = () => {
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      /* the extension context is gone */
    }
    window.removeEventListener('pageshow', onPageShow);
    document.removeEventListener('prerenderingchange', onActivated);
  };
  void run();
}

/** Stand down for good and undo the recoloring: an updated content script has taken over. */
export function stopDarkModeSmart(): void {
  runGeneration++;
  unlisten?.();
  unlisten = null;
  stopDynamicDark();
}

async function run(): Promise<void> {
  // Each run supersedes older ones so a slow initial run can't apply after a newer toggle.
  const gen = ++runGeneration;
  const host = location.hostname;
  let data: DarkModePageData | null = null;
  try {
    // The worker decides against the tab's page; a prerendered page is not that page yet, so it
    // says which top host it belongs to (B27).
    data = (await send({ type: 'darkmode:get', hostname: host, topHost: frameScope().top })) as
      | DarkModePageData
      | null;
  } catch {
    return;
  }
  if (gen !== runGeneration) return;

  if (!data?.paid || !data.apply) {
    stopDynamicDark();
    // Disarm the registered document_start shell — its :where(:not([data-stampstack-off]))
    // guard stops matching, so the site's OWN html background/color-scheme return exactly
    // (an !important counter-value would stomp them — natively-dark sites went white).
    // Top frame only (registration is top-frame-only). Always set on unpaid/off — including
    // first paint — so a race where the shell still injects (or a paid→unpaid refresh)
    // cannot leave the charcoal canvas stuck without the engine.
    if (isTopFrame()) {
      document.documentElement?.setAttribute('data-stampstack-off', '');
    }
    return;
  }

  document.documentElement?.removeAttribute('data-stampstack-off');
  await waitForBody(2000);
  if (gen !== runGeneration) return;
  applyDynamicDark(isTopFrame());
}

async function waitForBody(maxMs: number): Promise<void> {
  if (document.body) return;
  const start = Date.now();
  while (!document.body && Date.now() - start < maxMs) {
    await sleep(40);
  }
}

function send(msg: Message): Promise<unknown> {
  return chrome.runtime.sendMessage(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
