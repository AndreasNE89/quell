// Dynamic dark-mode engine (ISOLATED, top frame).
//
// Recolors each element's OWN background/text onto a dark palette (see shared/dark-mode-dynamic)
// and NEVER touches media — img/video/canvas/svg/iframe/etc. are left exactly as the site drew
// them, so images/GIFs/hover videos are untouched. Already-dark surfaces are kept as-is (the
// remap returns null for them), so this is a no-op on pages that are already dark.
//
// MVP scope: solid background + text colors via inline overrides, a root shell, and a
// MutationObserver for added nodes. Not yet handled (iterate): :hover/:focus and ::before
// pseudo colors, CSS gradients / background-images, box-shadows, borders, cross-origin @font
// icon glyphs, and re-remapping on the site's own color changes.

import {
  remapBackgroundColor,
  remapForegroundColor,
  remapBorderColor,
  remapGradient,
  ROOT_BG,
  ROOT_FG,
} from '../shared/dark-mode-dynamic.js';

const MARK = 'data-ss-dark';
const SHELL_STYLE = 'dark-dynamic';

// Elements we never recolor: media (rendered as the site intended) + non-visual/void tags.
const SKIP_TAGS = new Set([
  'IMG', 'VIDEO', 'CANVAS', 'PICTURE', 'IFRAME', 'EMBED', 'OBJECT', 'SVG',
  'SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'NOSCRIPT', 'TEMPLATE',
  'SOURCE', 'TRACK', 'BR', 'HR',
]);

let active = false;
let observer: MutationObserver | null = null;

interface SavedProp {
  prop: string;
  value: string;
  priority: string;
}
const saved = new WeakMap<HTMLElement, SavedProp[]>();

function override(el: HTMLElement, saves: SavedProp[], prop: string, value: string): void {
  saves.push({
    prop,
    value: el.style.getPropertyValue(prop),
    priority: el.style.getPropertyPriority(prop),
  });
  el.style.setProperty(prop, value, 'important');
}

function processElement(el: HTMLElement): void {
  if (el.hasAttribute(MARK)) return;
  if (SKIP_TAGS.has(el.tagName)) {
    el.setAttribute(MARK, '');
    return;
  }
  let cs: CSSStyleDeclaration;
  try {
    cs = getComputedStyle(el);
  } catch {
    return;
  }
  // Background is the element's own (doesn't inherit). Text color inherits — because the shell
  // sets a light default on <body>, an element only reads a dark `color` here when the site set
  // one explicitly, so we recolor exactly those and let everything else inherit the light text.
  const bg = remapBackgroundColor(cs.backgroundColor);
  const fg = remapForegroundColor(cs.color);

  // Gradient backgrounds (light hero/button/card gradients → dark). Skip actual images (url())
  // so we never touch media; leave dark gradients alone.
  const bgImg = cs.backgroundImage;
  const grad =
    bgImg && bgImg !== 'none' && bgImg.includes('gradient(') && !bgImg.includes('url(')
      ? remapGradient(bgImg)
      : null;
  const gradChanged = grad != null && grad !== bgImg;

  // Borders, but only where one is actually drawn (avoids overriding every element's default).
  const hasBorder =
    parseFloat(cs.borderTopWidth) > 0 ||
    parseFloat(cs.borderRightWidth) > 0 ||
    parseFloat(cs.borderBottomWidth) > 0 ||
    parseFloat(cs.borderLeftWidth) > 0;
  const bc = hasBorder && cs.borderColor ? remapBorderColor(cs.borderColor) : null;

  if (!bg && !fg && !gradChanged && !bc) {
    el.setAttribute(MARK, '');
    return;
  }
  const saves: SavedProp[] = [];
  if (bg) override(el, saves, 'background-color', bg);
  if (fg) override(el, saves, 'color', fg);
  if (gradChanged) override(el, saves, 'background-image', grad!);
  if (bc) override(el, saves, 'border-color', bc);
  saved.set(el, saves);
  el.setAttribute(MARK, '');
}

