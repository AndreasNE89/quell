// Compile filter lists → declarativeNetRequest rulesets + cosmetic/scriptlet data.
//
// Inputs:  filters/lists.json  (list registry) + the referenced .txt files
// Outputs: src/generated/rulesets/<id>.json   one DNR ruleset per list
//          src/generated/cosmetic.json         per-list element-hiding + network cosmetic exceptions
//          src/generated/scriptlets.json        per-list scriptlet rules (tests and tooling)
//          src/generated/scriptlets/*.js        the same rules as MAIN-world files keyed by host
//          src/generated/scriptlet-shards.json  host index the service worker registers them from
//          src/generated/generic-cosmetic/<id>.css
//          src/generated/meta.json              list metadata for runtime + manifest
//
// Run via `npm run compile-filters`. Prints a coverage report so we can see what
// fraction of each list converted to DNR vs. what MV3 can't express.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLine, cosmeticExceptionScope, preprocessFilterText } from './lib/parse-filter.mjs';
import {
  toDnrRule,
  ruleKey,
  networkFilterIdentity,
  hasMeaningfulDomainScope,
  isUniversallyMatchingUrlFilter,
  isUniversallyMatchingRegexFilter,
  regexFilterHasLiteralScope,
} from './lib/to-dnr.mjs';
import { DNR } from './lib/limits.mjs';
import { scriptletLooksObfuscated, scriptletUnsupported } from './lib/scriptlet-safe.mjs';
import { trackerDomainMap } from './lib/trackers.mjs';
import { readLock } from './lib/list-lock.mjs';
import { buildScriptletShards, SHARD_DIR } from './lib/scriptlet-shards.mjs';
import { build as esbuild } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FILTERS_DIR = join(ROOT, 'filters');
const OUT_DIR = join(ROOT, 'src', 'generated');
const RULESET_DIR = join(OUT_DIR, 'rulesets');
const GENERIC_CSS_DIR = join(OUT_DIR, 'generic-cosmetic');
const SHARD_OUT_DIR = join(OUT_DIR, SHARD_DIR.slice('generated/'.length));

function loadRegistry() {
  const p = join(FILTERS_DIR, 'lists.json');
  if (!existsSync(p)) {
    console.error(`No filter registry at ${p}. Nothing to compile.`);
    return { lists: [] };
  }
  const registry = JSON.parse(readFileSync(p, 'utf8'));
  // UTF-8 read back as cp1252 leaves "â€”" (U+00E2 U+20AC …) where a dash or quote belongs.
  // These titles are the visible labels in Options, so a mojibake round-trip ships garbage to
  // users; catch it here rather than in a screenshot.
  for (const l of registry.lists || []) {
    if (/â€|Ã©|�/.test(l.title || '')) {
      console.error(
        `  ✗ list "${l.id}" title is mis-encoded: ${JSON.stringify(l.title)}\n` +
          '    filters/lists.json must be saved as UTF-8.',
      );
      process.exit(1);
    }
  }
  return registry;
}

function emptyCosmeticBucket() {
  return {
    hideGeneric: new Set(),
    unhideGeneric: new Set(),
    hideSpecific: {},
    unhideSpecific: {},
    procedural: [],
    scriptlets: [],
    scriptletExceptions: [],
  };
}

/**
 * `!#include` target → its text, or null. uBO resolves includes against the including list's
 * URL; update-lists does not fetch sub-lists, so only a plain file name already committed under
 * filters/ is used. Nothing is downloaded here, and no path can leave filters/.
 */
