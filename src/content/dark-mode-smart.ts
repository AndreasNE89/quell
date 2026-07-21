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

import type { DarkModeData, Message } from '../shared/types.js';
import { isExtensionRestrictedHostname } from '../shared/dark-mode.js';
import { applyDynamicDark, stopDynamicDark } from './dark-mode-dynamic.js';

let runGeneration = 0;

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
  chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
    if (msg.type !== 'darkmode:refresh') return;
    void run()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  });
  // bfcache: a toggle made while this page sat in the back/forward cache never reached it —
  // re-evaluate when the cached document is shown again.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) void run();
  });
  void run();
}

async function run(): Promise<void> {
  // Each run supersedes older ones so a slow initial run can't apply after a newer toggle.
  const gen = ++runGeneration;
  const host = location.hostname;
  let data: DarkModeData | null = null;
  try {
    data = (await send({ type: 'darkmode:get', hostname: host })) as DarkModeData | null;
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
