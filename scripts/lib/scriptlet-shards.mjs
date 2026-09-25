// Build-time half of document_start scriptlet delivery (REVIEW_2026-09-24 B2).
//
// A scriptlet only works if it runs before the page's own scripts. Asking the service worker
// and waiting for chrome.scripting.executeScript lands 30-200 ms late, after inline <head>
// scripts and often after `load`. uBO Lite's answer, used here: ship the rules as MAIN-world
// files and register them with chrome.scripting.registerContentScripts at document_start, keyed
// by hostname, so Chrome injects them before the parser runs anything.
//
// Layout. Every include key goes to exactly one place:
//   - a concrete host (`example.com`, `1.2.3.4`) goes to one of SHARD_BUCKETS buckets, chosen by
//     its site (the smallest suffix that is not a public suffix). Every key that can match a page
//     is a suffix of that page's host no shorter than its site, so all of a page's keys share one
//     bucket, and one bucket file per list holds everything that page needs.
//   - an entity (`example.*`), a public-suffix key (`co.uk`) or anything else a match pattern
//     cannot express goes to the list's "broad" file, which is registered for every page and
//     checks the host at runtime before parsing anything.
//
// The service worker registers one content script per bucket whose `js` is the enabled lists'
// files for that bucket followed by the shared runtime, and one broad script the same way, so
// the runtime sees every enabled list at once: exceptions from one list still cancel rules from
// another, as matchScriptlets does. Exceptions are copied into every file whose rules they can
// meet, since a bucket registration and the broad one run separately.
//
// Keys and semantics are those of src/shared/hostname.ts (passed in as `host`), so a page gets
// what matchScriptlets would give it: www-stripped suffix matching, entity matching, and
// per-rule `~domain` exclusions.

import { createHash } from 'node:crypto';

/**
 * Buckets per list. Each bucket is a separate registration, so this trades per-page parse
 * weight (the whole bucket file loads on a matching page) against registration count; with
 * ~22k hosts, 16 keeps the largest file near 60 KB and each `matches` array near 1.4k patterns.
 * What a page pays for is the total pattern count: Chrome tests each one against every frame URL.
 */
export const SHARD_BUCKETS = 16;

/** Output directory under dist/ (and src/generated/). */
export const SHARD_DIR = 'generated/scriptlets';

/** FNV-1a, 32 bit: stable across Node versions and platforms, unlike anything seeded. */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The smallest suffix of `host` that is not a public suffix, or null when there is none.
 * A key that matches a page is a suffix of the page's host; if the key is not itself a public
 * suffix, the page's site and the key's site are the same string.
 */
export function siteOf(host, isPublicSuffixHost) {
  const parts = host.split('.');
  for (let i = parts.length - 1; i >= 0; i--) {
    const suffix = parts.slice(i).join('.');
    if (!isPublicSuffixHost(suffix)) return suffix;
  }
  return null;
}

export function bucketOf(host, isPublicSuffixHost, buckets = SHARD_BUCKETS) {
  const site = siteOf(host, isPublicSuffixHost);
  return site === null ? -1 : fnv1a(site) % buckets;
}

/**
 * Where one include key of a rule goes.
 * `concrete`: a match pattern can name it; `broad`: an entity or public suffix, checked at
 * runtime on every page; `dead`: hostMatchesDomain can never match it (`>>` forms, non-ASCII
 * names, IPv6, dotted entities), so shipping it would only cost bytes.
 */
export function classifyKey(raw, host) {
  const key = host.normalizeHostname(String(raw));
  if (key.endsWith('.*')) {
    const label = key.slice(0, -2);
    if (!label || label.includes('.') || label.includes('*')) return { kind: 'dead', key };
    return { kind: 'broad', key, entity: true };
  }
  if (!host.isValidMatchPatternHost(key)) return { kind: 'dead', key };
  if (host.isIPv4Host(key)) return { kind: 'concrete', key };
  if (host.isPublicSuffixHost(key)) return { kind: 'broad', key, entity: false };
  return { kind: 'concrete', key };
}

/** The one match pattern that covers a concrete key and its subdomains (`*.` also matches the bare host). */
export function shardMatchPattern(key, host) {
  return host.isIPv4Host(key) ? `*://${key}/*` : `*://*.${key}/*`;
}

