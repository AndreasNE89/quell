// The decisions behind the popup and Options, without a browser: what the popup may offer on a
// page and why not, what a filter-list row says, how the filter editor merges, and which
// language the pages are tagged with. The rendered pages are covered by test/ui-dom.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

async function load(entry) {
  const { outputFiles } = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
}

const site = await load('src/popup/site-state.ts');
const { listRowState } = await load('src/options/list-state.ts');
const { mergeFilterText } = await load('src/options/filter-merge.ts');
const { localizedListDate, listAge } = await load('src/shared/list-age.ts');

/** PopupData for an ordinary site, with overrides. */
function popup(over = {}) {
  return {
    hostname: 'news.example',
    url: 'https://news.example/',
    paused: false,
    allowlisted: false,
    tabBlocked: 0,
    blockedTotal: 0,
    statsReliable: false,
    activeRuleCount: 1000,
    coveredBy: null,
    siteFix: null,
    siteFixHost: null,
    siteActionable: true,
    siteRefusal: null,
    degraded: false,
    youtubeBlockSponsored: true,
    youtubeBlockShorts: false,
    youtubeSponsorBlock: true,
    ...over,
  };
}

// --- Popup ------------------------------------------------------------------------------

test('an ordinary site offers everything', () => {
  const s = site.siteState(popup());
  assert.equal(s.page, 'web');
  assert.equal(s.filtering, true);
  assert.equal(s.switchable, true);
  assert.equal(s.reportable, true);
  assert.equal(s.pick, null);
});

test('the switch follows the worker, not a local guess (B28)', () => {
  // go.dev passed the popup's old gate and the worker then ignored the switch.
  const refused = site.siteState(popup({ hostname: 'go.dev', siteActionable: false, siteRefusal: 'invalid' }));
  assert.equal(refused.switchable, false);
  // The breakage report is still offered: the worker names any valid host in it.
  assert.equal(refused.reportable, true);
  const held = site.siteState(popup({ hostname: 'go.dev', siteActionable: true }));
  assert.equal(held.switchable, true);
});

test('Chrome Web Store pages are not "Blocking on this site"', () => {
  const s = site.siteState(popup({ hostname: 'chromewebstore.google.com', siteActionable: false, siteRefusal: 'restricted' }));
  assert.equal(s.page, 'restricted');
  assert.equal(s.filtering, false);
  assert.equal(s.switchable, false);
  assert.equal(s.reportable, false);
  assert.equal(s.pick, 'page');
});

test('a page with no host offers nothing', () => {
  const s = site.siteState(popup({ hostname: null, url: 'chrome://extensions/', siteActionable: false }));
  assert.equal(s.page, 'none');
  assert.equal(s.filtering, false);
  assert.equal(s.pick, 'page');
});

test('the picker is not offered where a pick could not stick', () => {
  assert.equal(site.siteState(popup({ paused: true })).pick, 'paused');
  assert.equal(site.siteState(popup({ allowlisted: true })).pick, 'allowlisted');
  assert.equal(site.siteState(popup({ siteFix: 'cosmetics' })).pick, 'fix');
  assert.equal(site.siteState(popup({ siteFix: 'injection' })).pick, 'fix');
  // The custom-filter parser takes single-label intranet names, and so do picker:start and
  // the picker itself; the popup must not be the one place that refuses them.
  assert.equal(site.siteState(popup({ hostname: 'intranet' })).pick, null);
  assert.equal(site.siteState(popup({ hostname: '[::1]', siteActionable: false })).pick, 'host');
});

test('YouTube features read as off on an allowlisted YouTube page only', () => {
  assert.equal(site.siteState(popup({ hostname: 'www.youtube.com', allowlisted: true })).youtubeOffHere, true);
  assert.equal(site.siteState(popup({ hostname: 'www.youtube.com' })).youtubeOffHere, false);
  assert.equal(site.siteState(popup({ allowlisted: true })).youtubeOffHere, false);
});

test('an inherited fix names its source; the host\'s own fix does not', () => {
  assert.equal(
    site.inheritedFixHost(popup({ hostname: 'forum.example.com', siteFix: 'cosmetics', siteFixHost: 'example.com' })),
    'example.com',
  );
  assert.equal(
    site.inheritedFixHost(popup({ hostname: 'www.example.com', siteFix: 'cosmetics', siteFixHost: 'example.com' })),
    null,
  );
  assert.equal(site.inheritedFixHost(popup({ siteFix: null, siteFixHost: 'example.com' })), null);
});

test('an answer that left the site where it was is not reported as done', () => {
  assert.equal(site.toggleLanded(popup({ allowlisted: true }), false), true);
  assert.equal(site.toggleLanded(popup({ allowlisted: false }), false), false);
  assert.equal(site.fixLanded(popup({ siteFix: 'cosmetics' }), 'cosmetics'), true);
  assert.equal(site.fixLanded(popup({ siteFix: null }), 'cosmetics'), false);
  // A parent's stronger fix already covers the step asked for.
  assert.equal(site.fixLanded(popup({ siteFix: 'injection' }), 'cosmetics'), true);
  assert.equal(site.fixLanded(popup({ siteFix: 'cosmetics' }), 'injection'), false);
  assert.equal(site.fixLanded(popup({ siteFix: null }), null), true);
});

