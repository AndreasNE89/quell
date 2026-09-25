// The dynamic dark-mode engine against a real DOM (Playwright Chromium).
//
// dark-mode-dynamic.test.mjs covers the color math; everything REVIEW_2026-09-24 found wrong
// with dark mode (B64–B73, M4) lived in how the engine reads and writes a live page: iframe
// canvases, pseudo-classes, shadow roots, stylesheet loads, the style attribute round trip. Only
// a browser shows those. Each test loads the engine the way the content script does (an IIFE in
// every frame, the registered document_start sheet in the top frame) and checks computed colors
// or screen pixels.
//
// Skips (does not fail) when Chromium cannot be launched.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://stampstack.test';

let engine = '';
let smart = '';
let sheet = '';
let browser;
let launchError;

async function iife(entry, globalName) {
  const out = await build({
    entryPoints: [join(ROOT, entry)],
    bundle: true,
    format: 'iife',
    globalName,
    platform: 'browser',
    target: 'chrome120',
    write: false,
    logLevel: 'silent',
  });
  // Init scripts may be wrapped in a function scope; publish the global explicitly.
  return `${out.outputFiles[0].text}\nglobalThis.${globalName} = ${globalName};`;
}

before(async () => {
  engine = await iife('src/content/dark-mode-dynamic.ts', '__dm');
  smart = await iife('src/content/dark-mode-smart.ts', '__dms');
  sheet = readFileSync(join(ROOT, 'src/content/dark-mode.css'), 'utf8');
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

function skip(t) {
  if (browser) return false;
  t.skip(`Chromium unavailable: ${launchError?.message ?? 'unknown'}`);
  return true;
}

/**
 * Open `html` at https://stampstack.test/ with the engine in every frame. `files` serves more
 * paths on this origin, `pages` full URLs on others; a string is HTML (pages) or CSS (files).
 */
async function open(html, { files = {}, pages = {}, colorScheme, init = '', scripts = engine } = {}) {
  const context = await browser.newContext(colorScheme ? { colorScheme } : {});
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    const other = pages[url.origin + url.pathname];
    if (other !== undefined) {
      return route.fulfill(typeof other === 'string' ? { contentType: 'text/html', body: other } : other);
    }
    if (url.origin !== ORIGIN) return route.fulfill({ status: 404, body: '' });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    const file = files[url.pathname];
    if (file !== undefined) {
      return route.fulfill(typeof file === 'string' ? { contentType: 'text/css', body: file } : file);
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await context.addInitScript({ content: `${init}\n${scripts}` });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  // The registered document_start sheet (top frame only, like allFrames:false).
  await page.addStyleTag({ content: sheet });
  return { context, page };
}

const frames = (target, n = 3) =>
  target.evaluate(
    (n) =>
      new Promise((resolve) => {
        let i = 0;
        const tick = () => (++i >= n ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    n,
  );

/** Turn the engine on in a frame and wait for its first full pass. */
async function start(target, shell = true) {
  await target.evaluate((s) => window.__dm.applyDynamicDark(s), shell);
  await target.waitForFunction(() => document.documentElement.hasAttribute('data-stampstack-ready'));
  await frames(target);
}

const stop = (target) => target.evaluate(() => window.__dm.stopDynamicDark());

function styles(target, selector, props = ['backgroundColor', 'color'], pseudo = null) {
  return target.evaluate(
    ([selector, props, pseudo]) => {
      const cs = getComputedStyle(document.querySelector(selector), pseudo);
      return Object.fromEntries(props.map((p) => [p, cs[p]]));
    },
    [selector, props, pseudo],
  );
}

function rgb(css) {
  const m = /rgba?\(([^)]+)\)/.exec(css);
  assert.ok(m, `not an rgb() color: ${css}`);
  const [r, g, b, a = 1] = m[1].split(',').map(Number);
  return { r, g, b, a };
}

const lum = (css) => {
  const { r, g, b } = rgb(css);
  const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

function assertDark(css, what) {
  assert.ok(lum(css) < 0.05, `${what} should be dark, got ${css}`);
}

function assertLight(css, what) {
  assert.ok(lum(css) > 0.5, `${what} should be light, got ${css}`);
}

/** Readable = light text on a dark surface. */
function assertReadable(s, what) {
  assertDark(s.backgroundColor === 'rgba(0, 0, 0, 0)' ? 'rgb(0, 0, 0)' : s.backgroundColor, `${what} background`);
  assertLight(s.color, `${what} text`);
}

/** One screen pixel, decoded in the page. */
async function pixel(page, x, y) {
  const png = await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3);
  }, png.toString('base64'));
}

/**
 * Retry an assertion until it holds or `timeout` ms pass. The engine works in animation frames
 * and timers; under a loaded test run a fixed wait is either slow or flaky.
 */
async function eventually(check, timeout = 4000) {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      return await check();
    } catch (e) {
      if (Date.now() > end) throw e;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

const rect = (page, selector) =>
  page.evaluate((s) => document.querySelector(s).getBoundingClientRect().toJSON(), selector);

const LIGHT_PAGE = 'body{background:#fff;color:#111;margin:0}';

test('a transparent cross-origin iframe stays transparent over the dark page (B64)', async (t) => {
  if (skip(t)) return;
  const { context, page } = await open(
    `<!doctype html><html><head><style>${LIGHT_PAGE}</style></head><body><p>host</p>
     <iframe id=f style="border:0;width:300px;height:100px" src="https://embed.test/child"></iframe></body></html>`,
    {
      pages: {
        'https://embed.test/child': `<!doctype html><html><head><style>html,body{background:transparent;margin:0}
          p{color:#333;margin:0;padding:10px}</style></head><body><p id=t>embedded text</p></body></html>`,
      },
    },
  );
  try {
    await start(page, true);
    const frame = page.frames().find((f) => f.url().startsWith('https://embed.test/'));
    await start(frame, false);
    const box = await rect(page, '#f');
    // Chromium paints an opaque light canvas behind an embedded root whose color-scheme does not
    // match the <iframe>'s (inherited from the dark top page): it was [255,255,255] here.
    const [r, g, b] = await pixel(page, box.x + 250, box.y + 80);
    assert.ok(r < 60 && g < 60 && b < 60, `iframe backdrop should show the dark page, got ${[r, g, b]}`);
    assertLight((await styles(frame, '#t')).color, 'embedded text');
    assert.equal(
      await frame.evaluate(() => getComputedStyle(document.documentElement).colorScheme),
      'dark',
    );
  } finally {
    await context.close();
  }
});

test('text over a small url() icon or bullet is lightened with its darkened box (B65)', async (t) => {
  if (skip(t)) return;
  const icon = {
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="6" fill="#888"/></svg>',
  };
  const { context, page } = await open(
    `<!doctype html><html><head><style>body{background:#fff;color:#333;margin:0}
      .search{background:#fff url(/icon.svg) no-repeat right center;color:#333;width:300px;height:30px}
      .wrap{background:#fff} li{background:url(/icon.svg) no-repeat 0 8px;color:#333;padding-left:20px}
      .hero{background:url(/icon.svg) center/cover;height:300px;width:600px;color:#222}
    </style></head><body><input class=search id=s value=typed>
    <div class=wrap><ul><li id=li>bullet item</li></ul></div><div class=hero id=hero>hero</div></body></html>`,
    { files: { '/icon.svg': icon } },
  );
  try {
    await start(page);
    assertReadable(await styles(page, '#s'), 'search input');
    assertLight((await styles(page, '#li')).color, 'bullet item text');
    // A covering image is still a backdrop we refuse to darken: its text keeps the site's color.
    assert.equal((await styles(page, '#hero')).color, 'rgb(34, 34, 34)');
  } finally {
    await context.close();
  }
});

test('stylesheets that load late, swap or get inserted are re-evaluated (B66)', async (t) => {
  if (skip(t)) return;
  const { context, page } = await open(
    `<!doctype html><html><head><style>${LIGHT_PAGE}</style><link id=theme rel=stylesheet href="/dark.css">
     </head><body><div id=box>box</div><div class=tb id=tb>themed</div><div id=ins>inserted</div></body></html>`,
    {
      files: {
        '/late.css': '#box{background:#fafafa}',
        '/dark.css': '.tb{background:#111;color:#eee}',
        '/light.css': '.tb{background:#fff;color:#111}',
      },
    },
  );
  try {
    await start(page);
    // loadCSS / WP Rocket: media=print, flipped to all on load.
    await page.evaluate(() => {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = '/late.css';
      l.media = 'print';
      l.onload = () => {
        l.media = 'all';
      };
      document.head.appendChild(l);
    });
    const applied = (file, media = 'all') =>
      page.waitForFunction(
        ([file, media]) =>
          [...document.styleSheets].some((s) => s.href?.endsWith(file) && s.media.mediaText !== 'print' && (media === 'all' || s.media.mediaText === media)),
        [file, media],
      );
    await applied('/late.css');
    await eventually(async () => assertReadable(await styles(page, '#box'), 'box styled by a late sheet'));

    await page.evaluate(() => {
      document.getElementById('theme').href = '/light.css';
    });
    await applied('/light.css');
    await eventually(async () => assertReadable(await styles(page, '#tb'), 'panel after a theme <link> swap'));

    await page.evaluate(() => {
      const s = document.createElement('style');
      s.textContent = '#ins{background:#fff;color:#222}';
      document.head.appendChild(s);
    });
    await eventually(async () => assertReadable(await styles(page, '#ins'), 'box styled by an inserted <style>'));
  } finally {
    await context.close();
  }
});

test('a loadCSS sheet is re-read once Chromium swaps it in, on a slow machine too (B66)', async (t) => {
  if (skip(t)) return;
  // Chromium applies a <link>'s new media a few ms after the attribute changes, as a new sheet,
  // with no second load event. On a loaded or slow CPU the re-read ran before the swap.
  const { context, page } = await open(
    `<!doctype html><html><head><style>${LIGHT_PAGE}</style></head><body><div id=box>box</div></body></html>`,
    { files: { '/late.css': '#box{background:#fafafa;color:#222}' } },
  );
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 10 });
    await start(page);
    await page.evaluate(() => {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = '/late.css';
      l.media = 'print';
      l.onload = () => {
        l.media = 'all';
      };
      document.head.appendChild(l);
    });
    await page.waitForFunction(() => getComputedStyle(document.getElementById('box')).backgroundColor !== 'rgba(0, 0, 0, 0)');
    await eventually(async () => assertReadable(await styles(page, '#box'), 'box styled by a sheet swapped in late'), 8000);
  } finally {
    await context.close();
  }
});

test("a component's added <style> re-walks what it matches, not the whole page (B66)", async (t) => {
  if (skip(t)) return;
  const init = `window.__reads = 0; const __gcs = window.getComputedStyle;
    window.getComputedStyle = function (...a) { window.__reads++; return __gcs.apply(this, a); };`;
  const { context, page } = await open(
    `<!doctype html><html><head><style>${LIGHT_PAGE}</style></head><body>
     ${'<div class=row><span>row</span><a>link</a></div>'.repeat(2000)}<app-card id=card>card</app-card></body></html>`,
    { init },
  );
  try {
    await start(page);
    await page.waitForTimeout(300);
    const reads = await page.evaluate(async () => {
      window.__reads = 0;
      const s = document.createElement('style');
      s.textContent = 'app-card{display:block;background:#fff;color:#222} app-card::after{content:"!"}';
      document.head.appendChild(s);
      await new Promise((r) => setTimeout(r, 400));
      return window.__reads;
    });
    assertReadable(await styles(page, '#card'), 'component styled by its added <style>');
    assert.ok(reads < 100, `expected a targeted re-walk, got ${reads} getComputedStyle calls`);
  } finally {
    await context.close();
  }
});

test('theme switches without a class flip are followed: OS scheme, html[dark], Mantine, MkDocs (B67)', async (t) => {
  if (skip(t)) return;
  const { context, page } = await open(
    `<!doctype html><html dark data-mantine-color-scheme=dark><head><style>${LIGHT_PAGE}
      @media (prefers-color-scheme: dark) { #a { background:#222; color:#eee } }
      @media (prefers-color-scheme: light) { #a { background:#f0f0f0; color:#111 } }
      html[dark] #b { background:#222; color:#eee } html:not([dark]) #b { background:#fff; color:#111 }
      html[data-mantine-color-scheme=dark] #c { background:#222; color:#eee }
      html[data-mantine-color-scheme=light] #c { background:#fff; color:#111 }
      body[data-md-color-scheme=slate] #d { background:#222; color:#eee }
      body[data-md-color-scheme=default] #d { background:#fff; color:#111 }
      [data-theme=dark] #e { background:#222; color:#eee } [data-theme=light] #e { background:#fff; color:#111 }
    </style></head><body data-md-color-scheme=slate><div id=a>A</div><div id=b>B</div><div id=c>C</div>
    <div id=d>D</div><main data-theme=dark><div id=e>E</div></main></body></html>`,
    { colorScheme: 'dark' },
  );
  try {
    await start(page);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.evaluate(() => {
      document.documentElement.removeAttribute('dark');
      document.documentElement.setAttribute('data-mantine-color-scheme', 'light');
      document.body.setAttribute('data-md-color-scheme', 'default');
      document.querySelector('main').setAttribute('data-theme', 'light');
    });
    await eventually(async () => {
      for (const id of ['a', 'b', 'c', 'd', 'e']) assertReadable(await styles(page, `#${id}`), `#${id}`);
    });
  } finally {
    await context.close();
  }
});

test("a site's custom-property write on an element we recolored is not taken for ours (B68)", async (t) => {
  if (skip(t)) return;
  const { context, page } = await open(
    `<!doctype html><html><head><style>body{--card-bg:#222;background:#fff;color:#111}
     .card{background:var(--card-bg);color:#111;padding:8px}</style></head>
     <body><div class=card id=card>card</div></body></html>`,
  );
  try {
    await start(page);
    // body carries our overrides; its style attribute changes for the site's reason.
    await page.evaluate(() => document.body.style.setProperty('--card-bg', '#fff'));
    await eventually(async () => assertReadable(await styles(page, '#card'), 'card after the theme variable flipped'));
  } finally {
    await context.close();
  }
});

test(':hover and :focus-within light backgrounds are recolored, transitions included (B69)', async (t) => {
  if (skip(t)) return;
  const { context, page } = await open(
    `<!doctype html><html><head><style>body{background:#fff;color:#333;margin:0}
      .menu a{display:block;color:#333;padding:10px;width:200px;transition:background-color .2s}
      .menu a:hover{background:#eee} .f{color:#333;padding:4px} .f:focus-within{background:#fffbe0}
      .p{color:#333;transition:background-color .3s,color .3s} .p.on{background:#eee}
    </style></head><body><nav class=menu><a id=m href=#>Menu item</a></nav>
    <div class=f id=fw><input id=i></div><div class=p id=p>panel</div></body></html>`,
  );
  try {
    await start(page);
    await page.hover('#m');
    // Past the 0.2 s transition, so the end state is what is judged.
    await page.waitForTimeout(300);
    await eventually(async () => assertReadable(await styles(page, '#m'), 'hovered menu item'));
    await page.mouse.move(600, 500);
    await eventually(async () =>
      assert.equal((await styles(page, '#m')).backgroundColor, 'rgba(0, 0, 0, 0)', 'hover state dropped'),
    );

    await page.focus('#i');
    await eventually(async () => assertReadable(await styles(page, '#fw'), 'focus-within container'));

    // A class flip read mid-transition used to plan from the first frame and leave the end state
    // light (text dark again, too).
    await page.evaluate(() => document.getElementById('p').classList.add('on'));
    await page.waitForTimeout(400);
    await eventually(async () => assertReadable(await styles(page, '#p'), 'panel after a transitioned class flip'));
  } finally {
    await context.close();
  }
});

test('shadow roots are darkened when added, rendered late or upgraded late (B70)', async (t) => {
  if (skip(t)) return;
  const { context, page } = await open(
    `<!doctype html><html><head><style>${LIGHT_PAGE}</style><script>
      const card = '<style>.c{background:#fff;color:#222;padding:8px}</style><div class=c>card</div>';
      customElements.define('x-card', class extends HTMLElement {
        constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = card; } });
      customElements.define('x-lit', class extends HTMLElement {
        constructor() { super(); this.attachShadow({ mode: 'open' }); }
        connectedCallback() { setTimeout(() => { this.shadowRoot.innerHTML = card; }, 50); } });
      window.card = card;
    </script></head><body><x-card id=first></x-card><hn-panel id=late></hn-panel></body></html>`,
  );
  try {
    await start(page);
    await page.evaluate(() => {
      for (const [tag, id] of [['x-card', 'added'], ['x-lit', 'lit']]) {
        const el = document.createElement(tag);
        el.id = id;
        document.body.appendChild(el);
      }
    });
    await page.waitForTimeout(300);
    // helsenorge-style: the definition arrives after the page, and upgrading attaches the root.
    await page.evaluate(() =>
      customElements.define('hn-panel', class extends HTMLElement {
        constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = window.card; }
      }),
    );
    await eventually(async () => {
      for (const id of ['first', 'added', 'lit', 'late']) {
        const s = await page.evaluate((id) => {
          const cs = getComputedStyle(document.getElementById(id).shadowRoot.querySelector('.c'));
          return { backgroundColor: cs.backgroundColor, color: cs.color };
        }, id);
        assertReadable(s, `<${id}> shadow content`);
      }
    });
  } finally {
    await context.close();
  }
});

