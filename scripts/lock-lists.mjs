// Stamp (or verify) filters/lists.lock.json against the .txt files on disk.
//
//   node scripts/lock-lists.mjs           # rewrite the lock from what is on disk
//   node scripts/lock-lists.mjs --check   # verify only; non-zero exit if they disagree
//
// `--check` is what CI runs. It catches a list edited or replaced without the lock being
// re-stamped, which is the one way the committed .txt files and their recorded provenance
// can silently drift apart.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildLock, diffLock, formatLockDiff, readLock, writeLock } from './lib/list-lock.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILTERS = join(ROOT, 'filters');
const check = process.argv.includes('--check');

const registry = JSON.parse(readFileSync(join(FILTERS, 'lists.json'), 'utf8'));
const previous = readLock(FILTERS);
// A verify run must not invent a timestamp — it would make every check look like a change.
const current = buildLock(registry, FILTERS, check ? (previous?.updated ?? null) : new Date().toISOString());
const diff = diffLock(previous, current);

if (check) {
  if (!previous) {
    console.error('filters/lists.lock.json is missing. Run: npm run lock-lists');
    process.exit(1);
  }
  if (diff.absent.length) {
    console.error('Filter lists declared in lists.json but not present on disk:');
    console.error(diff.absent.map((id) => `  ! ${id}`).join('\n'));
    console.error('\nRun: npm run update-lists');
    process.exit(1);
  }
  if (!diff.clean) {
    console.error('filters/ does not match filters/lists.lock.json:\n');
    console.error(formatLockDiff(diff));
    console.error('\nIf the change is intended, re-stamp it: npm run lock-lists');
    process.exit(1);
  }
  console.log(`lists.lock.json matches ${Object.keys(current.lists).length} lists on disk.`);
} else {
  writeLock(FILTERS, current);
  if (diff.clean && previous) {
    console.log('lists.lock.json refreshed — no list content changed.');
  } else {
    console.log('lists.lock.json updated:\n');
    console.log(formatLockDiff(diff) || '  (first stamp)');
  }
}
