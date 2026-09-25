// Which hosts the site switch and the repair ladder can hold, and what one entry covers
// (REVIEW_2026-09-24 B28). go.dev, lg.com, wordpress.com, codesandbox.io and single-label
// intranet hosts were refused by the public-suffix heuristics, silently, while the popup asked
// for a reload; they now get an entry that covers that host alone.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.SS_SW_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
let m;

before(async () => {
  const out = await build({
    stdin: {
      contents: `
        export * from './src/shared/site-rules.ts';
        export { resolveSiteFix, resolveSiteFixEntry } from './src/shared/site-fix.ts';
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
  m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
});

test('ordinary hosts cover their subdomains; refused suffix look-alikes cover themselves only', () => {
  assert.equal(m.siteRuleScope('example.com'), 'domain');
  assert.equal(m.siteRuleScope('www.example.com'), 'domain');
  assert.equal(m.siteRuleScope('10.0.0.1'), 'domain');
  assert.equal(m.siteRuleScope('localhost'), 'domain');
  for (const host of ['go.dev', 'lg.com', 'wordpress.com', 'codesandbox.io', 'intranet', 'nas', 'github.io', 'co.uk']) {
    assert.equal(m.siteRuleScope(host), 'exact', host);
  }
});

test('hosts no rule can hold say why', () => {
  assert.equal(m.siteRuleScope('[::1]'), null);
  assert.equal(m.siteRuleRefusal('[::1]'), 'ipv6');
  assert.equal(m.siteRuleScope('chromewebstore.google.com'), null);
  assert.equal(m.siteRuleRefusal('chromewebstore.google.com'), 'restricted');
  for (const junk of ['', '10.0.0', 'a b', 'foo.123', 'bad_host!']) {
    assert.equal(m.siteRuleScope(junk), null, junk);
    assert.equal(m.siteRuleKey(junk), '', junk);
  }
  assert.equal(m.siteRuleRefusal('go.dev'), null);
});

test('an exact entry never reaches a subdomain, a tenant or a sibling under the suffix', () => {
  assert.equal(m.siteRuleCovers('go.dev', 'go.dev'), true);
  assert.equal(m.siteRuleCovers('go.dev', 'pkg.go.dev'), false);
  assert.equal(m.siteRuleCovers('wordpress.com', 'wordpress.com'), true);
  assert.equal(m.siteRuleCovers('wordpress.com', 'someblog.wordpress.com'), false);
  assert.equal(m.siteRuleCovers('github.io', 'someone.github.io'), false);
  assert.equal(m.siteRuleCovers('co.uk', 'bbc.co.uk'), false);
  assert.equal(m.siteRuleCovers('intranet', 'intranet'), true);
  assert.equal(m.siteRuleCovers('intranet', 'wiki.intranet'), false);
  // A tenant is an ordinary site of its own and covers its subdomains.
  assert.equal(m.siteRuleCovers('someblog.wordpress.com', 'www.someblog.wordpress.com'), true);
  assert.equal(m.siteRuleCovers('example.com', 'shop.example.com'), true);
  assert.equal(m.siteRuleCovers('example.com', 'notexample.com'), false);
});

test('match patterns and DNR conditions carry the same scope', () => {
  assert.deepEqual(m.siteRuleMatchPatterns('go.dev'), ['*://go.dev/*']);
  assert.deepEqual(m.siteRuleMatchPatterns('intranet'), ['*://intranet/*']);
  assert.deepEqual(m.siteRuleMatchPatterns('example.com'), [
    '*://example.com/*',
    '*://*.example.com/*',
    '*://www.example.com/*',
  ]);
  assert.deepEqual(m.siteRuleMatchPatterns('[::1]'), []);
  assert.deepEqual(m.siteRuleDnrConditions('example.com'), [{ requestDomains: ['example.com'] }]);
  // requestDomains alone would cover every host under go.dev, an anchored URL alone also
  // `https://go.dev@evil.example/`; together they cover go.dev alone (checked against Chromium's
  // testMatchOutcome in site-rules-chromium.test.mjs).
  assert.deepEqual(m.siteRuleDnrConditions('go.dev'), [
    { urlFilter: '|https://go.dev^', requestDomains: ['go.dev'] },
    { urlFilter: '|http://go.dev^', requestDomains: ['go.dev'] },
  ]);
  assert.deepEqual(m.siteRuleDnrConditions('[::1]'), []);
});

test('Options input becomes the key the popup would store', () => {
  assert.equal(m.siteRuleKeyFromInput('https://go.dev/doc/'), 'go.dev');
  assert.equal(m.siteRuleKeyFromInput('WWW.Example.com:8080/path'), 'example.com');
  assert.equal(m.siteRuleKeyFromInput('intranet'), 'intranet');
  assert.equal(m.siteRuleKeyFromInput('bücher.de'), 'xn--bcher-kva.de');
  assert.equal(m.siteRuleKeyFromInput('10.0.0'), '');
  assert.equal(m.siteRuleKeyFromInput('http://[::1]/'), '');
});

test('a repair step on go.dev applies there and nowhere under it', () => {
  const fixes = { 'go.dev': 'cosmetics', 'example.com': 'injection' };
  assert.equal(m.resolveSiteFix('go.dev', fixes), 'cosmetics');
  assert.equal(m.resolveSiteFix('pkg.go.dev', fixes), null);
  assert.equal(m.resolveSiteFix('forum.example.com', fixes), 'injection');
});

test('the source of an inherited fix is named, the nearest entry first', () => {
  const fixes = { 'example.com': 'cosmetics', 'shop.example.com': 'cosmetics' };
  assert.deepEqual(m.resolveSiteFixEntry('a.shop.example.com', fixes), {
    level: 'cosmetics',
    entry: 'shop.example.com',
  });
  assert.deepEqual(m.resolveSiteFixEntry('forum.example.com', fixes), {
    level: 'cosmetics',
    entry: 'example.com',
  });
  // The most permissive covering entry still decides, and names itself.
  assert.deepEqual(
    m.resolveSiteFixEntry('a.shop.example.com', { ...fixes, 'example.com': 'injection' }),
    { level: 'injection', entry: 'example.com' },
  );
  assert.equal(m.resolveSiteFixEntry('other.org', fixes), null);
});
