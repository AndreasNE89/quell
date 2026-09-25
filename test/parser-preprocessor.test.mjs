// `!#if` / `!#else` / `!#endif` / `!#include` handling (scripts/lib/parse-filter.mjs).
// compile-filters.mjs runs every list — and the $badfilter pre-scan — through
// preprocessFilterText before parseLine, so these rules are what reaches the rulesets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLine,
  preprocessFilterText,
  evaluatePreprocessorExpression,
  PREPROCESSOR_ENV,
  COSMETIC_PREPROCESSOR_ENV,
} from '../scripts/lib/parse-filter.mjs';

/** The rule lines that survive preprocessing, trimmed. */
function kept(text, opts) {
  return preprocessFilterText(text, opts)
    .lines.map((l) => l.trim())
    .filter((l) => parseLine(l));
}

test('a Firefox-only allow rule does not reach the Chromium build', () => {
  // ubo-filters.txt ships this allow inside `!#if env_firefox`. Compiled for Chrome, it let
  // Amazon's header-bidding script load on 14 sites.
  const text = [
    'animedao.*##hr',
    '!#if env_firefox',
    '@@||amazon-adsystem.com/$script,domain=avclub.com|gizmodo.com|kotaku.com',
    '!#endif',
    '@@||worldfreeware.com^$ghide',
  ].join('\n');
  assert.deepEqual(kept(text), ['animedao.*##hr', '@@||worldfreeware.com^$ghide']);
});

test('an !#if / !#else pair ships exactly one branch', () => {
  // ubo-filters.txt: maqal360.com used to get both `set` scriptlets.
  const text = [
    '!#if env_firefox',
    'maqal360.com##+js(set, navigator.serviceWorker, {})',
    '!#else',
    'maqal360.com##+js(set, navigator.webkitTemporaryStorage.queryUsageAndQuota, noopFunc)',
    '!#endif',
  ].join('\n');
  assert.deepEqual(kept(text), [
    'maqal360.com##+js(set, navigator.webkitTemporaryStorage.queryUsageAndQuota, noopFunc)',
  ]);
});

test('nested and negated conditions follow the Chromium desktop branch', () => {
  // ubo-filters.txt: the dmxleo block is for non-Chromium browsers only.
  const text = [
    '!#if !env_mobile',
    '!#if !env_chromium',
    '||dmxleo.dailymotion.com^',
    'geo.dailymotion.com##+js(set, DMP_ENABLE_ADS, false)',
    '!#else',
    'www.dailymotion.com##+js(xml-prune, [breakId], , _VMAP_)',
    '!#endif',
    '!#endif',
    '!#if env_mobile',
    '!#if env_chromium',
    '||mobile-only.example^',
    '!#else',
    '||mobile-other.example^',
    '!#endif',
    '!#endif',
  ].join('\n');
  assert.deepEqual(kept(text), ['www.dailymotion.com##+js(xml-prune, [breakId], , _VMAP_)']);
});

test('the environment is Chromium MV3 with uBO syntax and uBO Lite branches', () => {
  const on = ['env_chromium', 'env_mv3', 'ext_ublock', 'ext_ubol', 'adguard_ext_chromium', '!env_firefox'];
  const off = [
    'env_firefox',
    'env_safari',
    'env_mobile',
    'env_edge',
    'cap_html_filtering',
    'cap_ipaddress',
    'cap_user_stylesheet',
    'ext_devbuild',
    'ext_abp',
    'adguard',
    'false',
    '!ext_ubol',
    '!env_chromium',
  ];
  for (const t of on) assert.equal(evaluatePreprocessorExpression(t), true, t);
  for (const t of off) assert.equal(evaluatePreprocessorExpression(t), false, t);
  assert.ok(Object.isFrozen(PREPROCESSOR_ENV));
});

