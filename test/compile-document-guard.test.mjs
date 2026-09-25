// Build guard against rules that block whole pages by accident (overblock diagnosis C4).
//
// 2.2.2 shipped 141 block rules that Chrome applied to top-level navigations although their
// filters only left one type out (`-banner-ads-$~script`). A type list made only of exclusions
// reached DNR as `excludedResourceTypes` alone, and Chrome leaves main_frame out by default only
// when neither list is set, so those pages showed "This page has been blocked by an extension".
// to-dnr.mjs now adds main_frame to such excludes, and compile-filters.mjs refuses to write a
// ruleset in which any rule still slips through. This pins the predicate that build step uses:
// against the exact rules 2.2.2 emitted, and against the filters that are meant to block pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseLine } from '../scripts/lib/parse-filter.mjs';
import {
  toDnrRule,
  isAccidentalDocumentRule,
  conditionMatchesMainFrame,
} from '../scripts/lib/to-dnr.mjs';

const rulesOf = (out) => out.rules ?? (out.rule ? [out.rule] : []);
const block = (condition) => ({ id: 1, priority: 1000, action: { type: 'block' }, condition });

/** Filter line → the rule 2.2.2 emitted for it (published 2.2.3 rulesets, domain lists cut). */
const SHIPPED_222 = [
  ['-banner-ads-$~script', { urlFilter: '-banner-ads-', excludedResourceTypes: ['script'] }],
  [
    '/reklame/*$~xmlhttprequest',
    { urlFilter: '/reklame/*', excludedResourceTypes: ['xmlhttprequest'] },
  ],
  [
    '://ads.$~image,~xmlhttprequest,domain=~ads.apple.com|~ads.brave.com',
    {
      urlFilter: '://ads.',
      excludedResourceTypes: ['image', 'xmlhttprequest'],
      excludedInitiatorDomains: ['ads.apple.com', 'ads.brave.com'],
    },
  ],
  [
    '://promo.$~media,third-party,domain=~promo.com',
    {
      urlFilter: '://promo.',
      excludedResourceTypes: ['media'],
      domainType: 'thirdParty',
      excludedInitiatorDomains: ['promo.com'],
    },
  ],
  [
    '||2mdn.net^$~media,third-party',
    { urlFilter: '||2mdn.net^', excludedResourceTypes: ['media'], domainType: 'thirdParty' },
  ],
  ['||ads.yahoo.com^$~image', { urlFilter: '||ads.yahoo.com^', excludedResourceTypes: ['image'] }],
  [
    '/impressions?$~xmlhttprequest',
    { urlFilter: '/impressions?', excludedResourceTypes: ['xmlhttprequest'] },
  ],
];

test('Chrome applies a rule to top-level pages unless its type lists keep them out', () => {
  assert.equal(conditionMatchesMainFrame({}), false, 'no type list: Chrome skips main_frame');
  assert.equal(conditionMatchesMainFrame({ urlFilter: '||x^' }), false);
  assert.equal(conditionMatchesMainFrame({ excludedResourceTypes: ['script'] }), true);
  assert.equal(conditionMatchesMainFrame({ excludedResourceTypes: ['script', 'main_frame'] }), false);
  assert.equal(conditionMatchesMainFrame({ resourceTypes: ['main_frame'] }), true);
  assert.equal(conditionMatchesMainFrame({ resourceTypes: ['script', 'image'] }), false);
});

test('rejects every rule shape 2.2.2 shipped for a negated-only filter', () => {
  for (const [line, condition] of SHIPPED_222) {
    assert.equal(isAccidentalDocumentRule(block(condition), parseLine(line)), true, line);
  }
});

test('rejects a subresource filter whose rule reaches the page by any route', () => {
  // A parser that filled in every type for a typeless filter would list main_frame outright.
  const listed = block({ urlFilter: '||ads.example^', resourceTypes: ['script', 'main_frame'] });
  assert.equal(isAccidentalDocumentRule(listed, parseLine('||ads.example^$script')), true);
  assert.equal(isAccidentalDocumentRule(listed, parseLine('||ads.example^')), true);
  // Redirects replace the response, so a redirected page is as gone as a blocked one.
  const redirect = {
    id: 1,
    priority: 2000,
    action: { type: 'redirect', redirect: { extensionPath: '/redirects/noop.js' } },
    condition: { urlFilter: '||ads.example/x.js', excludedResourceTypes: ['image'] },
  };
  assert.equal(
    isAccidentalDocumentRule(redirect, parseLine('||ads.example/x.js$~image,redirect=noopjs')),
    true,
  );
  // `$all,~doc` asks for every type except the page: listing main_frame anyway is still wrong.
  assert.equal(
    isAccidentalDocumentRule(
      block({ urlFilter: '||x.example^', resourceTypes: ['main_frame', 'script'] }),
      parseLine('||x.example^$all,~doc'),
    ),
    true,
  );
});

test('the current converter keeps those filters off top-level pages', () => {
  for (const [line] of SHIPPED_222) {
    const rules = rulesOf(toDnrRule(parseLine(line)));
    assert.ok(rules.length > 0, `${line} converts`);
    for (const rule of rules) {
      assert.equal(conditionMatchesMainFrame(rule.condition), false, line);
      assert.equal(isAccidentalDocumentRule(rule, parseLine(line)), false, line);
    }
  }
});

test('accepts filters that ask for the page: $doc, $document, $all and $removeparam', () => {
  for (const line of [
    '||phish.example^$doc',
    '||phish.example^$document,reason=malicious',
    '||malware.example^$all',
    // Splits into a document part scoped to the site and a subresource part (B9).
    '*$all,domain=ytrqcxat.click',
    '||discord*.gift^$all,domain=~discord.gift',
    '$removeparam=utm_source',
    '||news.example^$removeparam=fbclid',
    // A bare $removeparam clears the query; the parser leaves it for toDnrRule.
    '||example.com/track?$removeparam',
  ]) {
    const parsed = parseLine(line);
    const rules = rulesOf(toDnrRule(parsed));
    assert.ok(
      rules.some((r) => conditionMatchesMainFrame(r.condition)),
      `${line}: expected a rule that reaches the page, or this case proves nothing`,
    );
    for (const rule of rules) assert.equal(isAccidentalDocumentRule(rule, parsed), false, line);
  }
});

test('leaves exceptions and type-less rules alone', () => {
  for (const line of ['@@||example.com^$~image', '@@||site.example^$document', '||ads.example^']) {
    const parsed = parseLine(line);
    for (const rule of rulesOf(toDnrRule(parsed))) {
      assert.equal(isAccidentalDocumentRule(rule, parsed), false, line);
    }
  }
  // An allow that reaches the page cannot block it, whatever its filter says.
  const allow = {
    id: 1,
    priority: 3000,
    action: { type: 'allow' },
    condition: { excludedResourceTypes: ['image'] },
  };
  assert.equal(isAccidentalDocumentRule(allow, parseLine('@@||example.com^$~image')), false);
});

test('compile-filters runs the guard on every list before writing its ruleset', () => {
  // The guard only helps if the build calls it; the lists change under the tests above.
  const src = readFileSync('scripts/compile-filters.mjs', 'utf8');
  const guard = src.indexOf('assertNoAccidentalDocumentRules(list.id, documentRules)');
  const write = src.indexOf('writeFileSync(rulesetPath');
  assert.ok(guard > 0, 'compile-filters no longer calls assertNoAccidentalDocumentRules');
  assert.ok(guard < write, 'the guard must run before the ruleset is written');
  assert.match(src, /documentRules\.push\(\{ rule, filter: parsed \}\)/);
});
