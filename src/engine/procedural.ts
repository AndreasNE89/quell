// Procedural cosmetic evaluator — the uBO/ABP operators that plain CSS can't express:
//   :has-text() / :contains()  text match       :matches-css()      computed style
//   :matches-attr()            attribute match   :xpath()            XPath transform
//   :upward()                  climb ancestors   :min-text-length()  text length
//   :matches-path()            page path gate    :watch-attr()       re-run on attributes
//   :has() / :not() / :if() / :if-not()          selector arguments, evaluated recursively
//                                                when they contain procedural operators
// and the uBO action operators, which end a rule and say what to do with its matches instead
// of hiding them: :style(), :remove(), :remove-attr(), :remove-class().
//
// The model follows uBO's PSelector: a CSS selector picks the starting nodes (an empty one
// starts from the document, or inside an argument from the element being tested), then each
// operator filters or transforms the set, and plain CSS after an operator (`:nth-child(2)`,
// `> .inner`, `+ .ad`) is applied relative to each node. Anything the engine does not know
// fails closed: an unknown operator makes the rule match nothing rather than hiding whatever
// reached it, which is how `:style(display:block)` used to hide the element it meant to show.

/** Must stay identical to `scripts/lib/procedural-ops.mjs` — converter test compares them. */
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
] as const;

/** uBO action operators: always the last operator of a rule. */
export const PROCEDURAL_ACTION_NAMES = ['remove', 'remove-attr', 'remove-class', 'style'] as const;
export type ProceduralActionName = (typeof PROCEDURAL_ACTION_NAMES)[number];

export interface ProceduralAction {
  name: ProceduralActionName;
  arg: string;
}

const PROCEDURAL_OPS = new Set<string>(PROCEDURAL_OP_NAMES);
const ACTION_OPS = new Set<string>(PROCEDURAL_ACTION_NAMES);
/** Pseudo-classes whose argument is a selector. After a procedural operator they are operators
 *  too; before one, only when their argument itself needs the engine. */
const SELECTOR_ARG_OPS = new Set(['has', '-abp-has', 'not', 'is', 'where', 'if', 'if-not']);

interface Op {
  name: string;
  arg: string;
}

interface Parsed {
  prefix: string; // plain CSS selector (may include native :has/:not)
  ops: Op[];
  /** The expression started with an operator: evaluation starts from the document. */
  empty?: boolean;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Extract a balanced-paren argument starting at `open` (index of '('), ignoring
 *  parentheses inside quoted strings and escaped ones. */
function readParen(s: string, open: number): { arg: string; end: number } | null {
  let depth = 0;
  let quote = '';
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = '';
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

/** `:name(` at `i`, with the index of its `(`. Pseudo-elements (`::before`) never match. */
function functionalPseudoAt(s: string, i: number): { name: string; open: number } | null {
  if (s[i] !== ':' || s[i + 1] === ':' || (i > 0 && s[i - 1] === ':')) return null;
  const m = /^:([-a-zA-Z]+)\(/.exec(s.slice(i, i + 48));
  return m ? { name: m[1].toLowerCase(), open: i + m[0].length - 1 } : null;
}

/**
 * Walk `s` from `from`, calling `visit(i)` at every `:` outside quotes, escapes, brackets and
 * parentheses. Returns the first index for which `visit` returns true, else `s.length`.
 */
function scanTopLevel(s: string, from: number, visit: (i: number) => boolean): number {
  let depth = 0;
  let quote = '';
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ':' && depth === 0 && visit(i)) return i;
  }
  return s.length;
}

/** True when `sel` uses a procedural or action operator anywhere, including inside `:has()`. */
export function isProceduralSelector(sel: string): boolean {
  let quote = '';
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c !== ':') continue;
    const fn = functionalPseudoAt(sel, i);
    if (!fn) continue;
    if (PROCEDURAL_OPS.has(fn.name) || ACTION_OPS.has(fn.name) || fn.name.startsWith('-abp-')) {
      return true;
    }
  }
  return false;
}

/** Split `s` at top-level commas (a selector list). */
function splitSelectorList(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim());
}

