// Dynamic dark-mode engine (ISOLATED world; runs in every frame the content script starts it in).
//
// Recolors each element's OWN background/text onto a dark palette (see shared/dark-mode-dynamic).
// Media is left exactly as the site drew it (img/video/canvas/iframe content and url() images),
// with one exception: an image drawn in flat dark ink on a transparent background (a formula, a
// line diagram, a monochrome SVG logo) is inverted, because on charcoal it would vanish (M4).
// Already-dark surfaces are kept (remaps return null). On a page that is natively dark only large
// light "islands" are darkened, so accent buttons, badges and white CTAs keep their color.
//
// Engine model (v3, after REVIEW_2026-09-24):
//  - Unified work queue drained in rAF batches (one large batch per timer tick in a hidden tab,
//    which has no frames to spread work over), each batch split into a READ phase (all
//    getComputedStyle calls; no DOM writes, so no forced style-recalc thrash) then a WRITE phase.
//  - Membership/marks live in WeakSets/WeakMaps, not DOM attributes (no serialization leaks).
//  - Observers watch the document and every shadow root the walk finds (childList + theme/state
//    attributes), theme-like attributes on html/body, stylesheet loads and swaps, and
//    prefers-color-scheme. Restyles roll back our override and re-process from fresh colors.
//  - Our own writes are recognized by the whole style attribute we last wrote; a site write is
//    diffed against it, and only color-relevant changes cause work. A custom-property write
//    re-walks the subtree only when the value could be a color, and big re-walks are rate-limited.
//  - Restore puts back the exact style attribute the site had and replays any change the site
//    made since; a WeakRef registry reaches nodes detached while dark.
//  - Hover and focus re-read the element chain they touch, and a running color transition is read
//    at its end value, so :hover/:focus states are recolored too.
//  - Foreground lightening is backdrop-aware: text over a covering url() image, or over a surface
//    we keep light, keeps its original color instead of becoming light-on-light.
//  - background-clip:text gradients are treated as TEXT paint (lightened, not darkened).
//  - ::before/::after get their overrides as inline custom properties, which the shell turns into
//    pseudo-element rules keyed on that attribute text (inline styles cannot reach them).
//  - Every frame declares color-scheme: dark, so a transparent iframe's canvas stays transparent;
//    only the top frame paints the charcoal canvas. The shell is @media screen; print restores.
//  - Rich-text editors are never written into: they save their DOM, inline styles included, as
//    the post or the email. A document that is itself the editor is left entirely alone; an
//    editor in a page we darken is shown as a light box, painted from the shell.

import {
  remapBackgroundColor,
  remapForegroundColor,
  remapBorderColor,
  remapBackgroundImage,
  isColorRelevantProperty,
  isDarkInkColor,
  isDarkInkImage,
  mightBeColorValue,
  urlLayersCoverBox,
  BG_KEEP_LUMINANCE,
  ROOT_BG,
  ROOT_FG,
} from '../shared/dark-mode-dynamic.js';
import { parseCssColor, relativeLuminance } from '../shared/dark-mode-smart.js';

const SHELL_STYLE = 'dark-dynamic';
/** Disarms the registered document_start sheet (dark-mode.css) and our own canvas rule. */
const OFF_ATTR = 'data-stampstack-off';
const READY_ATTR = 'data-stampstack-ready';
const BATCH_SIZE = 1200;
/** A hidden tab paints nothing and Chrome wakes its timers about once a second: do more per wake. */
const HIDDEN_BATCH_SIZE = 20000;
/** Re-walks bigger than this are rate-limited (B72); a small one (a menu opening) is not. */
const SMALL_SUBTREE = 300;
const SUBTREE_INTERVAL_MS = 250;
/** On a natively dark page, a light surface at least this big (px²) is an island we darken. */
const ISLAND_MIN_AREA = 40000;
const ISLAND_MIN_LUMINANCE = 0.6;
/** Inline SVGs with more painted shapes than this only get the root treatment. */
const SVG_MAX_SHAPES = 300;
const SVG_SHAPES = 'path, circle, rect, ellipse, line, polyline, polygon, text, tspan, textPath, use';
/** Paint servers and resources: lightening a black rect inside a <mask> would unmask it. */
const SVG_RESOURCES = 'mask, clipPath, defs, pattern, symbol, marker, filter';
/** Same-origin SVG images the engine may sample for dark ink, per page. */
const INK_SAMPLE_BUDGET = 400;
/**
 * Images the site itself marks as ink to invert on a dark background: MediaWiki's night-mode
 * classes (Wikipedia math is served cross-origin as SVG, so it cannot be sampled) and common
 * LaTeX renderers.
 */
const INK_HINT =
  '.skin-invert, .skin-invert-image img, .mw-invert, .mwe-math-fallback-image-inline, ' +
  '.mwe-math-fallback-image-display, .mw-logo-wordmark, .mw-logo-tagline, img.latex, ' +
  'img[src*="/math/render/svg/"], ' +
  'img[src*="/math/render/png/"], img[src*="latex.codecogs.com/"]';
const INVERT = 'invert(1) hue-rotate(180deg)';
/** Set on the parent of an editing host that is shown as a light box (editorBoxRule). */
const EDITOR_BOX = '--ssd-ed';

/** Theme and state attributes that change computed colors without a class/style mutation. */
export const THEME_ATTRIBUTE_FILTER = [
  'class',
  'style',
  'data-theme',
  'data-color-mode',
  'data-bs-theme',
  'data-mode',
  'data-color-scheme',
  'theme',
  // Framework theme switches (B67). html and body are watched for any theme-like attribute too.
  'data-mantine-color-scheme',
  'data-md-color-scheme',
  'data-mui-color-scheme',
  'data-color-theme',
  'data-appearance',
  // Component state that restyles an element and its children: tabs, menus, Radix/Headless UI.
  'aria-selected',
  'aria-expanded',
  'aria-current',
  'aria-pressed',
  'aria-checked',
  'data-state',
  'open',
  'disabled',
  // Stylesheet swaps (B66): acted on for LINK/STYLE only.
  'media',
  'href',
  'rel',
  // Editors switch themselves on after their content is in (TinyMCE after document.write).
  'contenteditable',
] as const;

const WATCHED_ATTRS = new Set<string>(THEME_ATTRIBUTE_FILTER);
const STYLESHEET_ATTRS = new Set(['media', 'href', 'rel', 'disabled']);
/** Attribute names/values on html/body that plausibly switch a theme (YouTube's `dark`, …). */
const THEME_LIKE = /dark|light|theme|scheme|night|day|contrast|appearance|mode|colou?r|palette|skin/i;

// Elements we never recolor: media (rendered as the site intended) + non-visual/void tags.
// IMG is handled on its own (dark-ink images only); inline <svg> gets a minimal icon treatment.
const SKIP_TAGS = new Set([
  'VIDEO', 'CANVAS', 'PICTURE', 'IFRAME', 'EMBED', 'OBJECT',
  'SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'NOSCRIPT', 'TEMPLATE',
  'SOURCE', 'TRACK', 'BR',
]);

/** Pseudo-element properties the shell can override, keyed by their custom-property suffix. */
const PSEUDO_PROPS: ReadonlyArray<readonly [string, string]> = [
  ['bgc', 'background-color'],
  ['bgi', 'background-image'],
  ['c', 'color'],
  ['tf', '-webkit-text-fill-color'],
  ['bt', 'border-top-color'],
  ['br', 'border-right-color'],
  ['bb', 'border-bottom-color'],
  ['bl', 'border-left-color'],
];
const PSEUDOS = [
  ['b', '::before'],
  ['a', '::after'],
] as const;

type Styled = Element & ElementCSSInlineStyle;

interface SavedProp {
  prop: string;
  value: string; // original inline value (may be '')
  priority: string;
  applied: string; // the value WE set, as the style serializes it
}

let active = false;
let engineGen = 0; // bumped on every apply/stop; pending drains abort on mismatch
let observer: MutationObserver | null = null;
let rootObserver: MutationObserver | null = null;
let schemeQuery: MediaQueryList | null = null;
let topFrame = false;
let withShell = false;
/** This frame's own canvas was dark when we looked: keep its surfaces, darken light islands. */
let nativeDark = false;
/** We set OFF_ATTR ourselves (natively dark top frame), so we remove it again on stop. */
let setOffAttr = false;
/** This document is itself an editor: the engine stood down for as long as it is on (editorDocument). */
let editorDoc = false;
/** Editing hosts seen editable: switched to read-only they still hold (and save) the content. */
const formerEditors = new WeakSet<Element>();
let anyFormerEditor = false;

