// Shared procedural-operator vocabulary.
//
// The compiler (parse-filter.mjs) uses this to classify a cosmetic as a CSS hide, a procedural
// rule, an action (`:style()`, `:remove-attr()`, `:remove-class()`) or unsupported.
// The runtime evaluator (src/engine/procedural.ts) must implement the same names — a test
// compares the two lists so an operator cannot ship in one place and be dropped in the other.

/** Operators `queryProcedural` / `applyOp` implement. */
export const PROCEDURAL_OP_NAMES = [
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
];

/**
 * True when a cosmetic selector body must go through the procedural engine, not plain CSS.
 * Native `:has()` is plain CSS (Chrome 105+): shipped in the stylesheet, a list or user `#@#`
 * and `$specifichide` cancel it the way they cancel any other hide.
 */
export function isProceduralCosmeticBody(body) {
  if (typeof body !== 'string') return false;
  const a = analyzeCosmeticBody(body);
  return a.kind === 'procedural' || (a.kind === 'action' && a.procedural);
}

/**
 * Rewrite ABP extended-selector names to the ones the runtime evaluates, as uBO does when it
 * reads an ABP list.
 *
 * - `:-abp-has()` is `:has()`. The runtime has no `-abp-has` operator, so without this 149 of
 *   EasyList China's 166 procedural rules matched nothing.
 * - `:-abp-contains()` is `:has-text()`.
 * - `:-abp-properties()` matches elements by the declarations of the *stylesheet rules* that
 *   style them. `:matches-css()` tests computed style instead, which is not the same test
 *   (`:-abp-properties(base64)` has no computed-style equivalent), and uBO does not implement
 *   it either. Such rules, and any other `:-abp-` operator, are reported as unsupported.
 *
 * @param {string} body
 * @returns {{ selector: string, unsupported: string | null }}
 */
export function normalizeAbpSelector(body) {
  if (typeof body !== 'string' || !body.includes(':-abp-')) {
    return { selector: body, unsupported: null };
  }
  const selector = body.replace(/:-abp-has\(/g, ':has(').replace(/:-abp-contains\(/g, ':has-text(');
  const left = /:(-abp-[a-z-]+)/.exec(selector);
  return { selector, unsupported: left ? left[1] : null };
}

// --- Classifying a selector body ---------------------------------------------------------

/**
 * uBO action operators. They change the elements a selector matches instead of hiding them, and
 * they must end the filter. The compiler turns them into action records for the content script;
 * shipped as a hide they did the opposite of what the filter asks (hianime.ms's play button,
 * networkhint.com's captcha form).
 */
export const ACTION_OP_NAMES = ['style', 'remove-attr', 'remove-class'];

const PROCEDURAL_OPS = new Set(PROCEDURAL_OP_NAMES);
const ACTION_OPS = new Set(ACTION_OP_NAMES);

/** Native CSS functional pseudo-classes whose argument is itself a selector (checked in turn). */
const NATIVE_SELECTOR_FUNCTIONS = new Set([
  'not',
  'is',
  'where',
  'has',
  'matches',
  '-webkit-any',
  'host',
  'host-context',
  'slotted',
  'nth-child',
  'nth-last-child',
]);

/** Native CSS functional pseudo-classes and pseudo-elements with a non-selector argument. */
const NATIVE_OTHER_FUNCTIONS = new Set([
  'nth-of-type',
  'nth-last-of-type',
  'lang',
  'dir',
  'state',
  'part',
  'highlight',
  'cue',
  'cue-region',
]);

/** Procedural operators whose argument is a selector: `:upward(2)` is a count instead. */
const SELECTOR_ARG_OPS = new Set(['if', 'if-not', 'upward']);


/** Index just past the quoted string opening at `i`, or -1 when it never closes. */
function skipQuoted(s, i) {
  const q = s[i];
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === q) return j + 1;
  }
  return -1;
}

/** Index of the `)` closing the `(` at `open`, skipping quotes and escapes; -1 if none. */
function closingParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
    } else if (c === '"' || c === "'") {
      const end = skipQuoted(s, i);
      if (end === -1) return -1;
      i = end - 1;
    } else if (c === '(') {
      depth++;
    } else if (c === ')' && --depth === 0) {
      return i;
    }
  }
  return -1;
}

/**
 * The functional pseudo-classes and pseudo-elements at the top level of `s` (not inside
 * brackets, quotes or another function's argument), in order; null when a quote, bracket or
 * parenthesis never closes. `end` is the index just past the closing `)`.
 *
 * @returns {{ name: string, arg: string, start: number, end: number, element: boolean }[] | null}
 */
export function topLevelFunctions(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipQuoted(s, i);
      if (i === -1) return null;
      continue;
    }
    if (c === '[') {
      let j = i + 1;
      while (j < s.length && s[j] !== ']') {
        if (s[j] === '\\') {
          j += 2;
        } else if (s[j] === '"' || s[j] === "'") {
          j = skipQuoted(s, j);
          if (j === -1) return null;
        } else {
          j++;
        }
      }
      if (j >= s.length) return null;
      i = j + 1;
      continue;
    }
    if (c === '(') {
      const close = closingParen(s, i);
      if (close === -1) return null;
      i = close + 1;
      continue;
    }
    if (c === ')' || c === ']') return null;
    if (c === ':') {
      const element = s[i + 1] === ':';
      const nameAt = element ? i + 2 : i + 1;
      const m = /^-?[A-Za-z_][\w-]*/.exec(s.slice(nameAt));
      const after = nameAt + (m ? m[0].length : 0);
      if (m && s[after] === '(') {
        const close = closingParen(s, after);
        if (close === -1) return null;
        out.push({
          name: m[0].toLowerCase(),
          arg: s.slice(after + 1, close),
          start: i,
          end: close + 1,
          element,
        });
        i = close + 1;
        continue;
      }
      i = Math.max(after, i + 1);
      continue;
    }
    i++;
  }
  return out;
}

