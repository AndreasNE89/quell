// Bundled scriptlet library. Scriptlets run in the page's MAIN world to neutralize
// anti-adblock checks and ad bootstrap scripts. Under MV3 we can't inject arbitrary
// remote code, so the implementations must ship with the extension — this is that set.
//
// Names + aliases follow uBlock Origin's resources so uBO filter lists (##+js(...))
// work unchanged. Each implementation is defensive: a throwing scriptlet must never
// break the page beyond what the filter author intended.

type Scriptlet = (args: string[]) => void;

const ALIASES: Record<string, string> = {
  set: 'set-constant',
  'set-constant': 'set-constant',
  aopr: 'abort-on-property-read',
  'abort-on-property-read': 'abort-on-property-read',
  aopw: 'abort-on-property-write',
  'abort-on-property-write': 'abort-on-property-write',
  // uBO short names: `acs` is the common form in filter lists; `acis` is rarer.
  acs: 'abort-current-inline-script',
  acis: 'abort-current-inline-script',
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
};

/** Strip uBO-style quoting: `'\"adPlacements\"'` → `"adPlacements"`. */
export function unquoteArg(raw: string): string {
  let s = raw.trim();
  if (
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith('"') && s.endsWith('"'))
  ) {
    s = s.slice(1, -1);
  }
  // After outer quotes, unescape common \" sequences left from filter text.
  s = s.replace(/\\"/g, '"').replace(/\\'/g, "'");
  return s;
}

function parseConstant(raw: string): unknown {
  const v = unquoteArg(raw);
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
    Object.defineProperty(owner, prop, {
      get: () => value,
      set: () => {},
      configurable: true,
      enumerable: true,
    });
  } catch {
    try {
      (owner as Record<string, unknown>)[prop] = value as never;
    } catch {
      /* ignore */
    }
  }
}

/**
 * Assign a constant along a dotted path on `root` without inventing a brand-new
 * root object on `window` (that breaks sites like YouTube that assign the whole
 * blob later). For nested chains we trap the root property setter instead.
 */