const marked = { set: new WeakSet<Element>() }; // wrapper so stop() can swap in a fresh WeakSet
const observedRoots = { set: new WeakSet<ShadowRoot>() };
const saved = new WeakMap<Element, SavedProp[]>();
/** The style attribute before our first write (null: there was none). */
const origStyle = new WeakMap<Element, string | null>();
/** The style attribute right after our last write: anything else there is the site's. */
const ourStyle = new WeakMap<Element, string | null>();
/** The style attribute as last accounted for — base of the diff for the next site write. */
const lastStyle = new WeakMap<Element, string | null>();
/** Inline SVG root → the shapes inside it we recolored (restored with the root). */
const svgKids = new WeakMap<Element, Element[]>();
/** Natively dark page: surfaces we darkened as (part of) a light island. */
const islands = new WeakSet<Element>();
const registry = new Set<WeakRef<Element>>(); // every element we actually overrode
// One ref per element, reused across reprocess cycles. Without this a long-lived element on an
// SPA that flips classes repeatedly adds a fresh WeakRef on every re-apply, and none of them
// are collectable while the element is alive — the Set grows for the life of the page.
const refFor = new WeakMap<Element, WeakRef<Element>>();
const cleanup = new FinalizationRegistry<WeakRef<Element>>((ref) => registry.delete(ref));
// Elements whose colors may have changed (class/style flipped on them or an ancestor) and must
// be rolled back + recomputed. Rollback happens lazily inside the drain, never in the observer.
const needsReprocess = new WeakSet<Element>();

const pending = new Set<Element>();
// Subtree-reprocess roots, expanded in the drain rather than in the observer callback.
const pendingRoots = new Set<Element>();
// Elements the pointer or focus just entered or left; their chain is re-read first.
const interactive = new Set<Element>();
// Custom elements not upgraded yet: their shadow root appears with no DOM mutation to see.
const awaitingUpgrade = new Map<Element, number>();
const inkCache = new Map<string, boolean>();
let inkSamples = 0;
let drainScheduled = false;
let drainTimer = 0;
let drainRaf = 0;
let subtreeTimer = 0;
let upgradeTimer = 0;
let upgradeDelay = 250;
/**
 * <link>s whose media/href/rel/disabled just changed, with the sheet they had then. Chromium
 * applies such a change later: the element gets a new CSSStyleSheet a few milliseconds on (tens
 * under load) and fires no second load event. loadCSS's `media=print` → `all` flip was re-read
 * before the new sheet applied, and nothing asked again (B66).
 */
const linkSwaps = new Map<HTMLLinkElement, { sheet: CSSStyleSheet | null; until: number }>();
let linkSwapTimer = 0;
const LINK_SWAP_WAIT_MS = 3000;
/** A big re-walk still being drained started here (-1: none). */
let bigWalkStart = -1;
let bigWalkEnd = -Infinity;
/** Wall time the last big re-walk took to drain. */
let bigWalkCost = 0;
let initialStormDone = false;

// ---------------------------------------------------------------------------
// Plans: read phase computes, write phase applies.
// ---------------------------------------------------------------------------

interface Plan {
  el: Styled;
  props: Array<[string, string]>;
}

interface ReadCtx {
  /** Per-node verdict: does the surface under this node end up dark? */
  bg: Map<Element, boolean>;
  /** Per-node verdict: is this node inside a light island (natively dark page only)? */
  island: Map<Element, boolean>;
}

