// Bundled scriptlet library. Scriptlets run in the page's MAIN world to neutralize
// anti-adblock checks and ad bootstrap scripts. Under MV3 we can't inject arbitrary
// remote code, so the implementations must ship with the extension — this is that set.
//
// Names + aliases follow uBlock Origin's resources so uBO filter lists (##+js(...))
// work unchanged. Each implementation is defensive: a throwing scriptlet must never
// break the page beyond what the filter author intended.

import { frameHostOf } from '../shared/frame-scope.js';

type Scriptlet = (args: string[]) => void;

const ALIASES: Record<string, string> = {
  set: 'set-constant',
  'set-constant': 'set-constant',
  aopr: 'abort-on-property-read',
  'abort-on-property-read': 'abort-on-property-read',
  aopw: 'abort-on-property-write',
  'abort-on-property-write': 'abort-on-property-write',
  // uBO short names: `acs` is the common form in filter lists; `acis` is rarer.
  // `abort-current-script` is uBO's canonical name; the inline-script one is its old alias.
  acs: 'abort-current-inline-script',
  acis: 'abort-current-inline-script',
  'abort-current-script': 'abort-current-inline-script',
  'abort-current-inline-script': 'abort-current-inline-script',
  nostif: 'prevent-setTimeout',
  'no-setTimeout-if': 'prevent-setTimeout',
  'prevent-setTimeout': 'prevent-setTimeout',
  nosiif: 'prevent-setInterval',
  'no-setInterval-if': 'prevent-setInterval',
  'prevent-setInterval': 'prevent-setInterval',
  ra: 'remove-attr',
  'remove-attr': 'remove-attr',
  rc: 'remove-class',
  'remove-class': 'remove-class',
  'json-prune': 'json-prune',
  'json-prune-fetch-response': 'json-prune-fetch-response',
  'json-prune-xhr-response': 'json-prune-xhr-response',
  'trusted-replace-fetch-response': 'trusted-replace-fetch-response',
  'trusted-replace-xhr-response': 'trusted-replace-xhr-response',
  // Popunder defuser — the single largest unimplemented group in the shipped lists.
  nowoif: 'no-window-open-if',
  'no-window-open-if': 'no-window-open-if',
  'window.open-defuser': 'no-window-open-if',
  aeld: 'addEventListener-defuser',
  'addEventListener-defuser': 'addEventListener-defuser',
  'prevent-addEventListener': 'addEventListener-defuser',
  'no-fetch-if': 'prevent-fetch',
  'prevent-fetch': 'prevent-fetch',
  'nano-stb': 'nano-setTimeout-booster',
  'nano-setTimeout-booster': 'nano-setTimeout-booster',
  'nano-sib': 'nano-setInterval-booster',
  'nano-setInterval-booster': 'nano-setInterval-booster',
  'noeval-if': 'prevent-eval-if',
  'prevent-eval-if': 'prevent-eval-if',
  // Plain `noeval` is the same hook with an empty (match-all) pattern.
  noeval: 'prevent-eval-if',
  'noeval.js': 'prevent-eval-if',
  nowebrtc: 'nowebrtc',
  // Inline-script text editing — see replaceNodeText for the measured timing limits.
  rmnt: 'remove-node-text',
  'remove-node-text': 'remove-node-text',
  rpnt: 'replace-node-text',
  'replace-node-text': 'replace-node-text',
  'no-xhr-if': 'prevent-xhr',
  'prevent-xhr': 'prevent-xhr',
  aost: 'abort-on-stack-trace',
  'abort-on-stack-trace': 'abort-on-stack-trace',
  'set-cookie': 'set-cookie',
  'set-local-storage-item': 'set-local-storage-item',
  'popads-dummy': 'popads-dummy',
};

// Arguments arrive exactly as uBO's ArglistParser leaves them (scripts/lib/parse-filter.mjs
// splitArgs): outer quotes and delimiter escapes are already gone. What remains is the value
// itself, so a quote left in it is literal — uBO's `'"adPlacements"'` means the JSON key with
// its quotes — and nothing here may unquote or unescape a second time.

