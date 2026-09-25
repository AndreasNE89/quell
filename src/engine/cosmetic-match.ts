// Given a hostname and the compiled cosmetic dataset, compute the selectors that apply.
// Runs in the service worker so per-page payloads stay small (only this hostname's
// specific rules travel to the content script; generic hiding ships as injected CSS).

import type {
  CosmeticActionData,
  CosmeticActionRule,
  CosmeticData,
  CosmeticListData,
  GenericCssSheet,
  ProceduralRule,
  ScriptletData,
  ScriptletListData,
  ScriptletRule,
} from '../shared/types.js';
import {
  domainSpecMatches,
  matchesExceptionHost,
  hostLookupKeys,
  isRegexDomain,
  filterDomainMatches,
  normalizeHostname,
  exceptionHostMatchPatterns,
  pathExceptionMatches,
  pathExceptionMatchPatterns,
} from '../shared/hostname.js';

type DomainSpec = { include: string[]; exclude: string[] };

/** An action as the content script receives it. */
export type CosmeticAction = CosmeticActionData;

export interface CosmeticMatch {
  hide: string[];
  /**
   * Selectors to revert with `display: revert !important`: generic hides of the registered
   * sheet that an exception cancels on this page. Specific hides an exception cancels are just
   * left out of `hide`, so the page's own display is untouched.
   */
  unhide: string[];
  procedural: ProceduralRule[];
  actions: CosmeticAction[];
  disableGeneric: boolean;
  disableSpecific: boolean;
  /**
   * With `genericRevert: 'files'`: the revert sheets (under `generated/`) that undo the
   * registered generic sheet on a page an entity exception (`@@||google.*^$generichide`) takes
   * out of generic hiding. The service worker injects them into the frame; `unhide` then no
   * longer carries the whole generic set.
   */
  revertGenericCss: string[];
}

export interface MatchCosmeticOptions {
  /** The user's own `#@#` selectors for this host: they cancel list hides, procedural rules and actions too. */
  userUnhide?: string[];
  /**
   * How to undo the registered generic sheet where an entity exception switches generic hiding
   * off: as selectors in `unhide` (the default, which the content script turns into one revert
   * sheet per frame), or as `revertGenericCss` files for chrome.scripting.insertCSS.
   */
  genericRevert?: 'selectors' | 'files';
}

function emptyList(): CosmeticListData {
  return {
    hideGeneric: [],
    unhideGeneric: [],
    hideSpecific: {},
    unhideSpecific: {},
    procedural: [],
    actions: [],
    hideScoped: [],
    unhideScoped: [],
    genericExcept: [],
  };
}

/**
 * Rules with domain lists, indexed by include key: a page is tested only against the rules one
 * of its lookup keys (hostLookupKeys) names, instead of every rule of every list.
 */
interface RuleIndex<T extends { domains: DomainSpec }> {
  rules: T[];
  byKey: Map<string, number[]>;
  /** Rules with no include (generic) or a `/regex/` include: tested on every page. */
  always: number[];
}

function buildIndex<T extends { domains: DomainSpec }>(rules: T[]): RuleIndex<T> {
  const byKey = new Map<string, number[]>();
  const always: number[] = [];
  rules.forEach((r, i) => {
    const include = r.domains.include;
    if (!include.length || include.some(isRegexDomain)) {
      always.push(i);
      return;
    }
    for (const d of new Set(include.map((x) => x.trim().toLowerCase()))) {
      const list = byKey.get(d);
      if (list) list.push(i);
      else byKey.set(d, [i]);
    }
  });
  return { rules, byKey, always };
}

/** The rules of `index` whose domain spec covers `host`, in their original order. */
function lookup<T extends { domains: DomainSpec }>(
  index: RuleIndex<T>,
  host: string,
  keys: string[],
): T[] {
  const hits = new Set<number>(index.always);
  for (const k of keys) for (const i of index.byKey.get(k) ?? []) hits.add(i);
  return [...hits]
    .sort((a, b) => a - b)
    .map((i) => index.rules[i])
    .filter((r) => domainSpecMatches(host, r.domains));
}