test("turning dark mode off restores the site's exact style attribute (B71)", async (t) => {
  if (skip(t)) return;
  const { context, page } = await open(
    `<!doctype html><html><head><style>body{background:#fff;color:#111;--bg:#eee;--c:#ccc}</style></head><body>
     <div id=v style="background: var(--bg) url(x.png) no-repeat; color:#222">v</div>
     <div id=w style="border: 2px solid var(--c)">w</div><div id=n>no attribute</div></body></html>`,
  );
  const snapshot = () =>
    page.evaluate(() =>
      ['v', 'w', 'n'].map((id) => {
        const el = document.getElementById(id);
        const cs = getComputedStyle(el);
        return [el.getAttribute('style'), cs.backgroundColor, cs.borderTopColor, cs.color];
      }),
    );
  try {
    const before = await snapshot();
    await start(page);
    assert.notDeepEqual(await snapshot(), before, 'the engine recolored something');
    await stop(page);
    assert.deepEqual(await snapshot(), before);
  } finally {
    await context.close();
  }
});

test('per-frame numeric custom-property writes cause no re-reads (B72)', async (t) => {
  if (skip(t)) return;
  const init = `window.__reads = 0; const __gcs = window.getComputedStyle;
    window.getComputedStyle = function (...a) { window.__reads++; return __gcs.apply(this, a); };`;
  const { context, page } = await open(
    `<!doctype html><html><head><style>${LIGHT_PAGE}</style></head><body><div id=list>
     ${'<div class=row><span>row</span><a>link</a></div>'.repeat(2000)}</div></body></html>`,
    { init },
  );
  try {
    await start(page);
    await page.waitForTimeout(300);
    const reads = await page.evaluate(async () => {
      window.__reads = 0;
      for (let i = 0; i < 20; i++) {
        document.documentElement.style.setProperty('--scroll-y', String(i * 10));
        document.getElementById('list').style.setProperty('--y', `${i}px`);
        document.getElementById('list').style.transform = `translateY(${i}px)`;
        await new Promise((r) => requestAnimationFrame(r));
      }
      await new Promise((r) => setTimeout(r, 400));
      return window.__reads;
    });
    // HEAD re-walked the whole subtree on every one of these writes (~59k reads here).
    assert.ok(reads < 50, `expected no subtree re-walks, got ${reads} getComputedStyle calls`);

    // A write that can be a color still re-walks.
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--row-bg', '#fff');
      document.head.insertAdjacentHTML('beforeend', '<style>.row{background:var(--row-bg)}</style>');
    });
    await eventually(async () => assertDark((await styles(page, '.row')).backgroundColor, 'row painted from a color variable'));
  } finally {
    await context.close();
  }
});

