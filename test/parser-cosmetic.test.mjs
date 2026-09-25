// Cosmetic parsing fixes: ABP extended selectors, and which page hosts a network cosmetic
// exception (`@@…$generichide` / `$elemhide` / `$specifichide`) may be keyed to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLine,
  cosmeticExceptionHosts,
  cosmeticExceptionScope,
  hostsFromPattern,
} from '../scripts/lib/parse-filter.mjs';
import { normalizeAbpSelector } from '../scripts/lib/procedural-ops.mjs';

// --- ABP extended selectors ---------------------------------------------------------------

test(':-abp-has() is rewritten to :has() (EasyList China)', () => {
  const p = parseLine('bilibili.com#?#.is-rcmd:-abp-has(>div:not(div:-abp-has(div)))');
  // Native `:has()` is plain CSS: it ships in the stylesheet, where exceptions reach it.
  assert.equal(p.kind, 'hide');
  assert.equal(p.selector, '.is-rcmd:has(>div:not(div:has(div)))');
  assert.equal(parseLine('neets.cc#?#div[class]:-abp-has(> div > .home_p)').selector, 'div[class]:has(> div > .home_p)');
});

test(':-abp-contains() is rewritten to :has-text()', () => {
  const p = parseLine('example.cn#?#div.item:-abp-has(span:-abp-contains(广告))');
  assert.equal(p.kind, 'procedural');
  assert.equal(p.selector, 'div.item:has(span:has-text(广告))');
});

test('exceptions are rewritten the same way, so they still pair with their hide rule', () => {
  const hide = parseLine('example.cn#?#div:-abp-has(.ad)');
  const unhide = parseLine('example.cn#@?#div:-abp-has(.ad)');
  assert.equal(unhide.kind, 'unhide');
  assert.equal(unhide.selector, hide.selector);
});

test(':-abp-properties() is reported unsupported rather than shipped as a dead rule', () => {
  for (const line of [
    'pcbeta.com#?##wp > div[class][id]:-abp-properties(width: 980px;)',
    'pornhub.com##:-abp-properties(height: 300px; width: 315px;)',
    'gamepadla.com#?#.pMain:has(div:-abp-properties(Partner))',
  ]) {
    const p = parseLine(line);
    assert.equal(p.kind, 'ignored', line);
    assert.equal(p.unsupported, '-abp-properties', line);
  }
  assert.equal(normalizeAbpSelector('div:-abp-unknown(x)').unsupported, '-abp-unknown');
});

test('uBO HTML filters are reported unsupported, not shipped as procedural selectors', () => {
  // ubo-filters.txt ships ~140 of these outside any `!#if cap_html_filtering` block.
  for (const line of [
    'wetteronline.*##^script:has-text(runCount)',
    "animepahe.*,kwik.*##^script:has-text('shift')",
    'example.com#@#^script:has-text(x)',
  ]) {
    const p = parseLine(line);
    assert.equal(p.kind, 'ignored', line);
    assert.equal(p.unsupported, 'html-filter', line);
  }
});

test('selectors without :-abp- are untouched', () => {
  assert.deepEqual(normalizeAbpSelector('.a:has(> .b)'), { selector: '.a:has(> .b)', unsupported: null });
  assert.equal(parseLine('example.com##.ad').selector, '.ad');
});

// --- network cosmetic exception hosts -------------------------------------------------------

/** The runtime can key an exception to a hostname, a full IPv4 address, or an entity `name.*`. */
function isKeyableHost(h) {
  if (/^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.\*$/.test(h)) return !/^\d+(\.\d+)+\.\*$/.test(h);
  const labels = h.split('.');
  if (labels.some((l) => !/^[a-z0-9_-]+$/.test(l))) return false;
  if (/^\d+$/.test(labels.at(-1))) {
    return labels.length === 4 && labels.every((l) => /^\d{1,3}$/.test(l) && Number(l) <= 255);
  }
  return true;
}

test('a wildcard or truncated IP never becomes a host (EasyList China 192.168.*.1)', () => {
  // `192.168` went into excludeMatches as `*://*.192.168/*`; Chrome rejected the whole
  // generic-cosmetic registration, so zh-* installs lost generic hiding.
  assert.deepEqual(hostsFromPattern('||192.168.*.1/', false), []);
  assert.deepEqual(cosmeticExceptionHosts('||192.168.*.1/', false), { hosts: [], skip: 'partial-host' });
  for (const p of ['://192.168.', '://10.0.0.', '://10.1.1.', '||10.0.0^', '||192.168.1^']) {
    assert.deepEqual(cosmeticExceptionHosts(p, false), { hosts: [], skip: 'partial-host' }, p);
  }
  for (const p of ['||anime-update*.*^', '||animedao*.*^', '||animetake*.*^']) {
    assert.deepEqual(cosmeticExceptionHosts(p, false), { hosts: [], skip: 'partial-host' }, p);
  }
});

test('`://host` exceptions for localhost and loopback yield their host (EasyList)', () => {
  assert.deepEqual(hostsFromPattern('://localhost/', false), ['localhost']);
  assert.deepEqual(hostsFromPattern('://localhost:', false), ['localhost']);
  assert.deepEqual(hostsFromPattern('://127.0.0.1', false), ['127.0.0.1']);
  assert.deepEqual(hostsFromPattern('|https://example.com^', false), ['example.com']);
});