function setConstant(chain: string, rawValue: string): void {
  const value = parseConstant(rawValue);
  const parts = chain.split('.').filter(Boolean);
  if (!parts.length) return;

  if (parts.length === 1) {
    defineLeaf(window, parts[0], value);
    return;
  }

  const [root, ...rest] = parts;
  const apply = (obj: unknown): unknown => {
    if (obj == null || (typeof obj !== 'object' && typeof obj !== 'function')) return obj;
    let cur: Record<string, unknown> = obj as Record<string, unknown>;
    for (let i = 0; i < rest.length - 1; i++) {
      const p = rest[i];
      const next = cur[p];
      if (next == null || (typeof next !== 'object' && typeof next !== 'function')) {
        // Don't fabricate deep structure on a live page object — only prune leaves
        // that already exist (or are one level away on a plain object).
        return obj;
      }
      cur = next as Record<string, unknown>;
    }
    defineLeaf(cur, rest[rest.length - 1], value);
    return obj;
  };

  const existing = (window as unknown as Record<string, unknown>)[root];
  if (existing != null) apply(existing);

  let held = existing;
  try {
    Object.defineProperty(window, root, {
      configurable: true,
      enumerable: true,
      get() {
        return held;
      },
      set(v: unknown) {
        held = apply(v);
      },
    });
  } catch {
    /* non-configurable */
  }
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

function textMatcher(pattern: string | undefined): (t: string) => boolean {
  if (!pattern || pattern === '*') return () => true;
  const rx = /^\/(.*)\/([a-z]*)$/.exec(pattern);
  if (rx) {
    try {
      const re = new RegExp(rx[1], rx[2]);
      return (t) => re.test(t);
    } catch {
      return () => false;
    }
  }
  return (t) => t.includes(pattern);
}

/** Install abort-on-read getter; setter keeps a mutable held value (uBO-style). */
export function abortCurrentInlineScript(args: string[]): void {
  const [chain, search] = args;
  const match = textMatcher(search);
  const parts = chain.split('.');
  const prop = parts.pop();
  if (!prop) return;
  let owner: any = window;
  for (const p of parts) {
    owner = owner?.[p];
    if (owner == null) return;
  }
  const desc = Object.getOwnPropertyDescriptor(owner, prop);
  // Mirror uBO: keep a mutable held value. A no-op setter breaks pages that assign
  // the property; throw only when a matching inline script is the currentScript.
  let held: unknown = desc?.get ? desc.get.call(owner) : desc?.value;
  const get = (): unknown => {
    const el = document.currentScript;
    if (el instanceof HTMLScriptElement && !el.src && match(el.textContent ?? '')) {
      throw new ReferenceError('StampStack: aborted inline script');
    }
    return held;
  };
  const set = (v: unknown): void => {
    held = v;
  };
  try {
    Object.defineProperty(owner, prop, { get, set, configurable: true });
  } catch {
    /* ignore */
  }
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
  try {
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
    });
  } catch {
    /* documentElement not ready */
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

function pruneAt(obj: unknown, path: JsonPath): void {
  if (obj == null || typeof obj !== 'object') return;
  if (!path.length) return;

  const [head, ...tail] = path;
  if (head === '[-]' || head === '[]') {
    if (!Array.isArray(obj)) return;
    if (!tail.length) {
      obj.length = 0;
      return;
    }
    for (const item of obj) pruneAt(item, tail);
    // Drop array entries that look like ad nodes after pruning children.
    for (let i = obj.length - 1; i >= 0; i--) {
      const it = obj[i];
      if (it && typeof it === 'object' && isMostlyEmptyAdStub(it)) obj.splice(i, 1);
    }
    return;
  }

  const rec = obj as Record<string, unknown>;
  if (!tail.length) {
    try {
      delete rec[head];
    } catch {
      try {
        rec[head] = undefined;
      } catch {
        /* ignore */
      }
    }
    return;
  }
  pruneAt(rec[head], tail);
}

function isMostlyEmptyAdStub(obj: object): boolean {
  // Keep this conservative — only used after [-] walks for adClientParams.isAd style paths.
  const o = obj as Record<string, unknown>;
  return Object.keys(o).length === 0;
}

export function pruneObject(obj: unknown, paths: JsonPath[]): unknown {
  if (obj == null || typeof obj !== 'object') return obj;
  for (const p of paths) pruneAt(obj, p);
  return obj;
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

function hookJsonParsePrune(paths: JsonPath[]): void {
  const orig = JSON.parse.bind(JSON);
  JSON.parse = function quellJsonParse(text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) {
    const parsed = orig(text, reviver as never);
    try {
      pruneObject(parsed, paths);
    } catch {
      /* ignore */
    }
    return parsed;
  } as typeof JSON.parse;
}

/** JS RegExp flag charset (ES2024). Used so path needles like `/api/graphql`
 *  are not misread as `/api/` + invalid flags `graphql` (which threw and never matched). */
const REGEXP_FLAG_CHARS = /^[dgimsuvy]*$/;

/**
 * Match a URL against a uBO scriptlet needle.
 * - empty / `*` → always match
 * - `/pattern/flags` with valid flags → RegExp
 * - otherwise → literal substring (so `/api/graphql` matches GraphQL XHRs)
 */
export function urlMatchesNeedle(url: string, needle: string | undefined): boolean {
  if (!needle || needle === '*') return true;
  const n = unquoteArg(needle);
  const rx = /^\/(.*)\/([a-z]*)$/.exec(n);
  if (rx && REGEXP_FLAG_CHARS.test(rx[2])) {
    try {
      return new RegExp(rx[1], rx[2]).test(url);
    } catch {
      /* fall through to literal substring */
    }
  }
  return url.includes(n);
}

function hookFetchTextTransform(transform: (url: string, body: string) => string): void {
  const origFetch = window.fetch.bind(window);
  window.fetch = async function quellFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const res = await origFetch(input as never, init);
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
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
      return new Response(next, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    } catch {
      return res;
    }
  };
}

function hookXhrTextTransform(transform: (url: string, body: string) => string): void {
  const proto = XMLHttpRequest.prototype;
  const open = proto.open;
  const send = proto.send;
  proto.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ) {
    (this as unknown as { __quellUrl?: string }).__quellUrl = String(url);
    return open.call(this, method, url as string, async ?? true, username, password);
  };
  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    // An XHR object can be reused across open()/send() cycles. Any override left by the
    // previous response shadows the browser's own accessor, so without this the next cycle
    // would read (and re-transform) last cycle's rewritten body instead of the fresh one.
    delete (this as unknown as { responseText?: unknown }).responseText;
    delete (this as unknown as { response?: unknown }).response;
    // NOT `{ once: true }`: an async XHR fires readystatechange at 2 (HEADERS_RECEIVED) and 3
    // (LOADING) before 4 (DONE), so `once` would discard the listener on the first non-DONE
    // event and the transform would never run. Unhook by hand once DONE is reached instead.
    const onDone = (): void => {
      if (this.readyState !== 4) return;
      this.removeEventListener('readystatechange', onDone);
      try {
        const url = (this as unknown as { __quellUrl?: string }).__quellUrl || '';
        const raw = this.responseText;
        if (typeof raw !== 'string' || !raw) return;
        const next = transform(url, raw);
        if (next === raw) return;
        // configurable: an XHR object can be reused across open()/send() cycles; without this
        // the second response would stay pinned to the first transformed body and the redefine
        // would throw into the silent catch below.
        Object.defineProperty(this, 'responseText', { get: () => next, configurable: true });
        try {
          Object.defineProperty(this, 'response', { get: () => next, configurable: true });
        } catch {
          /* ignore */
        }
      } catch {
        /* ignore */
      }
    };
    this.addEventListener('readystatechange', onDone);
    return send.call(this, body as never);
  };
}

