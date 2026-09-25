// Compile filter lists → declarativeNetRequest rulesets + cosmetic/scriptlet data.
//
// Inputs:  filters/lists.json  (list registry) + the referenced .txt files
// Outputs: src/generated/rulesets/<id>.json   one DNR ruleset per list
//          src/generated/cosmetic.json         per-list element-hiding + network cosmetic exceptions
//          src/generated/scriptlets.json        per-list scriptlet rules (tests and tooling)
//          src/generated/scriptlets/*.js        the same rules as MAIN-world files keyed by host
//          src/generated/scriptlet-shards.json  host index the service worker registers them from
//          src/generated/generic-cosmetic/*.css  generic hiding per list (+ cross-list-excepted
//                                                and revert sheets; cosmetic.json `genericCss`)
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
import { parseLine, preprocessFilterText } from './lib/parse-filter.mjs';
import {
  emptyCosmeticBucket,
  applyCosmeticRule,
  scriptletDomains,
  serializeBucket,
  planGenericCss,
  genericCssText,
  applyNetworkCosmeticException,
  isDocumentException,
  applyDocumentCosmeticException,
} from './lib/cosmetic-compile.mjs';
import {
  toDnrRule,
  ruleKey,
  networkFilterIdentity,
  hasMeaningfulDomainScope,
  isUniversallyMatchingUrlFilter,
  isUniversallyMatchingRegexFilter,
  regexFilterHasLiteralScope,
  conditionMatchesMainFrame,
  isAccidentalDocumentRule,
} from './lib/to-dnr.mjs';
import { DNR } from './lib/limits.mjs';
import { scriptletLooksObfuscated, scriptletUnsupported } from './lib/scriptlet-safe.mjs';
import { trackerDomainMap } from './lib/trackers.mjs';
import { readLock } from './lib/list-lock.mjs';
import { buildScriptletShards, planScriptletBundles, SHARD_DIR } from './lib/scriptlet-shards.mjs';
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

/** Compile one list's lines into DNR rules + cosmetic/scriptlet contributions. */
function compileList(list, text, ctx) {
  const dnrRules = [];
  // Emitted rules that can reach a top-level page, with the filter each came from, for
  // assertNoAccidentalDocumentRules. Only these few thousand keep their parsed source.
  const documentRules = [];
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
      applyNetworkCosmeticException(out.cosmeticException, parsed, ctx.networkCosmeticExceptions, list.id);
      // The network types it also lists (to-dnr.mjs toDnrRule) are an allow rule of their own.
      if (out.networkSkip) skips[out.networkSkip] = (skips[out.networkSkip] || 0) + 1;
      if (!out.rule && !out.rules) continue;
    }
    // The element-hiding half of `@@…$document`; its network half is the allowAllRequests
    // rule below.
    if (isDocumentException(parsed) && !out.skip) {
      applyDocumentCosmeticException(parsed, ctx.networkCosmeticExceptions, list.id);
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
      if (conditionMatchesMainFrame(rule.condition)) documentRules.push({ rule, filter: parsed });
      stats.converted++;
    }
  }

  return { dnrRules, documentRules, stats };
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
    // Scriptlets must be domain-scoped (injecting into every page is unsafe), and their
    // registrations can only key concrete hosts and entities (see scriptletDomains).
    const scoped = scriptletDomains(c.domains);
    if (scoped.skip) {
      skips[scoped.skip] = (skips[scoped.skip] || 0) + 1;
      return;
    }
    c = { ...c, domains: scoped.domains };
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
  applyCosmeticRule(c, cos, stats, skips);
}

/**
 * Write every list's generic stylesheets (planGenericCss) and their reverts; returns
 * cosmetic.json's `genericCss`: per list, the sheets to register while none of `unless` is
 * enabled (src/engine/cosmetic-match.ts genericCssFiles). Fills in metaLists' counts.
 */