/**
 * Where the engine has to take over from CSS: a procedural operator, an action, an ABP
 * extension, or a selector-argument pseudo-class whose argument is procedural
 * (`.x:has(.y:has-text(z))` — querySelectorAll would throw on the whole thing).
 */
function isSplitPoint(s: string, i: number): boolean {
  const fn = functionalPseudoAt(s, i);
  if (!fn) return false;
  if (PROCEDURAL_OPS.has(fn.name) || ACTION_OPS.has(fn.name) || fn.name.startsWith('-abp-')) return true;
  if (!SELECTOR_ARG_OPS.has(fn.name)) return false;
  const paren = readParen(s, fn.open);
  return !!paren && isProceduralSelector(paren.arg);
}

/** A selector that ends in a combinator (`center >`, `div `) continues with any element. */
function closeDangling(sel: string): string {
  if (!sel) return sel;
  if (/[>+~]\s*$/.test(sel) || /\s$/.test(sel)) return `${sel.trimEnd()} *`;
  return sel;
}

/** Find the first top-level procedural pseudo; split the selector there. */
export function parseProcedural(selector: string): Parsed {
  const at = scanTopLevel(selector, 0, (i) => isSplitPoint(selector, i));
  if (at >= selector.length) return { prefix: selector.trim() || '*', ops: [] };
  const head = selector.slice(0, at);
  const prefix = closeDangling(head.trimStart());
  const ops: Op[] = [];
  parseOps(selector.slice(at), ops);
  return { prefix: prefix.trim() || '*', ops, empty: !prefix.trim() };
}

function parseOps(s: string, ops: Op[]): void {
  let i = 0;
  while (i < s.length) {
    const fn = functionalPseudoAt(s, i);
    if (fn && (PROCEDURAL_OPS.has(fn.name) || ACTION_OPS.has(fn.name) || SELECTOR_ARG_OPS.has(fn.name) || fn.name.startsWith('-abp-'))) {
      const paren = readParen(s, fn.open);
      if (!paren) {
        // Unbalanced: keep the damage visible to the evaluator, which fails closed on it.
        ops.push({ name: fn.name, arg: s.slice(fn.open + 1) });
        return;
      }
      ops.push({ name: fn.name, arg: paren.arg.trim() });
      i = paren.end + 1;
      continue;
    }
    // Plain CSS continues until the next operator: `:nth-child(2)`, `:first-child .inner`,
    // `> .ad`, `+ .next`. It is kept as one segment and applied relative to each node.
    const next = scanTopLevel(s, i + 1, (j) => isSplitPoint(s, j));
    const seg = normalizeSegment(s.slice(i, next), next < s.length);
    if (seg) ops.push({ name: 'selector', arg: seg });
    i = next;
  }
}

/**
 * Segment spelling: a leading combinator is kept bare (`> .inner`), a leading descendant
 * combinator keeps one space (` .inner`), a compound continuation has none (`:first-child`).
 * A segment that ends in a combinator before another operator continues with `*`
 * (`:has-text(a) > :has-text(b)` is `> *` then `:has-text(b)`).
 */
function normalizeSegment(seg: string, beforeOp: boolean): string {
  let body = seg.trim();
  if (beforeOp && (/[>+~]$/.test(body) || /\s$/.test(seg))) body = body ? `${body} *` : '*';
  if (!body) return '';
  return /^\s/.test(seg) && !/^[>+~]/.test(body) ? ` ${body}` : body;
}

/**
 * How a trailing CSS fragment after a procedural op applies.
 * A leading space marks a descendant combinator; no leading space is a compound
 * continuation (`:first-child`) tested on the candidate itself.
 */
export function trailingSelectorMode(
  raw: string,
): 'self' | 'descendant' | 'child' | 'next' | 'sibling' {
  const trimmed = raw.trim();
  if (trimmed.startsWith('>')) return 'child';
  if (trimmed.startsWith('+')) return 'next';
  if (trimmed.startsWith('~')) return 'sibling';
  if (/^\s/.test(raw)) return 'descendant';
  return 'self';
}

/**
 * Split a rule into its selector and a trailing action operator. Returns null when an action
 * appears anywhere but last, which uBO rejects too.
 */
