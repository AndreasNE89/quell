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

test('should treat allowlisted host as allowlisted', () => {
  const opts = youtubeOptsFromSettings(
    { paused: false, youtubeBlockShorts: true, allowlist: ['youtube.com'] },
    'www.youtube.com',
  );
  assert.equal(opts.allowlisted, true);
});
