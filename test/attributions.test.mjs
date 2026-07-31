// Every shipped filter list must be attributed.
//
// These lists are third-party work under GPL / CC BY-SA / LGPL, and attribution is a licence
// condition, not a courtesy. docs/attributions.html ships inside the package as privacy.html's
// sibling, so it is the extension's own statement of what it is built from.
//
// EasyList China and CJX's Annoyance List were added in 2.2.0 and reached a submitted build
// before anyone noticed they were missing from it. Adding a list is a two-line change to
// filters/lists.json; remembering the attribution page is the part that does not happen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const registry = JSON.parse(readFileSync('filters/lists.json', 'utf8'));
const page = readFileSync('docs/attributions.html', 'utf8');

/** Rows as { list, project, licence }. */
function attributionRows() {
  return [
    ...page.matchAll(
      /<td>([^<]+)<\/td>\s*<td><a[^>]*href="([^"]+)"[^>]*>[^<]*<\/a><\/td>\s*<td>([^<]+)<\/td>/g,
    ),
  ].map((m) => ({ list: decode(m[1]), url: m[2], licence: m[3].trim() }));
}

/**
 * Decode the entities the page uses for typography.
 * Without this, "CJX&rsquo;s Annoyance List" never matches the registry's "CJX Annoyance" —
 * which is exactly how this check first failed against a page that was in fact correct.
 */
function decode(html) {
  return html
    .replace(/&rsquo;|&#8217;/g, '’')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/** Compare on words, so punctuation and possessives cannot break a real match. */
const words = (s) =>
  s
    .toLowerCase()
    .replace(/[’'`]s\b/g, '')
    .split(/[^a-z0-9一-鿿]+/)
    .filter(Boolean);

/** Upstream lists only — quell-seed is ours and has nothing to attribute. */
const upstream = registry.lists.filter((l) => l.url);

test('the attributions page has rows to check', () => {
  // Guards the checks below: a regex that matched nothing would make them vacuous.
  assert.ok(attributionRows().length >= 5, `found ${attributionRows().length} rows`);
});

test('every upstream filter list is attributed', () => {
  const rows = attributionRows();
  // Match on a distinctive word from the title rather than the whole string: the registry
  // title carries a group suffix ("EasyList Cookie (annoyances)") the page does not.
  const missing = upstream.filter((l) => {
    // Registry titles carry a group suffix the page does not ("EasyList Cookie (annoyances)"),
    // and the page adds words the registry does not ("CJX's Annoyance List"). Match when one
    // side's words are all present in the other.
    // One direction only. Allowing the reverse let the "EasyList" row satisfy "EasyList
    // China" — deleting the China row then passed, which is precisely the case this exists
    // to catch. The page may add words; it may not drop them.
    const want = words(l.title.replace(/\s*\(.*$/, ''));
    return !rows.some((r) => want.every((w) => words(r.list).includes(w)));
  });
  assert.deepEqual(
    missing.map((l) => l.id),
    [],
    'these ship in the package with no attribution, which their licences require',
  );
});

test('every attribution names a licence and links the project', () => {
  for (const r of attributionRows()) {
    assert.match(r.licence, /GPL|CC BY|MIT|LGPL|Apache/i, `${r.list}: licence "${r.licence}" unrecognised`);
    assert.match(r.url, /^https:\/\//, `${r.list}: project link is not https`);
  }
});

test('the page ships inside the extension', () => {
  // scripts/build.mjs copies it to dist/attributions.html. If that stops, the statement is
  // only in the repo, where a user never sees it.
  const build = readFileSync('scripts/build.mjs', 'utf8');
  assert.match(build, /attributions\.html/, 'build.mjs no longer copies the attributions page');
});

test('a list added without attribution is caught', () => {
  // Proves the check discriminates rather than passing on anything.
  const rows = attributionRows();
  const stem = 'some-list-nobody-attributed';
  assert.equal(
    rows.some((r) => r.list.toLowerCase().includes(stem)),
    false,
  );
});