test('pseudo-elements, -webkit-text-fill-color and <hr> are remapped, and restored (B73)', async (t) => {
  if (skip(t)) return;
  const { context, page } = await open(
    `<!doctype html><html><head><style>${LIGHT_PAGE}
      .fade{position:relative;height:60px} .fade::after{content:'';position:absolute;inset:0;
        background:linear-gradient(rgba(255,255,255,0),#fff)}
      .ico::before{content:'*';color:#333} .tf{color:#222} .tf span{-webkit-text-fill-color:#333}
      hr{border:0;border-top:1px solid #e5e5e5}
      .tip::before{content:'';border:8px solid transparent;border-bottom-color:#fff}
      .child::before{content:'c';background:#fafafa}
    </style></head><body><div class=fade id=fade><span class=child id=child>x</span></div>
    <span class=ico id=ico>icon</span><p class=tf><span id=tf>fill</span></p><hr id=hr>
    <div class=tip id=tip>t</div></body></html>`,
  );
  const read = async () => ({
    fade: (await styles(page, '#fade', ['backgroundImage'], '::after')).backgroundImage,
    ico: (await styles(page, '#ico', ['color'], '::before')).color,
    tf: (await styles(page, '#tf', ['webkitTextFillColor'])).webkitTextFillColor,
    hr: (await styles(page, '#hr', ['borderTopColor'])).borderTopColor,
    tip: await styles(page, '#tip', ['borderBottomColor', 'borderTopColor'], '::before'),
    child: (await styles(page, '#child', ['backgroundColor'], '::before')).backgroundColor,
  });
  try {
    const before = await read();
    await start(page);
    const dark = await read();
    assert.doesNotMatch(dark.fade, /rgb\(255, 255, 255\)/, 'white fade stop darkened');
    assertLight(dark.ico, 'icon glyph');
    assertLight(dark.tf, 'text fill');
    assert.ok(lum(dark.hr) < 0.1, `hr rule dimmed, got ${dark.hr}`);
    assert.ok(lum(dark.tip.borderBottomColor) < 0.1, 'tooltip arrow darkened');
    assert.equal(dark.tip.borderTopColor, 'rgba(0, 0, 0, 0)', 'transparent triangle sides stay transparent');
    // The fade's overrides are its own: a child's ::before is judged by itself.
    assertDark(dark.child, "child's own ::before");
    await stop(page);
    assert.deepEqual(await read(), before);
  } finally {
    await context.close();
  }
});

