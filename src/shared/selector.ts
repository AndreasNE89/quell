// Generate a CSS selector for an element the user picked.
//
// The hard requirement is that the selector still matches after a reload. Sites ship
// build-hashed class names (`css-1x2y3z`, `_3fKlM`, `jsx-1029384`) and framework-generated ids
// that change on every deploy, so the naive "shortest unique selector" is usually the most
// fragile one. This picks stable-looking hooks first and only falls back to positional
// selectors when there is nothing else to hold on to.
//
// Pure DOM reads, no chrome APIs: it runs in the page for the picker, and in tests against a
// minimal fake DOM.

/** Elements a picker should never target — hiding these breaks the page, not the ad. */
const NEVER_PICK = new Set(['HTML', 'BODY', 'HEAD', 'SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE']);

/**
 * Class/id tokens that look machine-generated and will change on the next deploy.
 *
 * Deliberately conservative — a false "unstable" verdict costs us a nicer selector, while a
 * false "stable" verdict produces a filter that silently stops working.
 */
export function looksGenerated(token: string): boolean {
  if (!token) return true;
  // CSS-in-JS: css-1a2b3c, sc-fzXfLZ, jsx-1029384756, emotion-9xk2p
  if (/^(?:css|sc|jsx|emotion|svelte|v-|mui)-[a-z0-9]{4,}$/i.test(token)) return true;
  // Leading underscore/dash plus hash: _3fKlM, --x1y2z3
  if (/^[-_]{1,2}[a-z0-9]{4,}$/i.test(token)) return true;
  // Pure digits at any length: 1048576
  if (/^[0-9]+$/.test(token)) return true;
  // Anything very long is almost certainly generated.
  if (token.length > 40) return true;

  // Hash-like SEGMENT, not just a hash-like whole token. Generated names usually carry a
  // readable prefix and a hash tail (`r_8f3a2b1c`, `wrap-1a2b3c`, `item_9xKq2p`), so testing the
  // token as a unit misses the common case. Short segments (`col-md-6`, `data-2024`) are left
  // alone: a length floor of 6 is what keeps ordinary hyphenated names out.
  for (const seg of token.split(/[-_]+/)) {
    if (seg.length < 6) continue;
    if (/^[0-9a-f]+$/i.test(seg)) return true; // hex chunk
    const digits = (seg.match(/\d/g) ?? []).length;
    if (digits && /[a-z]/i.test(seg) && digits / seg.length >= 0.25) return true;
  }
  return false;
}

/** `\hex ` escape for a character CSS does not allow escaped with a bare backslash. */
function hexEscape(c: string): string {
  return `\\${c.codePointAt(0)!.toString(16)} `;
}

/** CSS-escape an identifier for use in a selector. */
function escapeIdent(value: string): string {
  // CSS.escape exists in every browser we target; the manual path is for the test DOM.
  const g = globalThis as { CSS?: { escape?: (s: string) => string } };
  if (typeof g.CSS?.escape === 'function') return g.CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_\u00a0-\uffff-]/g, (c) =>
    /[\x00-\x1f\x7f]/.test(c) ? hexEscape(c) : `\\${c}`,
  ).replace(/^(-?)(\d)/, (_m, dash: string, d: string) => `${dash}${hexEscape(d)}`);
}

/**
 * A double-quoted CSS string. A backslash or a newline copied from an attribute verbatim ends
 * the string early or escapes the closing quote, and the selector then swallows the rest of the
 * stylesheet it lands in.
 */
export function cssString(value: string): string {
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`).replace(/[\x00-\x1f\x7f]/g, hexEscape)}"`;
}

interface PickTarget {
  tagName: string;
  id?: string;
  classList?: readonly string[];
  attrs?: Readonly<Record<string, string>>;
  parent?: PickTarget | null;
  /** Same-tag siblings before this one, for :nth-of-type. */
  indexOfType?: number;
  /** Total same-tag siblings, so a lone child skips :nth-of-type entirely. */
  countOfType?: number;
}

/** Stable class tokens, in document order, capped so selectors stay readable. */
export function stableClasses(classList: readonly string[] | undefined, max = 2): string[] {
  return (classList ?? []).filter((c) => c && !looksGenerated(c)).slice(0, max);
}

