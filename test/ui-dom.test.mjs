// The popup and Options pages against a real DOM (Playwright Chromium), with chrome.* stubbed
// and a scripted stand-in for the service worker.
//
// Most of what REVIEW_2026-09-24 found in these pages only shows once they render and messages
// arrive in a particular order: a storage event landing before the ruleset sync, a null answer,
// a focused switch rebuilt under the keyboard, an editor losing unsaved text. Unit tests of the
// decisions (test/ui-state.test.mjs) cannot see any of that.
//
// Skips (does not fail) when Chromium cannot be launched, e.g. on a machine without the
// Playwright browser download.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://ui.stampstack.test';

const bundles = {};
let browser;
let launchError;

before(async () => {
  for (const name of ['popup', 'options']) {
    const out = await build({
      entryPoints: [join(ROOT, 'src', name, `${name}.ts`)],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'chrome120',
      write: false,
      logLevel: 'silent',
      define: { __STAMPSTACK_DEV__: 'true' },
    });
    bundles[name] = out.outputFiles[0].text;
  }
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    launchError = e;
  }
});

after(async () => {
  await browser?.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const catalog = (locale) =>
  JSON.parse(readFileSync(join(ROOT, 'src', '_locales', locale, 'messages.json'), 'utf8'));

/** Runs in the page before its scripts: chrome.* as the extension pages see it. */
function chromeStub({ catalog, ui, commands, tabUrl }) {
  const listeners = [];
  window.__sent = [];
  window.__fireStorage = (changes = { 'stampstack.settings': { newValue: {} } }) => {
    for (const fn of listeners) fn(changes, 'local');
  };
  const getMessage = (key, subs) => {
    const entry = catalog[key];
    if (!entry) return '';
    const args = subs == null ? [] : Array.isArray(subs) ? subs : [subs];
    let out = entry.message;
    for (const [name, ph] of Object.entries(entry.placeholders || {})) {
      const value = args[Number(String(ph.content).slice(1)) - 1] ?? '';
      out = out.replace(new RegExp(`\\$${name}\\$`, 'gi'), () => value);
    }
    return out.split('$$').join('$');
  };
  window.chrome = {
    i18n: { getMessage, getUILanguage: () => ui },
    runtime: {
      sendMessage: async (m) => {
        window.__sent.push(m);
        return JSON.parse(await window.__sw(JSON.stringify(m)));
      },
      openOptionsPage: () => {},
      getManifest: () => ({ version: '9.9.9' }),
    },
    storage: { onChanged: { addListener: (fn) => listeners.push(fn) } },
    tabs: {
      query: async () => [{ id: 1, url: tabUrl }],
      reload: async () => {},
      create: async () => ({}),
    },
    commands: { getAll: async () => commands },
  };
}

/**
 * Open the popup or Options. `replies` maps a message type to its answer, or to a function of
 * the message (may be async) — the stand-in worker. Unlisted types answer null, as the real
 * worker does when a handler throws.
 */
async function open(t, name, replies, { locale = 'en', ui, commands, tabUrl = 'https://news.example/' } = {}) {
  if (!browser) {
    t.skip(`Chromium unavailable: ${launchError?.message ?? 'unknown'}`);
    return null;
  }
  const context = await browser.newContext({ colorScheme: 'light' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const log = [];
  await page.exposeFunction('__sw', async (json) => {
    const m = JSON.parse(json);
    log.push(m);
    const r = replies[m.type];
    const answer = typeof r === 'function' ? await r(m) : r;
    return JSON.stringify(answer ?? null);
  });
  await page.addInitScript(chromeStub, {
    catalog: catalog(locale),
    ui: ui ?? locale.replace('_', '-'),
    commands: commands ?? [{ name: 'pick-element', shortcut: 'Alt+Shift+X', description: '' }],
    tabUrl,
  });
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname.slice(1);
    if (path === `${name}.html`) {
      return route.fulfill({ contentType: 'text/html', body: readFileSync(join(ROOT, 'src', name, `${name}.html`)) });
    }
    if (path === `${name}.css`) {
      return route.fulfill({ contentType: 'text/css', body: readFileSync(join(ROOT, 'src', name, `${name}.css`)) });
    }
    if (path === `${name}.js`) return route.fulfill({ contentType: 'text/javascript', body: bundles[name] });
    if (path.startsWith('icons/')) {
      return route.fulfill({ contentType: 'image/png', body: readFileSync(join(ROOT, 'src', path)) });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto(`${ORIGIN}/${name}.html`);
  t.after(() => context.close());
  return { page, errors, log, settle: () => page.waitForTimeout(250) };
}

const text = (page, sel) => page.locator(sel).evaluate((e) => e.textContent.replace(/\s+/g, ' ').trim());
const isHidden = (page, sel) => page.locator(sel).evaluate((e) => e.hidden || !!e.closest('[hidden]'));

// --- Stand-in worker answers ----------------------------------------------------------------

function popupData(over = {}) {
  return {
    hostname: 'news.example',
    url: 'https://news.example/',
    paused: false,
    allowlisted: false,
    tabBlocked: 0,
    blockedTotal: 0,
    statsReliable: false,
    activeRuleCount: 120377,
    coveredBy: null,
    siteFix: null,
    siteFixHost: null,
    siteActionable: true,
    siteRefusal: null,
    degraded: false,
    youtubeBlockSponsored: true,
    youtubeBlockShorts: true,
    youtubeSponsorBlock: true,
    ...over,
  };
}

function license(over = {}) {
  return {
    paid: false,
    grace: false,
    verifiedAt: null,
    provider: 'none',
    configured: true,
    unpacked: false,
    priceLabel: '$2',
    ...over,
  };
}

function darkData(over = {}, licenseOver = {}) {
  return {
    paid: false,
    enabled: false,
    apply: false,
    hostname: 'news.example',
    override: null,
    restricted: false,
    siteOverrides: {},
    ...over,
    license: license({ paid: !!over.paid, ...licenseOver }),
  };
}

/** A write to the stored license, as chrome.storage.onChanged reports it. */
function licenseWrite(before, after) {
  const stored = (over) => ({ paid: false, provider: 'extensionpay', verifiedAt: Date.now() - 60_000, ...over });
  return { 'stampstack.license': { oldValue: stored(before), newValue: stored({ verifiedAt: Date.now(), ...after }) } };
}

/** darkmode:get answering unpaid until `state.paid`, and counting the asks. */
function paidWhen(state) {
  return () => {
    state.asks = (state.asks ?? 0) + 1;
    return state.paid ? darkData({ paid: true, enabled: true, apply: true }, { provider: 'extensionpay' }) : darkData();
  };
}

const hiddenReport = {
  available: false,
  reason: 'paused',
  hostname: null,
  trackers: [],
  unnamedThirdParty: 0,
  hiddenElements: 0,
  truncated: false,
};

function popupReplies(popup = {}, over = {}) {
  return {
    'popup:get': popupData(popup),
    'darkmode:get': darkData(),
    'report:get': hiddenReport,
    'sitefix:list': { allowlist: [], siteFixes: {} },
    ...over,
  };
}

// --- Popup ------------------------------------------------------------------------------------

test('popup: buttons, labels and <html lang> are translated (B76)', async (t) => {
  const ui = await open(t, 'popup', popupReplies(), { locale: 'zh_CN' });
  if (!ui) return;
  await ui.settle();
  const { page } = ui;
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-CN');
  assert.equal(await text(page, '#pickBtn'), '✛ 隐藏元素');
  assert.equal(await text(page, '#repairOpen'), '✱ 网站出问题？');
  assert.equal(await page.getAttribute('#optionsBtn', 'aria-label'), '设置');
  const tip = await text(page, '#shortcutHint');
  assert.match(tip, /^提示：按 Alt\+Shift\+X/);
  assert.doesNotMatch(tip, /starts the picker/);
});

test('popup: the shortcut tip shows the assigned key, or nothing when there is none', async (t) => {
  const rebound = await open(t, 'popup', popupReplies(), {
    commands: [{ name: 'pick-element', shortcut: 'Ctrl+Shift+Y', description: '' }],
  });
  if (!rebound) return;
  await rebound.settle();
  assert.match(await text(rebound.page, '#shortcutHint'), /Ctrl\+Shift\+Y/);

  // Chrome leaves the suggestion unassigned when another extension holds Alt+Shift+X.
  const unassigned = await open(t, 'popup', popupReplies(), {
    commands: [{ name: 'pick-element', shortcut: '', description: '' }],
  });
  await unassigned.settle();
  assert.equal(await isHidden(unassigned.page, '.shortcut-hint'), true);
});

test('popup: a Chrome Web Store page is not "Blocking on this site"', async (t) => {
  const ui = await open(
    t,
    'popup',
    popupReplies(
      { hostname: 'chromewebstore.google.com', url: 'https://chromewebstore.google.com/', siteActionable: false, siteRefusal: 'restricted' },
      { 'report:get': { ...hiddenReport, available: false, reason: 'no-content-script' } },
    ),
  );
  if (!ui) return;
  await ui.settle();
  const { page } = ui;
  assert.equal(await text(page, '#siteSub'), 'StampStack does not run on this page');
  assert.equal(await page.isChecked('#siteToggle'), false);
  assert.equal(await page.isDisabled('#siteToggle'), true);
  assert.equal(await page.isDisabled('#pickBtn'), true);
  // "Reload the page to see what it connects to" never comes true here.
  assert.equal(await isHidden(page, '#report'), true);
});

test('popup: a host the worker cannot hold offers no switch and says why (B28)', async (t) => {
  const ui = await open(
    t,
    'popup',
    popupReplies(
      { hostname: 'go.dev', url: 'https://go.dev/', siteActionable: false, siteRefusal: 'invalid' },
      { 'popup:toggleSite': popupData({ hostname: 'go.dev', siteActionable: false, applied: true }) },
    ),
  );
  if (!ui) return;
  await ui.settle();
  const { page } = ui;
  assert.equal(await page.isDisabled('#siteToggle'), true);
  assert.match(await text(page, '#siteToggleLabel'), /can't keep a setting for go\.dev/);
  // No rungs, but the report stays reachable.
  assert.equal(await page.isDisabled('#repairOpen'), false);
  await page.click('#repairOpen');
  assert.equal(await isHidden(page, '#repairLadder'), true);
  assert.equal(await isHidden(page, '#reportBreakage'), false);
});

test('popup: an answer that left the site unchanged is not followed by "Reload the page"', async (t) => {
  const ui = await open(
    t,
    'popup',
    popupReplies({}, {
      // What a worker answers when it stores nothing: the site as it was.
      'popup:toggleSite': popupData({ applied: true }),
      'sitefix:set': popupData(),
    }),
  );
  if (!ui) return;
  await ui.settle();
  const { page } = ui;
  await page.click('#siteToggle');
  await ui.settle();
  assert.equal(await isHidden(page, '#reloadNote'), true);
  assert.equal(await page.isChecked('#siteToggle'), true);
  assert.match(await text(page, '#siteToggleLabel'), /Nothing changed/);

  await page.click('#repairOpen');
  await page.click('#repairNext');
  await ui.settle();
  assert.equal(await isHidden(page, '#reloadNote'), true);
  assert.match(await text(page, '#repairHint'), /Nothing changed/);
});

test('popup: an active repair step shows in the status line, and an inherited one names its source (B30)', async (t) => {
  const ui = await open(
    t,
    'popup',
    popupReplies({
      hostname: 'forum.example.com',
      url: 'https://forum.example.com/',
      siteFix: 'injection',
      siteFixHost: 'example.com',
    }),
  );
  if (!ui) return;
  await ui.settle();
  const { page } = ui;
  assert.equal(await text(page, '#siteSub'), 'Blocking on · element hiding and script patches off here');
  assert.match(await text(page, '#repairState'), /the rule for example\.com/);
  assert.match(await text(page, '#repairReset'), /for all of example\.com/);
  // A pick would vanish on the next load: element hiding is off here.
  assert.equal(await page.isDisabled('#pickBtn'), true);
  assert.match(await text(page, '#pickHint'), /Element hiding is off here/);
});

test('popup: a null answer to Pause reverts the switch instead of throwing', async (t) => {
  const ui = await open(t, 'popup', popupReplies({}, { 'popup:setPaused': null }));
  if (!ui) return;
  await ui.settle();
  const { page, errors } = ui;
  await page.click('#pauseToggle');
  await page.waitForTimeout(900); // the retries
  assert.equal(await page.isChecked('#pauseToggle'), false);
  assert.match(await text(page, '#pauseNote'), /Could not change pause/);
  assert.deepEqual(errors, []);
});

test('popup: a failed first load shows no claims', async (t) => {
  const ui = await open(t, 'popup', { 'popup:get': null });
  if (!ui) return;
  const { page } = ui;
  await page.waitForTimeout(900); // the retries
  assert.match(await text(page, '#siteSub'), /Could not reach StampStack/);
  assert.equal(await isHidden(page, '#stats'), true);
  assert.equal(await page.isDisabled('#siteToggle'), true);
  assert.equal(await page.isDisabled('#pickBtn'), true);
  assert.deepEqual(ui.errors, []);
});

test('popup: YouTube reads "off on this site" on an allowlisted youtube.com', async (t) => {
  const ui = await open(
    t,
    'popup',
    popupReplies({ hostname: 'www.youtube.com', url: 'https://www.youtube.com/', allowlisted: true }),
  );
  if (!ui) return;
  await ui.settle();
  assert.equal(await text(ui.page, '#ytSummary'), 'off on this site');
  assert.equal(await isHidden(ui.page, '#ytSiteNote'), false);
});

test('popup: dark mode is not "on here" on a page it cannot reach', async (t) => {
  const ui = await open(
    t,
    'popup',
    popupReplies(
      { hostname: null, url: 'chrome://version/', siteActionable: false },
      { 'darkmode:get': darkData({ paid: true, enabled: true, apply: true, hostname: null }, { provider: 'extensionpay' }) },
    ),
    { tabUrl: 'chrome://version/' },
  );
  if (!ui) return;
  await ui.settle();
  assert.equal(await text(ui.page, '#darkSummary'), 'not available here');
});

test('popup: a purchase the worker verifies after the popup drew unlocks it in place', async (t) => {
  // Opening the popup starts the worker's re-check without waiting for it (M16); its answer
  // arrives as a license write.
  const state = { paid: false };
  const ui = await open(t, 'popup', popupReplies({}, { 'darkmode:get': paidWhen(state) }));
  if (!ui) return;
  await ui.settle();
  const { page } = ui;
  assert.equal(await isHidden(page, '#darkUpsell'), false);
  const asks = state.asks;
  // A re-check that found nothing new: no redraw.
  await page.evaluate((c) => window.__fireStorage(c), licenseWrite({}, {}));
  await ui.settle();
  assert.equal(state.asks, asks);
  state.paid = true;
  await page.evaluate((c) => window.__fireStorage(c), licenseWrite({}, { paid: true, email: 'a@b.c' }));
  await ui.settle();
  assert.equal(await isHidden(page, '#darkUpsell'), true, 'still offering the purchase just made');
  assert.equal(await isHidden(page, '#darkBuyBtn'), true);
  assert.equal(await isHidden(page, '#darkModeRow'), false);
});

test('popup: Buy or Restore with no answer from the worker does not send the user to Options', async (t) => {
  // Options runs the same request through the same worker, so "open Options → Restore purchase"
  // was a second try at what had just failed.
  const ui = await open(t, 'popup', popupReplies({}, { 'license:openCheckout': null, 'license:openRestore': null }));
  if (!ui) return;
  await ui.settle();
  const { page } = ui;
  await page.click('details:has(#darkSummary) > summary');
  await page.click('#darkRestoreBtn');
  await ui.settle();
  assert.match(await text(page, '#darkHint'), /could not open\. Check your connection/);
  assert.doesNotMatch(await text(page, '#darkHint'), /Options/);
  await page.click('#darkBuyBtn');
  await ui.settle();
  assert.match(await text(page, '#darkHint'), /Checkout could not open/);
  assert.doesNotMatch(await text(page, '#darkHint'), /Options/);
});

test('popup: in an Incognito window the site switch says it applies to normal windows too', async (t) => {
  const ui = await open(t, 'popup', popupReplies({ incognito: true }), { locale: 'zh_CN' });
  if (!ui) return;
  await ui.settle();
  assert.equal(await isHidden(ui.page, '#incognitoNote'), false);
  assert.match(await text(ui.page, '#incognitoNote'), /无痕窗口/);
  const normal = await open(t, 'popup', popupReplies());
  if (!normal) return;
  await normal.settle();
  assert.equal(await isHidden(normal.page, '#incognitoNote'), true);
});

test('popup: Details reports its state to assistive tech', async (t) => {
  const report = {
    available: true,
    hostname: 'news.example',
    trackers: [
      { host: 'doubleclick.net', label: 'Google Ads', blocked: true },
      { host: 'example-cdn.test', label: 'Some CDN', blocked: false, partial: true },
    ],
    unnamedThirdParty: 0,
    hiddenElements: 0,
    truncated: false,
  };
  const ui = await open(t, 'popup', popupReplies({}, { 'report:get': report }));
  if (!ui) return;
  await ui.settle();
  const { page } = ui;
  assert.equal(await page.getAttribute('#reportToggle', 'aria-expanded'), 'false');
  await page.click('#reportToggle');
  assert.equal(await page.getAttribute('#reportToggle', 'aria-expanded'), 'true');
  assert.equal(await text(page, '#reportList li:nth-child(2) .report-state'), 'partly blocked');
  for (const id of ['#pickHint', '#reloadNote', '#reportBreakageNote', '#siteToggleLabel', '#darkHint']) {
    assert.equal(await page.getAttribute(id, 'role'), 'status', `${id} must announce its outcome`);
  }
});

// --- Options -----------------------------------------------------------------------------------

function listRow(over = {}) {
  return {
    id: 'easylist',
    title: 'EasyList',
    group: 'ads',
    enabledByDefault: true,
    ruleCount: 54522,
    rulesetFile: 'rules/easylist.json',
    enabled: true,
    active: true,
    refused: false,
    ...over,
  };
}

function statsData(lists, over = {}) {
  return {
    blockedTotal: 0,
    paused: false,
    lists,
    regexRulesUsed: 209,
    statsReliable: false,
    degraded: false,
    listsGeneratedAt: '2026-09-07T10:00:00.000Z',
    ...over,
  };
}

function optionsReplies(over = {}) {
  const lists = [listRow()];
  return {
    'stats:get': statsData(lists),
    'lists:get': { lists, degraded: false, paused: false },
    'popup:get': popupData(),
    'darkmode:get': darkData(),
    'sitefix:list': { allowlist: [], siteFixes: {} },
    'customfilters:get': { text: '', count: 0, errors: [] },
    'sponsorblock:getCategories': {
      categories: [{ id: 'sponsor', label: 'Sponsor', hint: 'Paid promotion.', enabled: true }],
      allOff: false,
    },
    ...over,
  };
}

const listMeta = (page) =>
  page.locator('#lists .list-item .list-meta').first().evaluate((e) => e.textContent.trim());

test('options: switching a list on never ends on a false "Not active" (B37)', async (t) => {
  // Chrome loads the ruleset after the setting is stored, and the storage event reaches the page
  // in between. A read then sees the list enabled and not loaded.
  const state = { enabled: false, active: false };
  const rows = () => [listRow({ id: 'easylist-china', title: 'EasyList China', enabled: state.enabled, active: state.active, refused: state.enabled && !state.active })];
  let ui;
  const replies = optionsReplies({
    'stats:get': () => statsData(rows()),
    'lists:get': () => ({ lists: rows(), degraded: false, paused: false }),
    'lists:setEnabled': async (m) => {
      state.enabled = m.enabled;
      await ui.page.evaluate(() => window.__fireStorage());
      await sleep(200);
      state.active = m.enabled;
      return { lists: rows(), degraded: false, paused: false };
    },
  });
  ui = await open(t, 'options', replies);
  if (!ui) return;
  await ui.settle();
  await ui.page.click('#lists .list-item .slider');
  await ui.page.waitForTimeout(600);
  assert.doesNotMatch(await listMeta(ui.page), /Not active/);
  assert.equal(await ui.page.isChecked('#lists .list-item input'), true);
});

test('options: paused shows a neutral state, not "Chrome refused this list" (B36)', async (t) => {
  // What the worker sends while paused: every list enabled, none loaded.
  const lists = [listRow({ active: false, refused: false }), listRow({ id: 'easyprivacy', title: 'EasyPrivacy', group: 'privacy', active: false })];
  const ui = await open(
    t,
    'options',
    optionsReplies({
      'stats:get': statsData(lists, { paused: true }),
      'lists:get': { lists, degraded: false, paused: true },
      'customfilters:get': { text: 'a.com##.x\n', count: 1, errors: [] },
    }),
  );
  if (!ui) return;
  await ui.settle();
  const { page } = ui;
  assert.doesNotMatch(await text(page, '#lists'), /Not active|rule limit/);
  assert.match(await listMeta(page), /paused/);
  assert.equal(await isHidden(page, '#pausedBanner'), false);
  // "1 rule active" contradicted the 0 on the rules card.
  assert.match(await text(page, '#customStatus'), /not applied while StampStack is paused/);
});

test('options: keyboard focus stays on a list switch through its toggle', async (t) => {
  const state = { enabled: true };
  const rows = () => [listRow({ enabled: state.enabled, active: state.enabled })];
  let ui;
  ui = await open(
    t,
    'options',
    optionsReplies({
      'stats:get': () => statsData(rows()),
      'lists:get': () => ({ lists: rows(), degraded: false, paused: false }),
      'lists:setEnabled': async (m) => {
        state.enabled = m.enabled;
        await ui.page.evaluate(() => window.__fireStorage());
        await sleep(100);
        return { lists: rows(), degraded: false, paused: false };
      },
    }),
  );
  if (!ui) return;
  await ui.settle();
  const { page } = ui;
  await page.focus('#lists .list-item input');
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  const focused = await page.evaluate(() => {
    const a = document.activeElement;
    return a?.matches('#lists .list-item input') ? a.getAttribute('aria-label') : a?.tagName;
  });
  assert.equal(focused, 'Enable filter list EasyList');
  assert.equal(await page.isChecked('#lists .list-item input'), false);
});

test('options: unsaved filter edits survive an unrelated settings write (B38)', async (t) => {
  const ui = await open(t, 'options', optionsReplies({ 'customfilters:get': { text: 'a.com##.x\n', count: 1, errors: [] } }));
  if (!ui) return;
  await ui.settle();
  const { page } = ui;
  await page.fill('#customFilters', 'a.com##.x\nb.com##.mine\n');
  await page.click('h1'); // focus leaves the editor
  await page.evaluate(() => window.__fireStorage());
  await ui.settle();
  assert.equal(await page.inputValue('#customFilters'), 'a.com##.x\nb.com##.mine\n');
});

test('options: Save keeps a rule the picker added meanwhile (B38)', async (t) => {
  const stored = { text: 'a.com##.x\n' };
  const parse = (s) => ({ text: s, count: s.split('\n').filter(Boolean).length, errors: [] });
  const ui = await open(
    t,
    'options',
    optionsReplies({
      'customfilters:get': () => parse(stored.text),
      'customfilters:set': (m) => {
        stored.text = m.text;
        return parse(stored.text);
      },
    }),
  );
  if (!ui) return;
  await ui.settle();
  const { page } = ui;
  await page.fill('#customFilters', 'a.com##.x\nb.com##.mine\n');
  // The picker, in another tab.
  stored.text = 'a.com##.x\nc.com##.picked\n';
  await page.evaluate(() => window.__fireStorage());
  await ui.settle();
  await page.click('#customSave');
  await ui.settle();
  assert.match(stored.text, /b\.com##\.mine/);
  assert.match(stored.text, /c\.com##\.picked/);
  assert.equal(await page.inputValue('#customFilters'), stored.text);
});

test('options: "Saved — …" survives the storage event its own save causes', async (t) => {
  const stored = { text: '' };
  const ui = await open(
    t,
    'options',
    optionsReplies({
      'customfilters:get': () => ({ text: stored.text, count: 1, errors: [] }),
      'customfilters:set': (m) => {
        stored.text = m.text;
        return { text: m.text, count: 1, errors: [{ line: 2, text: 'junk', reason: 'Expected a rule' }] };
      },
    }),
  );
  if (!ui) return;
  await ui.settle();
  const { page } = ui;
  await page.fill('#customFilters', 'a.com##.x\njunk\n');
  await page.click('#customSave');
  await ui.settle();
  await page.evaluate(() => window.__fireStorage());
  await ui.settle();
  assert.match(await text(page, '#customStatus'), /^Saved — 1 rule active\. 1 line ignored\./);
});

test('options: Remove on a subdomain row removes only that row (B29)', async (t) => {
  const rules = { allowlist: ['example.com', 'shop.example.com'], siteFixes: {} };
  const ui = await open(
    t,
    'options',
    optionsReplies({
      'sitefix:list': () => rules,
      'allowlist:remove': (m) => {
        rules.allowlist = rules.allowlist.filter((h) => h !== m.hostname);
        return { ...rules, applied: true };
      },
      // The popup's switch: clears every entry covering the host, parents included.
      'popup:toggleSite': (m) => {
        rules.allowlist = rules.allowlist.filter((h) => !(m.hostname === h || m.hostname.endsWith(`.${h}`)));
        return { ...popupData(), applied: true };
      },
    }),
  );
  if (!ui) return;
  await ui.settle();
  const { page } = ui;
  const row = page.locator('#siteRules .list-item', { hasText: 'shop.example.com' });
  assert.match(await row.locator('.list-meta').innerText(), /also covered by example\.com/);
  await row.locator('button').click();
  await ui.settle();
  assert.deepEqual(rules.allowlist, ['example.com']);
  assert.equal(await page.locator('#siteRules .list-item').count(), 1);
  assert.match(await text(page, '#siteRules'), /example\.com/);
});

test('options: a paid user is not offered Buy again', async (t) => {
  const ui = await open(
    t,
    'options',
    optionsReplies({ 'darkmode:get': darkData({ paid: true, enabled: true }, { provider: 'extensionpay', email: 'a@b.c' }) }),
  );
  if (!ui) return;
  await ui.settle();
  assert.equal(await isHidden(ui.page, '#darkBuy'), true);
  assert.equal(await isHidden(ui.page, '#darkRestore'), false);
});

test('options: a license the worker verifies after the page drew redraws dark mode', async (t) => {
  // Options stays open in a tab: a purchase made meanwhile, or the worker's re-check when the
  // page opened (M16), lands in the license, not in settings.
  const state = { paid: false };
  const ui = await open(t, 'options', optionsReplies({ 'darkmode:get': paidWhen(state) }));
  if (!ui) return;
  await ui.settle();
  const { page } = ui;
  assert.equal(await isHidden(page, '#darkBuy'), false);
  state.paid = true;
  await page.evaluate((c) => window.__fireStorage(c), licenseWrite({}, { paid: true, email: 'a@b.c' }));
  await ui.settle();
  assert.equal(await isHidden(page, '#darkBuy'), true, 'still offering the purchase just made');
  assert.equal(await page.isChecked('#darkModeEnabled'), true);
});

test('options: a re-verify that changed nothing shown leaves the message on screen', async (t) => {
  const state = { paid: false };
  const ui = await open(
    t,
    'options',
    optionsReplies({ 'darkmode:get': paidWhen(state), 'license:refresh': { ...license(), unreachable: true } }),
  );
  if (!ui) return;
  await ui.settle();
  const { page } = ui;
  await page.click('#darkRefresh');
  await ui.settle();
  assert.match(await text(page, '#darkActionHint'), /Could not reach ExtensionPay/);
  const asks = state.asks;
  await page.evaluate((c) => window.__fireStorage(c), licenseWrite({}, {}));
  await ui.settle();
  assert.equal(state.asks, asks);
  assert.match(await text(page, '#darkActionHint'), /Could not reach ExtensionPay/);
});

test('options: a null Dev unlock answer is not reported as applied', async (t) => {
  let loads = 0;
  const ui = await open(
    t,
    'options',
    optionsReplies({
      // After the first load the page's re-read is slow, as on a busy worker: whatever the click
      // put on screen stays there meanwhile.
      'darkmode:get': async () => {
        if (loads++ > 0) await sleep(1000);
        return darkData({}, { configured: false, unpacked: true });
      },
      'license:devUnlock': null,
    }),
  );
  if (!ui) return;
  await ui.settle();
  await ui.page.click('#darkDevUnlock');
  await ui.page.waitForTimeout(400);
  assert.doesNotMatch(await text(ui.page, '#darkActionHint'), /applied/);
  await ui.page.waitForTimeout(1200);
  assert.match(await text(ui.page, '#darkActionHint'), /Dev unlock failed/);
});

test('options: zh-CN gets a Chinese date and translated accessible names (B76)', async (t) => {
  const ui = await open(
    t,
    'options',
    optionsReplies({
      'sponsorblock:getCategories': {
        categories: [{ id: 'selfpromo', label: 'Self-promotion', hint: 'Unpaid plugs.', enabled: true }],
        allOff: false,
      },
    }),
    { locale: 'zh_CN' },
  );
  if (!ui) return;
  await ui.settle();
  const { page } = ui;
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-CN');
  assert.match(await text(page, '#listAge'), /2026年9月7日/);
  assert.doesNotMatch(await text(page, '#listAge'), /Sep/);
  assert.equal(await page.getAttribute('#sponsorCategories input', 'aria-label'), '跳过 自我推广 片段');
  assert.equal(await page.getAttribute('#siteRuleHost', 'aria-label'), '站点主机名');
  assert.equal(await text(page, '.page-foot a[href="privacy.html"]'), '隐私');
});

test('options: the dark theme defines its warning colour and native control scheme', async (t) => {
  if (!browser) return t.skip(`Chromium unavailable: ${launchError?.message ?? 'unknown'}`);
  const ui = await open(t, 'options', optionsReplies());
  await ui.page.emulateMedia({ colorScheme: 'dark' });
  const probe = await ui.page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return { danger: root.getPropertyValue('--danger').trim(), scheme: root.colorScheme };
  });
  assert.equal(probe.danger, '#d9756b');
  assert.match(probe.scheme, /dark/);
});