test('dark-ink images are inverted; colored and unreadable ones are left alone (M4)', async (t) => {
  if (skip(t)) return;
  const svg = (fill) => ({
    contentType: 'image/svg+xml',
    body: `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect x="10" y="10" width="100" height="20" fill="${fill}"/></svg>`,
  });
  const { context, page } = await open(
    `<!doctype html><html><head><style>body{background:#fff;color:#202122;margin:0} img{display:block}</style></head><body>
      <img id=ink src="/ink.svg" width=120 height=40><img id=color src="/color.svg" width=120 height=40>
      <img id=math class=mwe-math-fallback-image-inline src="https://wikimedia.test/media/math/render/svg/1" width=120 height=40>
      <img id=xo src="https://cdn.test/logo.svg" width=120 height=40>
      <img id=lazy width=120 height=40></body></html>`,
    {
      files: { '/ink.svg': svg('#000'), '/color.svg': svg('#e33'), '/lazy.svg': svg('#111') },
      pages: { 'https://wikimedia.test/media/math/render/svg/1': svg('#000'), 'https://cdn.test/logo.svg': svg('#000') },
    },
  );
  const ink = async (id) => {
    const r = await rect(page, `#${id}`);
    return pixel(page, r.x + 60, r.y + 20);
  };
  try {
    await start(page);
    await page.evaluate(() => {
      document.getElementById('lazy').src = '/lazy.svg';
    });
    await eventually(async () => {
      for (const id of ['ink', 'math', 'lazy']) {
        const [r, g, b] = await ink(id);
        assert.ok(r > 200 && g > 200 && b > 200, `#${id} ink should now be light, got ${[r, g, b]}`);
      }
    });
    assert.deepEqual(await ink('color'), [238, 51, 51], 'colored artwork untouched');
    // Cross-origin without CORS: its pixels cannot be read, so it is not guessed at.
    assert.equal((await styles(page, '#xo', ['filter'])).filter, 'none');
    await stop(page);
    assert.equal((await styles(page, '#ink', ['filter'])).filter, 'none');
  } finally {
    await context.close();
  }
});

