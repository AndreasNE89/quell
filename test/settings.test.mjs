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
      contents: `export { defaultSettings, mergeSettings } from './src/background/settings.js';`,
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
  assert.equal(s.youtubeSponsorBlock, true);
  assert.equal(s.darkModeEnabled, false);
  assert.deepEqual(s.darkModeSiteOverrides, {});
});

test('should merge settings without letting null/undefined wipe defaults', () => {
  const s = mod.mergeSettings({
    paused: true,
    youtubeBlockSponsored: undefined,
    darkModeSiteOverrides: undefined,
    allowlist: ['example.com'],
  });
  assert.equal(s.paused, true);
  assert.equal(s.youtubeBlockSponsored, true); // default preserved
  assert.deepEqual(s.darkModeSiteOverrides, {});
  assert.deepEqual(s.allowlist, ['example.com']);
});

test('should keep darkModeAutoOff as a plain object when merging', () => {
  const s = mod.mergeSettings({
    darkModeAutoOff: { 'example.com': true },
    darkModeSiteOverrides: { 'example.com': 'off' },
  });
  assert.equal(s.darkModeAutoOff['example.com'], true);
  assert.equal(s.darkModeSiteOverrides['example.com'], 'off');
});

// --- siteFixes + hostile input --------------------------------------------------------------
// mergeSettings is now the validation boundary for user-supplied import files, not just for
// storage we wrote ourselves. Anything it lets through reaches the rest of the worker.

test('siteFixes defaults to empty and round-trips valid levels', () => {
  assert.deepEqual(mod.defaultSettings().siteFixes, {});
  const s = mod.mergeSettings({
    siteFixes: { 'a.example': 'cosmetics', 'b.example': 'injection' },
  });
  assert.deepEqual(s.siteFixes, { 'a.example': 'cosmetics', 'b.example': 'injection' });
});

test('unknown siteFixes levels and bad keys are dropped, not stored', () => {
  const s = mod.mergeSettings({
    siteFixes: {
      'ok.example': 'injection',
      'bad.example': 'everything',
      'null.example': null,
      'num.example': 3,
      '': 'cosmetics',
    },
  });
  assert.deepEqual(s.siteFixes, { 'ok.example': 'injection' });
});

test('siteFixes of the wrong shape falls back to the default', () => {
  assert.deepEqual(mod.mergeSettings({ siteFixes: 'nope' }).siteFixes, {});
  assert.deepEqual(mod.mergeSettings({ siteFixes: null }).siteFixes, {});
  assert.deepEqual(mod.mergeSettings({}).siteFixes, {});
});

test('non-string allowlist entries are filtered out', () => {
  // A single non-string entry used to reach normalizeHostname and throw, which took down
  // cosmetic filtering for every page — reachable via an imported settings file.
  const s = mod.mergeSettings({
    allowlist: ['good.example', null, 42, { host: 'x' }, '', 'also.example', undefined],
  });
  assert.deepEqual(s.allowlist, ['good.example', 'also.example']);
});

test('an allowlist of the wrong type does not wipe the default', () => {
  assert.deepEqual(mod.mergeSettings({ allowlist: 'example.com' }).allowlist, []);
});
