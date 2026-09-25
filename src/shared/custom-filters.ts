// User's own cosmetic filters — what the element picker writes and the Options textarea edits.
//
// Stored as raw text (one filter per line) rather than a parsed structure, because the text IS
// the user's document: comments, ordering and near-misses all need to survive a round trip
// through the editor. Parsing happens on read.
//
// Scope is deliberately cosmetic-only for now. Network rules (`||host^`) would need their own
// dynamic-rule id band and budget accounting to be done safely, and a half-implemented version
// that silently drops rules over the cap would be worse than not offering it — the parser
// recognizes them so it can report them as unsupported rather than mangling them.
//
// The count Options shows is `filters.length`, so every line that parses must be one the page
// can actually apply: plain CSS goes to the stylesheet, procedural and action syntax
// (`:has-text()`, `:style()`, `#?#`) to the procedural engine, and anything else is an error the
// user can read, not a silently dead rule.

import type { ProceduralRule } from './types.js';
import { hostMatchesDomain } from './hostname.js';
import {
  compileProcedural,
  isProceduralSelector,
  splitProceduralAction,
} from '../engine/procedural.js';

export type CustomFilterKind = 'hide' | 'unhide';

export interface CustomFilter {
  kind: CustomFilterKind;
  /** Hostnames the rule applies to. Empty = every site. `name.*` is an entity (any TLD). */
  domains: string[];
  selector: string;
  /** 1-based line in the source text, for error reporting in Options. */
  line: number;
  /** Needs the procedural engine (present only when true). */
  procedural?: true;
}

export interface CustomFilterParse {
  filters: CustomFilter[];
  /** Lines that could not be used, with a reason the user can act on. */
  errors: { line: number; text: string; reason: string }[];
}

const MAX_SELECTOR = 1024;

/** uBO operators the engine does not implement. Neither CSS nor the engine would apply them. */
const UNSUPPORTED_OPS = /:(?:others|matches-media|matches-prop|shadow|nth-ancestor|watch-attrs)\(/;

/**
 * Why `sel` cannot be a rule, or null. The service worker parses these and has no DOM to ask,
 * so this is a syntax check: a selector with an unclosed quote, bracket or parenthesis, or a
 * trailing backslash, used to pass and then swallow every other hide in the page's stylesheet.
 */
export function selectorProblem(sel: string): string | null {
  if (!sel) return 'Selector is empty.';
  if (sel.length > MAX_SELECTOR) return 'Selector is too long.';
  if (/[{}]/.test(sel) || sel.includes('/*') || sel.includes('*/') || sel.includes('<')) {
    return 'Selector contains unsafe characters.';
  }
  const stack: string[] = [];
  let quote = '';
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (c === '\\') {
      if (i === sel.length - 1) return 'Selector ends with a backslash.';
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\n' || c === '\r') return 'A quoted string in the selector is not closed.';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') stack.push(c === '(' ? ')' : ']');
    else if (c === ')' || c === ']') {
      if (stack.pop() !== c) return `Unbalanced "${c}" in the selector.`;
    }
  }
  if (quote) return 'A quoted string in the selector is not closed.';
  if (stack.length) return `Missing "${stack[stack.length - 1]}" in the selector.`;
  return null;
}

