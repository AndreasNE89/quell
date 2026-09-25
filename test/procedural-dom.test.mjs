// Procedural cosmetic filters against a real DOM (Playwright Chromium).
//
// The engine (src/engine/procedural.ts) and the content script's runner
// (src/content/procedural-runner.ts) are bundled the way content.js bundles them and run in a
// page: the unit tests in engine.test.mjs only see the parser, which is how action operators
// hid what they meant to restyle, nested operators matched nothing, and a recycled list row
// stayed hidden for good.
//
// Skips (does not fail) when Chromium cannot be launched.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://stampstack.test';

let bundle = '';
let browser;
let launchError;

before(async () => {
  const out = await build({
    stdin: {
      contents: `
        export { queryProcedural, proceduralMutationObserverInit } from './src/engine/procedural.ts';
        export { ProceduralRunner } from './src/content/procedural-runner.ts';
      `,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    globalName: '__ss',
    platform: 'browser',
    target: 'chrome120',
    write: false,
    logLevel: 'silent',
  });
  bundle = out.outputFiles[0].text;
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

/** Open `html` at `path` on the test origin with the engine loaded. */
async function open(html, path = '/') {
  const page = await browser.newPage();
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
  });
  await page.goto(`${ORIGIN}${path}`);
  await page.addScriptTag({ content: bundle });
  return page;
}

/** Run `rules` through a runner, as content.ts does with the worker's answer. */
async function runRules(page, rules) {
  await page.evaluate((r) => {
    window.runner = new __ss.ProceduralRunner();
    window.runner.setRules(r);
    window.runner.start();
  }, rules);
  await settle(page);
}

/** Let mutation-driven passes run: two frames plus a little slack for the throttle. */
async function settle(page) {
  await page.evaluate(
    () =>
      new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30))),
      ),
  );
}

const display = (page, sel) =>
  page.$$eval(sel, (els) => els.map((e) => `${e.id}:${getComputedStyle(e).display}`));

const ids = (page, expr) =>
  page.evaluate((x) => __ss.queryProcedural(x).map((e) => e.id), expr);

function skip(t) {
  if (browser) return false;
  t.skip(`Chromium unavailable: ${launchError?.message ?? 'unknown'}`);
  return true;
}

test('action operators act instead of hiding (B12)', async (t) => {
  if (skip(t)) return;
  const page = await open(`<!doctype html><body>
    <button id="play" class="pi-btn pi-btn--play is-locked" disabled>Play</button>
    <form><div id="row"><div class="g-recaptcha"></div><button>Submit</button></div></form>
    <div id="bait" class="adsbygoogle" style="display:none" data-x="1" title="t">ad</div>
    <div id="card" class="post sponsored">Sponsored</div>
  </body>`);
  try {
    await runRules(page, [
      // hianime.ms: unlock the play button — 2.2.2 hid it instead.
      { expr: '.pi-btn--play.pi-btn:watch-attr(disabled):remove-class(is-locked)' },
      // networkhint.com: reveal the captcha row — it used to be hidden.
      { expr: '.g-recaptcha:upward(form > div):style(display: block !important;)' },
      // The compiler's action records carry the action in fields.
      { expr: '#bait', action: 'remove-attr', arg: '/^(?:data-x|title)$/' },
      // An unknown operator must fail closed, not hide whatever reached it.
      { expr: '.post:has-text(Sponsored):others()' },
    ]);
    const r = await page.evaluate(() => ({
      play: [document.getElementById('play').className, getComputedStyle(document.getElementById('play')).display],
      row: getComputedStyle(document.getElementById('row')).display,
      bait: [document.getElementById('bait').hasAttribute('data-x'), document.getElementById('bait').hasAttribute('title')],
      card: getComputedStyle(document.getElementById('card')).display,
    }));
    assert.deepEqual(r.play, ['pi-btn pi-btn--play', 'inline-block']);
    assert.equal(r.row, 'block');
    assert.deepEqual(r.bait, [false, false]);
    assert.equal(r.card, 'block', 'an unsupported operator must not hide anything');
  } finally {
    await page.close();
  }
});

test(':style() with an unsafe declaration is dropped, never turned into a hide', async (t) => {
  if (skip(t)) return;
  const page = await open(`<!doctype html><body><div id="a" class="hero">x</div></body>`);
  try {
    await runRules(page, [
      { expr: '.hero:has-text(x):style(background: url(https://evil.test/x.png))' },
      { expr: '.hero', action: 'style', arg: 'color: red } body { display: none' },
    ]);
    assert.deepEqual(await display(page, '#a'), ['a:block']);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).display), 'block');
  } finally {
    await page.close();
  }
});

test(':remove() takes matches out of the page, including ones added later', async (t) => {
  if (skip(t)) return;
  const page = await open(`<!doctype html><body><div class="ad" id="a1">Ad</div><p id="keep">x</p></body>`);
  try {
    await runRules(page, [{ expr: '.ad:has-text(Ad):remove()' }]);
    assert.equal(await page.$('#a1'), null);
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div class="ad" id="a2">Ad</div>'));
    await settle(page);
    assert.equal(await page.$('#a2'), null);
    assert.notEqual(await page.$('#keep'), null);
  } finally {
    await page.close();
  }
});