export function splitProceduralAction(
  expr: string,
): { selector: string; action: ProceduralAction | null } | null {
  const at = scanTopLevel(expr, 0, (i) => {
    const fn = functionalPseudoAt(expr, i);
    return !!fn && ACTION_OPS.has(fn.name);
  });
  if (at >= expr.length) return { selector: expr.trim(), action: null };
  const fn = functionalPseudoAt(expr, at)!;
  const paren = readParen(expr, fn.open);
  if (!paren || expr.slice(paren.end + 1).trim()) return null;
  return {
    selector: expr.slice(0, at).trim(),
    action: { name: fn.name as ProceduralActionName, arg: paren.arg.trim() },
  };
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

type Task = (nodes: Node[]) => Node[];

interface PSelector {
  /** CSS the candidates start from; '' means the input node itself (the document at top level). */
  selector: string;
  tasks: Task[];
  /** Node-independent `:matches-path()` conditions hoisted out of `tasks`: all must hold. */
  gates: (() => boolean)[];
  /** A top-level selector list: the union of its members. */
  alternatives?: PSelector[];
  /** No operators at all: `selector` is plain CSS. */
  plain: boolean;
}

/**
 * uBO's regexFromString: `/re/flags` as a regex, anything else as a literal — a substring
 * match, or the whole value when `exact` (uBO anchors literal `:matches-css`/`:matches-attr`
 * values, so `z-index: 0` does not also match 10 and 100).
 */
function regexFromString(s: string, exact = false, unescape = false): RegExp {
  if (s === '') return /^/;
  // uBO's flag set. Anything else after the last slash is part of a literal:
  // `:matches-path(/marketplace/item)` is a path, not the regex /marketplace/ with flags "item".
  // (`g` and `y` would also make .test() stateful through lastIndex.)
  const m = /^\/(.+)\/([imu]*)$/.exec(s);
  if (m) return new RegExp(m[1], m[2]);
  const text = unescape ? s.replace(/\\(.)/g, '$1') : s;
  const literal = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(exact ? `^${literal}$` : literal);
}

/**
 * Strip one pair of surrounding quotes, as uBO's unquoteString does: only `\\` and an escaped
 * quote lose their backslash, so a quoted `/a\[0\]/` regex keeps its escapes.
 */
function unquote(s: string): string {
  const q = s[0];
  if ((q !== '"' && q !== "'") || s.length < 2 || !s.endsWith(q)) return s;
  let out = '';
  for (let i = 1; i < s.length - 1; i++) {
    let c = s[i];
    if (c === '\\' && i + 1 < s.length - 1 && (s[i + 1] === '\\' || s[i + 1] === q)) {
      c = s[++i];
    }
    out += c;
  }
  return out;
}

function isElement(n: Node): n is Element {
  return n.nodeType === 1;
}

function uniq(nodes: Iterable<Node>): Node[] {
  return [...new Set(nodes)];
}

/** Elements matching `sel` among the siblings after `el` (uBO's `:nth-child` spath trick). */
function siblingQuery(el: Element, sel: string): Element[] {
  const parent = el.parentElement;
  if (!parent) return [];
  let pos = 1;
  for (let n = el.previousElementSibling; n; n = n.previousElementSibling) pos++;
  return Array.from(parent.querySelectorAll(`:scope > :nth-child(${pos}) ${sel}`));
}

/** Split plain CSS at its first top-level combinator: the compound before it tests the node. */
function splitCompound(seg: string): { compound: string; rest: string } {
  if (/^\s/.test(seg) || /^[>+~]/.test(seg)) return { compound: '', rest: seg };
  let depth = 0;
  let quote = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && (/\s/.test(c) || c === '>' || c === '+' || c === '~')) {
      return { compound: seg.slice(0, i), rest: seg.slice(i) };
    }
  }
  return { compound: seg, rest: '' };
}

/** Above this many input nodes, a descendant step runs one document query instead of one each. */
const BATCH_THRESHOLD = 8;

