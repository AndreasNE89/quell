// Page-report classification: hostnames in, named organizations out.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let mod;

const INDEX = {
  domains: {
    'doubleclick.net': { label: 'Google Ads', blocked: true },
    'google-analytics.com': { label: 'Google Analytics', blocked: true },
    'googletagmanager.com': { label: 'Google Analytics', blocked: true },
    'criteo.com': { label: 'Criteo', blocked: true },
    'plausible.io': { label: 'Plausible', blocked: false },
    'co.uk': { label: 'Bogus Suffix', blocked: true },
  },
};

before(async () => {
  const outfile = join(tmpdir(), `quell-pagereport-${process.pid}.mjs`);
  await build({
    stdin: {
      contents: `export * from './src/shared/page-report.js';`,
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

test('exact host matches', () => {
  assert.equal(mod.lookupTracker('doubleclick.net', INDEX).label, 'Google Ads');
  assert.equal(mod.lookupTracker('DoubleClick.NET', INDEX).label, 'Google Ads');
  assert.equal(mod.lookupTracker('doubleclick.net.', INDEX).label, 'Google Ads');
});

test('subdomains resolve to the parent organization', () => {
  assert.equal(mod.lookupTracker('stats.g.doubleclick.net', INDEX).label, 'Google Ads');
  assert.equal(mod.lookupTracker('cdn.eu.criteo.com', INDEX).label, 'Criteo');
});

test('label-boundary only — a lookalike host must not match', () => {
  // The dangerous failure: substring matching would brand an innocent site as a tracker.
  assert.equal(mod.lookupTracker('notdoubleclick.net', INDEX), null);
  assert.equal(mod.lookupTracker('mycriteo.com', INDEX), null);
  assert.equal(mod.lookupTracker('doubleclick.net.evil.test', INDEX), null);
});

test('unknown and degenerate hosts return null', () => {
  assert.equal(mod.lookupTracker('example.com', INDEX), null);
  assert.equal(mod.lookupTracker('localhost', INDEX), null);
  assert.equal(mod.lookupTracker('', INDEX), null);
  assert.equal(mod.lookupTracker('.', INDEX), null);
});

test('a single-label suffix can never be reached by the walk', () => {
  // The walk stops before the bare TLD, so a stray one-label index entry stays inert rather
  // than labeling every .net host.
  const withTld = { domains: { net: { label: 'Everything', blocked: true } } };
  assert.equal(mod.lookupTracker('anything.net', withTld), null);
});

test('a two-label public suffix entry still only matches on boundaries', () => {
  // `co.uk` in the index is a data bug, but it must not label a random .co.uk site as
  // something it is not... it will match, so this documents the real behavior rather than
  // pretending otherwise — which is why the curated list must not contain suffixes.
  assert.equal(mod.lookupTracker('shop.co.uk', INDEX).label, 'Bogus Suffix');
  assert.equal(mod.lookupTracker('notco.uk', INDEX), null);
});

test('one row per organization, not per host', () => {
  const { trackers, unnamedThirdParty } = mod.classifyHosts(
    [
      'www.google-analytics.com',
      'ssl.google-analytics.com',
      'googletagmanager.com',
      'stats.g.doubleclick.net',
    ],
    INDEX,
  );
  assert.deepEqual(
    trackers.map((t) => t.label),
    ['Google Ads', 'Google Analytics'],
  );
  assert.equal(unnamedThirdParty, 0);
});

test('unblocked organizations sort first and win the dedupe', () => {
  const index = {
    domains: {
      'a.example': { label: 'Acme', blocked: true },
      'b.example': { label: 'Acme', blocked: false },
      'c.example': { label: 'Zeta', blocked: true },
    },
  };
  const { trackers } = mod.classifyHosts(['a.example', 'b.example', 'c.example'], index);
  assert.deepEqual(
    trackers.map((t) => [t.label, t.blocked]),
    [
      ['Acme', false],
      ['Zeta', true],
    ],
  );
});

test('unnamed hosts are counted, never guessed at', () => {
  const { trackers, unnamedThirdApparty, unnamedThirdParty } = mod.classifyHosts(
    ['cdn.somesite.test', 'api.other.test', 'criteo.com'],
    INDEX,
  );
  assert.equal(unnamedThirdApparty, undefined);
  assert.equal(unnamedThirdParty, 2);
  assert.deepEqual(
    trackers.map((t) => t.label),
    ['Criteo'],
  );
});

test('junk entries are skipped rather than throwing', () => {
  const { trackers, unnamedThirdParty } = mod.classifyHosts(
    [null, undefined, 42, '', {}, 'criteo.com'],
    INDEX,
  );
  assert.equal(unnamedThirdParty, 0);
  assert.deepEqual(
    trackers.map((t) => t.label),
    ['Criteo'],
  );
});

// --- blocked, from the lists Chrome has loaded (REVIEW_2026-09-24 B39) -------------------
// A compile-time "blocked" called OneTrust blocked with EasyList Cookie off, and 55 trackers
// blocked with EasyPrivacy off. The index now names the lists; the worker passes the loaded ones.

const LISTED = {
  domains: {
    'cookielaw.org': { label: 'OneTrust', blocked: true, lists: ['easylist-cookie'] },
    'google-analytics.com': { label: 'Google Analytics', blocked: true, lists: ['easyprivacy', 'ubo-filters'] },
    'hotjar.com': { label: 'Hotjar', blocked: true, lists: [], partial: ['easyprivacy'] },
  },
};

test('a tracker is blocked only while one of its lists is loaded', () => {
  const loaded = new Set(['quell-seed', 'easylist', 'easyprivacy']);
  const { trackers } = mod.classifyHosts(
    ['cdn.cookielaw.org', 'www.google-analytics.com', 'static.hotjar.com'],
    LISTED,
    loaded,
  );
  const by = Object.fromEntries(trackers.map((t) => [t.label, t]));
  assert.equal(by.OneTrust.blocked, false, 'the cookie list is off');
  assert.equal(by['Google Analytics'].blocked, true);
  assert.equal(by.Hotjar.blocked, false);
  assert.equal(by.Hotjar.partial, true, 'only some of its requests are blocked');
  assert.equal(mod.classifyHosts(['www.google-analytics.com'], LISTED, new Set()).trackers[0].blocked, false);
});

test('an index without lists keeps its compile-time answer', () => {
  const { trackers } = mod.classifyHosts(['plausible.io', 'doubleclick.net'], INDEX, new Set());
  assert.deepEqual(
    trackers.map((t) => [t.label, t.blocked]),
    [['Plausible', false], ['Google Ads', true]],
  );
});
