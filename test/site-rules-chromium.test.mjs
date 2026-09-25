// Two platform behaviours the service worker now relies on, checked in a real Chromium with a
// small extension that makes the same calls:
//   - the exact-host allowlist rules (site-rules.ts siteRuleDnrConditions, B28) match the host
//     itself and nothing under or around it, a user name that looks like it included, as
//     Chrome's DNR matcher reads them;
//   - a sheet inserted at USER origin (service-worker.ts syncUserGenericSheet, B21) beats a
//     page's `!important`, in a stylesheet and inline, where the registered author-origin sheet
//     loses to both.
//
// Skips (does not fail) when Chromium cannot be launched with an extension, e.g. on a machine
// without the Playwright browser download.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.SS_SW_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
let context;
let worker;
let server;
let launchError;
let rules;
const dirs = [];

const PAGE = `<!doctype html><html><head><style>.ad-a,.ad-b{display:block !important}</style></head><body>
<div id=registered class=ad-a>registered sheet vs page !important</div>
<div id=user class=ad-b>user sheet vs page !important</div>
<div id=inline class=ad-b style="display:block !important">user sheet vs inline !important</div>
</body></html>`;

before(async () => {
  const out = await build({
    stdin: { contents: `export * from './src/shared/site-rules.ts';`, resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
  });
  rules = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);

  const ext = mkdtempSync(join(tmpdir(), 'ss-ext-'));
  dirs.push(ext);
  writeFileSync(
    join(ext, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'site-rules-check',
      version: '1.0',
      permissions: ['scripting', 'declarativeNetRequest', 'declarativeNetRequestFeedback'],
      host_permissions: ['<all_urls>'],
      background: { service_worker: 'sw.js' },
      content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'], run_at: 'document_start' }],
    }),
  );
  writeFileSync(join(ext, 'registered.css'), '.ad-a { display: none !important; }\n');
  writeFileSync(join(ext, 'user.css'), '.ad-b { display: none !important; }\n');
  writeFileSync(
    join(ext, 'content.js'),
    `chrome.runtime.sendMessage('insert').then(() => document.documentElement.setAttribute('data-inserted', ''));\n`,
  );
  writeFileSync(
    join(ext, 'sw.js'),
    `globalThis.ready = chrome.scripting.unregisterContentScripts().catch(() => {}).then(() =>
       chrome.scripting.registerContentScripts([{ id: 'g', css: ['registered.css'], matches: ['<all_urls>'], runAt: 'document_start' }]));
     chrome.runtime.onMessage.addListener((m, sender, respond) => {
       if (m !== 'insert') return;
       chrome.scripting.insertCSS({ target: { tabId: sender.tab.id, documentIds: [sender.documentId] }, files: ['user.css'], origin: 'USER' })
         .then(() => respond(true), () => respond(false));
       return true;
     });
     globalThis.outcome = async (addRules, urls) => {
       const old = (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id);
       await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: old, addRules });
       const out = {};
       for (const url of urls) {
         const r = await chrome.declarativeNetRequest.testMatchOutcome({ url, type: 'main_frame', tabId: -1 });
         out[url] = r.matchedRules.length > 0;
       }
       return out;
     };\n`,
  );

  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  try {
    const { chromium } = await import('playwright');
    const profile = mkdtempSync(join(tmpdir(), 'ss-p-'));
    dirs.push(profile);
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${ext}`,
        `--load-extension=${ext}`,
        `--proxy-server=http://127.0.0.1:${server.address().port}`,
        '--proxy-bypass-list=<-loopback>',
      ],
    });
    worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
    // Playwright can attach before the worker script has run.
    for (let i = 0; i < 100 && !(await worker.evaluate(() => typeof globalThis.outcome === 'function')); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await worker.evaluate(() => globalThis.ready);
  } catch (e) {
    launchError = e;
  }
});

after(async () => {
  await context?.close().catch(() => {});
  server?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test('exact-host allowlist rules match the host alone in Chrome’s matcher (B28)', async (t) => {
  if (launchError) return t.skip(`Chromium with an extension unavailable: ${launchError.message}`);
  const addRules = ['go.dev', 'intranet', 'example.com'].flatMap(rules.siteRuleDnrConditions).map((c, i) => ({
    id: i + 1,
    priority: 1,
    action: { type: 'allowAllRequests' },
    condition: { ...c, resourceTypes: ['main_frame'] },
  }));
  const urls = {
    'https://go.dev/': true,
    'http://go.dev/doc/': true,
    'https://go.dev:8443/x': true,
    'https://pkg.go.dev/': false,
    'https://go.dev.evil.example/': false,
    'https://evil.example/?next=https://go.dev/': false,
    'http://intranet/wiki': true,
    'http://intranet.corp/': false,
    'https://www.example.com/': true,
    // `^` matches the `@` after a user name: a link written this way must not switch off evil.example.
    'https://go.dev@evil.example/': false,
    'https://go.dev:pw@evil.example/': false,
    'http://intranet@evil.example/': false,
  };
  const got = await worker.evaluate(([r, u]) => globalThis.outcome(r, u), [addRules, Object.keys(urls)]);
  assert.deepEqual(got, urls);
});

test('a USER-origin sheet beats page !important where the registered sheet does not (B21)', async (t) => {
  if (launchError) return t.skip(`Chromium with an extension unavailable: ${launchError.message}`);
  const page = await context.newPage();
  await page.goto('http://site.example/');
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-inserted'));
  const display = await page.evaluate(() =>
    Object.fromEntries(['registered', 'user', 'inline'].map((id) => [id, getComputedStyle(document.getElementById(id)).display])),
  );
  assert.deepEqual(display, { registered: 'block', user: 'none', inline: 'none' });
  await page.close();
});