function resolveListInclude(name) {
  if (!/^[\w.-]+\.txt$/i.test(name)) return null;
  const p = join(FILTERS_DIR, name);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/** A list's lines after `!#if` / `!#include` preprocessing (see preprocessFilterText). */
function preprocessList(text) {
  return preprocessFilterText(text, { resolveInclude: resolveListInclude });
}

/** Reject selectors that could break out of a CSS rule (e.g. `a{}body{display:none}`). */
function isSafeSelector(sel) {
  if (!sel || typeof sel !== 'string') return false;
  if (/[{}]/.test(sel)) return false;
  if (sel.length > 2048) return false;
  return true;
}

/** Compile one list's lines into DNR rules + cosmetic/scriptlet contributions. */
function compileList(list, text, ctx) {
  const dnrRules = [];
  // Dedup is PER-LIST, not global: each list becomes an independently enable-able
  // static ruleset, so a rule shared by two lists must exist in both — otherwise
  // disabling one list would drop a rule the other still needs.
  const seen = new Set();
  const stats = { network: 0, converted: 0, deduped: 0, regexUsed: 0, cosmetic: 0, scriptlet: 0 };
  const skips = ctx.skips;
  const cos = ctx.byList[list.id];
  const { lines, stats: preprocessed } = preprocessList(text);
  ctx.preprocessor[list.id] = preprocessed;

  let nextId = 1;
  for (const raw of lines) {
    const parsed = parseLine(raw);
    if (!parsed) continue;

    if (parsed.type === 'cosmetic') {
      applyCosmetic(parsed, cos, stats, skips);
      continue;
    }

    // network
    stats.network++;
    const out = toDnrRule(parsed);
    // $badfilter before cosmetic exceptions: `@@||x^$ehide,badfilter` must cancel the
    // exception, never become one — and a cancelled `@@||x^$ehide` must not apply either.
    if (out.badfilter) {
      skips['badfilter'] = (skips['badfilter'] || 0) + 1;
      continue;
    }
    if (ctx.badfilters.has(networkFilterIdentity(parsed))) {
      skips['badfilter-cancelled'] = (skips['badfilter-cancelled'] || 0) + 1;
      continue;
    }
    if (out.cosmeticException) {
      applyNetworkCosmeticException(out, parsed, ctx.networkCosmeticExceptions, list.id);
      continue;
    }
    if (out.skip) {
      skips[out.skip] = (skips[out.skip] || 0) + 1;
      continue;
    }
    // One filter can need two DNR rules (a top-level-document part and a subresource part;
    // see splitDocumentContext in to-dnr.mjs). A part that was dropped counts as a skip.
    if (out.partialSkip) skips[out.partialSkip] = (skips[out.partialSkip] || 0) + 1;

    for (const rule of out.rules ?? [out.rule]) {
      // Dedup within this list first — so budgets are only spent on rules we emit.
      const key = ruleKey(rule);
      if (seen.has(key)) {
        stats.deduped++;
        continue;
      }

      // Per-list static-rule budget (cap in-loop so regex counting matches what ships).
      if (dnrRules.length >= DNR.MAX_STATIC_RULES_PER_LIST) {
        skips['static-budget'] = (skips['static-budget'] || 0) + 1;
        continue;
      }

      // Global regex-rule budget (shared across all enabled rulesets).
      if (rule.condition.regexFilter) {
        if (ctx.regexCount >= DNR.MAX_NUMBER_OF_REGEX_RULES) {
          skips['regex-budget'] = (skips['regex-budget'] || 0) + 1;
          continue;
        }
        ctx.regexCount++;
        stats.regexUsed++;
      }

      seen.add(key);
      rule.id = nextId++;
      dnrRules.push(rule);
      stats.converted++;
    }
  }

  return { dnrRules, stats };
}

/**
 * `bag` is ctx.networkCosmeticExceptions; its `skips` is ctx.skips, so a dropped exception is
 * counted in the coverage report without widening this function's call site.
 */
function applyNetworkCosmeticException(out, parsed, bag, listId) {
  if (!parsed.isException) return; // only @@…$generichide etc.
  const kind = out.cosmeticException;
  const byList = bag[kind];
  if (!byList) return;
  const count = (reason) => {
    if (bag.skips) bag.skips[reason] = (bag.skips[reason] || 0) + 1;
  };
  // Runtime keys these exceptions by page host, plus a path for the ones EasyList limits to a
  // page (the Google, Bing, DuckDuckGo and Yandex results pages). A pattern it can't express
  // (a regex, a `^` in the path, `192.168.*.1`, `://10.0.0.`) is dropped whole — including its
  // $domain hosts, which would otherwise widen it to every page on those sites.
  const scope = cosmeticExceptionScope(parsed.pattern, parsed.isRegex);
  if (scope.skip) {
    count(`cosmetic-exception-${scope.skip}`);
    return;
  }
  if (scope.path !== null) {
    // `domain=` on a page-scoped exception narrows it further; never widen it to those hosts.
    const o = parsed.options || {};
    if (o.initiatorDomains?.length || o.requestDomains?.length) {
      count('cosmetic-exception-path-scoped');
      return;
    }
    const set = (bag.pathScoped[kind][listId] ||= new Set());
    for (const h of scope.hosts) set.add(`${h}${scope.path}`);
    return;
  }
  // Page hosts for cosmetic exceptions come from the URL pattern, $domain/$from,
  // and $to (destination) — e.g. @@||asd.$generichide,to=asd.homes|asd.ink.
  const hosts = [
    ...scope.hosts,
    ...(parsed.options?.initiatorDomains || []),
    ...(parsed.options?.requestDomains || []),
  ];
  const set = (byList[listId] ||= new Set());
  for (const h of hosts) if (h) set.add(h);
}

function serializeExceptionBag(byList) {
  const out = {};
  for (const [id, set] of Object.entries(byList)) out[id] = [...set];
  return out;
}

function exceptionHostCount(byList) {
  let n = 0;
  for (const set of Object.values(byList)) n += set.size;
  return n;
}

function applyCosmetic(c, cos, stats, skips) {
  if (c.kind === 'scriptlet') {
    // Scriptlets must be domain-scoped (injecting into every page is unsafe).
    if (!c.domains.include.length) return;
    // CWS rejects `atob("…")` / long base64 in the package as "obfuscated code".
    if (scriptletLooksObfuscated(c.scriptlet)) {
      skips['scriptlet-obfuscated'] = (skips['scriptlet-obfuscated'] || 0) + 1;
      return;
    }
    // No handler for this name — the rule would be bundled, shipped, injected and then
    // dropped by runScriptlet. Exceptions are kept regardless: an exception for an
    // unimplemented scriptlet is already a no-op, but keeping them costs nothing and avoids
    // an exception silently disappearing if the scriptlet is implemented later.
    if (!c.isException && scriptletUnsupported(c.scriptlet.name)) {
      skips[`scriptlet-unimplemented:${c.scriptlet.name}`] =
        (skips[`scriptlet-unimplemented:${c.scriptlet.name}`] || 0) + 1;
      return;
    }
    if (c.isException) {
      cos.scriptletExceptions.push({
        domains: c.domains,
        name: c.scriptlet.name,
        args: c.scriptlet.args,
      });
      stats.scriptlet++;
      return;
    }
    cos.scriptlets.push({
      domains: c.domains,
      name: c.scriptlet.name,
      args: c.scriptlet.args,
    });
    stats.scriptlet++;
    return;
  }
  if (c.kind === 'ignored') {
    if (c.unsupported) {
      const reason = `cosmetic-unsupported:${c.unsupported}`;
      skips[reason] = (skips[reason] || 0) + 1;
    }
    return;
  }

  if (c.kind === 'procedural') {
    if (!c.domains.include.length) return; // procedural generics are too risky/slow
    cos.procedural.push({ domains: c.domains, expr: c.selector });
    stats.cosmetic++;
    return;
  }

  const isUnhide = c.kind === 'unhide';
  const selector = c.selector;
  if (!selector || !isSafeSelector(selector)) return;

  const { include, exclude } = c.domains;
  if (include.length) {
    // Domain-scoped rule: hide/unhide on named domains, honoring ~excludes.
    const target = isUnhide ? cos.unhideSpecific : cos.hideSpecific;
    for (const d of include) {
      if (exclude.some((ex) => d === ex || d.endsWith('.' + ex))) continue;
      (target[d] ||= new Set()).add(selector);
    }
    // Explicit excludes under an include parent: cancel via the opposite map so
    // suffix matching on the parent cannot re-apply the selector.
    if (exclude.length) {
      const cancel = isUnhide ? cos.hideSpecific : cos.unhideSpecific;
      for (const ex of exclude) (cancel[ex] ||= new Set()).add(selector);
    }
  } else if (exclude.length) {
    // Domain-excluded generic (`~a.com##.ad`): generic everywhere, except the excluded
    // domains, which we express as per-domain unhide exceptions.
    (isUnhide ? cos.unhideGeneric : cos.hideGeneric).add(selector);
    const excTarget = isUnhide ? cos.hideSpecific : cos.unhideSpecific;
    for (const ex of exclude) (excTarget[ex] ||= new Set()).add(selector);
  } else {
    // Pure generic (applies everywhere).
    (isUnhide ? cos.unhideGeneric : cos.hideGeneric).add(selector);
  }
  stats.cosmetic++;
}

function setMapToObj(m) {
  const o = {};
  for (const [k, v] of Object.entries(m)) o[k] = [...v];
  return o;
}

function serializeBucket(cos) {
  return {
    hideGeneric: [...cos.hideGeneric],
    unhideGeneric: [...cos.unhideGeneric],
    hideSpecific: setMapToObj(cos.hideSpecific),
    unhideSpecific: setMapToObj(cos.unhideSpecific),
    procedural: cos.procedural,
  };
}

function writeGenericCss(listId, bucket) {
  const generic = bucket.hideGeneric.filter((s) => !bucket.unhideGeneric.includes(s) && isSafeSelector(s));
  const CHUNK = 500;
  let css = `/* StampStack generic element-hiding for list "${listId}" — generated, do not edit. */\n`;
  for (let i = 0; i < generic.length; i += CHUNK) {
    const group = generic.slice(i, i + CHUNK).join(',\n');
    if (group) css += `${group} { display: none !important; }\n`;
  }
  writeFileSync(join(GENERIC_CSS_DIR, `${listId}.css`), css);
  return generic.length;
}

/**
 * Build-time backstop against a globally-unblocking exception.
 *
 * The `@@` guards in to-dnr.mjs have been patched seven times as upstream lists invented new
 * ways to spell "match everything" (PRs #17→#28). Each patch was a heuristic, so each could be
 * out-argued by the next list update. This checks the *emitted rules* instead: every allow /
 * allowAllRequests must carry real scope, or the build fails loudly rather than shipping a
 * ruleset that switches blocking off. `npm test` staying green is not enough — the lists change
 * underneath the tests.
 */
function assertNoGlobalAllow(listId, rules) {
  const bad = [];
  for (const r of rules) {
    const type = r.action?.type;
    if (type !== 'allow' && type !== 'allowAllRequests') continue;
    const c = r.condition || {};
    const domainScoped = hasMeaningfulDomainScope(c.initiatorDomains, c.requestDomains);
    const urlScoped = !!(c.urlFilter && !isUniversallyMatchingUrlFilter(c.urlFilter));
    const regexScoped = !!(
      c.regexFilter &&
      !isUniversallyMatchingRegexFilter(c.regexFilter) &&
      regexFilterHasLiteralScope(c.regexFilter)
    );
    if (domainScoped || urlScoped || regexScoped) continue;
    // Deliberate exception: a type-only plain allow for a narrow resource type (EasyPrivacy
    // ships `@@$ping`). Frame types are never allowed to reach here — those disable blocking
    // for the whole document.
    const types = c.resourceTypes || [];
    if (
      type === 'allow' &&
      !c.urlFilter &&
      !c.regexFilter &&
      types.length > 0 &&
      !types.includes('main_frame') &&
      !types.includes('sub_frame')
    ) {
      continue;
    }
    bad.push(r);
  }
  if (!bad.length) return;
  console.error(
    `\n  ✗ list "${listId}" emitted ${bad.length} unscoped allow rule(s) — each would disable blocking globally:`,
  );
  for (const r of bad.slice(0, 5)) console.error(`      ${JSON.stringify(r)}`);
  console.error(
    '    Tighten the exception guards in scripts/lib/to-dnr.mjs. Refusing to write this ruleset.',
  );
  process.exit(1);
}

/**
 * Build the page-report tracker index: curated domain → { label, blocked }.
 *
 * `blocked` is decided by looking for a real domain-anchored block rule in the emitted
 * rulesets, so the popup can say "StampStack blocks these" without that being a guess. A
 * curated domain with no matching rule still ships (naming it is useful) but is reported as
 * seen-not-blocked, which is also a signal that a list has drifted.
 */
function buildTrackerIndex(rulesetsByList) {
  const blockedHosts = new Set();
  for (const rules of Object.values(rulesetsByList)) {
    for (const r of rules) {
      if (r.action?.type !== 'block') continue;
      const uf = r.condition?.urlFilter;
      if (!uf) continue;
      const m = /^\|\|([a-z0-9.-]+)\^?/i.exec(uf);
      if (m) blockedHosts.add(m[1].toLowerCase().replace(/\.$/, ''));
    }
  }
  /** A curated domain counts as blocked if it, or any subdomain of it, has a rule. */
  const hasRule = (domain) => {
    if (blockedHosts.has(domain)) return true;
    for (const h of blockedHosts) if (h.endsWith(`.${domain}`)) return true;
    return false;
  };

  const domains = {};
  let covered = 0;
  for (const [domain, label] of Object.entries(trackerDomainMap())) {
    const blocked = hasRule(domain);
    if (blocked) covered++;
    domains[domain] = { label, blocked };
  }
  const total = Object.keys(domains).length;
  console.log(`  tracker index: ${total} named domains, ${covered} with a shipped block rule`);
  return { domains };
}

/**
 * When the filter lists were last refreshed, as an ISO string (null if there are none).
 *
 * This ends up embedded in meta.json and therefore in the shipped bundle, so it has to be a
 * function of the committed sources — not of the machine doing the build. mtimes are not:
 * git does not preserve them, so a fresh clone stamps checkout time and the "reproducible
 * from the tag" claim quietly stops being true.
 *
 * filters/lists.lock.json records the fetch time and is committed, so prefer it. The mtime
 * scan stays as a fallback for a working copy that has not been stamped yet.
 */
function listsRefreshedAt() {
  let lock;
  try {
    lock = readLock(FILTERS_DIR);
  } catch (e) {
    if (e?.code === 'LOCK_CORRUPT') {
      // Fail rather than fall through to the mtime scan below: mtimes do not survive a clone,
      // and silently using them is the non-reproducible build the lock exists to prevent.
      throw new Error(
        'filters/lists.lock.json is not valid JSON.\n' +
          '  Rewrite it from the lists on disk: npm run lock-lists',
      );
    }
    throw e;
  }
  if (lock?.updated) return lock.updated;

  let newest = 0;
  for (const name of readdirSync(FILTERS_DIR)) {
    if (!name.endsWith('.txt')) continue;
    const t = statSync(join(FILTERS_DIR, name)).mtimeMs;
    if (t > newest) newest = t;
  }
  // Second resolution: filesystems disagree on sub-second mtime, and it would be the only
  // thing left making two builds of the same sources differ.
  return newest ? new Date(Math.floor(newest / 1000) * 1000).toISOString() : null;
}

/**
 * src/shared/hostname.ts, bundled on the fly. The scriptlet shards must key hosts exactly the way
 * the runtime matches them, and a hand-kept .mjs copy would drift.
 */
async function loadHostnameHelpers() {
  const out = await esbuild({
    entryPoints: [join(ROOT, 'src', 'shared', 'hostname.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
  });
  const code = out.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

/**
 * List scriptlets as MAIN-world files keyed by host (scripts/lib/scriptlet-shards.mjs), plus
 * the index the service worker registers them from and the hand-off key the runtime reads.
 */
function writeScriptletShards(byList, listOrder, host) {
  const { index, runtimeKey, files, stats } = buildScriptletShards(byList, listOrder, host);
  if (existsSync(SHARD_OUT_DIR)) rmSync(SHARD_OUT_DIR, { recursive: true });
  mkdirSync(SHARD_OUT_DIR, { recursive: true });
  for (const f of files) writeFileSync(join(OUT_DIR, f.path.slice('generated/'.length)), f.content);
  writeFileSync(join(OUT_DIR, 'scriptlet-shards.json'), JSON.stringify(index));
  writeFileSync(join(OUT_DIR, 'scriptlet-runtime.json'), JSON.stringify(runtimeKey));
  const kb = Math.round(files.reduce((n, f) => n + f.content.length, 0) / 1024);
  console.log(
    `  scriptlet shards:   ${files.length} files, ${kb} KB, ${stats.rules} rules ` +
      `(host keys ${stats.concreteKeys}, broad ${stats.broadKeys}, unmatchable dropped ${stats.deadKeys})`,
  );
}

async function main() {
  const registry = loadRegistry();

  // Fresh output dirs.
  if (existsSync(RULESET_DIR)) {
    for (const f of readdirSync(RULESET_DIR)) rmSync(join(RULESET_DIR, f));
  }
  if (existsSync(GENERIC_CSS_DIR)) {
    for (const f of readdirSync(GENERIC_CSS_DIR)) rmSync(join(GENERIC_CSS_DIR, f));
  }
  mkdirSync(RULESET_DIR, { recursive: true });
  mkdirSync(GENERIC_CSS_DIR, { recursive: true });

  const skips = {};
  const ctx = {
    regexCount: 0,
    skips,
    byList: {},
    /** @type {Record<string, ReturnType<typeof preprocessFilterText>['stats']>} */
    preprocessor: {},
    /** @type {Set<string>} identities cancelled by $badfilter across all lists */
    badfilters: new Set(),
    networkCosmeticExceptions: {
      // Per-list host sets. A disabled list must not keep its @@$generichide active.
      generichide: {},
      elemhide: {},
      specifichide: {},
      // Per-list `host/path-glob` entries for exceptions limited to one page of a site.
      pathScoped: { generichide: {}, elemhide: {}, specifichide: {} },
      // Not serialized: where applyNetworkCosmeticException counts exceptions it drops.
      skips,
    },
  };

  const metaLists = [];
  // Kept so the tracker index can be cross-checked against what actually shipped, rather
  // than against what the curated list claims.
  const emittedRulesets = {};
  let totalEnabledRules = 0;

  // Collect $badfilter identities from every compiled list before emit so later
  // lists can cancel earlier ones (and vice versa).
  //
  // Policy: $badfilter is compile-time global. Static DNR rulesets cannot drop a
  // matching rule in another list when the user toggles the badfilter's list off,
  // so a $badfilter in any shipped list cancels the matching identity everywhere.
  // Cosmetic @@$generichide / $elemhide / $specifichide are the opposite: they are
  // stored per list and merged only for enabled lists at runtime.
  //
  // The pre-scan reads the same preprocessed lines as compileList: a $badfilter inside an
  // inactive `!#if` branch must not cancel a rule that ships.
  for (const list of registry.lists) {
    const file = join(FILTERS_DIR, list.file);
    if (!existsSync(file)) continue;
    for (const raw of preprocessList(readFileSync(file, 'utf8')).lines) {
      const parsed = parseLine(raw);
      if (!parsed || parsed.type !== 'network' || !parsed.options?.badfilter) continue;
      ctx.badfilters.add(networkFilterIdentity(parsed));
    }
  }

  for (const list of registry.lists) {
    const file = join(FILTERS_DIR, list.file);
    if (!existsSync(file)) {
      console.warn(`  ! skipping "${list.id}" — file not found: ${list.file}`);
      continue;
    }
    ctx.byList[list.id] = emptyCosmeticBucket();
    const text = readFileSync(file, 'utf8');
    const { dnrRules, stats } = compileList(list, text, ctx);

    // Bound a single ruleset file so it can't dominate the global pool by itself.
    if (dnrRules.length > DNR.MAX_STATIC_RULES_PER_LIST) {
      console.warn(
        `  ! list "${list.id}" produced ${dnrRules.length} rules (> per-list max ${DNR.MAX_STATIC_RULES_PER_LIST}); truncating.`,
      );
      dnrRules.length = DNR.MAX_STATIC_RULES_PER_LIST;
    }

    assertNoGlobalAllow(list.id, dnrRules);
    emittedRulesets[list.id] = dnrRules;

    const rulesetPath = join(RULESET_DIR, `${list.id}.json`);
    writeFileSync(rulesetPath, JSON.stringify(dnrRules));

    const enabled = list.enabledByDefault !== false;
    if (enabled) totalEnabledRules += dnrRules.length;

    const bucket = serializeBucket(ctx.byList[list.id]);
    const genericCount = writeGenericCss(list.id, bucket);

    metaLists.push({
      id: list.id,
      title: list.title,
      group: list.group || 'ads',
      enabledByDefault: enabled,
      ruleCount: dnrRules.length,
      rulesetFile: `rulesets/${list.id}.json`,
      genericCssFile: `generic-cosmetic/${list.id}.css`,
      genericHideCount: genericCount,
    });

    console.log(
      `  ✓ ${list.id.padEnd(22)} net:${stats.converted} (dedup ${stats.deduped}, regex ${stats.regexUsed}) cosmetic:${stats.cosmetic} scriptlet:${stats.scriptlet}`,
    );
  }

  // Enforce the enabled-ruleset budget.
  if (totalEnabledRules > DNR.GUARANTEED_MINIMUM_STATIC_RULES) {
    console.warn(
      `  ! default-enabled rules total ${totalEnabledRules} exceed guaranteed ${DNR.GUARANTEED_MINIMUM_STATIC_RULES}. ` +
        `Consider disabling some lists by default (relies on the shared global pool otherwise).`,
    );
  }
  if (metaLists.filter((l) => l.enabledByDefault).length > DNR.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS) {
    console.warn(`  ! more than ${DNR.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS} rulesets enabled by default.`);
  }

  // Per-list cosmetic + scriptlet outputs (runtime merges enabled lists).
  const cosmeticByList = {};
  const scriptletsByList = {};
  for (const [id, cos] of Object.entries(ctx.byList)) {
    cosmeticByList[id] = serializeBucket(cos);
    scriptletsByList[id] = {
      scriptlets: cos.scriptlets,
      exceptions: cos.scriptletExceptions,
    };
  }

  const cosmeticOut = {
    byList: cosmeticByList,
    networkExceptions: {
      generichide: serializeExceptionBag(ctx.networkCosmeticExceptions.generichide),
      elemhide: serializeExceptionBag(ctx.networkCosmeticExceptions.elemhide),
      specifichide: serializeExceptionBag(ctx.networkCosmeticExceptions.specifichide),
    },
    pathExceptions: {
      generichide: serializeExceptionBag(ctx.networkCosmeticExceptions.pathScoped.generichide),
      elemhide: serializeExceptionBag(ctx.networkCosmeticExceptions.pathScoped.elemhide),
      specifichide: serializeExceptionBag(ctx.networkCosmeticExceptions.pathScoped.specifichide),
    },
  };
  writeFileSync(join(OUT_DIR, 'cosmetic.json'), JSON.stringify(cosmeticOut));
  writeFileSync(
    join(OUT_DIR, 'trackers.json'),
    JSON.stringify(buildTrackerIndex(emittedRulesets)),
  );
  // The whole rule set, for tests and tooling. What ships is the per-host shards below.
  writeFileSync(join(OUT_DIR, 'scriptlets.json'), JSON.stringify({ byList: scriptletsByList }));
  writeScriptletShards(
    scriptletsByList,
    metaLists.map((l) => l.id),
    await loadHostnameHelpers(),
  );

  // Legacy combined sheet kept for older loaders / docs; runtime prefers per-list files.
  let combinedCss = '/* StampStack combined generic element-hiding — generated, do not edit. */\n';
  for (const list of metaLists) {
    const p = join(GENERIC_CSS_DIR, `${list.id}.css`);
    if (existsSync(p)) combinedCss += readFileSync(p, 'utf8') + '\n';
  }
  writeFileSync(join(OUT_DIR, 'generic-cosmetic.css'), combinedCss);

  writeFileSync(
    join(OUT_DIR, 'meta.json'),
    JSON.stringify(
      {
        // Derived from the newest filter list, never from the wall clock: a build timestamp
        // gets inlined into background.js and makes two builds of identical sources produce
        // different bytes, so a store zip can't be diffed or reproduced. This value is also
        // more truthful — it dates the filter data, which is what "generated" means to a user.
        generatedAt: listsRefreshedAt(),
        lists: metaLists,
        regexRulesUsed: ctx.regexCount,
      },
      null,
      2,
    ),
  );

  // Coverage report.
  const totalNet = metaLists.reduce((n, l) => n + l.ruleCount, 0);
  console.log('\nCoverage:');
  console.log(`  DNR network rules:  ${totalNet}`);
  console.log(`  regex rules used:   ${ctx.regexCount}/${DNR.MAX_NUMBER_OF_REGEX_RULES}`);
  console.log(
    `  generichide hosts:  ${exceptionHostCount(ctx.networkCosmeticExceptions.generichide)}, elemhide: ${exceptionHostCount(ctx.networkCosmeticExceptions.elemhide)}, specifichide: ${exceptionHostCount(ctx.networkCosmeticExceptions.specifichide)}`,
  );
  console.log(
    `  page-scoped:        generichide ${exceptionHostCount(ctx.networkCosmeticExceptions.pathScoped.generichide)}, elemhide: ${exceptionHostCount(ctx.networkCosmeticExceptions.pathScoped.elemhide)}, specifichide: ${exceptionHostCount(ctx.networkCosmeticExceptions.pathScoped.specifichide)}`,
  );
  const skipEntries = Object.entries(ctx.skips).sort((a, b) => b[1] - a[1]);
  if (skipEntries.length) {
    console.log('  skipped network filters (not representable in DNR):');
    for (const [reason, n] of skipEntries) console.log(`     ${String(n).padStart(6)}  ${reason}`);
  }
  reportPreprocessor(ctx.preprocessor);
}

/** Rules left out by `!#if` branches that don't apply to Chromium MV3, and unresolved includes. */
function reportPreprocessor(byList) {
  const rows = Object.entries(byList).filter(
    ([, s]) => s.droppedRules || s.unknownConditions || s.includesUnresolved.length || s.includesResolved.length,
  );
  if (!rows.length) return;
  console.log('  preprocessor (!#if / !#include):');
  for (const [id, s] of rows) {
    const byCond = Object.entries(s.droppedByCondition)
      .sort((a, b) => b[1] - a[1])
      .map(([cond, n]) => `${cond} ${n}`)
      .join(', ');
    console.log(`     ${String(s.droppedRules).padStart(6)}  ${id}: rules in inactive branches${byCond ? ` (${byCond})` : ''}`);
    if (s.unknownConditions) {
      console.log(`     ${String(s.unknownConditions).padStart(6)}  ${id}: unknown !#if conditions (both branches dropped)`);
    }
    for (const name of s.includesUnresolved) {
      console.log(`     ${'1'.padStart(6)}  ${id}: include-unresolved ${name} (not in filters/)`);
    }
    for (const name of s.includesResolved) console.log(`            ${id}: included ${name}`);
  }
}

await main();