function jsonPrune(args: string[]): void {
  const paths = parsePrunePaths(args[0] || '');
  if (!paths.length) return;
  hookJsonParsePrune(paths);
}

function jsonPruneFetchResponse(args: string[]): void {
  const paths = parsePrunePaths(args[0] || '');
  if (!paths.length) return;
  const needle = args.find((a, i) => i > 0 && (a.startsWith('url:') || a.startsWith('/'))) || args[args.length - 1];
  const urlNeedle = needle?.startsWith('url:') ? needle.slice(4) : needle;
  hookFetchTextTransform((url, body) => {
    if (!urlMatchesNeedle(url, urlNeedle)) return body;
    try {
      const obj = JSON.parse(body);
      pruneObject(obj, paths);
      return keepJsonValid(body, JSON.stringify(obj));
    } catch {
      return body;
    }
  });
}

function jsonPruneXhrResponse(args: string[]): void {
  const paths = parsePrunePaths(args[0] || '');
  if (!paths.length) return;
  const needle = args.find((a, i) => i > 0 && (a.startsWith('url:') || a.startsWith('/'))) || args[args.length - 1];
  const urlNeedle = needle?.startsWith('url:') ? needle.slice(4) : needle;
  hookXhrTextTransform((url, body) => {
    if (!urlMatchesNeedle(url, urlNeedle)) return body;
    try {
      const obj = JSON.parse(body);
      pruneObject(obj, paths);
      return keepJsonValid(body, JSON.stringify(obj));
    } catch {
      return body;
    }
  });
}

function compileReplacePattern(raw: string): { find: RegExp | string; isRe: boolean } | null {
  const s = unquoteArg(raw);
  const rx = /^\/(.*)\/([a-z]*)$/.exec(s);
  if (rx) {
    try {
      return { find: new RegExp(rx[1], rx[2]), isRe: true };
    } catch {
      return null;
    }
  }
  return { find: s, isRe: false };
}

function keepJsonValid(before: string, after: string): string {
  if (before === after) return before;
  const trimmed = before.trimStart();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return after;
  try {
    JSON.parse(after);
    return after;
  } catch {
    // Prefer the original payload over a corrupted player response (hangs YouTube).
    return before;
  }
}

function trustedReplaceFetchResponse(args: string[]): void {
  const [patternRaw, replacementRaw, needle] = args;
  const pat = compileReplacePattern(patternRaw || '');
  if (!pat) return;
  const replacement = unquoteArg(replacementRaw ?? '');
  hookFetchTextTransform((url, body) => {
    if (!urlMatchesNeedle(url, needle)) return body;
    try {
      const next = pat.isRe
        ? body.replace(pat.find as RegExp, replacement)
        : body.split(pat.find as string).join(replacement);
      return keepJsonValid(body, next);
    } catch {
      return body;
    }
  });
}

function trustedReplaceXhrResponse(args: string[]): void {
  const [patternRaw, replacementRaw, needle] = args;
  const pat = compileReplacePattern(patternRaw || '');
  if (!pat) return;
  const replacement = unquoteArg(replacementRaw ?? '');
  hookXhrTextTransform((url, body) => {
    if (!urlMatchesNeedle(url, needle)) return body;
    try {
      const next = pat.isRe
        ? body.replace(pat.find as RegExp, replacement)
        : body.split(pat.find as string).join(replacement);
      return keepJsonValid(body, next);
    } catch {
      return body;
    }
  });
}