test('path- or query-scoped exceptions are never widened to the whole host', () => {
  for (const p of [
    '||www.google.*/search?',
    '||bing.com/search?',
    '||duckduckgo.com/?q=',
    '||yandex.com/search/?',
    '||weibo.com/share/share.php',
    '||googleapiscdn.com/player/*animevietsub.',
    '||example.com^|',
    '||localhost:3000^',
    'example.com/path',
    '/banner/*',
  ]) {
    assert.deepEqual(cosmeticExceptionHosts(p, false), { hosts: [], skip: 'path-scoped' }, p);
  }
  assert.deepEqual(cosmeticExceptionHosts('/^https:\\/\\/a\\.com\\//', true), {
    hosts: [],
    skip: 'path-scoped',
  });
});

test('host-only patterns are accepted in every spelling', () => {
  const cases = {
    '||example.com^': ['example.com'],
    '||example.com': ['example.com'],
    '||example.com/': ['example.com'],
    '||example.com^*': ['example.com'],
    '||Example.COM^': ['example.com'],
    'example.com^': ['example.com'],
    '||pahe.*^': ['pahe.*'],
    // uBO keeps the `www.`: www.pahe.<tld> and below, not every pahe.* host.
    '||www.pahe.*^': ['www.pahe.*'],
    '||stream4free.': ['stream4free.*'],
    '||519.*^': ['519.*'],
    '||1.2.3.4^': ['1.2.3.4'],
  };
  for (const [p, hosts] of Object.entries(cases)) {
    assert.deepEqual(cosmeticExceptionHosts(p, false), { hosts, skip: null }, p);
  }
  // `@@*$ghide,domain=…` is scoped by its options alone.
  assert.deepEqual(cosmeticExceptionHosts('*', false), { hosts: [], skip: null });
  assert.deepEqual(cosmeticExceptionHosts('', false), { hosts: [], skip: null });
});

test('every host emitted for the shipped exception spellings is keyable', () => {
  const patterns = [
    '||192.168.*.1/', '://10.0.0.', '://10.1.1.', '://127.0.0.1', '://192.168.', '://localhost/',
    '://localhost:', '||music.amazon.', '||taboolanews.com/summary-page/*_samsung-carnival-',
    '||bing.com/search?', '||www.google.*/search?', '||anime-update*.*^', '||shrink.', '||sms24.',
    '||asd.', '||519.*^', '||kwik.*^', '||github.io^', '||mail.google.com^', '||[::1]^',
  ];
  for (const p of patterns) {
    for (const h of hostsFromPattern(p, false)) assert.ok(isKeyableHost(h), `${p} → ${h}`);
  }
});

test('a host-anchored path keeps its scope as a match-pattern path', () => {
  // EasyList's search-engine block: generic hiding off on the results pages only.
  const cases = {
    '||bing.com/search?': { hosts: ['bing.com'], path: '/search?*' },
    '||duckduckgo.com/?q=': { hosts: ['duckduckgo.com'], path: '/?q=*' },
    '||www.google.*/search?': { hosts: ['www.google.*'], path: '/search?*' },
    '||yandex.com/search/?': { hosts: ['yandex.com'], path: '/search/?*' },
    '||weibo.com/share/share.php': { hosts: ['weibo.com'], path: '/share/share.php*' },
    '||googleapiscdn.com/player/*animevietsub.': {
      hosts: ['googleapiscdn.com'],
      path: '/player/*animevietsub.*',
    },
    // Case is kept (Chrome matches a pattern's path case-sensitively); `|` anchors the end.
    '||taboolanews.com/feed/summary?publisherId=Taboola_x&viewID=': {
      hosts: ['taboolanews.com'],
      path: '/feed/summary?publisherId=Taboola_x&viewID=*',
    },
    '||Example.com/Exact|': { hosts: ['example.com'], path: '/Exact' },
    '|https://example.com/a**b': { hosts: ['example.com'], path: '/a*b*' },
    '||example.com^': { hosts: ['example.com'], path: null },
  };
  for (const [p, want] of Object.entries(cases)) {
    assert.deepEqual(cosmeticExceptionScope(p, false), { ...want, skip: null }, p);
  }
  // Nothing a match pattern cannot say: a separator, a port, a bare substring, a regex.
  for (const p of [
    '||example.com/path^',
    '||example.com^|',
    '||localhost:3000^',
    'example.com/path',
    '/banner/*',
    '||example.com/a|b',
  ]) {
    assert.deepEqual(cosmeticExceptionScope(p, false), { hosts: [], path: null, skip: 'path-scoped' }, p);
  }
  assert.equal(cosmeticExceptionScope('/^https:\\/\\/a\\.com\\//', true).skip, 'path-scoped');
  assert.equal(cosmeticExceptionScope('||192.168.*.1/x', false).skip, 'partial-host');
});

test('the exception is parsed from a full network line', () => {
  const p = parseLine('@@||192.168.*.1/$generichide');
  assert.equal(p.cosmeticException, 'generichide');
  assert.equal(cosmeticExceptionHosts(p.pattern, p.isRegex).skip, 'partial-host');
  const g = parseLine('@@||www.google.*/search?$generichide');
  assert.equal(cosmeticExceptionHosts(g.pattern, g.isRegex).skip, 'path-scoped');
});
