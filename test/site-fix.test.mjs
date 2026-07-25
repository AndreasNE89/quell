// Breakage repair ladder: graded per-site relaxation.
//
// The point of the ladder is that the cheap rungs keep network blocking on. A bug that let a
// repair step silently disable blocking would hand a site back its ads while the popup claimed
// blocking was active, so the resolver and the "what does this level switch off" predicates are
// worth pinning down precisely.

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
  const outfile = join(tmpdir(), `quell-sitefix-${process.pid}.mjs`);
  await build({
    stdin: {
      contents: `export * from './src/shared/site-fix.js';`,
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

test('no fixes means nothing is suppressed', () => {
  assert.equal(mod.resolveSiteFix('example.com', {}), null);
  assert.equal(mod.resolveSiteFix('example.com', undefined), null);
  assert.equal(mod.resolveSiteFix(null, { 'example.com': 'cosmetics' }), null);
  assert.equal(mod.fixDisablesCosmetics(null), false);
  assert.equal(mod.fixDisablesScriptlets(null), false);
});

test('a fix covers subdomains, like the allowlist does', () => {
  const fixes = { 'example.com': 'cosmetics' };
  assert.equal(mod.resolveSiteFix('example.com', fixes), 'cosmetics');
  assert.equal(mod.resolveSiteFix('www.example.com', fixes), 'cosmetics');
  assert.equal(mod.resolveSiteFix('shop.eu.example.com', fixes), 'cosmetics');
  // Not a suffix match on the label — notexample.com must not inherit example.com's fix.
  assert.equal(mod.resolveSiteFix('notexample.com', fixes), null);
  assert.equal(mod.resolveSiteFix('example.com.evil.test', fixes), null);
});

test('the more permissive entry wins when several cover one host', () => {
  // A parent fix plus a deeper one: the deeper host must get the stronger repair, or stepping
  // down the ladder on a subdomain would appear to do nothing.
  const fixes = { 'example.com': 'cosmetics', 'shop.example.com': 'injection' };
  assert.equal(mod.resolveSiteFix('shop.example.com', fixes), 'injection');
  assert.equal(mod.resolveSiteFix('deep.shop.example.com', fixes), 'injection');
  // A sibling subdomain only inherits the parent's rung.
  assert.equal(mod.resolveSiteFix('other.example.com', fixes), 'cosmetics');
});

test('www is not a distinct site', () => {
  // normalizeHostname strips a leading `www.`, so `www.example.com` and `example.com` are one
  // host throughout the extension. The Options manager must not imply they can differ.
  assert.equal(mod.resolveSiteFix('www.example.com', { 'example.com': 'injection' }), 'injection');
  assert.equal(mod.resolveSiteFix('example.com', { 'www.example.com': 'injection' }), 'injection');
});

test('cosmetics rung switches off hiding but NOT scriptlets', () => {
  assert.equal(mod.fixDisablesCosmetics('cosmetics'), true);
  assert.equal(mod.fixDisablesScriptlets('cosmetics'), false);
});

test('injection rung switches off both', () => {
  assert.equal(mod.fixDisablesCosmetics('injection'), true);
  assert.equal(mod.fixDisablesScriptlets('injection'), true);
});

test('the ladder walks down once and then defers to the allowlist', () => {
  assert.equal(mod.nextSiteFix(null), 'cosmetics');
  assert.equal(mod.nextSiteFix('cosmetics'), 'injection');
  // null at the bottom is the signal for "offer the allowlist instead", not "start over".
  assert.equal(mod.nextSiteFix('injection'), null);
});

test('host buckets drive the registered-script excludes', () => {
  const fixes = {
    'a.example': 'cosmetics',
    'b.example': 'injection',
    'c.example': 'cosmetics',
  };
  assert.deepEqual(mod.hostsWithCosmeticsOff(fixes).sort(), ['a.example', 'b.example', 'c.example']);
  // Only the injection rung may pull the MAIN-world scriptlet registration.
  assert.deepEqual(mod.hostsWithScriptletsOff(fixes), ['b.example']);
  assert.deepEqual(mod.hostsWithCosmeticsOff(undefined), []);
  assert.deepEqual(mod.hostsWithScriptletsOff(undefined), []);
});

test('labels are distinct so the options rows are readable', () => {
  const labels = [
    mod.siteFixLabel(null),
    mod.siteFixLabel('cosmetics'),
    mod.siteFixLabel('injection'),
  ];
  assert.equal(new Set(labels).size, 3);
  for (const l of labels) assert.ok(l.length > 0);
});