// ---------------------------------------------------------------------------
// Global-patching scriptlets
// ---------------------------------------------------------------------------
// Each of these neuters one page capability when a pattern matches, and otherwise calls
// through untouched. The uniform shape matters: a scriptlet that misfires does not fail
// safe — it breaks the site — so every one of them defaults to "call the original".

/** uBO pattern semantics: empty/`*` matches all, `/re/flags` is a regex, leading `!` negates. */
function patternMatcher(raw: string | undefined): (text: string) => boolean {
  if (!raw || raw === '*') return () => true;
  if (raw.startsWith('!')) {
    const inner = textMatcher(raw.slice(1));
    return (t) => !inner(t);
  }
  return textMatcher(raw);
}

/** uBO `propsToMatch`: space-separated `key:value` pairs; a bare token is a URL needle. */
function propsMatcher(raw: string | undefined): (url: string, method: string) => boolean {
  if (!raw || raw === '*') return () => true;
  let urlNeedle: string | undefined;
  let method: string | undefined;
  for (const token of raw.trim().split(/\s+/)) {
    if (token.startsWith('url:')) urlNeedle = token.slice(4);
    else if (token.startsWith('method:')) method = token.slice(7).toUpperCase();
    else if (!urlNeedle) urlNeedle = token;
  }
  return (url, verb) => {
    if (method && verb.toUpperCase() !== method) return false;
    return urlMatchesNeedle(url, urlNeedle);
  };
}

/**
 * Apply `fn` to a dotted chain's owner, now or as soon as the site creates it.
 *
 * The previous abort-on-property-* walk bailed the moment an intermediate object was missing,
 * which is the normal case at document_start: the script that creates `_sp_` has not run yet.
 * 282 shipped rules use dotted chains — including the Sourcepoint CMP hooks on major news
 * sites — and every one of them was a silent no-op. Trap the root's setter instead, the same
 * way set-constant already does.
 */
function onChainOwner(chain: string, fn: (owner: object, prop: string) => void): void {
  const parts = chain.split('.').filter(Boolean);
  const prop = parts.pop();
  if (!prop) return;
  if (!parts.length) {
    fn(window, prop);
    return;
  }

  const [root, ...rest] = parts;
  const applyFrom = (obj: unknown): void => {
    let cur: unknown = obj;
    for (const p of rest) {
      if (cur == null || (typeof cur !== 'object' && typeof cur !== 'function')) return;
      cur = (cur as Record<string, unknown>)[p];
    }
    if (cur == null || (typeof cur !== 'object' && typeof cur !== 'function')) return;
    fn(cur as object, prop);
  };

  const existing = (window as unknown as Record<string, unknown>)[root];
  if (existing != null) applyFrom(existing);

  let held = existing;
  try {
    Object.defineProperty(window, root, {
      configurable: true,
      enumerable: true,
      get: () => held,
      set(v: unknown) {
        held = v;
        applyFrom(v);
      },
    });
  } catch {
    /* non-configurable root — nothing more we can do */
  }
}

/**
 * `no-window-open-if(pattern, delay, decoy)` — popunder defuser, 827 shipped rules.
 *
 * Returns a decoy window object rather than null: `null` is exactly what a browser popup
 * blocker returns, and anti-adblock scripts test for it to detect blocking. The decoy has to
 * absorb the property pokes a popunder does on the handle it gets back.
 */
function noWindowOpenIf(args: string[]): void {
  const match = patternMatcher(args[0]);
  const delay = args[1] ? parseInt(args[1], 10) : NaN;
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
    // uBO closes the decoy after `delay` ms when one is given, so a site that polls
    // `handle.closed` sees the lifecycle it expects.
    if (!Number.isNaN(delay) && delay >= 0) {
      setTimeout(() => {
        decoy['closed'] = true;
      }, delay);
    }
    return decoy;
  };

  window.open = function (this: unknown, url?: string | URL, ...rest: unknown[]) {
    try {
      if (match(String(url ?? ''))) return decoyWindow() as Window;
    } catch {
      /* fall through to the real open */
    }
    return (original as (...a: unknown[]) => Window | null).call(this, url, ...rest);
  } as typeof window.open;
}

/**
 * `addEventListener-defuser(type, pattern)` — 655 shipped rules.
 * Both arguments are wildcards when empty, so the guard requires BOTH to match before a
 * listener is dropped; anything else would silently break unrelated page behavior.
 */