function parseConstant(v: string): unknown {
  switch (v) {
    case 'undefined':
      return undefined;
    case 'false':
      return false;
    case 'true':
      return true;
    case 'null':
      return null;
    case 'noopFunc':
      return function () {};
    case 'trueFunc':
      return function () {
        return true;
      };
    case 'falseFunc':
      return function () {
        return false;
      };
    case 'emptyObj':
    case '{}':
      return {};
    case 'emptyArr':
    case '[]':
      return [];
    case "''":
    case '':
      return '';
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function defineLeaf(owner: object, prop: string, value: unknown): void {
  try {
    // No `enumerable`, as in uBO's trapProp: an existing property keeps its own, a missing one
    // stays hidden. `set Object.prototype.hideAds true` must not add `hideAds` to every
    // `for…in` and `Object.assign` on the page.
    Object.defineProperty(owner, prop, {
      get: () => value,
      set: () => {},
      configurable: true,
    });
  } catch {
    try {
      (owner as Record<string, unknown>)[prop] = value as never;
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Shared helpers (uBO safeSelf equivalents)
// ---------------------------------------------------------------------------

// Captured when the library is injected, before page code can replace them: matching must not
// be steerable, or breakable, by a page that later swaps these globals.
const ErrorCtor = Error;
const URLCtor = URL;
const reflectGet = Reflect.get;
const fnToString = Function.prototype.toString;
const objectToString = Object.prototype.toString;
const nativeAddEventListener =
  typeof EventTarget === 'function' ? EventTarget.prototype.addEventListener : undefined;
const nativeRemoveEventListener =
  typeof EventTarget === 'function' ? EventTarget.prototype.removeEventListener : undefined;

const isObjectLike = (v: unknown): v is object =>
  (typeof v === 'object' && v !== null) || typeof v === 'function';

/** `/body/flags` with real RegExp flags. `/api/graphql` is a path, not `/api/` + flags `graphql`. */
const REGEX_LITERAL = /^\/(.+)\/([dgimsuvy]*)$/;

/** RegExp#test from index 0: a `g`/`y` needle otherwise resumes where the previous haystack matched. */
function testRe(re: RegExp, text: string): boolean {
  re.lastIndex = 0;
  return re.test(text);
}

function textMatcher(pattern: string | undefined): (t: string) => boolean {
  if (!pattern || pattern === '*') return () => true;
  const rx = REGEX_LITERAL.exec(pattern);
  if (rx) {
    try {
      const re = new RegExp(rx[1], rx[2]);
      return (t) => testRe(re, t);
    } catch {
      return () => false;
    }
  }
  return (t) => t.includes(pattern);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * uBO's patternToRegex: '' matches everything, `/re/flags` is used as written (its own flags,
 * none when none are given), anything else is an escaped literal — anchored `^…$` when
 * `verbatim`. An invalid regex returns null so the caller does nothing; uBO falls back to
 * match-all there, which for these scriptlets means "abort or rewrite everything".
 */
function patternToRegex(pattern: string, flags?: string, verbatim = false): RegExp | null {
  if (pattern === '') return new RegExp('^');
  const m = REGEX_LITERAL.exec(pattern);
  if (m === null) {
    const body = escapeRegex(pattern);
    return new RegExp(verbatim ? `^${body}$` : body, flags);
  }
  try {
    return new RegExp(m[1], m[2] || undefined);
  } catch {
    return null;
  }
}

type ExtraArgs = Record<string, string | number | undefined>;

/** uBO getExtraArgs: trailing `key, value` pairs; an all-digit value becomes a number. */
function getExtraArgs(args: string[]): ExtraArgs {
  const out: ExtraArgs = Object.create(null);
  for (let i = 0; i < args.length; i += 2) {
    const raw = args[i + 1];
    out[args[i]] = raw !== undefined && /^\d+$/.test(raw) ? parseInt(raw, 10) : raw;
  }
  return out;
}

const READY_STATES = new Map<string, number>([
  ['loading', 1],
  ['asap', 1],
  ['interactive', 2],
  ['end', 2],
  ['2', 2],
  ['complete', 3],
  ['idle', 3],
  ['3', 3],
]);

/** uBO runAt: run now if the document has reached `when`, else on the readystatechange that gets it there. */
function runAt(fn: () => void, when: unknown): void {
  const target = READY_STATES.get(String(when)) ?? 0;
  const reached = (): boolean => (READY_STATES.get(String(document.readyState)) ?? 0) >= target;
  if (target === 0 || reached()) {
    fn();
    return;
  }
  // The native listener methods, not the page-visible ones: an aeld rule could otherwise drop
  // this scriptlet's own listener.
  const add = nativeAddEventListener ?? document.addEventListener;
  const remove = nativeRemoveEventListener ?? document.removeEventListener;
  const onChange = (): void => {
    if (!reached()) return;
    try {
      remove.call(document, 'readystatechange', onChange, true);
    } catch {
      /* ignore */
    }
    fn();
  };
  try {
    add.call(document, 'readystatechange', onChange, true);
  } catch {
    /* not an event target: the state can never be observed advancing */
  }
}

// ---------------------------------------------------------------------------
// Property traps
// ---------------------------------------------------------------------------

/**
 * Whether `owner[prop]` may be replaced by a re-arming accessor (see onChainOwner). Missing
 * properties and page-made plain objects may. Built-ins (`Math`, `JSON`, constructors) and
 * inherited platform members (`document.body`) are only walked: an accessor on `window.Object`
 * would slow every global lookup on the page, and a snapshot of `document.body` would freeze a
 * live value that the parser sets without ever calling a setter.
 */
function canTrapLink(owner: object, prop: string): boolean {
  let desc: PropertyDescriptor | undefined;
  try {
    desc = Object.getOwnPropertyDescriptor(owner, prop);
    if (!desc) return !(prop in owner);
  } catch {
    return false;
  }
  if (!desc.configurable) return false;
  if (desc.get || desc.set) return desc.set !== undefined;
  const v: unknown = desc.value;
  if (!isObjectLike(v)) return true;
  if (typeof v === 'function') return false;
  try {
    return objectToString.call(v) === '[object Object]';
  } catch {
    return false;
  }
}

/** Accessor on `owner[prop]` that keeps behaving like the property and calls `onAssign` on writes. */
function trapLink(owner: object, prop: string, onAssign: (v: unknown) => void): void {
  let desc: PropertyDescriptor | undefined;
  try {
    desc = Object.getOwnPropertyDescriptor(owner, prop);
  } catch {
    return;
  }
  // A setter already here (a site's reactive property, or another rule's trap) is chained, so
  // several rules on one root all stay armed.
  const prevGet = desc?.get;
  const prevSet = desc?.set;
  const isAccessor = !!(prevGet || prevSet);
  let held: unknown = desc && !isAccessor ? desc.value : undefined;
  // A missing link starts hidden, like the absent property it stands in for (uBO's trapProp
  // never sets `enumerable`). `set Object.prototype.ads.nopreroll_ true` puts this accessor on
  // Object.prototype, and an enumerable one would add `ads` to every `for…in` and naive clone
  // on the page. It turns visible once the site assigns it, as a real property would.
  let hidden = desc === undefined;
  try {
    Object.defineProperty(owner, prop, {
      configurable: true,
      enumerable: desc ? desc.enumerable : false,
      get(this: unknown) {
        if (isAccessor) return prevGet ? prevGet.call(this) : undefined;
        return held;
      },
      set(this: unknown, v: unknown) {
        if (isAccessor) {
          if (prevSet) prevSet.call(this, v);
        } else if (this !== owner && isObjectLike(this)) {
          // Written through an object that inherits from `owner` (a trap on a prototype): that
          // object gets its own property, as it would from a plain data property, and the value
          // is still armed. `o.ads = {nopreroll_: false}` is exactly the assignment a
          // `Object.prototype.ads.nopreroll_` rule is written for.
          try {
            Object.defineProperty(this, prop, { value: v, writable: true, enumerable: true, configurable: true });
          } catch {
            return;
          }
        } else {
          held = v;
          if (hidden) {
            hidden = false;
            try {
              Object.defineProperty(owner, prop, { enumerable: true });
            } catch {
              /* ignore */
            }
          }
        }
        onAssign(v);
      },
    });
  } catch {
    /* frozen or non-configurable */
  }
}

/**
 * Apply `fn` to a dotted chain's owner, now and whenever the site creates or replaces an object
 * along the chain — uBO's makeProxy/trapChain.
 *
 * At document_start the script that creates `_sp_` has not run yet, and sites routinely build
 * config objects step by step (`a = {}; a.b = {c: 1}`), so walking the chain once misses most
 * real pages. Every missing level gets a setter that re-arms the rest of the chain when the site
 * assigns it; plain page objects that already exist are trapped the same way so a wholesale
 * replacement (`window._sp_ = {...}`) is caught too.
 */
function onChainOwner(chain: string, fn: (owner: object, prop: string) => void): void {
  const parts = chain.split('.').filter(Boolean);
  if (!parts.length) return;
  const last = parts.length - 1;
  // Per rule: an object assigned again, or reached twice, must not stack another trap.
  const armed = new WeakMap<object, Set<number>>();
  const arm = (owner: object, depth: number): void => {
    let seen = armed.get(owner);
    if (!seen) armed.set(owner, (seen = new Set()));
    if (seen.has(depth)) return;
    seen.add(depth);
    const prop = parts[depth];
    if (depth === last) {
      fn(owner, prop);
      return;
    }
    let next: unknown;
    try {
      next = (owner as Record<string, unknown>)[prop];
    } catch {
      return;
    }
    if (isObjectLike(next)) arm(next, depth + 1);
    if (!canTrapLink(owner, prop)) return;
    trapLink(owner, prop, (v) => {
      if (isObjectLike(v)) arm(v, depth + 1);
    });
  };
  arm(window, 0);
}

let checking = false;

/**
 * Shadow `owner[prop]` with an accessor that runs `check` on every read and write and otherwise
 * behaves exactly like the property it replaces.
 *
 * Most acs/aost targets are inherited platform members — `document.createElement`,
 * `addEventListener`, `document.cookie`, `readyState` — so the value has to be found along the
 * prototype chain, and native accessors called with the real receiver. Reading only the own
 * descriptor turned every one of those into `undefined` for the whole page (434 shipped acs
 * rules), and a store-only setter swallowed the page's own `onload` handler.
 *
 * Checks do not nest: the check itself uses string and regex methods, and a rule on one of
 * those (`aost, String.prototype.includes, …`) would otherwise recurse until the stack overflows.
 */
function trapAccess(owner: object, prop: string, rawCheck: () => void): void {
  const check = (): void => {
    if (checking) return;
    checking = true;
    try {
      rawCheck();
    } finally {
      checking = false;
    }
  };
  let holder: object | null = owner;
  let desc: PropertyDescriptor | undefined;
  try {
    while (holder !== null) {
      desc = Object.getOwnPropertyDescriptor(holder, prop);
      if (desc) break;
      holder = Object.getPrototypeOf(holder) as object | null;
    }
  } catch {
    return;
  }
  const isOwn = desc !== undefined && holder === owner;
  if (isOwn && desc!.configurable === false) return;
  const nativeGet = desc?.get;
  const nativeSet = desc?.set;
  const isAccessor = !!(nativeGet || nativeSet);
  const writable = desc === undefined || isAccessor || desc.writable !== false;
  // An own data value is held here. An inherited one is read live from its prototype until the
  // page assigns one, so a site that later patches `Document.prototype.createElement` still gets
  // its own version back.
  let hasValue = isOwn && !isAccessor;
  let value: unknown = hasValue ? desc!.value : undefined;
  try {
    Object.defineProperty(owner, prop, {
      configurable: true,
      get(this: unknown) {
        check();
        if (isAccessor) return nativeGet ? nativeGet.call(this) : undefined;
        if (hasValue) return value;
        return holder !== null ? reflectGet(holder, prop, this) : undefined;
      },
      set(this: unknown, v: unknown) {
        check();
        if (isAccessor) {
          if (nativeSet) nativeSet.call(this, v);
          return;
        }
        if (!writable) return;
        if (this !== owner && isObjectLike(this)) {
          // Trap on a prototype, written through an instance: the instance gets its own
          // property, exactly as an ordinary inherited data property would give it.
          Object.defineProperty(this, prop, { value: v, writable: true, enumerable: true, configurable: true });
          return;
        }
        value = v;
        hasValue = true;
      },
    });
  } catch {
    /* non-configurable */
  }
}

// ---------------------------------------------------------------------------
// Stack traces (uBO matchesStackTraceFn)
// ---------------------------------------------------------------------------

const STACK_FRAME = /(.*?@)?(\S+)(:\d+):\d+\)?$/;
let selfUrl: string | undefined;
let docHref: string | undefined;
let docUrl = '';

/** The document URL as a stack frame shows it (no fragment); re-parsed only when it changes. */
function documentUrl(): string {
  try {
    const href = location.href;
    if (href !== docHref) {
      const u = new URLCtor(href);
      u.hash = '';
      docHref = href;
      docUrl = u.href;
    }
  } catch {
    return '';
  }
  return docUrl;
}

/** URL this library was loaded from, so its own frames can be left out of stack matching. */
function ownScriptUrl(): string {
  if (selfUrl === undefined) {
    selfUrl = '';
    try {
      for (const line of String(new ErrorCtor().stack ?? '').split(/[\n\r]+/)) {
        const m = STACK_FRAME.exec(line.trim());
        if (!m) continue;
        selfUrl = m[2].startsWith('(') ? m[2].slice(1) : m[2];
        break;
      }
    } catch {
      /* no stack support */
    }
  }
  return selfUrl;
}

/**
 * The stack in the form uBO filter authors write needles against: one `fn url:line:1` entry per
 * frame, the document URL written as `inlineScript` and `<anonymous>` as `injectedScript`, joined
 * with tabs behind a `stackDepth:N` header. A raw V8 stack never contains `inlineScript`, and its
 * newlines stop `.*` in the `^(?!.*\.js)` style needles at the first line.
 *
 * This library's own frames are dropped: they carry the extension's `scriptlets-runtime.js` URL, which
 * uBO's page-injected scriptlets never show, and would satisfy every `.js` needle. N still counts
 * the frames uBO's own trap contributes (`ownFrames`), so `stackDepth:` needles line up.
 */
function normalizeStack(raw: unknown, ownFrames: number): string {
  const self = ownScriptUrl();
  const doc = documentUrl();
  const lines: string[] = [];
  for (let line of String(raw ?? '').split(/[\n\r]+/)) {
    line = line.trim();
    const m = STACK_FRAME.exec(line);
    if (!m) continue;
    let url = m[2];
    if (url.startsWith('(')) url = url.slice(1);
    if (self !== '' && url === self) continue;
    if (url === doc) url = 'inlineScript';
    else if (url.startsWith('<anonymous>')) url = 'injectedScript';
    let fn = m[1] !== undefined ? m[1].slice(0, -1) : line.slice(0, m.index).trim();
    if (fn.startsWith('at')) fn = fn.slice(2).trim();
    lines.push(' ' + `${fn} ${url}${m[3]}:1`.trim());
  }
  return [`stackDepth:${lines.length + ownFrames}`, ...lines].join('\t');
}

// ---------------------------------------------------------------------------
// Property scriptlets
// ---------------------------------------------------------------------------

/**
 * Assign a constant along a dotted path. Missing intermediates are trapped, never invented:
 * fabricating `window.ytcfg = {}` breaks sites like YouTube that assign the whole blob later,
 * so the leaf is defined once the site builds the chain itself.
 */
function setConstant(chain: string, rawValue: string): void {
  const value = parseConstant(rawValue);
  onChainOwner(chain, (owner, prop) => defineLeaf(owner, prop, value));
}

const AbortError = (): never => {
  throw new ReferenceError('StampStack: aborted property access');
};

function abortOnPropertyRead(chain: string): void {
  // Via onChainOwner so a chain whose intermediate object does not exist yet still gets the
  // trap when the site creates it — see the note there.
  onChainOwner(chain, (owner, prop) => {
    try {
      Object.defineProperty(owner, prop, { get: AbortError, set: () => {}, configurable: true });
    } catch {
      /* non-configurable */
    }
  });
}

function abortOnPropertyWrite(chain: string): void {
  onChainOwner(chain, (owner, prop) => {
    try {
      Object.defineProperty(owner, prop, {
        set: AbortError,
        get: () => undefined,
        configurable: true,
      });
    } catch {
      /* non-configurable */
    }
  });
}

/**
 * `abort-current-script(chain, needle, context)` — `acs`/`acis`, 1,156 shipped rules; uBO's
 * abortCurrentScriptCore.
 *
 * Throws when `chain` is read or written while the running script's text matches `needle` and,
 * when given, its `src` matches `context`. External scripts count too: their text is empty, so
 * only a needle-less rule aborts them, and a `data:` script is judged on its decoded body. Every
 * other caller sees the property exactly as before (see trapAccess).
 */
export function abortCurrentInlineScript(args: string[]): void {
  const [target = '', needle = '', context = ''] = args;
  if (!target) return;
  const reNeedle = patternToRegex(needle);
  const reContext = context !== '' ? patternToRegex(context) : null;
  if (!reNeedle || (context !== '' && !reContext)) return;

  // uBO walks while the intermediate exists; a missing one is itself trapped, so a script that
  // creates `_sp_` later is still judged when it touches it.
  const chain = target.split('.');
  let owner: object = window;
  let prop = chain.shift() as string;
  while (chain.length) {
    let next: unknown;
    try {
      if (!(prop in owner)) break;
      next = (owner as Record<string, unknown>)[prop];
    } catch {
      return;
    }
    if (!isObjectLike(next)) return;
    owner = next;
    prop = chain.shift() as string;
  }

  const ScriptElement = HTMLScriptElement;
  const thisScript = document.currentScript;
  let textGetter: ((this: Node) => string | null) | undefined;
  try {
    textGetter = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')?.get;
  } catch {
    textGetter = undefined;
  }
  const nativeAtob = typeof atob === 'function' ? atob : undefined;
  const uriDecode = decodeURIComponent;
  const decoded = new WeakMap<object, string>();
  const scriptText = (el: HTMLScriptElement): string => {
    let text = '';
    try {
      text = String((textGetter ? textGetter.call(el) : el.textContent) ?? '');
    } catch {
      text = '';
    }
    if (text.trim() !== '') return text;
    const cached = decoded.get(el);
    if (cached !== undefined) return cached;
    text = '';
    const m = /^data:([^,]*),(.+)$/.exec(String(el.src ?? '').trim());
    if (m) {
      try {
        text = m[1].endsWith(';base64') ? (nativeAtob?.call(globalThis, m[2]) ?? '') : uriDecode(m[2]);
      } catch {
        text = '';
      }
    }
    decoded.set(el, text);
    return text;
  };

  const validate = (): void => {
    const el = document.currentScript;
    if (!(el instanceof ScriptElement) || el === thisScript) return;
    if (reContext && !testRe(reContext, String(el.src ?? ''))) return;
    if (!testRe(reNeedle, scriptText(el))) return;
    throw new ReferenceError('StampStack: aborted current script');
  };
  trapAccess(owner, prop, validate);
}

function preventTimer(kind: 'setTimeout' | 'setInterval', args: string[]): void {
  const [search, delayStr] = args;
  const match = textMatcher(search);
  const wantDelay = delayStr ? parseInt(delayStr, 10) : NaN;
  const original = (window as any)[kind] as (...a: any[]) => number;
  (window as any)[kind] = function (this: unknown, cb: unknown, delay?: number, ...rest: unknown[]) {
    try {
      const cbStr = typeof cb === 'function' ? cb.toString() : String(cb);
      const delayOk = Number.isNaN(wantDelay) || wantDelay === (delay ?? 0);
      if (match(cbStr) && delayOk) return 0;
    } catch {
      /* fall through */
    }
    return original.call(this, cb as any, delay as any, ...rest);
  };
}

function periodic(fn: () => void): void {
  const run = (): void => {
    try {
      fn();
    } catch {
      /* ignore */
    }
  };
  run();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  }
  let scheduled = false;
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      run();
    });
  };
  // `document`, not documentElement: the registered runtime runs at document_start, before the
  // parser has created <html>, and an observer that fails to attach would leave only the
  // DOMContentLoaded pass. Every behavior keeps observing, as all rules did when injection
  // came late (uBO stops after one pass unless `stay`); cutting that back would lose
  // elements that 2.2.x removed.
  try {
    new MutationObserver(schedule).observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
    });
  } catch {
    /* not a Node: nothing to observe */
  }
}

