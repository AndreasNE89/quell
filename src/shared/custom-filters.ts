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

export type CustomFilterKind = 'hide' | 'unhide';

export interface CustomFilter {
  kind: CustomFilterKind;
  /** Hostnames the rule applies to. Empty = every site. */
  domains: string[];
  selector: string;
  /** 1-based line in the source text, for error reporting in Options. */
  line: number;
}

export interface CustomFilterParse {
  filters: CustomFilter[];
  /** Lines that could not be used, with a reason the user can act on. */
  errors: { line: number; text: string; reason: string }[];
}

/** Reject selectors that could break out of a CSS rule or wedge the engine. */
function selectorLooksSafe(sel: string): boolean {
  if (!sel || sel.length > 512) return false;
  if (sel.includes('{') || sel.includes('}')) return false;
  if (sel.includes('/*') || sel.includes('*/')) return false;
  if (sel.includes('<')) return false;
  return true;
}

/** A hostname the user could plausibly have meant. Intentionally permissive about IDN. */
function hostLooksSane(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (!host.includes('.')) return false;
  return /^[a-z0-9.*_-]+$/i.test(host);
}

/**
 * Parse the user's filter text.
 *
 * Accepted forms (uBO subset):
 *   example.com##.ad-slot          hide on example.com
 *   a.com,b.com##.ad               hide on either
 *   ##.ad                          hide everywhere
 *   example.com#@#.ad              exception: stop hiding on example.com
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

    // Network syntax is recognized only to give a useful message instead of silence.
    if (/^@?@?\|\|/.test(trimmed) || /^\/.*\/$/.test(trimmed)) {
      errors.push({
        line,
        text: trimmed,
        reason: 'Network rules are not supported yet — only element hiding.',
      });
      return;
    }

    // Order matters: `#@#` must be tested before `##`.
    const sepIndex = trimmed.includes('#@#') ? trimmed.indexOf('#@#') : trimmed.indexOf('##');
    const sepLength = trimmed.includes('#@#') ? 3 : 2;
    if (sepIndex < 0) {
      errors.push({
        line,
        text: trimmed,
        reason: 'Expected a rule like example.com##.ad-slot',
      });
      return;
    }

    const kind: CustomFilterKind = sepLength === 3 ? 'unhide' : 'hide';
    const domainPart = trimmed.slice(0, sepIndex).trim();
    const selector = trimmed.slice(sepIndex + sepLength).trim();

    if (!selectorLooksSafe(selector)) {
      errors.push({ line, text: trimmed, reason: 'Selector is empty or contains unsafe characters.' });
      return;
    }

    const domains: string[] = [];
    if (domainPart) {
      for (const d of domainPart.split(',')) {
        const host = d.trim().toLowerCase().replace(/^\*\./, '');
        if (!host) continue;
        if (!hostLooksSane(host)) {
          errors.push({ line, text: trimmed, reason: `"${d.trim()}" is not a hostname.` });
          return;
        }
        domains.push(host);
      }
      if (!domains.length) {
        errors.push({ line, text: trimmed, reason: 'No usable hostname before ##.' });
        return;
      }
    }

    filters.push({ kind, domains, selector, line });
  });

  return { filters, errors };
}

/** True when `hostname` is covered by a rule's domain list (empty list = every site). */
export function filterAppliesTo(filter: CustomFilter, hostname: string): boolean {
  if (!filter.domains.length) return true;
  const host = hostname.toLowerCase();
  return filter.domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Selectors to hide and to un-hide on `hostname`, after applying the user's exceptions. */
export function customCosmeticsFor(
  text: string,
  hostname: string,
): { hide: string[]; unhide: string[] } {
  const { filters } = parseCustomFilters(text);
  const hide = new Set<string>();
  const unhide = new Set<string>();

  for (const f of filters) {
    if (!filterAppliesTo(f, hostname)) continue;
    (f.kind === 'hide' ? hide : unhide).add(f.selector);
  }
  // An exception on the same selector cancels the user's own hide, matching uBO.
  for (const s of unhide) hide.delete(s);

  return { hide: [...hide], unhide: [...unhide] };
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