function addEventListenerDefuser(args: string[]): void {
  const typeMatch = patternMatcher(args[0]);
  const handlerMatch = patternMatcher(args[1]);
  const proto = EventTarget.prototype;
  const original = proto.addEventListener;

  proto.addEventListener = function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    try {
      const src = typeof listener === 'function' ? listener.toString() : String(listener);
      if (typeMatch(String(type)) && handlerMatch(src)) return;
    } catch {
      /* fall through and register normally */
    }
    return original.call(this, type, listener, options);
  };
}

/** Body forms uBO accepts for the prevent-fetch/xhr family. */
function syntheticBody(spec: string | undefined): string {
  switch ((spec ?? '').trim()) {
    case 'emptyObj':
      return '{}';
    case 'emptyArr':
      return '[]';
    case 'true':
      return 'true';
    default:
      return '';
  }
}

/** `no-fetch-if(propsToMatch, responseBody)` — 359 shipped rules. */
function noFetchIf(args: string[]): void {
  const matches = propsMatcher(args[0]);
  const body = syntheticBody(args[1]);
  const original = window.fetch;

  window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    try {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      const method = init?.method ?? (input as Request)?.method ?? 'GET';
      if (matches(String(url), String(method))) {
        // A resolved empty 200 rather than a rejection: a rejected fetch is an observable
        // signal, and several anti-adblock scripts count failures.
        return Promise.resolve(
          new Response(body, { status: 200, statusText: 'OK', headers: { 'Content-Type': 'text/plain' } }),
        );
      }
    } catch {
      /* fall through */
    }
    return (original as (...a: unknown[]) => Promise<Response>).call(this, input, init);
  } as typeof window.fetch;
}

/**
 * `nano-setTimeout-booster` / `nano-setInterval-booster` — 309 shipped rules combined.
 * Scales a matching timer's delay so artificial "please wait N seconds" gates elapse at once.
 */
function nanoTimerBooster(kind: 'setTimeout' | 'setInterval', args: string[]): void {
  const match = patternMatcher(args[0]);
  const wantDelay = args[1] && args[1] !== '*' ? parseInt(args[1], 10) : NaN;
  let boost = args[2] ? parseFloat(args[2]) : 0.05;
  // uBO clamps out-of-range boosts rather than trusting the filter author.
  if (!Number.isFinite(boost) || boost < 0.001 || boost > 50) boost = 0.05;

  const g = window as unknown as Record<string, (...a: unknown[]) => number>;
  const original = g[kind];
  g[kind] = function (this: unknown, ...a: unknown[]) {
    const [cb, delay, ...rest] = a as [unknown, number | undefined, ...unknown[]];
    let nextDelay = delay;
    try {
      const src = typeof cb === 'function' ? cb.toString() : String(cb);
      const current = delay ?? 0;
      const delayOk = Number.isNaN(wantDelay) || wantDelay === current;
      if (match(src) && delayOk) nextDelay = Math.max(0, Math.floor(current * boost));
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
};

/** Resolve an alias and run the scriptlet. Unknown names are ignored. */
export function runScriptlet(name: string, args: string[]): void {
  const canonical = ALIASES[name] || ALIASES[name.replace(/\.js$/, '')];
  const host = typeof location !== 'undefined' ? location.hostname : '';
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

function installYoutubeAdSkipAssist(): void {
  const started = Date.now();
  const tick = () => {
    tickYoutubeAdSkipAssist();
    // Fast while the watch page boots; then keep a light watch for mid-rolls.
    const age = Date.now() - started;
    const delay = age < 30_000 ? 200 : 1000;
    if (age > 10 * 60_000) return; // stop after 10 minutes on this document
    setTimeout(tick, delay);
  };
  tickYoutubeAdSkipAssist();
  setTimeout(tick, 50);

  // React faster when the player enters `.ad-showing` than the poll alone.
  try {
    const root = document.documentElement;
    const mo = new MutationObserver(() => {
      if (Date.now() - started > 10 * 60_000) {
        mo.disconnect();
        return;
      }
      tickYoutubeAdSkipAssist();
    });
    mo.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class'],
    });
  } catch {
    /* ignore */
  }
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

  hookFetchTextTransform(transform);
  hookXhrTextTransform((url, body) => {
    if (!YT_PLAYER_API_RE.test(url)) {
      return body;
    }
    return transform(url, body);
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