test('a natively dark page keeps its canvas and accents; only light islands darken (P3)', async (t) => {
  if (skip(t)) return;
  const { context, page } = await open(
    `<!doctype html><html style="background:#000"><head><style>body{background:#0d1117;color:#e6edf3;margin:0}
      .btn{background:#238636;color:#fff} .badge{background:#1f6feb;color:#fff} .warn{background:#d29922;color:#000}
      .cta{background:#fff;color:#000;width:150px;height:40px}
      .panel{background:#fff;color:#111;width:600px;height:300px} .inner{background:#f6f8fa;color:#222}
    </style></head><body><span class=btn id=btn>Merge</span><span class=badge id=badge>New</span>
    <span class=warn id=warn>Warning</span><div class=cta id=cta>Sign up</div>
    <div class=panel id=panel>embedded light panel<div class=inner id=inner>inner</div></div></body></html>`,
  );
  try {
    await start(page);
    assert.deepEqual(await styles(page, '#btn'), { backgroundColor: 'rgb(35, 134, 54)', color: 'rgb(255, 255, 255)' });
    assert.deepEqual(await styles(page, '#badge'), { backgroundColor: 'rgb(31, 111, 235)', color: 'rgb(255, 255, 255)' });
    assert.deepEqual(await styles(page, '#warn'), { backgroundColor: 'rgb(210, 153, 34)', color: 'rgb(0, 0, 0)' });
    assert.deepEqual(await styles(page, '#cta'), { backgroundColor: 'rgb(255, 255, 255)', color: 'rgb(0, 0, 0)' });
    assertReadable(await styles(page, '#panel'), 'large light panel');
    assertReadable(await styles(page, '#inner'), 'card inside the light panel');
    // The registered sheet's !important #1c1c1e no longer replaces the site's own canvas.
    assert.equal((await styles(page, 'html', ['backgroundColor'])).backgroundColor, 'rgb(0, 0, 0)');
    assert.equal((await styles(page, 'html', ['colorScheme'])).colorScheme, 'dark');
  } finally {
    await context.close();
  }
});

test('explicit dark fills inside inline SVG icons are lifted; artwork and masks are not (P3)', async (t) => {
  if (skip(t)) return;
  const { context, page } = await open(
    `<!doctype html><html><head><style>${LIGHT_PAGE}</style></head><body>
      <svg id=icon width=40 height=40><path id=path fill="#212121" d="M0 0h40v40H0z"/></svg>
      <svg width=40 height=40><rect fill="#fff" width=40 height=40 /><path id=art fill="#212121" d="M10 10h20v20H10z"/></svg>
      <svg width=40 height=40><mask id=m><rect id=mask fill="#000" width=40 height=40/></mask>
        <path fill="#e33" mask="url(#m)" d="M0 0h40v40H0z"/></svg></body></html>`,
  );
  try {
    await start(page);
    const [r, g, b] = await pixel(page, 20, 20);
    assert.ok(r > 180 && g > 180 && b > 180, `icon should be visible on the dark page, got ${[r, g, b]}`);
    assert.equal((await styles(page, '#art', ['fill'])).fill, 'rgb(33, 33, 33)', 'drawing with its own light surface');
    assert.equal((await styles(page, '#mask', ['fill'])).fill, 'rgb(0, 0, 0)', 'mask content');
    await stop(page);
    assert.equal(await page.evaluate(() => document.getElementById('path').getAttribute('style')), null);
  } finally {
    await context.close();
  }
});

test('a hidden tab darkens the whole page per timer wake-up (P3)', async (t) => {
  if (skip(t)) return;
  // The engine reads document.hidden; a headless page is always visible.
  const init = `Object.defineProperty(Document.prototype, 'hidden', { get() { return window.__hidden === true; }, configurable: true });`;
  const { context, page } = await open(
    `<!doctype html><html><head><style>${LIGHT_PAGE} p{background:#fafafa}</style></head><body>${'<p>x</p>'.repeat(6000)}</body></html>`,
    { init },
  );
  try {
    await page.evaluate(() => {
      window.__hidden = true;
      window.__dm.applyDynamicDark(true);
    });
    // Chrome wakes a hidden tab's timers about once a second; 1,200 elements per wake-up left
    // most of a long page white when the user switched to it.
    await page.waitForTimeout(450);
    const light = await page.evaluate(
      () => [...document.querySelectorAll('p')].filter((p) => getComputedStyle(p).backgroundColor === 'rgb(250, 250, 250)').length,
    );
    assert.equal(light, 0);
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-stampstack-ready')), true);
  } finally {
    await context.close();
  }
});

