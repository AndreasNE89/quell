import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let mod;

before(async () => {
  const outfile = join(tmpdir(), `quell-settings-${process.pid}.mjs`);
  await build({
    stdin: {
      contents: `export { defaultSettings } from './src/background/settings.js';`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile,
  });
  mod = await import(`file://${outfile}?t=${Date.now()}`);
  process.on('exit', () => {
    try {
      rmSync(outfile);
    } catch {
      /* ignore */
    }
  });
});

test('default settings enable sponsored YouTube blocking and leave Shorts off', () => {
  const s = mod.defaultSettings();
  assert.equal(s.youtubeBlockSponsored, true);
  assert.equal(s.youtubeBlockShorts, false);
  assert.equal(s.darkModeEnabled, false);
  assert.deepEqual(s.darkModeSiteOverrides, {});
});