/** Is `key` equal to, or a subdomain of, the public-suffix key `suffix`? */
function under(key, suffix) {
  return key === suffix || key.endsWith(`.${suffix}`);
}

function newFile() {
  return { args: [], argIndex: new Map(), hosts: new Map(), exceptions: [], ruleKeys: new Set() };
}

function argIdx(file, name, args) {
  const tuple = [name, ...args];
  const k = JSON.stringify(tuple);
  let i = file.argIndex.get(k);
  if (i === undefined) {
    i = file.args.length;
    file.args.push(tuple);
    file.argIndex.set(k, i);
  }
  return i;
}

/** JSON as the body of a single-quoted JS string, ASCII only (Chrome insists content scripts are UTF-8). */
function jsString(json) {
  return (
    "'" +
    json
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) +
    "'"
  );
}

function payloadOf(file) {
  const h = {};
  for (const [key, entries] of [...file.hosts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    h[key] = entries;
  }
  return JSON.stringify({ a: file.args, h, x: file.exceptions });
}

/**
 * Hand-off shared by every data file and the runtime (src/content/scriptlets-runtime.ts). All
 * files of one injection run back to back before any page script, and the runtime deletes the
 * property; the name only has to be unguessable for the executeScript fallback, where page code
 * may already have run, so it is derived from the data (stable across identical builds).
 */
function pushScript(key, data) {
  return (
    '(function(n,d){var g=globalThis,q=Object.prototype.hasOwnProperty.call(g,n)?g[n]:void 0;' +
    'if(q===void 0){if(n in g)return;q=g[n]=[]}if(Array.isArray(q))q.push(d)})' +
    `(${JSON.stringify(key)},${data});\n`
  );
}

/**
 * @param {Record<string, {scriptlets: object[], exceptions: object[]}>} byList per-list rules
 * @param {string[]} listOrder list ids in registry order (the order files are registered in)
 * @param {object} host src/shared/hostname.ts
 * @param {{ buckets?: number, key?: string }} [opts] `key` overrides the hand-off name (tests)
 * @returns {{ index: object, runtimeKey: object, files: {path: string, content: string}[], stats: object }}
 */
export function buildScriptletShards(byList, listOrder, host, opts = {}) {
  const buckets = opts.buckets ?? SHARD_BUCKETS;
  const isPs = (h) => host.isPublicSuffixHost(h);
  const stats = { rules: 0, concreteKeys: 0, broadKeys: 0, deadKeys: 0, droppedRules: 0, coveredKeys: 0 };
  const perList = {};

  for (const id of listOrder) {
    const data = byList[id];
    if (!data) continue;
    const shard = new Map(); // bucket -> file
    const broad = newFile();
    const fileFor = (b) => {
      let f = shard.get(b);
      if (!f) shard.set(b, (f = newFile()));
      return f;
    };

    // Pass 1: where each rule's keys go. A broad key with no `~domain` exclusions applies to
    // every host under it, which pass 2 needs to know.
    const planned = [];
    const unconditional = new Map(); // broad key -> tuple keys
    for (const rule of data.scriptlets) {
      const classified = rule.domains.include.map((d) => classifyKey(d, host));
      const concrete = new Set();
      const broadKeys = new Set();
      for (const c of classified) {
        if (c.kind === 'dead') stats.deadKeys++;
        else (c.kind === 'broad' ? broadKeys : concrete).add(c.key);
      }
      if (!concrete.size && !broadKeys.size) {
        stats.droppedRules++;
        continue;
      }
      const tuple = JSON.stringify([rule.name, ...rule.args]);
      planned.push({ rule, tuple, concrete, broadKeys });
      if (rule.domains.exclude.length) continue;
      for (const key of broadKeys) {
        if (!unconditional.has(key)) unconditional.set(key, new Set());
        unconditional.get(key).add(tuple);
      }
    }
    const suffixKeys = [...unconditional.keys()].filter((k) => !k.endsWith('.*'));

    // Pass 2. A host key that a broad key of the same list already covers with the same
    // scriptlet (`site.org` next to `site.*`) is left out of its bucket: the broad registration
    // serves every host under it, and a bucket copy would run the scriptlet twice on the page.
    for (const { rule, tuple, concrete, broadKeys } of planned) {
      const exclude = rule.domains.exclude;
      stats.rules++;
      const add = (file, key) => {
        const i = argIdx(file, rule.name, rule.args);
        const entry = exclude.length ? [i, ...exclude] : i;
        let list = file.hosts.get(key);
        if (!list) file.hosts.set(key, (list = []));
        if (!list.some((e) => JSON.stringify(e) === JSON.stringify(entry))) list.push(entry);
        file.ruleKeys.add(key);
      };
      const ownBroad = [...broadKeys];
      for (const key of concrete) {
        const covering = [...host.entityDomainKeys(key), ...suffixKeys.filter((sk) => under(key, sk))];
        const coveredByThisRule = covering.some((k) => broadKeys.has(k)) || ownBroad.some((k) => under(key, k));
        if (coveredByThisRule || covering.some((k) => unconditional.get(k)?.has(tuple))) {
          stats.coveredKeys++;
          continue;
        }
        stats.concreteKeys++;
        add(fileFor(bucketOf(key, isPs, buckets)), key);
      }
      for (const key of broadKeys) {
        stats.broadKeys++;
        add(broad, key);
      }
    }

    // Exceptions keep their full domain spec and are tested at runtime, like matchScriptlets.
    for (const ex of data.exceptions) {
      const classified = ex.domains.include.map((d) => classifyKey(d, host));
      const live = classified.filter((c) => c.kind !== 'dead');
      if (!live.length) continue;
      const targets = new Set();
      if (live.some((c) => c.kind === 'broad')) {
        for (let b = 0; b < buckets; b++) targets.add(fileFor(b));
      } else {
        for (const c of live) targets.add(fileFor(bucketOf(c.key, isPs, buckets)));
      }
      // Broad rules can apply anywhere, so every exception rides along with them.
      targets.add(broad);
      for (const file of targets) {
        const entry = [ex.domains.include, ex.domains.exclude, argIdx(file, ex.name, ex.args)];
        file.exceptions.push(entry);
        for (const c of live) file.ruleKeys.add(c.key);
      }
    }

    perList[id] = { shard, broad };
  }

  // The runtime key and file names come from the content, so identical inputs give identical
  // bytes and any change gives new paths (the service worker compares registrations by path).
  const payloads = [];
  for (const id of Object.keys(perList)) {
    const { shard, broad } = perList[id];
    for (const b of [...shard.keys()].sort((x, y) => x - y)) payloads.push([id, b, payloadOf(shard.get(b))]);
    if (broad.hosts.size || broad.exceptions.length) payloads.push([id, 'broad', payloadOf(broad)]);
  }
  const digest = createHash('sha256');
  for (const [id, b, p] of payloads) digest.update(`${id}\0${b}\0${p}\0`);
  const version = digest.digest('hex').slice(0, 12);
  const runtimeKey = opts.key ?? `__ss${version}`;

  const files = [];
  const index = { version, key: runtimeKey, buckets, fallback: `${SHARD_DIR}/fallback.${version}.js`, lists: {} };
  for (const [id, b, payload] of payloads) {
    const entry = (index.lists[id] ||= { buckets: {}, broad: null });
    const { shard, broad } = perList[id];
    if (b === 'broad') {
      const keys = [...broad.ruleKeys].sort();
      const path = `${SHARD_DIR}/${id}.broad.${version}.js`;
      // `k` lets the runtime skip JSON.parse on the (nearly every) page no broad key can match.
      const data = `{l:${JSON.stringify(id)},k:${JSON.stringify(`|${keys.join('|')}|`)},p:${jsString(payload)}}`;
      files.push({ path, content: pushScript(runtimeKey, data) });
      entry.broad = { file: path, rules: broad.hosts.size > 0, keys: [...broad.hosts.keys()].sort().join('|') };
    } else {
      const f = shard.get(b);
      const path = `${SHARD_DIR}/${id}.${b}.${version}.js`;
      const data = `{l:${JSON.stringify(id)},p:${jsString(payload)}}`;
      files.push({ path, content: pushScript(runtimeKey, data) });
      // Rule keys only: an exception-only file rides along but must not widen `matches`.
      entry.buckets[b] = { file: path, keys: [...f.hosts.keys()].sort().join('|') };
    }
  }
  // Marks an executeScript fallback injection: the service worker has already decided this
  // frame gets these rules, so the runtime must not re-apply the registered path's frame check.
  files.push({ path: index.fallback, content: pushScript(runtimeKey, '{fallback:1}') });

  return { index, runtimeKey: { key: runtimeKey, version }, files, stats };
}
