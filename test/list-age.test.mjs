// Tests for filter-list staleness reporting (src/shared/list-age.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// The module is TS with no runtime dependencies, so bundling it is enough to exercise it.
const { outputFiles } = await build({
  entryPoints: ['src/shared/list-age.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'neutral',
});
const { listAge, AGING_DAYS, STALE_DAYS } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

const NOW = Date.parse('2026-07-27T12:00:00.000Z');
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();

test('a fresh build says when, with no warning tail', () => {
  const a = listAge(daysAgo(3), NOW);
  assert.equal(a.level, 'fresh');
  assert.equal(a.days, 3);
  assert.equal(a.text, 'Filter lists refreshed 3 days ago (24 Jul 2026)');
});

test('same day reads as "today", not "0 days ago"', () => {
  assert.equal(listAge(daysAgo(0), NOW).text, 'Filter lists refreshed today (27 Jul 2026)');
});

test('one day is singular', () => {
  assert.match(listAge(daysAgo(1), NOW).text, /refreshed 1 day ago/);
});

test('the aging threshold is inclusive and names what fixes it', () => {
  assert.equal(listAge(daysAgo(AGING_DAYS - 1), NOW).level, 'fresh');
  const aging = listAge(daysAgo(AGING_DAYS), NOW);
  assert.equal(aging.level, 'aging');
  // The user cannot refresh lists by hand, so the copy must not imply they can.
  assert.match(aging.text, /a StampStack update will refresh them soon/);
  assert.equal(/a refresh is due/.test(aging.text), false);
});

test('the stale threshold is inclusive and names what fixes it', () => {
  assert.equal(listAge(daysAgo(STALE_DAYS - 1), NOW).level, 'aging');
  const stale = listAge(daysAgo(STALE_DAYS), NOW);
  assert.equal(stale.level, 'stale');
  assert.match(stale.text, /behind upstream/);
  // The user cannot refresh lists by hand, so the copy must not imply they can.
  assert.match(stale.text, /A new StampStack version will refresh them/);
});

test('a clock behind the build machine reports 0 days, never a negative age', () => {
  const future = new Date(NOW + 3 * 86_400_000).toISOString();
  const a = listAge(future, NOW);
  assert.equal(a.days, 0);
  assert.equal(a.level, 'fresh');
  assert.match(a.text, /refreshed today/);
});

test('a missing or unparseable date says so instead of guessing', () => {
  for (const bad of [null, undefined, '', 'not a date']) {
    const a = listAge(bad, NOW);
    assert.equal(a.level, 'unknown');
    assert.equal(a.days, null);
    assert.equal(a.date, '');
    assert.match(a.text, /unavailable/);
  }
});

test('the date does not depend on the host locale', () => {
  // A fixed format, so a machine with different ICU data renders the same string.
  assert.equal(listAge('2026-01-05T00:00:00.000Z', Date.parse('2026-01-06T00:00:00Z')).date, '5 Jan 2026');
  assert.equal(listAge('2026-12-31T23:59:59.000Z', Date.parse('2027-01-01T00:00:00Z')).date, '31 Dec 2026');
});

test('age is measured in whole days, not rounded up by a few hours', () => {
  const almostTwo = new Date(NOW - (2 * 86_400_000 - 3_600_000)).toISOString();
  assert.equal(listAge(almostTwo, NOW).days, 1);
});