test('procedural operators inside :has(), :not() and :if-not() are evaluated (B13)', async (t) => {
  if (skip(t)) return;
  const page = await open(`<!doctype html><body>
    <ul>
      <li id="l1"><div class="info"><span class="cat"><a rel="category tag">推广</a></span></div></li>
      <li id="l2"><div class="info"><span class="cat"><a rel="category tag">新闻</a></span></div></li>
    </ul>
    <div class="card" id="c1">Promo <span class="label">Organic</span></div>
    <div class="card" id="c2">Promo <span class="label">Paid</span></div>
    <div class="w310" id="w1"><div class="swiper-company"></div></div>
    <div class="w310" id="w2"><div class="other"></div></div>
  </body>`);
  try {
    // EasyList China, after the compiler's -abp- rewrite, and before it.
    assert.deepEqual(
      await ids(page, 'li:has(>.info>.cat>a[rel="category tag"]:has-text(推广))'),
      ['l1'],
    );
    assert.deepEqual(await ids(page, '.w310:-abp-has(>.swiper-company)'), ['w1']);
    assert.deepEqual(
      await ids(page, '.card:has-text(Promo):not(:has(.label:has-text(Organic)))'),
      ['c2'],
    );
    assert.deepEqual(await ids(page, '.card:has-text(Promo):if-not(.label:has-text(Organic))'), ['c2']);
    assert.deepEqual(await ids(page, '.card:if(.label:has-text(Paid))'), ['c2']);
    // A :not() before any other operator used to stay in the CSS prefix and throw.
    assert.deepEqual(await ids(page, '.card:not(:has-text(Paid))'), ['c1']);
  } finally {
    await page.close();
  }
});

test('plain CSS after an operator applies relative to each match (B23)', async (t) => {
  if (skip(t)) return;
  const page = await open(`<!doctype html><body>
    <section>
      <div class="ad" id="a1">x <i class="inner" id="i1"></i></div>
      <div class="ad" id="a2">x <i class="inner" id="i2"></i></div>
      <div class="ad" id="a3">x <i class="inner" id="i3"></i></div>
    </section>
    <div class="video-holder"><center><div id="v1">Advertisement</div><div id="v2">Video</div></center></div>
    <div class="box" id="b1">hello <p class="p" id="p1">world</p><p class="p" id="p2">other</p></div>
    <div id="n1" class="row">Ad</div><div id="n2" class="next"></div>
  </body>`);
  try {
    assert.deepEqual(await ids(page, '.ad:has-text(x):nth-child(2)'), ['a2']);
    assert.deepEqual(await ids(page, '.ad:has-text(x):first-child .inner'), ['i1']);
    assert.deepEqual(await ids(page, '.ad:has-text(x) > .inner'), ['i1', 'i2', 'i3']);
    assert.deepEqual(await ids(page, '.video-holder > center > :has-text(/^Advertisement$/)'), ['v1']);
    assert.deepEqual(await ids(page, '.box:has-text(hello) > .p:has-text(world)'), ['p1']);
    assert.deepEqual(await ids(page, '.row:has-text(Ad) + .next'), ['n2']);
    // A selector list: only its procedural member is filtered by the operator.
    assert.deepEqual(await ids(page, '#n2, .row:has-text(Nope)'), ['n2']);
  } finally {
    await page.close();
  }
});

test(':matches-css and :matches-attr match literal values exactly, regex names work', async (t) => {
  if (skip(t)) return;
  const page = await open(`<!doctype html><body>
    <div id="z0" style="position:relative;z-index:0">a</div>
    <div id="z10" style="position:relative;z-index:10">b</div>
    <a id="h1" data-href="x">h</a><a id="h2" href="y">h</a><a id="h3" title="z">h</a>
  </body>`);
  try {
    assert.deepEqual(await ids(page, 'div:matches-css(z-index: 0)'), ['z0']);
    assert.deepEqual(await ids(page, 'div:matches-css(z-index: /^1/)'), ['z10']);
    assert.deepEqual(await ids(page, 'a:matches-attr(/-?href/)'), ['h1', 'h2']);
    assert.deepEqual(await ids(page, 'a:matches-attr(title="z")'), ['h3']);
    assert.deepEqual(await ids(page, 'a:matches-attr(title="zz")'), []);
  } finally {
    await page.close();
  }
});