function removeAttr(args: string[]): void {
  const [attrsRaw, selector] = args;
  if (!attrsRaw) return;
  const attrs = attrsRaw.split(/[|,]/).map((a) => a.trim());
  const sel = selector || `[${attrs[0]}]`;
  periodic(() => {
    for (const el of document.querySelectorAll(sel)) {
      for (const a of attrs) el.removeAttribute(a);
    }
  });
}

function removeClass(args: string[]): void {
  const [classesRaw, selector] = args;
  if (!classesRaw) return;
  const classes = classesRaw.split(/[|,]/).map((c) => c.trim());
  const sel = selector || classes.map((c) => `.${CSS.escape(c)}`).join(',');
  periodic(() => {
    for (const el of document.querySelectorAll(sel)) el.classList.remove(...classes);
  });
}

// ---------------------------------------------------------------------------
// Request matching (uBO parsePropertiesToMatchFn / generateContentFn)
// ---------------------------------------------------------------------------

type RequestProps = Record<string, string>;

/** uBO pattern semantics: empty/`*` matches all, `/re/flags` is a regex, leading `!` negates. */
function patternMatcher(raw: string | undefined): (text: string) => boolean {
  if (!raw || raw === '*') return () => true;
  if (raw.startsWith('!')) {
    const inner = textMatcher(raw.slice(1));
    return (t) => !inner(t);
  }
  return textMatcher(raw);
}

/**
 * uBO `propsToMatch`: space-separated `key:pattern` tokens; a bare token (or one whose "key" is
 * not a plain word, like `/api/v1?x:1` or a regex containing `(?:`) is a URL pattern. Every
 * listed property must be present and match — a property the request does not carry fails
 * rather than being skipped, so an unexpected request shape is let through untouched.
 */
function propsMatcher(raw: unknown): (props: RequestProps) => boolean {
  const spec = raw === undefined ? '' : String(raw);
  const needles: Array<[string, (v: string) => boolean]> = [];
  for (const token of spec.trim().split(/\s+/)) {
    if (token === '') continue;
    const pos = token.indexOf(':');
    let key = pos === -1 ? token : token.slice(0, pos);
    let pattern: string | undefined = pos === -1 ? undefined : token.slice(pos + 1);
    if (key === '') continue;
    if (pattern !== undefined && /[^$\w -]/.test(key)) {
      key = token;
      pattern = undefined;
    }
    if (pattern !== undefined) needles.push([key, patternMatcher(pattern)]);
    else needles.push(['url', patternMatcher(key)]);
  }
  if (!needles.length) return () => true;
  return (props) => {
    for (const [key, test] of needles) {
      const v = props[key];
      if (v === undefined || !test(v)) return false;
    }
    return true;
  };
}

/** The properties a fetch() call is matched on: the Request's own fields, then the init's. */
function fetchProps(input: unknown, init: unknown): RequestProps {
  const props: RequestProps = Object.create(null);
  const add = (src: unknown): void => {
    if (!isObjectLike(src)) return;
    for (const key in src) {
      let v: unknown;
      try {
        v = (src as Record<string, unknown>)[key];
      } catch {
        continue;
      }
      if (typeof v === 'function') continue;
      if (typeof v !== 'string') {
        try {
          v = JSON.stringify(v);
        } catch {
          continue;
        }
      }
      if (typeof v === 'string') props[key] = v;
    }
  };
  if (typeof Request === 'function' && input instanceof Request) add(input);
  else props.url = input instanceof URL ? input.href : String(input);
  add(init);
  if (props.method === undefined) props.method = 'GET';
  return props;
}

/** Random filler text of `len` characters (uBO generateContentFn). */
function randomText(len: number): string {
  const chunks: string[] = [];
  let size = 0;
  do {
    const s = Math.random().toString(36).slice(2);
    chunks.push(s);
    size += s.length;
  } while (size < len);
  return chunks.join(' ').slice(0, len);
}

/**
 * Response bodies uBO's prevent-fetch/xhr family can fake. `war:` names a web-accessible
 * resource that uBO ships; this build has none, so it stays empty like an unknown directive.
 */
