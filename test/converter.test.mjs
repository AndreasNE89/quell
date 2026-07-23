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
  assert.deepEqual(dnr.rule.condition.resourceTypes, ['main_frame']);
});

test('$document,$subdocument exception allowlists both frame types', () => {
  const { dnr } = convert('@@||good.example^$document,subdocument');
  assert.equal(dnr.rule.action.type, 'allowAllRequests');
  assert.deepEqual(dnr.rule.condition.resourceTypes, ['main_frame', 'sub_frame']);
});

test('unscoped $document exception is dropped (would globally allowAllRequests)', () => {
  for (const line of ['@@$document', '@@*$document', '@@||*$document']) {
    const { dnr } = convert(line);
    assert.equal(dnr.skip, 'too-broad-allow-all', line);
  }
});

test('match-all URL/regex $document exceptions are dropped (residual global AAR)', () => {
  // Presence of urlFilter/regexFilter alone is not enough scope — these match every
  // (or every http(s)) navigation and would disable network blocking site-wide.
  for (const line of [
    '@@/.*/$document',
    '@@/.+/$document',
    '@@/^/$document',
    '@@/$document',
    '@@|$document',
    '@@^$document',
    '@@||^$document',
    '@@||.$document',
    '@@/https?:\\/\\//$document',
  ]) {
    const { dnr } = convert(line);
    assert.equal(dnr.skip, 'too-broad-allow-all', line);
  }
});

test('path-scoped $document exception still allowAllRequests', () => {
  const { dnr } = convert('@@/ads.js$document');
  assert.equal(dnr.rule.action.type, 'allowAllRequests');
  assert.equal(dnr.rule.condition.urlFilter, '/ads.js');
});

test('hostname-scoped regex $document exception still allowAllRequests', () => {
  const { dnr } = convert('@@/^https:\\/\\/good\\.example\\//$document');
  assert.equal(dnr.rule.action.type, 'allowAllRequests');
  assert.equal(dnr.rule.condition.regexFilter, '^https:\\/\\/good\\.example\\/');
});

test('$document with initiator domain still allowAllRequests', () => {
  const { dnr } = convert('@@$document,domain=good.example');
  assert.equal(dnr.rule.action.type, 'allowAllRequests');
  assert.deepEqual(dnr.rule.condition.initiatorDomains, ['good.example']);
  assert.deepEqual(dnr.rule.condition.resourceTypes, ['main_frame']);
});

test('$subdocument exception is plain allow on sub_frame, not allowAllRequests', () => {
  // EasyList ships rules like @@||g.doubleclick.net/pagead/ads$subdocument,domain=…
  // These must only unblock the iframe document request, not the whole frame tree.
  const { dnr } = convert('@@||ads.example/pagead$subdocument,domain=site.example');
  assert.equal(dnr.rule.action.type, 'allow');
  assert.deepEqual(dnr.rule.condition.resourceTypes, ['sub_frame']);
  assert.deepEqual(dnr.rule.condition.initiatorDomains, ['site.example']);
});

test('$frame exception (uBO alias) is plain allow on sub_frame', () => {
  const { dnr } = convert('@@||ads.example/pagead?$frame,domain=site.example');
  assert.equal(dnr.rule.action.type, 'allow');
  assert.deepEqual(dnr.rule.condition.resourceTypes, ['sub_frame']);
});

