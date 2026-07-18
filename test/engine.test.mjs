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
        export { domainSuffixes, hostMatchesDomain, domainSpecMatches, normalizeHostname, isAllowlistedHost, isValidMatchPatternHost } from './src/shared/hostname.js';
        export { matchCosmetic, matchScriptlets, mergeCosmeticLists } from './src/engine/cosmetic-match.js';
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

test('should match entity domains ending in .* against registrable name', () => {
  assert.equal(mod.hostMatchesDomain('example.com', 'example.*'), true);
  assert.equal(mod.hostMatchesDomain('www.example.org', 'example.*'), true);
  assert.equal(mod.hostMatchesDomain('ads.example.co.uk', 'example.*'), true);
  assert.equal(mod.hostMatchesDomain('notexample.com', 'example.*'), false);
  assert.equal(mod.hostMatchesDomain('example.evil.com', 'example.*'), false);
});

test('should reject IPv6 and garbage hosts for match patterns', () => {
  assert.equal(mod.isValidMatchPatternHost('example.com'), true);
  assert.equal(mod.isValidMatchPatternHost('192.168.1.1'), true);
  assert.equal(mod.isValidMatchPatternHost(''), false);
  assert.equal(mod.isValidMatchPatternHost('2001:db8::1'), false);
  assert.equal(mod.isValidMatchPatternHost('[2001:db8::1]'), false);
  assert.equal(mod.isValidMatchPatternHost('bad host'), false);
  assert.equal(mod.isValidMatchPatternHost('ex_ample.com'), false);
});

test('domainSpecMatches respects include/exclude', () => {
  assert.equal(mod.domainSpecMatches('a.com', { include: ['a.com'], exclude: [] }), true);
  assert.equal(mod.domainSpecMatches('b.com', { include: ['a.com'], exclude: [] }), false);
  assert.equal(mod.domainSpecMatches('x.com', { include: [], exclude: [] }), true); // generic
  assert.equal(mod.domainSpecMatches('a.com', { include: [], exclude: ['a.com'] }), false);
});

test('matchCosmetic gathers generic-free specific selectors and applies exceptions', () => {
  const data = {
    byList: {
      seed: {
        hideGeneric: ['.g'],
        unhideGeneric: [],
        hideSpecific: { 'example.com': ['.ad', '.promo'], 'com': ['.tld-wide'] },
        unhideSpecific: { 'example.com': ['.promo'] },
        procedural: [
          { domains: { include: ['example.com'], exclude: [] }, expr: '.x:has-text(y)' },
          { domains: { include: ['other.com'], exclude: [] }, expr: '.z' },
        ],
      },
    },
    networkExceptions: { generichide: [], elemhide: [], specifichide: [] },
  };
  const m = mod.matchCosmetic('www.example.com', data, ['seed']);
  assert.ok(m.hide.includes('.ad'));
  assert.ok(!m.hide.includes('.promo'), 'specific unhide should cancel the hide');
  assert.equal(m.procedural.length, 1);
  assert.equal(m.procedural[0].expr, '.x:has-text(y)');
});

test('should apply hideSpecific keys keyed as entity.*', () => {
  const data = {
    byList: {
      seed: {
        hideGeneric: [],
        unhideGeneric: [],
        hideSpecific: { 'example.*': ['.entity-ad'] },
        unhideSpecific: {},
        procedural: [],
      },
    },
    networkExceptions: { generichide: [], elemhide: [], specifichide: [] },
  };
  const m = mod.matchCosmetic('www.example.co.uk', data, ['seed']);
  assert.ok(m.hide.includes('.entity-ad'));
  const miss = mod.matchCosmetic('other.com', data, ['seed']);
  assert.ok(!miss.hide.includes('.entity-ad'));
});

test('matchCosmetic honors mixed include/exclude via unhideSpecific cancel', () => {
  const data = {
    byList: {
      seed: {
        hideGeneric: [],
        unhideGeneric: [],
        hideSpecific: { 'example.com': ['.ad'] },
        unhideSpecific: { 'ads.example.com': ['.ad'] },
        procedural: [],
      },
    },
    networkExceptions: { generichide: [], elemhide: [], specifichide: [] },
  };
  const parent = mod.matchCosmetic('www.example.com', data, ['seed']);
  assert.ok(parent.hide.includes('.ad'));
  const child = mod.matchCosmetic('ads.example.com', data, ['seed']);
  assert.ok(!child.hide.includes('.ad'), 'exclude domain should cancel via unhide');
});

