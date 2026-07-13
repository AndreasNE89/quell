// Procedural cosmetic evaluator — the uBO/ABP operators that plain CSS can't express:
//   :has-text() / :contains()  text match       :matches-css()      computed style
//   :matches-attr()            attribute match   :xpath()            XPath transform
//   :upward()                  climb ancestors   :min-text-length()  text length
//   :not(...) / :if() / :if-not()                 boolean combinators
//
// Native `:has()` and `:not()` (modern Chromium) are left in the plain CSS prefix and
// handled by querySelectorAll. Everything is wrapped so one bad rule can't throw out
// of the engine.

const PROCEDURAL_OPS = new Set([
  'has-text',
  'contains',
  '-abp-contains',
  'matches-css',
  'matches-css-before',
  'matches-css-after',
  'matches-attr',
  'matches-path',
  'xpath',
  'upward',
  'min-text-length',
  'if',
  'if-not',
  'watch-attr',
  'remove',
]);

interface Op {
  name: string;
  arg: string;
}

interface Parsed {
  prefix: string; // plain CSS selector (may include native :has/:not)
  ops: Op[];
}

/** Extract a balanced-paren argument starting at `open` (index of '('), ignoring
 *  parentheses that appear inside quoted string literals. */
function readParen(s: string, open: number): { arg: string; end: number } | null {
  let depth = 0;
  let quote = '';
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') i++; // skip escaped char inside a quote
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return { arg: s.slice(open + 1, i), end: i };
    }
  }
  return null;
}

/** Find the first top-level procedural pseudo; split the selector there. */
export function parseProcedural(selector: string): Parsed {
  const ops: Op[] = [];
  let depth = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === '(') {
      depth++;
      continue;
    }
    if (c === ')') {
      depth--;
      continue;
    }
    if (c === ':' && depth === 0) {
      const m = /^:([-a-z]+)\(/.exec(selector.slice(i));
      if (m && PROCEDURAL_OPS.has(m[1])) {
        const prefix = selector.slice(0, i).trim() || '*';
        parseOps(selector.slice(i), ops);
        return { prefix, ops };
      }
    }
  }
  return { prefix: selector.trim() || '*', ops: [] };
}

function parseOps(s: string, ops: Op[]): void {
  let i = 0;
  while (i < s.length) {
    if (s[i] !== ':') {
      i++;
      continue;
    }
    const m = /^:([-a-z]+)\(/.exec(s.slice(i));
    if (!m) {
      i++;
      continue;
    }
    const name = m[1];
    const open = i + m[0].length - 1;
    const paren = readParen(s, open);
    if (!paren) break;
    ops.push({ name, arg: paren.arg.trim() });
    i = paren.end + 1;
  }
}

/** Strip a single pair of surrounding quotes, if present. */
function stripQuotes(s: string): string {
  return (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))
    ? s.slice(1, -1)
    : s;
}

/** Parse a `/regex/flags` string, else treat as a literal substring. */
function toMatcher(arg: string): (text: string) => boolean {
  const rx = /^\/(.*)\/([a-z]*)$/.exec(arg);
  if (rx) {
    try {
      const re = new RegExp(rx[1], rx[2]);
      return (t) => re.test(t);
    } catch {
      return () => false;
    }
  }
  const needle = arg.replace(/\\(.)/g, '$1');
  return (t) => t.includes(needle);
}

