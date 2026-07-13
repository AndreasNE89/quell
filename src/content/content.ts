// Quell content script (ISOLATED world, document_start).
//
// Generic element-hiding arrives as a browser-injected stylesheet (registered by the
// service worker, allowlist-aware). This script handles the two things that need the
// page's live DOM: site-specific hide selectors and procedural cosmetic filters.

import type { Message, CosmeticResponse } from '../shared/types.js';
import { queryProcedural } from '../engine/procedural.js';

// Only operate in real web documents.
if (location.protocol === 'http:' || location.protocol === 'https:' || location.protocol === 'about:') {
  void start();
}

async function start(): Promise<void> {
  let resp: CosmeticResponse | null = null;
  try {
    resp = (await send({ type: 'cosmetic:get', hostname: location.hostname })) as CosmeticResponse;
  } catch {
    return; // service worker unavailable
  }
  if (!resp || resp.allowlisted) return;

  injectSpecificCss(resp.hide, resp.unhide);

  if (resp.procedural.length) {
    const exprs = resp.procedural.map((p) => p.expr);
    runProcedural(exprs);
    observe(() => runProcedural(exprs));
  }
}

function send(msg: Message): Promise<unknown> {
  return chrome.runtime.sendMessage(msg);
}

/** Is `sel` a syntactically valid CSS selector? Guards against a compromised/auto-
 *  updated list injecting `a{}html{display:none}` and breaking out of the rule. */
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
  // Un-hide overrides come last so they win over the generic/specific hides above.
  if (safeUnhide.length) css += `${safeUnhide.join(',\n')} { display: revert !important; }\n`;

  const style = document.createElement('style');
  style.setAttribute('data-quell', 'cosmetic');
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);
}

const hidden = new WeakSet<Element>();
let hiddenCount = 0;

function runProcedural(exprs: string[]): void {
  let added = 0;
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
      (el as HTMLElement).style.setProperty('display', 'none', 'important');
      added++;
    }
  }
  // Only message the SW when this pass actually hid something new — otherwise every
  // throttled MutationObserver tick would flood a message forever once anything hid.
  if (added > 0) {
    hiddenCount += added;
    void send({ type: 'cosmetic:hidden', count: hiddenCount });
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
    obs.observe(document.documentElement, { childList: true, subtree: true });
  if (document.documentElement) attach();
  else document.addEventListener('DOMContentLoaded', attach, { once: true });
  // A final pass once the DOM is parsed.
  document.addEventListener('DOMContentLoaded', run, { once: true });
}
