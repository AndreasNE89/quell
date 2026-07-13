// Tests for the filter → DNR converter (parse-filter.mjs + to-dnr.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine } from '../scripts/lib/parse-filter.mjs';
import { toDnrRule } from '../scripts/lib/to-dnr.mjs';
import { PRIORITY } from '../scripts/lib/limits.mjs';

/** Parse a single line and convert it (if network). */
function convert(line) {
  const p = parseLine(line);
  return { parsed: p, dnr: p?.type === 'network' ? toDnrRule(p) : null };
}

test('comments and blanks are ignored', () => {
  assert.equal(parseLine('! a comment'), null);
  assert.equal(parseLine(''), null);
  assert.equal(parseLine('[Adblock Plus 2.0]'), null);
});

test('basic block rule with resource type + third-party', () => {
  const { parsed, dnr } = convert('||ads.example^$script,third-party');
  assert.equal(parsed.type, 'network');
  assert.equal(parsed.pattern, '||ads.example^');
  assert.deepEqual(parsed.options.resourceTypes, ['script']);
  assert.equal(parsed.options.thirdParty, true);

  assert.equal(dnr.rule.action.type, 'block');
  assert.equal(dnr.rule.priority, PRIORITY.BLOCK);
  assert.equal(dnr.rule.condition.urlFilter, '||ads.example^');
  assert.deepEqual(dnr.rule.condition.resourceTypes, ['script']);
  assert.equal(dnr.rule.condition.domainType, 'thirdParty');
});

test('document exception becomes allowAllRequests', () => {
  const { dnr } = convert('@@||good.example^$document');
  assert.equal(dnr.rule.action.type, 'allowAllRequests');
  assert.equal(dnr.rule.priority, PRIORITY.ALLOW);
  assert.deepEqual(dnr.rule.condition.resourceTypes, ['main_frame', 'sub_frame']);
});

test('non-document exception is a plain allow', () => {
  const { dnr } = convert('@@||api.example^$xmlhttprequest');
  assert.equal(dnr.rule.action.type, 'allow');
  assert.equal(dnr.rule.priority, PRIORITY.ALLOW);
  assert.deepEqual(dnr.rule.condition.resourceTypes, ['xmlhttprequest']);
});

test('domain option maps to initiator include/exclude', () => {
  const { dnr } = convert('||x.example^$domain=a.com|~b.com');
  assert.deepEqual(dnr.rule.condition.initiatorDomains, ['a.com']);
  assert.deepEqual(dnr.rule.condition.excludedInitiatorDomains, ['b.com']);
});

test('redirect rule outranks block and points at the bundled resource', () => {
  const { dnr } = convert('||host.example/ad.js$script,redirect=noopjs');
  assert.equal(dnr.rule.action.type, 'redirect');
  assert.equal(dnr.rule.action.redirect.extensionPath, '/redirects/noop.js');
  assert.equal(dnr.rule.priority, PRIORITY.REDIRECT);
  assert.ok(dnr.rule.priority > PRIORITY.BLOCK, 'redirect must beat block');
  assert.ok(dnr.rule.priority < PRIORITY.ALLOW, 'allow must beat redirect');
});

test('important redirect outranks important block', () => {
  const { dnr } = convert('||host.example/ad.js$script,redirect=noopjs,important');
  assert.equal(dnr.rule.action.type, 'redirect');
  assert.equal(dnr.rule.priority, PRIORITY.IMPORTANT_REDIRECT);
  assert.ok(dnr.rule.priority > PRIORITY.IMPORTANT_BLOCK);
  assert.ok(dnr.rule.priority < PRIORITY.IMPORTANT_ALLOW);
});

test('$redirect-rule is skipped (not expressible in DNR)', () => {
  const { dnr } = convert('||host.example/ad.js$script,redirect-rule=noopjs');
  assert.equal(dnr.skip, 'redirect-rule');
});

test('$csp is skipped rather than emitted as block', () => {
  const { dnr } = convert('||example.com^$csp=script-src');
  assert.ok(dnr.skip?.startsWith('unsupported:'), dnr.skip);
});

test('$to maps to requestDomains', () => {
  const { dnr } = convert('||tracker.example^$to=ads.example|~cdn.example');
  assert.deepEqual(dnr.rule.condition.requestDomains, ['ads.example']);
  assert.deepEqual(dnr.rule.condition.excludedRequestDomains, ['cdn.example']);
});

test('$generichide with a pattern is a cosmetic exception, not network allow', () => {
  const { dnr } = convert('@@||example.com^$generichide');
  assert.equal(dnr.rule, undefined);
  assert.equal(dnr.cosmeticException, 'generichide');
});

