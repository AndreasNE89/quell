// Tests for the user-sent breakage report (src/shared/breakage-report.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: ['src/shared/breakage-report.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'neutral',
});
const { buildBreakageReport, browserLabel } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

const NOW = Date.parse('2026-07-27T12:00:00.000Z');

const facts = (over = {}) => ({
  hostname: 'shop.example.com',
  siteFix: null,
  allowlisted: false,
  version: '2.0.0',
  listsGeneratedAt: '2026-07-24T14:22:55.000Z',
  activeRuleCount: 120377,
  degraded: false,
  enabledLists: ['quell-seed', 'easylist'],
  browser: 'Chrome 138',
  now: NOW,
  ...over,
});

test('the subject names the site so a triage inbox sorts itself', () => {
  const r = buildBreakageReport(facts());
  assert.equal(r.subject, 'StampStack breakage: shop.example.com');
  assert.equal(r.to, 'andreas.nelvik.engebretsen@gmail.com');
});

test('the body asks for a description before the diagnostics', () => {
  const r = buildBreakageReport(facts());
  assert.match(r.body, /^What looked wrong on shop\.example\.com\?/);
  assert.ok(r.body.indexOf('What looked wrong') < r.body.indexOf('--- details'));
});

test('every diagnostic line is present and labelled', () => {
  const b = buildBreakageReport(facts()).body;
  for (const key of ['site:', 'repair step:', 'version:', 'filter lists:', 'rules active:', 'lists on:', 'browser:']) {
    assert.ok(b.includes(key), `missing ${key}`);
  }
  assert.match(b, /site: *shop\.example\.com/);
  assert.match(b, /version: *2\.0\.0/);
  assert.match(b, /rules active: *120,377/);
  assert.match(b, /lists on: *quell-seed, easylist/);
  // 24 Jul 14:22 → 27 Jul 12:00 is 2 whole days, not 3 — the age floors rather than rounds.
  assert.match(b, /filter lists: *24 Jul 2026 \(2d old\)/);
});

test('the repair rung reached is stated in words, not a code', () => {
  const at = (over) => buildBreakageReport(facts(over)).body;
  assert.match(at({ siteFix: null }), /repair step: *everything on \(no repair applied\)/);
  assert.match(at({ siteFix: 'cosmetics' }), /repair step: *element hiding off/);
  assert.match(at({ siteFix: 'injection' }), /repair step: *element hiding and scriptlets off/);
  assert.match(at({ allowlisted: true }), /repair step: *blocking off for this site \(allowlisted\)/);
});

test('an allowlisted site reports that, even with a repair rung also set', () => {
  // The allowlist supersedes the ladder, so reporting the rung would be misleading.
  assert.match(
    buildBreakageReport(facts({ allowlisted: true, siteFix: 'cosmetics' })).body,
    /repair step: *blocking off/,
  );
});

test('a degraded ruleset is called out next to the rule count', () => {
  assert.match(buildBreakageReport(facts({ degraded: true })).body, /reduced — a list did not load/);
  assert.equal(/reduced/.test(buildBreakageReport(facts()).body), false);
});

test('no enabled lists says so rather than leaving the field blank', () => {
  assert.match(buildBreakageReport(facts({ enabledLists: [] })).body, /lists on: *none/);
});

test('an unknown list date does not fabricate an age', () => {
  const b = buildBreakageReport(facts({ listsGeneratedAt: null })).body;
  assert.match(b, /filter lists: *unknown/);
  assert.equal(/NaN|Invalid/.test(b), false);
});

test('the mailto round-trips the exact subject and body', () => {
  const r = buildBreakageReport(facts());
  assert.ok(r.mailto.startsWith('mailto:andreas.nelvik.engebretsen@gmail.com?'));
  const q = new URLSearchParams(r.mailto.slice(r.mailto.indexOf('?') + 1));
  assert.equal(q.get('subject'), r.subject);
  assert.equal(q.get('body'), r.body);
});

test('a hostname with characters needing escaping stays intact through the URL', () => {
  const r = buildBreakageReport(facts({ hostname: 'xn--bcher-kva.example' }));
  const q = new URLSearchParams(r.mailto.slice(r.mailto.indexOf('?') + 1));
  assert.match(q.get('body'), /site: *xn--bcher-kva\.example/);
  // Newlines must survive as newlines, or the diagnostics arrive as one run-on line.
  assert.ok(q.get('body').includes('\n'));
});

test('the report carries no page content, URL or observed hosts', () => {
  const r = buildBreakageReport(facts({ hostname: 'news.example.com' }));
  // Only the hostname may appear — never a path, query or third-party host.
  assert.equal(/https?:\/\//.test(r.body), false);
  assert.equal(r.body.includes('?'), true); // the "What looked wrong ...?" prompt only
  assert.equal((r.body.match(/news\.example\.com/g) ?? []).length, 2); // prompt + site row
});

test('the diagnostics block stays small enough for a mailto', () => {
  // Mail clients start truncating well before this; the report has no reason to be large.
  const r = buildBreakageReport(facts({ enabledLists: Array.from({ length: 20 }, (_, i) => `list-${i}`) }));
  assert.ok(r.mailto.length < 2000, `mailto was ${r.mailto.length} chars`);
});

test('browser labels prefer the specific brand over the Chrome they all claim', () => {
  const edge = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36 Edg/138.0.1',
    opera = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36 OPR/124.0',
    chrome = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36';
  assert.equal(browserLabel(edge), 'Edge 138');
  assert.equal(browserLabel(opera), 'Opera 124');
  assert.equal(browserLabel(chrome), 'Chrome 138');
});

test('an unrecognised or absent user agent degrades to "unknown"', () => {
  for (const ua of [null, undefined, '', 'Mozilla/5.0 (something else entirely)']) {
    assert.equal(browserLabel(ua), 'unknown');
  }
});
