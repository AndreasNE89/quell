import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let startSponsorBlock;
let refreshSponsorBlock;

before(async () => {
  globalThis.location = {
    hostname: 'www.youtube.com',
    href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    pathname: '/watch',
    search: '?v=dQw4w9WgXcQ',
  };
  globalThis.document = {
    addEventListener() {},
    fullscreenElement: null,
    documentElement: {},
    body: {},
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const win = {
    top: null,
    setInterval: () => 1,
    clearTimeout() {},
    addEventListener() {},
  };
  win.top = win;
  globalThis.window = win;

  const outfile = join(tmpdir(), `stampstack-sb-refresh-${process.pid}.mjs`);
  await build({
    stdin: {
      contents: `export { startSponsorBlock, refreshSponsorBlock } from './src/content/sponsorblock.ts';`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile,
  });
  ({ startSponsorBlock, refreshSponsorBlock } = await import(`file://${outfile}`));
  rmSync(outfile, { force: true });
});

test('should refetch the current video when SponsorBlock categories change', async () => {
  let fetches = 0;
  let opts = {
    paused: false,
    allowlisted: false,
    youtubeBlockSponsored: true,
    youtubeBlockShorts: false,
    youtubeSponsorBlock: true,
    sponsorBlockCategories: ['sponsor'],
  };
  startSponsorBlock({
    getOpts: () => opts,
    fetchSegments: async () => {
      fetches++;
      return [];
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fetches, 1);

  opts = { ...opts, sponsorBlockCategories: ['sponsor', 'intro'] };
  refreshSponsorBlock();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fetches, 2, 'same video must refetch after a category change');
});
