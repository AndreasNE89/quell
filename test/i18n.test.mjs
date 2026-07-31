// The translation catalog must stay in step with the code that uses it.
//
// A missing key is silent: chrome.i18n.getMessage returns '' and the UI renders blank rather
// than failing. A locale that lags behind English is the normal way that happens — someone adds
// a string, English gets it, the others do not, and only a Chinese-speaking user ever sees the
// hole. These checks are the only thing standing between that and a shipped blank label.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const LOCALES_DIR = 'src/_locales';
const DEFAULT_LOCALE = 'en';

const locales = existsSync(LOCALES_DIR)
  ? readdirSync(LOCALES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  : [];

const catalog = (locale) =>
  JSON.parse(readFileSync(join(LOCALES_DIR, locale, 'messages.json'), 'utf8'));

/** Keys referenced from markup (data-i18n / data-i18n-attr) and from TS (msg('key')). */
function keysUsed() {
  const used = new Set();
  for (const f of ['src/popup/popup.html', 'src/options/options.html']) {
    const html = readFileSync(f, 'utf8');
    for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) used.add(m[1]);
    for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
      for (const pair of m[1].split(',')) {
        const key = pair.split(':')[1]?.trim();
        if (key) used.add(key);
      }
    }
  }
  // Any key-shaped literal, not just `msg('literal')`. Keys are chosen at runtime all over:
  // ternaries for singular/plural, a GROUP_LABEL lookup map, multi-line calls. Matching only
  // the direct-literal form reported 25 live keys as orphans. The `popup_`/`options_` prefix
  // makes these unambiguous — nothing else in the source is shaped like that.
  const prefixes = [];
  for (const f of ['src/popup/popup.ts', 'src/options/options.ts']) {
    const ts = readFileSync(f, 'utf8');
    for (const m of ts.matchAll(/['"`]((?:popup|options)_[a-z0-9_]+)['"`]/g)) used.add(m[1]);
    // Keys assembled at runtime: msg(`options_list_age_${level}`). The literal part is a
    // prefix, and every catalog key under it is reachable.
    for (const m of ts.matchAll(/`((?:popup|options)_[a-z0-9_]*)\$\{/g)) prefixes.push(m[1]);
  }
  return { used, prefixes };
}

/** A key counts as used if it is named outright or falls under a runtime-built prefix. */
function isUsed(key, { used, prefixes }) {
  return used.has(key) || prefixes.some((p) => key.startsWith(p));
}

test('the default locale exists', () => {
  assert.ok(locales.includes(DEFAULT_LOCALE), `src/_locales/${DEFAULT_LOCALE} is missing`);
});

test('the manifest declares the default locale', () => {
  const man = JSON.parse(readFileSync('src/manifest.json', 'utf8'));
  assert.equal(man.default_locale, DEFAULT_LOCALE);
});

test('every key the code uses exists in the default locale', () => {
  const en = catalog(DEFAULT_LOCALE);
  const { used } = keysUsed();
  const missing = [...used].filter((k) => !(k in en)).sort();
  assert.deepEqual(missing, [], 'these render as empty text, not as an error');
});

test('the code actually uses the catalog', () => {
  // Guards the check above: if the extractors matched nothing, "no missing keys" is vacuous.
  const n = keysUsed().used.size;
  assert.ok(n >= 60, `expected the catalog to be in use, found ${n} keys`);
});

test('no orphaned messages in the default locale', () => {
  const index = keysUsed();
  const orphans = Object.keys(catalog(DEFAULT_LOCALE))
    .filter((k) => !isUsed(k, index))
    .sort();
  assert.deepEqual(orphans, [], 'unused entries drift out of date and mislead translators');
});

for (const locale of locales.filter((l) => l !== DEFAULT_LOCALE)) {
  test(`${locale}: covers every key in ${DEFAULT_LOCALE}`, () => {
    const en = catalog(DEFAULT_LOCALE);
    const other = catalog(locale);
    const missing = Object.keys(en).filter((k) => !(k in other)).sort();
    assert.deepEqual(missing, [], `${locale} would fall back to English for these`);
  });

  test(`${locale}: has no keys English does not`, () => {
    const en = catalog(DEFAULT_LOCALE);
    const extra = Object.keys(catalog(locale)).filter((k) => !(k in en)).sort();
    assert.deepEqual(extra, [], 'a key with no English source cannot be kept in step');
  });

  test(`${locale}: placeholders match ${DEFAULT_LOCALE}`, () => {
    // A translation that drops $1 silently loses the hostname or the count it was meant to show.
    const en = catalog(DEFAULT_LOCALE);
    const other = catalog(locale);
    const wrong = [];
    for (const [key, entry] of Object.entries(en)) {
      const want = new Set([...entry.message.matchAll(/\$([A-Za-z0-9_]+)\$/g)].map((m) => m[1].toLowerCase()));
      const got = new Set(
        [...(other[key]?.message ?? '').matchAll(/\$([A-Za-z0-9_]+)\$/g)].map((m) => m[1].toLowerCase()),
      );
      if (want.size !== got.size || [...want].some((p) => !got.has(p))) wrong.push(key);
    }
    assert.deepEqual(wrong.sort(), []);
  });
}

test('every message with a placeholder declares it', () => {
  for (const locale of locales) {
    for (const [key, entry] of Object.entries(catalog(locale))) {
      const refs = [...entry.message.matchAll(/\$([A-Za-z0-9_]+)\$/g)].map((m) => m[1].toLowerCase());
      if (!refs.length) continue;
      const declared = Object.keys(entry.placeholders ?? {}).map((p) => p.toLowerCase());
      for (const r of refs) {
        assert.ok(declared.includes(r), `${locale}/${key}: $${r}$ has no placeholders entry`);
      }
    }
  }
});

test('no conversion fragments were left behind', () => {
  // The TS conversion wrote _frag-*.json files that must be merged into the catalog, not shipped.
  const strays = existsSync(LOCALES_DIR)
    ? readdirSync(LOCALES_DIR).filter((f) => f.startsWith('_frag'))
    : [];
  assert.deepEqual(strays, [], 'merge these into en/messages.json and delete them');
});
