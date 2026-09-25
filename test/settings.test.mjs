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
      contents: `export {
        defaultSettings,
        mergeSettings,
        portableSettings,
        buildSettingsExportDocument,
        applyImportedSettings,
        PORTABLE_SETTING_KEYS,
      } from './src/background/settings.js';`,
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

test('should export every portable setting including custom filters and categories', () => {
  const s = {
    ...mod.defaultSettings(),
    paused: true,
    enabledLists: { easylist: false },
    allowlist: ['keep.example'],
    siteFixes: { 'broke.example': 'cosmetics' },
    youtubeBlockSponsored: false,
    youtubeBlockShorts: true,
    youtubeSponsorBlock: false,
    darkModeEnabled: true,
    darkModeSiteOverrides: { 'news.example': 'on' },
    customFilters: 'example.com##.ad',
    sponsorBlockCategories: { sponsor: false, intro: true },
    blockedTotal: 99,
    darkModeAutoOff: { 'dark.example': true },
  };
  const doc = mod.buildSettingsExportDocument(s);
  assert.equal(doc.format, 'stampstack-settings');
  assert.equal(doc.version, 2);
  for (const key of mod.PORTABLE_SETTING_KEYS) {
    assert.ok(key in doc.settings, `export must include ${key}`);
  }
  assert.equal(doc.settings.customFilters, 'example.com##.ad');
  assert.deepEqual(doc.settings.sponsorBlockCategories, { sponsor: false, intro: true });
  assert.equal('blockedTotal' in doc.settings, false);
  assert.equal('darkModeAutoOff' in doc.settings, false);

  const restored = mod.applyImportedSettings(mod.defaultSettings(), doc.settings);
  for (const key of mod.PORTABLE_SETTING_KEYS) {
    assert.deepEqual(restored[key], doc.settings[key], `round-trip ${key}`);
  }
  assert.equal(restored.blockedTotal, 0, 'counters are never imported');
});

test('should keep current custom filters when an older export omits them', () => {
  const current = {
    ...mod.defaultSettings(),
    customFilters: 'example.com##.ad',
    sponsorBlockCategories: { sponsor: false, intro: true },
    paused: false,
  };
  const incoming = {
    paused: true,
    enabledLists: {},
    allowlist: [],
    siteFixes: {},
    youtubeBlockSponsored: true,
    youtubeBlockShorts: false,
    youtubeSponsorBlock: true,
    darkModeEnabled: false,
    darkModeSiteOverrides: {},
  };
  const next = mod.applyImportedSettings(current, incoming);
  assert.equal(next.paused, true);
  assert.equal(next.customFilters, 'example.com##.ad');
  assert.deepEqual(next.sponsorBlockCategories, { sponsor: false, intro: true });
});

test('should apply empty custom filters when the export contains them', () => {
  const current = { ...mod.defaultSettings(), customFilters: 'keep.com##.x' };
  const next = mod.applyImportedSettings(current, { customFilters: '' });
  assert.equal(next.customFilters, '');
});

test('over-long stored filters are cut at a whole line, never mid-rule', () => {
  const line = 'news.example##.ad-slot-with-a-long-class-name\n';
  const text = line.repeat(Math.ceil(100_000 / line.length) + 5);
  const s = mod.mergeSettings({ customFilters: text });
  assert.ok(s.customFilters.length <= 100_000);
  assert.ok(s.customFilters.endsWith('\n'));
  assert.ok(s.customFilters.split('\n').slice(0, -1).every((l) => l === line.trim()), 'a rule was cut in half');
});