test('matchCosmetic generichide returns generic selectors as unhide', () => {
  const data = {
    byList: {
      seed: {
        hideGeneric: ['.g'],
        unhideGeneric: [],
        hideSpecific: {},
        unhideSpecific: {},
        procedural: [],
      },
    },
    networkExceptions: { generichide: ['example.com'], elemhide: [], specifichide: [] },
  };
  const m = mod.matchCosmetic('www.example.com', data, ['seed']);
  assert.equal(m.disableGeneric, true);
  assert.ok(m.unhide.includes('.g'));
});

test('should honor entity-domain generichide hosts (google.* / gmx.*)', () => {
  const data = {
    byList: {
      seed: {
        hideGeneric: ['.ad-slot'],
        unhideGeneric: [],
        hideSpecific: {},
        unhideSpecific: {},
        procedural: [],
      },
    },
    networkExceptions: { generichide: ['google.*', 'gmx.*'], elemhide: [], specifichide: [] },
  };
  const serp = mod.matchCosmetic('www.google.com', data, ['seed']);
  assert.equal(serp.disableGeneric, true);
  assert.ok(serp.unhide.includes('.ad-slot'));
  const gmx = mod.matchCosmetic('www.gmx.net', data, ['seed']);
  assert.equal(gmx.disableGeneric, true);
  const other = mod.matchCosmetic('example.com', data, ['seed']);
  assert.equal(other.disableGeneric, false);
});

test('should apply trailing-dot generichide entity keys to matching sites only', () => {
  // hostsFromPattern maps ||stream4free. / ||asd. → label.*; bare `asd` would
  // wrongly match evil.asd while missing asd.homes.
  const data = {
    byList: {
      seed: {
        hideGeneric: ['.ad-slot'],
        unhideGeneric: [],
        hideSpecific: {},
        unhideSpecific: {},
        procedural: [],
      },
    },
    networkExceptions: {
      generichide: ['stream4free.*', 'asd.*', 'asd.homes'],
      elemhide: [],
      specifichide: [],
    },
  };
  assert.equal(mod.matchCosmetic('stream4free.tv', data, ['seed']).disableGeneric, true);
  assert.equal(mod.matchCosmetic('asd.homes', data, ['seed']).disableGeneric, true);
  assert.equal(mod.matchCosmetic('evil.asd', data, ['seed']).disableGeneric, false);
  assert.equal(mod.matchCosmetic('example.com', data, ['seed']).disableGeneric, false);
});

test('matchScriptlets applies exceptions and dedupes', () => {
  const data = {
    byList: {
      a: {
        scriptlets: [
          { domains: { include: ['example.com'], exclude: [] }, name: 'set-constant', args: ['x', 'true'] },
          { domains: { include: ['example.com'], exclude: [] }, name: 'set-constant', args: ['x', 'true'] },
        ],
        exceptions: [
          { domains: { include: ['example.com'], exclude: [] }, name: 'abort-on-property-read', args: ['ads'] },
        ],
      },
      b: {
        scriptlets: [
          { domains: { include: ['example.com'], exclude: [] }, name: 'abort-on-property-read', args: ['ads'] },
        ],
        exceptions: [],
      },
    },
  };
  const rules = mod.matchScriptlets('example.com', data, ['a', 'b']);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].name, 'set-constant');
});

test('normalizeHostname strips www', () => {
  assert.equal(mod.normalizeHostname('www.Example.COM'), 'example.com');
  assert.equal(mod.isAllowlistedHost('www.example.com', ['example.com']), true);
});

test('disabled lists are excluded from mergeCosmeticLists', () => {
  const data = {
    byList: {
      on: {
        hideGeneric: ['.on'],
        unhideGeneric: [],
        hideSpecific: { 'example.com': ['.a'] },
        unhideSpecific: {},
        procedural: [],
      },
      off: {
        hideGeneric: ['.off'],
        unhideGeneric: [],
        hideSpecific: { 'example.com': ['.b'] },
        unhideSpecific: {},
        procedural: [],
      },
    },
    networkExceptions: { generichide: [], elemhide: [], specifichide: [] },
  };
  const m = mod.matchCosmetic('example.com', data, ['on']);
  assert.ok(m.hide.includes('.a'));
  assert.ok(!m.hide.includes('.b'));
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

test('should keep trailing CSS after a procedural op', () => {
  const r = mod.parseProcedural('.ad:has-text(Sponsored) > .inner');
  assert.equal(r.prefix, '.ad');
  assert.deepEqual(
    r.ops.map((o) => o.name),
    ['has-text', 'selector'],
  );
  assert.equal(r.ops[0].arg, 'Sponsored');
  assert.equal(r.ops[1].arg, '> .inner');
});

test('quote-aware paren reading: a ) inside a string does not truncate the arg', () => {
  const r = mod.parseProcedural(':xpath(//a[text()=")"])');
  assert.equal(r.ops[0].name, 'xpath');
  assert.equal(r.ops[0].arg, '//a[text()=")"]');
});