/**
 * One selector step for a single element: tag, plus whatever stable hooks it has. `positional`
 * also pins the element among same-tag siblings when it has hooks, for picks that must narrow
 * down to one element of a repeated class.
 */
export function stepFor(el: PickTarget, positional = false, generated = false): string {
  const tag = el.tagName.toLowerCase();
  if (el.id && (generated || !looksGenerated(el.id))) return `#${escapeIdent(el.id)}`;
  const nth =
    el.countOfType != null && el.countOfType > 1 && el.indexOfType != null
      ? `:nth-of-type(${el.indexOfType + 1})`
      : '';

  const classes = generated
    ? (el.classList ?? []).filter(Boolean).slice(0, 2)
    : stableClasses(el.classList);
  if (classes.length) return tag + classes.map((c) => `.${escapeIdent(c)}`).join('') + (positional ? nth : '');

  // Attribute hooks a site actually uses for semantics survive redesigns better than position.
  for (const name of ['data-testid', 'data-test', 'data-qa', 'aria-label', 'role', 'name']) {
    const v = el.attrs?.[name];
    if (v && v.length <= 40 && !looksGenerated(v)) {
      return `${tag}[${name}=${cssString(v)}]${positional ? nth : ''}`;
    }
  }

  // Nothing stable: fall back to position, but only when it disambiguates.
  return tag + nth;
}

/**
 * True when every step is a bare tag name (`div > div > div`): such a selector says nothing
 * about the element and matches whatever shares the page's nesting — one saved pick hid all 12
 * stories on a news page.
 */
export function isBareTagSelector(selector: string): boolean {
  const steps = selector.split(/\s*[>+~\s]\s*/).filter(Boolean);
  return steps.length > 0 && steps.every((s) => /^[a-z][a-z0-9-]*$/i.test(s));
}

/**
 * Selectors for `el`, most durable first: the stable-hook path at each depth, then the same
 * paths pinned by position, then paths through build-generated classes. The picker takes the
 * first that matches only the picked element.
 *
 * Generated classes come last but before giving up: after the site's next deploy such a
 * selector matches nothing and the ad comes back, which is harmless. A chain of bare tags fails
 * the other way, by matching whatever takes the ad's place in the layout.
 */
export function selectorCandidates(el: PickTarget, maxDepth = 8): string[] {
  const out: string[] = [];
  for (const [positional, generated] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ]) {
    const steps: string[] = [];
    let node: PickTarget | null | undefined = el;
    for (let depth = 0; node && depth < maxDepth && isPickable(node.tagName); depth++) {
      const step = stepFor(node, positional, generated);
      steps.unshift(step);
      const sel = steps.join(' > ');
      if (!out.includes(sel)) out.push(sel);
      if (step.startsWith('#')) break; // nothing above an id narrows it further
      node = node.parent;
    }
  }
  return out;
}

/**
 * Build a selector path from the element upward.
 *
 * Stops early at an id, because an id is already unique — continuing past it only adds
 * fragility. Otherwise climbs at most `maxDepth` steps, which keeps the selector short enough
 * to survive a wrapper div being added somewhere above.
 */
export function buildSelector(el: PickTarget, maxDepth = 4): string {
  const steps: string[] = [];
  let node: PickTarget | null | undefined = el;
  let depth = 0;

  while (node && depth < maxDepth && !NEVER_PICK.has(node.tagName.toUpperCase())) {
    const step = stepFor(node);
    steps.unshift(step);
    if (step.startsWith('#')) break; // already unique
    node = node.parent;
    depth++;
  }

  return steps.join(' > ');
}

/** True when this element is a sane pick target at all. */
export function isPickable(tagName: string): boolean {
  return !NEVER_PICK.has(tagName.toUpperCase());
}

/**
 * Compose the uBO-style cosmetic filter line for a pick.
 * `example.com##.ad-slot` — always domain-scoped; a global rule from a picker is a footgun.
 */
export function filterLineFor(hostname: string, selector: string): string {
  return `${hostname}##${selector}`;
}
