// Compile filter lists → declarativeNetRequest rulesets + cosmetic/scriptlet data.
//
// Inputs:  filters/lists.json  (list registry) + the referenced .txt files
// Outputs: src/generated/rulesets/<id>.json   one DNR ruleset per list
//          src/generated/cosmetic.json         element-hiding data
//          src/generated/scriptlets.json        scriptlet-injection data
//          src/generated/meta.json              list metadata for runtime + manifest
//
// Run via `npm run compile-filters`. Prints a coverage report so we can see what
// fraction of each list converted to DNR vs. what MV3 can't express.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLine } from './lib/parse-filter.mjs';
import { toDnrRule, ruleKey } from './lib/to-dnr.mjs';
import { DNR } from './lib/limits.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FILTERS_DIR = join(ROOT, 'filters');
const OUT_DIR = join(ROOT, 'src', 'generated');
const RULESET_DIR = join(OUT_DIR, 'rulesets');

function loadRegistry() {
  const p = join(FILTERS_DIR, 'lists.json');
  if (!existsSync(p)) {
    console.error(`No filter registry at ${p}. Nothing to compile.`);
    return { lists: [] };
  }
  return JSON.parse(readFileSync(p, 'utf8'));
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

  let nextId = 1;
  for (const raw of text.split('\n')) {
    const parsed = parseLine(raw);
    if (!parsed) continue;

    if (parsed.type === 'cosmetic') {
      applyCosmetic(parsed, ctx, stats);
      continue;
    }

    // network
    stats.network++;
    const out = toDnrRule(parsed);
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

function applyCosmetic(c, ctx, stats) {
  const cos = ctx.cosmetic;
  if (c.kind === 'scriptlet') {
    // Scriptlets must be domain-scoped (injecting into every page is unsafe).
    if (!c.domains.include.length || c.isException) return;
    ctx.scriptlets.push({
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
  if (!selector) return;

  const { include, exclude } = c.domains;
  if (include.length) {
    // Domain-scoped rule: hide/unhide only on the named domains.
    const target = isUnhide ? cos.unhideSpecific : cos.hideSpecific;
    for (const d of include) (target[d] ||= new Set()).add(selector);
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

function main() {
  const registry = loadRegistry();

  // Fresh output dirs.
  if (existsSync(RULESET_DIR)) {
    for (const f of readdirSync(RULESET_DIR)) rmSync(join(RULESET_DIR, f));
  }
  mkdirSync(RULESET_DIR, { recursive: true });

  const ctx = {
    regexCount: 0,
    skips: {},
    cosmetic: {
      hideGeneric: new Set(),
      unhideGeneric: new Set(),
      hideSpecific: {},
      unhideSpecific: {},
      procedural: [],
    },
    scriptlets: [],
  };

  const metaLists = [];
  let totalEnabledRules = 0;

  for (const list of registry.lists) {
    const file = join(FILTERS_DIR, list.file);
    if (!existsSync(file)) {
      console.warn(`  ! skipping "${list.id}" — file not found: ${list.file}`);
      continue;
    }
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

    metaLists.push({
      id: list.id,
      title: list.title,
      group: list.group || 'ads',
      enabledByDefault: enabled,
      ruleCount: dnrRules.length,
      rulesetFile: `rulesets/${list.id}.json`,
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

  // Write cosmetic + scriptlet + meta outputs.
  const cosmeticOut = {
    hideGeneric: [...ctx.cosmetic.hideGeneric],
    unhideGeneric: [...ctx.cosmetic.unhideGeneric],
    hideSpecific: setMapToObj(ctx.cosmetic.hideSpecific),
    unhideSpecific: setMapToObj(ctx.cosmetic.unhideSpecific),
    procedural: ctx.cosmetic.procedural,
  };
  writeFileSync(join(OUT_DIR, 'cosmetic.json'), JSON.stringify(cosmeticOut));

  // Generic element-hiding → a standalone stylesheet injected on every page (except
  // allowlisted ones, via registerContentScripts excludeMatches). Chunked into
  // grouped selectors so a single malformed selector can't nuke the whole sheet.
  const generic = cosmeticOut.hideGeneric.filter((s) => !cosmeticOut.unhideGeneric.includes(s));
  const CHUNK = 500;
  let css = '/* Quell generic element-hiding — generated, do not edit. */\n';
  for (let i = 0; i < generic.length; i += CHUNK) {
    const group = generic.slice(i, i + CHUNK).join(',\n');
    if (group) css += `${group} { display: none !important; }\n`;
  }
  writeFileSync(join(OUT_DIR, 'generic-cosmetic.css'), css);
  writeFileSync(join(OUT_DIR, 'scriptlets.json'), JSON.stringify({ scriptlets: ctx.scriptlets }));
  writeFileSync(
    join(OUT_DIR, 'meta.json'),
    JSON.stringify({ generatedAt: null, lists: metaLists, regexRulesUsed: ctx.regexCount }, null, 2),
  );

  // Coverage report.
  const totalNet = metaLists.reduce((n, l) => n + l.ruleCount, 0);
  console.log('\nCoverage:');
  console.log(`  DNR network rules:  ${totalNet}`);
  console.log(`  regex rules used:   ${ctx.regexCount}/${DNR.MAX_NUMBER_OF_REGEX_RULES}`);
  console.log(`  cosmetic hide (generic/specific): ${cosmeticOut.hideGeneric.length}/${Object.keys(cosmeticOut.hideSpecific).length} domains`);
  console.log(`  procedural cosmetics: ${cosmeticOut.procedural.length}`);
  console.log(`  scriptlets:         ${ctx.scriptlets.length}`);
  const skipEntries = Object.entries(ctx.skips).sort((a, b) => b[1] - a[1]);
  if (skipEntries.length) {
    console.log('  skipped network filters (not representable in DNR):');
    for (const [reason, n] of skipEntries) console.log(`     ${String(n).padStart(6)}  ${reason}`);
  }
}

main();
