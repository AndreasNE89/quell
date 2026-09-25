// Cosmetic exceptions across lists and rule kinds (REVIEW_2026-09-24 B14, B16, B18 and the
// exception P3s): what `#@#`, `~domain`, `$generichide`, `$specifichide` and `$document` cancel,
// and what the generic stylesheets and their reverts carry.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLine } from '../scripts/lib/parse-filter.mjs';
import {
  applyCosmeticRule,
  emptyCosmeticBucket,
  serializeBucket,
  planGenericCss,
  genericCssText,
  CSS_CHUNK,
  applyNetworkCosmeticException,
  isDocumentException,
  applyDocumentCosmeticException,
} from '../scripts/lib/cosmetic-compile.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let engine;

before(async () => {
  const out = await build({
    stdin: {
      contents: `export * from './src/engine/cosmetic-match.ts';`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
  });
  engine = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
});

/** Compile each list's filter lines the way compile-filters does, into a cosmetic.json object. */
function compileLists(lists, { order = Object.keys(lists) } = {}) {
  const byList = {};
  const skips = {};
  const bag = {
    generichide: {},
    elemhide: {},
    specifichide: {},
    pathScoped: { generichide: {}, elemhide: {}, specifichide: {} },
    skips,
  };
  for (const id of order) {
    const cos = emptyCosmeticBucket();
    for (const line of lists[id]) {
      const p = parseLine(line);
      if (!p) continue;
      if (p.type === 'cosmetic') applyCosmeticRule(p, cos, { cosmetic: 0 }, skips);
      else if (p.cosmeticException) applyNetworkCosmeticException(p.cosmeticException, p, bag, id);
      else if (isDocumentException(p)) applyDocumentCosmeticException(p, bag, id);
    }
    byList[id] = serializeBucket(cos);
  }
  const plan = planGenericCss(byList, order);
  const genericCss = {};
  for (const id of order) {
    genericCss[id] = plan[id].map((s) => ({
      file: `generic-cosmetic/${s.name}.css`,
      revert: `generic-cosmetic/${s.name}.revert.css`,
      count: s.selectors.length,
      ...(s.unless.length ? { unless: s.unless } : {}),
      selectors: s.selectors,
    }));
  }
  const ser = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [...v]]));
  return {
    data: {
      byList,
      genericCss,
      networkExceptions: { generichide: ser(bag.generichide), elemhide: ser(bag.elemhide), specifichide: ser(bag.specifichide) },
      pathExceptions: {
        generichide: ser(bag.pathScoped.generichide),
        elemhide: ser(bag.pathScoped.elemhide),
        specifichide: ser(bag.pathScoped.specifichide),
      },
    },
    skips,
  };
}

test('a generic #@# in one list cancels the selector in every enabled list (B14)', () => {
  const { data } = compileLists({
    easylist: ['##[id^="div-gpt-ad"]', '##.reklama', '##.banner', 'example.com##.reklama'],
    'ubo-filters': ['#@#[id^="div-gpt-ad"]', '#@#.reklama', '##.reklama:not(.ads)'],
  });
  const sheets = (ids) => engine.genericCssFiles(data, ids);
  const selectors = (ids) => sheets(ids).flatMap((s) => s.selectors);

  // Both lists on: EasyList's bait hides are not registered at all.
  assert.deepEqual(selectors(['easylist', 'ubo-filters']).sort(), ['.banner', '.reklama:not(.ads)']);
  // uBO's list off: EasyList hides them again.
  assert.deepEqual(selectors(['easylist']).sort(), ['.banner', '.reklama', '[id^="div-gpt-ad"]']);
  assert.deepEqual(
    sheets(['easylist']).map((s) => [s.file, s.unless ?? []]),
    [
      ['generic-cosmetic/easylist.css', []],
      ['generic-cosmetic/easylist.x-ubo-filters.css', ['ubo-filters']],
    ],
  );
  assert.deepEqual(engine.genericCssRegistration(data, ['easylist', 'ubo-filters']).css, [
    'generated/generic-cosmetic/easylist.css',
    'generated/generic-cosmetic/ubo-filters.css',
  ]);

  // uBO: an exception set holds generic exceptions too, so a specific hide of the selector goes.
  const m = engine.matchCosmetic('example.com', data, ['easylist', 'ubo-filters']);
  assert.ok(!m.hide.includes('.reklama'));
  assert.ok(engine.matchCosmetic('example.com', data, ['easylist']).hide.includes('.reklama'));
});

