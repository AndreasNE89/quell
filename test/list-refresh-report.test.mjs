// Tests for the filter-refresh PR summary (scripts/list-refresh-report.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { report, ruleDelta, ruleCounts, SHRINK_WARN } from '../scripts/list-refresh-report.mjs';

const meta = (counts) => ({ lists: Object.entries(counts).map(([id, ruleCount]) => ({ id, ruleCount })) });
const lock = (sizes) => ({
  lists: Object.fromEntries(
    Object.entries(sizes).map(([id, bytes]) => [id, { file: `${id}.txt`, bytes, sha256: `${id}-${bytes}` }]),
  ),
});

test('rule counts are read off the meta list array', () => {
  assert.deepEqual(ruleCounts(meta({ a: 10, b: 5 })), { a: 10, b: 5 });
  assert.deepEqual(ruleCounts(null), {});
  assert.deepEqual(ruleCounts({}), {});
});

test('deltas are per list and totalled', () => {
  const d = ruleDelta(meta({ a: 100, b: 50 }), meta({ a: 120, b: 50 }));
  assert.equal(d.totalBefore, 150);
  assert.equal(d.totalAfter, 170);
  assert.deepEqual(d.rows.find((r) => r.id === 'a'), {
    id: 'a', before: 100, after: 120, delta: 20, suspect: false,
  });
});

test('a list that loses more than the threshold is flagged suspect', () => {
  const survives = Math.floor(1000 * (1 - SHRINK_WARN)); // exactly at the edge, not past it
  assert.equal(ruleDelta(meta({ a: 1000 }), meta({ a: survives })).suspect.length, 0);
  assert.equal(ruleDelta(meta({ a: 1000 }), meta({ a: survives - 1 })).suspect.length, 1);
});

test('a list appearing for the first time is not suspect', () => {
  // before = 0 would otherwise trip the shrink arithmetic.
  const d = ruleDelta(meta({}), meta({ a: 500 }));
  assert.equal(d.suspect.length, 0);
  assert.equal(d.rows[0].delta, 500);
});

test('a list dropping to zero is suspect, not silently fine', () => {
  const d = ruleDelta(meta({ a: 1000 }), meta({ a: 0 }));
  assert.equal(d.suspect.length, 1);
  assert.equal(d.rows[0].delta, -1000);
});

test('no change at all produces no report, so the workflow can skip the PR', () => {
  const m = meta({ a: 100 });
  const l = lock({ a: 2048 });
  assert.equal(report({ beforeMeta: m, afterMeta: m, beforeLock: l, afterLock: l }), null);
});

test('a normal refresh reports totals, per-list rows and byte movement', () => {
  const body = report({
    beforeMeta: meta({ easylist: 80000, ubo: 20000 }),
    afterMeta: meta({ easylist: 80500, ubo: 20000 }),
    beforeLock: lock({ easylist: 2_000_000, ubo: 1_000_000 }),
    afterLock: lock({ easylist: 2_100_000, ubo: 1_000_000 }),
  });
  assert.match(body, /\+500 rules/);
  assert.match(body, /100,000 → \*\*100,500\*\*/);
  assert.match(body, /`easylist`/);
  assert.match(body, /\+98 KB/);
  // A list whose bytes did not move gets a dash, not a fabricated zero.
  assert.match(body, /\| `ubo` \| 20,000 \| 0 \| — \|/);
  assert.equal(/⚠️/.test(body), false);
});

test('a hard shrink puts a warning in the body', () => {
  const body = report({
    beforeMeta: meta({ easylist: 80000 }),
    afterMeta: meta({ easylist: 100 }),
    beforeLock: lock({ easylist: 2_000_000 }),
    afterLock: lock({ easylist: 4096 }),
  });
  assert.match(body, /⚠️/);
  assert.match(body, /lost more than 10%/);
  assert.match(body, /truncated or rate-limited/);
});

test('rule totals moving with identical bytes still reports', () => {
  // Happens when the compiler changes rather than the lists — worth surfacing, not hiding.
  const l = lock({ a: 2048 });
  const body = report({
    beforeMeta: meta({ a: 100 }), afterMeta: meta({ a: 140 }), beforeLock: l, afterLock: l,
  });
  assert.match(body, /\+40 rules/);
});

test('negative totals render with a minus, not a stray plus', () => {
  const body = report({
    beforeMeta: meta({ a: 500 }),
    afterMeta: meta({ a: 480 }),
    beforeLock: lock({ a: 2048 }),
    afterLock: lock({ a: 1024 }),
  });
  assert.match(body, /−20 rules/);
  assert.match(body, /−1 KB/);
});

test('a list declared but never downloaded is called out', () => {
  const body = report({
    beforeMeta: meta({ a: 100 }),
    afterMeta: meta({ a: 120 }),
    beforeLock: lock({ a: 1024 }),
    afterLock: { ...lock({ a: 2048 }), missing: ['b'] },
  });
  assert.match(body, /not downloaded: b/);
});

test('a sub-kilobyte change does not round away to "0 KB"', () => {
  const body = report({
    beforeMeta: meta({ a: 100 }),
    afterMeta: meta({ a: 99 }),
    beforeLock: lock({ a: 4096 }),
    afterLock: lock({ a: 4050 }),
  });
  assert.match(body, /−46 B/);
  assert.equal(/0 KB/.test(body), false);
});