function parentOf(node: Element): Element | null {
  if (node.parentElement) return node.parentElement;
  const root = node.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function lumOf(css: string): number | null {
  const rgb = parseCssColor(css);
  if (!rgb || rgb.a < 0.5) return null;
  return relativeLuminance(rgb.r, rgb.g, rgb.b);
}

/** Inside (or itself) a large light surface on a natively dark page — darkened like a light page. */
function islandOf(el: Element | null, ctx: ReadCtx): boolean {
  if (!el || el === document.documentElement) return false;
  if (islands.has(el)) return true;
  const known = ctx.island.get(el);
  if (known != null) return known;
  let v = false;
  try {
    const lum = lumOf(getComputedStyle(el).backgroundColor);
    if (lum != null && lum > ISLAND_MIN_LUMINANCE) {
      const r = el.getBoundingClientRect();
      v = r.width * r.height >= ISLAND_MIN_AREA;
    }
  } catch {
    v = false;
  }
  if (!v) v = islandOf(parentOf(el), ctx);
  ctx.island.set(el, v);
  return v;
}

/** Whether the engine darkens (or keeps dark) this node's own surface, or null when it paints none. */
function surfaceVerdict(node: Element, cs: CSSStyleDeclaration, ctx: ReadCtx): boolean | null {
  // background-clip:text paints the text, not a surface.
  if (cs.webkitBackgroundClip === 'text' || cs.backgroundClip === 'text') return null;
  const image = cs.backgroundImage;
  if (image && image !== 'none' && image.includes('url(')) {
    const box = node.getBoundingClientRect();
    // A photo, pattern or texture we refuse to darken. A corner icon or bullet does not count:
    // the box's own color is what we darken (B65).
    if (urlLayersCoverBox(image, cs.backgroundSize, cs.backgroundRepeat, box.width, box.height)) {
      return false;
    }
  }
  const bg = parseCssColor(cs.backgroundColor);
  if (!bg) {
    // Unparseable (unknown color space) → we keep it → don't lighten text over it.
    return cs.backgroundColor && cs.backgroundColor !== 'transparent' ? false : null;
  }
  if (bg.a < 0.5) return null;
  if (relativeLuminance(bg.r, bg.g, bg.b) < BG_KEEP_LUMINANCE) return true; // already dark
  // Light and opaque: darkened, except a small light surface on a natively dark page.
  return !nativeDark || islandOf(node, ctx);
}

function isDarkBackdrop(el: Element, ctx: ReadCtx): boolean {
  // Walk up to the nearest painted surface. If it ends dark (the site's own dark, or one we
  // darken), lightening text is safe; over a url() photo or a surface we keep light, keep the
  // site's text color (light-on-light is worse than missing a remap).
  const passed: Element[] = [];
  let node: Element | null = el;
  let verdict = true; // reached the root: our canvas / the page surface is dark
  for (let depth = 0; node && depth < 16; depth++) {
    const known = ctx.bg.get(node);
    if (known != null) {
      verdict = known;
      break;
    }
    let cs: CSSStyleDeclaration;
    try {
      cs = getComputedStyle(node);
    } catch {
      break;
    }
    const v = surfaceVerdict(node, cs, ctx);
    passed.push(node);
    if (v != null) {
      verdict = v;
      break;
    }
    node = parentOf(node);
  }
  for (const n of passed) ctx.bg.set(n, verdict);
  return verdict;
}

/**
 * The value a running CSS transition is heading to, per property. Right after a hover, a class
 * flip or our own rollback, getComputedStyle returns the transition's first frame; planning from
 * that let a hover background fade in to light under text we had already lightened (B69).
 */
function transitionEnds(el: Element, cs: CSSStyleDeclaration): Map<string, string> | null {
  const durations = cs.transitionDuration;
  if (!durations || !/[1-9]/.test(durations)) return null;
  let anims: Animation[];
  try {
    anims = el.getAnimations();
  } catch {
    return null;
  }
  let out: Map<string, string> | null = null;
  for (const a of anims) {
    const prop = (a as CSSTransition).transitionProperty;
    if (prop !== 'background-color' && prop !== 'color') continue;
    const frames = (a.effect as KeyframeEffect | null)?.getKeyframes?.();
    const end = frames?.[frames.length - 1]?.[prop === 'color' ? 'color' : 'backgroundColor'];
    if (typeof end === 'string') (out ??= new Map()).set(prop, end);
  }
  return out;
}

/**
 * Part of what a rich-text editor saves. TinyMCE, CKEditor, Gmail compose and the like serialize
 * their DOM, inline styles included: a color we wrote in there was published with the post or the
 * email, near-white text on white. Not recolored at all; the editor keeps the site's own colors.
 */
function isEditorContent(el: Element): boolean {
  if (document.designMode === 'on') return true;
  // SVG has no isContentEditable: it belongs to the editor its nearest HTML ancestor is in.
  let html: Element | null = el;
  while (html && !(html instanceof HTMLElement)) html = html.parentElement;
  if (!html) return false;
  // Editing hosts and everything editable inside them, designMode and user-modify included.
  if ((html as HTMLElement).isContentEditable) return true;
  // Saved with an editor without being editable: a contenteditable=false island inside one (a
  // mention chip, an embed card), or an editor switched to read-only while we watched.
  for (let node = html.closest('[contenteditable]'); node; node = node.parentElement?.closest('[contenteditable]') ?? null) {
    if (formerEditors.has(node) || (node.parentElement?.isContentEditable ?? false)) return true;
  }
  return insideFormerEditor(html);
}

function insideFormerEditor(el: Element): boolean {
  if (!anyFormerEditor) return false;
  for (let node: Element | null = el; node; node = node.parentElement) if (formerEditors.has(node)) return true;
  return false;
}

/**
 * isEditorContent from attributes alone, for the observer callback: isContentEditable brings the
 * page's pending style recalc forward. Any contenteditable value counts; what this unwrites is
 * judged again in the drain.
 */
function nearEditor(el: Element): boolean {
  return document.designMode === 'on' || el.closest('[contenteditable]') != null || insideFormerEditor(el);
}

/**
 * An editor child of el to show as a light box. Its content keeps the site's colors, so on a
 * surface we darkened its dark text vanished, and our lightened text, inherited through the host,
 * sat on the editor's own light surfaces (VisualEditor's template boxes, a white editor pane).
 * An editor on a surface the site itself made dark was designed for it and is left as it is.
 */
function holdsEditorToBox(el: HTMLElement): boolean {
  let host = false;
  for (const child of el.children) {
    if (!child.hasAttribute('contenteditable')) continue;
    if (formerEditors.has(child) || (child instanceof HTMLElement && child.isContentEditable)) {
      host = true;
      break;
    }
  }
  return host && !siteDarkUnder(el);
}

/** The nearest surface at or above el is the site's own dark, not a light one we darken. */
function siteDarkUnder(el: Element): boolean {
  for (let node: Element | null = el; node; node = parentOf(node)) {
    // The canvas: decided already, and our own charcoal may be painted on <html>.
    if (node === document.documentElement) break;
    // Darkened in an earlier batch; one planned in this batch still reads as its own light color.
    if (saved.get(node)?.some((s) => s.prop === 'background-color')) return false;
    let cs: CSSStyleDeclaration;
    try {
      cs = getComputedStyle(node);
    } catch {
      return true;
    }
    const image = cs.backgroundImage;
    if (image && image !== 'none' && image.includes('url(')) {
      const box = node.getBoundingClientRect();
      // A photo behind the editor: we keep it, and the editor's text is the site's own choice.
      if (urlLayersCoverBox(image, cs.backgroundSize, cs.backgroundRepeat, box.width, box.height)) return true;
    }
    const lum = lumOf(cs.backgroundColor);
    if (lum != null) return lum < BG_KEEP_LUMINANCE;
  }
  return nativeDark;
}

function computePlan(el: Element, ctx: ReadCtx, plans: Plan[]): void {
  if (marked.set.has(el)) return;
  if (isEditorContent(el)) {
    marked.set.add(el);
    return;
  }
  if (el instanceof SVGSVGElement) {
    marked.set.add(el);
    planSvg(el, ctx, plans);
    return;
  }
  if (!(el instanceof HTMLElement)) {
    marked.set.add(el);
    return;
  }
  if (el instanceof HTMLImageElement) {
    marked.set.add(el);
    planImage(el, ctx, plans);
    return;
  }
  if (SKIP_TAGS.has(el.tagName)) {
    marked.set.add(el);
    return;
  }

  let cs: CSSStyleDeclaration;
  try {
    cs = getComputedStyle(el);
  } catch {
    return;
  }
  marked.set.add(el);

  const props: Array<[string, string]> = [];
  const ends = transitionEnds(el, cs);
  // On a natively dark page only light islands are surfaces we darken: accent buttons, badges
  // and a white CTA keep their color instead of being flattened into charcoal.
  const surface = !nativeDark || islandOf(el, ctx);

  // background-clip:text — the background IS the text paint; lighten, never darken.
  const clipText = cs.webkitBackgroundClip === 'text' || cs.backgroundClip === 'text';
  const bgColor = ends?.get('background-color') ?? cs.backgroundColor;
  const bg = clipText
    ? remapForegroundColor(bgColor)
    : surface
      ? remapBackgroundColor(bgColor)
      : null;
  if (bg) {
    props.push(['background-color', bg]);
    if (nativeDark && !clipText) islands.add(el);
  }
  const grad = clipText
    ? remapBackgroundImage(cs.backgroundImage, 'fg')
    : surface
      ? remapBackgroundImage(cs.backgroundImage, 'bg')
      : null;
  if (grad) props.push(['background-image', grad]);

  // Text: lighten only when the effective backdrop is (or becomes) dark.
  let backdrop: boolean | null = null;
  const onDark = (): boolean => (backdrop ??= isDarkBackdrop(el, ctx));
  const color = ends?.get('color') ?? cs.color;
  const fg = remapForegroundColor(color);
  if (fg && onDark()) props.push(['color', fg]);
  // -webkit-text-fill-color paints over `color`. Only an explicit one differs from it; the
  // default follows `color`, and writing it would pin every descendant to this element's color.
  const fill = cs.webkitTextFillColor;
  if (fill && fill !== color && fill !== cs.color) {
    const lifted = remapForegroundColor(fill);
    if (lifted && onDark()) props.push(['-webkit-text-fill-color', lifted]);
  }

  // Borders per side (the shorthand serializes multi-value and fails to parse).
  if (surface) {
    const sides: Array<[string, string]> = [
      ['border-top-color', cs.borderTopWidth],
      ['border-right-color', cs.borderRightWidth],
      ['border-bottom-color', cs.borderBottomWidth],
      ['border-left-color', cs.borderLeftWidth],
    ];
    for (const [prop, width] of sides) {
      if (parseFloat(width) <= 0) continue;
      const remapped = remapBorderColor(cs.getPropertyValue(prop));
      if (remapped) props.push([prop, remapped]);
    }
  }

  for (const [key, pseudo] of PSEUDOS) planPseudo(el, cs, key, pseudo, surface, onDark, props);
  if (holdsEditorToBox(el)) props.push([EDITOR_BOX, '1']);

  if (props.length) plans.push({ el, props });
}

/**
 * ::before/::after (B73): fades, dividers and icon glyphs with their own colors. Inline styles
 * cannot reach a pseudo-element, so the values go into inline custom properties that the shell's
 * attribute-selector rules apply (see pseudoRules).
 */
function planPseudo(
  el: HTMLElement,
  cs: CSSStyleDeclaration,
  key: string,
  pseudo: string,
  surface: boolean,
  onDark: () => boolean,
  props: Array<[string, string]>,
): void {
  let pcs: CSSStyleDeclaration;
  try {
    pcs = getComputedStyle(el, pseudo);
  } catch {
    return;
  }
  const content = pcs.content;
  if (!content || content === 'none' || content === 'normal') return;
  const name = (suffix: string): string => `--ssd-${key}-${suffix}`;

  const bg = surface ? remapBackgroundColor(pcs.backgroundColor) : null;
  if (bg) props.push([name('bgc'), bg]);
  const grad = surface ? remapBackgroundImage(pcs.backgroundImage, 'bg') : null;
  if (grad) props.push([name('bgi'), grad]);

  // Its text sits on its own surface when it paints one, else on the element's.
  const ownLum = lumOf(pcs.backgroundColor);
  const onDarkSurface = (): boolean =>
    ownLum != null ? bg != null || ownLum < BG_KEEP_LUMINANCE : onDark();
  // An inherited color follows the element's own override.
  if (pcs.color !== cs.color) {
    const c = remapForegroundColor(pcs.color);
    if (c && onDarkSurface()) props.push([name('c'), c]);
  }
  const fill = pcs.webkitTextFillColor;
  if (fill && fill !== pcs.color && fill !== cs.webkitTextFillColor) {
    const f = remapForegroundColor(fill);
    if (f && onDarkSurface()) props.push([name('tf'), f]);
  }
  if (!surface) return;
  const sides: Array<[string, string, string]> = [
    ['bt', 'border-top-color', pcs.borderTopWidth],
    ['br', 'border-right-color', pcs.borderRightWidth],
    ['bb', 'border-bottom-color', pcs.borderBottomWidth],
    ['bl', 'border-left-color', pcs.borderLeftWidth],
  ];
  for (const [suffix, prop, width] of sides) {
    if (parseFloat(width) <= 0) continue;
    const remapped = remapBorderColor(pcs.getPropertyValue(prop));
    if (remapped) props.push([name(suffix), remapped]);
  }
}

/**
 * Inline SVG: lift near-dark, low-chroma paint (monochrome icons, navy wordmarks, chart labels)
 * on the root and on shapes with their own fill/stroke — exported icons carry
 * `<path fill="#212121">`, which a root-only override never reached. Never touched: vivid
 * artwork, drawings that bring their own light surface (dark ink on it is intended), shapes
 * inside masks/clip paths/defs, and anything not sitting on a surface that ends dark.
 */
function planSvg(svg: SVGSVGElement, ctx: ReadCtx, plans: Plan[]): void {
  let cs: CSSStyleDeclaration;
  try {
    cs = getComputedStyle(svg);
  } catch {
    return;
  }
  const inkProps = (s: CSSStyleDeclaration): Array<[string, string]> | 'light' => {
    const out: Array<[string, string]> = [];
    for (const prop of ['fill', 'stroke'] as const) {
      const v = s[prop];
      if (!v || v === 'none' || v.startsWith('url(')) continue;
      if (prop === 'fill') {
        const lum = lumOf(v);
        if (lum != null && lum > 0.6) return 'light';
      }
      if (!isDarkInkColor(v)) continue;
      const light = remapForegroundColor(v);
      if (light) out.push([prop, light]);
    }
    return out;
  };

  const rootProps = inkProps(cs);
  if (rootProps === 'light') return;
  const kids: Plan[] = [];
  const shapes = svg.querySelectorAll(SVG_SHAPES);
  if (shapes.length <= SVG_MAX_SHAPES) {
    for (const shape of shapes) {
      if (!(shape instanceof SVGElement) || shape.closest(SVG_RESOURCES)) continue;
      let scs: CSSStyleDeclaration;
      try {
        scs = getComputedStyle(shape);
      } catch {
        continue;
      }
      const p = inkProps(scs);
      if (p === 'light') return;
      if (p.length) kids.push({ el: shape, props: p });
    }
  }
  if (!rootProps.length && !kids.length) return;
  if (!isDarkBackdrop(svg, ctx)) return;
  if (rootProps.length) plans.push({ el: svg, props: rootProps });
  if (kids.length) {
    svgKids.set(
      svg,
      kids.map((k) => k.el),
    );
    plans.push(...kids);
  }
}

function isSvgSource(src: string): boolean {
  if (/^data:image\/svg\+xml[,;]/i.test(src)) return true;
  try {
    return /\.svg$/i.test(new URL(src, location.href).pathname);
  } catch {
    return false;
  }
}

/** Pixels we may read without tainting the sample canvas. */
function canReadPixels(img: HTMLImageElement, src: string): boolean {
  if (/^(?:data|blob):/i.test(src) || img.crossOrigin != null) return true;
  try {
    return new URL(src, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

/** true: dark ink to invert; false: leave it; null: not loaded yet (its load event re-queues it). */
function inkVerdict(img: HTMLImageElement): boolean | null {
  if (img.matches(INK_HINT)) return true;
  const src = img.currentSrc || img.src;
  // Photos are raster; sampling a transparent product shot of a black shoe would invert it. Only
  // vector images are judged by their pixels — formulas, diagrams, logos, icons.
  if (!src || !isSvgSource(src)) return false;
  if (!img.complete) return null;
  const cached = inkCache.get(src);
  if (cached != null) return cached;
  if (inkSamples >= INK_SAMPLE_BUDGET || !canReadPixels(img, src)) return false;
  inkSamples++;
  let verdict = false;
  try {
    const canvas = new OffscreenCanvas(32, 32);
    const g = canvas.getContext('2d', { willReadFrequently: true });
    if (g) {
      g.drawImage(img, 0, 0, 32, 32);
      verdict = isDarkInkImage(g.getImageData(0, 0, 32, 32).data);
    }
  } catch {
    verdict = false; // tainted after all (a redirect), or undecodable
  }
  inkCache.set(src, verdict);
  return verdict;
}

function planImage(img: HTMLImageElement, ctx: ReadCtx, plans: Plan[]): void {
  if (!inkVerdict(img)) return;
  let cs: CSSStyleDeclaration;
  try {
    cs = getComputedStyle(img);
  } catch {
    return;
  }
  // The site's own dark theme already inverts it.
  if (cs.filter.includes('invert(')) return;
  if (!isDarkBackdrop(img, ctx)) return;
  const filter = cs.filter && cs.filter !== 'none' ? `${INVERT} ${cs.filter}` : INVERT;
  plans.push({ el: img, props: [['filter', filter]] });
}

function applyPlan(plan: Plan): void {
  const el = plan.el;
  const style = el.style;
  if (!origStyle.has(el)) origStyle.set(el, el.getAttribute('style'));
  const saves: SavedProp[] = saved.get(el) ?? [];
  for (const [prop, value] of plan.props) {
    const before = style.getPropertyValue(prop);
    const priority = style.getPropertyPriority(prop);
    style.setProperty(prop, value, 'important');
    saves.push({ prop, value: before, priority, applied: style.getPropertyValue(prop) });
  }
  saved.set(el, saves);
  const now = el.getAttribute('style');
  ourStyle.set(el, now);
  lastStyle.set(el, now);
  let ref = refFor.get(el);
  if (!ref) {
    ref = new WeakRef<Element>(el);
    refFor.set(el, ref);
    cleanup.register(el, ref);
  }
  registry.add(ref);
}

// ---------------------------------------------------------------------------
// Style attribute bookkeeping
// ---------------------------------------------------------------------------

let scratch: CSSStyleDeclaration | null = null;

/** Parsed declarations of a style attribute: property → [value, priority]. */
function declarations(text: string | null): Map<string, [string, string]> {
  const out = new Map<string, [string, string]>();
  if (!text) return out;
  scratch ??= document.createElement('div').style;
  scratch.cssText = text;
  for (let i = 0; i < scratch.length; i++) {
    const p = scratch.item(i);
    out.set(p, [scratch.getPropertyValue(p), scratch.getPropertyPriority(p)]);
  }
  return out;
}

function isColorKeyword(word: string): boolean {
  try {
    return CSS.supports('color', word);
  } catch {
    return true;
  }
}

/** What a site write to a style attribute changed, as far as colors are concerned. */
function styleChange(before: string | null, after: string | null): { colors: boolean; vars: boolean } {
  const a = declarations(before);
  const b = declarations(after);
  let colors = false;
  let vars = false;
  const check = (prop: string, va?: [string, string], vb?: [string, string]): void => {
    if (va && vb && va[0] === vb[0] && va[1] === vb[1]) return;
    if (prop.startsWith('--')) {
      const colorish = (d?: [string, string]): boolean => !!d && mightBeColorValue(d[0], isColorKeyword);
      if (colorish(va) || colorish(vb)) vars = true;
    } else if (isColorRelevantProperty(prop)) {
      colors = true;
    }
  };
  for (const [p, d] of a) check(p, d, b.get(p));
  for (const [p, d] of b) if (!a.has(p)) check(p, undefined, d);
  return { colors, vars };
}

function setStyleAttribute(el: Element, value: string | null): void {
  if (value == null) el.removeAttribute('style');
  else el.setAttribute('style', value);
}

/** Roll back our overrides on one element, keeping everything the site wrote since. */
function restoreElement(el: Element): void {
  const kids = svgKids.get(el);
  if (kids) {
    svgKids.delete(el);
    for (const k of kids) restoreElement(k);
  }
  islands.delete(el);
  const saves = saved.get(el);
  if (!saves) return;
  const style = (el as Styled).style;
  const cur = el.getAttribute('style');
  const ours = ourStyle.get(el);
  const orig = origStyle.get(el);
  if (orig !== undefined && ours !== undefined) {
    // Put back the site's own attribute text. Per-longhand restore could not: a longhand read
    // out of `background: var(--bg)` is '', so it was removed and the shorthand lost (B71).
    // Whatever the site changed since our write is replayed on top — its newer intent wins.
    const edits = cur === ours ? null : diffDeclarations(ours, cur);
    setStyleAttribute(el, orig);
    if (edits) {
      for (const [prop, value, priority] of edits.set) style.setProperty(prop, value, priority);
      for (const prop of edits.removed) style.removeProperty(prop);
    }
  } else {
    for (const s of saves) {
      if (style.getPropertyValue(s.prop) !== s.applied) continue;
      if (s.value) style.setProperty(s.prop, s.value, s.priority || undefined);
      else style.removeProperty(s.prop);
    }
  }
  saved.delete(el);
  origStyle.delete(el);
  ourStyle.delete(el);
  lastStyle.set(el, el.getAttribute('style'));
  // Nothing of ours is on the element any more, so it does not belong in the restore set.
  const ref = refFor.get(el);
  if (ref) registry.delete(ref);
}

/** Take every override of ours out of a subtree that is (now) editor content, and judge it again. */
function unwriteSubtree(root: Element): void {
  for (const el of subtreeOf(root)) {
    restoreElement(el);
    marked.set.delete(el);
  }
}

function diffDeclarations(
  before: string | null,
  after: string | null,
): { set: Array<[string, string, string]>; removed: string[] } {
  const a = declarations(before);
  const b = declarations(after);
  const set: Array<[string, string, string]> = [];
  const removed: string[] = [];
  for (const [p, [v, pr]] of b) {
    const old = a.get(p);
    if (!old || old[0] !== v || old[1] !== pr) set.push([p, v, pr]);
  }
  for (const p of a.keys()) if (!b.has(p)) removed.push(p);
  return { set, removed };
}

// ---------------------------------------------------------------------------
// Walks, shadow roots, queue + drain
// ---------------------------------------------------------------------------

const OBSERVE_OPTS: MutationObserverInit = {
  childList: true,
  subtree: true,
  attributes: true,
  attributeOldValue: true,
  attributeFilter: [...THEME_ATTRIBUTE_FILTER],
};

/** Open shadow root, or a closed one where the extension API can reach it. */
function shadowOf(el: Element): ShadowRoot | null {
  const open = el.shadowRoot;
  if (open) return open;
  // Closed roots are looked up for custom elements only: the API call is not free.
  if (!el.localName.includes('-')) return null;
  try {
    const api = (globalThis as { chrome?: typeof chrome }).chrome?.dom?.openOrClosedShadowRoot;
    return (api && el instanceof HTMLElement ? api(el) : null) ?? null;
  } catch {
    return null;
  }
}

/** Observe a shadow root the walk found: later renders and theme flips inside it (B70). */
function adoptShadow(sr: ShadowRoot): void {
  if (observedRoots.set.has(sr)) return;
  observedRoots.set.add(sr);
  observer?.observe(sr, OBSERVE_OPTS);
}

/** A custom element that is not defined yet attaches its shadow root when it upgrades. */
function noteUpgrade(el: Element): void {
  if (!el.localName.includes('-') || awaitingUpgrade.has(el)) return;
  try {
    if (el.matches(':defined')) return;
  } catch {
    return;
  }
  awaitingUpgrade.set(el, performance.now());
  if (!upgradeTimer) {
    upgradeDelay = 250;
    armUpgradeTimer();
  }
}

function armUpgradeTimer(): void {
  const gen = engineGen;
  upgradeTimer = window.setTimeout(() => {
    upgradeTimer = 0;
    if (gen === engineGen && active) checkUpgrades();
  }, upgradeDelay);
}

function checkUpgrades(): void {
  const found: Element[] = [];
  const now = performance.now();
  for (const [el, since] of awaitingUpgrade) {
    const sr = el.isConnected ? shadowOf(el) : null;
    if (sr) {
      awaitingUpgrade.delete(el);
      adoptShadow(sr);
      collect(sr, found);
      continue;
    }
    let defined = false;
    try {
      defined = el.matches(':defined');
    } catch {
      defined = true;
    }
    // Defined without a shadow root (a light-DOM element), gone, or never defined after a minute.
    if (defined || !el.isConnected || now - since > 60000) awaitingUpgrade.delete(el);
  }
  if (found.length) enqueue(found);
  if (awaitingUpgrade.size) {
    upgradeDelay = Math.min(upgradeDelay * 2, 8000);
    armUpgradeTimer();
  }
}

function collect(root: ParentNode, out: Element[]): void {
  const scopes: ParentNode[] = [root];
  const take = (el: Element): void => {
    if ((el instanceof HTMLElement || el instanceof SVGSVGElement) && !marked.set.has(el)) out.push(el);
    const sr = shadowOf(el);
    if (sr) {
      adoptShadow(sr);
      scopes.push(sr);
    } else {
      noteUpgrade(el);
    }
  };
  // The root's own shadow root too: an added custom element's content lives there (B70).
  if (root instanceof Element) take(root);
  while (scopes.length) {
    const scope = scopes.pop()!;
    for (const el of scope.querySelectorAll('*')) take(el);
  }
}

/** Root + its whole subtree, shadow roots included, for a reprocess. */
function subtreeOf(root: Element): Element[] {
  const out: Element[] = [];
  const scopes: ParentNode[] = [root];
  const take = (el: Element): void => {
    if (el instanceof HTMLElement || el instanceof SVGSVGElement) out.push(el);
    const sr = shadowOf(el);
    if (sr) {
      adoptShadow(sr);
      scopes.push(sr);
    }
  };
  take(root);
  while (scopes.length) {
    const scope = scopes.pop()!;
    for (const el of scope.querySelectorAll('*')) take(el);
  }
  return out;
}

function enqueue(els: Iterable<Element>): void {
  for (const el of els) pending.add(el);
  scheduleDrain();
}

function requestSubtree(el: Element): void {
  pendingRoots.add(el);
  scheduleDrain();
}

/** A stylesheet came, went or changed: everything it styles may have new colors (B66). */
function requestSheetReprocess(node: Node): void {
  const root = node.getRootNode();
  if (root instanceof ShadowRoot) requestSubtree(root.host);
  else if (document.documentElement) requestSubtree(document.documentElement);
}

/** Re-read again once Chromium has swapped in the sheet a <link> attribute change asked for. */
function watchLinkSwap(link: HTMLLinkElement): void {
  linkSwaps.set(link, { sheet: link.sheet, until: performance.now() + LINK_SWAP_WAIT_MS });
  if (!linkSwapTimer) linkSwapTimer = window.setTimeout(checkLinkSwaps, 16);
}

function checkLinkSwaps(): void {
  linkSwapTimer = 0;
  if (!active) return;
  const now = performance.now();
  for (const [link, seen] of linkSwaps) {
    if (link.sheet !== seen.sheet) {
      linkSwaps.delete(link);
      requestSheetReprocess(link);
    } else if (now > seen.until || !link.isConnected) {
      linkSwaps.delete(link);
    }
  }
  if (linkSwaps.size) linkSwapTimer = window.setTimeout(checkLinkSwaps, 16);
}

const PSEUDO_ELEMENT = /::?(?:before|after|placeholder|marker|selection|first-line|first-letter|backdrop|file-selector-button|-webkit-[a-z-]+|-moz-[a-z-]+)(?![\w-])/gi;

/**
 * The elements a newly added <style> can restyle, or null when that is not cheap to tell.
 *
 * Component frameworks (Angular, Svelte, Vue without extraction) add a <style> per component
 * the first time it renders, and a whole-document re-walk per route change on a 20k-element
 * page is seconds of work. Their rules match a handful of elements: re-walk only those.
 */
function styleTargets(style: HTMLStyleElement): Element[] | null {
  let rules: CSSRuleList | undefined;
  try {
    rules = style.sheet?.cssRules;
  } catch {
    return null;
  }
  if (!rules) return null;
  const selectors: string[] = [];
  let budget = 200;
  const visit = (list: CSSRuleList): boolean => {
    for (const rule of list) {
      if (--budget < 0 || rule instanceof CSSImportRule) return false;
      if (rule instanceof CSSStyleRule) {
        // CSS nesting (&) and relative selectors need their parent rule: not worth resolving.
        if (rule.selectorText.includes('&') || rule.cssRules.length) return false;
        selectors.push(rule.selectorText.replace(PSEUDO_ELEMENT, ''));
      } else if (rule instanceof CSSGroupingRule) {
        if (!visit(rule.cssRules)) return false;
      }
      // @font-face, @keyframes, @property and the like restyle no element's colors.
    }
    return true;
  };
  if (!visit(rules)) return null;
  const found = new Set<Element>();
  for (const selector of selectors) {
    try {
      for (const el of document.querySelectorAll(selector.trim() || '*')) {
        found.add(el);
        if (found.size > 2000) return null;
      }
    } catch {
      return null;
    }
  }
  return [...found];
}

/** Re-walk what an added <style> restyles; the whole document when that cannot be narrowed. */
function requestStyleReprocess(style: HTMLStyleElement): void {
  const targets = style.getRootNode() instanceof ShadowRoot ? null : styleTargets(style);
  if (!targets) {
    requestSheetReprocess(style);
    return;
  }
  // Top-most matches only: a match inside another is covered by its subtree.
  targets.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  let kept: Element | null = null;
  const roots: Element[] = [];
  for (const el of targets) {
    if (kept?.contains(el)) continue;
    kept = el;
    roots.push(el);
  }
  if (roots.length > 200) {
    requestSheetReprocess(style);
    return;
  }
  for (const root of roots) requestSubtree(root);
}

function requestReprocess(el: Element): void {
  needsReprocess.add(el);
  enqueue([el]);
}

function scheduleDrain(): void {
  if (drainScheduled || !active) return;
  if (pending.size === 0 && pendingRoots.size === 0 && interactive.size === 0) return;
  drainScheduled = true;
  const gen = engineGen;
  const cb = (): void => {
    drainScheduled = false;
    drainTimer = 0;
    drainRaf = 0;
    if (gen !== engineGen || !active) return;
    drain();
  };
  // rAF doesn't fire in hidden tabs — fall back to a timer so background tabs still darken.
  if (document.hidden) drainTimer = window.setTimeout(cb, 120);
  else drainRaf = requestAnimationFrame(cb);
}

/**
 * When the next big re-walk may start: never while one is still draining, and then only after
 * a pause at least as long as the last one took, so a page that keeps swapping styles gets at
 * most half the main thread from us.
 */
function nextBigWalkAt(): number {
  if (bigWalkStart >= 0) return Infinity;
  return bigWalkEnd + Math.max(SUBTREE_INTERVAL_MS, bigWalkCost);
}

function armSubtreeTimer(): void {
  // A walk still draining re-arms this when it finishes (drain()).
  if (subtreeTimer || !active || bigWalkStart >= 0) return;
  const gen = engineGen;
  const wait = Math.max(0, nextBigWalkAt() - performance.now());
  subtreeTimer = window.setTimeout(() => {
    subtreeTimer = 0;
    if (gen === engineGen) scheduleDrain();
  }, wait);
}

/**
 * Expand subtree-reprocess roots queued by the observer.
 *
 * The walk used to run synchronously inside the MutationObserver callback, so a site that
 * assigns `document.documentElement.className` from a scroll handler (an unconditional
 * assignment emits a record on every event) queued `querySelectorAll('*')` over the whole
 * document per scroll tick. Deferring to the drain lets a burst of records collapse into one
 * walk, and dropping roots contained by another root avoids re-walking the same nodes. A big
 * subtree is re-walked at most once per SUBTREE_INTERVAL_MS, and never over another (B72): the
 * first change applies at once, a burst after it gets one trailing walk.
 */
function expandPendingRoots(): void {
  if (!pendingRoots.size) return;
  const roots = [...pendingRoots];
  pendingRoots.clear();
  const now = performance.now();
  const bigAllowed = now >= nextBigWalkAt();
  let tookBig = false;
  for (const root of roots) {
    if (!root.isConnected) continue;
    if (roots.some((other) => other !== root && other.isConnected && other.contains(root))) continue;
    const els = subtreeOf(root);
    if (els.length > SMALL_SUBTREE) {
      if (!bigAllowed) {
        pendingRoots.add(root);
        continue;
      }
      tookBig = true;
    }
    for (const el of els) {
      needsReprocess.add(el);
      pending.add(el);
    }
  }
  if (tookBig) bigWalkStart = now;
}

/**
 * Hover/focus chains: the element entered or left, its ancestors (a `li:hover > a` rule paints
 * above the target) and, when small, its subtree (`.menu:hover a`). Re-read first, so the state
 * change is recolored on the next frame instead of after a page's worth of queue (B69).
 */
function expandInteractive(batch: Element[]): void {
  if (!interactive.size) return;
  const chain = new Set<Element>();
  for (const target of interactive) {
    if (!target.isConnected) continue;
    let node: Element | null = target;
    for (let depth = 0; node && depth < 8; depth++) {
      if (node === document.body || node === document.documentElement) break;
      chain.add(node);
      node = parentOf(node);
    }
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_ELEMENT);
    const kids: Element[] = [];
    while (walker.nextNode() && kids.length <= 64) kids.push(walker.currentNode as Element);
    if (kids.length <= 64) for (const k of kids) chain.add(k);
  }
  interactive.clear();
  for (const el of chain) {
    const sr = shadowOf(el);
    if (sr && !observedRoots.set.has(sr)) {
      const found: Element[] = [];
      adoptShadow(sr);
      collect(sr, found);
      for (const f of found) pending.add(f);
    }
    if (!(el instanceof HTMLElement || el instanceof SVGSVGElement)) continue;
    needsReprocess.add(el);
    pending.delete(el);
    batch.push(el);
  }
}

function drain(): void {
  // designMode switches on with no DOM mutation to see; every drain looks.
  if (editorDocument()) return;
  expandPendingRoots();
  const batch: Element[] = [];
  expandInteractive(batch);
  const limit = document.hidden ? HIDDEN_BATCH_SIZE : BATCH_SIZE;
  for (const el of pending) {
    if (batch.length >= limit) break;
    batch.push(el);
    pending.delete(el);
  }

  // ROLLBACK phase — elements flagged after a class/style flip get our overrides removed and
  // their mark cleared, so the read phase below sees the site's fresh colors.
  let recheck = false;
  for (const el of batch) {
    if (needsReprocess.has(el)) {
      needsReprocess.delete(el);
      restoreElement(el);
      marked.set.delete(el);
      if (el === document.documentElement) recheck = true;
    }
  }
  if (recheck) recheckCanvas(batch);

  // READ phase — all computed-style access, zero writes (no recalc thrash)…
  const ctx: ReadCtx = { bg: new Map(), island: new Map() };
  const plans: Plan[] = [];
  for (const el of batch) computePlan(el, ctx, plans);
  // …then WRITE phase.
  for (const plan of plans) applyPlan(plan);

  if (pending.size > 0 || interactive.size > 0) {
    scheduleDrain();
  } else {
    if (bigWalkStart >= 0) {
      bigWalkEnd = performance.now();
      bigWalkCost = bigWalkEnd - bigWalkStart;
      bigWalkStart = -1;
    }
    if (!initialStormDone) finishStorm();
  }
  if (pendingRoots.size) armSubtreeTimer();
}

/**
 * Initial styling storm is over — stop suppressing transitions (which would otherwise paint a
 * multi-second staggered fade wave as batches land).
 */
function finishStorm(): void {
  initialStormDone = true;
  refreshShell();
  liftScrim();
}

/**
 * A document-wide reprocess (theme switch, stylesheet swap, OS scheme flip) may have turned a
 * light page dark or back: decide the canvas again from the site's own html/body colors.
 */
function recheckCanvas(batch: Element[]): void {
  const body = document.body;
  if (body && needsReprocess.has(body)) {
    needsReprocess.delete(body);
    restoreElement(body);
    marked.set.delete(body);
    if (pending.delete(body)) batch.push(body);
  }
  decideCanvas();
  refreshShell();
}

/**
 * Drop the document_start scrim once the page is actually recolored.
 *
 * The scrim in dark-mode.css hides the site's own (usually white) `body` background during the
 * window before the engine reaches it. It has a CSS fallback that lifts it regardless after
 * 1.4s, so this is the fast path, not the only path — never the sole thing standing between the
 * user and a visible page.
 */
function liftScrim(): void {
  document.documentElement?.setAttribute(READY_ATTR, '');
}

/**
 * The timer path of the scrim lift, for "engine started, then threw mid-drain". A hidden tab
 * shows nothing, so there it waits for the page to be done or shown: lifting on schedule let an
 * unfinished page paint white patches when the user switched to it.
 */
function scrimFallback(gen: number): void {
  if (gen !== engineGen || !active) return;
  if (document.hidden && !initialStormDone) {
    window.setTimeout(() => scrimFallback(gen), 1000);
    return;
  }
  liftScrim();
}

// ---------------------------------------------------------------------------
// Shell / observers / interaction / print
// ---------------------------------------------------------------------------

/**
 * ::before/::after overrides. The engine sets each value as an inline custom property on the
 * originating element, and these rules select exactly the elements whose style attribute carries
 * it — a descendant inherits the value but not the attribute text, so its own pseudo-elements are
 * left alone. The pseudo-element inherits the value from its originating element.
 *
 * Deliberately not @property + style() container queries: registering sixteen non-inherited
 * properties made every style recalc after a root custom-property write about ten times slower.
 */
function pseudoRules(): string {
  let css = '';
  for (const [key, pseudo] of PSEUDOS) {
    for (const [suffix, prop] of PSEUDO_PROPS) {
      const v = `--ssd-${key}-${suffix}`;
      css += `\n  [style*="${v}:"]${pseudo} { ${prop}: var(${v}) !important; }`;
    }
  }
  return css;
}

/**
 * Editors in a page we darken are shown as a light box: their content is never written into, so
 * it keeps the site's own colors and needs the site's light surface under it. The marker sits on
 * the host's parent, outside what the editor saves. Zero specificity: a background or color the
 * site gives the host itself wins (a white editor pane, a dark code editor), and only what the
 * host would inherit from our darkened surroundings is replaced. Any contenteditable value, so an
 * editor switched to read-only keeps its box (holdsEditorToBox decides which parents get one).
 */
function editorBoxRule(): string {
  return `\n  :where([style*="${EDITOR_BOX}:"] > [contenteditable]) { color-scheme: light; background-color: Canvas; color: CanvasText; }`;
}

function shellCss(): string {
  // @media screen so print keeps the site's light output. Placeholder default covers the
  // common dark ::placeholder (inline styles cannot target pseudo-elements).
  const suppress = initialStormDone
    ? ''
    : `\n  * { transition-duration: 0s !important; }`;
  // Guarded like the registered sheet, so siteCanvasIsDark() can read the site's own canvas.
  const canvas = withShell
    ? `\n  html:not([${OFF_ATTR}]) { background-color: ${ROOT_BG} !important; }`
    : '';
  // Every frame, shell or not (B64): an <iframe> element inherits the top page's
  // color-scheme: dark, and when the embedded root does not match it Chromium paints an opaque
  // light canvas behind the frame — transparent embeds became white boxes with lightened text.
  return `@media screen {
  :root { color-scheme: dark !important; }${canvas}
  input::placeholder, textarea::placeholder { color: ${ROOT_FG.replace('rgb', 'rgba').replace(')', ', 0.55)')} !important; }${pseudoRules()}${editorBoxRule()}${suppress}
}`;
}

function shellElement(): HTMLStyleElement | null {
  return document.querySelector(`style[data-stampstack="${SHELL_STYLE}"]`);
}

function refreshShell(): void {
  const el = shellElement();
  if (el) el.textContent = shellCss();
}

function injectShell(): void {
  let el = shellElement();
  if (!el) {
    el = document.createElement('style');
    el.setAttribute('data-stampstack', SHELL_STYLE);
    (document.head || document.documentElement).appendChild(el);
  }
  el.textContent = shellCss();
}

function isShell(node: Node): boolean {
  return node instanceof HTMLStyleElement && node.getAttribute('data-stampstack') === SHELL_STYLE;
}

function isStylesheetNode(node: Node): boolean {
  return (
    (node instanceof HTMLStyleElement && !isShell(node)) ||
    (node instanceof HTMLLinkElement && /\bstylesheet\b/i.test(node.rel))
  );
}

function observeRootTargets(): void {
  const opts: MutationObserverInit = { attributes: true, attributeOldValue: true };
  if (document.documentElement) rootObserver?.observe(document.documentElement, opts);
  if (document.body) rootObserver?.observe(document.body, opts);
}

function onMutations(records: MutationRecord[]): void {
  if (!active) return;
  const added: Element[] = [];
  const styleBefore = new Map<Element, string | null>();
  for (const r of records) {
    if (r.type === 'childList') {
      if (r.target instanceof HTMLStyleElement) {
        if (isShell(r.target)) continue;
        // Text appended (CSS-in-JS) adds rules; text replaced (theme scripts) can also take
        // away rules whose elements the new text no longer names.
        if (r.removedNodes.length) requestSheetReprocess(r.target);
        else requestStyleReprocess(r.target);
        continue;
      }
      for (const node of r.addedNodes) {
        if (!(node instanceof Element)) continue;
        // A <link> applies when it loads (onLoadCapture); a <style> applies at once.
        if (isStylesheetNode(node)) {
          if (node instanceof HTMLStyleElement) requestStyleReprocess(node);
          continue;
        }
        // document.open() (about:blank frames written by their parent) replaces the root, and
        // an iframe editor writes itself in exactly that way.
        if (node === document.documentElement || node === document.body) {
          if (editorDocument()) return;
          if (node === document.documentElement) injectShell();
          observeRootTargets();
        }
        // An element we recolored, moved into an editor: its styles would be saved with it.
        if (nearEditor(node)) unwriteSubtree(node);
        // A new editor: its parent decides the light box.
        if (node.hasAttribute('contenteditable') && r.target instanceof HTMLElement) requestReprocess(r.target);
        collect(node, added);
      }
      for (const node of r.removedNodes) {
        if (isStylesheetNode(node)) requestSheetReprocess(r.target);
      }
      continue;
    }
    const el = r.target;
    if (!(el instanceof Element)) continue;
    const name = r.attributeName ?? '';
    if (name === 'style') {
      if (!styleBefore.has(el)) {
        styleBefore.set(el, lastStyle.has(el) ? (lastStyle.get(el) ?? null) : r.oldValue);
      }
      continue;
    }
    // An unconditional re-assignment of the same value (scroll handlers do this per event).
    if (el.getAttribute(name) === r.oldValue) continue;
    if (name === 'contenteditable') {
      if (onEditableChange(el, r.oldValue)) return;
      continue;
    }
    if (el instanceof HTMLLinkElement || el instanceof HTMLStyleElement) {
      if (STYLESHEET_ATTRS.has(name) && !isShell(el)) {
        requestSheetReprocess(el);
        if (el instanceof HTMLLinkElement) watchLinkSwap(el);
      }
      continue;
    }
    if (name === 'href' || name === 'media' || name === 'rel') continue;
    // Colors may be different now. Class and state flips often drive CSS variables or
    // descendant selectors, changing computed colors across the whole subtree with no mutation
    // on the descendants (Stripe's header theme does exactly this) — reprocess the subtree.
    requestSubtree(el);
  }
  for (const [el, before] of styleBefore) {
    const after = el.getAttribute('style');
    // Our own write — the attribute is exactly what we left (B68: comparing only the values we
    // set swallowed a site's `--card-bg` write on any element we had recolored).
    if (after === before) continue;
    lastStyle.set(el, after);
    const change = styleChange(before, after);
    if (change.vars) requestSubtree(el);
    else if (change.colors) {
      needsReprocess.add(el);
      added.push(el);
    }
  }
  if (added.length) enqueue(added);
}

/** Every attribute on html/body: theme switches use names no fixed list keeps up with (B67). */
function onRootMutations(records: MutationRecord[]): void {
  if (!active) return;
  for (const r of records) {
    const name = r.attributeName;
    if (!name || name.startsWith('data-stampstack') || WATCHED_ATTRS.has(name)) continue;
    const el = r.target as Element;
    const now = el.getAttribute(name);
    if (now === r.oldValue) continue;
    if (!THEME_LIKE.test(name) && !THEME_LIKE.test(now ?? '') && !THEME_LIKE.test(r.oldValue ?? '')) {
      continue;
    }
    requestSubtree(el);
  }
}

function onSchemeChange(): void {
  // Sites styled with @media (prefers-color-scheme) swap palettes with no DOM mutation (B67).
  if (active && document.documentElement) requestSubtree(document.documentElement);
}

function onLoadCapture(e: Event): void {
  if (!active) return;
  const t = e.target;
  if (t instanceof HTMLLinkElement) {
    // loadCSS / WP Rocket (`media=print` then `onload`), or a theme sheet that just arrived.
    if (/\bstylesheet\b/i.test(t.rel)) requestSheetReprocess(t);
  } else if (t instanceof HTMLImageElement) {
    requestReprocess(t); // lazy or swapped image: judge it for dark ink now that it has pixels
  }
}

function eventElement(e: Event): Element | null {
  const first = e.composedPath()[0];
  if (first instanceof Element) return first;
  return e.target instanceof Element ? e.target : null;
}

function onInteraction(e: Event): void {
  if (!active) return;
  const t = eventElement(e);
  if (t) interactive.add(t);
  const related = (e as MouseEvent | FocusEvent).relatedTarget;
  if (related instanceof Element) interactive.add(related);
  if (interactive.size) scheduleDrain();
}

function onVisibility(): void {
  // Shown again with work waiting on a throttled timer: switch to frames now.
  if (document.hidden || !drainTimer) return;
  window.clearTimeout(drainTimer);
  drainTimer = 0;
  drainScheduled = false;
  scheduleDrain();
}

const INTERACTION_EVENTS = ['mouseover', 'mouseout', 'focusin', 'focusout'] as const;

/** The first edit in a document switched to designMode after our pass: stand down before it lands. */
function onEditIntent(): void {
  if (active) editorDocument();
}

const isEditableValue = (v: string | null | undefined): boolean => v != null && v.toLowerCase() !== 'false';

/**
 * An editor switched on or off after our pass (TinyMCE sets contenteditable after document.write,
 * CKEditor 5 on the element it takes over). Our writes come out of it now rather than in a drain
 * that may be rate-limited: the editor reads its content straight away. true: the whole document
 * turned out to be the editor, and the engine stood down.
 */
function onEditableChange(el: Element, old: string | null): boolean {
  if (isEditableValue(old)) {
    formerEditors.add(el);
    anyFormerEditor = true;
  }
  if (editorDocument()) return true;
  if (isEditableValue(el.getAttribute('contenteditable')) || formerEditors.has(el)) unwriteSubtree(el);
  if (el.parentElement) requestReprocess(el.parentElement);
  requestSubtree(el);
  return false;
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
    applyDynamicDark(topFrame);
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The site's OWN canvas color, read with the registered sheet and our canvas disarmed via the
 *  same data-stampstack-off attribute their selectors guard on. */
function siteCanvasIsDark(): boolean {
  const html = document.documentElement;
  if (!html) return false;
  const hadOff = html.hasAttribute(OFF_ATTR);
  if (!hadOff) html.setAttribute(OFF_ATTR, '');
  try {
    const hb = parseCssColor(getComputedStyle(html).backgroundColor);
    if (hb && hb.a >= 0.5) return relativeLuminance(hb.r, hb.g, hb.b) < 0.15;
    const body = document.body;
    if (body) {
      const bb = parseCssColor(getComputedStyle(body).backgroundColor);
      if (bb && bb.a >= 0.5) return relativeLuminance(bb.r, bb.g, bb.b) < 0.15;
    }
    return false;
  } finally {
    if (!hadOff) html.removeAttribute(OFF_ATTR);
  }
}

/**
 * Natively dark sites keep their own canvas: no charcoal shell, and in the top frame the
 * registered document_start sheet is disarmed too — its !important #1c1c1e replaced e.g.
 * GitHub's #0d1117 for as long as dark mode was on. Subframes never get that sheet.
 */
function decideCanvas(): void {
  nativeDark = siteCanvasIsDark();
  withShell = topFrame && !nativeDark;
  const html = document.documentElement;
  if (!topFrame || !html) return;
  if (nativeDark && !html.hasAttribute(OFF_ATTR)) {
    html.setAttribute(OFF_ATTR, '');
    setOffAttr = true;
  } else if (!nativeDark && setOffAttr) {
    html.removeAttribute(OFF_ATTR);
    setOffAttr = false;
  }
}

/**
 * This document is itself the editor: an iframe editor's contenteditable body (TinyMCE, CKEditor
 * 4) or designMode. The engine stands down and leaves it as the site drew it, with nothing written
 * inside: no inline colors, no shell, no attributes (stopping later writes none either). With our
 * color-scheme: dark in it, Chromium painted no canvas behind the frame, and TinyMCE's colorless
 * text turned white on its white <iframe>; left alone, the frame paints its own light canvas, a
 * light box on the dark page. It stays down while the engine is on: an editor switched to
 * read-only still saves its content. Attribute reads only, so every drain can ask.
 */
function editorDocument(): boolean {
  if (editorDoc) return true;
  if (
    document.designMode !== 'on' &&
    !isEditableValue(document.body?.getAttribute('contenteditable')) &&
    !isEditableValue(document.documentElement?.getAttribute('contenteditable'))
  ) {
    return false;
  }
  editorDoc = true;
  teardown();
  const html = document.documentElement;
  if (topFrame && html) {
    // The registered sheet (top frame only) is disarmed as for a natively dark page.
    if (!html.hasAttribute(OFF_ATTR)) {
      html.setAttribute(OFF_ATTR, '');
      setOffAttr = true;
    }
    liftScrim();
  } else {
    html?.removeAttribute(READY_ATTR); // an earlier pass's; nothing reads it in a subframe
  }
  return true;
}

/** Turn the dynamic dark engine on for this frame. Idempotent.
 *  `shell` (top frame only) paints the charcoal canvas; subframes keep transparent backgrounds
 *  transparent (overlay iframes would otherwise become opaque dark slabs). Natively-dark pages
 *  keep their own canvas. */
export function applyDynamicDark(shell: boolean): void {
  if (active) return;
  active = true;
  engineGen++;
  topFrame = shell;
  editorDoc = false;
  initialStormDone = false;
  // Dark mode is on here: arm the registered sheet again (the off path disarmed it), then
  // disarm it only if the page turns out to be natively dark.
  if (topFrame) document.documentElement?.removeAttribute(OFF_ATTR);
  setOffAttr = false;
  hookPrint();
  if (editorDocument()) return;
  decideCanvas();
  injectShell();

  // Third, independent scrim lift. The engine reporting its first drain is the fast path and
  // the CSS animation in dark-mode.css is the "engine never started" path — but CSS animations
  // are throttled in background tabs, and neither covers "engine started, then threw mid-drain".
  // A plain timer does, and costs nothing when the normal path wins the race.
  const gen = engineGen;
  window.setTimeout(() => scrimFallback(gen), 1600);

  // Observers first: the walk below adopts every shadow root it finds into `observer`.
  observer = new MutationObserver(onMutations);
  // The document, not its root element: document.open() swaps the root out from under us.
  observer.observe(document, OBSERVE_OPTS);
  rootObserver = new MutationObserver(onRootMutations);
  observeRootTargets();

  const els: Element[] = [];
  collect(document, els);
  enqueue(els);

  for (const type of INTERACTION_EVENTS) document.addEventListener(type, onInteraction, true);
  document.addEventListener('load', onLoadCapture, true);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('beforeinput', onEditIntent, true);
  try {
    schemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    schemeQuery.addEventListener('change', onSchemeChange);
  } catch {
    schemeQuery = null;
  }
}

/** Turn it off and restore original inline colors (including nodes detached while dark). */
export function stopDynamicDark(): void {
  if (!active) return;
  // Toggling off mid-load must not leave the scrim covering the page waiting for its timer.
  if (!editorDoc) liftScrim();
  active = false;
  editorDoc = false;
  teardown();
}

/** Observers, listeners, timers, queues and the shell go; every override of ours is restored. */
function teardown(): void {
  engineGen++;
  observer?.disconnect();
  observer = null;
  rootObserver?.disconnect();
  rootObserver = null;
  schemeQuery?.removeEventListener('change', onSchemeChange);
  schemeQuery = null;
  for (const type of INTERACTION_EVENTS) document.removeEventListener(type, onInteraction, true);
  document.removeEventListener('load', onLoadCapture, true);
  document.removeEventListener('visibilitychange', onVisibility);
  document.removeEventListener('beforeinput', onEditIntent, true);
  window.clearTimeout(drainTimer);
  window.clearTimeout(subtreeTimer);
  window.clearTimeout(upgradeTimer);
  window.clearTimeout(linkSwapTimer);
  if (drainRaf) cancelAnimationFrame(drainRaf);
  drainTimer = 0;
  drainRaf = 0;
  subtreeTimer = 0;
  upgradeTimer = 0;
  linkSwapTimer = 0;
  linkSwaps.clear();
  pending.clear();
  pendingRoots.clear();
  interactive.clear();
  awaitingUpgrade.clear();
  drainScheduled = false;
  bigWalkStart = -1;
  bigWalkEnd = -Infinity;
  bigWalkCost = 0;
  shellElement()?.remove();
  if (setOffAttr) {
    document.documentElement?.removeAttribute(OFF_ATTR);
    setOffAttr = false;
  }

  for (const ref of registry) {
    const el = ref.deref();
    if (el) restoreElement(el);
    registry.delete(ref);
  }
  marked.set = new WeakSet<Element>();
  observedRoots.set = new WeakSet<ShadowRoot>();
}
