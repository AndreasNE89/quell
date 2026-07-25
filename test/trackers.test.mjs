// Tracker-naming index for the page report.
//
// This is user-facing accuracy: the report exists to be trusted, so mislabeling a functional CDN
// as a tracker, or claiming "blocked" for a domain with no shipped rule, is worse than showing
// nothing. These tests pin the curated data's shape and the compiled artifact's honesty.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRACKER_ORGS, trackerDomainMap } from '../scripts/lib/trackers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_PATH = join(ROOT, 'src', 'generated', 'trackers.json');

test('every org has at least one non-empty domain', () => {
  const bad = Object.entries(TRACKER_ORGS)
    .filter(([, ds]) => !Array.isArray(ds) || !ds.length || ds.some((d) => !d?.trim()))
    .map(([label]) => label);
  assert.deepEqual(bad, [], 'orgs with empty or blank domain lists');
});

test('domains are lowercase, bare hostnames — no scheme, path or wildcard', () => {
  for (const [label, domains] of Object.entries(TRACKER_ORGS)) {
    for (const d of domains) {
      assert.equal(d, d.toLowerCase(), `${label}: ${d} must be lowercase`);
      assert.ok(!d.includes('/'), `${label}: ${d} must not contain a path`);
      assert.ok(!d.includes('*'), `${label}: ${d} must not contain a wildcard`);
      assert.ok(!d.includes(':'), `${label}: ${d} must not contain a scheme`);
      assert.ok(d.includes('.'), `${label}: ${d} must be a real domain`);
    }
  }
});

test('no domain is claimed by two organizations', () => {
  // A duplicate is silently resolved to whichever org is declared first, so the label a user
  // sees would depend on object ordering.
  const owner = new Map();
  const dupes = [];
  for (const [label, domains] of Object.entries(TRACKER_ORGS)) {
    for (const d of domains) {
      if (owner.has(d)) dupes.push(`${d}: ${owner.get(d)} vs ${label}`);
      else owner.set(d, label);
    }
  }
  assert.deepEqual(dupes, []);
});

test('functional asset CDNs are deliberately absent', () => {
  // Flagging Spotify album art or an avatar service as a tracker would cost the report its
  // credibility, which is the only thing that makes it worth showing.
  const map = trackerDomainMap();
  for (const cdn of [
    'fbcdn.net',
    'scdn.co',
    'ttvnw.net',
    'pinimg.com',
    'gravatar.com',
    'media-amazon.com',
    'licdn.com',
    'intercomcdn.com',
    'zdassets.com',
  ]) {
    assert.equal(map[cdn], undefined, `${cdn} should not be labeled a tracker`);
  }
});

test('the flattened map covers every declared domain', () => {
  const map = trackerDomainMap();
  const declared = new Set(Object.values(TRACKER_ORGS).flat());
  assert.equal(Object.keys(map).length, declared.size);
  for (const d of declared) assert.ok(map[d], `${d} missing from the flattened map`);
});

// The compiled artifact only exists after `npm run compile-filters`; skip rather than fail on a
// clean checkout, but assert hard once it is there.
const hasIndex = existsSync(INDEX_PATH);

test('compiled index marks blocked only where a rule exists', { skip: !hasIndex }, () => {
  const index = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
  const map = trackerDomainMap();

  assert.deepEqual(Object.keys(index.domains).sort(), Object.keys(map).sort());
  for (const [domain, entry] of Object.entries(index.domains)) {
    assert.equal(entry.label, map[domain], `${domain} label drifted from the curated list`);
    assert.equal(typeof entry.blocked, 'boolean', `${domain} must have a boolean blocked flag`);
  }

  // Cross-check a sample against the shipped rulesets directly, so a bug in buildTrackerIndex
  // cannot quietly mark everything blocked.
  const hosts = new Set();
  const dir = join(ROOT, 'src', 'generated', 'rulesets');
  for (const f of readdirSync(dir)) {
    for (const r of JSON.parse(readFileSync(join(dir, f), 'utf8'))) {
      const uf = r.condition?.urlFilter;
      if (r.action?.type === 'block' && uf) {
        const m = /^\|\|([a-z0-9.-]+)\^?/i.exec(uf);
        if (m) hosts.add(m[1].toLowerCase().replace(/\.$/, ''));
      }
    }
  }
  const reallyBlocked = (d) => hosts.has(d) || [...hosts].some((h) => h.endsWith(`.${d}`));
  for (const [domain, entry] of Object.entries(index.domains)) {
    assert.equal(entry.blocked, reallyBlocked(domain), `${domain} blocked flag is wrong`);
  }
});

test('compiled index stays small enough to inline in the worker', { skip: !hasIndex }, () => {
  // The whole reason this is curated rather than derived: 101k raw hostnames would be 2.2 MB.
  const bytes = readFileSync(INDEX_PATH).length;
  assert.ok(bytes < 64 * 1024, `tracker index grew to ${bytes} bytes; keep it under 64 KB`);
});

test('no curated domain is a public suffix', () => {
  // lookupTracker matches on label boundaries, so an entry like `co.uk` or `github.io` would
  // brand every site under that suffix with the label. Bare TLDs and known multi-tenant
  // suffixes must never appear.
  const map = trackerDomainMap();
  const suffixes = new Set([
    'co.uk',
    'com.au',
    'co.jp',
    'github.io',
    'blogspot.com',
    'pages.dev',
    'vercel.app',
    'netlify.app',
    'herokuapp.com',
    'workers.dev',
    'web.app',
    'firebaseapp.com',
    'azurewebsites.net',
    'appspot.com',
  ]);
  const offenders = Object.keys(map).filter(
    (d) => suffixes.has(d) || d.split('.').length < 2,
  );
  assert.deepEqual(offenders, [], 'curated domains that would over-match');
});
