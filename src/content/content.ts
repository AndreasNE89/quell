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
  } catch {
    /* SW may be asleep; storage bootstrap already applied */
  }
}

/** Shorts redirect + hide must start before cosmetic:get (can take hundreds of ms). */
function bootstrapYoutube(host: string): void {
  if (!isYoutubeHost(host)) return;
  watchYoutubeSpa(() => youtubeOpts);
  onYoutubeStorageChanged(host);
  void chrome.storage.local.get(STORAGE_KEY).then((stored) => {
    const partial = stored[STORAGE_KEY] as Partial<Settings> | undefined;
    if (!partial) return;
    youtubeOpts = youtubeOptsFromSettings(partial, host);
    applyYoutubeFeatures(youtubeOpts);
  });
  void refreshYoutubeOpts(host);
}

async function start(): Promise<void> {
  const host = location.hostname;

  bootstrapYoutube(host);

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
