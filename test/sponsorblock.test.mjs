import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @type {typeof import('../src/content/sponsorblock.ts')} */
let contentMod;
/** @type {typeof import('../src/background/sponsorblock-api.ts')} */
let apiMod;

before(async () => {
  if (!globalThis.crypto) globalThis.crypto = webcrypto;

  const contentOut = join(tmpdir(), `stampstack-sb-content-${process.pid}.mjs`);
  const apiOut = join(tmpdir(), `stampstack-sb-api-${process.pid}.mjs`);

  await build({
    stdin: {
      contents: `
        export { extractYoutubeVideoId, findSkipSegment } from './src/content/sponsorblock.ts';
        export {
          SPONSORBLOCK_SKIP_CATEGORIES,
          SPONSORBLOCK_CATEGORY_INFO,
          enabledSponsorCategories,
        } from './src/shared/sponsorblock.ts';
      `,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile: contentOut,
  });
  await build({
    stdin: {
      contents: `export { buildSkipSegmentsUrl, videoIdHashPrefix } from './src/background/sponsorblock-api.ts';`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile: apiOut,
  });

  contentMod = await import(`file://${contentOut}`);
  apiMod = await import(`file://${apiOut}`);
  rmSync(contentOut, { force: true });
  rmSync(apiOut, { force: true });
});

test('should extract video id from watch, shorts, embed, and youtu.be URLs', () => {
  assert.equal(
    contentMod.extractYoutubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    'dQw4w9WgXcQ',
  );
  assert.equal(
    contentMod.extractYoutubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'),
    'dQw4w9WgXcQ',
  );
  assert.equal(
    contentMod.extractYoutubeVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ'),
    'dQw4w9WgXcQ',
  );
  assert.equal(
    contentMod.extractYoutubeVideoId('https://youtu.be/dQw4w9WgXcQ'),
    'dQw4w9WgXcQ',
  );
  assert.equal(contentMod.extractYoutubeVideoId('https://example.com/watch?v=dQw4w9WgXcQ'), null);
});

test('should find the earliest skippable segment covering the playhead', () => {
  const segs = [
    { category: 'intro', actionType: 'skip', segment: [0, 5] },
    { category: 'sponsor', actionType: 'skip', segment: [10, 20] },
    { category: 'sponsor', actionType: 'mute', segment: [12, 14] },
  ];
  assert.equal(contentMod.findSkipSegment(segs, 2)?.category, 'intro');
  assert.equal(contentMod.findSkipSegment(segs, 12)?.category, 'sponsor');
  assert.equal(contentMod.findSkipSegment(segs, 12)?.segment[1], 20);
  assert.equal(contentMod.findSkipSegment(segs, 25), null);
});

test('should build skipSegments URL with unencoded JSON array brackets', () => {
  const url = apiMod.buildSkipSegmentsUrl('a1b2', ['sponsor', 'intro']);
  assert.match(url, /\/api\/skipSegments\/a1b2\?/);
  assert.match(url, /categories=\["sponsor","intro"\]/);
  assert.match(url, /actionTypes=\["skip"\]/);
  assert.ok(!url.includes('%5B'), 'must not percent-encode [ for Cloudflare');
});

test('should hash video id to a 4-char hex prefix', async () => {
  const prefix = await apiMod.videoIdHashPrefix('dQw4w9WgXcQ');
  assert.match(prefix, /^[0-9a-f]{4}$/);
});

// --- per-category control ---------------------------------------------------------------
// Skipping used to be all-or-nothing, with two of the seven categories firing without ever
// appearing in the UI. The absent-means-enabled default is load-bearing: a settings blob
// written before this was configurable must keep the coverage it had.

test('absent settings mean every category stays enabled', () => {
  assert.deepEqual(contentMod.enabledSponsorCategories(undefined), [...contentMod.SPONSORBLOCK_SKIP_CATEGORIES]);
  assert.deepEqual(contentMod.enabledSponsorCategories({}), [...contentMod.SPONSORBLOCK_SKIP_CATEGORIES]);
});

test('a malformed settings blob does not silently reduce coverage', () => {
  for (const bad of [null, 'nope', 42, []]) {
    assert.deepEqual(
      contentMod.enabledSponsorCategories(bad),
      [...contentMod.SPONSORBLOCK_SKIP_CATEGORIES],
      String(bad),
    );
  }
});

test('only explicit false disables a category', () => {
  const out = contentMod.enabledSponsorCategories({ intro: false, outro: false });
  assert.ok(!out.includes('intro'));
  assert.ok(!out.includes('outro'));
  assert.ok(out.includes('sponsor'));
  assert.equal(out.length, contentMod.SPONSORBLOCK_SKIP_CATEGORIES.length - 2);
});

test('an unrecognized key cannot enable something we do not support', () => {
  const out = contentMod.enabledSponsorCategories({ filler: true, chapter: true });
  assert.deepEqual(out, [...contentMod.SPONSORBLOCK_SKIP_CATEGORIES]);
  assert.ok(!out.includes('filler'));
});

test('everything off returns an empty list, which the caller uses to skip the request', () => {
  const allOff = {};
  for (const c of contentMod.SPONSORBLOCK_SKIP_CATEGORIES) allOff[c] = false;
  assert.deepEqual(contentMod.enabledSponsorCategories(allOff), []);
});

test('every category has user-facing copy', () => {
  // A category with no label would render as a blank row in Options.
  for (const c of contentMod.SPONSORBLOCK_SKIP_CATEGORIES) {
    const info = contentMod.SPONSORBLOCK_CATEGORY_INFO[c];
    assert.ok(info, c);
    assert.ok(info.label && info.label.length > 2, `${c} label`);
    assert.ok(info.hint && info.hint.length > 10, `${c} hint`);
  }
});
