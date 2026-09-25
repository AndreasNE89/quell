// Checks on what a build ships, shared by scripts/build.mjs (every build) and
// scripts/package.mjs (the store gate). Each returns one line per problem, empty when none.

import { DNR } from './limits.mjs';

/**
 * The manifest's `rule_resources` against the limits Chrome enforces when it loads the
 * extension: over 100 static rulesets or over 50 enabled ones and the install fails outright,
 * and a repeated id is rejected the same way.
 * @param {{ id: string, enabled: boolean }[]} ruleResources
 */
export function rulesetProblems(ruleResources) {
  const problems = [];
  const seen = new Set();
  for (const r of ruleResources) {
    if (seen.has(r.id)) problems.push(`duplicate ruleset id "${r.id}"`);
    seen.add(r.id);
  }
  if (ruleResources.length > DNR.MAX_NUMBER_OF_STATIC_RULESETS) {
    problems.push(
      `${ruleResources.length} static rulesets; Chrome allows at most ${DNR.MAX_NUMBER_OF_STATIC_RULESETS}`,
    );
  }
  const enabled = ruleResources.filter((r) => r.enabled).length;
  if (enabled > DNR.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS) {
    problems.push(
      `${enabled} rulesets enabled by default; Chrome allows at most ${DNR.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS}`,
    );
  }
  return problems;
}

/**
 * Every list in the registry must ship its ruleset, as the registry says (on or off by
 * default), with at least `minRules` rules where the registry sets a floor.
 *
 * A total alone cannot tell a healthy package from one missing a list: EasyPrivacy replaced by
 * an error page still left 73,493 rules, comfortably over the old 50,000 floor
 * (REVIEW_2026-09-24 B74). compile-filters skips a list whose file is missing with a warning,
 * so this is where that becomes fatal.
 * @param {{ lists: { id: string, enabledByDefault?: boolean, minRules?: number }[] }} registry
 * @param {{ id: string, enabled: boolean, path: string }[]} ruleResources
 * @param {(path: string) => number | null} countRules rules in a ruleset file, null if unreadable
 */
export function listFloorProblems(registry, ruleResources, countRules) {
  const problems = [];
  const byId = new Map(ruleResources.map((r) => [r.id, r]));
  for (const list of registry.lists) {
    const res = byId.get(list.id);
    if (!res) {
      problems.push(`${list.id}: no ruleset in the manifest (was filters/${list.file ?? '?'} missing when compile-filters ran?)`);
      continue;
    }
    const wantEnabled = list.enabledByDefault !== false;
    if (res.enabled !== wantEnabled) {
      problems.push(`${list.id}: the manifest has it ${res.enabled ? 'on' : 'off'} by default, lists.json ${wantEnabled ? 'on' : 'off'}`);
    }
    const n = countRules(res.path);
    if (n === null) {
      problems.push(`${list.id}: ${res.path} is missing or unreadable`);
      continue;
    }
    if (typeof list.minRules === 'number' && n < list.minRules) {
      problems.push(
        `${list.id}: ${n} DNR rules, under its floor of ${list.minRules} (lists.json minRules). ` +
          'A truncated or error-page download looks like this.',
      );
    }
  }
  return problems;
}
