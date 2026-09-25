// What a page's renderer can get the worker to do, and what the worker hands back to it
// (REVIEW_2026-09-24 P3 security), plus the settings-import and custom-filter-cap P3s, the
// user-origin generic sheet (B21) and prerendered pages' dark mode (B27).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootServiceWorker, capturingWarnings } from './helpers/sw-harness.mjs';

const PAID = () => ({ paid: true, provider: 'extensionpay', verifiedAt: Date.now() });

/** A content script in a tab on `url` (top frame unless `frameId` says otherwise). */
const page = (url, extra = {}) => ({
  id: 'test',
  frameId: 0,
  documentId: 'DOC',
  url,
  origin: new URL(url).origin,
  tab: { id: 1, url },
  ...extra,
});

test('a content script cannot switch sites off, pause, import or read settings', async () => {
  const sw = await bootServiceWorker({ host: 'evil.example' });
  await sw.settle();
  const from = page('https://evil.example/');
  const attempts = [
    { type: 'popup:toggleSite', hostname: 'bank.example', enabled: false },
    { type: 'popup:setPaused', paused: true },
    { type: 'sitefix:set', hostname: 'bank.example', level: 'injection' },
    { type: 'settings:import', json: JSON.stringify({ format: 'stampstack-settings', settings: { paused: true } }) },
    { type: 'settings:export' },
    { type: 'customfilters:set', text: '##body' },
    { type: 'lists:setEnabled', id: 'easylist', enabled: false },
    { type: 'license:devUnlock' },
  ];
  await capturingWarnings(async () => {
    for (const msg of attempts) assert.equal(await sw.send(msg, from), null, msg.type);
  });
  await sw.settle();
  const s = sw.settings();
  assert.deepEqual(s?.allowlist ?? [], []);
  assert.equal(s?.paused ?? false, false);
  assert.equal(s?.customFilters ?? '', '');
  // The same requests from the popup go through.
  assert.equal((await sw.send({ type: 'popup:setPaused', paused: true })).paused, true);
});

test('storage.local is closed to content scripts', async () => {
  // Otherwise a compromised renderer rewrites settings and the license directly.
  const sw = await bootServiceWorker({ host: 'news.example' });
  await sw.settle();
  assert.equal(sw.localAccess(), 'TRUSTED_CONTEXTS');
});

test('messages that are not ours are left to their own listener (ExtPay)', async () => {
  const sw = await bootServiceWorker({ host: 'news.example' });
  await sw.settle();
  assert.equal(await sw.send('fetch_user', page('https://extensionpay.com/')), undefined);
});

test('darkmode:get tells a page the decision, not the email or the override list', async () => {
  const sw = await bootServiceWorker({
    host: 'news.example',
    license: { ...PAID(), email: 'buyer@example.com' },
    settings: { darkModeEnabled: true, darkModeSiteOverrides: { 'secret.example': 'off' } },
  });
  await sw.settle();
  const data = await sw.send({ type: 'darkmode:get', hostname: 'news.example' }, page('https://news.example/'));
  assert.deepEqual(data, { paid: true, apply: true });
  const full = await sw.send({ type: 'darkmode:get', hostname: 'news.example' });
  assert.equal(full.license.email, 'buyer@example.com', 'Options still gets the full state');
});

test('a prerendered page gets its own dark-mode decision, not the visible page’s (B27)', async () => {
  const sw = await bootServiceWorker({
    host: 'news.example',
    license: PAID(),
    settings: { darkModeEnabled: true, darkModeSiteOverrides: { 'news.example': 'off' } },
  });
  await sw.settle();
  // The tab still shows news.example while search.example prerenders in it.
  const pre = {
    ...page('https://search.example/'),
    frameId: 3,
    documentLifecycle: 'prerender',
    tab: { id: 1, url: 'https://news.example/' },
  };
  const top = await sw.send({ type: 'darkmode:get', hostname: 'search.example', topHost: 'search.example' }, pre);
  assert.equal(top.apply, true, 'got news.example’s force-off');
  const frame = await sw.send(
    { type: 'darkmode:get', hostname: 'widgets.example', topHost: 'search.example' },
    { ...pre, url: 'https://widgets.example/w', frameId: 4 },
  );
  assert.equal(frame.apply, true);
  // A frame of the visible page still follows it.
  const visible = await sw.send(
    { type: 'darkmode:get', hostname: 'widgets.example' },
    page('https://widgets.example/w', { frameId: 5, tab: { id: 1, url: 'https://news.example/' } }),
  );
  assert.equal(visible.apply, false);
});