function generateContent(directive: string): string {
  switch (directive) {
    case 'true':
      return randomText(10);
    case 'emptyObj':
      return '{}';
    case 'emptyArr':
      return '[]';
    case 'emptyStr':
    case '':
      return '';
  }
  const m = /^length:(\d+)(?:-(\d+))?$/.exec(directive);
  if (m) {
    const min = parseInt(m[1], 10);
    const extent = Math.max(parseInt(m[2], 10) || 0, min) - min;
    return randomText(Math.min(min + extent * Math.random(), 500000) | 0);
  }
  return '';
}

// ---------------------------------------------------------------------------
// JSON prune + response hooks (YouTube / Facebook / etc.)
// ---------------------------------------------------------------------------

type JsonPath = string[];

/** Split a prune path list: `a.b c.[-].d` → [['a','b'], ['c','[-]','d']]. */
export function parsePrunePaths(raw: string): JsonPath[] {
  return raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p.split('.').filter(Boolean));
}

const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

/**
 * uBO objectFindOwnerFn over a pre-split path. Without `prune` it only reports whether the path
 * exists. `[-]` / `{-}` remove every array entry / object member that contains the rest of the
 * path — the whole promoted item, not just its marker, or X and Facebook render the ad as an
 * organic post. `[]`, `{}` and `*` walk every entry, and a trailing `*` empties the owner.
 */
function findOwner(root: unknown, path: JsonPath, prune: boolean, at = 0): boolean {
  if (!path.length) return false;
  let owner = root;
  for (let i = at; ; i++) {
    if (typeof owner !== 'object' || owner === null) return false;
    const rec = owner as Record<string, unknown>;
    const prop = path[i];
    if (i === path.length - 1) {
      if (!prune) return hasOwn(rec, prop);
      let modified = false;
      if (prop === '*') {
        for (const key of Object.keys(rec)) {
          delete rec[key];
          modified = true;
        }
      } else if (hasOwn(rec, prop)) {
        delete rec[prop];
        modified = true;
      }
      return modified;
    }
    let found = false;
    if (prop === '[-]' && Array.isArray(owner)) {
      for (let j = owner.length - 1; j >= 0; j--) {
        if (!findOwner(owner[j], path, false, i + 1)) continue;
        found = true;
        // Only a prune removes; a needle-path check never edits the payload.
        if (prune) owner.splice(j, 1);
      }
      return found;
    }
    if (prop === '{-}') {
      for (const key of Object.keys(rec)) {
        if (!findOwner(rec[key], path, false, i + 1)) continue;
        found = true;
        if (prune) delete rec[key];
      }
      return found;
    }
    if ((prop === '[]' && Array.isArray(owner)) || prop === '{}' || prop === '*') {
      for (const key of Object.keys(rec)) {
        if (findOwner(rec[key], path, prune, i + 1)) found = true;
      }
      return found;
    }
    if (!hasOwn(rec, prop)) return false;
    owner = rec[prop];
  }
}

/** Prune `paths` from `obj` in place (no needle paths). Returns `obj`. */
export function pruneObject(obj: unknown, paths: JsonPath[]): unknown {
  if (obj == null || typeof obj !== 'object') return obj;
  for (const p of paths) findOwner(obj, p, true);
  return obj;
}

/**
 * uBO objectPruneFn: prune only when every needle path exists, so `json-prune, enabled, ads`
 * edits the ad config and not every JSON document that happens to have an `enabled` key.
 */
function objectPrune(obj: unknown, prune: JsonPath[], needles: JsonPath[]): boolean {
  if (!prune.length || obj === null || typeof obj !== 'object') return false;
  for (const n of needles) if (!findOwner(obj, n, false)) return false;
  let hit = false;
  for (const p of prune) if (findOwner(obj, p, true)) hit = true;
  return hit;
}

const YT_AD_KEYS = new Set([
  'adPlacements',
  'playerAds',
  'adSlots',
  'adBreakHeartbeatParams',
  // Present on some player payloads; emptying is safer than leaving mid-roll hooks.
  'adParams',
  'adBreakParams',
]);

/** Defensive deep strip of known YouTube player ad keys (used by early boot + prune). */
export function stripYoutubeAdKeys(obj: unknown, depth = 0): unknown {
  if (obj == null || typeof obj !== 'object' || depth > 12) return obj;
  if (Array.isArray(obj)) {
    for (const item of obj) stripYoutubeAdKeys(item, depth + 1);
    return obj;
  }
  const rec = obj as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    if (YT_AD_KEYS.has(k)) {
      // Prefer empty arrays over delete — some player builds expect the key to exist.
      try {
        rec[k] = Array.isArray(rec[k]) ? [] : undefined;
      } catch {
        try {
          delete rec[k];
        } catch {
          /* ignore */
        }
      }
    } else {
      stripYoutubeAdKeys(rec[k], depth + 1);
    }
  }
  return obj;
}

/**
 * Match a URL against a uBO scriptlet needle.
 * - empty / `*` → always match
 * - `/pattern/flags` with valid flags → RegExp
 * - otherwise → literal substring (so `/api/graphql` matches GraphQL XHRs)
 */
export function urlMatchesNeedle(url: string, needle: string | undefined): boolean {
  if (!needle || needle === '*') return true;
  const rx = REGEX_LITERAL.exec(needle);
  if (rx) {
    try {
      return new RegExp(rx[1], rx[2]).test(url);
    } catch {
      /* fall through to literal substring */
    }
  }
  return url.includes(needle);
}

/**
 * Rewrite fetch() response bodies. `wants` sees the request before it is sent, so a response
 * nobody asked about is returned untouched instead of being cloned and buffered.
 */
function hookFetchTextTransform(
  transform: (url: string, body: string) => string,
  wants: (props: RequestProps) => boolean = () => true,
): void {
  const origFetch = window.fetch.bind(window);
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let props: RequestProps | undefined;
    try {
      props = fetchProps(input, init);
      if (!wants(props)) props = undefined;
    } catch {
      props = undefined;
    }
    const res = await origFetch(input as never, init);
    if (!props) return res;
    try {
      const url = props.url;
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      // Never buffer media/binary — reading googlevideo as text hangs playback.
      if (/video\/|audio\/|image\/|octet-stream|mpegurl|mp2t/.test(ct)) return res;
      const looksJson = /json|javascript|text\/plain/.test(ct);
      const looksPlayerApi = /youtubei|\/player\b|get_watch|playlist\?list=/.test(url);
      if (!looksJson && !looksPlayerApi) return res;
      const clone = res.clone();
      const text = await clone.text();
      const next = transform(url, text);
      if (next === text) return res;
      const out = new Response(next, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
      // A constructed Response has an empty url and type 'default'; carry the real ones over so
      // the rewrite is not observable from the response alone.
      try {
        Object.defineProperties(out, {
          ok: { value: res.ok },
          redirected: { value: res.redirected },
          type: { value: res.type },
          url: { value: res.url },
        });
      } catch {
        /* ignore */
      }
      return out;
    } catch {
      return res;
    }
  };
}

function descriptorOf(obj: object, prop: string): PropertyDescriptor | undefined {
  for (let o: object | null = obj; o !== null; o = Object.getPrototypeOf(o) as object | null) {
    const d = Object.getOwnPropertyDescriptor(o, prop);
    if (d) return d;
  }
  return undefined;
}

/**
 * Rewrite XMLHttpRequest response bodies by overriding the `responseText`/`response` getters on
 * the prototype. The rewrite is computed on the first read after DONE, so every reader sees it —
 * including handlers the page registered before send(), which a readystatechange listener added
 * inside send() always ran behind. `json` responses (an object, not text) go to `onJson`.
 */
function hookXhrTextTransform(
  transform: (url: string, body: string) => string,
  wants: (props: RequestProps) => boolean = () => true,
  onJson?: (url: string, obj: object) => void,
): void {
  const proto = XMLHttpRequest.prototype;
  let textDesc: PropertyDescriptor | undefined;
  let responseDesc: PropertyDescriptor | undefined;
  try {
    textDesc = descriptorOf(proto, 'responseText');
    responseDesc = descriptorOf(proto, 'response');
  } catch {
    return;
  }
  const nativeText = textDesc?.get;
  const nativeResponse = responseDesc?.get;
  if (!textDesc || !responseDesc || !nativeText || !nativeResponse) return;

  interface Pending {
    url: string;
    text?: string;
    jsonDone?: boolean;
  }
  const pending = new WeakMap<object, Pending>();
  const open = proto.open;
  proto.open = function (this: XMLHttpRequest, ...args: unknown[]) {
    // A reused XHR starts over: whatever the previous response was rewritten to is dropped.
    pending.delete(this);
    try {
      const url = String(args[1]);
      if (wants({ url, method: String(args[0] ?? 'GET') })) pending.set(this, { url });
    } catch {
      /* leave this request alone */
    }
    return (open as (...a: unknown[]) => void).apply(this, args);
  } as typeof proto.open;

  const rewritten = (xhr: XMLHttpRequest): string | undefined => {
    const req = pending.get(xhr);
    if (!req || xhr.readyState !== 4) return undefined;
    if (req.text !== undefined) return req.text;
    let raw: unknown;
    try {
      raw = nativeText.call(xhr);
    } catch {
      return undefined;
    }
    if (typeof raw !== 'string' || raw === '') return undefined;
    let next = raw;
    try {
      next = transform(req.url, raw);
    } catch {
      next = raw;
    }
    req.text = next;
    return next;
  };

  try {
    Object.defineProperty(proto, 'responseText', {
      ...textDesc,
      get(this: XMLHttpRequest) {
        const t = rewritten(this);
        return t !== undefined ? t : nativeText.call(this);
      },
    });
    Object.defineProperty(proto, 'response', {
      ...responseDesc,
      get(this: XMLHttpRequest) {
        const type = this.responseType;
        if (type === '' || type === 'text') {
          const t = rewritten(this);
          if (t !== undefined) return t;
        } else if (type === 'json' && onJson) {
          const obj: unknown = nativeResponse.call(this);
          const req = pending.get(this);
          if (req && !req.jsonDone && this.readyState === 4 && obj !== null && typeof obj === 'object') {
            // The browser hands out the same parsed object on every read: edit it once, in place.
            req.jsonDone = true;
            try {
              onJson(req.url, obj);
            } catch {
              /* ignore */
            }
          }
          return obj;
        }
        return nativeResponse.call(this);
      },
    });
  } catch {
    /* non-configurable in this engine */
  }
}

