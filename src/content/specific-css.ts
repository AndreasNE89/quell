// Hostname-specific hide/unhide stylesheet, plus the rules the procedural runner injects. Replaced
// on every cosmetic:refresh so removing the last custom rule (or allowlisting the page) actually
// clears the hide.

const ATTR = 'data-StampStack';
const VALUE = 'cosmetic';

/**
 * Selectors per emitted rule. Blink stops reading a rule's selector list after 8,192 components,
 * and one invalid selector voids its whole rule, so rules stay small.
 */
const CHUNK = 256;

/** An odd run of trailing backslashes escapes whatever follows — the `,` of the next selector. */
function endsInEscape(sel: string): boolean {
  const m = /\\+$/.exec(sel);
  return !!m && m[0].length % 2 === 1;
}

let probeSheet: CSSStyleSheet | null | undefined;

function parser(): CSSStyleSheet | null {
  if (probeSheet === undefined) {
    try {
      probeSheet = typeof CSSStyleSheet === 'function' ? new CSSStyleSheet() : null;
    } catch {
      probeSheet = null;
    }
  }
  return probeSheet;
}

/** Does `css` parse as exactly one style rule? */
function isOneStyleRule(sheet: CSSStyleSheet, css: string): boolean {
  try {
    sheet.replaceSync(css);
    return sheet.cssRules.length === 1 && sheet.cssRules[0] instanceof CSSStyleRule;
  } catch {
    return false;
  }
}

/**
 * The selectors that parse as CSS on their own.
 *
 * querySelector is not a safe check: it closes an unterminated string, bracket or paren at the
 * end of its input, so `div[title="Sponsored` passes — and once joined into a rule it swallows
 * the rest of the stylesheet. Each selector must parse as a complete style rule instead.
 */
export function validSelectors(sels: readonly string[]): string[] {
  const candidates = sels.filter(
    (s) => typeof s === 'string' && s.trim() && !/[{}]/.test(s) && !s.includes('/*') && !endsInEscape(s),
  );
  const sheet = parser();
  if (!sheet) {
    return candidates.filter((s) => {
      try {
        document.createDocumentFragment().querySelector(s);
        return true;
      } catch {
        return false;
      }
    });
  }
  const out: string[] = [];
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const chunk = candidates.slice(i, i + CHUNK);
    // Valid selectors stay valid in a list, so a chunk that parses needs no per-selector pass.
    if (isOneStyleRule(sheet, `${chunk.join(',')}{}`)) {
      out.push(...chunk);
      continue;
    }
    for (const s of chunk) if (isOneStyleRule(sheet, `${s}{}`)) out.push(s);
  }
  try {
    sheet.replaceSync('');
  } catch {
    /* ignore */
  }
  return out;
}

/** Is `sel` a syntactically valid CSS selector? Guards against CSS breakout. */
export function isValidSelector(sel: string): boolean {
  return validSelectors([sel]).length === 1;
}

/** `sels` as rules of at most CHUNK selectors each, all with `body`. */
export function chunkedRules(sels: readonly string[], body: string): string {
  let css = '';
  for (let i = 0; i < sels.length; i += CHUNK) {
    css += `${sels.slice(i, i + CHUNK).join(',\n')} { ${body} }\n`;
  }
  return css;
}

/**
 * Serialize hide/unhide selectors. Empty string means the existing sheet must be removed.
 *
 * `unhide` is only for selectors of the registered generic sheet that an exception cancels on
 * this page (cosmetic-match decides which): a revert is the one way to undo a rule of a sheet the
 * browser injected, and on anything else it overrides the site's own display. A specific
 * exception needs no rule at all; its selector is simply not in `hide`.
 */
export function buildSpecificCss(hide: string[], unhide: string[]): string {
  let css = chunkedRules(validSelectors(hide), 'display: none !important;');
  const safeUnhide = validSelectors(unhide);
  if (safeUnhide.length) css += chunkedRules(safeUnhide, 'display: revert !important;');
  return css;
}

let specificPart = '';
let proceduralPart = '';
let styleEl: HTMLStyleElement | null = null;
let guard: MutationObserver | null = null;
/** undefined: not observing anything yet. */
let guardedParent: Node | null | undefined;
let reattachments = 0;
/** A page that keeps deleting the sheet wins eventually; fighting it forever would spin. */
const MAX_REATTACH = 50;

function existingSheet(): HTMLStyleElement | null {
  if (styleEl) return styleEl;
  const found = document.querySelector(`style[${ATTR}="${VALUE}"]`);
  return found instanceof HTMLStyleElement ? found : null;
}

function attach(style: HTMLStyleElement): void {
  const parent = document.head || document.documentElement;
  if (parent) parent.appendChild(style);
}

function rewatch(): void {
  if (!guard) return;
  const parent = styleEl?.parentNode ?? null;
  if (parent === guardedParent) return;
  guard.disconnect();
  guard.observe(document, { childList: true });
  if (parent && parent !== document) guard.observe(parent, { childList: true });
  guardedParent = parent;
}

function onGuard(): void {
  if (styleEl && !styleEl.isConnected && reattachments < MAX_REATTACH) {
    reattachments++;
    attach(styleEl);
  }
  rewatch();
}

/**
 * Put the sheet back when it leaves the document: `document.open()` (friendly-iframe ads written
 * with document.write) replaces the whole tree, and a page script can delete the element.
 */
function watch(style: HTMLStyleElement): void {
  styleEl = style;
  if (!guard && typeof MutationObserver === 'function') guard = new MutationObserver(onGuard);
  rewatch();
}

function unwatch(): void {
  guard?.disconnect();
  guardedParent = undefined;
}

function render(): void {
  const css = specificPart + proceduralPart;
  const existing = existingSheet();
  if (!css) {
    unwatch();
    existing?.remove();
    styleEl = null;
    return;
  }
  const style = existing ?? document.createElement('style');
  style.setAttribute(ATTR, VALUE);
  if (style.textContent !== css) style.textContent = css;
  if (!style.isConnected) attach(style);
  watch(style);
}

/** Insert or replace the specific cosmetic sheet. Empty hide+unhide removes it. */
export function injectSpecificCss(hide: string[], unhide: string[]): void {
  specificPart = buildSpecificCss(hide, unhide);
  render();
}

/** The procedural runner's rules (marker-attribute hides, `:style()`, plain-CSS rules). */
export function setProceduralCss(css: string): void {
  proceduralPart = css;
  render();
}