test('a page can add a picked hide for itself only', async () => {
  const sw = await bootServiceWorker({ host: 'www.news.example' });
  await sw.settle();
  const from = page('https://www.news.example/a');
  await capturingWarnings(async () => {
    for (const line of ['bank.example##.balance', '##body', 'news.example#@#.ad', 'com##body', 'example.*##.x']) {
      const r = await sw.send({ type: 'customfilters:add', line }, from);
      assert.equal(r.ok, false, line);
    }
  });
  assert.equal(sw.settings()?.customFilters ?? '', '');
  assert.deepEqual(await sw.send({ type: 'customfilters:add', line: 'news.example##.promo' }, from), { ok: true });
  assert.equal(sw.settings().customFilters, 'news.example##.promo\n');
  assert.ok(sw.tabMessages().some((m) => m.msg.type === 'cosmetic:refresh'));
});

test('refusals the settings page shows carry a code it can translate', async () => {
  // The worker's `error` is English; popup_error_<code> is what a zh-CN page shows instead.
  const offline = await bootServiceWorker({
    host: 'news.example',
    extpay: {
      openPaymentPage: () => Promise.reject(new TypeError('Failed to fetch')),
      openLoginPage: () => Promise.reject(new Error('ExtensionPay said no')),
    },
  });
  await offline.settle();
  const quietly = async (fn) => {
    const orig = console.error;
    console.error = () => {};
    try {
      return await fn();
    } finally {
      console.error = orig;
    }
  };
  const checkout = await quietly(() => offline.send({ type: 'license:openCheckout' }));
  assert.deepEqual([checkout.ok, checkout.code], [false, 'network']);
  const restore = await quietly(() => offline.send({ type: 'license:openRestore' }));
  assert.deepEqual([restore.ok, restore.code], [false, 'provider']);
  const notJson = await offline.send({ type: 'settings:import', json: '{nope' });
  assert.deepEqual([notJson.ok, notJson.code], [false, 'not_json']);
  const notOurs = await offline.send({ type: 'settings:import', json: '{"format":"other"}' });
  assert.deepEqual([notOurs.ok, notOurs.code], [false, 'not_export']);
});

test('a field of the wrong type keeps its value, and keys are normalized on import', async () => {
  const sw = await bootServiceWorker({
    host: 'news.example',
    settings: { allowlist: ['keep.example'], enabledLists: { 'easylist-cookie': true }, customFilters: 'a.b##.c\n' },
  });
  await sw.settle();
  const doc = {
    format: 'stampstack-settings',
    version: 2,
    settings: {
      allowlist: 'imported.example',
      enabledLists: { easyprivacy: 'false', 'ubo-filters': false },
      siteFixes: { 'WWW.Shop.Example': 'cosmetics', 'https://x.example/': 'cosmetics', 'y.example': 'all' },
      darkModeSiteOverrides: { 'Mixed.Example': 'on', 'not a host': 'off' },
      customFilters: 42,
      youtubeBlockShorts: true,
    },
  };
  const r = await sw.send({ type: 'settings:import', json: JSON.stringify(doc) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.ignored?.sort(), ['allowlist', 'customFilters']);
  const s = sw.settings();
  assert.deepEqual(s.allowlist, ['keep.example'], 'a string allowlist erased the real one');
  assert.equal(s.customFilters, 'a.b##.c\n');
  assert.deepEqual(s.enabledLists, { 'ubo-filters': false }, '"false" switched a list on');
  assert.deepEqual(s.siteFixes, { 'shop.example': 'cosmetics' });
  assert.deepEqual(s.darkModeSiteOverrides, { 'mixed.example': 'on' });
  assert.equal(s.youtubeBlockShorts, true);
});

test('an import reaches open pages without a reload', async () => {
  const sw = await bootServiceWorker({ host: 'news.example' });
  await sw.settle();
  const doc = { format: 'stampstack-settings', settings: { customFilters: 'news.example##.promo\n' } };
  await sw.send({ type: 'settings:import', json: JSON.stringify(doc) });
  await sw.settle();
  const types = sw.tabMessages().map((m) => m.msg.type);
  assert.ok(types.includes('cosmetic:refresh'), types.join());
  assert.ok(types.includes('darkmode:refresh'));
});

test('the filter cap cuts at a whole line, and a pick past it is refused', async () => {
  const sw = await bootServiceWorker({ host: 'news.example' });
  await sw.settle();
  const line = 'news.example##.ad-slot-with-a-long-class-name\n';
  const text = line.repeat(Math.ceil(100_000 / line.length) + 5);
  const r = await sw.send({ type: 'customfilters:set', text });
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 100_000);
  assert.ok(r.text.endsWith('\n') && r.text.split('\n').slice(0, -1).every((l) => l === line.trim()), 'a rule was cut in half');
  const extra = `news.example##.${'x'.repeat(100_000 - r.text.length)}`;
  const add = await sw.send({ type: 'customfilters:add', line: extra }, page('https://news.example/'));
  assert.equal(add.ok, false, 'saved past the cap, then gone on the next load');
  assert.equal(sw.settings().customFilters, r.text);
});

