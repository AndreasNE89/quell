import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let youtubeOptsFromSettings;

before(async () => {
  const outfile = join(tmpdir(), `stampstack-youtube-ui-${process.pid}.mjs`);
  await build({
    stdin: {
      contents: `export { youtubeOptsFromSettings } from './src/content/youtube-ui.ts';`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile,
  });
  ({ youtubeOptsFromSettings } = await import(`file://${outfile}`));
  rmSync(outfile, { force: true });
});

test('should enable shorts block when youtubeBlockShorts is true', () => {
  const opts = youtubeOptsFromSettings(
    { paused: false, youtubeBlockShorts: true, allowlist: [] },
    'www.youtube.com',
  );
  assert.equal(opts.youtubeBlockShorts, true);
  assert.equal(opts.youtubeSponsorBlock, true);
  assert.equal(opts.paused, false);
  assert.equal(opts.allowlisted, false);
});

test('should disable SponsorBlock when youtubeSponsorBlock is false', () => {
  const opts = youtubeOptsFromSettings(
    { paused: false, youtubeSponsorBlock: false, allowlist: [] },
    'www.youtube.com',
  );
  assert.equal(opts.youtubeSponsorBlock, false);
});

test('should include resolved SponsorBlock categories in youtube options', () => {
  const opts = youtubeOptsFromSettings(
    { paused: false, allowlist: [], sponsorBlockCategories: { intro: true, sponsor: false } },
    'www.youtube.com',
  );
  assert.ok(opts.sponsorBlockCategories.includes('intro'));
  assert.ok(!opts.sponsorBlockCategories.includes('sponsor'));
});

test('should treat allowlisted host as allowlisted', () => {
  const opts = youtubeOptsFromSettings(
    { paused: false, youtubeBlockShorts: true, allowlist: ['youtube.com'] },
    'www.youtube.com',
  );
  assert.equal(opts.allowlisted, true);
});

test('the repair ladder reaches the YouTube features, as the worker decides it (B32)', () => {
  const at = (siteFixes) =>
    youtubeOptsFromSettings({ paused: false, allowlist: [], siteFixes }, 'www.youtube.com');
  assert.deepEqual(
    [at({}).cosmeticsOff, at({}).scriptletsOff],
    [false, false],
  );
  const cosmetics = at({ 'youtube.com': 'cosmetics' });
  assert.deepEqual([cosmetics.cosmeticsOff, cosmetics.scriptletsOff], [true, false]);
  const injection = at({ 'youtube.com': 'injection' });
  assert.deepEqual([injection.cosmeticsOff, injection.scriptletsOff], [true, true]);
  // A fix for another site does not reach YouTube.
  assert.equal(at({ 'example.com': 'injection' }).scriptletsOff, false);
});

test('an exact site rule counts on its own host only, as in the worker (B28)', () => {
  const opts = (allowlist, host) => youtubeOptsFromSettings({ paused: false, allowlist }, host);
  // github.io is a tenant platform: its entry means github.io itself, never every tenant.
  assert.equal(opts(['github.io'], 'someone.github.io').allowlisted, false);
  assert.equal(opts(['github.io'], 'github.io').allowlisted, true);
});
