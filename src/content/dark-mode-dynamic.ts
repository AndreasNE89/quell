// Dynamic dark-mode engine (ISOLATED world; runs in every http/https frame).
//
// Recolors each element's OWN background/text onto a dark palette (see shared/dark-mode-dynamic)
// and NEVER touches media — img/video/canvas/iframe content and url() images are left exactly as
// the site drew them. Already-dark surfaces are kept (remaps return null), so this is a no-op on
// pages that are already dark.
//
// Engine model (v2, after the all-pages review):
//  - Unified work queue drained in rAF batches, each batch split into a READ phase (all
//    getComputedStyle calls; no DOM writes, so no forced style-recalc thrash) then a WRITE phase.
//  - Membership/marks live in WeakSets/WeakMaps, not DOM attributes (no serialization leaks).
//  - Observer watches childList AND class/style attributes: state-driven restyles (theme swaps,
//    hover-toggled classes) roll back our override and re-process from the fresh colors. Our own
//    style writes are recognized (saved `applied` values) and skipped.
//  - Restore uses a WeakRef registry, so nodes detached while dark are restored on toggle-off if
//    they come back; values the site overwrote mid-session are left as the site set them.
//  - Foreground lightening is backdrop-aware: text over a url() photo/pattern (which we refuse
//    to darken) keeps its original color instead of becoming light-on-light.
//  - background-clip:text gradients are treated as TEXT paint (lightened, not darkened).
//  - The shell (only in the top frame) is @media screen; print restores the page.

import {
  remapBackgroundColor,
  remapForegroundColor,
  remapBorderColor,
  remapBackgroundImage,
  ROOT_BG,
  ROOT_FG,
} from '../shared/dark-mode-dynamic.js';
import { parseCssColor, relativeLuminance } from '../shared/dark-mode-smart.js';

const SHELL_STYLE = 'dark-dynamic';
const BATCH_SIZE = 1200;

// Elements we never recolor: media (rendered as the site intended) + non-visual/void tags.
// Inline <svg> roots get a minimal grayscale-icon treatment; svg internals are never walked.
const SKIP_TAGS = new Set([
  'IMG', 'VIDEO', 'CANVAS', 'PICTURE', 'IFRAME', 'EMBED', 'OBJECT',
  'SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'NOSCRIPT', 'TEMPLATE',
  'SOURCE', 'TRACK', 'BR', 'HR',
]);

interface SavedProp {
  prop: string;
  value: string; // original inline value (may be '')
  priority: string;
  applied: string; // the value WE set — used to detect our own writes / site overwrites
}

let active = false;
let engineGen = 0; // bumped on every apply/stop; pending drains abort on mismatch
let observer: MutationObserver | null = null;
let withShell = false;

const marked = { set: new WeakSet<Element>() }; // wrapper so stop() can swap in a fresh WeakSet
const saved = new WeakMap<Element, SavedProp[]>();
const registry = new Set<WeakRef<Element>>(); // every element we actually overrode
const cleanup = new FinalizationRegistry<WeakRef<Element>>((ref) => registry.delete(ref));

const pending = new Set<Element>();
let drainScheduled = false;
let initialStormDone = false;

// ---------------------------------------------------------------------------
// Plans: read phase computes, write phase applies.
// ---------------------------------------------------------------------------

interface Plan {
  el: HTMLElement | SVGSVGElement;
  props: Array<[string, string]>;
}

function isDarkBackdrop(
  el: Element,
  batchBg: Map<Element, boolean>,
): boolean {
  // Walk up to the nearest painted background. If it's one we darken(ed) or the site's own
  // dark, lightening text is safe; if it's a url() image or a kept-light surface, keep the
  // site's text color (light-on-light is worse than missing a remap).
  let node: Element | null = el;
  for (let depth = 0; node && depth < 8; depth++) {
    const known = batchBg.get(node);
    if (known != null) return known;

    let cs: CSSStyleDeclaration;
    try {
      cs = getComputedStyle(node);
    } catch {
      return true;
    }
    const img = cs.backgroundImage;
    if (img && img !== 'none' && img.includes('url(')) {
      batchBg.set(node, false);
      return false; // photo/pattern backdrop we refuse to darken
    }
    const bg = parseCssColor(cs.backgroundColor);
    if (bg && bg.a >= 0.5) {
      // Any parseable opaque surface ends up dark: either it already is, or the luminance-gated
      // background remap darkens it (has darkened it in an earlier batch) — safe to lighten text.
      batchBg.set(node, true);
      return true;
    }
    if (!bg && cs.backgroundColor && cs.backgroundColor !== 'transparent') {
      batchBg.set(node, false);
      return false; // unparseable (unknown color space) → we keep it → don't lighten text
    }
    const root = node.getRootNode();
    node = node.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }
  return true; // reached the root — our canvas / the page surface is dark
}