test('ruleKey distinguishes $important from plain block', async () => {
  const { ruleKey } = await import('../scripts/lib/to-dnr.mjs');
  const a = convert('||ads.example^').dnr.rule;
  const b = convert('||ads.example^$important').dnr.rule;
  assert.notEqual(ruleKey(a), ruleKey(b));
});

test('noop.txt redirect resource resolves', () => {
  const { dnr } = convert('||host.example/pixel$redirect=nooptext');
  assert.equal(dnr.rule.action.redirect.extensionPath, '/redirects/noop.txt');
});

test('unknown redirect resource is skipped, not emitted', () => {
  const { dnr } = convert('||host.example/ad.js$redirect=totally-unknown');
  assert.ok(dnr.skip, 'should skip');
});

test('regex rule maps to regexFilter', () => {
  const { parsed, dnr } = convert('/ads?[0-9]+/$script');
  assert.equal(parsed.isRegex, true);
  assert.equal(dnr.rule.condition.regexFilter, 'ads?[0-9]+');
  assert.equal(dnr.rule.condition.urlFilter, undefined);
});

test('regex with a $ end-anchor and internal slashes is preserved (not mis-split)', () => {
  const { parsed, dnr } = convert('/ad/banner$/');
  assert.equal(parsed.isRegex, true, 'still recognized as a full regex');
  assert.equal(dnr.rule.condition.regexFilter, 'ad/banner$', 'end-anchor and slash kept');
  assert.equal(dnr.rule.action.type, 'block');
});

test('regex end-anchor + options: body and options both survive', () => {
  const { parsed, dnr } = convert('/ads$/$script');
  assert.equal(parsed.isRegex, true);
  assert.equal(dnr.rule.condition.regexFilter, 'ads$');
  assert.deepEqual(dnr.rule.condition.resourceTypes, ['script']);
});

test('should skip regex with positive lookahead (RE2 / Chrome DNR rejects)', () => {
  // Real offender from ubo-filters (was static rule id 1302).
  const line =
    '/^https?:\\/\\/[a-z]{8,15}\\.com?\\/(?=[0-9a-zA-Z]*%)(?=[%a-zA-Z]*\\d)(?=[%0-9a-z]*[A-Z])[%0-9a-zA-Z]{170,}$/$script,3p';
  const { dnr } = convert(line);
  assert.equal(dnr.skip, 'regex-lookaround');
  assert.equal(dnr.rule, undefined);
});

test('should skip regex with negative lookahead', () => {
  const { dnr } = convert('/^https?:\\/\\/[a-z]{8,15}\\.top\\/(?!api|available|team)[a-z]{4,}\\.json$/$script');
  assert.equal(dnr.skip, 'regex-lookaround');
});

test('should skip regex with backreference', () => {
  const { dnr } = convert('/^https:\\/\\/[0-9a-z]{7}\\.([0-9a-z]{7})\\.top\\/[0-9a-z]{7}\\?t=\\1/$script');
  assert.equal(dnr.skip, 'regex-backref');
});

test('should skip regex with repetition count above RE2 max (1000)', () => {
  const { dnr } = convert('/a{1001}/$script');
  assert.equal(dnr.skip, 'regex-repeat-limit');
});

test('should emit compact RE2-safe regex without lookarounds', () => {
  const { dnr } = convert('/^https?:\\/\\/cdn\\.example\\.com\\/lib\\/[a-z0-9]{6,12}\\.js$/$script');
  assert.equal(dnr.skip, undefined);
  assert.equal(
    dnr.rule.condition.regexFilter,
    '^https?:\\/\\/cdn\\.example\\.com\\/lib\\/[a-z0-9]{6,12}\\.js$',
  );
});

test('should skip regex that exceeds Chrome DNR ~2KB compiled memory (jsdelivr offender)', () => {
  // easyprivacy static rule id 13120 — Chrome: "regexFilter value exceeded the 2KB memory limit".
  const line =
    '/^https:\\/\\/cdn\\.jsdelivr\\.net\\/npm\\/[-a-z_]{4,22}@latest\\/dist\\/script\\.min\\.js$/$script,third-party';
  const { dnr } = convert(line);
  assert.equal(dnr.skip, 'regex-memory');
  assert.equal(dnr.rule, undefined);
});

test('should skip nested counted character-class regex (ubo-badware offender)', () => {
  // Nested `{7,25}` inside `{9,13}` blows RE2 Prog size past Chrome's max_mem.
  const line =
    '/\\/(?:[0-9a-z]{7,25}-){9,13}[0-9a-z]{10,15}\\/(?:[0-9a-z]+\\/)+index\\.php/$document';
  const { dnr } = convert(line);
  assert.equal(dnr.skip, 'regex-memory');
});

test('should skip large counted any-byte regex (gorhill memoryLimitExceeded sample)', () => {
  const { dnr } = convert('/(https?:\\/\\/)104\\.154\\..{100,}/$script');
  assert.equal(dnr.skip, 'regex-memory');
});