/**
 * A rewrite must never turn valid JSON into a payload the page cannot parse (it hangs the
 * YouTube player). Multi-document bodies — NDJSON, one document per line, as Facebook streams
 * GraphQL — never parse as a whole, so they are checked line by line instead of being reverted.
 */
function keepJsonValid(before: string, after: string): string {
  if (before === after) return before;
  const trimmed = before.trimStart();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return after;
  try {
    JSON.parse(after);
    return after;
  } catch {
    /* maybe one document per line */
  }
  return parsesAsLines(after) && parsesAsLines(before) ? after : before;
}

function parsesAsLines(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return false;
  try {
    for (const l of lines) JSON.parse(l);
    return true;
  } catch {
    return false;
  }
}

/**
 * `json-prune(prunePaths, needlePaths, stackNeedle)` — 112 shipped rules. Hooks JSON.parse and
 * Response#json, which reads fetch() bodies without ever calling JSON.parse.
 */
function jsonPrune(args: string[]): void {
  const [rawPrune = '', rawNeedles = '', stackNeedle = ''] = args;
  const prune = parsePrunePaths(rawPrune);
  if (!prune.length) return;
  const needles = parsePrunePaths(rawNeedles);
  const stackMatch = stackNeedle !== '' ? patternMatcher(stackNeedle) : undefined;
  if (stackMatch) ownScriptUrl();
  // uBO evaluates the stack two frames below its JSON.parse proxy (objectPruneFn + the trap).
  const apply = (obj: unknown, stack: unknown): void => {
    if (stackMatch && !stackMatch(normalizeStack(stack, 2))) return;
    objectPrune(obj, prune, needles);
  };

  const nativeParse = JSON.parse;
  JSON.parse = function (this: unknown, ...a: unknown[]) {
    const obj: unknown = Reflect.apply(nativeParse, this, a);
    try {
      apply(obj, stackMatch ? new ErrorCtor().stack : undefined);
    } catch {
      /* ignore */
    }
    return obj;
  } as typeof JSON.parse;

  if (typeof Response === 'function' && typeof Response.prototype.json === 'function') {
    const nativeJson = Response.prototype.json;
    Response.prototype.json = function (this: Response) {
      const stack = stackMatch ? new ErrorCtor().stack : undefined;
      return nativeJson.call(this).then((obj: unknown) => {
        try {
          apply(obj, stack);
        } catch {
          /* ignore */
        }
        return obj;
      });
    };
  }
}

/** json-prune-fetch/xhr-response(prunePaths, needlePaths, ...extra) — `propsToMatch` picks the requests. */
function jsonPruneResponseArgs(args: string[]):
  | { prune: JsonPath[]; needles: JsonPath[]; wants: (props: RequestProps) => boolean }
  | undefined {
  const [rawPrune = '', rawNeedles = '', ...rest] = args;
  const prune = parsePrunePaths(rawPrune);
  if (!prune.length) return undefined;
  const extra = getExtraArgs(rest);
  return { prune, needles: parsePrunePaths(rawNeedles), wants: propsMatcher(extra.propsToMatch) };
}

function jsonPruneFetchResponse(args: string[]): void {
  const spec = jsonPruneResponseArgs(args);
  if (!spec) return;
  hookFetchTextTransform((_url, body) => {
    try {
      const obj = JSON.parse(body);
      if (!objectPrune(obj, spec.prune, spec.needles)) return body;
      return keepJsonValid(body, JSON.stringify(obj));
    } catch {
      return body;
    }
  }, spec.wants);
}

function jsonPruneXhrResponse(args: string[]): void {
  const spec = jsonPruneResponseArgs(args);
  if (!spec) return;
  hookXhrTextTransform(
    (_url, body) => {
      try {
        const obj = JSON.parse(body);
        if (!objectPrune(obj, spec.prune, spec.needles)) return body;
        return keepJsonValid(body, JSON.stringify(obj));
      } catch {
        return body;
      }
    },
    spec.wants,
    (_url, obj) => {
      objectPrune(obj, spec.prune, spec.needles);
    },
  );
}

function compileReplacePattern(raw: string): { find: RegExp | string; isRe: boolean } | null {
  const rx = REGEX_LITERAL.exec(raw);
  if (rx) {
    try {
      return { find: new RegExp(rx[1], rx[2]), isRe: true };
    } catch {
      return null;
    }
  }
  return { find: raw, isRe: false };
}

function trustedReplace(args: string[]): { transform: (url: string, body: string) => string; wants: (p: RequestProps) => boolean } | null {
  const [patternRaw, replacementRaw, propsToMatch] = args;
  const pat = compileReplacePattern(patternRaw || '');
  if (!pat) return null;
  const replacement = replacementRaw ?? '';
  return {
    wants: propsMatcher(propsToMatch),
    transform: (_url, body) => {
      try {
        // A sticky pattern starts from lastIndex even in replace(), and it is reused per response.
        if (pat.isRe) (pat.find as RegExp).lastIndex = 0;
        const next = pat.isRe
          ? body.replace(pat.find as RegExp, replacement)
          : body.split(pat.find as string).join(replacement);
        return keepJsonValid(body, next);
      } catch {
        return body;
      }
    },
  };
}

function trustedReplaceFetchResponse(args: string[]): void {
  const spec = trustedReplace(args);
  if (spec) hookFetchTextTransform(spec.transform, spec.wants);
}

function trustedReplaceXhrResponse(args: string[]): void {
  // uBO leaves a `json` response (an object) alone here: there is no text to replace in.
  const spec = trustedReplace(args);
  if (spec) hookXhrTextTransform(spec.transform, spec.wants);
}

// ---------------------------------------------------------------------------
// Global-patching scriptlets
// ---------------------------------------------------------------------------
// Each of these neuters one page capability when a pattern matches, and otherwise calls
// through untouched. The uniform shape matters: a scriptlet that misfires does not fail
// safe — it breaks the site — so every one of them defaults to "call the original".

/**
 * `no-window-open-if(pattern, delay, decoy)` — popunder defuser, 839 shipped rules.
 *
 * Returns a decoy window object rather than null: `null` is exactly what a browser popup
 * blocker returns, and anti-adblock scripts test for it to detect blocking. The decoy has to
 * absorb the property pokes a popunder does on the handle it gets back. uBO's own decoys are an
 * iframe or `<object>` loading the popup URL; this one never loads the ad at all.
 */
function noWindowOpenIf(args: string[]): void {
  const [pattern = '', delayArg = '', decoyKind = ''] = args;
  const match = patternMatcher(pattern);
  // uBO: the delay is in seconds.
  const hasDelay = delayArg !== '';
  const closeAfter = (parseFloat(delayArg) || 0) * 1000;
  const original = window.open;

  const decoyWindow = (): unknown => {
    const noop = (): void => {};
    const decoy: Record<string, unknown> = {
      closed: false,
      opener: null,
      name: '',
      focus: noop,
      blur: noop,
      close() {
        decoy['closed'] = true;
      },
      postMessage: noop,
      addEventListener: noop,
      removeEventListener: noop,
      moveTo: noop,
      resizeTo: noop,
      document: { write: noop, writeln: noop, open: noop, close: noop, body: null },
      location: { href: 'about:blank', assign: noop, replace: noop, reload: noop },
    };
    // uBO removes its decoy after `delay` seconds when one is given, so a site that polls
    // `handle.closed` sees the lifecycle it expects.
    if (hasDelay) {
      setTimeout(() => {
        decoy['closed'] = true;
      }, closeAfter);
    }
    return decoy;
  };

  window.open = function (this: unknown, ...callArgs: unknown[]) {
    let blocked = false;
    try {
      // The haystack is every argument — URL, target and features — as uBO joins them, so
      // `_blank` rules match and a negated `_self` rule lets same-tab navigation through.
      blocked = match(callArgs.join(' '));
    } catch {
      blocked = false;
    }
    if (!blocked) return (original as (...a: unknown[]) => Window | null).apply(this, callArgs);
    if (decoyKind === 'blank' && hasDelay) {
      // The filter asked for a real, blank window that closes itself after the delay.
      const blankArgs = [...callArgs];
      blankArgs[0] = 'about:blank';
      const w = (original as (...a: unknown[]) => Window | null).apply(this, blankArgs);
      setTimeout(() => {
        try {
          w?.close();
        } catch {
          /* ignore */
        }
      }, closeAfter);
      return w;
    }
    return decoyWindow() as Window;
  } as typeof window.open;
}

/**
 * `addEventListener-defuser(type, pattern, ...extra)` — 663 shipped rules; uBO semantics.
 *
 * A literal type matches exactly (`click` is not `dblclick`), the handler pattern is a plain
 * substring or regex (a leading `!` is part of the text, as in `!adShown`), a listener object is
 * judged by its handleEvent source, and `elements, <selector>` limits the rule to matching
 * targets (`window`/`document` by name). With neither a type nor a pattern uBO only logs, so
 * this does nothing rather than dropping every listener on the page.
 */
