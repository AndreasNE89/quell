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

/** CSS-escape an identifier for use in a selector. */
function escapeIdent(value: string): string {
  // CSS.escape exists in every browser we target; the manual path is for the test DOM.
  const g = globalThis as { CSS?: { escape?: (s: string) => string } };
  if (typeof g.CSS?.escape === 'function') return g.CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
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

/** One selector step for a single element: tag, plus whatever stable hooks it has. */
export function stepFor(el: PickTarget): string {
  const tag = el.tagName.toLowerCase();
  if (el.id && !looksGenerated(el.id)) return `#${escapeIdent(el.id)}`;

  const classes = stableClasses(el.classList);
  if (classes.length) return tag + classes.map((c) => `.${escapeIdent(c)}`).join('');

  // Attribute hooks a site actually uses for semantics survive redesigns better than position.
  for (const name of ['data-testid', 'data-test', 'data-qa', 'aria-label', 'role', 'name']) {
    const v = el.attrs?.[name];
    if (v && v.length <= 40 && !looksGenerated(v)) {
      return `${tag}[${name}="${v.replace(/"/g, '\\"')}"]`;
    }
  }

  // Nothing stable: fall back to position, but only when it disambiguates.
  if (el.countOfType != null && el.countOfType > 1 && el.indexOfType != null) {
    return `${tag}:nth-of-type(${el.indexOfType + 1})`;
  }
  return tag;
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
