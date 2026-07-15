// Smart dark mode (ISOLATED): detect already-dark pages, upgrade invert → tuned CSS.
// Runs on http(s) only; license/apply gating via darkmode:get.

import type { DarkModeData, Message } from '../shared/types.js';
import {
  buildDarkResetCss,
  buildSmartDarkCss,
  isConfidentlyAlreadyDark,
  luminanceOfCssColor,
  type DarkPageSignals,
} from '../shared/dark-mode-smart.js';
import { isExtensionRestrictedHostname } from '../shared/dark-mode.js';

const STYLE_SMART = 'dark-smart';
const STYLE_RESET = 'dark-reset';

export function startDarkModeSmart(): void {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  // Top frame only. In a subframe, location.hostname is the iframe's host; a dark-themed
  // cross-origin embed (YouTube/Vimeo/Disqus/CodePen) would sample dark and auto-skip —
  // persisting a force-off for its OWN host — silently disabling dark mode when that host
  // is later opened directly. Detection/persistence must be driven by the top document.
  if (window.top !== window.self) return;
  if (isExtensionRestrictedHostname(location.hostname)) return;
  chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
    if (msg.type !== 'darkmode:refresh') return;
    void run()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  });
  void run(true);
}

async function run(initial = false): Promise<void> {
  const host = location.hostname;
  let data: DarkModeData | null = null;
  try {
    data = (await send({ type: 'darkmode:get', hostname: host })) as DarkModeData | null;
  } catch {
    return;
  }
  if (!data?.paid) return;

  // Force off (user, global off, or prior auto) — cancel invert + clear smart CSS.
  if (!data.apply) {
    injectStyle(STYLE_RESET, buildDarkResetCss());
    removeStyle(STYLE_SMART);
    return;
  }

  await waitForBody(800);

  const settledDark = sampleAndApply(host, data);
  // Some sites apply their dark theme via JS after body exists (saved preference / matchMedia
  // on DOMContentLoaded), so a single early sample sees light and inverts a page that then
  // turns dark → washed-out. On the initial page load, re-check after load / a short delay.
  if (initial && !settledDark) scheduleReSample(host, data);
}

/**
 * Sample the page without our FOUC invert and apply the right treatment.
 * Returns true if it settled as already-dark (reset + auto-skip); false if it applied the
 * smart invert for a light page (or Force on).
 */
function sampleAndApply(host: string, data: DarkModeData): boolean {
  const signals = samplePageWithoutInvert(document);
  const verdict = isConfidentlyAlreadyDark(signals);

  // User Force on always wins — never auto-skip.
  if (verdict.dark && verdict.confidence === 'high' && data.override !== 'on') {
    injectStyle(STYLE_RESET, buildDarkResetCss());
    removeStyle(STYLE_SMART);
    void send({ type: 'darkmode:autoSkip', hostname: host, reason: verdict.reason }).catch(() => {
      /* SW may be waking */
    });
    return true;
  }

  // Light page (or Force on): upgrade FOUC invert → smarter stylesheet.
  injectStyle(STYLE_SMART, buildSmartDarkCss(signals));
  removeStyle(STYLE_RESET);
  return false;
}

let reSampleScheduled = false;
/** Re-check once after load for sites that turn dark via JS after our initial light verdict. */
function scheduleReSample(host: string, data: DarkModeData): void {
  if (reSampleScheduled) return;
  reSampleScheduled = true;
  let settled = false;
  const recheck = (): void => {
    if (settled) return;
    // Only flips to reset if the page is NOW confidently dark; never un-darks a light page.
    if (sampleAndApply(host, data)) settled = true;
  };
  if (document.readyState !== 'complete') {
    window.addEventListener('load', () => setTimeout(recheck, 0), { once: true });
  }
  setTimeout(recheck, 1200);
}

/**
 * Temporarily clear html/body filters so getComputedStyle reflects the site's
 * real colors (registered invert CSS uses filter:!important).
 */
function samplePageWithoutInvert(doc: Document): DarkPageSignals {
  const html = doc.documentElement;
  const body = doc.body;
  const prevHtmlFilter = html?.style.getPropertyValue('filter') ?? '';
  const prevHtmlPriority = html?.style.getPropertyPriority('filter') ?? '';
  const prevBodyFilter = body?.style.getPropertyValue('filter') ?? '';
  const prevBodyPriority = body?.style.getPropertyPriority('filter') ?? '';
  try {
    html?.style.setProperty('filter', 'none', 'important');
    body?.style.setProperty('filter', 'none', 'important');
    // Force layout so computed styles update before sampling.
    void html?.offsetHeight;
    return samplePage(doc);
  } finally {
    if (html) {
      if (prevHtmlFilter) html.style.setProperty('filter', prevHtmlFilter, prevHtmlPriority || undefined);
      else html.style.removeProperty('filter');
    }
    if (body) {
      if (prevBodyFilter) body.style.setProperty('filter', prevBodyFilter, prevBodyPriority || undefined);
      else body.style.removeProperty('filter');
    }
  }
}

function samplePage(doc: Document): DarkPageSignals {
  const html = doc.documentElement;
  const body = doc.body;
  const htmlCs = html ? getComputedStyle(html) : null;
  const bodyCs = body ? getComputedStyle(body) : null;

  let metaTheme: string | null = null;
  const meta = doc.querySelector('meta[name="theme-color"]');
  if (meta) metaTheme = meta.getAttribute('content');

  return {
    htmlBgLuminance: htmlCs ? luminanceOfCssColor(htmlCs.backgroundColor) : null,
    bodyBgLuminance: bodyCs ? luminanceOfCssColor(bodyCs.backgroundColor) : null,
    htmlTextLuminance: htmlCs ? luminanceOfCssColor(htmlCs.color) : null,
    bodyTextLuminance: bodyCs ? luminanceOfCssColor(bodyCs.color) : null,
    htmlColorScheme: htmlCs?.colorScheme ?? '',
    bodyColorScheme: bodyCs?.colorScheme ?? '',
    metaThemeLuminance: metaTheme ? luminanceOfCssColor(metaTheme) : null,
  };
}

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
  let el = document.querySelector(
    `style[data-stampstack="${kind}"]`,
  ) as HTMLStyleElement | null;
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
