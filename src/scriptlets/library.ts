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
};

function parseConstant(raw: string): unknown {
  switch (raw) {
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
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

/** Define `chain` (dotted path) on window as a non-overridable constant getter. */
function setConstant(chain: string, value: unknown): void {
  const parts = chain.split('.');
  const prop = parts.pop();
  if (!prop) return;
  let owner: any = window;
  for (const p of parts) {
    if (owner[p] == null) {
      try {
        owner[p] = {};
      } catch {
        return;
      }
    }
    owner = owner[p];
    if (owner == null) return;
  }
  try {
    Object.defineProperty(owner, prop, {
      get: () => value,
      set: () => {},
      configurable: false,
    });
  } catch {
    /* already non-configurable */
  }
}

const AbortError = (): never => {
  throw new ReferenceError('Quell: aborted property access');
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
    Object.defineProperty(owner, prop, { get: AbortError, set: () => {}, configurable: false });
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
      configurable: false,
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
      throw new ReferenceError('Quell: aborted inline script');
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
      if (match(cbStr) && delayOk) return 0; // swallow
    } catch {
      /* fall through to original */
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
  // Coalesce mutation bursts into one rescan per frame. The isolated cosmetic engine
  // and other scripts mutate the shared DOM constantly; without throttling, every
  // attribute/childList batch would trigger a full-document querySelectorAll.
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

const SCRIPTLETS: Record<string, Scriptlet> = {
  'set-constant': (a) => setConstant(a[0], parseConstant(a[1] ?? '')),
  'abort-on-property-read': (a) => abortOnPropertyRead(a[0]),
  'abort-on-property-write': (a) => abortOnPropertyWrite(a[0]),
  'abort-current-inline-script': (a) => abortCurrentInlineScript(a),
  'prevent-setTimeout': (a) => preventTimer('setTimeout', a),
  'prevent-setInterval': (a) => preventTimer('setInterval', a),
  'remove-attr': (a) => removeAttr(a),
  'remove-class': (a) => removeClass(a),
};

/** Resolve an alias and run the scriptlet. Unknown names are ignored. */
export function runScriptlet(name: string, args: string[]): void {
  const canonical = ALIASES[name] || ALIASES[name.replace(/\.js$/, '')];
  const fn = canonical ? SCRIPTLETS[canonical] : undefined;
  if (!fn) return;
  try {
    fn(args);
  } catch {
    /* a scriptlet must never take down the injector */
  }
}

export const SUPPORTED_SCRIPTLETS = Object.keys(SCRIPTLETS);
