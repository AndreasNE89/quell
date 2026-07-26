// Reporting when Chrome refuses to load a ruleset.
//
// StampStack ships ~120k static rules, well past the 30k Chrome guarantees; the rest comes from
// a pool shared with every other installed extension. When that pool is full,
// `updateEnabledRulesets` throws and syncRulesets drops the largest list to keep the rest
// working — good behavior, but the UI went on reporting the dropped list as enabled and counted
// its rules in the headline total. The user saw "120,377 blocking rules active" while a third
// of them were not loaded.
//
// This exercises the pure reconciliation: what the user asked for vs what Chrome reports live.

import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Mirror of buildListRows' logic. The real one lives in the service worker, which cannot be
 * bundled here (it imports the 3 MB generated datasets and the extpay-backed license module),
 * so the rule under test is restated rather than imported — kept deliberately small so the
 * restatement cannot drift far.
 */
function reconcile(lists, settings, live) {
  const rows = lists.map((l) => {
    const wanted = settings.enabledLists[l.id] ?? l.enabledByDefault;
    const enabled = wanted;
    const effective = wanted && !settings.paused;
    return {
      ...l,
      enabled,
      active: live == null ? effective : effective && live.includes(l.id),
    };
  });
  return {
    rows,
    degraded: rows.some((r) => r.enabled && !settings.paused && !r.active),
  };
}

const LISTS = [
  { id: 'quell-seed', enabledByDefault: true, ruleCount: 103 },
  { id: 'easylist', enabledByDefault: true, ruleCount: 54522 },
  { id: 'easyprivacy', enabledByDefault: true, ruleCount: 55525 },
  { id: 'easylist-cookie', enabledByDefault: false, ruleCount: 2085 },
];
const base = { enabledLists: {}, paused: false };
const activeRules = (rows) => rows.filter((r) => r.active).reduce((n, r) => n + r.ruleCount, 0);

test('everything loaded: nothing is reported as degraded', () => {
  const live = ['quell-seed', 'easylist', 'easyprivacy'];
  const { rows, degraded } = reconcile(LISTS, base, live);
  assert.equal(degraded, false);
  assert.equal(activeRules(rows), 103 + 54522 + 55525);
});

test('a dropped ruleset is reported inactive and excluded from the count', () => {
  // Chrome accepted everything except easyprivacy — the largest, so the first to be dropped.
  const live = ['quell-seed', 'easylist'];
  const { rows, degraded } = reconcile(LISTS, base, live);
  assert.equal(degraded, true);

  const ep = rows.find((r) => r.id === 'easyprivacy');
  assert.equal(ep.enabled, true, 'the user still asked for it — the toggle stays on');
  assert.equal(ep.active, false, 'but it is not loaded, and the UI must say so');
  assert.equal(activeRules(rows), 103 + 54522, 'its 55,525 rules must not be counted');
});

test('a list the user turned off is not degradation', () => {
  // easylist-cookie is off by default; absent from `live` is expected, not a failure.
  const { rows, degraded } = reconcile(LISTS, base, ['quell-seed', 'easylist', 'easyprivacy']);
  assert.equal(degraded, false);
  assert.equal(rows.find((r) => r.id === 'easylist-cookie').active, false);
});

test('pause is not degradation either', () => {
  // Everything is inactive while paused, but that is the user's own doing — warning about it
  // would train people to ignore the warning.
  const { rows, degraded } = reconcile(LISTS, { ...base, paused: true }, []);
  assert.equal(degraded, false);
  assert.equal(activeRules(rows), 0);
  assert.equal(rows.find((r) => r.id === 'easylist').enabled, true, 'the toggle still reads on');
});

test('an explicit user override is honored over the default', () => {
  const settings = { enabledLists: { easylist: false, 'easylist-cookie': true }, paused: false };
  const live = ['quell-seed', 'easyprivacy', 'easylist-cookie'];
  const { rows, degraded } = reconcile(LISTS, settings, live);
  assert.equal(degraded, false);
  assert.equal(rows.find((r) => r.id === 'easylist').enabled, false);
  assert.equal(rows.find((r) => r.id === 'easylist-cookie').active, true);
});

test('when the live state cannot be read, do not cry wolf', () => {
  // getEnabledRulesets threw. Claiming degradation on missing information would put a scary
  // warning in front of users whose setup is fine.
  const { rows, degraded } = reconcile(LISTS, base, null);
  assert.equal(degraded, false);
  assert.equal(activeRules(rows), 103 + 54522 + 55525);
});

test('the seed list is never the one dropped', () => {
  // syncRulesets excludes quell-seed from the droppable set, so the built-in floor survives
  // even on a completely exhausted pool.
  const { rows, degraded } = reconcile(LISTS, base, ['quell-seed']);
  assert.equal(degraded, true);
  assert.equal(rows.find((r) => r.id === 'quell-seed').active, true);
  assert.equal(activeRules(rows), 103, 'some protection, honestly reported');
});
