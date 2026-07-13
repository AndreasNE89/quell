// Given a hostname and the compiled cosmetic dataset, compute the selectors that apply.
// Runs in the service worker so per-page payloads stay small (only this hostname's
// specific rules travel to the content script; generic hiding ships as injected CSS).

import type {
  CosmeticData,
  CosmeticListData,
  ProceduralRule,
  ScriptletData,
  ScriptletRule,
} from '../shared/types.js';
import {
  domainSuffixes,
  domainSpecMatches,
  matchesExceptionHost,
} from '../shared/hostname.js';

export interface CosmeticMatch {
  hide: string[];
  unhide: string[];
  procedural: ProceduralRule[];
  disableGeneric: boolean;
  disableSpecific: boolean;
}

function emptyList(): CosmeticListData {
  return {
    hideGeneric: [],
    unhideGeneric: [],
    hideSpecific: {},
    unhideSpecific: {},
    procedural: [],
  };
}

/** Merge enabled list buckets into one CosmeticListData view. */
export function mergeCosmeticLists(
  data: CosmeticData,
  enabledListIds: string[],
): CosmeticListData {
  const merged = emptyList();
  const hideGeneric = new Set<string>();
  const unhideGeneric = new Set<string>();
  const hideSpecific: Record<string, Set<string>> = {};
  const unhideSpecific: Record<string, Set<string>> = {};
  const procedural: ProceduralRule[] = [];

  for (const id of enabledListIds) {
    const bucket = data.byList[id];
    if (!bucket) continue;
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
    procedural.push(...bucket.procedural);
  }

  merged.hideGeneric = [...hideGeneric];
  merged.unhideGeneric = [...unhideGeneric];
  for (const [k, v] of Object.entries(hideSpecific)) merged.hideSpecific[k] = [...v];
  for (const [k, v] of Object.entries(unhideSpecific)) merged.unhideSpecific[k] = [...v];
  merged.procedural = procedural;
  return merged;
}

export function matchCosmetic(
  hostname: string,
  data: CosmeticData,
  enabledListIds: string[],
): CosmeticMatch {
  const merged = mergeCosmeticLists(data, enabledListIds);
  const suffixes = domainSuffixes(hostname);

  const disableGeneric = matchesExceptionHost(hostname, data.networkExceptions.generichide);
  const disableAll = matchesExceptionHost(hostname, data.networkExceptions.elemhide);
  const disableSpecific = matchesExceptionHost(hostname, data.networkExceptions.specifichide);

  if (disableAll) {
    return {
      hide: [],
      unhide: [...merged.hideGeneric],
      procedural: [],
      disableGeneric: true,
      disableSpecific: true,
    };
  }

  const hide = new Set<string>();
  const unhide = new Set<string>();

  if (!disableSpecific) {
    for (const suffix of suffixes) {
      const h = merged.hideSpecific[suffix];
      if (h) for (const s of h) hide.add(s);
      const u = merged.unhideSpecific[suffix];
      if (u) for (const s of u) unhide.add(s);
    }
  } else {
    // Still apply explicit unhides (exceptions) even when specifichide is on.
    for (const suffix of suffixes) {
      const u = merged.unhideSpecific[suffix];
      if (u) for (const s of u) unhide.add(s);
    }
  }

  // A specific unhide cancels a specific hide for the same hostname.
  for (const s of unhide) hide.delete(s);

  // generichide: cancel generic CSS by reverting those selectors in the content script.
  if (disableGeneric) {
    for (const s of merged.hideGeneric) unhide.add(s);
  }

  const procedural = disableAll
    ? []
    : merged.procedural.filter((p) => domainSpecMatches(hostname, p.domains));

  return {
    hide: [...hide],
    unhide: [...unhide],
    procedural,
    disableGeneric,
    disableSpecific,
  };
}

function scriptletKey(r: ScriptletRule): string {
  return `${r.name}\0${r.args.join('\0')}\0${r.domains.include.join(',')}\0${r.domains.exclude.join(',')}`;
}

/** Resolve enabled-list scriptlets for a hostname, applying #@#+js exceptions. */
export function matchScriptlets(
  hostname: string,
  data: ScriptletData,
  enabledListIds: string[],
): ScriptletRule[] {
  const exceptions: ScriptletRule[] = [];
  const candidates: ScriptletRule[] = [];

  for (const id of enabledListIds) {
    const bucket = data.byList[id];
    if (!bucket) continue;
    for (const r of bucket.exceptions) {
      if (domainSpecMatches(hostname, r.domains)) exceptions.push(r);
    }
    for (const r of bucket.scriptlets) {
      if (domainSpecMatches(hostname, r.domains)) candidates.push(r);
    }
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