function scan(root: ParentNode): void {
  if (root instanceof HTMLElement) processElement(root);
  for (const el of root.querySelectorAll('*')) {
    if (el instanceof HTMLElement) processElement(el);
    // Recurse into open shadow roots: light-DOM CSS and our shell can't cross the shadow
    // boundary, so web-component text (often a transparent surface over our dark page with its
    // original dark text) would otherwise stay dark and unreadable while backgrounds look fine.
    const sr = el.shadowRoot;
    if (sr) scan(sr);
  }
}

function injectShell(): void {
  let el = document.querySelector(
    `style[data-stampstack="${SHELL_STYLE}"]`,
  ) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.setAttribute('data-stampstack', SHELL_STYLE);
    (document.head || document.documentElement).appendChild(el);
  }
  // Only the html canvas + a light default text. body's OWN background is handled per element
  // (light → charcoal, already-dark → kept), so already-dark sites aren't repainted; and a
  // light default color on body means unstyled text inherits light and only explicitly-dark
  // text gets recolored.
  el.textContent = `html { background-color: ${ROOT_BG} !important; color-scheme: dark !important; }
body { color: ${ROOT_FG} !important; }`;
}

/** Collect every element under `root`, descending into open shadow roots. */
function collectElements(root: ParentNode, out: HTMLElement[]): void {
  for (const el of root.querySelectorAll('*')) {
    if (el instanceof HTMLElement) out.push(el);
    const sr = el.shadowRoot;
    if (sr) collectElements(sr, out);
  }
}

/** Process the whole document in rAF-sized batches so a large page doesn't freeze on apply.
 *  The dark shell is already up, so this just refines colors progressively. Aborts if stopped. */
function scanChunked(root: ParentNode): void {
  const els: HTMLElement[] = [];
  if (root instanceof HTMLElement) els.push(root);
  collectElements(root, els);
  let i = 0;
  const step = (): void => {
    if (!active) return;
    const end = Math.min(i + 1500, els.length);
    for (; i < end; i++) processElement(els[i]);
    if (i < els.length) requestAnimationFrame(step);
  };
  step();
}

let lastHover = 0;
function onHover(e: Event): void {
  // Catch shadow roots attached after load (hover-play widgets, lazy components) — the
  // childList observer never sees an attachShadow on an existing host. Throttled; scan() is
  // idempotent (already-processed elements are skipped) and descends into shadow roots.
  const now = Date.now();
  if (now - lastHover < 250) return;
  lastHover = now;
  if (e.target instanceof Element) scan(e.target);
}

/** Turn the dynamic dark engine on for this page. Idempotent. */
export function applyDynamicDark(): void {
  if (active) return;
  active = true;
  injectShell();
  scanChunked(document);
  observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) if (node instanceof HTMLElement) scan(node);
    }
  });
  const root = document.documentElement;
  if (root) observer.observe(root, { childList: true, subtree: true });
  document.addEventListener('mouseover', onHover, true);
}

/** Turn it off and fully restore the page's original inline colors (incl. shadow DOM). Idempotent. */
export function stopDynamicDark(): void {
  if (!active) return;
  active = false;
  observer?.disconnect();
  observer = null;
  document.removeEventListener('mouseover', onHover, true);
  document.querySelector(`style[data-stampstack="${SHELL_STYLE}"]`)?.remove();
  restoreIn(document);
}

function restoreIn(root: ParentNode): void {
  for (const el of root.querySelectorAll('*')) {
    if (el instanceof HTMLElement && el.hasAttribute(MARK)) {
      const saves = saved.get(el);
      if (saves) {
        for (const s of saves) {
          if (s.value) el.style.setProperty(s.prop, s.value, s.priority || undefined);
          else el.style.removeProperty(s.prop);
        }
        saved.delete(el);
      }
      el.removeAttribute(MARK);
    }
    const sr = el.shadowRoot;
    if (sr) restoreIn(sr);
  }
}