/** Why a `:style()` argument cannot be used, or null. The content script validates it again. */
function styleProblem(decl: string): string | null {
  if (!decl.trim()) return ':style() needs CSS declarations.';
  if (
    /[{}<>\\@]|\/\*/.test(decl) ||
    /(?:url|image|image-set|-webkit-image-set|cross-fade|element|expression)\s*\(/i.test(decl)
  ) {
    return ':style() cannot load resources or contain braces, comments or escapes.';
  }
  for (const d of decl.split(';').map((x) => x.trim()).filter(Boolean)) {
    if (!/^(?:--[\w-]+|-?[a-z][\w-]*)\s*:\s*\S/i.test(d)) {
      return `"${d}" is not a CSS declaration.`;
    }
  }
  return null;
}

/** Why a procedural or action selector cannot run, or null. */
function proceduralProblem(sel: string): string | null {
  const split = splitProceduralAction(sel);
  if (!split || !split.selector) {
    return 'An action such as :style() or :remove() must come last, after a selector.';
  }
  const action = split.action;
  if (action?.name === 'style') {
    const p = styleProblem(action.arg);
    if (p) return p;
  } else if ((action?.name === 'remove-attr' || action?.name === 'remove-class') && !action.arg) {
    return `:${action.name}() needs a name.`;
  }
  if (!compileProcedural(split.selector)) {
    return 'This filter uses an operator StampStack does not support.';
  }
  return null;
}

/**
 * The hostname the user meant, as the page will report it (lowercase, punycode), or null.
 * Accepts single-label hosts (`localhost`, `intranet`), IPv6 literals as `location.hostname`
 * spells them (`[::1]`), entities (`example.*`) and Unicode names (`bücher.de`).
 */
export function normalizeFilterHost(raw: string): string | null {
  const h = raw.trim().toLowerCase().replace(/^\*\./, '');
  if (!h || h.length > 253) return null;
  if (/^\[[0-9a-f:.]+\]$/.test(h)) return h;
  const entity = h.endsWith('.*');
  let base = entity ? h.slice(0, -2) : h;
  if (!base || base.includes('*')) return null;
  if (/[^\x00-\x7f]/.test(base)) {
    try {
      base = new URL(`http://${base}/`).hostname;
    } catch {
      return null;
    }
  }
  if (!/^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/.test(base)) {
    return null;
  }
  return entity ? `${base}.*` : base;
}

/** Separators, longest first: `#@?#` and `#?#` are uBO's explicit procedural forms. */
const SEPARATORS: { sep: string; kind: CustomFilterKind; procedural: boolean }[] = [
  { sep: '#@?#', kind: 'unhide', procedural: true },
  { sep: '#@#', kind: 'unhide', procedural: false },
  { sep: '#?#', kind: 'hide', procedural: true },
  { sep: '##', kind: 'hide', procedural: false },
];

function findSeparator(line: string): { at: number; sep: string; kind: CustomFilterKind } | null {
  let best: { at: number; sep: string; kind: CustomFilterKind } | null = null;
  for (const s of SEPARATORS) {
    const at = line.indexOf(s.sep);
    // The domain part never contains `#`, so the earliest separator is the real one; at the
    // same index the longer spelling wins (`#@#` over `##` inside `#@##id`).
    if (at >= 0 && (!best || at < best.at)) best = { at, sep: s.sep, kind: s.kind };
  }
  return best;
}

/**
 * Parse the user's filter text.
 *
 * Accepted forms (uBO subset):
 *   example.com##.ad-slot          hide on example.com
 *   a.com,b.com##.ad               hide on either
 *   ##.ad                          hide everywhere
 *   example.com#@#.ad              exception: stop hiding on example.com
 *   example.*##.ad                 any TLD of example
 *   example.com##.post:has-text(Sponsored)     procedural (also written #?#)
 *   example.com##.hero:style(margin-top: 0 !important)   uBO action operators
 *   ! comment                      ignored
 */
export function parseCustomFilters(text: string): CustomFilterParse {
  const filters: CustomFilter[] = [];
  const errors: CustomFilterParse['errors'] = [];
  const lines = (text ?? '').split(/\r?\n/);

  lines.forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('!') || trimmed.startsWith('#!')) return;
    const fail = (reason: string): void => {
      errors.push({ line, text: trimmed, reason });
    };

    // Network syntax is recognized only to give a useful message instead of silence.
    if (/^@?@?\|\|/.test(trimmed) || /^\/.*\/$/.test(trimmed)) {
      fail('Network rules are not supported yet — only element hiding.');
      return;
    }

    const found = findSeparator(trimmed);
    if (!found) {
      fail(
        /#\$#|#\$\?#|#%#/.test(trimmed)
          ? 'AdGuard CSS and script rules are not supported — only element hiding.'
          : 'Expected a rule like example.com##.ad-slot',
      );
      return;
    }

    const domainPart = trimmed.slice(0, found.at).trim();
    const selector = trimmed.slice(found.at + found.sep.length).trim();

    if (/^\+js\(/.test(selector)) {
      fail('Script rules (+js) are not supported in My filters.');
      return;
    }
    if (selector.startsWith('^')) {
      fail('HTML filters (##^) are not supported.');
      return;
    }
    const problem = selectorProblem(selector);
    if (problem) {
      fail(problem);
      return;
    }
    if (UNSUPPORTED_OPS.test(selector)) {
      fail('This filter uses an operator StampStack does not support.');
      return;
    }

    const domains: string[] = [];
    if (domainPart) {
      for (const d of domainPart.split(',')) {
        if (!d.trim()) continue;
        if (d.trim().startsWith('~')) {
          fail('Excluding a domain with ~ is not supported in My filters.');
          return;
        }
        const host = normalizeFilterHost(d);
        if (!host) {
          fail(`"${d.trim()}" is not a hostname.`);
          return;
        }
        domains.push(host);
      }
      if (!domains.length) {
        fail('No usable hostname before ##.');
        return;
      }
    }

    const filter: CustomFilter = { kind: found.kind, domains, selector, line };
    if (found.sep.includes('?') || isProceduralSelector(selector)) {
      filter.procedural = true;
      // An exception only has to name the rule it cancels; a hide has to be able to run.
      const p = found.kind === 'hide' ? proceduralProblem(selector) : null;
      if (p) {
        fail(p);
        return;
      }
    }
    filters.push(filter);
  });

  return { filters, errors };
}

