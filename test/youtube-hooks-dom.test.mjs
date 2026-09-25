// The YouTube MAIN-world hooks (dist/scriptlets-youtube.js) against the Shorts feed endpoint.
//
// On youtube.com the list rewrites are dropped at runtime (runScriptlet), so these hooks are
// the only thing between the page and its ads. The Shorts feed is answered by
// /youtubei/v1/reel/reel_watch_sequence: a POST fetch whose `entries` put an ad in every third
// slot (7 of 21 on youtube.com, 2026-09), each marked `adClientParams.isAd`, which is what
// uBO's `json-prune-fetch-response` rule for it removes. The fixture below keeps that shape.
//
// The browser part skips (does not fail) when Chromium cannot be launched.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let hooks = '';
let lib;
let browser;
let launchError;

before(async () => {
  // As scripts/build.mjs builds it.
  const out = await build({
    entryPoints: [join(ROOT, 'src/content/scriptlets-youtube.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    write: false,
    logLevel: 'silent',
  });
  hooks = out.outputFiles[0].text;
  const libOut = await build({
    stdin: {
      contents: `export { stripYoutubeShortsAds } from './src/scriptlets/library.ts';`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
  });
  lib = await import(`data:text/javascript;base64,${Buffer.from(libOut.outputFiles[0].text).toString('base64')}`);
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

function entry(videoId, ad = false) {
  return {
    command: {
      clickTrackingParams: `ct-${videoId}`,
      commandMetadata: { webCommandMetadata: { url: `/shorts/${videoId}`, webPageType: 'WEB_PAGE_TYPE_SHORTS' } },
      reelWatchEndpoint: {
        videoId,
        playerParams: 'pp',
        params: 'p',
        ...(ad ? { adClientParams: { isAd: true } } : { overlay: {} }),
        loggingContext: {},
      },
    },
    trackingParams: `tp-${videoId}`,
  };
}

const IDS = ['short000001', 'adadadad001', 'short000002', 'short000003', 'adadadad002', 'short000004'];
const sequence = () => ({
  responseContext: {},
  entries: IDS.map((id) => entry(id, id.startsWith('adad'))),
  trackingParams: 't',
  continuationEndpoint: {},
});
const CONTENT = IDS.filter((id) => !id.startsWith('adad'));

const idsOf = (entries) => entries.map((e) => e.command.reelWatchEndpoint.videoId);

test('Shorts feed ads are removed, at the top level and under reelWatchSequenceResponse', () => {
  const top = sequence();
  assert.equal(lib.stripYoutubeShortsAds(top), true);
  assert.deepEqual(idsOf(top.entries), CONTENT);

  const nested = { reelWatchSequenceResponse: sequence() };
  assert.equal(lib.stripYoutubeShortsAds(nested), true);
  assert.deepEqual(idsOf(nested.reelWatchSequenceResponse.entries), CONTENT);

  const clean = { entries: [entry('short000001')] };
  assert.equal(lib.stripYoutubeShortsAds(clean), false);
  assert.equal(clean.entries.length, 1);
  for (const junk of [null, 'x', 42, [], { entries: 'x' }, { entries: [null, 1] }]) {
    assert.equal(lib.stripYoutubeShortsAds(junk), false);
  }
});

test('the YouTube hooks strip Shorts ads from reel_watch_sequence by fetch and XHR (M3)', async (t) => {
  if (!browser) return t.skip(`Chromium unavailable: ${launchError?.message ?? 'unknown'}`);
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith('/youtubei/v1/')) {
      return route.fulfill({ contentType: 'application/json; charset=UTF-8', body: JSON.stringify(sequence()) });
    }
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Shorts</title>' });
  });
  await page.addInitScript({ content: hooks });
  await page.goto('https://www.youtube.com/shorts/short000001');

  const got = await page.evaluate(async () => {
    const url = '/youtubei/v1/reel/reel_watch_sequence?prettyPrint=false';
    const ids = (body) => body.entries.map((e) => e.command.reelWatchEndpoint.videoId);
    const viaFetch = ids(await (await fetch(url, { method: 'POST', body: '{}' })).json());
    const xhr = (responseType) =>
      new Promise((resolve) => {
        const x = new XMLHttpRequest();
        x.open('POST', url);
        x.responseType = responseType;
        x.onload = () => resolve(ids(responseType === 'json' ? x.response : JSON.parse(x.responseText)));
        x.send('{}');
      });
    // Another endpoint with the same body is not the hooks' business.
    const other = ids(await (await fetch('/youtubei/v1/browse?prettyPrint=false', { method: 'POST' })).json());
    return { viaFetch, viaXhrText: await xhr(''), viaXhrJson: await xhr('json'), other };
  });
  assert.deepEqual(got.viaFetch, CONTENT, 'fetch kept the Shorts ads');
  assert.deepEqual(got.viaXhrText, CONTENT);
  assert.deepEqual(got.viaXhrJson, CONTENT);
  assert.deepEqual(got.other, IDS);
});