test('a top-level page gets the generic sheet at user origin too, once (B21)', async () => {
  const sw = await bootServiceWorker({ host: 'news.example' });
  await sw.settle();
  // The same sheets the registration injects at author origin.
  const files = sw.script('quell-generic-cosmetic').css;
  assert.ok(files.length > 0);
  const top = page('https://news.example/');
  await sw.send({ type: 'cosmetic:get', hostname: 'news.example' }, top);
  await sw.settle();
  const inserts = () => sw.cssCalls().filter((c) => c.op === 'insert');
  assert.deepEqual(inserts(), [
    { op: 'insert', target: { tabId: 1, documentIds: ['DOC'] }, files, origin: 'USER' },
  ]);
  // A refresh does not stack a second copy.
  await sw.send({ type: 'cosmetic:get', hostname: 'news.example' }, top);
  await sw.settle();
  assert.equal(inserts().length, 1);
  // Subframes keep the registered sheet only.
  await sw.send(
    { type: 'cosmetic:get', hostname: 'ads.example' },
    page('https://ads.example/f', { frameId: 9, documentId: 'SUB', tab: { id: 1, url: 'https://news.example/' } }),
  );
  await sw.settle();
  assert.equal(inserts().length, 1);
  // Switched off: the refresh takes it away again.
  await sw.send({ type: 'popup:toggleSite', hostname: 'news.example', enabled: false });
  await sw.send({ type: 'cosmetic:get', hostname: 'news.example' }, top);
  await sw.settle();
  assert.deepEqual(sw.cssCalls().filter((c) => c.op === 'remove'), [
    { op: 'remove', target: { tabId: 1, documentIds: ['DOC'] }, files, origin: 'USER' },
  ]);
});

test('a worker that slept still clears the sheets a page asking again holds (B21, B24)', async () => {
  // The per-document memory is gone after a wake. A page that asks again (a refresh, a new
  // exception in Options) says so, and whatever an earlier worker inserted there goes first:
  // a user-origin sheet left behind beats the author-origin revert of a new `#@#`.
  const first = await bootServiceWorker({ host: 'news.example' });
  await first.settle();
  const files = first.script('quell-generic-cosmetic').css;
  const reverts = files.map((f) => f.replace(/\.css$/, '.revert.css'));
  const top = page('https://news.example/');
  const ask = (sw, hostname, sender, refetch = true) =>
    sw.send({ type: 'cosmetic:get', hostname, ...(refetch ? { refetch } : {}) }, sender);
  const calls = (sw, origin, doc = 'DOC') =>
    sw.cssCalls().filter((c) => c.origin === origin && c.target.documentIds[0] === doc);
  const covers = (call, wanted) => wanted.every((f) => call.files.includes(f));

  // An exception now reverts a generic hide: the user sheet has to go.
  const woken = await bootServiceWorker({ host: 'news.example', settings: { customFilters: 'news.example#@##AD_160\n' } });
  await woken.settle();
  assert.deepEqual((await ask(woken, 'news.example', top)).unhide, ['#AD_160']);
  await woken.settle();
  const user = calls(woken, 'USER');
  assert.deepEqual(user.map((c) => c.op), ['remove']);
  assert.ok(covers(user[0], files), 'the forgotten user sheet stays and beats the revert');

  // Still wanted: out and back in, so a later removal leaves no second copy behind.
  const same = await bootServiceWorker({ host: 'news.example' });
  await same.settle();
  await ask(same, 'news.example', top);
  await same.settle();
  assert.deepEqual(calls(same, 'USER').map((c) => c.op), ['remove', 'insert']);
  assert.deepEqual(calls(same, 'USER')[1].files, files);

  // Switched off meanwhile: gone, while a revert the page may hold stays. A frame the page
  // switch reached gets its revert, and nothing is doubled.
  const off = await bootServiceWorker({ host: 'news.example', settings: { allowlist: ['news.example'] } });
  await off.settle();
  await ask(off, 'news.example', top);
  const ad = page('https://ads.example/f', { frameId: 5, documentId: 'AD', tab: { id: 1, url: 'https://news.example/' } });
  await ask(off, 'ads.example', ad);
  await off.settle();
  assert.deepEqual(calls(off, 'USER').map((c) => c.op), ['remove']);
  assert.deepEqual(calls(off, 'AUTHOR'), []);
  assert.deepEqual(calls(off, 'AUTHOR', 'AD').map((c) => c.op), ['remove', 'insert']);
  assert.deepEqual(calls(off, 'AUTHOR', 'AD')[1].files, reverts);

  // Switched on again after another wake: the frame's forgotten revert goes. A subframe never
  // held a user sheet, so nothing is asked of it there.
  const on = await bootServiceWorker({ host: 'news.example' });
  await on.settle();
  await ask(on, 'ads.example', ad);
  await on.settle();
  const author = calls(on, 'AUTHOR', 'AD');
  assert.deepEqual(author.map((c) => c.op), ['remove']);
  assert.ok(covers(author[0], reverts));
  assert.deepEqual(calls(on, 'USER', 'AD'), []);

  // A first ask removes nothing: the document cannot hold anything yet.
  const fresh = await bootServiceWorker({ host: 'news.example' });
  await fresh.settle();
  await ask(fresh, 'news.example', top, false);
  await fresh.settle();
  assert.deepEqual(fresh.cssCalls().map((c) => c.op), ['insert']);
});