/** Everything matchCosmetic needs for one (dataset, enabled lists) pair. */
interface MergedView {
  list: CosmeticListData;
  /** Generic selectors the registered sheets hide with these lists on (planGenericCss). */
  registeredGeneric: Set<string>;
  unhideGeneric: Set<string>;
  regexHideKeys: string[];
  regexUnhideKeys: string[];
  procedural: RuleIndex<ProceduralRule>;
  actions: RuleIndex<CosmeticActionRule>;
  /** `~a.com##S` hides whose selector no enabled list also hides unconditionally. */
  genericExcept: Map<string, string[][]>;
  netEx: { generichide: string[]; elemhide: string[]; specifichide: string[] };
  pathEx: { generichide: string[]; elemhide: string[]; specifichide: string[] };
  /** Whole-host generichide/elemhide entries a registration exclude can express. */
  concreteGenericOff: string[];
  revertFiles: string[];
}

// The merge materializes the whole dataset (Sets over ~29k generic selectors and ~28k domain
// keys holding ~43k specific selectors, plus the rule indexes). matchCosmetic runs once per
// frame per page load, so rebuilding it per call is tens of milliseconds of blocking
// service-worker work on every navigation. The inputs are a module constant and the
// enabled-list array, so the result is stable until settings change — cache on the two
// identities.
let mergeCache: { data: CosmeticData; key: string; view: MergedView } | null = null;

function mergedView(data: CosmeticData, enabledListIds: string[]): MergedView {
  const key = enabledListIds.join('\0');
  if (mergeCache && mergeCache.data === data && mergeCache.key === key) return mergeCache.view;

    const merged = emptyList();
  const hideGeneric = new Set<string>();
  const unhideGeneric = new Set<string>();
  const hideSpecific: Record<string, Set<string>> = {};
  const unhideSpecific: Record<string, Set<string>> = {};
  const plainGeneric = new Set<string>();
  const exceptSets = new Map<string, string[][]>();
  const buckets: CosmeticListData[] = [];

  for (const id of enabledListIds) {
    const bucket = data.byList[id];
    if (!bucket) continue;
    buckets.push(bucket);
    for (const s of bucket.hideGeneric) hideGeneric.add(s);
    for (const s of bucket.unhideGeneric) unhideGeneric.add(s);
    for (const [dom, sels] of Object.entries(bucket.hideSpecific)) {
      const set = (hideSpecific[dom] ||= new Set());
      for (const s of sels) set.add(s);
    }
    for (const [dom, sels] of Object.entries(bucket.unhideSpecific)) {
      const set = (unhideSpecific[dom] ||= new Set());
      for (const s of sels) set.add(s);
    }
    merged.procedural.push(...bucket.procedural);
    merged.actions!.push(...(bucket.actions ?? []));
    merged.hideScoped!.push(...(bucket.hideScoped ?? []));
    merged.unhideScoped!.push(...(bucket.unhideScoped ?? []));
    const excepted = new Set<string>();
    for (const g of bucket.genericExcept ?? []) {
      excepted.add(g.selector);
      const sets = exceptSets.get(g.selector) ?? [];
      sets.push(...g.exclude);
      exceptSets.set(g.selector, sets);
    }
    for (const s of bucket.hideGeneric) if (!excepted.has(s)) plainGeneric.add(s);
  }

  // What the registered sheets hold: each list's generic hides minus its own exceptions and
  // those of every other enabled list (compile-filters splits the sheets that way).
  const registeredGeneric = new Set<string>();
  for (const bucket of buckets) {
    const own = new Set(bucket.unhideGeneric);
    for (const s of bucket.hideGeneric) {
      if (!own.has(s) && !unhideGeneric.has(s)) registeredGeneric.add(s);
    }
  }
  const genericExcept = new Map<string, string[][]>();
  for (const [s, sets] of exceptSets) {
    if (!plainGeneric.has(s) && registeredGeneric.has(s)) genericExcept.set(s, sets);
  }

  merged.hideGeneric = [...hideGeneric];
  merged.unhideGeneric = [...unhideGeneric];
  for (const [k, v] of Object.entries(hideSpecific)) merged.hideSpecific[k] = [...v];
  for (const [k, v] of Object.entries(unhideSpecific)) merged.unhideSpecific[k] = [...v];
  merged.genericExcept = [...genericExcept].map(([selector, exclude]) => ({ selector, exclude }));

  const netEx = mergeNetworkExceptions(data, enabledListIds);
  const view: MergedView = {
    list: merged,
    registeredGeneric,
    unhideGeneric,
    regexHideKeys: Object.keys(merged.hideSpecific).filter(isRegexDomain),
    regexUnhideKeys: Object.keys(merged.unhideSpecific).filter(isRegexDomain),
    procedural: buildIndex(merged.procedural),
    actions: buildIndex(merged.actions!),
    genericExcept,
    netEx,
    pathEx: mergePathExceptions(data, enabledListIds),
    concreteGenericOff: [...netEx.generichide, ...netEx.elemhide].filter(
      (h) => exceptionHostMatchPatterns(h).length > 0,
    ),
    revertFiles: genericCssFiles(data, enabledListIds).map((s) => `generated/${s.revert}`),
  };
  mergeCache = { data, key, view };
  return view;
}