function computePlan(el: Element, batchBg: Map<Element, boolean>): Plan | null {
  if (marked.set.has(el)) return null;

  // Minimal inline-SVG treatment: lighten dark, desaturated (grayscale-icon) root fills so
  // monochrome icons stay visible; never touch colorful artwork or svg internals.
  if (el instanceof SVGSVGElement) {
    marked.set.add(el);
    let cs: CSSStyleDeclaration;
    try {
      cs = getComputedStyle(el);
    } catch {
      return null;
    }
    const props: Array<[string, string]> = [];
    for (const prop of ['fill', 'stroke'] as const) {
      const v = cs[prop];
      if (!v || v === 'none') continue;
      const rgb = parseCssColor(v);
      if (!rgb || rgb.a < 0.5) continue;
      if (relativeLuminance(rgb.r, rgb.g, rgb.b) >= 0.15) continue;
      const max = Math.max(rgb.r, rgb.g, rgb.b);
      const min = Math.min(rgb.r, rgb.g, rgb.b);
      if (max - min > 40) continue; // saturated → likely artwork, keep
      const light = remapForegroundColor(v);
      if (light) props.push([prop, light]);
    }
    return props.length ? { el, props } : null;
  }

  if (!(el instanceof HTMLElement)) {
    marked.set.add(el);
    return null;
  }
  if (SKIP_TAGS.has(el.tagName)) {
    marked.set.add(el);
    return null;
  }

  let cs: CSSStyleDeclaration;
  try {
    cs = getComputedStyle(el);
  } catch {
    return null;
  }
  marked.set.add(el);

  const props: Array<[string, string]> = [];

  // background-clip:text — the background IS the text paint; lighten, never darken.
  const clipText =
    cs.webkitBackgroundClip === 'text' || (cs as CSSStyleDeclaration).backgroundClip === 'text';

  const bg = clipText
    ? remapForegroundColor(cs.backgroundColor)
    : remapBackgroundColor(cs.backgroundColor);
  if (bg) props.push(['background-color', bg]);

  const grad = remapBackgroundImage(cs.backgroundImage, clipText ? 'fg' : 'bg');
  if (grad) props.push(['background-image', grad]);

  // Text: lighten only when the effective backdrop is (or becomes) dark.
  const fg = remapForegroundColor(cs.color);
  if (fg && isDarkBackdrop(el, batchBg)) props.push(['color', fg]);

  // Borders per side (the shorthand serializes multi-value and fails to parse).
  const sides: Array<[string, string]> = [
    ['border-top-color', cs.borderTopWidth],
    ['border-right-color', cs.borderRightWidth],
    ['border-bottom-color', cs.borderBottomWidth],
    ['border-left-color', cs.borderLeftWidth],
  ];
  for (const [prop, width] of sides) {
    if (parseFloat(width) <= 0) continue;
    const cur = cs.getPropertyValue(prop);
    const remapped = remapBorderColor(cur);
    if (remapped) props.push([prop, remapped]);
  }

  if (props.length && bg) batchBg.set(el, true);
  return props.length ? { el, props } : null;
}

function applyPlan(plan: Plan): void {
  const el = plan.el;
  const saves: SavedProp[] = saved.get(el) ?? [];
  for (const [prop, value] of plan.props) {
    saves.push({
      prop,
      value: el.style.getPropertyValue(prop),
      priority: el.style.getPropertyPriority(prop),
      applied: value,
    });
    el.style.setProperty(prop, value, 'important');
  }
  if (saves.length && !saved.has(el)) {
    saved.set(el, saves);
    const ref = new WeakRef<Element>(el);
    registry.add(ref);
    cleanup.register(el, ref);
  }
}

// ---------------------------------------------------------------------------
// Queue + drain
// ---------------------------------------------------------------------------

function collect(root: ParentNode, out: Element[]): void {
  if (root instanceof Element && !marked.set.has(root)) out.push(root);
  for (const el of root.querySelectorAll('*')) {
    if (el instanceof SVGSVGElement || el instanceof HTMLElement) {
      if (!marked.set.has(el)) out.push(el);
    }
    const sr = (el as HTMLElement).shadowRoot;
    if (sr) collect(sr, out);
  }
}

function enqueue(els: Iterable<Element>): void {
  for (const el of els) pending.add(el);
  scheduleDrain();
}

function scheduleDrain(): void {
  if (drainScheduled || !active || pending.size === 0) return;
  drainScheduled = true;
  const gen = engineGen;
  const cb = (): void => {
    drainScheduled = false;
    if (gen !== engineGen || !active) return;
    drain();
  };
  // rAF doesn't fire in hidden tabs — fall back to a timer so background tabs still darken.
  if (document.hidden) setTimeout(cb, 120);
  else requestAnimationFrame(cb);
}

function drain(): void {
  const batch: Element[] = [];
  for (const el of pending) {
    batch.push(el);
    pending.delete(el);
    if (batch.length >= BATCH_SIZE) break;
  }

  // READ phase — all computed-style access, zero writes (no recalc thrash)…
  const batchBg = new Map<Element, boolean>();
  const plans: Plan[] = [];
  for (const el of batch) {
    const plan = computePlan(el, batchBg);
    if (plan) plans.push(plan);
  }
  // …then WRITE phase.
  for (const plan of plans) applyPlan(plan);

  if (pending.size > 0) {
    scheduleDrain();
  } else if (!initialStormDone) {
    // Initial styling storm is over — stop suppressing transitions (which would otherwise
    // paint a multi-second staggered fade wave as batches land).
    initialStormDone = true;
    refreshShell();
  }
}