test('no user-origin sheet where an exception has to revert generic hiding (B21)', async () => {
  // An author-origin revert cannot beat a user-origin `!important`. #AD_160 is an EasyList
  // generic hide, so the user's exception has to undo the registered sheet on this site.
  const sw = await bootServiceWorker({ host: 'news.example', settings: { customFilters: 'news.example#@##AD_160\n' } });
  await sw.settle();
  const r = await sw.send({ type: 'cosmetic:get', hostname: 'news.example' }, page('https://news.example/'));
  assert.deepEqual(r.unhide, ['#AD_160']);
  await sw.settle();
  assert.deepEqual(sw.cssCalls(), []);
  // Nor on the search pages EasyList exempts from generic hiding.
  const serp = await sw.send(
    { type: 'cosmetic:get', hostname: 'www.google.de' },
    page('https://www.google.de/search?q=x', { documentId: 'SERP' }),
  );
  assert.equal(serp.disableGeneric, true);
  await sw.settle();
  assert.deepEqual(sw.cssCalls().filter((c) => c.origin === 'USER'), []);
});

test('a user exception reverts only what the generic sheet hides (B15)', async () => {
  // `display: revert !important` on a selector nothing hid overrides the page's own CSS.
  const sw = await bootServiceWorker({
    host: 'news.example',
    settings: { customFilters: 'news.example#@#.not-hidden-by-any-list\nnews.example#@##AD_160\n' },
  });
  await sw.settle();
  const r = await sw.send({ type: 'cosmetic:get', hostname: 'news.example' }, page('https://news.example/'));
  assert.deepEqual(r.unhide, ['#AD_160']);
});

test('no user-origin sheet on a page a :style() filter restyles (B21)', async () => {
  // A `:style(display: block !important)` reveal is author-origin; a user-origin hide beats it.
  const sw = await bootServiceWorker({
    host: 'news.example',
    settings: { customFilters: 'news.example##.hero:style(display: block !important)\n' },
  });
  await sw.settle();
  const r = await sw.send({ type: 'cosmetic:get', hostname: 'news.example' }, page('https://news.example/'));
  assert.ok(r.procedural.some((p) => p.expr.includes(':style(')));
  await sw.settle();
  assert.deepEqual(sw.cssCalls().filter((c) => c.origin === 'USER'), []);
});

