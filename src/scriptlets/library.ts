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
  const parts = chain.split('.');
  const prop = parts.pop();
  if (!prop) return;
  let owner: any = window;
  for (const p of parts) {
    owner = owner?.[p];
    if (owner == null) return;
  }
  try {
    Object.defineProperty(owner, prop, { get: AbortError, set: () => {}, configurable: true });
  } catch {
    /* ignore */
  }
}

function abortOnPropertyWrite(chain: string): void {
  const parts = chain.split('.');
  const prop = parts.pop();
  if (!prop) return;
  let owner: any = window;
  for (const p of parts) {
    owner = owner?.[p];
    if (owner == null) return;
  }
  try {
    Object.defineProperty(owner, prop, {
      set: AbortError,
      get: () => undefined,
      configurable: true,
    });
  } catch {
    /* ignore */
  }
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

function abortCurrentInlineScript(args: string[]): void {
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
  const orig = desc?.value;
  const guard = (): unknown => {
    const el = document.currentScript;
    if (el instanceof HTMLScriptElement && !el.src && match(el.textContent ?? '')) {
      throw new ReferenceError('StampStack: aborted inline script');
    }
    return orig;
  };
  try {
    Object.defineProperty(owner, prop, { get: guard, set: () => {}, configurable: true });
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

const YT_AD_KEYS = new Set(['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams']);

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

function urlMatchesNeedle(url: string, needle: string | undefined): boolean {
  if (!needle || needle === '*') return true;
  const n = unquoteArg(needle);
  const rx = /^\/(.*)\/([a-z]*)$/.exec(n);
  if (rx) {
    try {
      return new RegExp(rx[1], rx[2]).test(url);
    } catch {
      return false;
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
    this.addEventListener(
      'readystatechange',
      () => {
        if (this.readyState !== 4) return;
        try {
          const url = (this as unknown as { __quellUrl?: string }).__quellUrl || '';
          const raw = this.responseText;
          if (typeof raw !== 'string' || !raw) return;
          const next = transform(url, raw);
          if (next === raw) return;
          Object.defineProperty(this, 'responseText', { get: () => next });
          try {
            Object.defineProperty(this, 'response', { get: () => next });
          } catch {
            /* ignore */
          }
        } catch {
          /* ignore */
        }
      },
      { once: true },
    );
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

/**
 * Install document_start YouTube hooks before the player bootstrap runs.
 * Safe to call multiple times (idempotent).
 */
export function installYoutubeEarlyHooks(): void {
  const g = globalThis as unknown as { __quellYtEarly?: boolean };
  if (g.__quellYtEarly) return;
  g.__quellYtEarly = true;

  // Fetch/XHR scrub only. Defining getters on ytInitialPlayerResponse / ytInitialData
  // has hung the Chromium watch player in audits even when mutating in place.

  const transform = (url: string, body: string): string => {
    if (!/youtubei\/v1\/(?:player|get_watch|next)|\/player\?|get_watch\?|playlist\?list=/i.test(url)) {
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
          .replace(/"playerAds"/g, '"no_ads"'),
      );
    }
  };

  hookFetchTextTransform(transform);
  hookXhrTextTransform((url, body) => {
    if (!/youtubei\/v1\/(?:player|get_watch|next)|\/player\?|get_watch\?|playlist\?list=/i.test(url)) {
      return body;
    }
    return transform(url, body);
  });
}