test('$script,subdocument exception stays plain allow with both types', () => {
  const { dnr } = convert('@@||cdn.example/x$script,subdocument');
  assert.equal(dnr.rule.action.type, 'allow');
  assert.deepEqual(dnr.rule.condition.resourceTypes, ['script', 'sub_frame']);
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

test('isValidDnrDomain accepts canonical hosts / IPv4 / bracketed IPv6, rejects wildcards', async () => {
  const { isValidDnrDomain } = await import('../scripts/lib/to-dnr.mjs');
  assert.equal(isValidDnrDomain('example.com'), true);
  assert.equal(isValidDnrDomain('sub.example.co.uk'), true);
  assert.equal(isValidDnrDomain('192.168.1.1'), true);
  assert.equal(isValidDnrDomain('[::1]'), true, 'bracketed IPv6');
  assert.equal(isValidDnrDomain('gmx.*'), false, 'entity wildcard');
  assert.equal(isValidDnrDomain('$domain=fortune.com'), false, 'option bleed');
  assert.equal(isValidDnrDomain(''), false);
});

test('entity-wildcard $domain drops invalid entries, keeping valid ones', () => {
  const { dnr } = convert('||x.example/a.js$script,domain=gmx.*|realsite.com');
  assert.equal(dnr.skip, undefined);
  assert.deepEqual(dnr.rule.condition.initiatorDomains, ['realsite.com']);
});

test('rule scoped ONLY to an invalid entity domain is skipped (not shipped globally)', () => {
  // ||uim.tifbs.net/js/*.js$domain=gmx.* — dropping gmx.* would block the script on every
  // site, broader than the author scoped it. Skip instead.
  const { dnr } = convert('||uim.tifbs.net/js/x.js$script,domain=gmx.*');
  assert.equal(dnr.rule, undefined);
  assert.equal(dnr.skip, 'invalid-domain');
});

test('bracketed-IPv6 excluded initiator domains are kept when valid', () => {
  const { dnr } = convert('||0.0.0.0^$domain=~[::1]|~[::]');
  assert.equal(dnr.skip, undefined);
  assert.deepEqual(dnr.rule.condition.excludedInitiatorDomains, ['[::1]', '[::]']);
  assert.equal(dnr.rule.action.type, 'block');
});

test('entity-wildcard $to (requestDomains) with no valid entry is skipped', () => {
  const { dnr } = convert('||tracker.example^$to=gmx.*');
  assert.equal(dnr.rule, undefined);
  assert.equal(dnr.skip, 'invalid-domain');
});

test('$generichide with a pattern is a cosmetic exception, not network allow', () => {
  const { dnr } = convert('@@||example.com^$generichide');
  assert.equal(dnr.rule, undefined);
  assert.equal(dnr.cosmeticException, 'generichide');
});

test('should map uBO $ghide/$ehide/$shide aliases to cosmetic exceptions', () => {
  // ubo-filters ships ~859 $ghide rules; treating them as unsupported dropped all of them.
  assert.equal(convert('@@||bild.de^$ghide').dnr.cosmeticException, 'generichide');
  assert.equal(convert('@@||example.com^$ehide').dnr.cosmeticException, 'elemhide');
  assert.equal(convert('@@||example.com^$shide').dnr.cosmeticException, 'specifichide');
  assert.equal(convert('@@*$ghide,domain=web.de|gmx.*').dnr.cosmeticException, 'generichide');
  assert.equal(convert('@@*$ghide,domain=web.de|gmx.*').dnr.skip, undefined);
  assert.deepEqual(convert('@@*$ghide,domain=web.de|gmx.*').parsed.options.initiatorDomains, [
    'web.de',
    'gmx.*',
  ]);
});

test('should extract entity hosts from generichide patterns for runtime matching', async () => {
  const { hostsFromPattern } = await import('../scripts/lib/parse-filter.mjs');
  // EasyList: @@||www.google.*/search?$generichide — must not become dead host `www.google`.
  assert.deepEqual(hostsFromPattern('||www.google.*/search?', false), ['google.*']);
  assert.deepEqual(hostsFromPattern('||pahe.*^', false), ['pahe.*']);
  assert.deepEqual(hostsFromPattern('||userupload.*^', false), ['userupload.*']);
  assert.deepEqual(hostsFromPattern('||example.com^', false), ['example.com']);
  assert.deepEqual(hostsFromPattern('||mail.google.com^', false), ['mail.google.com']);
});

test('should map trailing-dot hostname prefixes to entity keys for generichide', async () => {
  const { hostsFromPattern } = await import('../scripts/lib/parse-filter.mjs');
  // ubo-filters: @@||stream4free.$ghide — must not become bare `stream4free`
  // (suffix match misses stream4free.tv; would only hit *.stream4free).
  assert.deepEqual(hostsFromPattern('||stream4free.', false), ['stream4free.*']);
  assert.deepEqual(hostsFromPattern('||asd.', false), ['asd.*']);
  assert.deepEqual(hostsFromPattern('||shrink.', false), ['shrink.*']);
  assert.deepEqual(hostsFromPattern('||asd.^', false), ['asd.*']);
  // Multi-label hosts stay exact — do not treat example.com. as entity.
  assert.deepEqual(hostsFromPattern('||example.com.', false), ['example.com']);
});

test('$removeparam=<name> becomes a queryTransform redirect', () => {
  const { dnr } = convert('||example.com^$removeparam=fbclid');
  assert.equal(dnr.rule.action.type, 'redirect');
  assert.deepEqual(dnr.rule.action.redirect.transform.queryTransform.removeParams, ['fbclid']);
  assert.equal(dnr.rule.priority, PRIORITY.REDIRECT);
  assert.equal(dnr.rule.condition.urlFilter, '||example.com^');
});

test('global $removeparam (no pattern) is allowed, not dropped as too-broad', () => {
  const { dnr } = convert('$removeparam=utm_source');
  assert.equal(dnr.skip, undefined);
  assert.deepEqual(dnr.rule.action.redirect.transform.queryTransform.removeParams, ['utm_source']);
  assert.equal(dnr.rule.condition.urlFilter, undefined);
});

test('regex / negated / bare $removeparam is skipped, not mis-emitted', () => {
  assert.ok(convert('||x.example^$removeparam=/utm_.*/').dnr.skip?.startsWith('unsupported'));
  assert.ok(convert('||x.example^$removeparam=~keep').dnr.skip?.startsWith('unsupported'));
});

test('@@...$removeparam exception is skipped (cannot be narrowly exempted)', () => {
  const { dnr } = convert('@@||example.com^$removeparam=fbclid');
  assert.equal(dnr.rule, undefined);
  assert.equal(dnr.skip, 'exception-removeparam');
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

test('path-anchored filter with options is not treated as full regex', () => {
  // `/ad/image/*$image` has a second `/` but is a path pattern, not `/regex/`.
  // Options must split at `$`; otherwise `$image` stays in urlFilter and the rule is dead.
  const { parsed, dnr } = convert('/ad/image/*$image');
  assert.equal(parsed.isRegex, false);
  assert.equal(parsed.pattern, '/ad/image/*');
  assert.deepEqual(parsed.options.resourceTypes, ['image']);
  assert.equal(dnr.rule.condition.urlFilter, '/ad/image/*');
  assert.deepEqual(dnr.rule.condition.resourceTypes, ['image']);
  assert.ok(!String(dnr.rule.condition.urlFilter).includes('$'));
});

test('should keep literal $ in URL path (Azure $web) and still parse $doc options', () => {
  // ubo-badware: ||blob.core.windows.net/$web/*index.html$doc
  // Splitting at the first `$` dropped this phishing rule as unsupported:web/*index.html$doc.
  const { parsed, dnr } = convert('||blob.core.windows.net/$web/*index.html$doc');
  assert.equal(parsed.pattern, '||blob.core.windows.net/$web/*index.html');
  assert.deepEqual(parsed.options.resourceTypes, ['main_frame']);
  assert.equal(parsed.unsupported.length, 0);
  assert.equal(dnr.skip, undefined);
  assert.equal(dnr.rule.condition.urlFilter, '||blob.core.windows.net/$web/*index.html');
  assert.deepEqual(dnr.rule.condition.resourceTypes, ['main_frame']);
});

test('should keep literal $.min.js path and parse $script,3p options', () => {
  // ubo-filters: /$.min.js|$script,3p — first `$` is part of the path; `|` is right-anchor.
  const { parsed, dnr } = convert('/$.min.js|$script,3p');
  assert.equal(parsed.pattern, '/$.min.js|');
  assert.deepEqual(parsed.options.resourceTypes, ['script']);
  assert.equal(parsed.options.thirdParty, true);
  assert.equal(parsed.unsupported.length, 0);
  assert.equal(dnr.rule.condition.urlFilter, '/$.min.js|');
  assert.deepEqual(dnr.rule.condition.resourceTypes, ['script']);
});

test('should strip entity domains from DNR but keep valid siblings', () => {
  // Chrome ignores the whole rule if initiatorDomains contains `gmx.*`.
  const { dnr } = convert('||uim.tifbs.net/js/*.js$script,redirect=noopjs,domain=gmx.*|web.de');
  assert.equal(dnr.skip, undefined);
  assert.deepEqual(dnr.rule.condition.initiatorDomains, ['web.de']);
  assert.ok(!dnr.rule.condition.initiatorDomains.some((d) => d.includes('*')));
});

test('should skip rule when $domain is only entity wildcards (would become global)', () => {
  const { dnr } = convert('/pop.js$domain=booru.*');
  assert.equal(dnr.skip, 'invalid-domain');
  assert.equal(dnr.rule, undefined);
});

test('should skip rule when $to uses entity wildcard', () => {
  const { dnr } = convert('||tikimall.$doc,to=tikimall.*|~tiki.vn');
  assert.equal(dnr.skip, 'invalid-domain');
});

test('should skip rule when excluded domain is invalid (dropping exclude would over-match)', async () => {
  const { isValidDnrDomain, sanitizeDnrDomainLists } = await import('../scripts/lib/to-dnr.mjs');
  assert.equal(isValidDnrDomain('web.de'), true);
  assert.equal(isValidDnrDomain('gmx.*'), false);
  assert.equal(isValidDnrDomain('$domain=fortune.com'), false);
  assert.equal(isValidDnrDomain('[::1]'), true);
  assert.equal(sanitizeDnrDomainLists(['web.de'], ['evil.*']).skip, 'invalid-domain');
  assert.deepEqual(sanitizeDnrDomainLists(['gmx.*', 'web.de'], []), {
    include: ['web.de'],
    exclude: [],
  });
});

test('should skip $replace with trailing / instead of emitting regexFilter', () => {
  // Path ends with `/` from replace=/…/ — must not be treated as full regex with no options.
  const { parsed, dnr } = convert(
    '/theme/002/js/application.js?2.0|$script,1p,replace=/video\\.maxPop/0/',
  );
  assert.equal(parsed.pattern, '/theme/002/js/application.js?2.0|');
  assert.ok(parsed.unsupported.some((t) => t.startsWith('replace=')));
  assert.equal(dnr.skip, 'unsupported:replace');
  assert.equal(dnr.rule, undefined);
});

test('should skip $replace when value contains commas', () => {
  const { parsed, dnr } = convert('||ads.example^$script,replace=/a,b/');
  assert.equal(parsed.pattern, '||ads.example^');
  assert.ok(parsed.unsupported.some((t) => t.startsWith('replace=')));
  assert.equal(dnr.skip, 'unsupported:replace');
});

test('should skip $header when value contains escaped commas', () => {
  const { parsed, dnr } = convert(
    '||example.com^$script,header=vary:/^referer\\,accept-encoding/i',
  );
  assert.equal(parsed.pattern, '||example.com^');
  assert.deepEqual(parsed.options.resourceTypes, ['script']);
  assert.ok(parsed.unsupported.some((t) => t.startsWith('header=')));
  assert.equal(dnr.skip, 'unsupported:header');
});

test('should still parse full regex with $options after closing slash', () => {
  const { parsed, dnr } = convert('/^ads$/$script,3p');
  assert.equal(parsed.pattern, '/^ads$/');
  assert.equal(parsed.isRegex, true);
  assert.deepEqual(parsed.options.resourceTypes, ['script']);
  assert.equal(parsed.options.thirdParty, true);
  assert.equal(dnr.skip, undefined);
  assert.equal(dnr.rule.condition.regexFilter, '^ads$');
});

test('should parse $badfilter without treating it as unsupported', () => {
  const { parsed, dnr } = convert('||ads.example^$script,badfilter');
  assert.equal(parsed.options.badfilter, true);
  assert.equal(dnr.badfilter, true);
  assert.equal(dnr.rule, undefined);
  assert.equal(dnr.skip, undefined);
});

test('should ignore uBO $reason metadata and still emit the network block', () => {
  // ubo-badware: ||designrigoroso.com^$all,reason=malicious — $reason is display-only.
  // Treating it as unsupported skipped the whole phishing/malware host block.
  const plain = convert('||designrigoroso.com^$all,reason=malicious');
  assert.equal(plain.parsed.unsupported.length, 0);
  assert.equal(plain.dnr.skip, undefined);
  assert.equal(plain.dnr.rule.action.type, 'block');
  assert.equal(plain.dnr.rule.condition.urlFilter, '||designrigoroso.com^');

  const quoted = convert('||outertune.org^$doc,reason="Not the official site"');
  assert.equal(quoted.parsed.unsupported.length, 0);
  assert.equal(quoted.dnr.skip, undefined);
  assert.equal(quoted.dnr.rule.action.type, 'block');
  assert.deepEqual(quoted.dnr.rule.condition.resourceTypes, ['main_frame']);

  const regex = convert(
    '/^https?:\\/\\/gitcoin-[a-z]+\\.com\\//$all,reason="Blatant scammers who are not related to GitHub or Gitcoin whatsoever."',
  );
  assert.equal(regex.parsed.unsupported.length, 0);
  assert.equal(regex.dnr.skip, undefined);
  assert.equal(regex.dnr.rule.action.type, 'block');
  assert.equal(regex.dnr.rule.condition.regexFilter, '^https?:\\/\\/gitcoin-[a-z]+\\.com\\/');
});

test('should match badfilter identity to target without badfilter token', async () => {
  const { networkFilterIdentity } = await import('../scripts/lib/to-dnr.mjs');
  const bad = parseLine('||ads.example^$script,badfilter');
  const target = parseLine('||ads.example^$script');
  assert.equal(networkFilterIdentity(bad), networkFilterIdentity(target));
  const other = parseLine('||ads.example^$image');
  assert.notEqual(networkFilterIdentity(bad), networkFilterIdentity(other));
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
  // Use $match-case so validation mirrors Chrome's case-sensitive compile path;
  // the same counted class is over budget when compiled case-insensitively.
  const { dnr } = convert(
    '/^https?:\\/\\/cdn\\.example\\.com\\/lib\\/[a-z0-9]{6,12}\\.js$/$script,match-case',
  );
  assert.equal(dnr.skip, undefined);
  assert.equal(
    dnr.rule.condition.regexFilter,
    '^https?:\\/\\/cdn\\.example\\.com\\/lib\\/[a-z0-9]{6,12}\\.js$',
  );
  assert.equal(dnr.rule.condition.isUrlFilterCaseSensitive, true);
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

test('should skip case-insensitive regex that exceeds Chrome 2KB memory (ubo-badware sbs)', () => {
  // Chrome 118+ defaults isUrlFilterCaseSensitive to false. Validating only with
  // case-sensitive RE2 underestimates Prog size — these shipped and Chrome skipped them.
  const line = '/^https?:\\/\\/[a-f0-9]{32}\\.[a-z]{7}\\.sbs\\b/$doc,to=sbs';
  const { dnr } = convert(line);
  assert.equal(dnr.skip, 'regex-memory');
});

test('should skip dense repeated-class regex under case-insensitive compile (ubo-badware)', () => {
  const line =
    '/^https?:\\/\\/[a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9]\\.[a-z][a-z][a-z][a-z][a-z][a-z][a-z]\\.sbs\\//$doc,to=sbs';
  const { dnr } = convert(line);
  assert.equal(dnr.skip, 'regex-memory');
});

test('should skip match-case regex near Chrome Latin1 2KB ceiling (ubo-filters 4247)', () => {
  // Unicode/`u` compiles under 1990 but Chrome Latin1 still rejects — tighter budget.
  const line =
    '/^https:\\/\\/[a-z0-9-]{7,}\\.[a-z]{3,6}\\/(?:load|register)\\/(?:movie|show|episode)\\/[0-9]+(?:\\/[0-9]{1,2}){0,2}\\/?\\?[a-z]+=[a-zA-Z0-9%&]+(?:&[a-z]+=[0-9a-z]+)?$/$doc,match-case,to=~edu|~gov';
  const { dnr } = convert(line);
  assert.equal(dnr.skip, 'regex-memory');
});

test('re2UnsupportedReason reports regex-memory for oversized class repeats', async () => {
  const { re2UnsupportedReason } = await import('../scripts/lib/to-dnr.mjs');
  assert.equal(re2UnsupportedReason('[-a-z_]{4,22}'), 'regex-memory');
  assert.equal(re2UnsupportedReason('ads?[0-9]+'), null);
  // Chrome default is case-insensitive; counted classes often fit only when `$match-case`.
  assert.equal(re2UnsupportedReason('[a-z]{10,20}'), 'regex-memory');
  assert.equal(re2UnsupportedReason('[a-z]{10,20}', { caseSensitive: true }), null);
  // ubo-badware hex.sbs — over budget even with match-case (Latin1 margin).
  assert.equal(
    re2UnsupportedReason('^https?:\\/\\/[a-f0-9]{32}\\.[a-z]{7}\\.sbs\\b', { caseSensitive: true }),
    'regex-memory',
  );
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