test('frames follow the page for generic hiding too (B24)', async () => {
  const sw = await bootServiceWorker({ host: 'news.example', settings: { allowlist: ['off.example'] } });
  await sw.settle();
  const files = sw.script('quell-generic-cosmetic').css;
  const reverts = files.map((f) => f.replace(/\.css$/, '.revert.css'));
  const author = (doc) =>
    sw.cssCalls().filter((c) => c.origin === 'AUTHOR' && c.target.documentIds[0] === doc);
  const frame = (url, top, documentId) =>
    page(url, { frameId: 5, documentId, tab: { id: 1, url: top } });

  // An ad frame on a switched-off page got the registered sheet (its own URL is not excluded):
  // it is undone there, as uBO switches element hiding off for the whole page.
  const offAd = await sw.send(
    { type: 'cosmetic:get', hostname: 'ads.example' },
    frame('https://ads.example/f', 'https://off.example/', 'AD-ON-OFF'),
  );
  assert.equal(offAd.allowlisted, true);
  await sw.settle();
  assert.deepEqual(author('AD-ON-OFF'), [
    { op: 'insert', target: { tabId: 1, documentIds: ['AD-ON-OFF'] }, files: reverts, origin: 'AUTHOR' },
  ]);
  // The switched-off page itself was excluded from the registration, so it needs nothing.
  await sw.send({ type: 'cosmetic:get', hostname: 'off.example' }, page('https://off.example/', { documentId: 'OFF' }));
  await sw.settle();
  assert.deepEqual(author('OFF'), []);

  // The reverse: a frame from the switched-off host, on a page that is on, was left out of the
  // registration by its own URL. It gets the sheet.
  const embed = await sw.send(
    { type: 'cosmetic:get', hostname: 'off.example' },
    frame('https://off.example/embed', 'https://news.example/', 'EMBED'),
  );
  assert.equal(embed.allowlisted, false);
  await sw.settle();
  assert.deepEqual(author('EMBED'), [
    { op: 'insert', target: { tabId: 1, documentIds: ['EMBED'] }, files, origin: 'AUTHOR' },
  ]);
  // An ordinary frame on an ordinary page has the registered sheet already.
  await sw.send(
    { type: 'cosmetic:get', hostname: 'ads.example' },
    frame('https://ads.example/f', 'https://news.example/', 'AD-ON-ON'),
  );
  await sw.settle();
  assert.deepEqual(author('AD-ON-ON'), []);

  // Paused: nothing is registered for new documents, and nothing is inserted.
  await sw.send({ type: 'popup:setPaused', paused: true });
  await sw.settle();
  await sw.send(
    { type: 'cosmetic:get', hostname: 'ads.example' },
    frame('https://ads.example/f', 'https://news.example/', 'AD-PAUSED'),
  );
  await sw.settle();
  assert.deepEqual(author('AD-PAUSED'), []);
});

test('a frame the lists keep out of generic hiding gets no revert on a switched-off page (B24)', async () => {
  // EasyList excludes www.youtube.com and docs.google.com from generic hiding: the registered
  // sheet never reached those frames, so a revert would only override their own display.
  const sw = await bootServiceWorker({ host: 'news.example', settings: { allowlist: ['off.example'] } });
  await sw.settle();
  const author = (doc) =>
    sw.cssCalls().filter((c) => c.origin === 'AUTHOR' && c.target.documentIds[0] === doc);
  const frame = (url, documentId) => page(url, { frameId: 5, documentId, tab: { id: 1, url: 'https://off.example/' } });
  for (const [host, url, doc] of [
    ['www.youtube.com', 'https://www.youtube.com/embed/x', 'YT'],
    ['docs.google.com', 'https://docs.google.com/document/d/x', 'DOCS'],
    ['www.bing.com', 'https://www.bing.com/search?q=x', 'SERP'],
  ]) {
    const r = await sw.send({ type: 'cosmetic:get', hostname: host }, frame(url, doc));
    assert.equal(r.allowlisted, true);
    await sw.settle();
    assert.deepEqual(author(doc), [], host);
  }
  // A frame the sheet did reach is still undone.
  await sw.send({ type: 'cosmetic:get', hostname: 'ads.example' }, frame('https://ads.example/f', 'AD'));
  await sw.settle();
  assert.equal(author('AD').length, 1);
});

test('a dark-mode override is stored under the host a tab reports, never a URL or a word', async () => {
  const sw = await bootServiceWorker({ host: 'news.example', license: PAID(), settings: { darkModeEnabled: true } });
  await sw.settle();
  await sw.send({ type: 'darkmode:setSiteOverride', hostname: 'https://WWW.Mixed.Example/path?q=1', override: 'off' });
  await sw.send({ type: 'darkmode:setSiteOverride', hostname: 'not a host', override: 'on' });
  await sw.send({ type: 'darkmode:setSiteOverride', hostname: 'other.example', override: 'sideways' });
  assert.deepEqual(sw.settings().darkModeSiteOverrides, { 'mixed.example': 'off' });
  await sw.settle();
  assert.deepEqual(sw.script('quell-dark-mode')?.excludeMatches, ['*://mixed.example/*', '*://www.mixed.example/*']);
});