/** True when `hostname` is covered by a rule's domain list (empty list = every site). */
export function filterAppliesTo(filter: CustomFilter, hostname: string): boolean {
  if (!filter.domains.length) return true;
  const host = hostname.toLowerCase();
  return filter.domains.some((d) =>
    d.endsWith('.*') ? hostMatchesDomain(host, d) : host === d || host.endsWith(`.${d}`),
  );
}

/**
 * The last text customCosmeticsFor parsed. Every frame of every page asks the worker for its
 * cosmetics, and the text changes only when the user edits it, so re-parsing it (procedural
 * rules are compiled to be checked) on each request was wasted work (REVIEW_2026-09-24 P3).
 */
let parsedFilters: { text: string; filters: CustomFilter[] } | null = null;

/**
 * Selectors to hide and to un-hide on `hostname`, after applying the user's exceptions, plus the
 * procedural rules for the page's engine. An exception cancels a rule with the identical body,
 * as in uBO; `unhide` carries procedural exceptions too, so list rules can be cancelled by them.
 */
export function customCosmeticsFor(
  text: string,
  hostname: string,
): { hide: string[]; unhide: string[]; procedural: ProceduralRule[] } {
  const source = text ?? '';
  if (parsedFilters?.text !== source) {
    parsedFilters = { text: source, filters: parseCustomFilters(source).filters };
  }
  const { filters } = parsedFilters;
  const hide = new Set<string>();
  const unhide = new Set<string>();
  const procedural = new Set<string>();

  for (const f of filters) {
    if (!filterAppliesTo(f, hostname)) continue;
    if (f.kind === 'unhide') unhide.add(f.selector);
    else (f.procedural ? procedural : hide).add(f.selector);
  }
  // An exception on the same selector cancels the user's own hide, matching uBO.
  for (const s of unhide) {
    hide.delete(s);
    procedural.delete(s);
  }

  return {
    hide: [...hide],
    unhide: [...unhide],
    procedural: [...procedural].map((expr) => ({
      domains: { include: hostname ? [hostname.toLowerCase()] : [], exclude: [] },
      expr,
    })),
  };
}

/** Append a filter line, skipping an exact duplicate. Returns the new text. */
export function appendFilterLine(text: string, line: string): string {
  const existing = (text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (existing.includes(line.trim())) return text ?? '';
  const base = (text ?? '').replace(/\s*$/, '');
  return base ? `${base}\n${line}\n` : `${line}\n`;
}
