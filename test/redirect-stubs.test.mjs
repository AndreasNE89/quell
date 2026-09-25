// The analytics, GPT and AdSense redirect stubs (src/redirects/*.js), run in a node vm.
//
// The seed redirects these libraries to the stubs on every site so that pages depending on them
// keep working. A stub that only defines globals does not do that: pages queue commands and
// callbacks before the library loads and wait for them (REVIEW_2026-09-24 B57-B59). Page code
// runs inside the vm context too, so its arrays and functions come from the same realm as the
// stub's, as they would in a browser. test/redirect-stubs-dom.test.mjs covers the DOM side.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const stub = (name) => readFileSync(join(ROOT, 'src', 'redirects', name), 'utf8');
/** A value from the vm realm as a plain one, so deepEqual does not compare prototypes. */
const plain = (v) => JSON.parse(JSON.stringify(v));

/**
 * A window-like context. `page` runs first, the stub second. Timers are queued, not run, so a
 * test can tell a synchronous callback from a deferred one; `flush()` runs them.
 */
function run(file, page = '', { scriptSrc = null, elements = {} } = {}) {
  const timers = [];
  const navigations = [];
  const ctx = {
    setTimeout: (fn, _ms, ...args) => timers.push(() => fn(...args)),
    URL,
    location: { assign: (url) => navigations.push(url) },
    document: {
      readyState: 'complete',
      currentScript: scriptSrc ? { src: scriptSrc } : null,
      getElementById: (id) => elements[id] ?? null,
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    results: {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  if (page) vm.runInContext(page, ctx);
  vm.runInContext(stub(file), ctx);
  const flush = () => {
    while (timers.length) timers.shift()();
  };
  return { ctx, r: ctx.results, flush, timers, navigations, exec: (code) => vm.runInContext(code, ctx) };
}

// --- google-analytics.js -----------------------------------------------------------------------

const ANALYTICS_SNIPPET = (name = 'ga') => `
  window.GoogleAnalyticsObject = '${name}';
  window['${name}'] = window['${name}'] || function () { (window['${name}'].q = window['${name}'].q || []).push(arguments); };
  window['${name}'].l = 1;
  ${name}('create', 'UA-1-1', 'auto');
  ${name}(function (tracker) { results.ready = typeof tracker.get; });
  ${name}('send', 'pageview', { hitCallback: function () { results.hits = (results.hits || 0) + 1; } });
  ${name}('send', 'event', 'outbound', 'click', 'x', 'hitCallback', function () { results.pairHit = true; });
`;

test('analytics.js: the snippet queue is replayed, so ready and hit callbacks run', () => {
  const { ctx, r, exec } = run('google-analytics.js', ANALYTICS_SNIPPET());
  assert.equal(r.ready, 'function', 'ga(fn) is called with a tracker');
  assert.equal(r.hits, 1, 'a queued hitCallback runs');
  assert.equal(r.pairHit, true, "'hitCallback', fn in the argument list runs");
  assert.equal(ctx.ga.loaded, true, 'the queue function is replaced');
  assert.equal(typeof ctx.ga.create, 'function');
  // A click handler that navigates from hitCallback, after the library "loaded".
  exec(`ga('send', 'event', 'outbound', 'click', { hitCallback: function () { results.later = true; } });`);
  assert.equal(r.later, true);
  assert.equal(exec('typeof ga.getAll()[0].get'), 'function', 'getAll() has a tracker to read');
  assert.equal(exec('typeof ga.getByName("t0").send'), 'function');
});

test('analytics.js: a renamed global (GoogleAnalyticsObject) is the one replaced', () => {
  const { ctx, r } = run('google-analytics.js', ANALYTICS_SNIPPET('__gaTracker'));
  assert.equal(r.hits, 1);
  assert.equal(ctx.GoogleAnalyticsObject, '__gaTracker', 'the page chose the name; keep it');
  assert.equal(ctx.__gaTracker.loaded, true);
  assert.equal(ctx.ga, undefined, 'no second, unrelated global');
});

test('analytics.js: a real library that some exception let through is left alone', () => {
  const page = `
    window.ga = function real() { results.realCalled = true; };
    ga.loaded = true;
    ga.create = function () {};
    window.realGa = ga;
  `;
  const { ctx, exec } = run('google-analytics.js', page);
  assert.equal(ctx.ga, ctx.realGa);
  exec(`ga('send', 'pageview');`);
  assert.equal(ctx.results.realCalled, true);
});

test('gtm.js: the anti-flicker hide ends, and eventCallback runs for queued and later pushes', () => {
  const page = `
    window.dataLayer = window.dataLayer || [];
    dataLayer.hide = { 'GTM-X': true, end: function () { results.ended = (results.ended || 0) + 1; } };
    dataLayer.push({ event: 'gtm.js', 'gtm.start': 1 });
    dataLayer.push({ event: 'form', eventCallback: function () { results.queuedCallback = true; } });
    function gtag() { dataLayer.push(arguments); }
    gtag('event', 'purchase', { event_callback: function () { results.gtagCallback = true; } });
    gtag('get', 'G-1', 'client_id', function (id) { results.getCallback = typeof id; });
  `;
  const { r, flush, exec } = run('google-analytics.js', page);
  assert.equal(r.ended, 1, 'dataLayer.hide.end() is what lifts opacity:0 off the page');
  assert.equal(r.queuedCallback, undefined, 'GTM runs eventCallback after the push, not inside it');
  flush();
  assert.equal(r.queuedCallback, true);
  assert.equal(r.gtagCallback, true, "gtag('event', …, { event_callback }) runs");
  assert.equal(r.getCallback, 'undefined', "gtag('get', …, callback) is answered");
  exec(`dataLayer.push({ event: 'click', eventCallback: function () { results.laterCallback = true; } });`);
  flush();
  assert.equal(r.laterCallback, true);
  assert.equal(exec('dataLayer.length'), 5, 'pushes still reach the array');
  exec('dataLayer.hide.end()');
  assert.equal(r.ended, 1, 'the snippet timeout calling end() again is harmless');
});

test('gtm.js and gtag/js both stubbed on one page run each callback once', () => {
  const page = `
    window.dataLayer = [{ event: 'x', eventCallback: function () { results.n = (results.n || 0) + 1; } }];
  `;
  const { r, flush, exec } = run('google-analytics.js', page);
  exec(stub('google-analytics.js'));
  exec(`dataLayer.push({ event: 'y', eventCallback: function () { results.m = (results.m || 0) + 1; } });`);
  flush();
  assert.equal(r.n, 1);
  assert.equal(r.m, 1);
});

test('gtm.js: a real container on the page keeps its own dataLayer handling', () => {
  const page = `
    window.google_tag_manager = {};
    window.dataLayer = [{ event: 'x', eventCallback: function () { results.n = 1; } }];
    window.nativePush = dataLayer.push;
  `;
  const { r, flush, ctx } = run('google-analytics.js', page);
  flush();
  assert.equal(r.n, undefined, 'the real container calls it, not the stub');
  assert.equal(ctx.dataLayer.push, ctx.nativePush);
});

test('gtm.js: a data layer renamed with l= is the one handled', () => {
  const page = `
    window.myLayer = [{ event: 'x', eventCallback: function () { results.custom = true; } }];
  `;
  const { r, flush } = run('google-analytics.js', page, {
    scriptSrc: 'https://www.googletagmanager.com/gtm.js?id=GTM-1&l=myLayer',
  });
  flush();
  assert.equal(r.custom, true);
});

test('ga.js: _gaq is replayed, _link navigates, and _gat exists for the synchronous snippet', () => {
  const page = `
    var _gaq = _gaq || [];
    _gaq.push(['_setAccount', 'UA-1-1'], ['_trackPageview']);
    _gaq.push(function () { results.fn = true; });
    _gaq.push(['_set', 'hitCallback', function () { results.hit = true; }]);
  `;
  const { r, exec, navigations } = run('google-analytics.js', page);
  assert.equal(r.fn, true, 'a queued function runs');
  assert.equal(r.hit, true, "['_set', 'hitCallback', fn] runs");
  exec(`_gaq.push(['_link', 'https://other.example/landing']);`);
  exec(`_gaq.push(['t2._link', 'https://third.example/']);`);
  assert.deepEqual(navigations, ['https://other.example/landing', 'https://third.example/']);
  exec(`var t = _gat._getTracker('UA-1-1'); t._trackPageview(); results.linker = t._getLinkerUrl('https://a.example/');`);
  assert.equal(r.linker, 'https://a.example/');
  assert.equal(exec(`typeof _gaq._getAsyncTracker()._trackEvent`), 'function');
});

// --- gpt.js ------------------------------------------------------------------------------------

// The documented surface (developers.google.com/publisher-tag/reference) plus a few widely used
// undocumented members; the same list the review's api-diff probe measured.
const GPT_SURFACE = {
  googletag: ['apiReady', 'cmd', 'pubadsReady', 'secureSignalProviders', 'companionAds', 'defineOutOfPageSlot', 'defineSlot', 'destroySlots', 'disablePublisherConsole', 'display', 'enableServices', 'enums', 'getVersion', 'openConsole', 'pubads', 'setAdIframeTitle', 'setConfig', 'sizeMapping'],
  pubads: ['addEventListener', 'clear', 'clearCategoryExclusions', 'clearTargeting', 'collapseEmptyDivs', 'disableInitialLoad', 'display', 'enableLazyLoad', 'enableSingleRequest', 'enableVideoAds', 'get', 'getAttributeKeys', 'getSlots', 'getTargeting', 'getTargetingKeys', 'isInitialLoadDisabled', 'refresh', 'removeEventListener', 'set', 'setCategoryExclusion', 'setCentering', 'setForceSafeFrame', 'setLocation', 'setPrivacySettings', 'setPublisherProvidedId', 'setSafeFrameConfig', 'setTargeting', 'setVideoContent', 'updateCorrelator', 'setCookieOptions', 'setRequestNonPersonalizedAds', 'setTagForChildDirectedTreatment', 'enableAsyncRendering', 'definePassback', 'defineOutOfPagePassback'],
  slot: ['addService', 'clearCategoryExclusions', 'clearTargeting', 'defineSizeMapping', 'get', 'getAdUnitPath', 'getAttributeKeys', 'getCategoryExclusions', 'getConfig', 'getResponseInformation', 'getSlotElementId', 'getTargeting', 'getTargetingKeys', 'set', 'setCategoryExclusion', 'setClickUrl', 'setCollapseEmptyDiv', 'setConfig', 'setForceSafeFrame', 'setSafeFrameConfig', 'setTargeting', 'updateTargetingFromMap', 'getSizes', 'getSlotId', 'getDomId'],
  companionAds: ['addEventListener', 'removeEventListener', 'setRefreshUnfilledSlots'],
};

test('gpt.js: the documented googletag, pubads, slot and companionAds members all exist', () => {
  const { ctx } = run('gpt.js');
  const gt = ctx.googletag;
  const objects = {
    googletag: gt,
    pubads: gt.pubads(),
    slot: gt.defineSlot('/1234/top', [728, 90], 'div-gpt-ad-1'),
    companionAds: gt.companionAds(),
  };
  for (const [name, members] of Object.entries(GPT_SURFACE)) {
    const missing = members.filter((m) => !(m in objects[name]));
    assert.deepEqual(missing, [], `${name} is missing members`);
  }
  assert.notEqual(gt.enums.OutOfPageFormat.INTERSTITIAL, gt.enums.OutOfPageFormat.TOP_ANCHOR);
  assert.equal(typeof gt.getVersion(), 'string');
});

test('gpt.js: slots keep the path, sizes and div they were defined with', () => {
  const { ctx } = run('gpt.js');
  const gt = ctx.googletag;
  const a = gt.defineSlot('/6355419/Sidebar', [[300, 600], [300, 250]], 'div-gpt-ad-4');
  const b = gt.defineSlot('/6355419/Footer', [728, 90], 'div-gpt-ad-5').addService(gt.pubads());
  assert.equal(a.getSlotElementId(), 'div-gpt-ad-4');
  assert.equal(a.getAdUnitPath(), '/6355419/Sidebar');
  assert.deepEqual(plain(a.getSizes().map((s) => [s.getWidth(), s.getHeight()])), [[300, 600], [300, 250]]);
  assert.equal(b.getSlotId().getDomId(), 'div-gpt-ad-5');
  const found = gt.pubads().getSlots().find((s) => s.getSlotElementId() === 'div-gpt-ad-5');
  assert.equal(found, b, 'getSlots() lists defined slots');
  found.setTargeting('pos', 'footer');
  assert.deepEqual(plain(b.getTargeting('pos')), ['footer']);
  assert.deepEqual(plain(b.getTargetingKeys()), ['pos']);
  gt.pubads().setTargeting('section', ['news', 'world']);
  assert.deepEqual(plain(gt.pubads().getTargeting('section')), ['news', 'world']);
  gt.destroySlots([a]);
  assert.deepEqual([...gt.pubads().getSlots()], [b]);
  gt.destroySlots();
  assert.equal(gt.pubads().getSlots().length, 0);
});

test('gpt.js: queued commands run in order, each push runs every argument, and one failure stops nothing', () => {
  const page = `
    window.googletag = window.googletag || { cmd: [] };
    window.heldCmd = googletag.cmd;
    results.order = [];
    googletag.cmd.push(function () { results.order.push('a'); });
    googletag.cmd.push(function () { throw new Error('page bug'); });
    googletag.cmd.push(function () { results.order.push('b'); });
  `;
  const { ctx, r, exec } = run('gpt.js', page);
  assert.deepEqual([...r.order], ['a', 'b']);
  exec(`googletag.cmd.push(function () { results.order.push('c'); }, function () { results.order.push('d'); });`);
  assert.deepEqual([...r.order], ['a', 'b', 'c', 'd'], 'cmd.push(f1, f2) runs both');
  // A reference the page kept to its own queue still works after load.
  exec(`heldCmd.push(function () { results.order.push('e'); });`);
  assert.deepEqual([...r.order], ['a', 'b', 'c', 'd', 'e']);
  assert.equal(ctx.googletag.cmd, ctx.heldCmd);
});

test('gpt.js: slotRenderEnded reports each displayed slot as empty, after the calling code', () => {
  const page = `
    window.googletag = { cmd: [] };
    results.events = [];
    googletag.cmd.push(function () {
      var slot = googletag.defineSlot('/1/a', [300, 250], 'div-a').addService(googletag.pubads());
      googletag.pubads().addEventListener('slotRenderEnded', function (e) {
        results.events.push([e.slot.getSlotElementId(), e.isEmpty, e.size]);
      });
      googletag.pubads().addEventListener('slotRequested', function () { results.requested = true; });
      googletag.pubads().addEventListener('slotOnload', function () { results.onload = true; });
      googletag.enableServices();
      googletag.display('div-a');
      results.sync = results.events.length;
    });
  `;
  const { r, flush } = run('gpt.js', page);
  assert.equal(r.sync, 0, 'events are not dispatched inside display()');
  flush();
  assert.deepEqual(plain(r.events), [['div-a', true, null]]);
  assert.equal(r.requested, true);
  assert.equal(r.onload, undefined, 'real GPT fires no slotOnload for an empty slot');
});

test('gpt.js: disableInitialLoad holds events until refresh(), and collapseEmptyDivs collapses', () => {
  const ad = { style: { display: '' } };
  const page = `
    window.googletag = { cmd: [] };
    results.ended = 0;
    googletag.cmd.push(function () {
      googletag.defineSlot('/1/a', [300, 250], 'div-a').addService(googletag.pubads());
      googletag.pubads().disableInitialLoad();
      googletag.pubads().collapseEmptyDivs();
      googletag.pubads().addEventListener('slotRenderEnded', function () { results.ended++; });
      googletag.enableServices();
      googletag.display('div-a');
      results.disabled = googletag.pubads().isInitialLoadDisabled();
    });
  `;
  const { r, flush, exec } = run('gpt.js', page, { elements: { 'div-a': ad } });
  flush();
  assert.equal(r.disabled, true);
  assert.equal(r.ended, 0, 'with the initial load disabled, display() fetches nothing');
  exec('googletag.pubads().refresh()');
  flush();
  assert.equal(r.ended, 1);
  assert.equal(ad.style.display, 'none', 'an empty slot collapses when the page asked for it');
});

test('gpt.js: a synchronous legacy snippet runs to its last line', () => {
  // The review's fixture: every call here threw "is not a function" on the old stub, and the
  // rest of the inline script never ran.
  const { r, exec } = run('gpt.js');
  exec(`
    googletag.pubads().setForceSafeFrame(true);
    googletag.pubads().set('page_url', 'https://example.test/');
    googletag.setAdIframeTitle('Advertisement');
    googletag.pubads().enableLazyLoad({ fetchMarginPercent: 500 });
    googletag.pubads().setPublisherProvidedId('abc');
    googletag.pubads().enableVideoAds();
    googletag.setConfig({ adYield: 'DISABLED' });
    googletag.companionAds().addEventListener('slotRenderEnded', function () {});
    var slot = googletag.defineOutOfPageSlot('/1/interstitial', googletag.enums.OutOfPageFormat.INTERSTITIAL);
    if (slot) slot.addService(googletag.pubads());
    googletag.pubads().setSafeFrameConfig({ allowOverlayExpansion: true });
    googletag.sizeMapping().addSize([1024, 0], [728, 90]).addSize([0, 0], []).build();
    results.ready = googletag.pubads().get('page_url');
  `);
  assert.equal(r.ready, 'https://example.test/');
});

test('gpt.js: a real GPT already on the page is left alone', () => {
  const page = `
    window.googletag = { apiReady: true, pubads: function () { return 'real'; }, cmd: [] };
    window.realTag = googletag;
  `;
  const { ctx } = run('gpt.js', page);
  assert.equal(ctx.googletag, ctx.realTag);
  assert.equal(ctx.googletag.pubads(), 'real');
});

// --- adsbygoogle.js ----------------------------------------------------------------------------

test('adsbygoogle.js: the H5 Ad Placement API gets onReady and adBreakDone, and no reward', () => {
  const page = `
    window.adsbygoogle = window.adsbygoogle || [];
    var adBreak = window.adConfig = function (o) { adsbygoogle.push(o); };
    results.calls = [];
    adConfig({ preloadAdBreaks: 'on', onReady: function () { results.calls.push('ready'); } });
    adBreak({
      type: 'start', name: 'game_start',
      beforeAd: function () { results.calls.push('beforeAd'); },
      afterAd: function () { results.calls.push('afterAd'); },
      adBreakDone: function (info) { results.calls.push('done:' + info.breakType + ':' + info.breakName + ':' + info.breakFormat); results.status = info.breakStatus; },
    });
  `;
  const { r, flush, exec } = run('adsbygoogle.js', page);
  assert.deepEqual([...r.calls], [], 'callbacks run after the push, not inside it');
  flush();
  assert.deepEqual([...r.calls], ['ready', 'done:start:game_start:interstitial']);
  assert.equal(typeof r.status, 'string');
  exec(`adBreak({
    type: 'reward', name: 'extra_life',
    beforeReward: function (show) { results.calls.push('beforeReward'); show(); },
    adViewed: function () { results.calls.push('viewed'); },
    adDismissed: function () { results.calls.push('dismissed'); },
    adBreakDone: function (info) { results.calls.push('done:' + info.breakFormat); },
  });`);
  flush();
  assert.deepEqual([...r.calls], ['ready', 'done:start:game_start:interstitial', 'done:reward']);
  assert.equal(exec('adsbygoogle.loaded'), true);
});

test('adsbygoogle.js: loading twice does not run callbacks twice', () => {
  const page = `
    window.adsbygoogle = [{ onReady: function () { results.ready = (results.ready || 0) + 1; } }];
  `;
  const { r, flush, exec } = run('adsbygoogle.js', page);
  exec(stub('adsbygoogle.js'));
  flush();
  assert.equal(r.ready, 1);
});
