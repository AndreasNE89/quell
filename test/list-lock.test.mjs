// Tests for the filter-list provenance lock (scripts/lib/list-lock.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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

test('a corrupt lock file throws LOCK_CORRUPT rather than looking missing', () => {
  const dir = fixture({ 'lists.lock.json': '{ not json' });
  try {
    assert.throws(() => readLock(dir), (e) => e?.code === 'LOCK_CORRUPT');
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
  // on an unchanged refresh would reset the Options "refreshed N days ago" counter and claim
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

// --- CLI recovery from a corrupt lock ---------------------------------------------------
// `--check` must fail on a corrupt lock: it exists to prove disk matches the record, and an
// unreadable record proves nothing. The rewrite path must NOT fail for the same reason — it is
// the documented way out, and it used to tell the user to run the command they were running.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';

const REPO = process.cwd();

/** A throwaway repo root with filters/ populated, so lock-lists.mjs can run against it. */
function repoFixture(lockContents) {
  const dir = mkdtempSync(join(tmpdir(), 'stampstack-repo-'));
  mkdirSync(join(dir, 'filters'));
  cpSync(join(REPO, 'filters', 'lists.json'), join(dir, 'filters', 'lists.json'));
  for (const l of JSON.parse(readFileSync(join(REPO, 'filters', 'lists.json'), 'utf8')).lists) {
    writeFileSync(join(dir, 'filters', l.file), `! stub for ${l.id}\n`);
  }
  if (lockContents !== undefined) writeFileSync(join(dir, 'filters', 'lists.lock.json'), lockContents);
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  cpSync(join(REPO, 'scripts', 'lock-lists.mjs'), join(dir, 'scripts', 'lock-lists.mjs'));
  cpSync(join(REPO, 'scripts', 'lib', 'list-lock.mjs'), join(dir, 'scripts', 'lib', 'list-lock.mjs'));
  return dir;
}

/** spawnSync, not execFileSync: the recovery warning goes to stderr, which execFileSync drops. */
function runLock(dir, args) {
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'lock-lists.mjs'), ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('CLI: --check fails on a corrupt lock', () => {
  const dir = repoFixture('{ not json');
  try {
    const r = runLock(dir, ['--check']);
    assert.equal(r.code, 1);
    assert.match(r.out, /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: rewrite recovers from a corrupt lock instead of telling you to run itself', () => {
  const dir = repoFixture('{ not json');
  try {
    const r = runLock(dir, []);
    assert.equal(r.code, 0, `rewrite should recover, got exit ${r.code}: ${r.out}`);
    assert.match(r.out, /unreadable — rewritten/);
    // The lost refresh date must be called out, not silently reset.
    assert.match(r.out, /previous refresh date was lost/);
    // And the file it wrote must now be readable.
    assert.equal(runLock(dir, ['--check']).code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: the recovery message does not point at a command that fails', () => {
  const dir = repoFixture('{ not json');
  try {
    // The --check error names the rewrite; the rewrite must then actually succeed.
    const checkOut = runLock(dir, ['--check']).out;
    assert.match(checkOut, /npm run lock-lists/);
    assert.equal(/Fix it or re-stamp: npm run lock-lists/.test(checkOut), false);
    assert.equal(runLock(dir, []).code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: a healthy lock is untouched by a rewrite', () => {
  const dir = repoFixture(undefined);
  try {
    assert.equal(runLock(dir, []).code, 0); // first stamp
    const first = readFileSync(join(dir, 'filters', 'lists.lock.json'), 'utf8');
    const second = runLock(dir, []);
    assert.equal(second.code, 0);
    assert.match(second.out, /No list content changed/);
    assert.equal(readFileSync(join(dir, 'filters', 'lists.lock.json'), 'utf8'), first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