function addEventListenerDefuser(args: string[]): void {
  const [type = '', pattern = '', ...rest] = args;
  if (type === '' && pattern === '') return;
  const extra = getExtraArgs(rest);
  const reType = patternToRegex(type, undefined, true);
  const rePattern = patternToRegex(pattern);
  if (!reType || !rePattern) return;
  const selector = extra.elements !== undefined && extra.elements !== '' ? String(extra.elements) : undefined;

  const targetMatches = (target: unknown): boolean => {
    if (selector === undefined) return true;
    if (selector === 'window') return target === window;
    if (selector === 'document') return target === document;
    try {
      const el = target as Element;
      if (el && typeof el.matches === 'function' && el.matches(selector)) return true;
      return Array.from(document.querySelectorAll(selector)).includes(el);
    } catch {
      return false;
    }
  };

  runAt(() => {
    const proto = EventTarget.prototype;
    const original = proto.addEventListener;
    proto.addEventListener = function (
      this: EventTarget,
      evType: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      try {
        let handler: string;
        if (typeof listener === 'function') {
          handler = String(fnToString.call(listener));
        } else if (listener !== null && typeof listener === 'object') {
          const h = (listener as { handleEvent?: unknown }).handleEvent;
          handler = typeof h === 'function' ? String(fnToString.call(h)) : 'undefined';
        } else {
          handler = String(listener);
        }
        if (testRe(reType, String(evType)) && testRe(rePattern, handler) && targetMatches(this)) return;
      } catch {
        /* fall through and register normally */
      }
      return original.call(this, evType, listener, options);
    };
  }, extra.runAt);
}

/**
 * `no-fetch-if(propsToMatch, responseBody, responseType)` — 376 shipped rules.
 *
 * A matching request resolves with a fake 200 rather than rejecting: a rejected fetch is an
 * observable signal, and several anti-adblock scripts count failures. With no properties uBO
 * only logs, so an empty rule blocks nothing.
 */
function noFetchIf(args: string[]): void {
  const [propsToMatch = '', responseBody = '', responseType = ''] = args;
  if (propsToMatch.trim() === '') return;
  const matches = propsMatcher(propsToMatch);

  // uBO accepts only these values for the faked Response's own fields.
  const valid: Record<string, unknown[]> = {
    ok: [false, true],
    statusText: ['', 'Not Found'],
    type: ['basic', 'cors', 'default', 'error', 'opaque'],
  };
  const overrides: Record<string, unknown> = { statusText: 'OK' };
  if (/^\{.*\}$/.test(responseType)) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(responseType) as Record<string, unknown>)) {
        if (valid[k]?.includes(v)) overrides[k] = v;
      }
    } catch {
      /* ignore a malformed override */
    }
  } else if (responseType !== '' && valid.type.includes(responseType)) {
    overrides.type = responseType;
  }

  const original = window.fetch;
  window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    let props: RequestProps | undefined;
    try {
      props = fetchProps(input, init);
      if (!matches(props)) props = undefined;
    } catch {
      props = undefined;
    }
    if (props) {
      try {
        const text = generateContent(responseBody);
        const res = new Response(text, { headers: { 'Content-Length': String(text.length) } });
        const defs: PropertyDescriptorMap = { url: { value: props.url } };
        for (const [k, v] of Object.entries(overrides)) defs[k] = { value: v };
        Object.defineProperties(res, defs);
        return Promise.resolve(res);
      } catch {
        /* fall through to the real request */
      }
    }
    return (original as (...a: unknown[]) => Promise<Response>).call(this, input, init);
  } as typeof window.fetch;
}

/**
 * `nano-setTimeout-booster` / `nano-setInterval-booster` — 308 shipped rules combined; uBO's
 * adjust-setTimeout/adjust-setInterval. Scales a matching timer's delay so artificial "please
 * wait N seconds" gates elapse at once.
 *
 * An omitted delay means 1000 ms, as in uBO; only `*` means any delay. Treating an omitted delay
 * as "any" sped up every timer on 181 sites, animations and heartbeats included.
 */
function nanoTimerBooster(kind: 'setTimeout' | 'setInterval', args: string[]): void {
  const [needle = '', delayArg = '', boostArg = ''] = args;
  const match = patternMatcher(needle);
  let wantDelay = delayArg !== '*' ? parseInt(delayArg, 10) : -1;
  if (!Number.isFinite(wantDelay)) wantDelay = 1000;
  const parsedBoost = parseFloat(boostArg);
  // uBO clamps an out-of-range boost into [0.001, 50] rather than trusting the filter author.
  const boost = Number.isFinite(parsedBoost) ? Math.min(Math.max(parsedBoost, 0.001), 50) : 0.05;

  const g = window as unknown as Record<string, (...a: unknown[]) => number>;
  const original = g[kind];
  g[kind] = function (this: unknown, ...a: unknown[]) {
    const [cb, delay, ...rest] = a as [unknown, number | undefined, ...unknown[]];
    let nextDelay = delay;
    try {
      const src = typeof cb === 'function' ? String(fnToString.call(cb)) : String(cb);
      const delayOk = wantDelay === -1 || delay === wantDelay;
      if (delayOk && match(src)) nextDelay = Math.max(0, Math.floor((Number(delay) || 0) * boost));
    } catch {
      /* leave the delay alone */
    }
    return original.call(this, cb, nextDelay as number, ...rest);
  };
}

/**
 * `prevent-eval-if(pattern)` — 145 rules — and `noeval` — 29 rules.
 *
 * This replaces the page's eval to *stop* code running; nothing here evaluates anything. An
 * empty pattern means "neuter every eval", which is what plain `noeval` compiles to.
 */
function preventEvalIf(args: string[]): void {
  const match = patternMatcher(args[0]);
  const g = window as unknown as { eval: (code: string) => unknown };
  const original = g.eval;
  g.eval = function (this: unknown, code: string) {
    try {
      if (match(String(code))) return undefined;
    } catch {
      /* fall through */
    }
    return original.call(this, code);
  } as typeof g.eval;
}

/** `nowebrtc` — 59 rules. Stub the peer-connection constructor so peer ads cannot dial out. */
function noWebrtc(): void {
  const g = window as unknown as Record<string, unknown>;
  const noop = (): void => {};
  const Stub = function () {
    return {
      close: noop,
      createDataChannel: () => ({ close: noop, send: noop }),
      createOffer: () => Promise.reject(new Error('blocked')),
      createAnswer: () => Promise.reject(new Error('blocked')),
      setLocalDescription: () => Promise.resolve(),
      setRemoteDescription: () => Promise.resolve(),
      addIceCandidate: () => Promise.resolve(),
      addEventListener: noop,
      removeEventListener: noop,
      addStream: noop,
      getStats: () => Promise.resolve(new Map()),
    };
  } as unknown as new () => unknown;

  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection']) {
    if (!(name in g)) continue;
    try {
      Object.defineProperty(g, name, { value: Stub, writable: true, configurable: true });
    } catch {
      /* non-configurable */
    }
  }
}

/**
 * `replace-node-text(nodeName, pattern, replacement, ...extra)` and `remove-node-text(nodeName,
 * includes, ...extra)` — 980 shipped rules, 99% of them targeting inline `<script>`; uBO's
 * replaceNodeTextFn.
 *
 * `nodeName` matches exactly and case-insensitively (`script` is not `noscript`). Extra
 * arguments: `condition`/`includes` and `excludes` gate which nodes are edited, `sedCount` stops
 * after N edits, and the observer stops once the document is interactive unless `stay` (or
 * `quitAfter` ms) says otherwise — a JSON data script inserted after load is not the target.
 * A `/re/` pattern uses exactly its own flags: without `g` only the first match is replaced.
 *
 * These defuse anti-adblock checks by editing the script's text before it runs. Whether that is
 * possible at all comes down to observer timing, which I measured in Chrome rather than assumed:
 *
 *   - Parser-inserted inline scripts (the ones written into the served HTML): the observer
 *     callback fires BEFORE the script executes, so blanking the text prevents it running.
 *     Verified with a control script that was observed and deliberately left alone — it ran,
 *     while the blanked one did not.
 *   - Dynamically injected scripts (`el.textContent = …; body.appendChild(el)`): the script
 *     executes synchronously inside appendChild, and the observer only sees it afterwards.
 *     These CANNOT be stopped this way.
 *
 * That limitation is acceptable because anti-adblock detection is overwhelmingly inline in the
 * HTML — that is the whole point of it, to run before anything can interfere.
 */