/** Merge enabled list buckets into one CosmeticListData view (memoized). */
export function mergeCosmeticLists(
  data: CosmeticData,
  enabledListIds: string[],
): CosmeticListData {
  return mergedView(data, enabledListIds).list;
}

/** Drop the memoized merge. Only needed by tests that mutate a dataset in place. */
export function clearCosmeticMergeCache(): void {
  mergeCache = null;
}

/**
 * The generic stylesheets to register for these lists: each list's base sheet, plus the sheets
 * of selectors other lists except (`#@#sel`) while none of those lists is enabled. A generic
 * exception thereby cancels the selector in every list, as in uBO, not only in its own.
 */
export function genericCssFiles(data: CosmeticData, enabledListIds: string[]): GenericCssSheet[] {
  const plan = data.genericCss;
  if (!plan) return [];
  const on = new Set(enabledListIds);
  const out: GenericCssSheet[] = [];
  for (const id of enabledListIds) {
    for (const sheet of plan[id] ?? []) {
      if (!sheet.unless?.some((x) => on.has(x))) out.push(sheet);
    }
  }
  return out;
}

/**
 * The list-driven part of the generic sheet's registration: the stylesheets (paths under the
 * extension root) and the excludes for hosts and pages the enabled lists take out of generic
 * hiding. The caller adds the user's own excludes (allowlist, repair ladder). matchCosmetic
 * assumes exactly these excludes when it decides whether a page needs a revert.
 */
export function genericCssRegistration(
  data: CosmeticData,
  enabledListIds: string[],
): { css: string[]; excludeMatches: string[] } {
  const view = mergedView(data, enabledListIds);
  return {
    css: genericCssFiles(data, enabledListIds).map((s) => `generated/${s.file}`),
    excludeMatches: [
      ...new Set([
        ...view.concreteGenericOff.flatMap(exceptionHostMatchPatterns),
        // Page-scoped exceptions keep their path: EasyList's `@@||duckduckgo.com/?q=` excludes
        // the results page (`*://*.duckduckgo.com/?q=*`), not the whole site.
        ...[...view.pathEx.generichide, ...view.pathEx.elemhide].flatMap(pathExceptionMatchPatterns),
      ]),
    ],
  };
}

/** Union network cosmetic exceptions from enabled lists only. */
export function mergeNetworkExceptions(
  data: CosmeticData,
  enabledListIds: string[],
): { generichide: string[]; elemhide: string[]; specifichide: string[] } {
  const generichide: string[] = [];
  const elemhide: string[] = [];
  const specifichide: string[] = [];
  for (const id of enabledListIds) {
    const g = data.networkExceptions.generichide[id];
    const e = data.networkExceptions.elemhide[id];
    const s = data.networkExceptions.specifichide[id];
    if (g) generichide.push(...g);
    if (e) elemhide.push(...e);
    if (s) specifichide.push(...s);
  }
  return { generichide, elemhide, specifichide };
}

/** Union of the enabled lists' page-scoped (`host/path-glob`) exceptions. */
export function mergePathExceptions(
  data: CosmeticData,
  enabledListIds: string[],
): { generichide: string[]; elemhide: string[]; specifichide: string[] } {
  const out = { generichide: [] as string[], elemhide: [] as string[], specifichide: [] as string[] };
  const src = data.pathExceptions;
  if (!src) return out;
  for (const id of enabledListIds) {
    out.generichide.push(...(src.generichide[id] ?? []));
    out.elemhide.push(...(src.elemhide[id] ?? []));
    out.specifichide.push(...(src.specifichide[id] ?? []));
  }
  return out;
}