function spathTask(arg: string): Task {
  const { compound, rest } = splitCompound(arg);
  const tail = rest.trim();
  const kind = !tail ? 'none' : tail[0] === '>' ? 'child' : tail[0] === '+' || tail[0] === '~' ? 'sibling' : 'descendant';
  return (nodes) => {
    let base = nodes;
    if (compound) base = nodes.filter((n) => isElement(n) && n.matches(compound));
    if (kind === 'none') return base;
    const out = new Set<Node>();
    if (kind === 'descendant' && base.length > BATCH_THRESHOLD) {
      // uBO runs `node.querySelectorAll(spath)` per node. Same set, one query: every match of
      // the spath that sits inside one of the nodes.
      const set = new Set(base);
      for (const m of Array.from(document.querySelectorAll(tail))) {
        for (let p = m.parentNode; p; p = p.parentNode) {
          if (set.has(p)) {
            out.add(m);
            break;
          }
        }
      }
      return [...out];
    }
    for (const n of base) {
      if (kind === 'descendant') {
        for (const m of Array.from((n as ParentNode).querySelectorAll(tail))) out.add(m);
      } else if (!isElement(n)) {
        continue;
      } else if (kind === 'child') {
        for (const m of Array.from(n.querySelectorAll(`:scope ${tail}`))) out.add(m);
      } else {
        for (const m of siblingQuery(n, tail)) out.add(m);
      }
    }
    return [...out];
  };
}

function filterElements(test: (el: Element) => boolean): Task {
  return (nodes) => nodes.filter((n) => isElement(n) && test(n));
}

/** `prop: value`, optionally `before, prop: value` (uBO's newer :matches-css syntax). */
function matchesCssTask(arg: string, pseudoFromName: string | null): Task {
  let rest = arg;
  let pseudo = pseudoFromName;
  const pm = /^(before|after)\s*,\s*/i.exec(rest);
  if (pm) {
    pseudo = `::${pm[1].toLowerCase()}`;
    rest = rest.slice(pm[0].length);
  }
  const idx = rest.indexOf(':');
  if (idx <= 0) throw new Error('matches-css needs prop: value');
  const prop = rest.slice(0, idx).trim();
  const value = regexFromString(unquote(rest.slice(idx + 1).trim()), true);
  return filterElements((el) => {
    const style = getComputedStyle(el, pseudo);
    return value.test(style.getPropertyValue(prop).trim());
  });
}

/** uBO's compileMatchAttrArgument: `name`, `name=value`, either side quoted or /regex/. */
function matchesAttrTask(arg: string): Task {
  let name = '';
  let value = '';
  const q = arg[0];
  if (q === '"' || q === "'") {
    let end = 1;
    while (end < arg.length && arg[end] !== q) end += arg[end] === '\\' ? 2 : 1;
    name = unquote(arg.slice(0, end + 1));
    const tail = arg.slice(end + 1).trim();
    if (tail && !tail.startsWith('=')) throw new Error('bad matches-attr');
    value = tail.slice(1).trim();
  } else {
    const eq = arg.indexOf('=');
    name = (eq === -1 ? arg : arg.slice(0, eq)).trim();
    value = eq === -1 ? '' : arg.slice(eq + 1).trim();
  }
  if (!name) throw new Error('bad matches-attr');
  const reName = regexFromString(name, true);
  const reValue = regexFromString(unquote(value), true);
  return filterElements((el) =>
    el.getAttributeNames().some((a) => reName.test(a) && reValue.test(el.getAttribute(a) ?? '')),
  );
}

function upwardTask(arg: string): Task {
  if (/^\d+$/.test(arg)) {
    const n = Number(arg);
    if (n < 1 || n > 255) throw new Error('bad upward');
    return (nodes) => {
      const out = new Set<Node>();
      for (const node of nodes) {
        let t: Element | null = isElement(node) ? node : null;
        for (let k = 0; k < n && t; k++) t = t.parentElement;
        if (t) out.add(t);
      }
      return [...out];
    };
  }
  if (!arg) throw new Error('bad upward');
  return (nodes) => {
    const out = new Set<Node>();
    for (const node of nodes) {
      const t = isElement(node) ? node.parentElement?.closest(arg) : null;
      if (t) out.add(t);
    }
    return [...out];
  };
}

