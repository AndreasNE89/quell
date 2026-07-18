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
      contents: `export { extractYoutubeVideoId, findSkipSegment } from './src/content/sponsorblock.ts';`,
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