test('the scrim timer lifts after a failed pass, but waits while the tab is hidden (P3)', async (t) => {
  if (skip(t)) return;
  // A pass that throws midway never reports ready; only the timer can lift the scrim.
  const init = `Object.defineProperty(Document.prototype, 'hidden', { get() { return window.__hidden === true; }, configurable: true });
    CSSStyleDeclaration.prototype.setProperty = function () { throw new Error('boom'); };`;
  const { context, page } = await open(
    `<!doctype html><html><head><style>${LIGHT_PAGE}</style></head><body><p>x</p></body></html>`,
    { init },
  );
  const ready = () => page.evaluate(() => document.documentElement.hasAttribute('data-stampstack-ready'));
  try {
    await page.evaluate(() => {
      window.__hidden = true;
      window.__dm.applyDynamicDark(true);
    });
    await page.waitForTimeout(2200);
    // Lifting on schedule in a background tab let an unfinished page flash white when shown.
    assert.equal(await ready(), false, 'scrim kept while hidden and unfinished');
    await page.evaluate(() => {
      window.__hidden = false;
    });
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-stampstack-ready'), null, {
      timeout: 3000,
    });
  } finally {
    await context.close();
  }
});

test('an about:blank frame rewritten with document.open() is darkened', async (t) => {
  if (skip(t)) return;
  const { context, page } = await open(
    `<!doctype html><html><head><style>${LIGHT_PAGE}</style></head><body><iframe id=f></iframe></body></html>`,
  );
  try {
    await start(page);
    await page.frames()[1].evaluate(() => window.__dm.applyDynamicDark(false));
    await page.evaluate(() => {
      const d = document.getElementById('f').contentDocument;
      d.open();
      d.write('<!doctype html><html><body><div id=w style="background:#fff;color:#222">written</div></body></html>');
      d.close();
    });
    await eventually(async () => {
      const s = await page.evaluate(() => {
        const d = document.getElementById('f').contentDocument;
        const cs = d.defaultView.getComputedStyle(d.getElementById('w'));
        return { backgroundColor: cs.backgroundColor, color: cs.color };
      });
      assertReadable(s, 'written frame content');
    });
  } finally {
    await context.close();
  }
});

const EDITOR_CONTENT = '<p>First paragraph</p><p>Second <strong>bold</strong> text</p><ul><li>item</li></ul>';
const editorPage = (css, bodyAttrs = '') =>
  `<!doctype html><html><head><style>${css}</style></head><body${bodyAttrs}>${EDITOR_CONTENT}</body></html>`;

/** What an editor frame could serialize, and anything of ours left on it. */
const editorSnapshot = (frame) =>
  frame.evaluate(() => ({
    body: document.body.innerHTML,
    bodyAttrs: [...document.body.attributes].map((a) => `${a.name}=${a.value}`),
    htmlAttrs: [...document.documentElement.attributes].map((a) => a.name),
    shell: document.querySelector('style[data-stampstack]') != null,
  }));

const frameById = async (page, id) => (await page.$(`#${id}`)).contentFrame();

test('an iframe editor is never written into and stays a readable light box', async (t) => {
  if (skip(t)) return;
  const tiny = editorPage('body{font:16px sans-serif;margin:8px}', ' contenteditable="true"');
  const cke = editorPage('body{color:#333;background:#fff;margin:8px}');
  const { context, page } = await open(
    `<!doctype html><html><head><style>${LIGHT_PAGE} .wrap{background:#f5f5f5;padding:10px}
      iframe{display:block;border:0;width:500px;height:120px;background:#fff}</style></head><body>
      <div class=wrap id=wrap><iframe id=tiny></iframe><iframe id=cke></iframe><iframe id=later></iframe></div><script>
      const write = (id, html) => { const d = document.getElementById(id).contentDocument; d.open(); d.write(html); d.close(); return d; };
      // TinyMCE: colorless content in a contenteditable body. CKEditor 4 on older engines: designMode.
      write('tiny', ${JSON.stringify(tiny)});
      write('cke', ${JSON.stringify(cke)}).designMode = 'on';
    </script></body></html>`,
  );
  try {
    await start(page);
    for (const id of ['tiny', 'cke']) {
      const frame = await frameById(page, id);
      const before = await editorSnapshot(frame);
      await frame.evaluate(() => window.__dm.applyDynamicDark(false));
      await frames(frame, 4);
      await page.waitForTimeout(200);
      // The editor saves body.innerHTML: every p, strong and li carried color: rgb(227, 227, 227).
      assert.deepEqual(await editorSnapshot(frame), before, `${id}: nothing written into the editor`);
    }
    assertDark((await styles(page, '#wrap')).backgroundColor, 'the page around the editors');
    // With color-scheme: dark in the frame, Chromium painted no canvas behind it and TinyMCE's
    // default text turned white on the white <iframe>.
    const frame = await frameById(page, 'tiny');
    assert.equal((await styles(frame, 'p', ['color'])).color, 'rgb(0, 0, 0)', 'editor text on its light canvas');
    const box = await rect(page, '#tiny');
    const [r, g, b] = await pixel(page, box.x + 480, box.y + 110);
    assert.ok(r > 200 && g > 200 && b > 200, `editor canvas stays light, got ${[r, g, b]}`);

    // An editor written into a frame the engine already runs in: the write itself brings it.
    await start(await frameById(page, 'later'), false);
    const written = await page.evaluate(async (html) => {
      const d = document.getElementById('later').contentDocument;
      d.open();
      d.write(html);
      d.close();
      await Promise.resolve();
      return { shell: d.querySelector('style[data-stampstack]') != null, htmlAttrs: d.documentElement.getAttributeNames() };
    }, tiny);
    assert.deepEqual(written, { shell: false, htmlAttrs: [] }, 'nothing written into the new editor document');
    await frames(page, 4);
    assert.equal(await page.evaluate(() => document.getElementById('later').contentDocument.body.innerHTML), EDITOR_CONTENT);
  } finally {
    await context.close();
  }
});

