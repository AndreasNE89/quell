// Dark mode orchestration (ISOLATED world, every frame content.ts starts it in).
// Gating/toggle plumbing; the actual recoloring is the dynamic engine (dark-mode-dynamic.ts),
// which recolors backgrounds/text per element and leaves media alone.
//
// Frames: the engine runs in EVERY frame (a dark host page with light iframes — or worse,
// a dark shell without recolored text — breaks embeds like Stripe/Disqus/login widgets). The
// gate below also admits about:blank, srcdoc and blob: frames, whose text would otherwise be
// dark on the darkened host; content.ts decides which frames start it. The service worker
// resolves darkmode:get against the TOP document's host, so all frames in a tab follow the
// top site's setting (a prerendered page reports its own top host, B27). Only the top frame
// paints the opaque charcoal canvas; subframes keep transparent backgrounds transparent, and
// every frame declares color-scheme: dark so Chromium does not paint an opaque light canvas
// behind a transparent embed (B64).

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

const DARK_PROTOCOLS = new Set(['http:', 'https:', 'about:', 'blob:']);

export function startDarkModeSmart(): void {
  if (!DARK_PROTOCOLS.has(location.protocol)) return;
  // about:blank / srcdoc / blob: frames have no host of their own; they carry their creator's.
  if (isExtensionRestrictedHostname(frameScope().host)) return;
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
  const scope = frameScope();
  let data: DarkModePageData | null = null;
  try {
    // The worker decides against the tab's page; a prerendered page is not that page yet, so it
    // says which top host it belongs to (B27).
    data = (await send({ type: 'darkmode:get', hostname: scope.host, topHost: scope.top })) as
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

  // The engine re-arms the registered shell itself (it removes data-stampstack-off), and keeps
  // it disarmed on a natively dark page; clearing it here would repaint that page's canvas.
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