test('uBO Lite branches apply to network filters, uBO branches to scriptlets and cosmetics', () => {
  // ubo-filters.txt. The ext_ubol side swaps bild.de's json-prune pair for
  // trusted-replace-argument and welt.de's no-fetch-if for trusted-prevent-fetch, neither of
  // which StampStack implements: reading scriptlets as uBO Lite left bild.de with none.
  const text = [
    '!#if !ext_ubol',
    'bild.de##+js(json-prune, CLIENT_STORE_INITIAL_STATE.pageAggregation.advertisement.adBlockWallEnabled)',
    'bild.de##+js(json-prune, CLIENT_STORE_INITIAL_STATE.pageAggregation.advertisement.adsOn)',
    '!#else',
    'bild.de##+js(trusted-replace-argument, JSON.parse, 0, repl:/"adBlockWallEnabled":true/"adBlockWallEnabled":false/, condition, adBlockWallEnabled)',
    '!#endif',
    '!#if ext_ubol',
    'welt.de##+js(trusted-prevent-fetch, aud.springserve.com, <VAST version="3.0"></VAST>)',
    '!#else',
    'welt.de##+js(no-fetch-if, aud.springserve.com, war:noop-vast3.xml)',
    '!#endif',
    // Network lines keep uBO Lite's DNR-shaped versions.
    '!#if !ext_ubol',
    '@@||medium.ngtv.io/v2/media/live*$removeparam=ssaiProfile,domain=adultswim.com',
    '!#else',
    '@@||medium.ngtv.io/v2/media/live*$domain=adultswim.com',
    '!#endif',
    '!#if ext_ubol',
    '||cdntrf.com^$script,domain=anisearch.com,redirect=noopjs',
    'example.com##.ubol-only-cosmetic',
    '!#endif',
  ].join('\n');
  assert.deepEqual(kept(text), [
    'bild.de##+js(json-prune, CLIENT_STORE_INITIAL_STATE.pageAggregation.advertisement.adBlockWallEnabled)',
    'bild.de##+js(json-prune, CLIENT_STORE_INITIAL_STATE.pageAggregation.advertisement.adsOn)',
    'welt.de##+js(no-fetch-if, aud.springserve.com, war:noop-vast3.xml)',
    '@@||medium.ngtv.io/v2/media/live*$domain=adultswim.com',
    '||cdntrf.com^$script,domain=anisearch.com,redirect=noopjs',
  ]);
  assert.equal(evaluatePreprocessorExpression('ext_ubol', COSMETIC_PREPROCESSOR_ENV), false);
  assert.equal(evaluatePreprocessorExpression('ext_ublock', COSMETIC_PREPROCESSOR_ENV), true);
  assert.ok(Object.isFrozen(COSMETIC_PREPROCESSOR_ENV));
});

test('an include in a uBO Lite branch keeps only its network lines', () => {
  const resolveInclude = () => '||net.example^\nexample.com##.cos';
  const text = ['!#if ext_ubol', '!#include sub.txt', '!#endif'].join('\n');
  assert.deepEqual(kept(text, { resolveInclude }), ['||net.example^']);
  const mv2 = ['!#if !ext_ubol', '!#include sub.txt', '!#endif'].join('\n');
  assert.deepEqual(kept(mv2, { resolveInclude }), ['example.com##.cos']);
});

test('&&, || and outer parentheses', () => {
  assert.equal(evaluatePreprocessorExpression('env_chromium && !env_mobile'), true);
  assert.equal(evaluatePreprocessorExpression('env_chromium && env_mobile'), false);
  assert.equal(evaluatePreprocessorExpression('env_firefox || env_chromium'), true);
  assert.equal(evaluatePreprocessorExpression('(env_firefox || env_safari)'), false);
  // Mixing the two depends on precedence the lists never use; it is not guessed.
  assert.equal(evaluatePreprocessorExpression('env_chromium || env_firefox && env_safari'), undefined);
  assert.equal(evaluatePreprocessorExpression('env_chromium &&'), undefined);
  assert.equal(evaluatePreprocessorExpression(''), undefined);
});

