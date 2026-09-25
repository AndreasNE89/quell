// Runtime half of document_start scriptlet delivery (REVIEW_2026-09-24 B2). The build side,
// scripts/lib/scriptlet-shards.mjs, explains the file layout; this module is what reads it:
//   - matchShards runs in the page (MAIN world) and picks the rules for one host, with the
//     semantics of matchScriptlets (cosmetic-match.ts): suffix and entity matching, `~domain`
//     exclusions, exceptions from any file in the same injection, one run per name+args;
//   - shardRegistrations and planShardInjection run in the service worker and turn the compiled
//     index into content-script registrations and executeScript fallbacks.

import {
  entityDomainKeys,
  filterDomainMatches,
  domainSpecMatches,
  isIPv4Host,
} from '../shared/hostname.js';

/** Registered-script id prefix; `quell-*` like every other id, for upgrade safety. */
export const SCRIPTLET_SHARD_ID_PREFIX = 'quell-sl-';
export const SCRIPTLET_BROAD_ID = `${SCRIPTLET_SHARD_ID_PREFIX}broad`;
/** The MAIN-world runtime the bucket registrations and fallback injections end with. */
export const SCRIPTLET_RUNTIME_FILE = 'scriptlets-runtime.js';
/**
 * The same runtime under another name, for the broad registration. Chrome injects a file only
 * once per document even when two registrations list it (measured, Chromium 131): on a host
 * matched by a bucket and by the broad script, a shared runtime ran after the bucket's data and
 * never after the broad data, so entity rules silently did nothing there.
 */
export const SCRIPTLET_BROAD_RUNTIME_FILE = 'scriptlets-runtime-broad.js';

/** A rule entry under a host key: the args index, then the rule's `~domain` exclusions. */
type HostEntry = number | [number, ...string[]];

/** Parsed `p` of one data file. */
export interface ShardPayload {
  /** `[name, ...args]` tuples, in rule order. */
  a: string[][];
  /** Include key → entries. */
  h: Record<string, HostEntry[]>;
  /** Exceptions: include domains, exclude domains, args index. */
  x: [string[], string[], number][];
}

/** What one data file hands the runtime. */
export interface ShardData {
  /** List id. */
  l?: string;
  /** Broad files only: `|key|key|`, every key that can make the file matter. */
  k?: string;
  /** The payload as JSON, parsed only when the page needs it. */
  p: string;
}

export interface ShardIndexList {
  /** Bucket → the list's file for it and its rule keys (`|`-joined; empty for exception-only files). */
  buckets: Record<string, { file: string; keys: string }>;
  broad: { file: string; rules: boolean; keys: string } | null;
}

/** One file that holds a registration's data files and its runtime, joined at build time. */
export interface ShardBundle {
  file: string;
  /** The files it stands in for, in injection order. */
  parts: string[];
}

/** src/generated/scriptlet-shards.json */
export interface ShardIndex {
  version: string;
  key: string;
  buckets: number;
  fallback: string;
  lists: Record<string, ShardIndexList>;
  /**
   * Registration id → its bundle for the lists that are on by default (scripts/build.mjs joins
   * the bytes). Absent in indexes built without one, which then register their parts.
   */
  bundles?: Record<string, ShardBundle>;
}

function splitKeys(keys: string): string[] {
  return keys ? keys.split('|') : [];
}

/** Every dotted suffix of the host, the TLD included, most specific first. */
export function hostSuffixes(hostname: string): string[] {
  const host = hostname.trim().toLowerCase();
  if (!host) return [];
  const parts = host.split('.');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) out.push(parts.slice(i).join('.'));
  return out;
}

/** Keys a data file can hold for this host: its suffixes, then its entity keys (`example.*`). */
export function shardCandidates(hostname: string): string[] {
  const suffixes = hostSuffixes(hostname);
  if (!suffixes.length) return [];
  return [...suffixes, ...entityDomainKeys(hostname)];
}

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function tupleKey(tuple: string[]): string {
  return tuple.join('\0');
}