function xpathTask(arg: string): Task {
  if (!arg) throw new Error('bad xpath');
  return (nodes) => {
    const out = new Set<Node>();
    for (const node of nodes) {
      const res = document.evaluate(arg, node, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let k = 0; k < res.snapshotLength; k++) {
        const n = res.snapshotItem(k);
        if (n && isElement(n)) out.add(n);
      }
    }
    return [...out];
  };
}

function matchesPathGate(arg: string): () => boolean {
  const needle = regexFromString(arg.replace(/[^\x00-\x7f]/g, (c) => encodeURIComponent(c)));
  return () => needle.test(location.pathname + location.search);
}

/** A pure `:matches-path()` selector (as in `:not(:matches-path(/x/))`) is a page condition. */
function asGate(ps: PSelector): (() => boolean) | null {
  if (ps.selector !== '' || ps.tasks.length || ps.alternatives || !ps.gates.length) return null;
  const gates = ps.gates;
  return () => gates.every((g) => g());
}

function selectorArgTask(name: string, arg: string, gates: (() => boolean)[]): Task | null {
  if (!arg) throw new Error(`empty :${name}()`);
  const procedural = isProceduralSelector(arg);
  if (name === 'is' || name === 'where') {
    // Not a uBO operator; kept for rules that reach it as plain CSS after an operator.
    if (!procedural) return filterElements((el) => el.matches(`:is(${arg})`));
    const sub = compileSelector(arg);
    return filterElements((el) => testSelf(sub, el));
  }
  const negate = name === 'not' || name === 'if-not';
  if (!procedural) {
    // Native CSS: `:not()` tests the node itself; `:has()`/`:if()` test relatives of it.
    if (name === 'not') return filterElements((el) => !el.matches(arg));
    const rel = `:has(${arg})`;
    return filterElements((el) => el.matches(rel) !== negate);
  }
  const sub = compileSelector(arg);
  const gate = asGate(sub);
  if (gate) {
    // Node-independent: hoisted so a page that fails it never queries the DOM at all.
    gates.push(negate ? () => !gate() : gate);
    return null;
  }
  return filterElements((el) => testPSelector(sub, el) !== negate);
}

function compileTask(op: Op, gates: (() => boolean)[]): Task | null {
  const { name, arg } = op;
  switch (name) {
    case 'has-text':
    case 'contains':
    case '-abp-contains': {
      const re = regexFromString(arg, false, true);
      return filterElements((el) => re.test(el.textContent ?? ''));
    }
    case 'min-text-length': {
      if (!/^\d+$/.test(arg)) throw new Error('bad min-text-length');
      const n = Number(arg);
      return filterElements((el) => (el.textContent ?? '').trim().length >= n);
    }
    case 'matches-css':
      return matchesCssTask(arg, null);
    case 'matches-css-before':
      return matchesCssTask(arg, '::before');
    case 'matches-css-after':
      return matchesCssTask(arg, '::after');
    case 'matches-attr':
      return matchesAttrTask(arg);
    case 'matches-path':
      gates.push(matchesPathGate(arg));
      return null;
    case 'upward':
      return upwardTask(arg);
    case 'xpath':
      return xpathTask(arg);
    case 'watch-attr':
      // A re-run trigger only: the observer watches these attributes (see observer init).
      return null;
    case 'has':
    case '-abp-has':
    case 'if':
    case 'if-not':
    case 'not':
    case 'is':
    case 'where':
      return selectorArgTask(name, arg, gates);
    case 'selector':
      return spathTask(arg);
    default:
      // Unknown or misplaced (an action in the middle of a chain): fail closed.
      throw new Error(`unsupported procedural operator :${name}()`);
  }
}

function compileOne(raw: string): PSelector {
  // An empty member (`.a,,.b`, or a rule that was only an action) must not become `*`.
  if (!raw.trim()) throw new Error('empty selector');
  const parsed = parseProcedural(raw);
  const gates: (() => boolean)[] = [];
  const tasks: Task[] = [];
  for (const op of parsed.ops) {
    const t = compileTask(op, gates);
    if (t) tasks.push(t);
  }
  const selector = parsed.empty ? '' : parsed.prefix;
  return { selector, tasks, gates, plain: parsed.ops.length === 0 };
}

const compileCache = new Map<string, PSelector>();

