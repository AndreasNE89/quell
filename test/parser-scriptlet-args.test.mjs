// Scriptlet argument parsing must match uBO's ArglistParser: quoted arguments, and backslashes
// that are only consumed when they escape a delimiter. Fixtures are the shipped list lines the
// 2026-09-24 review traced (inline, so a list refresh cannot silently change them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine, splitArgs } from '../scripts/lib/parse-filter.mjs';

const args = (line) => parseLine(line).scriptlet.args;

/** The RegExp a scriptlet builds from a `/pattern/flags` argument. */
function regexArg(arg) {
  const m = /^\/(.*)\/([a-z]*)$/.exec(arg);
  assert.ok(m, `not a regex argument: ${arg}`);
  return new RegExp(m[1], m[2]);
}

test('datanodes.to rmnt keeps `\\\\x` as a literal backslash-x, not every "x"', () => {
  const a = args(String.raw`datanodes.to##+js(rmnt, script, /\\x|_blank/)`);
  assert.deepEqual(a, ['script', String.raw`/\\x|_blank/`]);
  const re = regexArg(a[1]);
  // The collapsed `/\x|_blank/` matched this and blanked nearly every inline script.
  assert.equal(re.test('var max = 1;'), false);
  assert.equal(re.test(String.raw`eval("\x61\x62")`), true);
});

test('filemoon/embedmoon acs still matches the hex-escaped source it targets', () => {
  const a = args(
    String.raw`embedmoon.*,filemoon.*,kerapoxy.*##+js(acs, Math, /window\['(?:\\x[0-9a-f]{2}){2}/)`,
  );
  assert.deepEqual(a, ['Math', String.raw`/window\['(?:\\x[0-9a-f]{2}){2}/`]);
  const re = regexArg(a[1]);
  assert.equal(re.test(String.raw`window['\x61\x62']`), true);
  assert.equal(re.test("window['x61x62']"), false);
});

test('adhs-zentrum nostif stays a valid RegExp', () => {
  const a = args(String.raw`adhs-zentrum.de##+js(nostif, /Werbeblocker|refresh\\/)`);
  assert.deepEqual(a, [String.raw`/Werbeblocker|refresh\\/`]);
  // Collapsed to `refresh\` it was an invalid pattern and the rule threw away.
  assert.equal(regexArg(a[0]).test(String.raw`location.refresh\ `), true);
});

test('a quoted regex containing a comma is one argument, unquoted (Facebook rpnt)', () => {
  const a = args(
    `web.facebook.com,www.facebook.com##+js(rpnt, script, '/"[a-z0-9]{8}":true,/g', , condition, compat_iframe_token)`,
  );
  assert.deepEqual(a, ['script', '/"[a-z0-9]{8}":true,/g', '', 'condition', 'compat_iframe_token']);
  assert.equal(regexArg(a[1]).test('{"abcd1234":true,"x":1}'), true);
});

test('a backtick-quoted needle is one argument (uBO Admiral rmnt)', () => {
  const needle =
    '/"v4ac1eiZr0"|""\\)\\.split\\(","\\)\\[4\\]|(\\.localStorage\\)|JSON\\.parse\\(\\w)\\.getItem\\("|["\']_aQS0\\w+["\']|decodeURI\\(decodeURI\\("|<a href="https:\\/\\/getad%|"cmp\\.updated"/';
  const a = args(`15min.lt,arstechnica.com##+js(rmnt, script, \`${needle}\`)`);
  assert.deepEqual(a, ['script', needle]);
  assert.equal(regexArg(a[1]).test('var k = ("").split(",")[4];'), true);
});

test('quotes around a needle are removed, quotes inside it are kept (EasyPrivacy Admiral)', () => {
  assert.deepEqual(args(`nypost.com,cbsnews.com##+js(rmnt, script, '"data-adm-url"')`), [
    'script',
    '"data-adm-url"',
  ]);
  assert.deepEqual(args(`abc17news.com,al.com##+js(rmnt, script, '"v4ac1eiZr0"')`), [
    'script',
    '"v4ac1eiZr0"',
  ]);
});

test('a double-quoted argument may contain commas and single quotes (bigshare rpnt)', () => {
  assert.deepEqual(
    args(`bigshare.io##+js(rpnt, script, "art.on('video:play', setUpAds);", art.on('video:play');)`),
    ['script', "art.on('video:play', setUpAds);", "art.on('video:play');"],
  );
});

test('a quoted regex with a `{9,11}` quantifier keeps its argument count (Tokopedia)', () => {
  const a = args(
    String.raw`tokopedia.com##+js(trusted-replace-fetch-response, '/\{"id":\d{9,11}(?:(?!"ads":\{"id":"").)+?"ads":\{"id":"\d+".+?"__typename":"ProductCarouselV2"\},?/g', , /graphql/InspirationCarousel)`,
  );
  assert.equal(a.length, 3);
  assert.equal(a[1], '');
  assert.equal(a[2], '/graphql/InspirationCarousel');
  assert.ok(regexArg(a[0]).global);
});

test('backslash escapes: only an odd run before the active delimiter is consumed', () => {
  assert.deepEqual(splitArgs(String.raw`a\,b, c`), ['a,b', 'c']);
  assert.deepEqual(splitArgs(String.raw`a\\,b`), [String.raw`a\\`, 'b']);
  assert.deepEqual(splitArgs(String.raw`a\\\,b`), [String.raw`a\\,b`]);
  // Inside quotes the quote is the delimiter; `\,` is left alone.
  assert.deepEqual(splitArgs(String.raw`'it\'s', x`), ["it's", 'x']);
  assert.deepEqual(splitArgs(String.raw`'a\,b', x`), [String.raw`a\,b`, 'x']);
  assert.deepEqual(splitArgs(String.raw`'a\\', x`), [String.raw`a\\`, 'x']);
  // Other backslashes survive for regex arguments.
  assert.deepEqual(splitArgs(String.raw`/[^\n]\?\//`), [String.raw`/[^\n]\?\//`]);
});

test('quotes count only when the closing quote ends the argument', () => {
  // Text after the closing quote: read unquoted, quotes included.
  assert.deepEqual(splitArgs(`'a'b, c`), [`'a'b`, 'c']);
  // No closing quote at all.
  assert.deepEqual(splitArgs(`'abc, d`), [`'abc`, 'd']);
  // Whitespace between the closing quote and the comma is fine.
  assert.deepEqual(splitArgs(`'a,b'  , c`), ['a,b', 'c']);
  assert.deepEqual(splitArgs(`""`), ['']);
});

test('arguments are trimmed; empty middle arguments are kept', () => {
  assert.deepEqual(splitArgs('  set ,  a.b ,  , c  '), ['set', 'a.b', '', 'c']);
  assert.deepEqual(args('example.com##+js( set-constant , canRunAds , true )'), ['canRunAds', 'true']);
  assert.equal(parseLine('example.com##+js( set-constant , x)').scriptlet.name, 'set-constant');
});

test('AdGuard //scriptlet() arguments may contain commas inside their quotes', () => {
  const p = parseLine(`example.com#%#//scriptlet('set-constant', 'a, b', 'x')`);
  assert.equal(p.scriptlet.name, 'set-constant');
  assert.deepEqual(p.scriptlet.args, ['a, b', 'x']);
});