function writeGenericCss(cosmeticByList, metaLists) {
  const plan = planGenericCss(
    cosmeticByList,
    metaLists.map((l) => l.id),
  );
  const out = {};
  let split = 0;
  for (const meta of metaLists) {
    out[meta.id] = (plan[meta.id] ?? []).map((sheet) => {
      const file = `generic-cosmetic/${sheet.name}.css`;
      const revert = `generic-cosmetic/${sheet.name}.revert.css`;
      writeFileSync(join(OUT_DIR, file), genericCssText(sheet.name, sheet.selectors));
      writeFileSync(join(OUT_DIR, revert), genericCssText(sheet.name, sheet.selectors, true));
      meta.genericHideCount += sheet.selectors.length;
      if (sheet.unless.length) split += sheet.selectors.length;
      return {
        file,
        revert,
        count: sheet.selectors.length,
        ...(sheet.unless.length ? { unless: sheet.unless } : {}),
      };
    });
  }
  console.log(
    `  generic exceptions: ${split} selectors registered only while the list excepting them is off`,
  );
  return out;
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
 * Build-time backstop against blocking whole pages by accident.
 *
 * A block or redirect rule may match `main_frame` only when its filter names the document
 * (`$doc`, `$document`, `$all`) or is a `$removeparam`; see isAccidentalDocumentRule. 2.2.2
 * shipped 141 rules that broke this: Chrome showed "This page has been blocked by an extension"
 * on any address containing `/reklame/` or `-banner-ads-`, on every `ads.*` host, and more. The
 * converter fix has tests, but like assertNoGlobalAllow this checks what is actually emitted,
 * because the lists and the parser keep changing underneath those tests.
 */
function assertNoAccidentalDocumentRules(listId, documentRules) {
  const bad = documentRules.filter(({ rule, filter }) => isAccidentalDocumentRule(rule, filter));
  if (!bad.length) return;
  console.error(
    `\n  ✗ list "${listId}" emitted ${bad.length} rule(s) that would block whole pages although their filter only targets subresources:`,
  );
  for (const { rule, filter } of bad.slice(0, 5)) {
    console.error(`      ${filter.raw}\n        → ${JSON.stringify(rule)}`);
  }
  console.error(
    '    Fix the resource-type mapping in scripts/lib/to-dnr.mjs. Refusing to write this ruleset.',
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
  // Per list: hosts it blocks outright, and hosts it blocks only on some paths or pages
  // (`||host/ads/`, or `initiatorDomains`). The worker names a tracker blocked only while one of
  // the first kind is loaded (REVIEW_2026-09-24 B39): OneTrust was "blocked" with the cookie
  // list off.
  const wholeByList = new Map();
  const partialByList = new Map();
  for (const [listId, rules] of Object.entries(rulesetsByList)) {
    const whole = new Set();
    const partial = new Set();
    for (const r of rules) {
      if (r.action?.type !== 'block') continue;
      const uf = r.condition?.urlFilter;
      if (!uf) continue;
      const m = /^\|\|([a-z0-9.-]+)(.*)$/i.exec(uf);
      if (!m) continue;
      const host = m[1].toLowerCase().replace(/\.$/, '');
      blockedHosts.add(host);
      const hostWide = /^(?:\^\*?)?$/.test(m[2]) && !r.condition.initiatorDomains?.length;
      (hostWide ? whole : partial).add(host);
    }
    wholeByList.set(listId, whole);
    partialByList.set(listId, partial);
  }
  /** `domain` or one of its subdomains is in `hosts`. */
  const covers = (hosts, domain) => {
    if (hosts.has(domain)) return true;
    for (const h of hosts) if (h.endsWith(`.${domain}`)) return true;
    return false;
  };

  const domains = {};
  let covered = 0;
  let outright = 0;
  for (const [domain, label] of Object.entries(trackerDomainMap())) {
    // The compile-time answer for every list, any rule for the domain: kept for a worker that
    // reads an index without `lists`.
    const blocked = covers(blockedHosts, domain);
    const lists = [...wholeByList].filter(([, hosts]) => covers(hosts, domain)).map(([id]) => id);
    const partial = [...partialByList]
      .filter(([id, hosts]) => !lists.includes(id) && covers(hosts, domain))
      .map(([id]) => id);
    if (blocked) covered++;
    if (lists.length) outright++;
    domains[domain] = { label, blocked, lists, ...(partial.length ? { partial } : {}) };
  }
  const total = Object.keys(domains).length;
  console.log(
    `  tracker index: ${total} named domains, ${covered} with a shipped block rule (${outright} blocked outright)`,
  );
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
 * A runtime module (src/shared/hostname.ts, src/engine/scriptlet-shards.ts), bundled on the fly.
 * The scriptlet shards must key hosts exactly the way the runtime matches them, and bundles must
 * hold exactly what the service worker would register; a hand-kept .mjs copy would drift.
 */
async function loadRuntimeModule(...path) {
  const out = await esbuild({
    entryPoints: [join(ROOT, 'src', ...path)],
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
 * The index also names one bundle per registration of the default lists; scripts/build.mjs
 * writes their bytes, because they end with the built runtime.
 */
function writeScriptletShards(byList, listOrder, defaultIds, host, engine) {
  const { index, runtimeKey, files, stats } = buildScriptletShards(byList, listOrder, host);
  index.bundles = planScriptletBundles(
    engine.shardRegistrations(index, defaultIds),
    engine.SCRIPTLET_SHARD_ID_PREFIX,
  );
  if (existsSync(SHARD_OUT_DIR)) rmSync(SHARD_OUT_DIR, { recursive: true });
  mkdirSync(SHARD_OUT_DIR, { recursive: true });
  for (const f of files) writeFileSync(join(OUT_DIR, f.path.slice('generated/'.length)), f.content);
  writeFileSync(join(OUT_DIR, 'scriptlet-shards.json'), JSON.stringify(index));
  writeFileSync(join(OUT_DIR, 'scriptlet-runtime.json'), JSON.stringify(runtimeKey));
  const kb = Math.round(files.reduce((n, f) => n + f.content.length, 0) / 1024);
  console.log(
    `  scriptlet shards:   ${files.length} files, ${kb} KB, ${stats.rules} rules ` +
      `(host keys ${stats.concreteKeys}, broad ${stats.broadKeys}, unmatchable dropped ${stats.deadKeys}); ` +
      `${Object.keys(index.bundles).length} default-list bundles for the build to join`,
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
    const { dnrRules, documentRules, stats } = compileList(list, text, ctx);

    // Bound a single ruleset file so it can't dominate the global pool by itself.
    if (dnrRules.length > DNR.MAX_STATIC_RULES_PER_LIST) {
      console.warn(
        `  ! list "${list.id}" produced ${dnrRules.length} rules (> per-list max ${DNR.MAX_STATIC_RULES_PER_LIST}); truncating.`,
      );
      dnrRules.length = DNR.MAX_STATIC_RULES_PER_LIST;
    }

    assertNoGlobalAllow(list.id, dnrRules);
    assertNoAccidentalDocumentRules(list.id, documentRules);
    emittedRulesets[list.id] = dnrRules;

    const rulesetPath = join(RULESET_DIR, `${list.id}.json`);
    writeFileSync(rulesetPath, JSON.stringify(dnrRules));

    const enabled = list.enabledByDefault !== false;
    if (enabled) totalEnabledRules += dnrRules.length;

    metaLists.push({
      id: list.id,
      title: list.title,
      group: list.group || 'ads',
      enabledByDefault: enabled,
      ruleCount: dnrRules.length,
      rulesetFile: `rulesets/${list.id}.json`,
      genericCssFile: `generic-cosmetic/${list.id}.css`,
      // Set once every list is compiled: another list's generic exceptions split this one's sheet.
      genericHideCount: 0,
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

  const genericCss = writeGenericCss(cosmeticByList, metaLists);

  const cosmeticOut = {
    byList: cosmeticByList,
    genericCss,
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
    metaLists.filter((l) => l.enabledByDefault).map((l) => l.id),
    await loadRuntimeModule('shared', 'hostname.ts'),
    await loadRuntimeModule('engine', 'scriptlet-shards.ts'),
  );

  // The combined sheet older builds wrote was never registered or shipped (build.mjs skips it).
  rmSync(join(OUT_DIR, 'generic-cosmetic.css'), { force: true });

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
