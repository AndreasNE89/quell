// Cosmetic half of compile-filters: parsed element-hiding lines → the per-list data in
// src/generated/cosmetic.json and the generic stylesheets the service worker registers.
//
// Kept out of compile-filters.mjs, which compiles everything the moment it is imported, so the
// rules below can be tested on their own. The runtime side is src/engine/cosmetic-match.ts.

import { cosmeticExceptionScope } from './parse-filter.mjs';

/** Selectors per CSS rule. Blink ignores the selectors of one rule past component 8,192. */
export const CSS_CHUNK = 500;

export function emptyCosmeticBucket() {
  return {
    hideGeneric: new Set(),
    /** selector → the `~domain` lists of this list's generic hides of it (`~a.com##.ad`) */
    genericExcept: new Map(),
    unhideGeneric: new Set(),
    hideSpecific: {},
    unhideSpecific: {},
    /** Domain-scoped hides and exceptions that carry `~domain` exclusions. */
    hideScoped: [],
    unhideScoped: [],
    procedural: [],
    actions: [],
    scriptlets: [],
    scriptletExceptions: [],
  };
}

/** Reject selectors that could break out of a CSS rule (e.g. `a{}body{display:none}`). */
export function isSafeSelector(sel) {
  if (!sel || typeof sel !== 'string') return false;
  if (/[{}]/.test(sel)) return false;
  if (sel.length > 2048) return false;
  return true;
}

function count(skips, reason) {
  skips[reason] = (skips[reason] || 0) + 1;
}

/**
 * The domains a scriptlet rule can ship with, or a skip reason. Scriptlets reach pages through
 * host-keyed registrations (scripts/lib/scriptlet-shards.mjs) that cannot test a `/regex/`
 * hostname: a regex include is dropped (the rule still runs on its other hosts), and a regex
 * exclusion, which would silently stop excluding, drops the rule.
 *
 * @returns {{ domains: { include: string[], exclude: string[] } } | { skip: string }}
 */
export function scriptletDomains(domains) {
  const isRegex = (d) => d.length > 2 && d.startsWith('/') && d.endsWith('/');
  if (domains.exclude.some(isRegex)) return { skip: 'scriptlet-regex-domain' };
  if (!domains.include.length) return { skip: 'scriptlet-generic' };
  const include = domains.include.filter((d) => !isRegex(d));
  if (!include.length) return { skip: 'scriptlet-regex-domain' };
  return { domains: include.length === domains.include.length ? domains : { ...domains, include } };
}

/**
 * Add one parsed element-hiding line (not a scriptlet) to a list's bucket.
 *
 * Domain lists with `~` exclusions keep their whole spec (`hideScoped` / `unhideScoped`). Host-
 * keyed maps cannot say "a.com but not b.a.com", and the old workaround, an entry in the opposite
 * map, turned an exception's exclusions into hides: `~onet.pl,…,pl#@#[id^="crt-"]` hid every
 * `crt-` element on onet.pl, fakt.pl and forbes.pl.
 */
