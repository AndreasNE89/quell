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