test('re2UnsupportedReason reports regex-memory for oversized class repeats', async () => {
  const { re2UnsupportedReason } = await import('../scripts/lib/to-dnr.mjs');
  assert.equal(re2UnsupportedReason('[-a-z_]{4,22}'), 'regex-memory');
  assert.equal(re2UnsupportedReason('ads?[0-9]+'), null);
});

test('should sanitize ||* urlFilter (Chrome forbids domain-anchor + leading wildcard)', () => {
  // Real offender from ubo-filters (was static rule id 4217).
  const { dnr } = convert('||*ontent.steamplay.*^$all');
  assert.equal(dnr.skip, undefined);
  assert.equal(dnr.rule.condition.urlFilter, '*ontent.steamplay.*^');
  assert.ok(!dnr.rule.condition.urlFilter.startsWith('||*'));
});

test('should sanitize ||* via normalizeUrlFilter', async () => {
  const { normalizeUrlFilter } = await import('../scripts/lib/to-dnr.mjs');
  assert.deepEqual(normalizeUrlFilter('||*ads.example^'), { urlFilter: '*ads.example^' });
  assert.deepEqual(normalizeUrlFilter('||ads.example^'), { urlFilter: '||ads.example^' });
  assert.equal(normalizeUrlFilter('').skip, 'empty-url-filter');
  assert.equal(normalizeUrlFilter('||*').skip, 'url-filter-star');
});

test('bare @@||domain^ exception is a plain allow, NOT allowAllRequests', () => {
  const { dnr } = convert('@@||ads.example^');
  assert.equal(dnr.rule.action.type, 'allow');
  assert.equal(dnr.rule.condition.urlFilter, '||ads.example^');
  assert.equal(dnr.rule.condition.resourceTypes, undefined, 'matches all types by request URL');
});

test('negated-resource-type exception never emits both resourceTypes and excludedResourceTypes', () => {
  const { dnr } = convert('@@||example.com^$~image');
  assert.equal(dnr.rule.action.type, 'allow');
  assert.deepEqual(dnr.rule.condition.excludedResourceTypes, ['image']);
  assert.equal(dnr.rule.condition.resourceTypes, undefined, 'Chrome rejects both fields together');
});

test('$important raises block priority above exceptions', () => {
  const { dnr } = convert('||x.example^$important');
  assert.equal(dnr.rule.priority, PRIORITY.IMPORTANT_BLOCK);
  assert.ok(dnr.rule.priority > PRIORITY.ALLOW);
});

test('$match-case sets case sensitivity', () => {
  const { dnr } = convert('||X.example^$match-case');
  assert.equal(dnr.rule.condition.isUrlFilterCaseSensitive, true);
});

test('overly broad filter (no url/regex/domain/type) is dropped', () => {
  const { dnr } = convert('$third-party');
  assert.ok(dnr.skip, 'should skip too-broad rule');
});

test('negated resource type maps to excludedResourceTypes', () => {
  const { dnr } = convert('||x.example^$~script');
  assert.deepEqual(dnr.rule.condition.excludedResourceTypes, ['script']);
});

test('cosmetic hide rule parses domain + selector', () => {
  const p = parseLine('example.com,~sub.example.com##.ad-box');
  assert.equal(p.type, 'cosmetic');
  assert.equal(p.kind, 'hide');
  assert.deepEqual(p.domains.include, ['example.com']);
  assert.deepEqual(p.domains.exclude, ['sub.example.com']);
  assert.equal(p.selector, '.ad-box');
});

test('generic cosmetic has no domains', () => {
  const p = parseLine('##.adsbygoogle');
  assert.equal(p.kind, 'hide');
  assert.deepEqual(p.domains.include, []);
  assert.deepEqual(p.domains.exclude, []);
});

test('cosmetic exception is unhide', () => {
  const p = parseLine('example.com#@#.ad-box');
  assert.equal(p.kind, 'unhide');
  assert.equal(p.isException, true);
});

test('procedural cosmetic detected', () => {
  const p = parseLine('example.com##.box:has-text(Sponsored)');
  assert.equal(p.kind, 'procedural');
});

test('uBO scriptlet syntax parses name + args', () => {
  const p = parseLine('example.com##+js(set-constant, canRunAds, true)');
  assert.equal(p.kind, 'scriptlet');
  assert.equal(p.scriptlet.name, 'set-constant');
  assert.deepEqual(p.scriptlet.args, ['canRunAds', 'true']);
});

test('AdGuard scriptlet syntax parses', () => {
  const p = parseLine("example.com#%#//scriptlet('abort-on-property-read', 'ads')");
  assert.equal(p.kind, 'scriptlet');
  assert.equal(p.scriptlet.name, 'abort-on-property-read');
  assert.deepEqual(p.scriptlet.args, ['ads']);
});
