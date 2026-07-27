// Provenance for the filter lists that get compiled into a release.
//
// The upstream lists are mutable and unversioned: fetching easylist.txt today and tomorrow
// gives different bytes under the same URL. Committing the .txt files pins what a given
// release was built from, but their diffs run to tens of thousands of lines, so the raw diff
// is unreadable as review material.
//
// The lock is the readable half of that pair. It is a handful of lines that say which lists
// moved and by how much, which is the part a human can actually check before merging a
// refresh.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LOCK_FILE = 'lists.lock.json';

/** sha256 over the raw bytes — not the decoded text, so a BOM or CRLF change is visible. */
export function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Describe every list in the registry that is present on disk.
 * Missing files are reported rather than skipped: a lock that silently omits a list would
 * make an incomplete build look fully pinned.
 */
export function buildLock(registry, filtersDir, now) {
  const lists = {};
  const missing = [];
  for (const list of registry.lists) {
    const path = join(filtersDir, list.file);
    if (!existsSync(path)) {
      missing.push(list.id);
      continue;
    }
    const bytes = readFileSync(path);
    lists[list.id] = {
      file: list.file,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }
  return {
    comment:
      'Integrity record for the lists compiled into a release. Written by `npm run update-lists`; ' +
      'verify with `npm run check-lists`. The .txt files themselves are the source of truth.',
    updated: now,
    lists,
    ...(missing.length ? { missing } : {}),
  };
}

/**
 * @returns {object | null} parsed lock, or `null` when the file is absent.
 * @throws {{ code: 'LOCK_CORRUPT' }} when the file exists but is not valid JSON — callers
 * must not treat that the same as "not stamped yet".
 */
export function readLock(filtersDir) {
  const path = join(filtersDir, LOCK_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    const err = new Error(`${LOCK_FILE} is not valid JSON`);
    err.code = 'LOCK_CORRUPT';
    throw err;
  }
}

export function writeLock(filtersDir, lock) {
  writeFileSync(join(filtersDir, LOCK_FILE), JSON.stringify(lock, null, 2) + '\n');
}

/**
 * Compare what is on disk against what the lock claims.
 *
 * `changed` covers a list whose bytes moved, `added`/`removed` a registry edit, and
 * `absent` a list the registry declares but nobody has downloaded. Callers decide which of
 * those is fatal — for CI all of them are, for a local build none need to be.
 */
export function diffLock(lock, current) {
  const before = lock?.lists ?? {};
  const after = current.lists;
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);

  const changed = [];
  const added = [];
  const removed = [];
  for (const id of [...ids].sort()) {
    const a = before[id];
    const b = after[id];
    if (!a && b) added.push({ id, bytes: b.bytes });
    else if (a && !b) removed.push({ id });
    else if (a && b && a.sha256 !== b.sha256)
      changed.push({ id, bytes: b.bytes, wasBytes: a.bytes, delta: b.bytes - a.bytes });
  }
  return {
    changed,
    added,
    removed,
    absent: current.missing ?? [],
    clean: !changed.length && !added.length && !removed.length,
  };
}

/**
 * Which timestamp a re-stamp should record.
 *
 * `updated` means "when this list content arrived", not "when someone last ran the stamping
 * script". Those diverge whenever a refresh downloads bytes identical to what was already
 * there, which is the common case between upstream releases. Advancing the stamp then would
 * be a lie with a user-visible consequence: compile-filters feeds this into
 * `meta.generatedAt`, and the Options page turns it into "Filter lists refreshed N days ago".
 * A no-op refresh would reset that counter and claim protection is fresher than upstream
 * actually delivered.
 */
export function stampFor(previous, diff, now) {
  return diff.clean && previous?.updated ? previous.updated : now;
}

/** One line per moved list, for a PR body or a CI log. */
export function formatLockDiff(diff) {
  const kb = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(0)} KB`);
  // A handful of changed bytes must not round to "0 KB" and read as no change at all.
  const signed = (n) => `${n >= 0 ? '+' : '−'}${kb(Math.abs(n))}`;
  const lines = [];
  for (const c of diff.changed) lines.push(`  ~ ${c.id} — ${kb(c.bytes)} (${signed(c.delta)})`);
  for (const a of diff.added) lines.push(`  + ${a.id} — ${kb(a.bytes)} (new)`);
  for (const r of diff.removed) lines.push(`  - ${r.id} — no longer in the registry`);
  for (const id of diff.absent) lines.push(`  ! ${id} — declared but not downloaded`);
  return lines.join('\n');
}