test('a contenteditable region keeps its markup while the page around it is darkened', async (t) => {
  if (skip(t)) return;
  const { context, page } = await open(
    `<!doctype html><html><head><style>${LIGHT_PAGE} .box{background:#fafafa;color:#222;padding:8px}
      .ed{border:1px solid #ccc;color:#222;padding:8px} .ed p{color:#333} .ed li::before{content:'-';color:#444}
      .chip{background:#e8f0fe;color:#1a0dab}</style></head><body><div class=box id=box>outside
      <div class=ed id=ed contenteditable=true><p>First <strong>bold</strong></p><ul><li>item</li></ul>
      <p><span class=chip contenteditable=false>@bob</span> <svg width=16 height=16><path fill="#212121" d="M0 0h16v16H0z"/></svg></p></div></div>
    </body></html>`,
  );
  try {
    const before = await page.evaluate(() => document.getElementById('ed').outerHTML);
    await start(page);
    assertReadable(await styles(page, '#box'), 'content outside the editor');
    // The host, its paragraphs, the pseudo-element custom properties, the SVG fill and the
    // contenteditable=false chip (saved with the post all the same) were all written into.
    assert.equal(await page.evaluate(() => document.getElementById('ed').outerHTML), before);
  } finally {
    await context.close();
  }
});

test('an editor switched on after the pass has our colors taken back out before it reads them', async (t) => {
  if (skip(t)) return;
  const content = '<p>Initial <b>content</b></p><p class="muted">more</p>';
  const plain = editorPage('body{background:#fff;color:#222}');
  const { context, page } = await open(
    `<!doctype html><html><head><style>${LIGHT_PAGE} #late{background:#fafafa} #late p{color:#333}
      .muted{background:#f0f0f0}</style></head><body><div id=late>${content}</div>
      <iframe id=f></iframe><iframe id=g></iframe></body></html>`,
  );
  const late = () =>
    page.evaluate(() => {
      const el = document.getElementById('late');
      return [el.innerHTML, el.getAttribute('style')];
    });
  try {
    await start(page);
    assert.notEqual((await late())[0], content, 'recolored while it was plain content');
    // CKEditor 5 and TinyMCE inline take over an element already on the page.
    const onSwitch = await page.evaluate(async () => {
      const el = document.getElementById('late');
      el.setAttribute('contenteditable', 'true');
      await Promise.resolve();
      return [el.innerHTML, el.getAttribute('style')];
    });
    assert.deepEqual(onSwitch, [content, null]);
    // Switched to read-only it still holds, and saves, the same content.
    await page.evaluate(() => document.getElementById('late').setAttribute('contenteditable', 'false'));
    await frames(page, 4);
    await page.waitForTimeout(300);
    assert.deepEqual(await late(), [content, null]);

    // TinyMCE writes its frame, then makes the body editable; older editors turn on designMode.
    for (const id of ['f', 'g']) {
      await page.evaluate(
        ([id, html]) => {
          const d = document.getElementById(id).contentDocument;
          d.open();
          d.write(html);
          d.close();
        },
        [id, plain],
      );
    }
    const f = await frameById(page, 'f');
    const g = await frameById(page, 'g');
    const clean = await editorSnapshot(f);
    for (const frame of [f, g]) {
      await start(frame, false);
      assert.notDeepEqual(await editorSnapshot(frame), clean, 'plain frame content is recolored');
    }
    const switched = await f.evaluate(async () => {
      document.body.contentEditable = 'true';
      await Promise.resolve();
      return document.body.innerHTML;
    });
    assert.equal(switched, EDITOR_CONTENT);
    assert.deepEqual(await editorSnapshot(f), { ...clean, bodyAttrs: ['contenteditable=true'] });

    // designMode changes no attribute: the first pointer move or edit in the frame finds it.
    await g.evaluate(() => {
      document.designMode = 'on';
    });
    const box = await rect(page, '#g');
    await page.mouse.move(box.x + 20, box.y + 20);
    await eventually(async () => assert.deepEqual(await editorSnapshot(g), clean));
  } finally {
    await context.close();
  }
});

