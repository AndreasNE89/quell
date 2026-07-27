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

import { buildLock, diffLock, formatLockDiff, readLock, stampFor, writeLock } from './lib/list-lock.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILTERS = join(ROOT, 'filters');
const check = process.argv.includes('--check');

const registry = JSON.parse(readFileSync(join(FILTERS, 'lists.json'), 'utf8'));
const previous = readLock(FILTERS);
// Carry the previous stamp through so the diff reflects content alone; what the stamp should
// actually become is decided from that diff, below. Inventing a timestamp here would make
// every verify run look like a change.
const candidate = buildLock(registry, FILTERS, previous?.updated ?? null);
const diff = diffLock(previous, candidate);
const current = { ...candidate, updated: stampFor(previous, diff, new Date().toISOString()) };

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
    // Deliberately byte-identical to what was already there — including the stamp, so the
    // recorded age still reflects when upstream last actually changed.
    console.log(`No list content changed. Stamp left at ${current.updated} (age is upstream's, not ours).`);
  } else {
    console.log('lists.lock.json updated:\n');
    console.log(formatLockDiff(diff) || '  (first stamp)');
  }
}
