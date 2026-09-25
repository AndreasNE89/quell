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
  assert.deepEqual(mod.customCosmeticsFor(text, 'a.com'), { hide: [], unhide: ['.ad'], procedural: [] });
  assert.deepEqual(mod.customCosmeticsFor(text, 'b.com'), { hide: ['.ad'], unhide: [], procedural: [] });
});

test('a selector with an unclosed quote, bracket or paren, or a trailing backslash, is an error', () => {
  // Each of these passes querySelector (it closes them at end of input) and, joined into the
  // page's stylesheet, swallowed every hide after it.
  for (const sel of ['div[title="Sponsored', 'a[href*="promo"', 'div:not(.foo', '.keep\\', 'a[x]]', 'div)']) {
    const { filters, errors } = mod.parseCustomFilters(`example.com##${sel}`);
    assert.equal(filters.length, 0, sel);
    assert.equal(errors.length, 1, sel);
  }
  // Escapes and quoted brackets are fine.
  const ok = mod.parseCustomFilters('example.com##a[title="x ] ("]\nexample.com##.a\\:b');
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.filters.length, 2);
});

test('procedural and action rules are routed to the procedural engine, not counted as dead CSS', () => {
  const text = [
    'example.com##.post:has-text(Sponsored)',
    'example.com#?#div:has-text(Ad)',
    'example.com##.hero:style(margin-top: 0 !important)',
    'example.com##.x:has(.y:has-text(z))',
    'example.com##.gone:remove()',
  ].join('\n');
  const { filters, errors } = mod.parseCustomFilters(text);
  assert.deepEqual(errors, []);
  assert.deepEqual(filters.map((f) => !!f.procedural), [true, true, true, true, true]);
  const out = mod.customCosmeticsFor(text, 'www.example.com');
  assert.deepEqual(out.hide, []);
  assert.deepEqual(
    out.procedural.map((p) => p.expr),
    [
      '.post:has-text(Sponsored)',
      'div:has-text(Ad)',
      '.hero:style(margin-top: 0 !important)',
      '.x:has(.y:has-text(z))',
      '.gone:remove()',
    ],
  );
  // A plain :has() is CSS the browser applies itself.
  assert.deepEqual(mod.customCosmeticsFor('example.com##.x:has(> .y)', 'example.com').hide, ['.x:has(> .y)']);
  // A procedural exception cancels the identical procedural hide.
  const cancelled = mod.customCosmeticsFor(
    'example.com##.post:has-text(Sponsored)\nexample.com#@#.post:has-text(Sponsored)',
    'example.com',
  );
  assert.deepEqual(cancelled.procedural, []);
});

test('rules that can never apply are errors with a reason', () => {
  const cases = [
    ['example.com##+js(set, foo, 1)', /\+js/],
    ['example.com##^script:has-text(ad)', /HTML/],
    ['example.com##.x:style(background: url(https://t.test/p.gif))', /resources/],
    ['example.com##.x:style(nonsense)', /declaration/],
    ['example.com##.x:others()', /not support/],
    ['example.com##.x:remove-class()', /needs a name/],
    ['example.com##.x:style(color: red):has-text(y)', /last/],
    ['example.com#$#body { color: red }', /AdGuard/],
    ['example.com,~a.example.com##.x', /~/],
  ];
  for (const [line, reason] of cases) {
    const { filters, errors } = mod.parseCustomFilters(line);
    assert.equal(filters.length, 0, line);
    assert.match(errors[0]?.reason ?? '', reason, line);
  }
});

test('entity, single-label, IPv6 and Unicode hosts are accepted and match', () => {
  const { filters, errors } = mod.parseCustomFilters(
    ['google.*##.ad', 'localhost##.ad', 'intranet##.ad', '[::1]##.ad', 'bücher.de##.ad'].join('\n'),
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(
    filters.map((f) => f.domains[0]),
    ['google.*', 'localhost', 'intranet', '[::1]', 'xn--bcher-kva.de'],
  );
  assert.deepEqual(mod.customCosmeticsFor('google.*##.ad', 'www.google.co.uk').hide, ['.ad']);
  assert.deepEqual(mod.customCosmeticsFor('google.*##.ad', 'google.de').hide, ['.ad']);
  assert.deepEqual(mod.customCosmeticsFor('google.*##.ad', 'notgoogle.com').hide, []);
  assert.deepEqual(mod.customCosmeticsFor('localhost##.ad', 'localhost').hide, ['.ad']);
  assert.deepEqual(mod.customCosmeticsFor('bücher.de##.ad', 'xn--bcher-kva.de').hide, ['.ad']);
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

test('the text is parsed once, not on every page that asks (P3)', () => {
  // Every frame of every page asks the worker for its cosmetics; the text changes only on edits.
  const lines = [];
  for (let i = 0; i < 1500; i++) {
    lines.push(`site${i}.example##.ad-${i}`, `site${i}.example##.card-${i}:has-text(Sponsored ${i})`);
  }
  const text = lines.join('\n');
  const time = (fn) => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };
  const cold = time(() => mod.customCosmeticsFor(`${text}\n! first`, 'site7.example'));
  const warm = time(() => {
    for (let i = 0; i < 40; i++) mod.customCosmeticsFor(`${text}\n! first`, `site${i}.example`);
  });
  assert.ok(warm < cold * 8, `40 lookups took ${warm.toFixed(1)} ms, one parse ${cold.toFixed(1)} ms`);
  // An edit is seen at once.
  assert.deepEqual(mod.customCosmeticsFor(`${text}\nsite7.example##.new`, 'site7.example').hide, ['.ad-7', '.new']);
  assert.deepEqual(mod.customCosmeticsFor(text, 'site7.example').hide, ['.ad-7']);
});