function applyOp(els: Element[], op: Op): Element[] {
  switch (op.name) {
    case 'has-text':
    case 'contains':
    case '-abp-contains': {
      const match = toMatcher(op.arg);
      return els.filter((el) => match(el.textContent ?? ''));
    }
    case 'min-text-length': {
      const n = parseInt(op.arg, 10);
      return Number.isFinite(n) ? els.filter((el) => (el.textContent ?? '').trim().length >= n) : els;
    }
    case 'matches-css':
    case 'matches-css-before':
    case 'matches-css-after': {
      const pseudo =
        op.name === 'matches-css-before' ? '::before' : op.name === 'matches-css-after' ? '::after' : null;
      const idx = op.arg.indexOf(':');
      if (idx === -1) return els;
      const prop = op.arg.slice(0, idx).trim();
      const match = toMatcher(op.arg.slice(idx + 1).trim());
      return els.filter((el) => {
        try {
          const style = getComputedStyle(el, pseudo);
          return match(style.getPropertyValue(prop).trim());
        } catch {
          return false;
        }
      });
    }
    case 'matches-attr': {
      const eq = op.arg.indexOf('=');
      const name = stripQuotes((eq === -1 ? op.arg : op.arg.slice(0, eq)).trim());
      const valMatch = eq === -1 ? null : toMatcher(stripQuotes(op.arg.slice(eq + 1).trim()));
      return els.filter((el) => {
        if (!el.hasAttribute(name)) return false;
        return valMatch ? valMatch(el.getAttribute(name) ?? '') : true;
      });
    }
    case 'upward': {
      const n = parseInt(op.arg, 10);
      const out = new Set<Element>();
      for (const el of els) {
        let target: Element | null = null;
        if (Number.isFinite(n) && String(n) === op.arg) {
          target = el;
          for (let k = 0; k < n && target; k++) target = target.parentElement;
        } else {
          target = el.parentElement ? el.parentElement.closest(op.arg) : null;
        }
        if (target) out.add(target);
      }
      return [...out];
    }
    case 'xpath': {
      const out = new Set<Element>();
      for (const el of els) {
        try {
          const res = document.evaluate(op.arg, el, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          for (let k = 0; k < res.snapshotLength; k++) {
            const node = res.snapshotItem(k);
            if (node instanceof Element) out.add(node);
          }
        } catch {
          /* bad xpath */
        }
      }
      return [...out];
    }
    case 'if':
    case 'has': {
      return els.filter((el) => safeHas(el, op.arg));
    }
    case 'if-not': {
      return els.filter((el) => !safeHas(el, op.arg));
    }
    case 'not': {
      // A `:not(...)` that trailed a procedural op reaches us here (native `:not`
      // stays in the CSS prefix). Exclude elements matching the (possibly procedural)
      // argument — without this the negation is silently dropped and we over-match.
      return els.filter((el) => !elementMatches(el, op.arg));
    }
    case 'is':
    case 'where': {
      return els.filter((el) => elementMatches(el, op.arg));
    }
    default:
      return els; // watch-attr / remove / matches-path: no-op in the prototype
  }
}

function safeHas(el: Element, arg: string): boolean {
  // Native :has on the element itself supports all combinators (`+`, `~`, `>`),
  // unlike a `:scope`-based querySelector which only searches descendants.
  try {
    return el.matches(`:has(${arg})`);
  } catch {
    return false;
  }
}

/** Does `el` itself satisfy `selector` (plain CSS or a procedural chain)? */
function elementMatches(el: Element, selector: string): boolean {
  const { prefix, ops } = parseProcedural(selector);
  let set: Element[];
  try {
    set = prefix === '*' || el.matches(prefix) ? [el] : [];
  } catch {
    return false;
  }
  for (const op of ops) {
    if (!set.length) break;
    set = applyOp(set, op);
  }
  return set.includes(el);
}

/** Evaluate a procedural selector, returning the matched elements. */
export function queryProcedural(selector: string, root: ParentNode = document): Element[] {
  const { prefix, ops } = parseProcedural(selector);

  // Special case: an xpath as the very first op evaluates against the document.
  let els: Element[];
  if (prefix === '*' && ops[0]?.name === 'xpath') {
    els = applyOp([document.documentElement], ops.shift()!);
  } else {
    try {
      // Known limitation: a procedural pseudo nested inside a native :has() (e.g.
      // `.x:has(.y:has-text(z))`) stays in this prefix and makes querySelectorAll
      // throw. We fail safe (match nothing) rather than over-hide; full support would
      // need a recursive selector parser.
      els = Array.from(root.querySelectorAll(prefix));
    } catch {
      return [];
    }
  }

  for (const op of ops) {
    if (els.length === 0) break;
    els = applyOp(els, op);
  }
  return els;
}
