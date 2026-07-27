// Tests for the filter-list provenance lock (scripts/lib/list-lock.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLock, diffLock, formatLockDiff, readLock, stampFor, writeLock } from '../scripts/lib/list-lock.mjs';

const STAMP = '2026-07-27T00:00:00.000Z';

/** A throwaway filters/ directory holding the given `file → contents` map. */
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'stampstack-lock-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

const registry = (...ids) => ({
  lists: ids.map((id) => ({ id, file: `${id}.txt` })),
});

test('a lock records byte length and hash per list', () => {
  const dir = fixture({ 'a.txt': 'alpha', 'b.txt': 'beta!!' });
  try {
    const lock = buildLock(registry('a', 'b'), dir, STAMP);
    assert.equal(lock.updated, STAMP);
    assert.equal(lock.lists['a'].bytes, 5);
    assert.equal(lock.lists['b'].bytes, 6);
    assert.match(lock.lists['a'].sha256, /^[0-9a-f]{64}$/);
    assert.notEqual(lock.lists['a'].sha256, lock.lists['b'].sha256);
    // Nothing missing, so the key is absent rather than an empty array.
    assert.equal('missing' in lock, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a list in the registry but not on disk is reported, not skipped', () => {
  const dir = fixture({ 'a.txt': 'alpha' });
  try {
    const lock = buildLock(registry('a', 'gone'), dir, STAMP);
    assert.deepEqual(lock.missing, ['gone']);
    assert.equal('gone' in lock.lists, false);
    // An incomplete download must not read as clean.
    assert.deepEqual(diffLock(lock, lock).absent, ['gone']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('identical bytes at a different timestamp are still clean', () => {
  const dir = fixture({ 'a.txt': 'alpha' });
  try {
    const before = buildLock(registry('a'), dir, STAMP);
    const after = buildLock(registry('a'), dir, '2026-08-10T00:00:00.000Z');
    assert.equal(diffLock(before, after).clean, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('changed content is reported with a signed byte delta', () => {
  const dir = fixture({ 'a.txt': 'alpha' });
  try {
    const before = buildLock(registry('a'), dir, STAMP);
    writeFileSync(join(dir, 'a.txt'), 'alpha and then some');
    const diff = diffLock(before, buildLock(registry('a'), dir, STAMP));
    assert.equal(diff.clean, false);
    assert.equal(diff.changed.length, 1);
    assert.equal(diff.changed[0].id, 'a');
    assert.equal(diff.changed[0].delta, 19 - 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('same length but different bytes is still a change', () => {
  // Byte count alone would miss an upstream edit that swaps a rule for another of equal
  // length, which is exactly the drift the hash exists to catch.
  const dir = fixture({ 'a.txt': 'alpha' });
  try {
    const before = buildLock(registry('a'), dir, STAMP);
    writeFileSync(join(dir, 'a.txt'), 'ALPHA');
    const diff = diffLock(before, buildLock(registry('a'), dir, STAMP));
    assert.equal(diff.clean, false);
    assert.equal(diff.changed[0].delta, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registry additions and removals are distinguished from edits', () => {
  const dir = fixture({ 'a.txt': 'alpha', 'b.txt': 'beta' });
  try {
    const before = buildLock(registry('a'), dir, STAMP);
    const diff = diffLock(before, buildLock(registry('b'), dir, STAMP));
    assert.deepEqual(diff.added.map((x) => x.id), ['b']);
    assert.deepEqual(diff.removed.map((x) => x.id), ['a']);
    assert.equal(diff.changed.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing lock file reads as null rather than throwing', () => {
  const dir = fixture({});
  try {
    assert.equal(readLock(dir), null);
    // Everything is "added" against no prior lock, which is what a first stamp should say.
    const diff = diffLock(null, buildLock(registry(), dir, STAMP));
    assert.equal(diff.clean, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt lock file reads as null rather than throwing', () => {
  const dir = fixture({ 'lists.lock.json': '{ not json' });
  try {
    assert.equal(readLock(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a written lock round-trips', () => {
  const dir = fixture({ 'a.txt': 'alpha' });
  try {
    const lock = buildLock(registry('a'), dir, STAMP);
    writeLock(dir, lock);
    assert.deepEqual(readLock(dir), lock);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the diff summary names each list and its direction', () => {
  const text = formatLockDiff({
    changed: [{ id: 'easylist', bytes: 2048, wasBytes: 1024, delta: 1024 }],
    added: [{ id: 'new-list', bytes: 512 }],
    removed: [{ id: 'old-list' }],
    absent: ['not-downloaded'],
  });
  assert.match(text, /~ easylist/);
  assert.match(text, /\+1 KB/);
  assert.match(text, /\+ new-list/);
  assert.match(text, /- old-list/);
  assert.match(text, /! not-downloaded/);
});

test('a shrinking list reads as a minus, not a plus', () => {
  const text = formatLockDiff({
    changed: [{ id: 'easylist', bytes: 1024, wasBytes: 3072, delta: -2048 }],
    added: [],
    removed: [],
    absent: [],
  });
  assert.match(text, /−2 KB/);
  assert.equal(/\+/.test(text), false);
});

test('a no-op re-stamp keeps the old timestamp, so list age stays honest', () => {
  // The stamp means "when this content arrived", not "when the script last ran". Advancing it
  // on an unchanged refresh would reset the Options "compiled N days ago" counter and claim
  // protection is fresher than upstream actually delivered.
  const dir = fixture({ 'a.txt': 'alpha' });
  try {
    const before = buildLock(registry('a'), dir, STAMP);
    const diff = diffLock(before, buildLock(registry('a'), dir, STAMP));
    assert.equal(diff.clean, true);
    assert.equal(stampFor(before, diff, '2026-09-01T00:00:00.000Z'), STAMP);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a real content change does take the new timestamp', () => {
  const dir = fixture({ 'a.txt': 'alpha' });
  try {
    const before = buildLock(registry('a'), dir, STAMP);
    writeFileSync(join(dir, 'a.txt'), 'alpha changed');
    const diff = diffLock(before, buildLock(registry('a'), dir, STAMP));
    assert.equal(diff.clean, false);
    assert.equal(stampFor(before, diff, '2026-09-01T00:00:00.000Z'), '2026-09-01T00:00:00.000Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a first stamp with no previous lock uses now', () => {
  const dir = fixture({ 'a.txt': 'alpha' });
  try {
    const diff = diffLock(null, buildLock(registry('a'), dir, STAMP));
    assert.equal(stampFor(null, diff, '2026-09-01T00:00:00.000Z'), '2026-09-01T00:00:00.000Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a clean diff against a previous lock with no stamp still takes now', () => {
  const diff = { clean: true, changed: [], added: [], removed: [], absent: [] };
  assert.equal(stampFor({ lists: {} }, diff, '2026-09-01T00:00:00.000Z'), '2026-09-01T00:00:00.000Z');
});