/**
 * First operator in selector `s` (looked into recursively) that neither CSS nor the runtime
 * implements, or that may not appear there (an action operator anywhere but the end); null
 * when there is none.
 */
function unsupportedIn(s) {
  const fns = topLevelFunctions(s);
  if (!fns) return 'unbalanced';
  for (const f of fns) {
    if (ACTION_OPS.has(f.name)) return `${f.name}-not-last`;
    if (NATIVE_SELECTOR_FUNCTIONS.has(f.name)) {
      const inner = unsupportedIn(f.arg);
      if (inner) return inner;
    } else if (NATIVE_OTHER_FUNCTIONS.has(f.name)) {
      continue;
    } else if (!f.element && PROCEDURAL_OPS.has(f.name)) {
      if (SELECTOR_ARG_OPS.has(f.name) && !(f.name === 'upward' && /^\s*\d+\s*$/.test(f.arg))) {
        const inner = unsupportedIn(f.arg);
        if (inner) return inner;
      }
    } else {
      return f.name;
    }
  }
  return null;
}

/** Does selector `s` use a procedural operator anywhere, nested arguments included? */
function usesProcedural(s) {
  const fns = topLevelFunctions(s) ?? [];
  return fns.some(
    (f) =>
      (!f.element && PROCEDURAL_OPS.has(f.name)) ||
      ((NATIVE_SELECTOR_FUNCTIONS.has(f.name) || SELECTOR_ARG_OPS.has(f.name)) &&
        usesProcedural(f.arg)),
  );
}

/**
 * A `:style()` argument that can go into a stylesheet as declarations and nothing else, or null.
 * It cannot close the rule or open another (`{`, `}`), carry an escape or a comment, or load
 * anything: `url()` and its relatives would let a list make every matching page fetch a URL,
 * which uBO refuses for the same reason.
 */
export function validStyleDeclarations(arg) {
  const s = String(arg ?? '').trim();
  if (!s || s.length > 1024) return null;
  if (/[{}<>\\@]|\/\*|\*\//.test(s)) return null;
  if (/(?:url|image|image-set|-webkit-image-set|cross-fade|element|expression|src)\s*\(/i.test(s)) {
    return null;
  }
  if (/javascript:|-moz-binding|behavior\s*:/i.test(s)) return null;
  const decls = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const end = skipQuoted(s, i);
      if (end === -1) return null;
      i = end - 1;
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      if (--depth < 0) return null;
    } else if (i === s.length || (c === ';' && depth === 0)) {
      const d = s.slice(start, i).trim();
      if (d) decls.push(d);
      start = i + 1;
    }
  }
  if (depth !== 0 || !decls.length) return null;
  for (const d of decls) {
    if (!/^(?:--[\w-]+|-?[A-Za-z][\w-]*)\s*:\s*\S/.test(d)) return null;
  }
  return s;
}

/**
 * How the runtime will treat a cosmetic selector body (after normalizeAbpSelector):
 *   - `css`: a selector the browser applies as is, native `:has()` included, so it ships in the
 *     stylesheet where exceptions and `$specifichide` already work;
 *   - `procedural`: needs the JS engine (procedural.ts);
 *   - `action`: ends in `:style()` / `:remove-attr()` / `:remove-class()`; `selector` is what it
 *     applies to, itself `procedural` or not;
 *   - `unsupported`: an operator nothing here implements (`:others()`, `:matches-media()`,
 *     `:shadow()`), a misplaced or malformed action, or unbalanced quotes or brackets. The
 *     compiler skips and counts these; none may fall through as a hide. (Plain CSS after an
 *     operator, and operators nested in `:if-not()`, are evaluated by procedural.ts, which
 *     fails closed on anything it does not know.)
 *
 * @param {string} body
 * @returns {{ kind: 'css' } | { kind: 'procedural' } | { kind: 'unsupported', reason: string }
 *   | { kind: 'action', selector: string, procedural: boolean, action: string, arg: string }}
 */
export function analyzeCosmeticBody(body) {
  const s = String(body ?? '').trim();
  const fns = topLevelFunctions(s);
  if (!fns) return { kind: 'unsupported', reason: 'unbalanced' };
  let selector = s;
  let action = null;
  const last = fns[fns.length - 1];
  if (last && !last.element && ACTION_OPS.has(last.name) && s.slice(last.end).trim() === '') {
    selector = s.slice(0, last.start).trim();
    action = { name: last.name, arg: last.arg.trim() };
    fns.pop();
    if (!selector) return { kind: 'unsupported', reason: `${last.name}-without-selector` };
    if (last.name === 'style') {
      if (!validStyleDeclarations(action.arg)) {
        return { kind: 'unsupported', reason: 'style-declarations' };
      }
    } else if (!action.arg || action.arg.length > 256 || /[{}<>]/.test(action.arg)) {
      return { kind: 'unsupported', reason: `${last.name}-argument` };
    }
  }
  const unknown = unsupportedIn(selector);
  if (unknown) return { kind: 'unsupported', reason: unknown };
  const procedural = usesProcedural(selector);
  if (!action) return { kind: procedural ? 'procedural' : 'css' };
  return { kind: 'action', selector, procedural, action: action.name, arg: action.arg };
}
