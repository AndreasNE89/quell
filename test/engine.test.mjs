// Tests for the pure-logic runtime engine (hostname, cosmetic matcher, procedural
// parser). These live in TypeScript, so we bundle them to a temp ESM module with
// esbuild (already a dependency) and import that — no DOM needed for these functions.

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
  const outfile = join(tmpdir(), `quell-engine-${process.pid}.mjs`);
  await build({
    stdin: {
      contents: `
        export { domainSuffixes, hostMatchesDomain, domainSpecMatches } from './src/shared/hostname.js';
        export { matchCosmetic } from './src/engine/cosmetic-match.js';
        export { parseProcedural } from './src/engine/procedural.js';
      `,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile,
  });
  mod = await import(`file://${outfile}?t=${Date.now()}`);
  process.on('exit', () => {
    try {
      rmSync(outfile);
    } catch {
      /* ignore */
    }
  });
});

test('domainSuffixes yields all parent domains', () => {
  const s = mod.domainSuffixes('ads.sub.example.co.uk');
  assert.ok(s.includes('example.co.uk'));
  assert.ok(s.includes('co.uk'));
  assert.ok(s.includes('ads.sub.example.co.uk'));
});

test('hostMatchesDomain handles exact and subdomain', () => {
  assert.equal(mod.hostMatchesDomain('www.example.com', 'example.com'), true);
  assert.equal(mod.hostMatchesDomain('example.com', 'example.com'), true);
  assert.equal(mod.hostMatchesDomain('notexample.com', 'example.com'), false);
  assert.equal(mod.hostMatchesDomain('evil-example.com', 'example.com'), false);
});

test('domainSpecMatches respects include/exclude', () => {
  assert.equal(mod.domainSpecMatches('a.com', { include: ['a.com'], exclude: [] }), true);
  assert.equal(mod.domainSpecMatches('b.com', { include: ['a.com'], exclude: [] }), false);
  assert.equal(mod.domainSpecMatches('x.com', { include: [], exclude: [] }), true); // generic
  assert.equal(mod.domainSpecMatches('a.com', { include: [], exclude: ['a.com'] }), false);
});

test('matchCosmetic gathers generic-free specific selectors and applies exceptions', () => {
  const data = {
    hideGeneric: ['.g'],
    unhideGeneric: [],
    hideSpecific: { 'example.com': ['.ad', '.promo'], 'com': ['.tld-wide'] },
    unhideSpecific: { 'example.com': ['.promo'] },
    procedural: [
      { domains: { include: ['example.com'], exclude: [] }, expr: '.x:has-text(y)' },
      { domains: { include: ['other.com'], exclude: [] }, expr: '.z' },
    ],
  };
  const m = mod.matchCosmetic('www.example.com', data);
  assert.ok(m.hide.includes('.ad'));
  assert.ok(!m.hide.includes('.promo'), 'specific unhide should cancel the hide');
  assert.equal(m.procedural.length, 1);
  assert.equal(m.procedural[0].expr, '.x:has-text(y)');
});

test('parseProcedural keeps native :has in prefix, splits at :has-text', () => {
  const r = mod.parseProcedural('.container:has(> .s):has-text(Ad)');
  assert.equal(r.prefix, '.container:has(> .s)');
  assert.equal(r.ops.length, 1);
  assert.equal(r.ops[0].name, 'has-text');
  assert.equal(r.ops[0].arg, 'Ad');
});

test('parseProcedural with leading xpath', () => {
  const r = mod.parseProcedural(':xpath(//div[@id="ad"])');
  assert.equal(r.prefix, '*');
  assert.equal(r.ops[0].name, 'xpath');
  assert.equal(r.ops[0].arg, '//div[@id="ad"]');
});

test('parseProcedural on a plain selector yields no ops', () => {
  const r = mod.parseProcedural('.just .css');
  assert.equal(r.prefix, '.just .css');
  assert.equal(r.ops.length, 0);
});

test('parseProcedural captures a trailing :not so it is not silently dropped', () => {
  const r = mod.parseProcedural('.a:has-text(x):not(.keep)');
  assert.equal(r.prefix, '.a');
  assert.deepEqual(
    r.ops.map((o) => o.name),
    ['has-text', 'not'],
  );
  assert.equal(r.ops[1].arg, '.keep');
});

test('quote-aware paren reading: a ) inside a string does not truncate the arg', () => {
  const r = mod.parseProcedural(':xpath(//a[text()=")"])');
  assert.equal(r.ops[0].name, 'xpath');
  assert.equal(r.ops[0].arg, '//a[text()=")"]');
});
