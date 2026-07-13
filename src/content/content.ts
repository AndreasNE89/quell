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
} from '../shared/types.js';
import { STORAGE_KEY } from '../shared/constants.js';
import { queryProcedural } from '../engine/procedural.js';
import { applyYoutubeFeatures, watchYoutubeSpa } from './youtube-ui.js';

if (location.protocol === 'http:' || location.protocol === 'https:' || location.protocol === 'about:') {
  void start();
}

let youtubeOpts: YoutubeOptionsData | null = null;

async function start(): Promise<void> {
  const host = location.hostname;

  // Kick scriptlets immediately — do not wait on cosmetics. YouTube/player
  // pages need MAIN-world hooks as early as the SW round-trip allows.
  const scriptletsP = send({ type: 'scriptlets:get', hostname: host }).then((raw) => {
    const s = raw as ScriptletsResponse | null;
    if (!s || s.allowlisted || !s.scriptlets.length) return;
    return send({ type: 'scriptlets:inject', scriptlets: s.scriptlets });
  });

  const ytOptsP = send({ type: 'youtube:getOptions', hostname: host }).then((raw) => {
    youtubeOpts = raw as YoutubeOptionsData | null;
    if (youtubeOpts) applyYoutubeFeatures(youtubeOpts);
  });

  const resp = await sendWithRetry({ type: 'cosmetic:get', hostname: host });
  if (resp?.allowlisted) {
    await Promise.all([scriptletsP.catch(() => {}), ytOptsP.catch(() => {})]);
    return;
  }

  if (resp) {
    injectSpecificCss(resp.hide, resp.unhide);
    if (resp.procedural.length) {
      const exprs = resp.procedural.map((p) => p.expr);
      runProcedural(exprs);
      observe(() => runProcedural(exprs));
    }
  }

  await Promise.all([scriptletsP.catch(() => {}), ytOptsP.catch(() => {})]);
  watchYoutubeSpa(() => youtubeOpts);

  // Live-update when the user flips YouTube toggles in the popup/options.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEY]) return;
    void send({ type: 'youtube:getOptions', hostname: host }).then((raw) => {
      youtubeOpts = raw as YoutubeOptionsData | null;
      if (youtubeOpts) applyYoutubeFeatures(youtubeOpts);
    });
  });
}

async function sendWithRetry(msg: Message, attempts = 5): Promise<CosmeticResponse | null> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = (await send(msg)) as CosmeticResponse | null;
      if (resp) return resp;
    } catch (e) {
      lastErr = e;
    }
    await sleep(50 * (i + 1));
  }
  if (lastErr) console.warn('[StampStack] cosmetic:get failed after retries', lastErr);
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

  const style = document.createElement('style');
  style.setAttribute('data-StampStack', 'cosmetic');
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);
}

const hidden = new WeakSet<Element>();

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
      // `:remove()` ops already detach nodes; others get display:none.
      if (el.isConnected) {
        (el as HTMLElement).style?.setProperty?.('display', 'none', 'important');
      }
    }
  }
}

/** Re-run procedural matching as the page mutates, throttled to once per frame. */
function observe(run: () => void): void {
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
      attributes: true,
    });
  if (document.documentElement) attach();
  else document.addEventListener('DOMContentLoaded', attach, { once: true });
  document.addEventListener('DOMContentLoaded', run, { once: true });
}