test('#@# with ~ exclusions never hides, and a hide with exclusions spares them', () => {
  const { data } = compileLists({
    ubo: [
      // ubo-filters.txt: the exception must not become a hide on the excluded sites.
      '~przegladsportowy.pl,~fakt.pl,~forbes.pl,~onet.pl,pl#@#[id^="crt-"]',
      'oxy.*,~oxy.edu##[href*=".info"]',
      'site.pl##[id^="crt-"]',
    ],
  });
  for (const host of ['www.onet.pl', 'fakt.pl', 'www.forbes.pl']) {
    const m = engine.matchCosmetic(host, data, ['ubo']);
    assert.ok(!m.hide.includes('[id^="crt-"]'), host);
    assert.deepEqual(m.unhide, [], host);
  }
  // The exception still covers the rest of .pl …
  assert.ok(!engine.matchCosmetic('site.pl', data, ['ubo']).hide.includes('[id^="crt-"]'));
  assert.ok(engine.matchCosmetic('oxy.com', data, ['ubo']).hide.includes('[href*=".info"]'));
  // … and the excluded host just does not get the hide: no revert of its own CSS either.
  const edu = engine.matchCosmetic('www.oxy.edu', data, ['ubo']);
  assert.ok(!edu.hide.includes('[href*=".info"]'));
  assert.deepEqual(edu.unhide, []);
});

test('a revert is sent only for generic hides the registered sheet applies', () => {
  const { data } = compileLists({
    a: ['##.gen', 'example.com##.spec', 'example.com#@#.spec', 'example.com#@#.gen', '~quiet.com##.except-gen'],
    b: ['##.plain'],
  });
  // A specific exception of a specific hide drops the hide; the page's own display stays.
  const m = engine.matchCosmetic('example.com', data, ['a', 'b']);
  assert.ok(!m.hide.includes('.spec'));
  assert.deepEqual(m.unhide, ['.gen']);
  // `~quiet.com##.except-gen` is withdrawn on quiet.com only.
  assert.deepEqual(engine.matchCosmetic('quiet.com', data, ['a', 'b']).unhide, ['.except-gen']);
  assert.deepEqual(engine.matchCosmetic('loud.com', data, ['a', 'b']).unhide, []);
  // … unless another enabled list hides the same selector everywhere.
  const both = compileLists({ a: ['~quiet.com##.x'], b: ['##.x'] }).data;
  assert.deepEqual(engine.matchCosmetic('quiet.com', both, ['a', 'b']).unhide, []);
  assert.deepEqual(engine.matchCosmetic('quiet.com', both, ['a']).unhide, ['.x']);
});

test('list and user #@#, and $specifichide, cancel procedural rules (B18)', () => {
  const { data } = compileLists({
    l: [
      'safeway.com##.product-card-col:has-text(Sponsored)',
      'safeway.com##.promo:has-text(Deal)',
      'shop.safeway.com#@#.promo:has-text(Deal)',
      'imgur.com##.Gallery-Sidebar-PostContainer:has(> a[href*="/ad/"])',
      '@@||plain.safeway.com^$specifichide',
    ],
  });
  const exprs = (host, opts) => engine.matchCosmetic(host, data, ['l'], undefined, opts).procedural.map((p) => p.expr);
  assert.deepEqual(exprs('safeway.com'), ['.product-card-col:has-text(Sponsored)', '.promo:has-text(Deal)']);
  assert.deepEqual(exprs('shop.safeway.com'), ['.product-card-col:has-text(Sponsored)'], 'list #@#');
  assert.deepEqual(
    exprs('safeway.com', { userUnhide: ['.product-card-col:has-text(Sponsored)'] }),
    ['.promo:has-text(Deal)'],
    'the user’s own #@#',
  );
  assert.deepEqual(exprs('plain.safeway.com'), [], '$specifichide');
  // Native :has() is CSS now, so a #@# for it works like any other.
  const imgur = engine.matchCosmetic('imgur.com', data, ['l'], undefined, {
    userUnhide: ['.Gallery-Sidebar-PostContainer:has(> a[href*="/ad/"])'],
  });
  assert.deepEqual(imgur.hide, []);
  assert.deepEqual(imgur.procedural, []);
});

test('an entity $generichide reverts the registered sheets as files, not 13,923 selectors (B16)', () => {
  const { data } = compileLists({
    easylist: ['##.ad-slot', '##[id^="div-gpt-ad"]', '@@||www.google.*/search?$generichide', '@@||gmx.*^$ghide'],
    'ubo-filters': ['#@#[id^="div-gpt-ad"]'],
  });
  const ids = ['easylist', 'ubo-filters'];
  const url = 'https://www.google.de/search?q=x';
  const files = engine.matchCosmetic('www.google.de', data, ids, url, { genericRevert: 'files' });
  assert.equal(files.disableGeneric, true);
  assert.deepEqual(files.unhide, []);
  assert.deepEqual(files.revertGenericCss, [
    'generated/generic-cosmetic/easylist.revert.css',
    'generated/generic-cosmetic/ubo-filters.revert.css',
  ]);
  // Default: selectors, but only the ones the sheets hold.
  assert.deepEqual(engine.matchCosmetic('www.google.de', data, ids, url).unhide, ['.ad-slot']);
  assert.equal(engine.matchCosmetic('www.gmx.net', data, ids).disableGeneric, true);
  // Not the results page, and not another Google property.
  assert.equal(engine.matchCosmetic('www.google.de', data, ids, 'https://www.google.de/maps').disableGeneric, false);
  assert.equal(engine.matchCosmetic('news.google.de', data, ids, 'https://news.google.de/search?q=x').disableGeneric, false);
});

