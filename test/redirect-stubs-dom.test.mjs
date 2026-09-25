// The redirect stubs against a real DOM (Playwright Chromium), served at the URLs the seed
// redirects, the way the extension serves them: the page asks for the Google library and gets
// the stub instead.
//
// test/redirect-stubs.test.mjs covers the API surface in a vm. What only a browser shows is the
// DOM a page checks: the aswift_ frames an anti-adblock wall looks for inside <ins>, the
// anti-flicker class on <html>, and content revealed from slotRenderEnded.
//
// Skips (does not fail) when Chromium cannot be launched.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://pub.stampstack.test';
const STUBS = {
  'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js': 'adsbygoogle.js',
  'https://www.googletagmanager.com/gtm.js': 'google-analytics.js',
  'https://www.google-analytics.com/analytics.js': 'google-analytics.js',
  'https://www.googletagservices.com/tag/js/gpt.js': 'gpt.js',
};

let browser;
let launchError;

before(async () => {
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

async function open(html) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    const file = STUBS[url.origin + url.pathname];
    if (file) {
      return route.fulfill({
        contentType: 'application/javascript',
        body: readFileSync(join(ROOT, 'src', 'redirects', file), 'utf8'),
      });
    }
    if (url.origin === ORIGIN && url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: html });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  return { context, page, errors };
}

test('adsbygoogle: every ad unit gets its aswift frames and unfilled status', async (t) => {
  if (!browser) return t.skip(`Chromium unavailable: ${launchError?.message ?? 'unknown'}`);
  const html = `<!doctype html><html><head>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1" crossorigin="anonymous"></script>
</head><body>
<ins class="adsbygoogle" style="display:block" data-ad-client="ca-pub-1" data-ad-slot="1"></ins>
<script>(adsbygoogle = window.adsbygoogle || []).push({});</script>
<p>article</p>
<ins class="adsbygoogle" style="display:block" data-ad-client="ca-pub-1" data-ad-slot="2"></ins>
<script>(adsbygoogle = window.adsbygoogle || []).push({});</script>
</body></html>`;
  const { context, page, errors } = await open(html);
  try {
    await page.waitForFunction(() => window.adsbygoogle && window.adsbygoogle.loaded === true);
    const units = await page.evaluate(() =>
      [...document.querySelectorAll('ins.adsbygoogle')].map((ins) => ({
        frame: ins.querySelector(':scope > iframe')?.id,
        inner: ins.querySelector(':scope > iframe > iframe')?.id,
        status: ins.getAttribute('data-adsbygoogle-status'),
        adStatus: ins.getAttribute('data-ad-status'),
        empty: ins.innerHTML.length === 0,
      })),
    );
    assert.deepEqual(units, [
      { frame: 'aswift_0', inner: 'google_ads_frame0', status: 'done', adStatus: 'unfilled', empty: false },
      { frame: 'aswift_1', inner: 'google_ads_frame1', status: 'done', adStatus: 'unfilled', empty: false },
    ]);
    // A unit added after load, the way infinite-scroll pages do.
    const added = await page.evaluate(() => {
      const ins = document.createElement('ins');
      ins.className = 'adsbygoogle';
      document.body.appendChild(ins);
      window.adsbygoogle.push({});
      return ins.querySelector('iframe')?.id;
    });
    assert.equal(added, 'aswift_2');
    const size = await page.evaluate(() => {
      const r = document.getElementById('aswift_0').getBoundingClientRect();
      return [r.width, r.height];
    });
    assert.ok(size[0] <= 1 && size[1] <= 1, `the placeholder frame must stay 1px, got ${size}`);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('gtm.js: the anti-flicker snippet lets the page show at once instead of after its timeout', async (t) => {
  if (!browser) return t.skip(`Chromium unavailable: ${launchError?.message ?? 'unknown'}`);
  // Google Optimize's documented anti-flicker snippet, with a long timeout so only the stub
  // can lift it within the test.
  const html = `<!doctype html><html><head>
<style>.async-hide { opacity: 0 !important }</style>
<script>(function(a,s,y,n,c,h,i,d,e){s.className+=' '+y;h.start=1*new Date;
h.end=i=function(){s.className=s.className.replace(RegExp(' ?'+y),'')};
(a[n]=a[n]||[]).hide=h;setTimeout(function(){i();h.end=null},c);h.timeout=c;
})(window,document.documentElement,'async-hide','dataLayer',60000,{'GTM-XXXX':true});</script>
<script>
  window.dataLayer.push({ event: 'signup', eventCallback: function () { window.navigated = true; } });
</script>
<script async src="https://www.googletagmanager.com/gtm.js?id=GTM-XXXX"></script>
</head><body><p>content</p></body></html>`;
  const { context, page } = await open(html);
  try {
    await page.waitForFunction(() => !document.documentElement.classList.contains('async-hide'), null, {
      timeout: 5000,
    });
    await page.waitForFunction(() => window.navigated === true, null, { timeout: 5000 });
    const opacity = await page.evaluate(() => getComputedStyle(document.documentElement).opacity);
    assert.equal(opacity, '1');
  } finally {
    await context.close();
  }
});

test('gpt.js: content waiting on slotRenderEnded is revealed, and sync snippets run to the end', async (t) => {
  if (!browser) return t.skip(`Chromium unavailable: ${launchError?.message ?? 'unknown'}`);
  const html = `<!doctype html><html><head>
<style>#article { display: none }</style>
<script>window.googletag = window.googletag || { cmd: [] };</script>
<script src="https://www.googletagservices.com/tag/js/gpt.js"></script>
<script>
  googletag.pubads().setForceSafeFrame(true);
  googletag.pubads().set('page_url', location.href);
  googletag.setAdIframeTitle('Advertisement');
  document.documentElement.dataset.ready = '1';
</script>
</head><body>
<div id="div-gpt-ad-6" style="width:300px;height:250px"></div>
<div id="article">article</div>
<script>
  googletag.cmd.push(function () {
    googletag.defineSlot('/6355419/Travel', [300, 250], 'div-gpt-ad-6').addService(googletag.pubads());
    googletag.pubads().collapseEmptyDivs();
    googletag.pubads().addEventListener('slotRenderEnded', function (e) {
      if (e.slot.getSlotElementId() === 'div-gpt-ad-6') document.getElementById('article').style.display = 'block';
    });
    googletag.enableServices();
    googletag.display('div-gpt-ad-6');
  });
</script>
</body></html>`;
  const { context, page, errors } = await open(html);
  try {
    await page.waitForFunction(() => getComputedStyle(document.getElementById('article')).display === 'block', null, {
      timeout: 5000,
    });
    const state = await page.evaluate(() => ({
      ready: document.documentElement.dataset.ready,
      adDisplay: getComputedStyle(document.getElementById('div-gpt-ad-6')).display,
    }));
    assert.equal(state.ready, '1', 'the inline script after a synchronous gpt.js ran to its last line');
    assert.equal(state.adDisplay, 'none', 'collapseEmptyDivs collapses the empty slot');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
