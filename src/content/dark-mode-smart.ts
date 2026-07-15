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

const STYLE_SMART = 'dark-smart';
const STYLE_RESET = 'dark-reset';

export function startDarkModeSmart(): void {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  void run();
}

async function run(): Promise<void> {
  const host = location.hostname;
  let data: DarkModeData | null = null;
  try {
    data = (await send({ type: 'darkmode:get', hostname: host })) as DarkModeData | null;
  } catch {
    return;
  }
  if (!data?.paid) return;

  // Force off (user or prior auto) — ensure invert is cancelled if it briefly applied.
  if (!data.apply) {
    if (data.override === 'off') injectStyle(STYLE_RESET, buildDarkResetCss());
    return;
  }

  await waitForBody(800);
  const signals = samplePage(document);
  const verdict = isConfidentlyAlreadyDark(signals);

  // User Force on always wins — never auto-skip.
  if (verdict.dark && verdict.confidence === 'high' && data.override !== 'on') {
    injectStyle(STYLE_RESET, buildDarkResetCss());
    removeStyle(STYLE_SMART);
    try {
      await send({
        type: 'darkmode:autoSkip',
        hostname: host,
        reason: verdict.reason,
      });
    } catch {
      /* SW may be waking */
    }
    return;
  }

  // Light page (or Force on): upgrade FOUC invert → smarter stylesheet.
  injectStyle(STYLE_SMART, buildSmartDarkCss(signals));
  removeStyle(STYLE_RESET);
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
