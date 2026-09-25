// The store package gate: the zip it writes and reads back (scripts/lib/zip.mjs), and the
// per-list and ruleset checks it runs on dist/ (scripts/lib/package-checks.mjs).
//
// - The readback scanned every byte for the central-directory signature, so any `PK\x01\x02`
//   inside compressed data made a valid package fail, every time, until its content changed.
// - The only rule check was a 50,000 total: EasyPrivacy replaced by an error page still left
//   73,493 rules, and a default list whose file was missing only produced a compile warning.
// (REVIEW_2026-09-24 B74 and the zip readback P3.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readZipEntries, zipDirectory } from '../scripts/lib/zip.mjs';
import { listFloorProblems, rulesetProblems } from '../scripts/lib/package-checks.mjs';

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'stampstack-zip-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

/** The old readback: count every offset that holds the central-directory signature. */
function signatureScanCount(buf) {
  let n = 0;
  for (let i = 0; i + 46 <= buf.length; i++) if (buf.readUInt32LE(i) === 0x02014b50) n++;
  return n;
}

test('a zip whose stored content contains the central-directory signature reads back exactly', () => {
  // Random bytes do not deflate, so they are stored as is: the signature lands in the archive
  // body verbatim, which is what a compressed ruleset or icon can do by chance.
  const noise = Buffer.alloc(4096);
  let x = 2463534242; // xorshift32: deterministic, incompressible
  for (let i = 0; i < noise.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    noise[i] = x & 0xff;
  }
  const trap = Buffer.concat([noise.subarray(0, 100), Buffer.from([0x50, 0x4b, 0x01, 0x02]), noise.subarray(100)]);
  const dir = tree({ 'manifest.json': '{"manifest_version":3}', 'icons/icon.png': trap, 'a/b/c.js': 'x'.repeat(5000) });
  try {
    const { bytes, names } = zipDirectory(dir);
    assert.deepEqual(names, ['a/b/c.js', 'icons/icon.png', 'manifest.json']);
    assert.ok(signatureScanCount(bytes) > names.length, 'fixture: the old scan would have seen an extra entry');
    const entries = readZipEntries(bytes);
    assert.deepEqual(entries.map((e) => e.name), names);
    assert.deepEqual(entries.map((e) => e.size), [5000, trap.length, 22]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the same tree always zips to the same bytes', () => {
  const dir = tree({ 'manifest.json': '{}', 'x/y.txt': 'hello\n' });
  try {
    assert.deepEqual(zipDirectory(dir).bytes, zipDirectory(dir).bytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a damaged or non-ZIP file is rejected by the readback', () => {
  const dir = tree({ 'manifest.json': '{"a":1}', 'b.txt': 'b'.repeat(300) });
  try {
    const { bytes } = zipDirectory(dir);
    assert.throws(() => readZipEntries(Buffer.from('ustar tar archive, not a zip')), /not a ZIP/);
    assert.throws(() => readZipEntries(bytes.subarray(0, bytes.length - 10)), /end-of-central-directory/);
    const corrupt = Buffer.from(bytes);
    corrupt[40] ^= 0xff; // inside the first entry's data
    assert.throws(() => readZipEntries(corrupt), /CRC|invalid|incorrect/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- package checks ------------------------------------------------------------------------------

const REGISTRY = {
  lists: [
    { id: 'quell-seed', enabledByDefault: true, file: 'quell-seed.txt' },
    { id: 'easylist', enabledByDefault: true, file: 'easylist.txt', minRules: 25000 },
    { id: 'easyprivacy', enabledByDefault: true, file: 'easyprivacy.txt', minRules: 28000 },
    { id: 'easylist-china', enabledByDefault: false, file: 'easylist-china.txt', minRules: 6000 },
  ],
};
const resources = (ids) =>
  ids.map((id) => ({ id, enabled: id !== 'easylist-china', path: `generated/rulesets/${id}.json` }));
const counts = (map) => (path) => map[/rulesets\/(.+)\.json$/.exec(path)[1]] ?? null;

test('a healthy package passes the per-list checks', () => {
  const ok = counts({ 'quell-seed': 103, easylist: 50191, easyprivacy: 55998, 'easylist-china': 12133 });
  assert.deepEqual(listFloorProblems(REGISTRY, resources(REGISTRY.lists.map((l) => l.id)), ok), []);
});

test('EasyPrivacy replaced by an error page fails its floor, although the total still looks healthy', () => {
  const broken = counts({ 'quell-seed': 103, easylist: 50191, easyprivacy: 0, 'easylist-china': 12133 });
  const problems = listFloorProblems(REGISTRY, resources(REGISTRY.lists.map((l) => l.id)), broken);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^easyprivacy: 0 DNR rules, under its floor of 28000/);
});

test('a registry list missing from the manifest is fatal, default-on or not', () => {
  const ok = counts({ 'quell-seed': 103, easylist: 50191, easyprivacy: 55998 });
  const problems = listFloorProblems(REGISTRY, resources(['quell-seed', 'easylist', 'easyprivacy']), ok);
  assert.deepEqual(problems.map((p) => p.split(':')[0]), ['easylist-china']);
  const noDefault = listFloorProblems(REGISTRY, resources(['quell-seed', 'easylist', 'easylist-china']), ok);
  assert.match(noDefault.join('\n'), /easyprivacy: no ruleset in the manifest/);
});

test('an unreadable ruleset file and a flipped default are reported', () => {
  const problems = listFloorProblems(
    REGISTRY,
    [
      ...resources(['quell-seed', 'easylist']),
      { id: 'easyprivacy', enabled: false, path: 'generated/rulesets/easyprivacy.json' },
      { id: 'easylist-china', enabled: false, path: 'generated/rulesets/easylist-china.json' },
    ],
    counts({ 'quell-seed': 103, easylist: 50191, easyprivacy: 55998 }),
  );
  assert.ok(problems.some((p) => /^easyprivacy: the manifest has it off by default, lists.json on/.test(p)));
  assert.ok(problems.some((p) => /^easylist-china: .* missing or unreadable/.test(p)));
});

test("Chrome's static ruleset limits and unique ids are checked", () => {
  const many = (n, enabled) => Array.from({ length: n }, (_, i) => ({ id: `l${i}`, enabled }));
  assert.deepEqual(rulesetProblems(many(100, false)), []);
  assert.deepEqual(rulesetProblems(many(50, true)), []);
  assert.match(rulesetProblems(many(101, false)).join(), /101 static rulesets/);
  assert.match(rulesetProblems(many(51, true)).join(), /51 rulesets enabled/);
  assert.match(rulesetProblems([{ id: 'a', enabled: true }, { id: 'a', enabled: false }]).join(), /duplicate ruleset id "a"/);
});