/** Path and query of `pageUrl` when it is a page on `hostname`; null otherwise. */
function pagePathOn(hostname: string, pageUrl: string | undefined): string | null {
  if (!pageUrl) return null;
  try {
    const u = new URL(pageUrl);
    if (normalizeHostname(u.hostname) !== normalizeHostname(hostname)) return null;
    return u.pathname + u.search;
  } catch {
    return null;
  }
}

/** The enabled lists' page-scoped generichide and elemhide entries that cover this page. */
function genericPathsOn(view: MergedView, host: string, path: string | null): string[] {
  if (path === null) return [];
  return [...view.pathEx.generichide, ...view.pathEx.elemhide].filter((e) =>
    pathExceptionMatches(e, host, path),
  );
}

/**
 * Whether the registered generic sheet reaches this page: genericCssRegistration excludes hosts
 * matching a *concrete* (match-patternable) generichide/elemhide entry, and the pages a concrete
 * page-scoped entry covers. Only entity-domain (example.*) exceptions, which can't be a match
 * pattern, still receive the sheet.
 */
function sheetReaches(view: MergedView, host: string, genericPaths: string[]): boolean {
  return !(
    matchesExceptionHost(host, view.concreteGenericOff) ||
    genericPaths.some((e) => pathExceptionMatchPatterns(e).length > 0)
  );
}

/**
 * Does the registered generic sheet (with only its list-driven excludes) apply in a frame on
 * `hostname` at `pageUrl`? A frame it never reached has nothing for a revert to undo there.
 */
export function genericSheetApplies(
  hostname: string,
  data: CosmeticData,
  enabledListIds: string[],
  pageUrl?: string,
): boolean {
  const view = mergedView(data, enabledListIds);
  const host = hostname.trim().toLowerCase();
  return sheetReaches(view, host, genericPathsOn(view, host, pagePathOn(hostname, pageUrl)));
}

/**
 * `pageUrl` is the frame's own address. Without it, page-scoped exceptions (EasyList's
 * search-results `generichide`) cannot apply and only whole-host ones do.
 *
 * Exceptions follow uBO: a list or user `#@#sel` for this host, a scoped one whose exclusions
 * spare it, or a generic `#@#sel` from any enabled list cancels `sel` wherever it would apply —
 * specific hides, procedural rules and actions alike, and the generic sheet (by revert).
 * `$specifichide` switches off every specific rule, procedural ones and actions included.
 */