function replaceNodeText(args: string[], removeMode: boolean): void {
  let nodeName: string;
  let pattern: string;
  let replacement: string;
  let extra: ExtraArgs;
  if (removeMode) {
    // uBO: remove-node-text(n, includes, ...) is replace-node-text(n, '', '', 'includes', includes, ...).
    const [name = '', includes = '', ...rest] = args;
    nodeName = name;
    pattern = '';
    replacement = '';
    extra = getExtraArgs(['includes', includes, ...rest]);
  } else {
    const [name = '', pat = '', repl = '', ...rest] = args;
    nodeName = name;
    pattern = pat;
    replacement = repl;
    extra = getExtraArgs(rest);
  }
  const includes = String(extra.includes || extra.condition || '');
  // Stricter than uBO: a rule that names no text at all would rewrite every matching node on
  // the page, so it is a no-op instead.
  if (!nodeName || (pattern === '' && includes === '')) return;

  const reNodeName = patternToRegex(nodeName, 'i', true);
  const rePattern = patternToRegex(pattern, 'gms');
  const reIncludes = includes !== '' ? patternToRegex(includes, 'ms') : undefined;
  const reExcludes = extra.excludes ? patternToRegex(String(extra.excludes), 'ms') : undefined;
  if (!reNodeName || !rePattern || reIncludes === null || reExcludes === null) return;
  let sedCount = typeof extra.sedCount === 'number' ? extra.sedCount : 0;

  /** Edit one node. False once `sedCount` edits are spent. */
  const handleNode = (node: Node): boolean => {
    const before = node.textContent;
    if (typeof before !== 'string') return true;
    if (reIncludes && !testRe(reIncludes, before)) return true;
    if (reExcludes && testRe(reExcludes, before)) return true;
    if (!testRe(rePattern, before)) return true;
    rePattern.lastIndex = 0;
    const after = pattern !== '' ? before.replace(rePattern, replacement) : replacement;
    if (after !== before) {
      try {
        node.textContent = after;
      } catch {
        /* read-only node */
      }
    }
    return sedCount === 0 || --sedCount !== 0;
  };

  let observer: MutationObserver | undefined;
  const handleMutations = (records: MutationRecord[]): void => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (!testRe(reNodeName, String(node.nodeName))) continue;
        if (handleNode(node)) continue;
        stop(false);
        return;
      }
    }
  };
  const stop = (drain = true): void => {
    const obs = observer;
    if (!obs) return;
    observer = undefined;
    if (drain) {
      try {
        handleMutations(obs.takeRecords());
      } catch {
        /* ignore */
      }
    }
    obs.disconnect();
  };

  try {
    observer = new MutationObserver(handleMutations);
    observer.observe(document, { childList: true, subtree: true });
  } catch {
    observer = undefined;
  }

  // Anything already parsed when this scriptlet runs — text nodes too, for `#text` rules.
  const root = document.documentElement;
  if (root) {
    const current = document.currentScript;
    const walker = document.createTreeWalker(root, 0x1 | 0x4 /* SHOW_ELEMENT | SHOW_TEXT */);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (!testRe(reNodeName, String(node.nodeName))) continue;
      if (node === current) continue;
      if (handleNode(node)) continue;
      stop();
      return;
    }
  }

  if (extra.stay) return;
  runAt(() => {
    const quitAfter = typeof extra.quitAfter === 'number' ? extra.quitAfter : 0;
    if (quitAfter !== 0) setTimeout(() => stop(), quitAfter);
    else stop();
  }, 'interactive');
}

/**
 * `no-xhr-if(propsToMatch, directive)` — 205 shipped rules.
 *
 * Unlike prevent-fetch there is nothing to return: the page holds the XHR object and waits for
 * its events. So the request is simply never sent, and the object is driven through the state
 * transitions a real 200 would produce, with a body shaped by `responseType` and `directive`.
 * Skipping the events instead would hang any site that awaits `onload`, which is worse than
 * letting the request through.
 */
function noXhrIf(args: string[]): void {
  const [propsToMatch = '', directive = ''] = args;
  if (propsToMatch.trim() === '' && directive === '') return;
  const matches = propsMatcher(propsToMatch);
  const proto = XMLHttpRequest.prototype;
  const open = proto.open;
  const send = proto.send;
  const FAKED = ['readyState', 'responseURL', 'status', 'statusText', 'response', 'responseText', 'responseXML'];

  interface Blocked {
    url: string;
    async: boolean;
  }
  const blocked = new WeakMap<object, Blocked>();

  proto.open = function (this: XMLHttpRequest, ...openArgs: unknown[]) {
    if (blocked.has(this)) {
      // Reused after a blocked request: drop the faked fields so the real ones show again.
      blocked.delete(this);
      for (const p of FAKED) {
        try {
          delete (this as unknown as Record<string, unknown>)[p];
        } catch {
          /* ignore */
        }
      }
    }
    try {
      const url = String(openArgs[1]);
      if (matches({ url, method: String(openArgs[0] ?? 'GET') })) {
        blocked.set(this, { url, async: openArgs.length < 3 || !!openArgs[2] });
      }
    } catch {
      /* leave this request alone */
    }
    return (open as (...a: unknown[]) => void).apply(this, openArgs);
  } as typeof proto.open;

  proto.send = function (this: XMLHttpRequest, ...sendArgs: unknown[]) {
    const req = blocked.get(this);
    if (!req) return (send as (...a: unknown[]) => void).apply(this, sendArgs);

    const define = (prop: string, value: unknown): void => {
      try {
        Object.defineProperty(this, prop, { value, configurable: true });
      } catch {
        /* ignore */
      }
    };
    let text = '';
    let response: unknown = '';
    let xml: unknown = null;
    switch (this.responseType) {
      case 'arraybuffer':
        response = new ArrayBuffer(0);
        break;
      case 'blob':
        response = new Blob([]);
        break;
      case 'document':
        try {
          response = xml = new DOMParser().parseFromString('', 'text/html');
        } catch {
          response = null;
        }
        break;
      case 'json':
        response = {};
        text = '{}';
        break;
      default:
        text = generateContent(directive);
        response = text;
    }
    const dispatch = (type: string): void => {
      try {
        this.dispatchEvent(new Event(type));
      } catch {
        /* ignore */
      }
    };
    const finish = (): void => {
      define('readyState', 4);
      dispatch('readystatechange');
      dispatch('load');
      dispatch('loadend');
    };
    define('responseURL', req.url);
    if (!req.async) {
      // A synchronous request is DONE when send() returns, with its events already delivered.
      define('status', 200);
      define('statusText', 'OK');
      define('response', response);
      define('responseText', text);
      define('responseXML', xml);
      finish();
      return;
    }
    // Asynchronous, like a real request: a site that assigns onload after send() must still
    // see the event.
    setTimeout(() => {
      define('status', 200);
      define('statusText', 'OK');
      define('readyState', 2);
      dispatch('readystatechange');
      define('response', response);
      define('responseText', text);
      define('responseXML', xml);
      define('readyState', 3);
      dispatch('readystatechange');
      finish();
    }, 0);
  } as typeof proto.send;
}

/**
 * `abort-on-stack-trace(chain, needle)` — 194 shipped rules.
 *
 * Narrower than abort-on-property-read: the property keeps working for the page at large and
 * only throws, on read or write, when the call comes from a matching stack. That is what makes
 * it usable on hot built-ins — the shipped rules target things like `String.prototype.charCodeAt`
 * and `document.createElement`, which a blanket abort would take the whole site down with.
 */
function abortOnStackTrace(args: string[]): void {
  const [chain, needle] = args;
  if (!chain || !needle) return;
  const match = patternMatcher(needle);
  ownScriptUrl();

  onChainOwner(chain, (owner, prop) => {
    // The Error is created right here, so the trap's own frames are this check and the accessor
    // — the same two uBO's matchesStackTraceFn and getter add. normalizeStack drops ours; uBO's
    // stackDepth still counts its getter, hence the 1.
    trapAccess(owner, prop, () => {
      if (match(normalizeStack(new ErrorCtor().stack, 1))) {
        throw new ReferenceError('StampStack: aborted by stack trace');
      }
    });
  });
}

/**
 * `set-cookie(name, value)` — 48 shipped rules, mostly pre-answering consent and anti-adblock
 * probes. Values are restricted to a known-safe vocabulary exactly as uBO does: a filter list
 * must not be able to write arbitrary cookie content on the user's origin.
 */
const SAFE_COOKIE_VALUES = new Set([
  'true', 'false', 'yes', 'no', 'y', 'n', 'on', 'off',
  'accept', 'accepted', 'reject', 'rejected', 'allow', 'deny',
  'ok', 'dismiss', 'dismissed', 'closed', 'consent', 'null', '0', '1', '',
]);

