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
// A corrupt lock is fatal when verifying and recoverable when rewriting.
//
// `--check` must fail: it exists to prove disk matches the record, and a record nobody can
// read proves nothing. But the rewrite path is the documented way out of that state, so it
// cannot fail for the same reason — it used to print "re-stamp: npm run lock-lists", which is
// this command, which then exited the same way. The only escape was deleting the file by hand.
let previous = null;
let recovered = false;
try {
  previous = readLock(FILTERS);
} catch (e) {
  if (e?.code !== 'LOCK_CORRUPT') throw e;
  if (check) {
    console.error('filters/lists.lock.json is not valid JSON.');
    console.error('Rewrite it from the lists on disk: npm run lock-lists');
    process.exit(1);
  }
  recovered = true;
}
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
  if (recovered) {
    // The stamp means "when this content arrived", and a corrupt file took that date with it.
    // The lists on disk have not moved, so `now` overstates their freshness — say so rather
    // than let the Options age line quietly restart from today.
    console.warn('filters/lists.lock.json was unreadable — rewritten from the lists on disk.');
    console.warn(`  The previous refresh date was lost; the stamp now reads ${current.updated}.`);
    console.warn('  If the lists are older than that, run npm run update-lists to make it true.');
  } else if (diff.clean && previous) {
    // Deliberately byte-identical to what was already there — including the stamp, so the
    // recorded age still reflects when upstream last actually changed.
    console.log(`No list content changed. Stamp left at ${current.updated} (age is upstream's, not ours).`);
  } else {
    console.log('lists.lock.json updated:\n');
    console.log(formatLockDiff(diff) || '  (first stamp)');
  }
}
