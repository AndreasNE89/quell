// One live content script per frame across an extension update (REVIEW_2026-09-24 M2).
//
// After an install or update the worker runs content.js again in every open tab. A real
// extension (Playwright Chromium, new headless) whose stub worker does the same on `update`
// checks that the copy an update orphaned takes its marks, sheets and observers down, that a
// second copy of the same version never starts next to the first, and that the new copy starts
// on a page that already has images and scripts (the manifest's copy only ever sees an empty
// document at document_start).
//
// Skips (does not fail) when Chromium cannot load an extension.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// SS_CONTENT_ROOT points at another checkout, to confirm the test fails on old code.
const ROOT = process.env.SS_CONTENT_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://site.test';

let extDir;
let profileDir;
let context;
let launchError;

// The configuration is part of the script, so it survives the worker's restart on reload.
const STUB_WORKER = `
self.log = [];
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  self.log.push({ type: msg.type, frameId: sender.frameId, refetch: msg.refetch });
  if (msg.type !== 'cosmetic:get') return sendResponse(null);
  sendResponse({
    allowlisted: false,
    hide: ['.ad'],
    unhide: [],
    procedural: [{ domains: { include: [], exclude: [] }, expr: '.card:has-text(Sponsored)' }],
    disableGeneric: false,
    disableSpecific: false,
  });
});
async function reinject() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const t of tabs) {
    await chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ['content.js'] });
  }
}
self.reinject = reinject;
self.collect = async () => {
  const [tab] = await chrome.tabs.query({ url: 'https://site.test/*' });
  return chrome.tabs.sendMessage(tab.id, { type: 'page:collect' });
};
chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === 'update') reinject().then(() => (self.reinjected = true));
});
`;

function manifest(version) {
  return JSON.stringify({
    manifest_version: 3,
    name: 'StampStack takeover test',
    version,
    background: { service_worker: 'background.js' },
    permissions: ['scripting', 'tabs'],
    host_permissions: ['<all_urls>'],
    content_scripts: [
      { matches: ['<all_urls>'], js: ['content.js'], run_at: 'document_start', all_frames: true },
    ],
  });
}

before(async () => {
  try {
    extDir = mkdtempSync(join(tmpdir(), 'ss-ext-'));
    profileDir = mkdtempSync(join(tmpdir(), 'ss-prof-'));
    const out = await build({
      entryPoints: [join(ROOT, 'src/content/content.ts')],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'chrome120',
      write: false,
      logLevel: 'silent',
      define: { __STAMPSTACK_DEV__: 'true' },
    });
    writeFileSync(join(extDir, 'content.js'), out.outputFiles[0].text);
    writeFileSync(join(extDir, 'background.js'), STUB_WORKER);
    writeFileSync(join(extDir, 'manifest.json'), manifest('1.0'));
    const { chromium } = await import('playwright');
    context = await chromium.launchPersistentContext(profileDir, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
    });
    context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15000 }));
  } catch (e) {
    launchError = e;
    await context?.close().catch(() => {});
    context = undefined;
  }
});

after(async () => {
  await context?.close().catch(() => {});
  for (const d of [extDir, profileDir]) {
    try {
      if (d) rmSync(d, { recursive: true, force: true });
    } catch {
      /* Chrome may still hold the profile on Windows */
    }
  }
});

function skip(t) {
  if (context) return false;
  t.skip(`Chromium extension unavailable: ${launchError?.message ?? 'unknown'}`);
  return true;
}

async function until(fn, expected, ms = 5000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (JSON.stringify(last) === JSON.stringify(expected)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  return last;
}

/** The procedural runner's marker attributes on each `.card` (random `s` + 10 characters). */
const markers = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.card')].map((el) =>
      [...el.attributes].map((a) => a.name).filter((n) => /^s[a-z0-9]{10}$/.test(n)).length,
    ),
  );

const worker = () => context.serviceWorkers().find((w) => w.url().endsWith('/background.js'));

test('a copy an update orphaned stands down for the new one (M2)', async (t) => {
  if (skip(t)) return;
  const page = await context.newPage();
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body:
        '<!doctype html><body><img src="https://cdn.other.test/a.png">' +
        '<script src="https://tracker.other.test/t.js"></script>' +
        '<div class="ad" id="ad">ad</div><div class="card">Sponsored</div></body>',
    }),
  );
  await page.route('https://*.other.test/**', (route) => route.fulfill({ body: '' }));
  try {
    await page.goto(`${ORIGIN}/`);
    assert.deepEqual(await until(() => markers(page), [1]), [1]);

    // A second copy of this same version (the manifest's and the worker's at once).
    await worker().evaluate(() => self.reinject());
    await page.waitForTimeout(500);
    assert.deepEqual(await markers(page), [1], 'a second copy of the same version started');
    const asks = await worker().evaluate(() => self.log.filter((l) => l.type === 'cosmetic:get'));
    assert.equal(asks.length, 1);
    assert.equal(asks[0].refetch, undefined, 'a copy that ran at document_start has nothing inserted yet');

    // An update: the old copy loses the worker, the new one is injected by it.
    writeFileSync(join(extDir, 'manifest.json'), manifest('1.1'));
    const next = context.waitForEvent('serviceworker', { timeout: 15000 });
    await worker().evaluate(() => chrome.runtime.reload()).catch(() => {});
    const sw = await next;
    assert.equal(await until(() => sw.evaluate(() => self.reinjected === true), true), true);
    // The new copy got as far as asking for cosmetics on a page it found fully loaded.
    assert.equal(
      await until(() => sw.evaluate(() => self.log.some((l) => l.type === 'cosmetic:get')), true),
      true,
      'the re-injected copy never asked for cosmetics',
    );
    // It came into a loaded page, which may hold sheets the previous worker inserted.
    assert.deepEqual(
      await sw.evaluate(() => self.log.filter((l) => l.type === 'cosmetic:get').map((l) => l.refetch)),
      [true],
    );

    // The new copy hides; the old one's mark is gone, and its observer no longer marks.
    assert.deepEqual(await until(() => markers(page), [1]), [1], 'the orphaned copy kept its marks');
    await page.evaluate(() => {
      const d = document.createElement('div');
      d.className = 'card';
      d.textContent = 'Sponsored';
      document.body.appendChild(d);
    });
    assert.deepEqual(await until(() => markers(page), [1, 1]), [1, 1], 'the orphaned copy still observes');
    const sheets = await page.evaluate(() => document.querySelectorAll('style[data-StampStack]').length);
    assert.equal(sheets, 1);
    const shown = await page.evaluate(() =>
      [...document.querySelectorAll('.ad, .card')].map((el) => getComputedStyle(el).display),
    );
    assert.deepEqual(shown, ['none', 'none', 'none']);
    // And it answers the popup's page report, with the hosts the page already referenced.
    const report = await sw.evaluate(() => self.collect());
    assert.deepEqual([...(report?.hosts ?? [])].sort(), ['cdn.other.test', 'tracker.other.test']);
    // A page cannot switch a live copy off by sending the same event.
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('stampstack:takeover')));
    await page.waitForTimeout(200);
    assert.deepEqual(await markers(page), [1, 1]);
  } finally {
    await page.close();
  }
});
