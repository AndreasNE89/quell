// RE2 program-size check for regexFilter rules (review 2026-09-24 B10).
//
// Every pattern below comes from the shipped lists and was checked with Chrome's own
// chrome.declarativeNetRequest.isRegexSupported (Chromium 131, isCaseSensitive: false).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine } from '../scripts/lib/parse-filter.mjs';
import { toDnrRule, re2UnsupportedReason, expandAsciiCase } from '../scripts/lib/to-dnr.mjs';

// Chrome accepts these case-insensitively; Unicode `i` folding rejected them as regex-memory.
const CHROME_ACCEPTS = [
  String.raw`\/[0-9a-f]{32}\/invoke\.js`, // EasyList, generic
  String.raw`\/\w{17}\/`,
  String.raw`\/z-[a-z0-9]{7,10}(\.js)?$`,
  String.raw`^https?:\/\/[a-z]{8,15}\.com\/$`,
  String.raw`(?:com|net)\/[a-z-]{3,10}\.html$`,
  String.raw`^https://[a-z]{40,}\.pages\.dev\/`,
  String.raw`\.com\/[A-Za-z]{9,}\/[A-Za-z]{9,}\.js$`,
  String.raw`^https?:\/\/[a-f0-9]{29,}\.[a-z]{7}\.sbs\b`,
  String.raw`^https?:\/\/pov\.spectrum\.net\/[a-zA-Z0-9]{14,}\.js`,
  String.raw`^https?:\/\/tmx\.(td|tdbank)\.com\/[a-z0-9]{14,18}\.js.*`,
];

// Chrome rejects these (memoryLimitExceeded); shipping them costs a load-time warning each.
const CHROME_REJECTS = [
  String.raw`^https?:\/\/[a-f0-9]{32}\.[a-z]{7}\.sbs\b`,
  String.raw`^https:\/\/cdn\.jsdelivr\.net\/npm\/[-a-z_]{4,22}@latest\/dist\/script\.min\.js$`,
  String.raw`(https?:\/\/)\w{30,}\.me\/\w{30,}\.`,
  String.raw`(https?:\/\/)104\.154\..{100,}`,
];

test('case-insensitive regexes Chrome accepts are not rejected as regex-memory', () => {
  for (const p of CHROME_ACCEPTS) assert.equal(re2UnsupportedReason(p), null, p);
});

test('regexes over Chrome\'s 2KB program budget are still rejected', () => {
  for (const p of CHROME_REJECTS) assert.equal(re2UnsupportedReason(p), 'regex-memory', p);
});

test('EasyList\'s generic invoke.js rule converts', () => {
  const out = toDnrRule(parseLine(String.raw`/\/[0-9a-f]{32}\/invoke\.js/$script,third-party`));
  assert.equal(out.skip, undefined);
  assert.equal(out.rule.condition.regexFilter, String.raw`\/[0-9a-f]{32}\/invoke\.js`);
  assert.equal(out.rule.condition.isUrlFilterCaseSensitive, undefined);
});

test('expandAsciiCase folds ASCII letters the way Latin1 RE2 does', () => {
  assert.equal(expandAsciiCase('ads?[0-9]+'), '[aA][dD][sS]?[0-9]+');
  assert.equal(expandAsciiCase('[a-f0-9]{32}'), '[a-fA-F0-9]{32}');
  assert.equal(expandAsciiCase('[^a-c]'), '[^a-cA-C]');
  assert.equal(expandAsciiCase('[x-]'), '[xX-]');
  assert.equal(expandAsciiCase('[0-Z]'), '[0-Za-z]');
  // Escapes, group headers and counted repeats are not letters to fold.
  assert.equal(expandAsciiCase(String.raw`\d\w\.\x41\p{Lu}`), String.raw`\d\w\.\x41\p{Lu}`);
  assert.equal(expandAsciiCase('(?:a|b){2,3}'), '(?:[aA]|[bB]){2,3}');
  assert.equal(expandAsciiCase('(?P<name>a)'), '(?P<name>[aA])');
  assert.equal(expandAsciiCase('[[:lower:]]'), '[[:lower:]A-Z]');
});
