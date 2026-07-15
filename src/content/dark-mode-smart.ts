// Dark mode orchestration (ISOLATED, top frame).
// Gating/toggle plumbing; the actual recoloring is the dynamic engine (dark-mode-dynamic.ts),
// which recolors backgrounds/text per element and never touches media.

import type { DarkModeData, Message } from '../shared/types.js';
import { isExtensionRestrictedHostname } from '../shared/dark-mode.js';
import { applyDynamicDark, stopDynamicDark } from './dark-mode-dynamic.js';

const STYLE_RESET = 'dark-reset';
let runGeneration = 0;

export function startDarkModeSmart(): void {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  // Top frame only: subframes are recolored by their own content-script instance if the engine
  // decides to run there; per-site gating/persistence is driven by the top document.
  if (window.top !== window.self) return;
  if (isExtensionRestrictedHostname(location.hostname)) return;
  chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
    if (msg.type !== 'darkmode:refresh') return;
    void run()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
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
    // Not applying (unpaid / global off / per-site off): stop the engine and cancel the
    // registered FOUC dark shell on this already-loaded tab.
    stopDynamicDark();
    injectStyle(STYLE_RESET, RESET_CSS);
    return;
  }

  removeStyle(STYLE_RESET);
  await waitForBody(2000);
  if (gen !== runGeneration) return;
  applyDynamicDark();
}

// Cancels the registered document_start dark shell (dark-mode.css) for a tab that's toggling off.
const RESET_CSS = `html { background-color: transparent !important; color-scheme: revert !important; }`;

async function waitForBody(maxMs: number): Promise<void> {
  if (document.body) return;
  const start = Date.now();
  while (!document.body && Date.now() - start < maxMs) {
    await sleep(40);
  }
}

function injectStyle(kind: string, css: string): void {
  const root = document.head || document.documentElement;
  if (!root) return;
  let el = document.querySelector(`style[data-stampstack="${kind}"]`) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.setAttribute('data-stampstack', kind);
    root.appendChild(el);
  }
  el.textContent = css;
}

function removeStyle(kind: string): void {
  document.querySelector(`style[data-stampstack="${kind}"]`)?.remove();
}

function send(msg: Message): Promise<unknown> {
  return chrome.runtime.sendMessage(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