// --- Options: list rows -----------------------------------------------------------------

const row = (over = {}) => ({ id: 'easylist', title: 'EasyList', enabled: true, active: true, refused: false, ...over });

test('paused is not "Chrome refused this list" (B36)', () => {
  // What the worker sends for every enabled list while paused.
  assert.equal(listRowState(row({ active: false }), true), 'paused');
  assert.equal(listRowState(row({ enabled: false, active: false }), true), 'off');
});

test('refused, on and off', () => {
  assert.equal(listRowState(row({ active: false, refused: true }), false), 'refused');
  assert.equal(listRowState(row(), false), 'on');
  assert.equal(listRowState(row({ enabled: false, active: false }), false), 'off');
  // A row without the worker's verdict falls back to the raw comparison.
  const bare = row({ active: false });
  delete bare.refused;
  assert.equal(listRowState(bare, false), 'refused');
});

// --- Options: filter editor merge (B38) --------------------------------------------------------

test('Save keeps a rule the picker added after the editor loaded', () => {
  const base = 'a.com##.x\n';
  const mine = 'a.com##.x\nb.com##.mine\n';
  const theirs = 'a.com##.x\nc.com##.picked\n';
  const m = mergeFilterText(base, mine, theirs);
  assert.equal(m.text, 'a.com##.x\nb.com##.mine\nc.com##.picked\n');
  assert.equal(m.added, 1);
  assert.equal(m.removed, 0);
});

test('a rule deleted elsewhere and untouched here stays deleted; comments stay', () => {
  const base = '! mine\na.com##.x\nb.com##.y\n';
  const mine = '! mine\na.com##.x\nb.com##.y\nd.com##.new\n';
  const theirs = '! mine\na.com##.x\n';
  const m = mergeFilterText(base, mine, theirs);
  assert.equal(m.text, '! mine\na.com##.x\nd.com##.new\n');
  assert.equal(m.removed, 1);
});

test('nothing changed underneath: the editor text is saved as typed', () => {
  const m = mergeFilterText('a.com##.x', 'a.com##.x\n\n  b.com##.y  ', 'a.com##.x');
  assert.equal(m.text, 'a.com##.x\n\n  b.com##.y  ');
});

test('the same rule added on both sides is not duplicated', () => {
  const m = mergeFilterText('', 'b.com##.y\n', 'b.com##.y\n');
  assert.equal(m.text, 'b.com##.y\n');
  assert.equal(m.added, 0);
});

// --- Language ---------------------------------------------------------------------------------

test('the list date follows the page language, the email keeps English', () => {
  const at = '2026-09-07T10:00:00.000Z';
  assert.equal(localizedListDate(at, 'zh-CN'), '2026年9月7日');
  assert.equal(localizedListDate(at, 'zh-TW'), '2026年9月7日');
  assert.match(localizedListDate(at, 'en'), /Sep 7, 2026/);
  assert.equal(localizedListDate(null, 'en'), '');
  // The breakage-report sentence is untouched.
  assert.match(listAge(at, Date.parse('2026-09-08T00:00:00Z')).text, /\(7 Sep 2026\)/);
});

test('an unusable language tag still gives a date', () => {
  assert.equal(localizedListDate('2026-09-07T10:00:00.000Z', 'not a tag!'), '7 Sep 2026');
});

/** i18n.ts with a stand-in chrome.i18n and document. */
async function withI18n({ catalog, browser }, fn) {
  const saved = { chrome: globalThis.chrome, document: globalThis.document };
  const root = { lang: 'en', dataset: {} };
  globalThis.chrome = {
    i18n: {
      getMessage: (k) => catalog[k] ?? '',
      getUILanguage: () => browser,
    },
  };
  globalThis.document = { documentElement: root, querySelectorAll: () => [] };
  try {
    const mod = await load('src/shared/i18n.ts');
    await fn(mod, root);
  } finally {
    globalThis.chrome = saved.chrome;
    globalThis.document = saved.document;
  }
}

test('<html lang> is the catalog language, refined by the browser region when they match', async () => {
  await withI18n({ catalog: { ui_lang: 'zh-TW' }, browser: 'zh-TW' }, ({ applyI18n }, root) => {
    applyI18n();
    assert.equal(root.lang, 'zh-TW');
  });
  await withI18n({ catalog: { ui_lang: 'en' }, browser: 'en-GB' }, ({ applyI18n, uiLanguage }, root) => {
    applyI18n();
    assert.equal(root.lang, 'en-GB');
    assert.equal(uiLanguage(), 'en-GB');
  });
  // A French browser gets the English catalog: the text is English, so the tag is too.
  await withI18n({ catalog: { ui_lang: 'en' }, browser: 'fr' }, ({ uiLanguage }) => {
    assert.equal(uiLanguage(), 'en');
  });
});
