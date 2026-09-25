// Match patterns built from hostnames must be patterns Chrome accepts, for the host we meant.
//
// B3 (REVIEW_2026-09-24): EasyList China's `@@||192.168.*.1/$generichide` was cut down to the
// host `192.168`, the validator accepted it, and allowlistMatchPatterns emitted
// `*://www.192.168/*`. Chrome rejects the whole registerContentScripts call over one invalid
// exclude ("exclude_matches[3800]: Invalid host"), so every zh-* install lost generic hiding.
// Typing `10.0.0` into Options > Add a site did the same to anyone.
//
// Nothing caught it because no test knew what Chrome considers a valid pattern. The validator
// below mirrors Chrome's parser, and the invariants run every host the extension can meet
// (the shipped lists, edge cases, random strings) through it.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, rmSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let mod;

before(async () => {
  const outfile = join(tmpdir(), `quell-hostname-patterns-${process.pid}.mjs`);
  await build({
    stdin: {
      contents: `
        export {
          normalizeHostname, isIPv4Host, isValidMatchPatternHost, isSafeAllowlistHost,
          allowlistMatchPatterns, exactHostMatchPatterns, siteRuleHostFromInput,
          pathExceptionMatchPatterns,
        } from './src/shared/hostname.js';
        export { mergeNetworkExceptions, mergePathExceptions } from './src/engine/cosmetic-match.js';
        export { shardRegistrations } from './src/engine/scriptlet-shards.js';
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

// ---------------------------------------------------------------------------
// A faithful model of Chrome's match-pattern parser
// ---------------------------------------------------------------------------

/** Schemes a content-script pattern may use (UserScript::ValidUserScriptSchemes). */
const SCHEMES = new Set(['*', 'http', 'https', 'file', 'ftp']);

/**
 * URLPattern::Parse (extensions/common/url_pattern.cc) for content-script patterns. Returns
 * null when Chrome accepts the pattern, otherwise the ParseResult it reports. Host
 * canonicalization is delegated to the WHATWG URL parser, which applies the same rule as
 * Chrome's net::CanonicalizeHost: a host whose last label is a number is parsed as IPv4, so
 * `192.168` becomes `192.0.0.168` and `www.192.168` fails outright.
 */
function chromeMatchPatternError(pattern) {
  if (pattern === '<all_urls>') return null;
  const sep = pattern.indexOf('://');
  if (sep < 0) return 'kMissingSchemeSeparator';
  if (!SCHEMES.has(pattern.slice(0, sep))) return 'kInvalidScheme';
  const start = sep + 3;
  if (start >= pattern.length) return 'kEmptyHost';
  if (pattern.startsWith('file:')) return null; // the host of a file pattern is ignored
  const slash = pattern.indexOf('/', start);
  if (slash === start) return 'kEmptyHost';
  if (slash < 0) return 'kEmptyPath';
  const hostAndPort = pattern.slice(start, slash);

  let portAt = -1;
  if (hostAndPort[0] !== '[') {
    portAt = hostAndPort.indexOf(':');
  } else {
    const close = hostAndPort.indexOf(']');
    if (close < 0) return 'kInvalidHost';
    if (close === 1) return 'kEmptyHost';
    if (close < hostAndPort.length - 1) {
      if (hostAndPort[close + 1] !== ':') return 'kInvalidHost';
      portAt = close + 1;
    }
  }
  if (portAt >= 0) {
    const port = hostAndPort.slice(portAt + 1);
    if (port !== '*' && !(/^\d+$/.test(port) && Number(port) < 65536)) return 'kInvalidPort';
  }
  let host = portAt >= 0 ? hostAndPort.slice(0, portAt) : hostAndPort;
  if (!host) return 'kEmptyHost';
  if (host === '*') return null;
  if (host.startsWith('*.')) {
    if (host.length === 2) return 'kEmptyHost';
    host = host.slice(2);
  }
  if (host.includes('*')) return 'kInvalidHostWildcard';
  return canonicalHost(host) === null ? 'kInvalidHost' : null;
}

/** The canonical form Chrome would store for `host`, or null when it cannot be parsed. */
function canonicalHost(host) {
  // WHATWG forbidden host code points; Chrome's canonicalizer refuses them as well.
  if (host[0] !== '[' && /[\x00-\x20\x7f#%/:<>?@[\\\]^|]/.test(host)) return null;
  try {
    return new URL(`http://${host}/`).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Stricter than Chrome: the pattern must also be for the host we wrote. Chrome accepts
 * `*://192.168.1/*` but reads it as 192.168.0.1, which is a different page.
 */
function patternProblem(pattern) {
  const err = chromeMatchPatternError(pattern);
  if (err) return err;
  const m = /^[^:]+:\/\/(?:\*\.)?([^/]+)\//.exec(pattern);
  if (m && m[1] !== '*') {
    const canon = canonicalHost(m[1]);
    if (canon !== m[1]) return `host rewritten to ${canon}`;
  }
  return null;
}

test('the pattern model agrees with what Chromium 131 was observed to accept and reject', () => {
  // Outcomes recorded in a real Chromium 131 for REVIEW_2026-09-24 (B3).
  for (const ok of ['*://192.168.1/*', '*://*.192.168.1/*', '*://example.com/*', '<all_urls>']) {
    assert.equal(chromeMatchPatternError(ok), null, ok);
  }
  for (const bad of [
    '*://www.192.168/*',
    '*://www.192.168.1/*',
    '*://www.10.0.0/*',
    '*://foo.123/*',
    '*://*.foo.123/*',
    '*://www.foo.123/*',
  ]) {
    assert.equal(chromeMatchPatternError(bad), 'kInvalidHost', bad);
  }
  // Parser structure, from url_pattern.cc.
  assert.equal(chromeMatchPatternError('*://*./*'), 'kEmptyHost');
  assert.equal(chromeMatchPatternError('*://a.*.com/*'), 'kInvalidHostWildcard');
  assert.equal(chromeMatchPatternError('*://example.com'), 'kEmptyPath');
  assert.equal(chromeMatchPatternError('*://[::1]/*'), null);
  // Accepted, but not the host that was written.
  assert.equal(patternProblem('*://192.168.1/*'), 'host rewritten to 192.168.0.1');
  assert.equal(patternProblem('*://*.example.com/*'), null);
});

// ---------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------

test('partial and non-canonical IPv4, and names ending in a number, are not valid hosts', () => {
  for (const h of [
    '192.168', // EasyList China's truncated `192.168.*.1`
    '10.0.0', // typed into Options > Add a site
    '192.168.1',
    '1.2.3.4.5',
    '256.1.1.1',
    '010.0.0.1', // Chrome reads leading zeros as octal: 8.0.0.1
    'foo.123',
    'foo.0x1f',
    'foo.0X',
    '4294967295',
  ]) {
    assert.equal(mod.isValidMatchPatternHost(h), false, h);
    assert.equal(mod.isSafeAllowlistHost(h), false, h);
    assert.deepEqual(mod.allowlistMatchPatterns(h), [], h);
    assert.deepEqual(mod.exactHostMatchPatterns(h), [], h);
  }
  for (const h of ['10.0.0.1', '0.0.0.0', '255.255.255.255', '123.example.com', 'a.0xg']) {
    assert.equal(mod.isValidMatchPatternHost(h), true, h);
  }
});

test('IP literals never get a www. or *. prefix', () => {
  assert.deepEqual(mod.allowlistMatchPatterns('192.168.1.1'), ['*://192.168.1.1/*']);
  assert.deepEqual(mod.exactHostMatchPatterns('192.168.1.1'), ['*://192.168.1.1/*']);
  assert.deepEqual(mod.allowlistMatchPatterns('www.10.0.0.1'), ['*://10.0.0.1/*']);
});

test('IPv6 literals are refused everywhere, so the popup never offers a switch that cannot work', () => {
  for (const h of ['[::1]', '::1', '[2001:db8::1]']) {
    assert.equal(mod.isValidMatchPatternHost(h), false, h);
    assert.equal(mod.isSafeAllowlistHost(h), false, h);
    assert.deepEqual(mod.allowlistMatchPatterns(h), [], h);
  }
});

test('localhost gets match patterns, so switching it off also stops generic hiding (B31)', () => {
  assert.equal(mod.isSafeAllowlistHost('localhost'), true);
  assert.deepEqual(mod.allowlistMatchPatterns('localhost'), [
    '*://localhost/*',
    '*://*.localhost/*',
  ]);
  // Other single-label names stay public suffixes: no patterns, not allowlistable.
  assert.deepEqual(mod.allowlistMatchPatterns('com'), []);
  assert.equal(mod.isSafeAllowlistHost('intranet'), false);
});

test('Options > Add a site keeps the host of a URL and refuses what the worker would drop', () => {
  // Finding 197: the service worker ignores a host it cannot key a rule on, and Options used
  // to clear the field anyway, so a typed `10.0.0` simply vanished.
  const cases = {
    'example.com': 'example.com',
    '  WWW.Example.COM ': 'example.com',
    'https://www.example.com/path?q=1': 'example.com',
    'example.com:8080/admin': 'example.com',
    'http://192.168.1.1:8080/': '192.168.1.1',
    'localhost:3000': 'localhost',
    'bücher.de': 'xn--bcher-kva.de',
    '10.0.0': '',
    '192.168.1': '',
    '010.0.0.1': '',
    '[::1]': '',
    'com': '',
    'github.io': '',
    'not a host': '',
    'https://': '',
    '': '',
  };
  for (const [typed, host] of Object.entries(cases)) {
    assert.equal(mod.siteRuleHostFromInput(typed), host, JSON.stringify(typed));
    // Whatever it accepts, the worker accepts too.
    if (host) assert.equal(mod.isSafeAllowlistHost(host), true, host);
  }
});

// ---------------------------------------------------------------------------
// Invariants over every host we can find
// ---------------------------------------------------------------------------

const cosmetic = JSON.parse(readFileSync(join(ROOT, 'src/generated/cosmetic.json'), 'utf8'));
const meta = JSON.parse(readFileSync(join(ROOT, 'src/generated/meta.json'), 'utf8'));

/** Deterministic PRNG so a failure reproduces. */
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hostCorpus() {
  const hosts = new Set([
    'example.com',
    'www.example.com',
    'WWW.Example.COM',
    ' example.com ',
    'sub.example.co.uk',
    'www.com',
    'co.uk',
    'github.io',
    'alice.github.io',
    'www.github.io',
    'localhost',
    'www.localhost',
    'app.localhost',
    'xn--bcher-kva.example',
    '1.2.3.4',
    'www.1.2.3.4',
    '1.2.3',
    '192.168',
    '10.0.0',
    '0x7f.1',
    '1.0x7f',
    'a.b.c.0',
    '0',
    '-a.com',
    'a-.com',
    'a..com',
    'example.com.',
    '.example.com',
    'ex_ample.com',
    'bücher.de',
    '[::1]',
    'example.com:8080',
    'example.*',
    '',
  ]);
  for (const list of Object.values(cosmetic.byList)) {
    for (const key of Object.keys(list.hideSpecific ?? {})) hosts.add(key);
    for (const key of Object.keys(list.unhideSpecific ?? {})) hosts.add(key);
  }
  for (const kind of Object.values(cosmetic.networkExceptions)) {
    for (const list of Object.values(kind)) for (const h of list) hosts.add(h);
  }
  const rand = mulberry32(0x5eed);
  const alphabet = 'ax0019.-';
  for (let i = 0; i < 20000; i++) {
    let s = '';
    const len = 1 + Math.floor(rand() * 12);
    for (let j = 0; j < len; j++) s += alphabet[Math.floor(rand() * alphabet.length)];
    hosts.add(s);
  }
  return [...hosts];
}

test('every pattern emitted for a host is a valid Chrome pattern, for that same host', () => {
  const failures = [];
  for (const h of hostCorpus()) {
    for (const fn of ['allowlistMatchPatterns', 'exactHostMatchPatterns']) {
      for (const p of mod[fn](h)) {
        const problem = patternProblem(p);
        if (problem) failures.push(`${fn}(${JSON.stringify(h)}) → ${p}: ${problem}`);
      }
    }
    // Anything the validator accepts must produce patterns Chrome accepts. This is the
    // property B3 broke: '192.168' passed the validator and its patterns did not.
    const n = mod.normalizeHostname(h);
    if (mod.isValidMatchPatternHost(n)) {
      const canon = canonicalHost(n);
      if (canon !== n) failures.push(`validator accepted ${JSON.stringify(h)} (→ ${canon})`);
    }
  }
  assert.deepEqual(failures.slice(0, 20), []);
});

test('a host that can be allowlisted always has patterns, and is a canonical DNR domain', () => {
  const failures = [];
  for (const h of hostCorpus()) {
    if (!mod.isSafeAllowlistHost(h)) continue;
    const n = mod.normalizeHostname(h);
    // Otherwise the DNR allow rule is written but generic hiding and the YouTube hooks keep
    // running on the site (B31, localhost).
    if (!mod.allowlistMatchPatterns(h).length) failures.push(`${h}: no match patterns`);
    // requestDomains wants the lowercase canonical host; anything else never matches.
    if (canonicalHost(n) !== n) failures.push(`${h}: stored as ${n}, canonical ${canonicalHost(n)}`);
  }
  assert.deepEqual(failures.slice(0, 20), []);
});

test('generic-sheet excludes from the shipped lists are valid for every list combination', () => {
  // This is the computation syncRegisteredScripts does for the generic cosmetic registration.
  // A single invalid entry makes Chrome reject the whole registration.
  const ids = meta.lists.map((l) => l.id);
  const patternsFor = new Map();
  const problems = new Map();
  const patterns = (h) => {
    if (!patternsFor.has(h)) patternsFor.set(h, mod.allowlistMatchPatterns(h));
    return patternsFor.get(h);
  };
  const check = (p) => {
    if (!problems.has(p)) problems.set(p, patternProblem(p));
    return problems.get(p);
  };

  const failures = [];
  for (let mask = 1; mask < 1 << ids.length; mask++) {
    const enabled = ids.filter((_, i) => mask & (1 << i));
    const netEx = mod.mergeNetworkExceptions(cosmetic, enabled);
    for (const h of [...netEx.generichide, ...netEx.elemhide]) {
      for (const p of patterns(h)) {
        const problem = check(p);
        if (problem) failures.push(`[${enabled.join(',')}] ${h} → ${p}: ${problem}`);
      }
    }
    // Page-scoped exceptions (EasyList's search-results generichide) keep their path.
    const pathEx = mod.mergePathExceptions(cosmetic, enabled);
    for (const e of [...pathEx.generichide, ...pathEx.elemhide]) {
      for (const p of mod.pathExceptionMatchPatterns(e)) {
        const problem = check(p);
        if (problem) failures.push(`[${enabled.join(',')}] ${e} → ${p}: ${problem}`);
      }
    }
    if (failures.length) break;
  }
  assert.deepEqual(failures.slice(0, 10), []);
  const shipped = mod.mergePathExceptions(cosmetic, ids).generichide.flatMap(mod.pathExceptionMatchPatterns);
  assert.ok(shipped.includes('*://*.duckduckgo.com/?q=*'), 'the page-scoped excludes are checked');
});

test('list scriptlet registrations only carry patterns Chrome accepts, for the host meant (B2)', () => {
  // One refused pattern fails the whole registerContentScripts call, and the scriptlet shards
  // carry some 22k of them, compiled from list hostnames.
  const index = JSON.parse(readFileSync(join(ROOT, 'src/generated/scriptlet-shards.json'), 'utf8'));
  const regs = mod.shardRegistrations(index, meta.lists.map((l) => l.id));
  assert.ok(regs.length > 1);
  const failures = [];
  for (const r of regs) {
    for (const pattern of r.matches()) {
      const problem = patternProblem(pattern);
      if (problem) failures.push(`${r.id} ${pattern}: ${problem}`);
    }
  }
  assert.deepEqual(failures.slice(0, 10), []);
});