export function applyCosmeticRule(c, cos, stats, skips) {
  if (c.kind === 'ignored') {
    if (c.unsupported) count(skips, `cosmetic-unsupported:${c.unsupported}`);
    return;
  }
  const { include, exclude } = c.domains;

  if (c.kind === 'procedural') {
    // Generic procedural rules would run the JS engine on every page.
    if (!include.length) {
      count(skips, 'cosmetic-procedural-generic');
      return;
    }
    cos.procedural.push({ domains: c.domains, expr: c.selector });
    stats.cosmetic++;
    return;
  }

  if (c.kind === 'action') {
    if (!include.length) {
      count(skips, `cosmetic-action-generic:${c.action}`);
      return;
    }
    if (!isSafeSelector(c.target)) {
      count(skips, 'cosmetic-unsafe-selector');
      return;
    }
    cos.actions.push({
      domains: c.domains,
      expr: c.selector,
      selector: c.target,
      procedural: c.procedural,
      action: c.action,
      arg: c.arg,
    });
    stats.cosmetic++;
    return;
  }

  const isUnhide = c.kind === 'unhide';
  const selector = c.selector;
  if (!selector || !isSafeSelector(selector)) {
    count(skips, 'cosmetic-unsafe-selector');
    return;
  }

  if (include.length && exclude.length) {
    (isUnhide ? cos.unhideScoped : cos.hideScoped).push({ domains: c.domains, selector });
  } else if (include.length) {
    const target = isUnhide ? cos.unhideSpecific : cos.hideSpecific;
    for (const d of include) (target[d] ||= new Set()).add(selector);
  } else if (exclude.length) {
    if (isUnhide) {
      // `~a.com#@#.ad`: an exception everywhere but a.com. The registered sheet cannot bring a
      // cancelled selector back on one host, and no shipped list has one; keep hiding.
      count(skips, 'cosmetic-exception-generic-excluded');
      return;
    }
    // `~a.com##.ad`: in the generic sheet, withdrawn on a.com by matchCosmetic (unless another
    // generic rule for the same selector still covers a.com).
    cos.hideGeneric.add(selector);
    const sets = cos.genericExcept.get(selector);
    if (sets === undefined) cos.genericExcept.set(selector, [[...exclude]]);
    else if (sets !== null) sets.push([...exclude]);
  } else {
    (isUnhide ? cos.unhideGeneric : cos.hideGeneric).add(selector);
    // A plain generic hide of the same selector wins over this list's exclusions.
    if (!isUnhide) cos.genericExcept.set(selector, null);
  }
  stats.cosmetic++;
}

function setMapToObj(m) {
  const o = {};
  for (const [k, v] of Object.entries(m)) o[k] = [...v];
  return o;
}

export function serializeBucket(cos) {
  const genericExcept = [];
  for (const [selector, sets] of cos.genericExcept) {
    if (sets) genericExcept.push({ selector, exclude: sets });
  }
  return {
    hideGeneric: [...cos.hideGeneric],
    unhideGeneric: [...cos.unhideGeneric],
    hideSpecific: setMapToObj(cos.hideSpecific),
    unhideSpecific: setMapToObj(cos.unhideSpecific),
    procedural: cos.procedural,
    actions: cos.actions,
    hideScoped: cos.hideScoped,
    unhideScoped: cos.unhideScoped,
    genericExcept,
  };
}

/**
 * Split every list's generic hides into stylesheets by which *other* lists except them.
 *
 * uBO applies a generic exception (`#@#[id^="div-gpt-ad"]`) to every list. Static registered
 * sheets cannot drop a selector at runtime, so a selector another list excepts goes into a file
 * of its own, registered only while none of those lists is enabled: ubo-filters' 44 anti-adblock
 * bait exceptions then stop EasyList hiding the bait, and a user who switches ubo-filters off
 * gets EasyList's hides back. A list's own exceptions never ship at all.
 *
 * @param {Record<string, { hideGeneric: string[], unhideGeneric: string[] }>} byList serialized buckets
 * @param {string[]} order list ids, registry order
 * @returns {Record<string, { name: string, selectors: string[], unless: string[] }[]>}
 *   per list, the base sheet first (`name` is the file name without `.css`)
 */
export function planGenericCss(byList, order) {
  const exceptedBy = new Map();
  for (const id of order) {
    for (const s of byList[id]?.unhideGeneric ?? []) {
      if (!exceptedBy.has(s)) exceptedBy.set(s, new Set());
      exceptedBy.get(s).add(id);
    }
  }
  const plan = {};
  for (const id of order) {
    const bucket = byList[id];
    if (!bucket) continue;
    const own = new Set(bucket.unhideGeneric);
    const groups = new Map([['', { name: id, selectors: [], unless: [] }]]);
    for (const s of bucket.hideGeneric) {
      if (own.has(s) || !isSafeSelector(s)) continue;
      const unless = [...(exceptedBy.get(s) ?? [])].filter((x) => x !== id).sort();
      const key = unless.join(',');
      if (!groups.has(key)) groups.set(key, { name: `${id}.x-${unless.join('.')}`, selectors: [], unless });
      groups.get(key).selectors.push(s);
    }
    plan[id] = [...groups.values()].filter((g, i) => i === 0 || g.selectors.length);
  }
  return plan;
}