/** The scriptlets `datas` hold for `hostname`, exceptions applied, each name+args once. */
export function matchShards(
  hostname: string,
  datas: ShardData[],
): { name: string; args: string[] }[] {
  const candidates = shardCandidates(hostname);
  if (!candidates.length) return [];
  const payloads: ShardPayload[] = [];
  for (const d of datas) {
    if (!d || typeof d.p !== 'string') continue;
    const prefilter = d.k;
    if (typeof prefilter === 'string' && !candidates.some((c) => prefilter.includes(`|${c}|`))) {
      continue;
    }
    try {
      payloads.push(JSON.parse(d.p) as ShardPayload);
    } catch {
      /* a damaged file must not stop the others */
    }
  }

  const cancelled = new Set<string>();
  for (const p of payloads) {
    for (const [include, exclude, ai] of p.x) {
      if (domainSpecMatches(hostname, { include, exclude })) cancelled.add(tupleKey(p.a[ai]));
    }
  }

  const seen = new Set<string>();
  const out: { name: string; args: string[] }[] = [];
  for (const p of payloads) {
    const hits: number[] = [];
    for (const c of candidates) {
      if (!hasOwn(p.h, c)) continue;
      for (const entry of p.h[c]) {
        if (typeof entry === 'number') {
          hits.push(entry);
          continue;
        }
        const [ai, ...exclude] = entry;
        if (!exclude.some((d) => filterDomainMatches(hostname, d))) hits.push(ai);
      }
    }
    // Args indexes follow rule order, so this keeps the list's own order.
    hits.sort((x, y) => x - y);
    for (const ai of hits) {
      const tuple = p.a[ai];
      const key = tupleKey(tuple);
      if (cancelled.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push({ name: tuple[0], args: tuple.slice(1) });
    }
  }
  return out;
}

/** The match pattern for a concrete key: `*.` also matches the bare host; an IP has no subdomains. */
export function shardMatchPattern(key: string): string {
  return isIPv4Host(key) ? `*://${key}/*` : `*://*.${key}/*`;
}

export interface ShardRegistration {
  id: string;
  /** What Chrome is asked to inject: the registration's bundle when it holds exactly `parts`. */
  js: string[];
  /** Enabled lists' data files, then the runtime. */
  parts: string[];
  /** Built only when the registration has to be written. */
  matches: () => string[];
}

/**
 * The bundle stands in for `parts` only when it holds exactly those files. Chrome runs a
 * registration's files one by one, and in a sandboxed frame without `allow-scripts` every one
 * of them fails with its own console error ("Blocked script execution in 'about:blank'…").
 * matchOriginAsFallback is what reaches those frames, and chrome.scripting cannot leave
 * sandboxed frames out, so one file per registration is the least noise a page can get.
 * The bundle's name is derived from its parts, so `js` still decides `matches`.
 */
function injected(index: ShardIndex, id: string, parts: string[]): string[] {
  const bundle = index.bundles?.[id];
  return bundle && bundle.parts.join('\n') === parts.join('\n') ? [bundle.file] : parts;
}

/**
 * One registration per bucket any enabled list has rules in, plus the broad one. Each carries
 * every enabled list's file for its bucket, exception-only files included, so a list's
 * exceptions reach rules from the others.
 */
export function shardRegistrations(index: ShardIndex, enabled: string[]): ShardRegistration[] {
  const lists = enabled.filter((id) => index.lists[id]);
  const out: ShardRegistration[] = [];
  for (let b = 0; b < index.buckets; b++) {
    const withFile = lists.filter((id) => index.lists[id].buckets[b]);
    if (!withFile.some((id) => index.lists[id].buckets[b].keys)) continue;
    const id = `${SCRIPTLET_SHARD_ID_PREFIX}${b}`;
    const parts = [...withFile.map((l) => index.lists[l].buckets[b].file), SCRIPTLET_RUNTIME_FILE];
    out.push({
      id,
      js: injected(index, id, parts),
      parts,
      matches: () => [
        ...new Set(
          withFile.flatMap((l) => splitKeys(index.lists[l].buckets[b].keys)).map(shardMatchPattern),
        ),
      ],
    });
  }
  const broad = lists.filter((id) => index.lists[id].broad);
  if (broad.some((id) => index.lists[id].broad?.rules)) {
    const parts = [...broad.map((l) => index.lists[l].broad!.file), SCRIPTLET_BROAD_RUNTIME_FILE];
    out.push({
      id: SCRIPTLET_BROAD_ID,
      js: injected(index, SCRIPTLET_BROAD_ID, parts),
      parts,
      // Entities (`example.*`) have no match pattern; the file checks the host before parsing.
      matches: () => ['*://*/*'],
    });
  }
  return out;
}

/** The data and runtime files behind a registration's `js`, its bundle opened up. */
export function shardParts(index: ShardIndex, js: string[]): string[] {
  const bundles = Object.values(index.bundles ?? {});
  return js.flatMap((f) => bundles.find((b) => b.file === f)?.parts ?? [f]);
}

interface ShardLookup {
  /** Concrete key → its bucket and the lists with a rule on it. */
  concrete: Map<string, { bucket: number; lists: string[] }>;
  /** Broad key → the lists with a rule on it. */
  broad: Map<string, string[]>;
}

const lookups = new WeakMap<ShardIndex, ShardLookup>();

function lookupFor(index: ShardIndex): ShardLookup {
  let l = lookups.get(index);
  if (l) return l;
  l = { concrete: new Map(), broad: new Map() };
  for (const [id, list] of Object.entries(index.lists)) {
    for (const [b, entry] of Object.entries(list.buckets)) {
      for (const key of splitKeys(entry.keys)) {
        const info = l.concrete.get(key);
        if (info) info.lists.push(id);
        else l.concrete.set(key, { bucket: Number(b), lists: [id] });
      }
    }
    for (const key of splitKeys(list.broad?.keys ?? '')) {
      const ids = l.broad.get(key);
      if (ids) ids.push(id);
      else l.broad.set(key, [id]);
    }
  }
  lookups.set(index, l);
  return l;
}

export interface ShardPlan {
  /** Registration ids whose scripts would carry this host's rules. */
  registrations: { id: string; files: string[] }[];
}

/**
 * The data files a frame on `hostname` needs, grouped by the registration that would carry
 * them, or null when no enabled list has a rule for it. The service worker injects these
 * (plus the fallback marker and the runtime) when the registered scripts cannot serve a frame.
 */
export function planShardInjection(
  index: ShardIndex,
  hostname: string,
  enabled: string[],
): ShardPlan | null {
  const lookup = lookupFor(index);
  const on = new Set(enabled);
  const lists = enabled.filter((id) => index.lists[id]);
  const suffixes = hostSuffixes(hostname);
  const registrations: ShardPlan['registrations'] = [];

  for (const s of suffixes) {
    const info = lookup.concrete.get(s);
    if (!info || !info.lists.some((id) => on.has(id))) continue;
    const files = lists
      .map((id) => index.lists[id].buckets[info.bucket]?.file)
      .filter((f): f is string => !!f);
    registrations.push({ id: `${SCRIPTLET_SHARD_ID_PREFIX}${info.bucket}`, files });
    break; // every key of one host shares a bucket
  }

  const broadHit = [...suffixes, ...entityDomainKeys(hostname)].some((k) =>
    (lookup.broad.get(k) ?? []).some((id) => on.has(id)),
  );
  if (broadHit) {
    registrations.push({
      id: SCRIPTLET_BROAD_ID,
      files: lists.map((id) => index.lists[id].broad?.file).filter((f): f is string => !!f),
    });
  }
  return registrations.length ? { registrations } : null;
}