test('generic sheets: 500 selectors a rule, and a selector Chrome may reject gets its own (B16, B19)', () => {
  const plain = Array.from({ length: 1234 }, (_, i) => `.ad-${i}`);
  const risky = ['.x:has(.y:has(.z))', '::-moz-selection', '#\\31 280_adv'];
  const css = genericCssText('t', [...plain.slice(0, 600), ...risky, ...plain.slice(600)]);
  const rules = css.split('\n').filter((l) => l.includes('{'));
  const sizes = rules.map((r) => r.split(',').length);
  assert.ok(sizes.every((n) => n <= CSS_CHUNK), `a rule has ${Math.max(...sizes)} selectors`);
  for (const r of risky) assert.ok(rules.includes(`${r} { display: none !important; }`), r);
  assert.equal(rules.length, Math.ceil(plain.length / CSS_CHUNK) + risky.length);
  assert.ok(genericCssText('t', ['.a'], true).includes('.a { display: revert !important; }'));
});

test('$document exceptions switch element hiding off; a framed page’s domain= is not the page', () => {
  const { data, skips } = compileLists({
    easylist: [
      '@@||optout.networkadvertising.org^$document',
      '@@||tab.gladly.io/newtab/|$document,subdocument',
      '@@||framed.example^$document,domain=parent.example',
      '##.ad',
    ],
    china: ['@@||ad.12306.cn^$elemhide,subdocument,domain=95306.cn', '@@||asd.$generichide,to=asd.homes|asd.ink'],
    ubo: ['@@||shrink.$ghide,domain=shrink.icu|shrink.yt', '@@||news.example^$ghide,domain=www.news.example'],
  });
  const nai = engine.matchCosmetic('optout.networkadvertising.org', data, ['easylist']);
  assert.equal(nai.disableGeneric, true);
  assert.equal(nai.disableSpecific, true);
  const gladly = engine.matchCosmetic('tab.gladly.io', data, ['easylist'], 'https://tab.gladly.io/newtab/');
  assert.equal(gladly.disableSpecific, true);
  assert.equal(engine.matchCosmetic('parent.example', data, ['easylist']).disableSpecific, false);
  assert.equal(skips['document-exception-cosmetics-context'], 1);

  // The elemhide belongs to the ad.12306.cn frame; 95306.cn keeps its cosmetics.
  assert.equal(engine.matchCosmetic('95306.cn', data, ['china']).disableSpecific, false);
  assert.equal(engine.matchCosmetic('ad.12306.cn', data, ['china']).disableSpecific, true);
  // `$to` names the page and narrows the pattern.
  assert.deepEqual(data.networkExceptions.generichide.china, ['asd.homes', 'asd.ink']);
  // So does a `domain=` the pattern covers: those sites, not every shrink.* (uBO needs both).
  assert.deepEqual(data.networkExceptions.generichide.ubo, ['shrink.icu', 'shrink.yt', 'www.news.example']);
  assert.equal(engine.matchCosmetic('shrink.icu', data, ['ubo']).disableGeneric, true);
  assert.equal(engine.matchCosmetic('shrink.pe', data, ['ubo']).disableGeneric, false);
});

test('only a real $document exception switches element hiding off', () => {
  // The parser gives a typeless $removeparam every type, main_frame included; that exception only
  // keeps a query parameter. A $document with another modifier excepts that modifier.
  const { data } = compileLists({
    ubo: [
      '@@||example.com^$removeparam=utm_source',
      '@@||kept.example^$removeparam=x,doc',
      '@@||all.example^$all,~doc',
      '@@||csp.example^$document,csp=worker-src',
      '@@||skip.example^$doc,urlskip',
      '@@||whole.example^$all',
      '##.ad',
    ],
  });
  assert.deepEqual(data.networkExceptions.elemhide.ubo, ['whole.example']);
  for (const host of ['example.com', 'kept.example', 'all.example', 'csp.example', 'skip.example']) {
    const m = engine.matchCosmetic(host, data, ['ubo']);
    assert.equal(m.disableGeneric || m.disableSpecific, false, host);
  }
  // `$all` covers the document, as in uBO.
  assert.equal(engine.matchCosmetic('whole.example', data, ['ubo']).disableSpecific, true);
});