/**
 * A selector the browser might reject: a functional pseudo-class (nested `:has()`, which is
 * invalid inside `:has()`), a vendor pseudo (`::-moz-selection`) or an escape. The compiler has
 * no CSS parser, and one invalid selector in a selector list drops the whole rule, so these get
 * a rule each instead of taking 499 others down with them.
 */
function mayBeInvalidCss(sel) {
  return /[(\\]|:-|::/.test(sel);
}

/**
 * One generic stylesheet: hides, or the matching revert the service worker injects into a frame
 * whose page an entity exception (`@@||google.*^$generichide`) takes out of generic hiding,
 * which no registration exclude can express. Rules are chunked so every selector applies.
 */
export function genericCssText(label, selectors, revert = false) {
  const decl = revert ? 'display: revert !important;' : 'display: none !important;';
  let css = `/* StampStack generic element-hiding${revert ? ' revert' : ''} for "${label}" — generated, do not edit. */\n`;
  const plain = selectors.filter((s) => !mayBeInvalidCss(s));
  for (let i = 0; i < plain.length; i += CSS_CHUNK) {
    css += `${plain.slice(i, i + CSS_CHUNK).join(',\n')} { ${decl} }\n`;
  }
  for (const s of selectors) if (mayBeInvalidCss(s)) css += `${s} { ${decl} }\n`;
  return css;
}

/**
 * Page hosts (or `host/path` entries) of a network cosmetic exception — `@@…$generichide`,
 * `$elemhide`, `$specifichide`, and `@@…$document`, which in uBO switches element hiding off
 * with everything else — added to `bag` for `listId`.
 *
 * The page is the one the URL pattern names. `domain=` names the page a frame sits in: it is
 * the page host only when the pattern has none of its own (`@@*$ghide,domain=uptoplay.net`).
 * For `@@||ad.12306.cn^$elemhide,subdocument,domain=95306.cn` the exception belongs to the
 * ad.12306.cn frame, not to 95306.cn, where it used to switch off every cosmetic filter; the
 * frame gets it wherever it is embedded, since the runtime does not know a frame's parent.
 *
 * `bag.skips` is where dropped exceptions are counted (ctx.skips in compile-filters).
 */
export function applyNetworkCosmeticException(kind, parsed, bag, listId) {
  if (!parsed.isException) return;
  const byList = bag[kind];
  if (!byList) return;
  const drop = (reason) => {
    if (bag.skips) count(bag.skips, reason);
  };
  // Runtime keys these exceptions by page host, plus a path for the ones EasyList limits to a
  // page (the Google, Bing, DuckDuckGo and Yandex results pages). A pattern it can't express
  // (a regex, a `^` in the path, `192.168.*.1`, `://10.0.0.`) is dropped whole — including its
  // $domain hosts, which would otherwise widen it to every page on those sites.
  const scope = cosmeticExceptionScope(parsed.pattern, parsed.isRegex);
  if (scope.skip) {
    drop(`cosmetic-exception-${scope.skip}`);
    return;
  }
  const o = parsed.options || {};
  const context = o.initiatorDomains || [];
  const destinations = o.requestDomains || [];
  if (scope.path !== null) {
    // `domain=` on a page-scoped exception narrows it further; never widen it to those hosts.
    if (context.length || destinations.length) {
      drop('cosmetic-exception-path-scoped');
      return;
    }
    const set = (bag.pathScoped[kind][listId] ||= new Set());
    for (const h of scope.hosts) set.add(`${h}${scope.path}`);
    return;
  }
  // The page is the request: `$to` names it outright and narrows the pattern
  // (@@||asd.$generichide,to=asd.homes|asd.ink), then the pattern's host, and only a pattern
  // with no host of its own (`@@*$ghide,domain=…`) is keyed by `domain=`. A `domain=` the
  // pattern covers is the page too, and narrows it the same way (`@@||shrink.$ghide,
  // domain=shrink.icu|shrink.yt` is those two sites, not every shrink.*); one it does not cover
  // is the page a frame sits in (`@@||ad.12306.cn^$elemhide,subdocument,domain=95306.cn`), which
  // a per-host exception cannot express, so the frame's own host stands.
  let hosts = destinations;
  if (!hosts.length) hosts = scope.hosts;
  if (!hosts.length) {
    hosts = context;
  } else if (context.length) {
    const within = context.filter((c) => hosts.some((h) => exceptionHostCovers(h, c)));
    if (within.length) hosts = within;
    else drop(`cosmetic-exception-${kind}-context-dropped`);
  }
  const set = (byList[listId] ||= new Set());
  for (const h of hosts) if (h) set.add(h);
}

/**
 * Does the exception host `h` (a host, or an entity `name.*`) cover the page host `c`? `c` may
 * be an entity itself, covered when its name is.
 */
function exceptionHostCovers(h, c) {
  const host = String(c).toLowerCase();
  const key = String(h).toLowerCase();
  if (!key.endsWith('.*')) return host === key || host.endsWith(`.${key}`);
  const name = key.slice(0, -2);
  if (host === key || host.endsWith(`.${key}`)) return true;
  // `shrink.*` covers shrink.icu and www.shrink.co.uk: the name, then one or two suffix labels.
  const at = host === name ? -1 : host.startsWith(`${name}.`) ? 0 : host.indexOf(`.${name}.`);
  if (at < 0) return false;
  const rest = host.slice(at === 0 ? name.length + 1 : at + name.length + 2);
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)?$/.test(rest);
}

