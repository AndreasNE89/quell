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
  // The element picker is a content script; it reads its own `picker_` keys.
  for (const f of ['src/popup/popup.ts', 'src/options/options.ts', 'src/content/picker.ts']) {
    const ts = readFileSync(f, 'utf8');
    for (const m of ts.matchAll(/['"`]((?:popup|options|picker)_[a-z0-9_]+)['"`]/g)) used.add(m[1]);
    // Keys assembled at runtime: msg(`options_list_age_${level}`). The literal part is a
    // prefix, and every catalog key under it is reachable.
    for (const m of ts.matchAll(/`((?:popup|options)_[a-z0-9_]*)\$\{/g)) prefixes.push(m[1]);
  }
  // The manifest pulls its store-facing strings from the catalog as __MSG_key__ (the
  // description doubles as the Web Store summary). No UI file names those keys, so without
  // this they would be reported as orphans.
  for (const m of readFileSync('src/manifest.json', 'utf8').matchAll(/__MSG_(\w+)__/g)) used.add(m[1]);
  // The shared helper reads a key of its own (`ui_lang`), by a direct msg('key') call.
  for (const m of readFileSync('src/shared/i18n.ts', 'utf8').matchAll(/\bmsg\(\s*'([a-z0-9_]+)'/g)) used.add(m[1]);
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

test('every __MSG_ key in the manifest exists in every locale', () => {
  // Unlike a UI string, a missing manifest message does not degrade to blank text. Missing
  // from the default locale, Chrome refuses to load the extension ("Variable __MSG_key__ used
  // but not defined"); missing from another locale, users of that language quietly get the
  // English description instead.
  const keys = [...readFileSync('src/manifest.json', 'utf8').matchAll(/__MSG_(\w+)__/g)].map((m) => m[1]);
  assert.ok(keys.includes('extName'), 'the manifest name must come from the catalog');
  assert.ok(keys.includes('extDescription'), 'the manifest description must come from the catalog');
  for (const locale of locales) {
    const cat = catalog(locale);
    const missing = keys.filter((k) => !(k in cat));
    assert.deepEqual(missing, [], `${locale} is missing manifest messages`);
  }
});

test('the store name comes from the package and matches the published listing', () => {
  // The dashboard shows the manifest name as "Title from package"; there is no separate field to
  // correct it in. 2.2.3 was uploaded with this English name, so a later package that drifted
  // from it would rename the listing without anyone deciding to.
  const man = JSON.parse(readFileSync('src/manifest.json', 'utf8'));
  assert.equal(man.name, '__MSG_extName__');
  assert.equal(catalog(DEFAULT_LOCALE).extName.message, 'StampStack — Ad & Tracker Blocker');
  // The toolbar tooltip is not the store name: it stays the short brand.
  assert.equal(man.action.default_title, 'StampStack');
  for (const locale of locales) {
    const name = catalog(locale).extName.message;
    // Chrome and the Web Store refuse a name over 75 characters.
    assert.ok([...name].length <= 75, `${locale}: extName is ${[...name].length} characters`);
    assert.ok(name.startsWith('StampStack — '), `${locale}: extName must keep the brand prefix`);
  }
  // The listing docs quote the name for whoever fills in the dashboard; keep them in step.
  const listing = { en: 'store/LISTING.md', zh_CN: 'store/LISTING-zh_CN.md', zh_TW: 'store/LISTING-zh_TW.md' };
  for (const [locale, file] of Object.entries(listing)) {
    if (!locales.includes(locale) || !existsSync(file)) continue;
    const md = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const at = md.search(/\n## [^\n]*Item name[^\n]*\n/);
    const quoted = at < 0 ? null : md.slice(at).match(/\n```[^\n]*\n([\s\S]*?)\n```/)?.[1];
    assert.equal(quoted, catalog(locale).extName.message, `${file} quotes a different item name`);
  }
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

test('every catalog names its own language for <html lang>', () => {
  // applyI18n tags the page with the catalog's language, not the browser's: a French browser
  // gets the English catalog, and tagging that text "fr" would have it read with a French voice.
  for (const locale of locales) {
    const tag = catalog(locale).ui_lang?.message;
    assert.equal(tag, locale.replace('_', '-'), `${locale}/ui_lang must be the catalog's BCP 47 tag`);
  }
});

// Words in the markup that stay as they are in every language.
const UNTRANSLATABLE = new Set(['StampStack', 'StampStack v', 'example.com##.sponsored-widget']);
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const SPOKEN_ATTRS = ['aria-label', 'title', 'alt', 'placeholder'];

function parseAttrs(src) {
  const attrs = {};
  for (const m of src.matchAll(/([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

/**
 * Text a user sees or hears in the markup that no catalog key replaces: text outside any
 * [data-i18n] element, and aria-label/title/alt/placeholder values the element's
 * data-i18n-attr does not name. The key-existence checks above cannot see these — a string with
 * no key at all is simply English in every locale, which is how "Hide an element", the shortcut
 * tip and the upsell paragraph shipped while the changelog said "translated everywhere".
 */
function untranslatedMarkup(html) {
  const src = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!doctype[^>]*>/i, '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  const found = [];
  const stack = [];
  const tokens = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  for (const m of src.matchAll(tokens)) {
    if (m[5] !== undefined) {
      const text = m[5].replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
      if (/\p{L}/u.test(text) && !stack.some((e) => e.translated) && !UNTRANSLATABLE.has(text)) {
        found.push(text);
      }
      continue;
    }
    const tag = m[2].toLowerCase();
    if (m[1]) {
      const at = stack.map((e) => e.tag).lastIndexOf(tag);
      if (at >= 0) stack.length = at;
      continue;
    }
    const attrs = parseAttrs(m[3]);
    const covered = new Set(
      (attrs['data-i18n-attr'] ?? '').split(',').map((p) => p.split(':')[0].trim()).filter(Boolean),
    );
    for (const a of SPOKEN_ATTRS) {
      const v = attrs[a];
      if (v && /\p{L}/u.test(v) && !covered.has(a) && !UNTRANSLATABLE.has(v)) found.push(`${a}="${v}"`);
    }
    if (!VOID_TAGS.has(tag) && !m[4]) stack.push({ tag, translated: 'data-i18n' in attrs });
  }
  return found;
}

for (const page of ['popup', 'options']) {
  test(`${page}.html: every visible or spoken string has a catalog key`, () => {
    const html = readFileSync(`src/${page}/${page}.html`, 'utf8');
    assert.deepEqual(untranslatedMarkup(html), [], 'these stay English in every locale');
  });
}

test('the markup detector catches what 2.3.0 shipped untranslated', () => {
  // Verbatim shapes from the 2.3.0 popup and Options.
  const shipped = `
    <button class="icon-btn" id="optionsBtn" title="Settings" data-i18n-attr="title:popup_settings" aria-label="Settings">⚙</button>
    <button type="button" class="action" id="pickBtn">
      <span class="action-icon" aria-hidden="true">✛</span> Hide an element
    </button>
    <p class="shortcut-hint">
      Tip: <kbd data-i18n="popup_alt">Alt</kbd>+<kbd data-i18n="popup_shift">Shift</kbd>+<kbd>X</kbd> starts the picker
    </p>
    <a href="privacy.html" target="_blank" rel="noopener">Privacy</a>
    <input id="siteRuleHost" placeholder="example.com" data-i18n-attr="placeholder:options_example_com" aria-label="Site hostname" />`;
  assert.deepEqual(untranslatedMarkup(shipped), [
    'aria-label="Settings"',
    'Hide an element',
    'Tip:',
    'X',
    'starts the picker',
    'Privacy',
    'aria-label="Site hostname"',
  ]);
});

test('the markup detector leaves translated and brand text alone', () => {
  const ok = `
    <button type="button" class="action"><span aria-hidden="true">✛</span> <span data-i18n="k">Hide an element</span></button>
    <p data-i18n="k">Nested <strong>words</strong> inside a translated element</p>
    <img alt="StampStack" /><input aria-label="Name" data-i18n-attr="aria-label:k" />`;
  assert.deepEqual(untranslatedMarkup(ok), []);
});

test('no conversion fragments were left behind', () => {
  // The TS conversion wrote _frag-*.json files that must be merged into the catalog, not shipped.
  const strays = existsSync(LOCALES_DIR)
    ? readdirSync(LOCALES_DIR).filter((f) => f.startsWith('_frag'))
    : [];
  assert.deepEqual(strays, [], 'merge these into en/messages.json and delete them');
});
