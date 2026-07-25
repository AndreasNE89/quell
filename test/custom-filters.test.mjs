// The user's own cosmetic filters: parsing, scoping, and the append the picker relies on.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let mod;

before(async () => {
  const outfile = join(tmpdir(), `quell-customfilters-${process.pid}.mjs`);
  await build({
    stdin: {
      contents: `export * from './src/shared/custom-filters.js';`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile,
  });
  mod = await import(`file://${outfile}?t=${process.pid}`);
  process.on('exit', () => {
    try {
      rmSync(outfile);
    } catch {
      /* ignore */
    }
  });
});

test('parses a domain-scoped hide', () => {
  const { filters, errors } = mod.parseCustomFilters('example.com##.ad-slot');
  assert.deepEqual(errors, []);
  assert.equal(filters.length, 1);
  assert.deepEqual(filters[0], {
    kind: 'hide',
    domains: ['example.com'],
    selector: '.ad-slot',
    line: 1,
  });
});

test('parses multiple domains, an exception, and a global rule', () => {
  const { filters, errors } = mod.parseCustomFilters(
    ['a.com,b.com##.ad', 'a.com#@#.ad', '##.global-ad'].join('\n'),
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(
    filters.map((f) => [f.kind, f.domains, f.selector]),
    [
      ['hide', ['a.com', 'b.com'], '.ad'],
      ['unhide', ['a.com'], '.ad'],
      ['hide', [], '.global-ad'],
    ],
  );
});

test('comments and blank lines are skipped silently', () => {
  const { filters, errors } = mod.parseCustomFilters('! a comment\n\n   \nexample.com##.x');
  assert.deepEqual(errors, []);
  assert.equal(filters.length, 1);
  assert.equal(filters[0].line, 4, 'line numbers must survive skipped lines');
});

test('#@# is detected before ##, so exceptions are not read as hides', () => {
  // `#@#` contains no `##`, but a naive indexOf('##') ordering still gets this wrong on
  // selectors that themselves contain `#`.
  const { filters } = mod.parseCustomFilters('example.com#@##some-id');
  assert.equal(filters[0].kind, 'unhide');
  assert.equal(filters[0].selector, '#some-id');
});

test('network syntax is reported, not silently dropped', () => {
  const { filters, errors } = mod.parseCustomFilters('||ads.example^\n@@||good.example^');
  assert.equal(filters.length, 0);
  assert.equal(errors.length, 2);
  for (const e of errors) assert.match(e.reason, /Network rules/);
});

test('unsafe selectors are rejected', () => {
  const bad = [
    'example.com##a{}body{display:none}',
    'example.com##.x/*comment*/',
    'example.com##<script>',
    'example.com##',
  ];
  for (const line of bad) {
    const { filters, errors } = mod.parseCustomFilters(line);
    assert.equal(filters.length, 0, line);
    assert.equal(errors.length, 1, line);
  }
});

test('a garbage domain is an error, not a silent global rule', () => {
  // The dangerous failure: dropping the bad host and keeping the selector would turn a
  // site-scoped rule into one that hides that selector everywhere.
  const { filters, errors } = mod.parseCustomFilters('not a host##.ad');
  assert.equal(filters.length, 0);
  assert.equal(errors.length, 1);
});

test('a line with no separator is an error', () => {
  const { filters, errors } = mod.parseCustomFilters('example.com .ad-slot');
  assert.equal(filters.length, 0);
  assert.match(errors[0].reason, /example\.com##/);
});

test('scoping matches the host and its subdomains only', () => {
  const f = { kind: 'hide', domains: ['example.com'], selector: '.x', line: 1 };
  assert.equal(mod.filterAppliesTo(f, 'example.com'), true);
  assert.equal(mod.filterAppliesTo(f, 'www.example.com'), true);
  assert.equal(mod.filterAppliesTo(f, 'deep.a.example.com'), true);
  assert.equal(mod.filterAppliesTo(f, 'notexample.com'), false);
  assert.equal(mod.filterAppliesTo(f, 'example.com.evil.test'), false);
});

test('a global rule applies everywhere', () => {
  const f = { kind: 'hide', domains: [], selector: '.x', line: 1 };
  assert.equal(mod.filterAppliesTo(f, 'anything.test'), true);
});

test('an exception cancels the user own hide for that host only', () => {
  const text = ['a.com,b.com##.ad', 'a.com#@#.ad'].join('\n');
  assert.deepEqual(mod.customCosmeticsFor(text, 'a.com'), { hide: [], unhide: ['.ad'] });
  assert.deepEqual(mod.customCosmeticsFor(text, 'b.com'), { hide: ['.ad'], unhide: [] });
});

test('cosmetics are deduped and scoped per host', () => {
  const text = ['example.com##.a', 'example.com##.a', 'other.com##.b', '##.c'].join('\n');
  const out = mod.customCosmeticsFor(text, 'example.com');
  assert.deepEqual(out.hide.sort(), ['.a', '.c']);
});

test('appendFilterLine adds, skips exact duplicates, and keeps a trailing newline', () => {
  let text = mod.appendFilterLine('', 'example.com##.a');
  assert.equal(text, 'example.com##.a\n');
  text = mod.appendFilterLine(text, 'example.com##.b');
  assert.equal(text, 'example.com##.a\nexample.com##.b\n');
  const same = mod.appendFilterLine(text, 'example.com##.b');
  assert.equal(same, text, 'a duplicate pick must not grow the list');
  const spaced = mod.appendFilterLine(text, '  example.com##.b  ');
  assert.equal(spaced, text, 'duplicate detection must ignore surrounding whitespace');
});

test('appendFilterLine does not lose the user comments', () => {
  const text = mod.appendFilterLine('! my rules\nexample.com##.a\n', 'example.com##.b');
  assert.equal(text, '! my rules\nexample.com##.a\nexample.com##.b\n');
});