test('procedural hides are reversible and survive page style writes (B20)', async (t) => {
  if (skip(t)) return;
  const page = await open(`<!doctype html><body>
    <div class="product-card-col" id="c1">Apples</div>
    <div class="product-card-col" id="c2">Sponsored · Soda</div>
    <div class="product-card-col" id="c3">Pears</div>
  </body>`);
  try {
    await runRules(page, [{ expr: '.product-card-col:has-text(Sponsored)' }]);
    assert.deepEqual(await display(page, '.product-card-col'), ['c1:block', 'c2:none', 'c3:block']);

    // Virtualized list: the sponsored node is recycled for organic content.
    await page.evaluate(() => {
      document.getElementById('c2').textContent = 'Bananas';
      document.getElementById('c3').textContent = 'Sponsored · Chips';
    });
    await settle(page);
    assert.deepEqual(await display(page, '.product-card-col'), ['c1:block', 'c2:block', 'c3:none']);

    // The page resets the element's inline style: the ad must stay hidden.
    await page.evaluate(() => document.getElementById('c3').setAttribute('style', 'order: 2'));
    await settle(page);
    assert.deepEqual(await display(page, '#c3'), ['c3:none']);

    // Stopping (allowlisted, cosmetics switched off) restores everything.
    await page.evaluate(() => window.runner.stop());
    assert.deepEqual(await display(page, '.product-card-col'), ['c1:block', 'c2:block', 'c3:block']);
  } finally {
    await page.close();
  }
});

test('a :matches-path() gate that fails never queries the DOM (B22)', async (t) => {
  if (skip(t)) return;
  const page = await open(
    `<!doctype html><body><div role="main" id="m"><div class="feed">Sponsored</div></div></body>`,
    '/home',
  );
  try {
    const r = await page.evaluate(() => {
      let calls = 0;
      const orig = Document.prototype.querySelectorAll;
      const origEl = Element.prototype.querySelectorAll;
      Document.prototype.querySelectorAll = function (...a) {
        calls++;
        return orig.apply(this, a);
      };
      Element.prototype.querySelectorAll = function (...a) {
        calls++;
        return origEl.apply(this, a);
      };
      const miss = __ss.queryProcedural(':matches-path(/marketplace) div[role="main"] .feed:has-text(Sponsored)');
      const missCalls = calls;
      const notMiss = __ss.queryProcedural(':not(:matches-path(/home)) .feed');
      const hit = __ss.queryProcedural(':matches-path(/home) div[role="main"] .feed:has-text(Sponsored)');
      Document.prototype.querySelectorAll = orig;
      Element.prototype.querySelectorAll = origEl;
      return { miss: miss.length, missCalls, notMiss: notMiss.length, hit: hit.map((e) => e.className) };
    });
    assert.deepEqual(r, { miss: 0, missCalls: 0, notMiss: 0, hit: ['feed'] });
  } finally {
    await page.close();
  }
});

test('style writes do not wake rules that never look at style (B22)', async (t) => {
  if (skip(t)) return;
  const inits = await (async () => {
    const page = await open('<!doctype html><body></body>');
    try {
      return await page.evaluate(() =>
        [
          ['.ad:has-text(Sponsored)'],
          ['div.ad:has-text(1.5)'],
          ['a:has(> [href*="/ad/"]):has-text(x)'],
          [':xpath(//span[(text()="Ad")]/../..)'],
          ['span:upward(div[data-ad])'],
          ['.x:matches-attr(/^on/)'],
        ].map((e) => __ss.proceduralMutationObserverInit(e)),
      );
    } finally {
      await page.close();
    }
  })();
  assert.deepEqual(inits[0].attributeFilter, ['class']);
  assert.equal(inits[0].characterData, true);
  assert.deepEqual(inits[1].attributeFilter, ['class']);
  assert.deepEqual(inits[2].attributeFilter, ['href']);
  assert.equal(inits[3].characterData, true, 'xpath text() tests need text changes');
  assert.deepEqual(inits[4].attributeFilter, ['data-ad']);
  assert.equal(inits[5].attributes, true);
  assert.equal(inits[5].attributeFilter, undefined, 'a regex attribute name watches every attribute');

  const page = await open(`<!doctype html><body><div class="ad" id="a">Sponsored</div><div id="bar"></div></body>`);
  try {
    await runRules(page, [{ expr: '.ad:has-text(Sponsored)' }]);
    const passes = await page.evaluate(async () => {
      let n = 0;
      const orig = window.runner.runPass.bind(window.runner);
      window.runner.runPass = () => {
        n++;
        orig();
      };
      // A progress bar animating its inline style every frame.
      for (let i = 0; i < 30; i++) {
        document.getElementById('bar').style.width = `${i}%`;
        await new Promise((r) => requestAnimationFrame(r));
      }
      return n;
    });
    assert.equal(passes, 0);
  } finally {
    await page.close();
  }
});

test('plain-CSS rules become stylesheet rules and need no observer', async (t) => {
  if (skip(t)) return;
  const page = await open(`<!doctype html><body><div class="x" id="x"><i class="y"></i></div></body>`);
  try {
    await runRules(page, [{ expr: '.x:has(> .y)' }]);
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div class="x" id="x2"><i class="y"></i></div>'));
    // No pass is needed: the stylesheet applies to the new element at once.
    assert.deepEqual(await display(page, '.x'), ['x:none', 'x2:none']);
  } finally {
    await page.close();
  }
});
