// uBO's cosmetic domain forms (REVIEW_2026-09-24 B11) and how a filter's domain is matched.
//
// Keys the parser stored verbatim that no runtime lookup could produce left rules dead:
// EasyList's 31 `www.google.*` hides (Google Search ads), `read.amazon.*` and other multi-label
// entities, 40 scriptlets whose only domains were `host>>`, regex hostnames, `*##` generics and
// non-punycode IDNs. The opposite problem, folding `www.` into the site, widened
// `www.yahoo.com` rules and `www.youtube.com` exceptions to every subdomain.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLine } from '../scripts/lib/parse-filter.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let mod;

before(async () => {
  const out = await build({
    stdin: {
      contents: `
        export * from './src/shared/hostname.ts';
        export { matchCosmetic, matchScriptlets, genericCssRegistration } from './src/engine/cosmetic-match.ts';
      `,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
  });
  mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
});

const spec = (include, exclude = []) => ({ include, exclude });

function cosmeticData(bucket, networkExceptions = {}) {
  return {
    byList: {
      l: {
        hideGeneric: [],
        unhideGeneric: [],
        hideSpecific: {},
        unhideSpecific: {},
        procedural: [],
        ...bucket,
      },
    },
    networkExceptions: { generichide: {}, elemhide: {}, specifichide: {}, ...networkExceptions },
  };
}

test('uBO domain forms parse into keys the runtime can match', () => {
  assert.deepEqual(parseLine('www.google.*###tads[aria-label]').domains, spec(['www.google.*']));
  // `host>>` is the host (and, in uBO, the frames it embeds).
  assert.deepEqual(
    parseLine('lk21official.*>>,noxx.to>>##+js(acs, EventTarget.prototype.addEventListener, delete window)')
      .domains,
    spec(['lk21official.*', 'noxx.to']),
  );
  assert.deepEqual(parseLine('divicast.watch>>,~disqus.com##.x').domains, spec(['divicast.watch'], ['disqus.com']));
  // A regex hostname keeps its commas and its case (`\D` is not `\d`).
  const tamil = String.raw`/(\d{0,1})?tamilprint(\d{1,2})?\.[a-z]{3,7}/`;
  assert.deepEqual(parseLine(`${tamil}##.ad`).domains, spec([tamil]));
  const upper = String.raw`/^www\.Site\D+\.xyz$/`;
  assert.deepEqual(parseLine(`${upper},~other.xyz##.ad`).domains, spec([upper], ['other.xyz']));
  // `*` is every site: a generic filter, with or without exclusions.
  assert.deepEqual(parseLine('*##.ads_all > .ads_w').domains, spec([]));
  assert.deepEqual(parseLine('*,~a.com##.x').domains, spec([], ['a.com']));
  // location.hostname is punycode.
  assert.deepEqual(
    parseLine('glarnerwanderwege.ch,wanderwege-graubünden.ch###ct-custom-cookie-notice').domains,
    spec(['glarnerwanderwege.ch', 'xn--wanderwege-graubnden-4ec.ch']),
  );
  assert.deepEqual(parseLine('пример.*##.ad').domains, spec(['xn--e1afmkfd.*']));
  // An unreadable include is left out; an unreadable exclusion, or no readable include at all,
  // drops the rule rather than widening it.
  assert.deepEqual(parseLine('a.com,/[/##.x').domains, spec(['a.com']));
  for (const line of ['a.com,~/[/##.x', '/[/##.x']) {
    const bad = parseLine(line);
    assert.equal(bad.kind, 'ignored', line);
    assert.equal(bad.unsupported, 'domain-invalid', line);
  }
});

test('multi-label entities, regex hostnames and TLD keys match at runtime', () => {
  const data = cosmeticData({
    hideSpecific: {
      'www.google.*': ['#tads[aria-label]'],
      'read.amazon.*': ['.kw-ads-ftue-container'],
      [String.raw`/^www\.selcuksportshd[a-z0-9-]+\.xyz$/`]: ['.banner'],
      pl: ['.pl-wide'],
    },
    procedural: [{ domains: spec(['www.google.*']), expr: 'div:has-text(Sponsored)' }],
  });
  const hides = (host) => mod.matchCosmetic(host, data, ['l']).hide;
  assert.ok(hides('www.google.co.uk').includes('#tads[aria-label]'));
  assert.ok(hides('www.google.com').includes('#tads[aria-label]'));
  assert.ok(!hides('news.google.com').includes('#tads[aria-label]'), 'www.google.* is not google.*');
  assert.ok(hides('read.amazon.co.jp').includes('.kw-ads-ftue-container'));
  assert.ok(!hides('amazon.co.jp').includes('.kw-ads-ftue-container'));
  assert.ok(hides('www.selcuksportshd42.xyz').includes('.banner'));
  assert.ok(!hides('selcuksportshd42.xyz').includes('.banner'));
  assert.ok(hides('onet.pl').includes('.pl-wide'), 'uBO keys whole ccTLDs (`pl#@#…`) too');
  assert.equal(mod.matchCosmetic('www.google.de', data, ['l']).procedural.length, 1);
  assert.equal(mod.matchCosmetic('maps.google.de', data, ['l']).procedural.length, 0);

  assert.equal(mod.filterDomainMatches('www.google.co.uk', 'www.google.*'), true);
  assert.equal(mod.filterDomainMatches('a.www.google.co.uk', 'www.google.*'), true);
  assert.equal(mod.filterDomainMatches('1337x.unblockit.kim', '1337x.unblockit.*'), true);
  assert.equal(mod.filterDomainMatches('192.168.1.1', '1.*'), false, 'an IP has no entity');
  assert.equal(mod.filterDomainMatches('tamilprint29.art', String.raw`/(\d{0,1})?tamilprint(\d{1,2})?\.[a-z]{3,7}/`), true);
});

test('a filter domain is matched as written: www. is not folded into the site', () => {
  assert.equal(mod.filterDomainMatches('mail.yahoo.com', 'www.yahoo.com'), false);
  assert.equal(mod.filterDomainMatches('www.yahoo.com', 'www.yahoo.com'), true);
  assert.equal(mod.filterDomainMatches('m.www.yahoo.com', 'www.yahoo.com'), true);
  assert.equal(mod.filterDomainMatches('www.yahoo.com', 'yahoo.com'), true);
  assert.equal(mod.domainSpecMatches('yahoo.com', spec(['yahoo.com'], ['www.yahoo.com'])), true);
  // The user's own entries still stand for the site.
  assert.equal(mod.hostMatchesDomain('www.example.com', 'example.com'), true);
  assert.equal(mod.isAllowlistedHost('example.com', ['www.example.com']), true);
  assert.equal(mod.isAllowlistedHost('shop.example.com', ['example.com']), true);

  const scriptlets = {
    byList: {
      l: {
        scriptlets: [
          { domains: spec(['www.yahoo.com']), name: 'set', args: ['navigator.globalPrivacyControl', 'false'] },
          { domains: spec(['wp.pl']), name: 'aopr', args: ['__headpayload'] },
        ],
        exceptions: [{ domains: spec(['www.wp.pl']), name: 'aopr', args: ['__headpayload'] }],
      },
    },
  };
  const names = (host) => mod.matchScriptlets(host, scriptlets, ['l']).map((r) => r.name);
  assert.deepEqual(names('www.yahoo.com'), ['set']);
  assert.deepEqual(names('mail.yahoo.com'), []);
  assert.deepEqual(names('www.wp.pl'), [], 'the exception cancels on www.wp.pl');
  assert.deepEqual(names('sportowefakty.wp.pl'), ['aopr'], 'and nowhere else on wp.pl');
});

test('a www. exception host covers www and below, in matching and in registration excludes', () => {
  // EasyList `@@||www.youtube.com^$generichide`.
  const data = cosmeticData(
    { hideGeneric: ['.ad-slot'] },
    { generichide: { l: ['www.youtube.com'] } },
  );
  assert.equal(mod.matchCosmetic('www.youtube.com', data, ['l']).disableGeneric, true);
  for (const host of ['music.youtube.com', 'm.youtube.com', 'studio.youtube.com', 'youtube.com']) {
    assert.equal(mod.matchCosmetic(host, data, ['l']).disableGeneric, false, host);
  }
  assert.deepEqual(mod.exceptionHostMatchPatterns('www.youtube.com'), [
    '*://www.youtube.com/*',
    '*://*.www.youtube.com/*',
  ]);
  assert.deepEqual(mod.exceptionHostMatchPatterns('co.uk'), [], 'never a whole public suffix');
  assert.deepEqual(mod.exceptionHostMatchPatterns('10.0.0.1'), ['*://10.0.0.1/*']);
  assert.deepEqual(mod.genericCssRegistration(data, ['l']).excludeMatches, [
    '*://www.youtube.com/*',
    '*://*.www.youtube.com/*',
  ]);
});

/** Every include key a synthetic list uses, and hosts around them. */
function syntheticScriptlets(n) {
  const labels = ['news', 'shop', 'www', 'cdn', 'm'];
  const tlds = ['com', 'org', 'co.uk', 'de', 'io'];
  const scriptlets = [];
  const exceptions = [];
  const hosts = new Set(['www.example.org', 'example.org', 'localhost', '192.168.1.1']);
  for (let i = 0; i < n; i++) {
    const site = `site${i % 1500}`;
    const tld = tlds[i % tlds.length];
    const sub = labels[i % labels.length];
    const include =
      i % 7 === 0 ? [`${site}.*`] : i % 11 === 0 ? [`${sub}.${site}.*`] : [`${sub}.${site}.${tld}`, `${site}.${tld}`];
    const exclude = i % 5 === 0 ? [`${sub}.${site}.${tld}`] : [];
    const rule = { domains: spec(include, exclude), name: `s${i % 40}`, args: [String(i % 97)] };
    (i % 13 === 0 ? exceptions : scriptlets).push(rule);
    hosts.add(`${site}.${tld}`);
    hosts.add(`${sub}.${site}.${tld}`);
    hosts.add(`www.${site}.${tld}`);
  }
  return { data: { byList: { a: { scriptlets, exceptions } } }, hosts: [...hosts] };
}

/** matchScriptlets as it was: every rule of every enabled list tested against the host. */
function scanScriptlets(host, data, ids) {
  const exceptions = [];
  const candidates = [];
  for (const id of ids) {
    for (const r of data.byList[id].exceptions) if (mod.domainSpecMatches(host, r.domains)) exceptions.push(r);
    for (const r of data.byList[id].scriptlets) if (mod.domainSpecMatches(host, r.domains)) candidates.push(r);
  }
  const cancelled = new Set(exceptions.map((e) => `${e.name}\0${e.args.join('\0')}`));
  const seen = new Set();
  const out = [];
  for (const r of candidates) {
    if (cancelled.has(`${r.name}\0${r.args.join('\0')}`)) continue;
    const key = `${r.name}\0${r.args.join('\0')}\0${r.domains.include.join(',')}\0${r.domains.exclude.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

test('matchScriptlets looks rules up by domain and returns what a full scan returns', () => {
  const { data, hosts } = syntheticScriptlets(9000);
  for (const host of hosts.filter((_, i) => i % 3 === 0)) {
    assert.deepEqual(mod.matchScriptlets(host, data, ['a']), scanScriptlets(host, data, ['a']), host);
  }
  // 7-8 ms per frame on www. hosts before the index; the scan alone is ~1 ms here.
  mod.matchScriptlets('www.example.org', data, ['a']);
  const start = performance.now();
  for (let i = 0; i < 200; i++) mod.matchScriptlets('www.example.org', data, ['a']);
  const perCall = (performance.now() - start) / 200;
  assert.ok(perCall < 0.5, `matchScriptlets took ${perCall.toFixed(3)} ms per call`);
});
