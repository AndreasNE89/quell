// Every shipped filter list and every bundled package must be attributed.
//
// These lists are third-party work under GPL / CC BY-SA / CC BY / LGPL, and attribution is a
// licence condition, not a courtesy. docs/attributions.html ships inside the package as
// privacy.html's sibling, so it is the extension's own statement of what it is built from.
//
// EasyList China and CJX's Annoyance List were added in 2.2.0 and reached a submitted build
// before anyone noticed they were missing from it. Adding a list is a two-line change to
// filters/lists.json; remembering the attribution page is the part that does not happen. The
// same went for the code: ExtPay and webextension-polyfill were bundled from the start with no
// notice or licence text anywhere in the package (REVIEW_2026-09-24 M17).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

const registry = JSON.parse(read('filters', 'lists.json'));
const page = read('docs', 'attributions.html');
const markdown = read('ATTRIBUTIONS.md');
const LICENSES = join(ROOT, 'docs', 'licenses');
const notices = read('docs', 'licenses', 'THIRD_PARTY_NOTICES.txt');

/** Filter-list rows of the page as { list, url, licence }. */
function pageRows(html = page) {
  return [
    ...html.matchAll(
      /<td>([^<]+)<\/td>\s*<td><a[^>]*href="([^"]+)"[^>]*>[^<]*<\/a><\/td>\s*<td>([^<]+)<\/td>/g,
    ),
  ].map((m) => ({ list: decode(m[1]), url: m[2], licence: m[3].trim() }));
}

/** Filter-list rows of ATTRIBUTIONS.md's table as { list, url, licence }. */
function markdownRows() {
  const section = markdown.split(/^## /m).find((s) => s.startsWith('Filter lists')) ?? '';
  return section
    .split(/\r?\n/)
    .filter((l) => /^\|/.test(l) && !/^\|\s*-/.test(l) && !/^\|\s*List\s*\|/.test(l))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
    .map(([list, project, licence]) => ({
      list,
      url: /\]\(([^)]+)\)/.exec(project)?.[1] ?? '',
      licence: licence.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'),
    }));
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

/**
 * Registry lists with no row naming them.
 *
 * Registry titles carry a group suffix the page does not ("EasyList Cookie (annoyances)"), and
 * the page adds words the registry does not ("CJX's Annoyance List"). Match when every word of
 * the title (suffix dropped) is in a row. One direction only: allowing the reverse let the
 * "EasyList" row satisfy "EasyList China", so deleting the China row passed, which is precisely
 * the case this exists to catch. The page may add words; it may not drop them.
 */