/**
 * Is this parsed network line a `@@…$document` exception? uBO switches off element hiding on
 * such a page along with network filtering; DNR's allowAllRequests only covers the network.
 *
 * `main_frame` among the types is not enough: the parser also gives a typeless `$removeparam`
 * every type, so `@@||example.com^$removeparam=utm_source`, which only keeps a query parameter,
 * would switch off all element hiding on example.com. A `$document` that carries another
 * modifier (`$doc,urlskip`, `$document,csp=…`) excepts that modifier, and `$all,~doc` leaves the
 * document out.
 */
export function isDocumentException(parsed) {
  const o = parsed?.options;
  return (
    !!parsed?.isException &&
    !parsed.cosmeticException &&
    !o?.badfilter &&
    !!o?.resourceTypes?.includes('main_frame') &&
    !o.excludedResourceTypes?.includes('main_frame') &&
    !o.removeParams?.length &&
    parsed.redirect == null &&
    !parsed.unsupported?.length
  );
}

/**
 * The element-hiding half of a `@@…$document` exception: its page, taken from the URL pattern
 * only. With `domain=` the page is the context of a frame the runtime cannot see, so such a line
 * keeps cosmetics (counted).
 */
export function applyDocumentCosmeticException(parsed, bag, listId) {
  const o = parsed.options || {};
  if (o.initiatorDomains?.length || o.requestDomains?.length) {
    if (bag.skips) count(bag.skips, 'document-exception-cosmetics-context');
    return;
  }
  const scope = cosmeticExceptionScope(parsed.pattern, parsed.isRegex);
  if (scope.skip || !scope.hosts.length) {
    if (bag.skips) count(bag.skips, `document-exception-cosmetics-${scope.skip ?? 'no-host'}`);
    return;
  }
  applyNetworkCosmeticException('elemhide', parsed, bag, listId);
}