test('an unknown condition drops both branches and is counted', () => {
  const text = ['!#if env_quantum', '||a.example^', '!#else', '||b.example^', '!#endif', '||c.example^'].join('\n');
  const { lines, stats } = preprocessFilterText(text);
  assert.deepEqual(lines.map((l) => l.trim()), ['||c.example^']);
  assert.equal(stats.unknownConditions, 1);
  assert.equal(stats.droppedRules, 2);
});

test('dropped rules are counted per condition; comments in dropped branches are not', () => {
  const text = [
    '!#if cap_html_filtering',
    '! HTML filters',
    'example.com##^script:has-text(ads)',
    '!#else',
    'example.com##+js(rmnt, script, ads)',
    '!#endif',
    '!#if ext_abp',
    'example.org###cookie',
    'example.net###cookie',
    '!#endif',
  ].join('\n');
  const { lines, stats } = preprocessFilterText(text);
  assert.deepEqual(lines.map((l) => l.trim()), ['example.com##+js(rmnt, script, ads)']);
  assert.equal(stats.droppedRules, 3);
  assert.deepEqual(stats.droppedByCondition, { cap_html_filtering: 1, ext_abp: 2 });
});

test('the else branch of a false condition is labelled as such', () => {
  const text = ['!#if env_chromium', '||x.example^', '!#else', '||y.example^', '!#endif'].join('\n');
  const { stats } = preprocessFilterText(text);
  assert.deepEqual(stats.droppedByCondition, { '!#else of env_chromium': 1 });
});

test('directives count only at the start of a line; `!#name` comments stay comments', () => {
  // EasyList China uses `!#Qq.com`-style section comments.
  const text = ['!#Qq.com', '!#iffy', '  !#if env_firefox', '||kept.example^', '!#endif'].join('\n');
  const { lines } = preprocessFilterText(text);
  assert.ok(lines.some((l) => l.trim() === '||kept.example^'));
});

test('CRLF lists are handled', () => {
  const text = '!#if env_firefox\r\n||ff.example^\r\n!#endif\r\n||all.example^\r\n';
  assert.deepEqual(kept(text), ['||all.example^']);
});

test('an unmatched !#else / !#endif is ignored and an unclosed !#if runs to the end', () => {
  assert.deepEqual(kept('!#endif\n||a.example^\n!#else\n||b.example^'), ['||a.example^', '||b.example^']);
  assert.deepEqual(kept('||a.example^\n!#if env_safari\n||b.example^'), ['||a.example^']);
});

test('!#include is expanded only through resolveInclude, never fetched', () => {
  const files = {
    'sub.txt': '||sub.example^\n!#if env_firefox\n||sub-ff.example^\n!#endif',
  };
  const resolveInclude = (name) => files[name] ?? null;
  const text = [
    '||main.example^',
    '!#include sub.txt',
    '!#include easylist_cookie_specific_uBO.txt',
    '!#if env_safari',
    '!#include sub.txt',
    '!#endif',
  ].join('\n');
  const { lines, stats } = preprocessFilterText(text, { resolveInclude });
  assert.deepEqual(lines.map((l) => l.trim()).filter(Boolean), ['||main.example^', '||sub.example^']);
  assert.deepEqual(stats.includesResolved, ['sub.txt']);
  // Only the include in an active branch is reported, and without a resolver nothing resolves.
  assert.deepEqual(stats.includesUnresolved, ['easylist_cookie_specific_uBO.txt']);
  assert.deepEqual(preprocessFilterText('!#include sub.txt').stats.includesUnresolved, ['sub.txt']);
});

test('an include that includes itself does not loop', () => {
  const resolveInclude = () => '||loop.example^\n!#include self.txt';
  const { lines, stats } = preprocessFilterText('!#include self.txt', { resolveInclude });
  assert.deepEqual(lines.map((l) => l.trim()), ['||loop.example^']);
  assert.deepEqual(stats.includesResolved, ['self.txt']);
  assert.deepEqual(stats.includesUnresolved, ['self.txt']);
});