function unattributed(lists, rows) {
  return lists.filter((l) => {
    const want = words(l.title.replace(/\s*\(.*$/, ''));
    return !rows.some((r) => want.every((w) => words(r.list).includes(w)));
  });
}

/** Upstream lists only — quell-seed is ours and has nothing to attribute. */
const upstream = registry.lists.filter((l) => l.url);

test('the attributions page and ATTRIBUTIONS.md have rows to check', () => {
  // Guards the checks below: a regex that matched nothing would make them vacuous.
  assert.ok(pageRows().length >= upstream.length, `found ${pageRows().length} page rows`);
  assert.ok(markdownRows().length >= upstream.length, `found ${markdownRows().length} markdown rows`);
});

test('every upstream filter list is attributed, on the page and in ATTRIBUTIONS.md', () => {
  assert.deepEqual(
    unattributed(upstream, pageRows()).map((l) => l.id),
    [],
    'these ship in the package with no attribution, which their licences require',
  );
  assert.deepEqual(
    unattributed(upstream, markdownRows()).map((l) => l.id),
    [],
    'ATTRIBUTIONS.md is missing lists the shipped page names',
  );
});

test('the page and ATTRIBUTIONS.md give each list the same licence', () => {
  const md = new Map(markdownRows().map((r) => [words(r.list).join(' '), r.licence]));
  for (const r of pageRows()) {
    const key = words(r.list).join(' ');
    assert.ok(md.has(key), `ATTRIBUTIONS.md has no row for "${r.list}"`);
    assert.equal(md.get(key), r.licence, `${r.list}: the two attributions disagree`);
  }
});

test('a list added without attribution is caught', () => {
  // Proves the check discriminates: run the matcher itself on a list nobody attributed, and on
  // a page with a real row removed.
  const invented = { id: 'some-list', title: 'Nobody Attributed This (ads)', url: 'https://x.example/l.txt' };
  assert.deepEqual(unattributed([invented], pageRows()).map((l) => l.id), ['some-list']);
  const china = registry.lists.find((l) => l.id === 'easylist-china');
  const withoutChina = page.replace(/<tr>\s*<td>EasyList China<\/td>[\s\S]*?<\/tr>/, '');
  assert.notEqual(withoutChina, page, 'fixture: the China row exists to remove');
  assert.deepEqual(unattributed([china], pageRows(withoutChina)).map((l) => l.id), ['easylist-china']);
});

test('every attribution names a licence and links the project', () => {
  for (const r of pageRows()) {
    assert.match(r.licence, /GPL|CC BY|MIT|LGPL|Apache|MPL/i, `${r.list}: licence "${r.licence}" unrecognised`);
    assert.match(r.url, /^https:\/\//, `${r.list}: project link is not https`);
  }
});

test("a list's Creative Commons licence matches the one its own header declares", () => {
  // EasyList Cookie was attributed "GPLv3 / CC BY-SA 3.0" while its header says CC BY 3.0.
  const CC = { by: 'CC BY', 'by-sa': 'CC BY-SA', 'by-nc-sa': 'CC BY-NC-SA' };
  let checked = 0;
  for (const list of upstream) {
    const file = join(ROOT, 'filters', list.file);
    if (!existsSync(file)) continue;
    const header = readFileSync(file, 'utf8').slice(0, 4000);
    const m = /^!\s*Licen[cs]e:\s*https?:\/\/creativecommons\.org\/licenses\/([a-z-]+)\/(\d\.\d)/im.exec(header);
    if (!m) continue;
    const want = `${CC[m[1]] ?? m[1]} ${m[2]}`;
    const title = words(list.title.replace(/\s*\(.*$/, ''));
    const row = pageRows().find((r) => title.every((w) => words(r.list).includes(w)));
    assert.ok(row, `${list.id}: no row`);
    assert.ok(
      namesLicence(row.licence, want),
      `${list.id}: its header says ${want}, the page says "${row.licence}"`,
    );
    checked++;
  }
  assert.ok(checked >= 1, 'expected at least one list with a Creative Commons header (EasyList Cookie)');
});

/** `licence` names `want` exactly, not as a prefix of a longer licence (CC BY vs CC BY-SA). */
function namesLicence(licence, want) {
  return new RegExp(`(^|[^\\w-])${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(licence);
}

// --- bundled code --------------------------------------------------------------------------------

/** Every package the extension bundles: package.json dependencies and theirs, from node_modules. */
function bundledPackages() {
  const seen = new Map();
  const visit = (name) => {
    if (seen.has(name)) return;
    const pkg = JSON.parse(read('node_modules', name, 'package.json'));
    seen.set(name, pkg);
    for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep);
  };
  for (const dep of Object.keys(JSON.parse(read('package.json')).dependencies ?? {})) visit(dep);
  return [...seen.values()];
}

test('every bundled package is attributed with its version, on the page, in the notices and in ATTRIBUTIONS.md', () => {
  const packages = bundledPackages();
  assert.ok(packages.length >= 2, 'extpay and webextension-polyfill at least');
  for (const pkg of packages) {
    const row = new RegExp(`<tr data-package="${pkg.name}">([\\s\\S]*?)</tr>`).exec(page)?.[1];
    assert.ok(row, `attributions.html has no row for ${pkg.name}`);
    assert.match(row, new RegExp(`<td>${pkg.version.replace(/\./g, '\\.')}</td>`), `${pkg.name}: page version`);
    assert.ok(notices.includes(`${pkg.name} ${pkg.version}`), `THIRD_PARTY_NOTICES.txt: ${pkg.name} ${pkg.version}`);
    assert.ok(
      notices.includes(`https://registry.npmjs.org/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`),
      `THIRD_PARTY_NOTICES.txt: source of ${pkg.name} ${pkg.version}`,
    );
    assert.match(markdown, new RegExp(`\\| ${pkg.version.replace(/\./g, '\\.')} \\|`), `ATTRIBUTIONS.md: ${pkg.name}`);
  }
});

test('every licence a bundled package declares ships as text or is linked', () => {
  const TEXT = { 'MPL-2.0': 'MPL-2.0.txt', 'LGPL-3.0': 'LGPL-3.0.txt', 'GPL-3.0': 'GPL-3.0.txt' };
  for (const pkg of bundledPackages()) {
    const declared = [pkg.license, readFileSyncIf(join(ROOT, 'node_modules', pkg.name, 'LICENSE'))]
      .filter(Boolean)
      .join(' ');
    for (const id of ['MPL-2.0', 'LGPL-3.0', 'AGPL-3.0', 'GPL-3.0']) {
      const re = new RegExp(`(^|[^A-Z])${id.replace('.', '\\.')}`);
      if (!re.test(declared.replace(/Mozilla Public License Version 2\.0/, 'MPL-2.0'))) continue;
      if (TEXT[id]) {
        assert.ok(existsSync(join(LICENSES, TEXT[id])), `${pkg.name} is ${id}: docs/licenses/${TEXT[id]} missing`);
        assert.ok(notices.includes(TEXT[id]), `THIRD_PARTY_NOTICES.txt does not point at ${TEXT[id]}`);
      } else {
        assert.ok(notices.includes('https://www.gnu.org/licenses/agpl-3.0.txt'), `${pkg.name} is ${id}: no link`);
      }
    }
  }
  // The LGPL is a set of additional permissions on the GPL and must travel with it.
  assert.match(readFileSync(join(LICENSES, 'LGPL-3.0.txt'), 'utf8'), /GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3/);
  assert.match(readFileSync(join(LICENSES, 'GPL-3.0.txt'), 'utf8'), /GNU GENERAL PUBLIC LICENSE\s+Version 3/);
  assert.match(readFileSync(join(LICENSES, 'MPL-2.0.txt'), 'utf8'), /^Mozilla Public License Version 2\.0/);
});

function readFileSyncIf(p) {
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

test('the page links every licence text it ships', () => {
  for (const f of ['THIRD_PARTY_NOTICES.txt', 'GPL-3.0.txt', 'LGPL-3.0.txt', 'MPL-2.0.txt']) {
    assert.ok(existsSync(join(LICENSES, f)), `docs/licenses/${f} missing`);
    assert.match(page, new RegExp(`href="licenses/${f.replace('.', '\\.')}"`), `attributions.html does not link ${f}`);
  }
});
