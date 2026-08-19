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
          SPONSORBLOCK_DEFAULT_ON,
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
      contents: `export { buildSkipSegmentsUrl, videoIdHashPrefix, normalizeSegments } from './src/background/sponsorblock-api.ts';`,
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
// "Extremely aggressive, skips at seemingly random times" — reported against 2.2.0, whose
// default enabled all seven categories. Interaction reminders, previews and non-music sections
// are scattered mid-video, so a default-settings user was yanked around constantly. The default
// is now the official SponsorBlock extension's: auto-skip sponsors, everything else opt-in.

test('absent settings skip sponsors only', () => {
  assert.deepEqual(contentMod.enabledSponsorCategories(undefined), ['sponsor']);
  assert.deepEqual(contentMod.enabledSponsorCategories({}), ['sponsor']);
});

test('a malformed settings blob falls back to the sponsor-only default', () => {
  for (const bad of [null, 'nope', 42, []]) {
    assert.deepEqual(contentMod.enabledSponsorCategories(bad), ['sponsor'], String(bad));
  }
});

test('an explicit choice always wins over the default, in both directions', () => {
  const out = contentMod.enabledSponsorCategories({ intro: true, sponsor: false });
  assert.ok(out.includes('intro'), 'explicitly enabled category must skip');
  assert.ok(!out.includes('sponsor'), 'explicitly disabled category must not skip');
  assert.ok(!out.includes('outro'), 'untouched category follows its default');
});

test('a pre-2.2.1 user who enabled extra categories keeps them', () => {
  // Only toggles the user actually flipped are stored, so an old blob with explicit trues
  // must survive the default change.
  const out = contentMod.enabledSponsorCategories({ intro: true, preview: true });
  assert.deepEqual(out.sort(), ['intro', 'preview', 'sponsor'].sort());
});

test('the default map covers every category exactly', () => {
  assert.deepEqual(
    Object.keys(contentMod.SPONSORBLOCK_DEFAULT_ON).sort(),
    [...contentMod.SPONSORBLOCK_SKIP_CATEGORIES].sort(),
  );
  const on = Object.entries(contentMod.SPONSORBLOCK_DEFAULT_ON).filter(([, v]) => v);
  assert.deepEqual(on.map(([k]) => k), ['sponsor'], 'only sponsor is on by default');
});

test('an unrecognized key cannot enable something we do not support', () => {
  const out = contentMod.enabledSponsorCategories({ filler: true, chapter: true });
  assert.deepEqual(out, ['sponsor']);
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

// --- robustness -----------------------------------------------------------------------------

test('implausible and malformed segments are rejected before they reach the player', () => {
  // A segment covering most of a video is bad data or abuse; acting on it would jump the
  // viewer to the end. Rejecting here also keeps it out of the cache and the page payload.
  const raw = [
    { category: 'sponsor', actionType: 'skip', segment: [10, 25], UUID: 'ok' },
    { category: 'sponsor', actionType: 'skip', segment: [0, 99999] },
    { category: 'sponsor', actionType: 'skip', segment: [-5, 20] },
    { category: 'sponsor', actionType: 'skip', segment: [30, 30] },
    { category: 'sponsor', actionType: 'skip', segment: [50, 10] },
    { category: 'sponsor', actionType: 'skip', segment: ['a', 'b'] },
    { category: 'sponsor', actionType: 'mute', segment: [1, 2] },
    null,
    'nonsense',
  ];
  const out = apiMod.normalizeSegments(raw);
  assert.equal(out.length, 1, `expected only the valid segment, got ${JSON.stringify(out)}`);
  assert.equal(out[0].UUID, 'ok');
  assert.deepEqual(out[0].segment, [10, 25]);
});

test('the request URL still carries unencoded JSON brackets', () => {
  // Cloudflare on sponsor.ajay.app rejects fully URL-encoded arrays, so this must not regress
  // when the category list became dynamic.
  const url = apiMod.buildSkipSegmentsUrl('5f6b', ['sponsor', 'intro']);
  assert.match(url, /categories=\["sponsor","intro"\]/);
  assert.match(url, /actionTypes=\["skip"\]/);
  assert.ok(!url.includes('%5B'), 'brackets must not be percent-encoded');
});

test('a narrower category list produces a different request', () => {
  const all = apiMod.buildSkipSegmentsUrl('5f6b', ['sponsor', 'intro', 'outro']);
  const one = apiMod.buildSkipSegmentsUrl('5f6b', ['sponsor']);
  assert.notEqual(all, one);
  assert.ok(!one.includes('intro'), 'a sponsor-only user must not request intro data');
});

// A segment running to the video end must still be found; the tick clamps the landing point
// rather than refusing the skip (outros normally run to the very end).
test('a segment ending at the video end is still found', () => {
  const hit = contentMod.findSkipSegment(
    [{ category: 'outro', actionType: 'skip', segment: [280, 300] }],
    285,
  );
  assert.ok(hit);
  assert.equal(hit.segment[1], 300);
});