function setCookie(args: string[]): void {
  const name = (args[0] ?? '').trim();
  const value = (args[1] ?? '').trim();
  if (!name || !/^[\w!#$%&'*.^`|~+-]+$/.test(name)) return;
  if (!SAFE_COOKIE_VALUES.has(value.toLowerCase())) return;
  try {
    document.cookie = `${name}=${value}; path=/; SameSite=Lax`;
  } catch {
    /* cookies blocked for this origin */
  }
}

/** `set-local-storage-item(key, value)` — 18 rules. Same safe-value restriction as set-cookie. */
function setLocalStorageItem(args: string[]): void {
  const key = (args[0] ?? '').trim();
  const value = (args[1] ?? '').trim();
  if (!key) return;
  if (!SAFE_COOKIE_VALUES.has(value.toLowerCase())) return;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage disabled or full */
  }
}

/**
 * `popads-dummy` — 19 rules. Pin the globals the PopAds loader probes for, as uBO does: empty
 * objects that are neither writable nor configurable, so the loader cannot swap its own in.
 */
function popadsDummy(): void {
  const g = window as unknown as Record<string, unknown>;
  for (const name of ['PopAds', 'popns']) {
    try {
      delete g[name];
    } catch {
      /* ignore */
    }
    try {
      Object.defineProperty(g, name, { value: {} });
    } catch {
      /* non-configurable */
    }
  }
}

const SCRIPTLETS: Record<string, Scriptlet> = {
  'set-constant': (a) => setConstant(a[0], a[1] ?? ''),
  'abort-on-property-read': (a) => abortOnPropertyRead(a[0]),
  'abort-on-property-write': (a) => abortOnPropertyWrite(a[0]),
  'abort-current-inline-script': (a) => abortCurrentInlineScript(a),
  'prevent-setTimeout': (a) => preventTimer('setTimeout', a),
  'prevent-setInterval': (a) => preventTimer('setInterval', a),
  'remove-attr': (a) => removeAttr(a),
  'remove-class': (a) => removeClass(a),
  'json-prune': (a) => jsonPrune(a),
  'json-prune-fetch-response': (a) => jsonPruneFetchResponse(a),
  'json-prune-xhr-response': (a) => jsonPruneXhrResponse(a),
  'trusted-replace-fetch-response': (a) => trustedReplaceFetchResponse(a),
  'trusted-replace-xhr-response': (a) => trustedReplaceXhrResponse(a),
  'no-window-open-if': (a) => noWindowOpenIf(a),
  'addEventListener-defuser': (a) => addEventListenerDefuser(a),
  'prevent-fetch': (a) => noFetchIf(a),
  'nano-setTimeout-booster': (a) => nanoTimerBooster('setTimeout', a),
  'nano-setInterval-booster': (a) => nanoTimerBooster('setInterval', a),
  'prevent-eval-if': (a) => preventEvalIf(a),
  nowebrtc: () => noWebrtc(),
  'remove-node-text': (a) => replaceNodeText(a, true),
  'replace-node-text': (a) => replaceNodeText(a, false),
  'prevent-xhr': (a) => noXhrIf(a),
  'abort-on-stack-trace': (a) => abortOnStackTrace(a),
  'set-cookie': (a) => setCookie(a),
  'set-local-storage-item': (a) => setLocalStorageItem(a),
  'popads-dummy': () => popadsDummy(),
};

/** This frame's host as the runtime matches rules against it (see frame-scope.ts). */
function currentFrameHost(): string {
  if (typeof location === 'undefined') return '';
  let origin: string | null = null;
  try {
    origin = self.origin;
  } catch {
    /* no origin: treat as opaque */
  }
  return frameHostOf(location.hostname ?? '', origin);
}

/**
 * Resolve an alias and run the scriptlet. Unknown names are ignored. `host` is the host the
 * rule was matched against; an about:blank or srcdoc frame has no hostname of its own and
 * carries its creator's, so the YouTube guard below must see that one too.
 */
export function runScriptlet(name: string, args: string[], host: string = currentFrameHost()): void {
  const canonical = ALIASES[name] || ALIASES[name.replace(/\.js$/, '')];
  const onYoutube = /(^|\.)youtube\.com$|(^|\.)youtube-nocookie\.com$|(^|\.)youtu\.be$|(^|\.)youtubekids\.com$/i.test(
    host,
  );
  if (onYoutube) {
    // YouTube watch playback is fragile under stacked response rewrites. Early
    // hooks (installYoutubeEarlyHooks) do a conservative ad-key strip; skip the
    // heavier list-driven rewrites that have hung the player at 0:00.
    if (
      canonical === 'set-constant' ||
      canonical === 'trusted-replace-fetch-response' ||
      canonical === 'trusted-replace-xhr-response' ||
      canonical === 'json-prune-fetch-response' ||
      canonical === 'json-prune-xhr-response' ||
      canonical === 'json-prune'
    ) {
      return;
    }
  }
  const fn = canonical ? SCRIPTLETS[canonical] : undefined;
  if (!fn) return;
  try {
    fn(args);
  } catch {
    /* a scriptlet must never take down the injector */
  }
}

export const SUPPORTED_SCRIPTLETS = Object.keys(SCRIPTLETS);

const YT_PLAYER_API_RE =
  /youtubei\/v1\/(?:player|get_watch|next|player_streaming|reel\/reel_item_watch)|\/player\?|get_watch\?|playlist\?list=/i;

/**
 * Passive in-place scrub of the inline player blob. Never redefine getters on
 * ytInitialPlayerResponse — that hung the Chromium watch player in audits.
 */
export function scrubInlineYoutubePlayerResponse(): void {
  const g = globalThis as typeof globalThis & {
    ytInitialPlayerResponse?: unknown;
    ytplayer?: { config?: { args?: { player_response?: string; raw_player_response?: unknown } } };
  };
  try {
    if (g.ytInitialPlayerResponse && typeof g.ytInitialPlayerResponse === 'object') {
      stripYoutubeAdKeys(g.ytInitialPlayerResponse);
    }
  } catch {
    /* ignore */
  }
  try {
    const raw = g.ytplayer?.config?.args?.raw_player_response;
    if (raw && typeof raw === 'object') stripYoutubeAdKeys(raw);
  } catch {
    /* ignore */
  }
  try {
    const encoded = g.ytplayer?.config?.args?.player_response;
    if (typeof encoded === 'string' && encoded.includes('adPlacements')) {
      const obj = JSON.parse(encoded);
      stripYoutubeAdKeys(obj);
      g.ytplayer!.config!.args!.player_response = JSON.stringify(obj);
    }
  } catch {
    /* ignore — leave original string if rewrite fails */
  }
}

function installInlinePlayerScrub(): void {
  scrubInlineYoutubePlayerResponse();
  try {
    queueMicrotask(scrubInlineYoutubePlayerResponse);
  } catch {
    /* ignore */
  }
  const started = Date.now();
  const iv = setInterval(() => {
    scrubInlineYoutubePlayerResponse();
    // Cover the early bootstrap window without staying forever.
    if (Date.now() - started > 4000) clearInterval(iv);
  }, 25);
}

const YT_SKIP_SEL =
  [
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button-container button',
    '.ytp-ad-overlay-close-button',
    'button.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button-slot button',
    // Newer player chrome (attribute / id variants).
    'button[id*="skip-button"]',
    '.ytp-skip-ad button',
  ].join(', ');

/**
 * Click Skip when YouTube shows it; if the player is in `.ad-showing` with a
 * finite ad duration, seek to the end. Does not redefine player getters.
 */
export function tickYoutubeAdSkipAssist(): void {
  try {
    const skips = document.querySelectorAll(YT_SKIP_SEL);
    for (const node of skips) {
      const skip = node as HTMLElement;
      if (skip.getAttribute('disabled') != null) continue;
      if (typeof (skip as HTMLButtonElement).disabled === 'boolean' && (skip as HTMLButtonElement).disabled) {
        continue;
      }
      if (typeof skip.click === 'function') {
        skip.click();
        return;
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const player = document.querySelector('.html5-video-player');
    if (!player?.classList.contains('ad-showing')) return;
    const video = document.querySelector('video.html5-main-video, .html5-video-player video') as
      | HTMLVideoElement
      | null;
    if (!video) return;
    const dur = video.duration;
    if (Number.isFinite(dur) && dur > 0 && video.currentTime < dur - 0.25) {
      video.currentTime = dur;
    }
  } catch {
    /* ignore */
  }
}

/**
 * Skip/seek assist for the whole life of the document. YouTube is a single-page app: one
 * document serves every video watched in the tab, so the old 10-minute cutoff silently ended
 * skipping for every later pre-roll and mid-roll. The observer watches only the player — where
 * `ad-showing` and the Skip button appear — instead of every class change on the page, and
 * follows it when YouTube swaps the player element.
 */
export function installYoutubeAdSkipAssist(): void {
  const started = Date.now();
  let observed: Element | null = null;
  let observer: MutationObserver | undefined;
  const watchPlayer = (): void => {
    let player: Element | null = null;
    try {
      player = document.getElementById('movie_player') ?? document.querySelector('.html5-video-player');
    } catch {
      return;
    }
    if (!player || player === observed) return;
    observed = player;
    try {
      observer?.disconnect();
      observer = new MutationObserver(() => tickYoutubeAdSkipAssist());
      observer.observe(player, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['class'],
      });
    } catch {
      observer = undefined;
    }
  };
  const tick = (): void => {
    tickYoutubeAdSkipAssist();
    watchPlayer();
    // Fast while the watch page boots, then a light poll as the observer's backstop.
    setTimeout(tick, Date.now() - started < 30_000 ? 200 : 1000);
  };
  tickYoutubeAdSkipAssist();
  watchPlayer();
  setTimeout(tick, 50);
}

/**
 * Install document_start YouTube hooks before the player bootstrap runs.
 * Safe to call multiple times (idempotent).
 */
export function installYoutubeEarlyHooks(): void {
  const g = globalThis as unknown as { __quellYtEarly?: boolean };
  if (g.__quellYtEarly) return;
  g.__quellYtEarly = true;

  // Inline blob scrub (passive) + fetch/XHR scrub + skip/seek assist.
  // Avoid Object.defineProperty traps on ytInitialPlayerResponse.

  installInlinePlayerScrub();
  installYoutubeAdSkipAssist();

  const transform = (url: string, body: string): string => {
    if (!YT_PLAYER_API_RE.test(url)) {
      return body;
    }
    try {
      const obj = JSON.parse(body);
      stripYoutubeAdKeys(obj);
      return keepJsonValid(body, JSON.stringify(obj));
    } catch {
      return keepJsonValid(
        body,
        body
          .replace(/"adPlacements"/g, '"no_ads"')
          .replace(/"adSlots"/g, '"no_ads"')
          .replace(/"playerAds"/g, '"no_ads"')
          .replace(/"adBreakHeartbeatParams"/g, '"no_ads"')
          .replace(/"adParams"/g, '"no_ads"')
          .replace(/"adBreakParams"/g, '"no_ads"'),
      );
    }
  };
  const isPlayerApi = (props: RequestProps): boolean => YT_PLAYER_API_RE.test(props.url);

  hookFetchTextTransform(transform, isPlayerApi);
  hookXhrTextTransform(transform, isPlayerApi, (_url, obj) => {
    stripYoutubeAdKeys(obj);
  });
}

/** Every accepted scriptlet name (canonical + uBO short forms). Used by the compile-time
 *  drift guard in test/scriptlets.test.mjs so the packaged filter never silently diverges. */
export function scriptletAliasNames(): string[] {
  return Object.keys(ALIASES);
}

/** True when this name (alias or canonical) maps to a handler that actually runs. */
export function scriptletIsImplemented(name: string): boolean {
  const canonical = ALIASES[String(name ?? '').trim()];
  return !!canonical && !!SCRIPTLETS[canonical];
}