/** WCAG contrast of two computed colors. */
const contrast = (fg, bg) => {
  const [a, b] = [lum(fg), lum(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

test('an editor in a page we darken is a readable light box, with nothing written into it', async (t) => {
  if (skip(t)) return;
  // VisualEditor: a transparent host whose template boxes bring their own light surface and whose
  // text is inherited. A white editor pane of its own. A plain block that becomes an editor later.
  const { context, page } = await open(
    `<!doctype html><html><head><style>${LIGHT_PAGE} .page{background:#fff;color:#202122;padding:8px}
      .note{background:#fbfbfb;border:1px solid #a2a9b1;padding:4px} .kw{color:#708} .pane{background:#fff;padding:4px}
      </style></head><body><div class=page id=page>outside
      <div id=surface><div id=ve contenteditable=true><p id=para>Plain paragraph</p><div class=note id=note>Template box</div><p><span class=kw id=kw>function</span></p></div></div>
      <div><div class=pane id=pane contenteditable=true><p id=panep>White pane</p></div></div>
      <div id=later><p id=laterp>Becomes an editor</p></div></div></body></html>`,
  );
  const markup = () =>
    page.evaluate(() => ['ve', 'pane'].map((id) => document.getElementById(id).outerHTML));
  const readable = async (text, surface, what) => {
    const fg = (await styles(page, text, ['color'])).color;
    const bg = (await styles(page, surface, ['backgroundColor'])).backgroundColor;
    assertLight(bg, `${what} surface`);
    assert.ok(contrast(fg, bg) >= 4.5, `${what}: ${fg} on ${bg}`);
  };
  try {
    const before = await markup();
    const late = await page.evaluate(() => document.getElementById('later').innerHTML);
    await start(page);
    assertReadable(await styles(page, '#page'), 'the page around the editors');
    assert.deepEqual(await markup(), before, 'nothing written into the editors');
    // Our lightened text used to reach the editor through the host: white on the template box,
    // and the site's own dark text sat on the charcoal page.
    await readable('#para', '#ve', 'inherited editor text');
    await readable('#note', '#note', 'text on the editor’s own light box');
    await readable('#kw', '#ve', 'the site’s own dark ink in the editor');
    await readable('#panep', '#pane', 'a white editor pane');

    await page.evaluate(() => document.getElementById('later').setAttribute('contenteditable', 'true'));
    await eventually(() => readable('#laterp', '#later', 'an editor switched on after the pass'));
    // Switched to read-only it still holds, and saves, the same content: the box stays.
    await page.evaluate(() => document.getElementById('later').setAttribute('contenteditable', 'false'));
    await frames(page, 4);
    await page.waitForTimeout(200);
    await readable('#laterp', '#later', 'an editor switched to read-only');
    assert.equal(await page.evaluate(() => document.getElementById('later').innerHTML), late);
  } finally {
    await context.close();
  }
});

test('an editor straight on the page canvas gets its light box too', async (t) => {
  if (skip(t)) return;
  // No background anywhere: the surface under the editor is the canvas we paint charcoal.
  const { context, page } = await open(
    `<!doctype html><html><head><style>body{color:#222;margin:0} .note{background:#f8f9fa}</style></head><body>
      <div id=ed contenteditable=true><p id=p>On the canvas</p><div class=note id=note>Boxed</div></div></body></html>`,
  );
  try {
    await start(page);
    const ed = await styles(page, '#ed');
    assertLight(ed.backgroundColor, 'editor surface');
    const text = (await styles(page, '#p', ['color'])).color;
    assert.ok(contrast(text, ed.backgroundColor) >= 4.5, `editor text: ${text} on ${ed.backgroundColor}`);
    const note = await styles(page, '#note');
    assert.ok(contrast(note.color, note.backgroundColor) >= 4.5, `boxed text: ${note.color} on ${note.backgroundColor}`);
  } finally {
    await context.close();
  }
});

test('an editor on a surface the site made dark itself gets no light box', async (t) => {
  if (skip(t)) return;
  const { context, page } = await open(
    `<!doctype html><html><head><style>body{background:#111;color:#ddd;margin:0} .kw{color:#c792ea}
      </style></head><body><div id=wrap><div id=ed contenteditable=true><p id=p>Dark site text <span class=kw>kw</span></p></div></div>
    </body></html>`,
  );
  try {
    await start(page);
    assert.deepEqual(await styles(page, '#ed'), { backgroundColor: 'rgba(0, 0, 0, 0)', color: 'rgb(221, 221, 221)' });
    assert.equal(await page.evaluate(() => document.getElementById('wrap').getAttribute('style')), null);
  } finally {
    await context.close();
  }
});

test('about:blank frames run dark mode and ask for their creator page (B25)', async (t) => {
  if (skip(t)) return;
  const stub = `window.__asked = [];
    Object.defineProperty(window, 'chrome', { configurable: true, value: { runtime: {
      sendMessage: async (m) => { window.__asked.push(m); return { paid: true, apply: true }; },
      onMessage: { addListener() {}, removeListener() {} } } } });`;
  const { context, page } = await open(
    `<!doctype html><html><head><style>${LIGHT_PAGE}</style></head><body><iframe id=f></iframe></body></html>`,
    { init: stub, scripts: `${engine}\n${smart}` },
  );
  try {
    const frame = page.frames()[1];
    await frame.evaluate(() => {
      document.body.innerHTML = '<p id=p style="color:#222">frame text</p>';
      window.__dms.startDarkModeSmart();
    });
    await frame.waitForFunction(() => document.documentElement.hasAttribute('data-stampstack-ready'));
    const asked = await frame.evaluate(() => window.__asked);
    assert.equal(asked[0]?.type, 'darkmode:get');
    assert.equal(asked[0]?.hostname, 'stampstack.test', 'the frame reports the host it inherited');
    assertLight((await styles(frame, '#p')).color, 'frame text');
  } finally {
    await context.close();
  }
});

test("site style writes are diffed: unrelated ones cost nothing, color ones win, and survive toggle-off", async (t) => {
  if (skip(t)) return;
  const { context, page } = await open(
    `<!doctype html><html><head><style>${LIGHT_PAGE} #a{background:#f5f5f5;color:#222}</style></head>
     <body><div id=a style="padding:3px">a</div></body></html>`,
  );
  try {
    await start(page);
    await page.evaluate(() => {
      document.getElementById('a').style.transform = 'translateX(5px)';
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      document.getElementById('a').style.backgroundColor = '#ffffff';
    });
    await eventually(async () => assertReadable(await styles(page, '#a'), 'element whose background the site rewrote'));
    await stop(page);
    const left = await page.evaluate(() =>
      document
        .getElementById('a')
        .getAttribute('style')
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .sort(),
    );
    assert.deepEqual(left, ['background-color: rgb(255, 255, 255)', 'padding: 3px', 'transform: translateX(5px)']);
    // Re-applying after a stop starts from scratch.
    await start(page);
    assertReadable(await styles(page, '#a'), 'element after re-apply');
  } finally {
    await context.close();
  }
});