// ---------------------------------------------------------------------------
// Shell / observer / hover / print
// ---------------------------------------------------------------------------

function shellCss(): string {
  // @media screen so print keeps the site's light output. Placeholder default covers the
  // common dark ::placeholder (inline styles cannot target pseudo-elements).
  const suppress = initialStormDone
    ? ''
    : `\n  * { transition-duration: 0s !important; }`;
  const canvas = withShell
    ? `\n  html { background-color: ${ROOT_BG} !important; color-scheme: dark !important; }`
    : '';
  return `@media screen {${canvas}
  input::placeholder, textarea::placeholder { color: ${ROOT_FG.replace('rgb', 'rgba').replace(')', ', 0.55)')} !important; }${suppress}
}`;
}

function refreshShell(): void {
  const el = document.querySelector(
    `style[data-stampstack="${SHELL_STYLE}"]`,
  ) as HTMLStyleElement | null;
  if (el) el.textContent = shellCss();
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
  el.textContent = shellCss();
}

/** Did this style-attribute mutation come from our own write phase? */
function isOurStyleWrite(el: Element): boolean {
  const saves = saved.get(el);
  if (!saves || !saves.length) return false;
  return saves.every(
    (s) => (el as HTMLElement).style.getPropertyValue(s.prop) === s.applied,
  );
}

/** Roll back our overrides on one element (keeping any value the site wrote over ours). */
function restoreElement(el: Element): void {
  const saves = saved.get(el);
  if (saves) {
    const style = (el as HTMLElement).style;
    for (const s of saves) {
      // Only restore when the current value is still OURS — if the site overwrote it
      // mid-session, its value is newer intent than our pre-scan snapshot.
      if (style.getPropertyValue(s.prop) !== s.applied) continue;
      if (s.value) style.setProperty(s.prop, s.value, s.priority || undefined);
      else style.removeProperty(s.prop);
    }
    saved.delete(el);
  }
}

function onMutations(records: MutationRecord[]): void {
  if (!active) return;
  const added: Element[] = [];
  for (const r of records) {
    if (r.type === 'childList') {
      for (const node of r.addedNodes) {
        if (node instanceof HTMLElement) collect(node, added);
      }
    } else if (r.type === 'attributes') {
      const el = r.target;
      if (!(el instanceof HTMLElement)) continue;
      if (r.attributeName === 'style' && isOurStyleWrite(el)) continue; // our own write
      // Class/style changed under us: the colors may be different now. Roll back our
      // override, unmark, and re-process from the element's fresh computed colors.
      restoreElement(el);
      marked.set.delete(el);
      added.push(el);
    }
  }
  if (added.length) enqueue(added);
}

let lastHover = 0;
function onHover(e: Event): void {
  // Shadow roots attached after load (hover-play widgets, lazy components) are invisible to
  // the childList observer. Throttled; enqueues (never scans synchronously in the handler).
  const now = Date.now();
  if (now - lastHover < 250) return;
  lastHover = now;
  if (e.target instanceof Element) {
    const els: Element[] = [];
    collect(e.target, els);
    if (els.length) enqueue(els);
  }
}

let printHooked = false;
let pausedForPrint = false;
function hookPrint(): void {
  if (printHooked) return;
  printHooked = true;
  window.addEventListener('beforeprint', () => {
    if (!active) return;
    pausedForPrint = true;
    stopDynamicDark();
  });
  window.addEventListener('afterprint', () => {
    if (!pausedForPrint) return;
    pausedForPrint = false;
    applyDynamicDark(withShell);
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Turn the dynamic dark engine on for this frame. Idempotent.
 *  `shell` paints the charcoal canvas — top frame only; subframes must keep transparent
 *  backgrounds transparent (overlay iframes would otherwise become opaque dark slabs). */
export function applyDynamicDark(shell: boolean): void {
  if (active) return;
  active = true;
  engineGen++;
  withShell = shell;
  initialStormDone = false;
  injectShell();
  hookPrint();

  const els: Element[] = [];
  collect(document, els);
  enqueue(els);

  observer = new MutationObserver(onMutations);
  const root = document.documentElement;
  if (root) {
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
  }
  document.addEventListener('mouseover', onHover, true);
}

/** Turn it off and restore original inline colors (including nodes detached while dark). */
export function stopDynamicDark(): void {
  if (!active) return;
  active = false;
  engineGen++;
  observer?.disconnect();
  observer = null;
  document.removeEventListener('mouseover', onHover, true);
  pending.clear();
  drainScheduled = false;
  document.querySelector(`style[data-stampstack="${SHELL_STYLE}"]`)?.remove();

  for (const ref of registry) {
    const el = ref.deref();
    if (el) restoreElement(el);
    registry.delete(ref);
  }
  marked.set = new WeakSet<Element>();
}