/** Compile a (possibly procedural) selector. Throws on anything the engine cannot honor. */
function compileSelector(raw: string): PSelector {
  const hit = compileCache.get(raw);
  if (hit) return hit;
  const parts = splitSelectorList(raw);
  let ps: PSelector;
  if (parts.length > 1 && parts.some(isProceduralSelector)) {
    const alternatives = parts.map(compileOne);
    ps = { selector: '', tasks: [], gates: [], alternatives, plain: false };
  } else {
    ps = compileOne(raw);
  }
  compileCache.set(raw, ps);
  return ps;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function prime(ps: PSelector, input: Node | undefined): Node[] {
  const root: Node = input ?? document;
  if (ps.selector === '') return [root];
  if (input && isElement(input)) {
    const sel = ps.selector.trim();
    const c0 = sel[0];
    if (c0 === '+' || c0 === '~') return siblingQuery(input, sel);
    if (c0 === '>') return Array.from(input.querySelectorAll(`:scope ${sel}`));
  }
  return Array.from((root as ParentNode).querySelectorAll(ps.selector));
}

function gatesPass(ps: PSelector): boolean {
  for (const g of ps.gates) if (!g()) return false;
  return true;
}

function execPSelector(ps: PSelector, input?: Node): Node[] {
  if (!gatesPass(ps)) return [];
  if (ps.alternatives) return uniq(ps.alternatives.flatMap((a) => execPSelector(a, input)));
  let nodes = prime(ps, input);
  for (const task of ps.tasks) {
    if (!nodes.length) break;
    nodes = task(nodes);
  }
  return nodes;
}

/** uBO's PSelector.test: does anything reachable from `node` survive the chain? */
function testPSelector(ps: PSelector, node: Element): boolean {
  if (!gatesPass(ps)) return false;
  if (ps.alternatives) return ps.alternatives.some((a) => testPSelector(a, node));
  for (const start of prime(ps, node)) {
    let out: Node[] = [start];
    for (const task of ps.tasks) {
      out = task(out);
      if (!out.length) break;
    }
    if (out.length) return true;
  }
  return false;
}

/** Does `el` itself satisfy `ps` (CSS `:is()` semantics)? */
function testSelf(ps: PSelector, el: Element): boolean {
  if (!gatesPass(ps)) return false;
  if (ps.alternatives) return ps.alternatives.some((a) => testSelf(a, el));
  if (ps.selector && !el.matches(ps.selector)) return false;
  let out: Node[] = [el];
  for (const task of ps.tasks) {
    out = task(out);
    if (!out.length) return false;
  }
  return out.includes(el);
}

/** A compiled rule: its selector, ready to run, and whether plain CSS could express it. */
export interface CompiledProcedural {
  run(): Element[];
  /** The whole selector is plain CSS (no operators), so a stylesheet rule can apply it. */
  readonly plainCss: string | null;
}

/** Compile `selector` (no action). Returns null when the engine cannot honor it. */
export function compileProcedural(selector: string): CompiledProcedural | null {
  let ps: PSelector;
  if (!selector.trim()) return null;
  try {
    ps = compileSelector(selector);
  } catch {
    return null;
  }
  const plainCss = ps.plain && !ps.alternatives && ps.selector ? ps.selector : null;
  return {
    plainCss,
    run(): Element[] {
      try {
        return execPSelector(ps).filter(isElement);
      } catch {
        return [];
      }
    },
  };
}

/** Evaluate a procedural selector, returning the matched elements. Actions are not applied. */
export function queryProcedural(selector: string): Element[] {
  const split = splitProceduralAction(selector);
  if (!split) return [];
  return compileProcedural(split.selector)?.run() ?? [];
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Validate a `:style()` declaration block and return it normalized, or null. Resource-loading
 * values are refused as uBO refuses them: a filter list must not make the page fetch URLs.
 */
export function sanitizeStyleDeclaration(decl: string): string | null {
  if (!decl || /[{}<>]|\/\*|\\|@/.test(decl)) return null;
  if (/(?:url|image|image-set|-webkit-image-set|cross-fade|element|expression)\s*\(/i.test(decl)) {
    return null;
  }
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`x{${decl}}`);
    const rule = sheet.cssRules[0];
    if (sheet.cssRules.length !== 1 || !(rule instanceof CSSStyleRule) || !rule.style.length) {
      return null;
    }
    return rule.style.cssText;
  } catch {
    return null;
  }
}

/** `:remove-attr()` / `:remove-class()` argument: exact name or /regex/. */
export function actionNameMatcher(arg: string): RegExp | null {
  if (!arg) return null;
  try {
    return regexFromString(unquote(arg), true);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Re-run triggers
// ---------------------------------------------------------------------------

/**
 * MutationObserver options derived from the selectors' actual dependencies: the attributes
 * they name (`.x` → class, `#x` → id, `[data-x]`, `:matches-attr(name)`, xpath `@name`,
 * `:watch-attr(name)`), text for the text operators and xpath text tests, and class/id/style
 * for computed-style tests. Page-wide `style` writes (progress bars, animations) no longer
 * wake rules that never look at style.
 */
/** `expr` with the arguments of `names` blanked, so text and paths are not read as selectors. */
function blankArgs(expr: string, names: Set<string>): string {
  let out = '';
  let i = 0;
  while (i < expr.length) {
    const fn = expr[i] === ':' ? functionalPseudoAt(expr, i) : null;
    if (fn && names.has(fn.name)) {
      const paren = readParen(expr, fn.open);
      if (paren) {
        out += `:${fn.name}()`;
        i = paren.end + 1;
        continue;
      }
    }
    out += expr[i++];
  }
  return out;
}

const NON_SELECTOR_ARG_OPS = new Set([
  'has-text',
  'contains',
  '-abp-contains',
  'min-text-length',
  'matches-path',
  'matches-css',
  'matches-css-before',
  'matches-css-after',
  'matches-attr',
  'watch-attr',
  'xpath',
  'style',
  'remove-attr',
  'remove-class',
]);

export function proceduralMutationObserverInit(exprs: string[]): MutationObserverInit {
  let characterData = false;
  let allAttributes = false;
  const attrs = new Set<string>();

  for (const expr of exprs) {
    const bare = blankArgs(expr, NON_SELECTOR_ARG_OPS).replace(
      /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g,
      '""',
    );
    if (/:(?:has-text|contains|-abp-contains|min-text-length)\(/.test(bare)) characterData = true;
    // `.x` after anything but a digit (`1.5em` is not a class) or an escape.
    if (/(?:^|[^\\0-9])\.-?[_a-zA-Z]/.test(bare)) attrs.add('class');
    if (/(?:^|[^\\])#-?[_a-zA-Z]/.test(bare)) attrs.add('id');
    for (const m of bare.matchAll(/\[\s*([-\w]+)/g)) attrs.add(m[1].toLowerCase());
    if (/:matches-css/.test(bare)) {
      attrs.add('class');
      attrs.add('style');
      attrs.add('id');
    }
    for (const m of expr.matchAll(/:matches-attr\(\s*(["']?)([^"'=)]*)/g)) {
      const name = m[2].trim();
      if (!name || name.startsWith('/')) allAttributes = true;
      else attrs.add(name.toLowerCase());
    }
    for (const m of expr.matchAll(/:watch-attr\(([^)]*)\)/g)) {
      const names = m[1].split(',').map((n) => unquote(n.trim())).filter(Boolean);
      if (!names.length) allAttributes = true;
      for (const n of names) attrs.add(n.toLowerCase());
    }
    for (const m of expr.matchAll(/:xpath\(/g)) {
      const paren = readParen(expr, (m.index ?? 0) + m[0].length - 1);
      const xp = paren?.arg ?? '';
      if (/text\(\)|contains\(|string\(|normalize-space\(|string-length\(/.test(xp)) characterData = true;
      if (/@\*/.test(xp)) allAttributes = true;
      for (const a of xp.matchAll(/@([-\w]+)/g)) attrs.add(a[1].toLowerCase());
    }
  }

  const init: MutationObserverInit = { childList: true, subtree: true, characterData };
  if (allAttributes) init.attributes = true;
  else if (attrs.size) {
    init.attributes = true;
    init.attributeFilter = [...attrs];
  } else init.attributes = false;
  return init;
}