export function matchCosmetic(
  hostname: string,
  data: CosmeticData,
  enabledListIds: string[],
  pageUrl?: string,
  opts: MatchCosmeticOptions = {},
): CosmeticMatch {
  const view = mergedView(data, enabledListIds);
  const merged = view.list;
  const host = hostname.trim().toLowerCase();
  const keys = hostLookupKeys(host);
  const path = pagePathOn(hostname, pageUrl);
  const onThisPage = (entries: string[]): string[] =>
    path === null ? [] : entries.filter((e) => pathExceptionMatches(e, host, path));
  const genericPaths = genericPathsOn(view, host, path);

  const disableGeneric =
    matchesExceptionHost(host, view.netEx.generichide) || genericPaths.length > 0;
  const disableAll =
    matchesExceptionHost(host, view.netEx.elemhide) || onThisPage(view.pathEx.elemhide).length > 0;
  const disableSpecific =
    disableAll ||
    matchesExceptionHost(host, view.netEx.specifichide) ||
    onThisPage(view.pathEx.specifichide).length > 0;

  // Pages the registration excludes need no per-page revert; entity-domain exceptions, whose
  // pages still receive the sheet, require the revert below.
  const sheetOnPage = sheetReaches(view, host, genericPaths);
  const revertAll = (disableGeneric || disableAll) && sheetOnPage;
  const filesMode = opts.genericRevert === 'files';

  // Every exception that applies on this page.
  const except = new Set<string>(view.unhideGeneric);
  for (const k of keys) for (const s of merged.unhideSpecific[k] ?? []) except.add(s);
  for (const k of view.regexUnhideKeys) {
    if (filterDomainMatches(host, k)) for (const s of merged.unhideSpecific[k]) except.add(s);
  }
  for (const r of merged.unhideScoped ?? []) {
    if (domainSpecMatches(host, r.domains)) except.add(r.selector);
  }
  for (const s of opts.userUnhide ?? []) except.add(s);

  const unhide = new Set<string>();
  let revertGenericCss: string[] = [];
  if (revertAll) {
    // generichide on an entity host: the sheet is injected anyway, so undo all of it — as
    // files the worker injects, or (default) as selectors (13,923 on google.* with the
    // default lists, which the content script must split into chunks Blink applies).
    if (filesMode) revertGenericCss = view.revertFiles;
    else for (const s of view.registeredGeneric) unhide.add(s);
  } else if (sheetOnPage) {
    for (const s of except) if (view.registeredGeneric.has(s)) unhide.add(s);
    for (const [s, sets] of view.genericExcept) {
      // Withdrawn here only when every generic rule for it excludes this host.
      if (sets.every((ex) => ex.some((d) => filterDomainMatches(host, d)))) unhide.add(s);
    }
  }

  if (disableSpecific) {
    return {
      hide: [],
      unhide: [...unhide],
      procedural: [],
      actions: [],
      disableGeneric: disableGeneric || disableAll,
      disableSpecific: true,
      revertGenericCss,
    };
  }

  const hide = new Set<string>();
  for (const k of keys) for (const s of merged.hideSpecific[k] ?? []) hide.add(s);
  for (const k of view.regexHideKeys) {
    if (filterDomainMatches(host, k)) for (const s of merged.hideSpecific[k]) hide.add(s);
  }
  for (const r of merged.hideScoped ?? []) {
    if (domainSpecMatches(host, r.domains)) hide.add(r.selector);
  }
  for (const s of except) hide.delete(s);

  const procedural = lookup(view.procedural, host, keys).filter((p) => !except.has(p.expr));
  const actions = lookup(view.actions, host, keys)
    .filter((a) => !except.has(a.expr))
    .map(({ expr, selector, procedural: proc, action, arg }) => ({
      expr,
      selector,
      procedural: proc,
      action,
      arg,
    }));

  return {
    hide: [...hide],
    unhide: [...unhide],
    procedural,
    actions,
    disableGeneric,
    disableSpecific: false,
    revertGenericCss,
  };
}

function scriptletKey(r: ScriptletRule): string {
  return `${r.name}\0${r.args.join('\0')}\0${r.domains.include.join(',')}\0${r.domains.exclude.join(',')}`;
}

// Per-list scriptlet indexes, built once per list object (the dataset is a module constant).
const scriptletIndexes = new WeakMap<
  ScriptletListData,
  { scriptlets: RuleIndex<ScriptletRule>; exceptions: RuleIndex<ScriptletRule> }
>();

function scriptletIndex(bucket: ScriptletListData): {
  scriptlets: RuleIndex<ScriptletRule>;
  exceptions: RuleIndex<ScriptletRule>;
} {
  let idx = scriptletIndexes.get(bucket);
  if (!idx) {
    idx = { scriptlets: buildIndex(bucket.scriptlets), exceptions: buildIndex(bucket.exceptions) };
    scriptletIndexes.set(bucket, idx);
  }
  return idx;
}

/**
 * Resolve enabled-list scriptlets for a hostname, applying #@#+js exceptions. Each list's rules
 * are indexed by include domain, so a page costs a few map lookups rather than a domain test
 * against all ~9,000 rules (7-8 ms of service-worker time per frame on www. hosts).
 */
export function matchScriptlets(
  hostname: string,
  data: ScriptletData,
  enabledListIds: string[],
): ScriptletRule[] {
  const host = hostname.trim().toLowerCase();
  const keys = hostLookupKeys(host);
  const exceptions: ScriptletRule[] = [];
  const candidates: ScriptletRule[] = [];

  for (const id of enabledListIds) {
    const bucket = data.byList[id];
    if (!bucket) continue;
    const idx = scriptletIndex(bucket);
    exceptions.push(...lookup(idx.exceptions, host, keys));
    candidates.push(...lookup(idx.scriptlets, host, keys));
  }

  const cancelled = new Set(
    exceptions.map((e) => `${e.name}\0${e.args.join('\0')}`),
  );

  const seen = new Set<string>();
  const out: ScriptletRule[] = [];
  for (const r of candidates) {
    const nameKey = `${r.name}\0${r.args.join('\0')}`;
    if (cancelled.has(nameKey)) continue;
    const key = scriptletKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
