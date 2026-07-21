// Compile filter lists → declarativeNetRequest rulesets + cosmetic/scriptlet data.
//
// Inputs:  filters/lists.json  (list registry) + the referenced .txt files
// Outputs: src/generated/rulesets/<id>.json   one DNR ruleset per list
//          src/generated/cosmetic.json         per-list element-hiding + network cosmetic exceptions
//          src/generated/scriptlets.json        per-list scriptlet-injection data
//          src/generated/generic-cosmetic/<id>.css
//          src/generated/meta.json              list metadata for runtime + manifest
//
// Run via `npm run compile-filters`. Prints a coverage report so we can see what
// fraction of each list converted to DNR vs. what MV3 can't express.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLine, hostsFromPattern } from './lib/parse-filter.mjs';
import { toDnrRule, ruleKey, networkFilterIdentity } from './lib/to-dnr.mjs';
import { DNR } from './lib/limits.mjs';
import { scriptletLooksObfuscated } from './lib/scriptlet-safe.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FILTERS_DIR = join(ROOT, 'filters');
const OUT_DIR = join(ROOT, 'src', 'generated');
const RULESET_DIR = join(OUT_DIR, 'rulesets');
const GENERIC_CSS_DIR = join(OUT_DIR, 'generic-cosmetic');

function loadRegistry() {
  const p = join(FILTERS_DIR, 'lists.json');
  if (!existsSync(p)) {
    console.error(`No filter registry at ${p}. Nothing to compile.`);
    return { lists: [] };
  }
  return JSON.parse(readFileSync(p, 'utf8'));
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
  const lines = text.split('\n');

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
    if (out.cosmeticException) {
      applyNetworkCosmeticException(out, parsed, ctx.networkCosmeticExceptions);
      continue;
    }
    if (out.badfilter) {
      skips['badfilter'] = (skips['badfilter'] || 0) + 1;
      continue;
    }
    if (ctx.badfilters.has(networkFilterIdentity(parsed))) {
      skips['badfilter-cancelled'] = (skips['badfilter-cancelled'] || 0) + 1;
      continue;
    }
    if (out.skip) {
      skips[out.skip] = (skips[out.skip] || 0) + 1;
      continue;
    }
    const rule = out.rule;

    // Dedup within this list first — so budgets are only spent on rules we emit.
    const key = ruleKey(rule);
    if (seen.has(key)) {
      stats.deduped++;
      continue;
    }

    // Per-list static-rule budget (cap in-loop so regex counting matches what ships).
    if (dnrRules.length >= DNR.GUARANTEED_MINIMUM_STATIC_RULES) {
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

  return { dnrRules, stats };
}

function applyNetworkCosmeticException(out, parsed, bag) {
  if (!parsed.isException) return; // only @@…$generichide etc.
  const kind = out.cosmeticException;
  // Page hosts for cosmetic exceptions come from the URL pattern, $domain/$from,
  // and $to (destination) — e.g. @@||asd.$generichide,to=asd.homes|asd.ink.
  const hosts = [
    ...hostsFromPattern(parsed.pattern, parsed.isRegex),
    ...(parsed.options?.initiatorDomains || []),
    ...(parsed.options?.requestDomains || []),
  ];
  const set = bag[kind];
  if (!set) return;
  for (const h of hosts) if (h) set.add(h);
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
  if (c.kind === 'ignored') return;

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

function main() {
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

  const ctx = {
    regexCount: 0,
    skips: {},
    byList: {},
    /** @type {Set<string>} identities cancelled by $badfilter across all lists */
    badfilters: new Set(),
    networkCosmeticExceptions: {
      generichide: new Set(),
      elemhide: new Set(),
      specifichide: new Set(),
    },
  };

  const metaLists = [];
  let totalEnabledRules = 0;

  // Collect $badfilter identities from every list before emit so later lists can
  // cancel earlier ones (and vice versa).
  for (const list of registry.lists) {
    const file = join(FILTERS_DIR, list.file);
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
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

    // A ruleset must fit the per-extension static budget when enabled.
    if (dnrRules.length > DNR.GUARANTEED_MINIMUM_STATIC_RULES) {
      console.warn(
        `  ! list "${list.id}" produced ${dnrRules.length} rules (> guaranteed ${DNR.GUARANTEED_MINIMUM_STATIC_RULES}); truncating.`,
      );
      dnrRules.length = DNR.GUARANTEED_MINIMUM_STATIC_RULES;
    }

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
      generichide: [...ctx.networkCosmeticExceptions.generichide],
      elemhide: [...ctx.networkCosmeticExceptions.elemhide],
      specifichide: [...ctx.networkCosmeticExceptions.specifichide],
    },
  };
  writeFileSync(join(OUT_DIR, 'cosmetic.json'), JSON.stringify(cosmeticOut));
  writeFileSync(join(OUT_DIR, 'scriptlets.json'), JSON.stringify({ byList: scriptletsByList }));

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
        generatedAt: new Date().toISOString(),
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
    `  generichide hosts:  ${ctx.networkCosmeticExceptions.generichide.size}, elemhide: ${ctx.networkCosmeticExceptions.elemhide.size}, specifichide: ${ctx.networkCosmeticExceptions.specifichide.size}`,
  );
  const skipEntries = Object.entries(ctx.skips).sort((a, b) => b[1] - a[1]);
  if (skipEntries.length) {
    console.log('  skipped network filters (not representable in DNR):');
    for (const [reason, n] of skipEntries) console.log(`     ${String(n).padStart(6)}  ${reason}`);
  }
}

main();
