// Top-level document context in the filter → DNR converter (review 2026-09-24 B9).
//
// uBO filters a main_frame request in the context of the document being opened, so `domain=`
// names that page and `$1p`/`$3p` compare the page with itself. DNR's initiator is the page
// the navigation came from (none for a typed URL), so these must map onto the request host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine } from '../scripts/lib/parse-filter.mjs';
import { toDnrRule } from '../scripts/lib/to-dnr.mjs';

const convert = (line) => toDnrRule(parseLine(line));
const rulesOf = (out) => out.rules ?? (out.rule ? [out.rule] : []);
const docRule = (out) => rulesOf(out).find((r) => r.condition.resourceTypes?.includes('main_frame'));
const subRule = (out) => rulesOf(out).find((r) => !r.condition.resourceTypes?.includes('main_frame'));

test('$doc,domain= blocks the listed site when it is opened, not links out of it', () => {
  // ubo-badware: blocked only when the link was clicked on a github.io page, never when typed.
  const aws = convert('.amazonaws.com/*.*.*.*.*.*.denied/$doc,domain=amazonaws.com|github.io');
  assert.deepEqual(aws.rule.condition.resourceTypes, ['main_frame']);
  assert.deepEqual(aws.rule.condition.requestDomains, ['amazonaws.com', 'github.io']);
  assert.equal(aws.rule.condition.initiatorDomains, undefined);

  const php = convert('/*.php$doc,domain=maxstream.video');
  assert.deepEqual(php.rule.condition.requestDomains, ['maxstream.video']);
  assert.equal(php.rule.condition.initiatorDomains, undefined);
});

test('$all,domain= splits into a document rule and a subresource rule', () => {
  // `*$all,domain=ytrqcxat.click` blocked every outbound link from that site (Wikipedia
  // included) and never the site itself.
  const out = convert('*$all,domain=ytrqcxat.click');
  assert.equal(out.rules.length, 2);
  const doc = docRule(out);
  assert.deepEqual(doc.condition.resourceTypes, ['main_frame']);
  assert.deepEqual(doc.condition.requestDomains, ['ytrqcxat.click']);
  assert.equal(doc.condition.initiatorDomains, undefined);
  const sub = subRule(out);
  assert.equal(sub.condition.resourceTypes.includes('main_frame'), false);
  assert.ok(sub.condition.resourceTypes.includes('script'));
  assert.deepEqual(sub.condition.initiatorDomains, ['ytrqcxat.click']);
  assert.equal(doc.action.type, 'block');
  assert.equal(sub.action.type, 'block');
});

test('domain=~legit exclusions on typosquat blocks apply to the opened host', () => {
  const out = convert('||discord*.gift^$all,domain=~discord.gift');
  const doc = docRule(out);
  assert.deepEqual(doc.condition.excludedRequestDomains, ['discord.gift']);
  assert.equal(doc.condition.excludedInitiatorDomains, undefined);
  assert.deepEqual(subRule(out).condition.excludedInitiatorDomains, ['discord.gift']);
  // Both exclusion lists fold into the request host for the document part.
  const both = convert('||bloxstrap.*^$doc,domain=~bloxstraplabs.com,to=~bloxstrap.pizzaboxer.xyz');
  assert.deepEqual(both.rule.condition.excludedRequestDomains, [
    'bloxstraplabs.com',
    'bloxstrap.pizzaboxer.xyz',
  ]);
});

test('$1p always holds for a document; $3p never does', () => {
  // A typed URL has no initiator, which DNR counts as third-party: `$doc,1p` never fired.
  const oneP = convert('||multiup.io/download-fast/$doc,1p');
  assert.equal(oneP.rule.condition.domainType, undefined);
  assert.deepEqual(oneP.rule.condition.resourceTypes, ['main_frame']);

  assert.equal(convert('||ads.example^$doc,3p').skip, 'document-third-party');

  const all1p = convert('||ads.example^$all,1p');
  assert.equal(docRule(all1p).condition.domainType, undefined);
  assert.equal(subRule(all1p).condition.domainType, 'firstParty');
});

test('domain= and to= on a document must both hold for the opened host', () => {
  const nested = convert('||x.example^$doc,domain=a.com,to=b.a.com');
  assert.deepEqual(nested.rule.condition.requestDomains, ['b.a.com']);
  assert.equal(convert('||x.example^$doc,domain=a.com,to=b.com').skip, 'document-domain-disjoint');
});

test('$document exceptions scope the page being opened', () => {
  // As an initiator this exempted every page opened FROM example.com.
  const out = convert('@@*$document,domain=example.com');
  assert.equal(out.rule.action.type, 'allowAllRequests');
  assert.deepEqual(out.rule.condition.requestDomains, ['example.com']);
  assert.equal(out.rule.condition.initiatorDomains, undefined);
  // A document exception on a bare public suffix is still refused.
  assert.equal(convert('@@*$document,domain=github.io').skip, 'too-broad-allow-all');
});

test('subresource-only filters keep the initiator mapping', () => {
  const { rule } = convert('||x.example^$script,domain=a.com|~b.a.com,3p');
  assert.deepEqual(rule.condition.initiatorDomains, ['a.com']);
  assert.deepEqual(rule.condition.excludedInitiatorDomains, ['b.a.com']);
  assert.equal(rule.condition.domainType, 'thirdParty');
});

test('a negated-only type list never matches the page being opened', () => {
  // DNR drops main_frame by default only when neither type list is given. Without it in the
  // excludes, `-banner-ads-$~script` blocked a visit to /why-banner-ads-fail, and the
  // easylist-china `$~image,third-party,domain=…` filter blocked every link leaving 57 sites.
  for (const line of [
    '-banner-ads-$~script',
    '-cookie-consent-$~script',
    '/\\.[a-z]+[\\:\\/]/$~image,third-party,domain=bijiyd.com|example.org',
    '://promo.$~media,3p',
    '||eloqua.com^$~stylesheet,3p',
    '@@||example.com^$~image',
  ]) {
    const out = convert(line);
    const rules = rulesOf(out);
    assert.equal(rules.length, 1, line);
    const c = rules[0].condition;
    assert.equal(c.resourceTypes, undefined, line);
    assert.ok(c.excludedResourceTypes.includes('main_frame'), `${line} must exclude main_frame`);
  }
  const { rule } = convert('/\\.[a-z]+[\\:\\/]/$~image,third-party,domain=bijiyd.com');
  assert.deepEqual(rule.condition.excludedResourceTypes, ['image', 'main_frame']);
  assert.deepEqual(rule.condition.initiatorDomains, ['bijiyd.com'], 'subresources keep the initiator');
  // A filter with no types at all is left to DNR's own default.
  assert.equal(convert('-banner-ads-').rule.condition.excludedResourceTypes, undefined);
});

test('negated types subtract from $all (no document part for ~doc)', () => {
  const { rule, rules } = convert('||x.example^$all,~doc,domain=a.com');
  assert.equal(rules, undefined);
  assert.equal(rule.condition.resourceTypes.includes('main_frame'), false);
  assert.ok(rule.condition.resourceTypes.includes('script'));
  assert.equal(rule.condition.excludedResourceTypes, undefined);
});
