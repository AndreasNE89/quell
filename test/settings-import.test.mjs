// Settings backups are validated field by field before they reach storage
// (src/background/settings-import.ts, REVIEW_2026-09-24 import P3s).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.SS_SW_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
let m;

before(async () => {
  const out = await build({
    stdin: {
      contents: `
        export * from './src/background/settings-import.ts';
        export { applyImportedSettings, defaultSettings } from './src/background/settings.ts';
      `,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
  });
  m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
});

test('a present field of the wrong type is named and left out, so the install keeps its value', () => {
  const { settings, ignored } = m.sanitizeImportedSettings({
    paused: 'yes',
    allowlist: 'example.com',
    siteFixes: ['x'],
    enabledLists: null,
    customFilters: 7,
    youtubeSponsorBlock: false,
  });
  assert.deepEqual(ignored.sort(), ['allowlist', 'customFilters', 'enabledLists', 'paused', 'siteFixes']);
  assert.deepEqual(settings, { youtubeSponsorBlock: false });

  const current = { ...m.defaultSettings(), allowlist: ['keep.example'], paused: true };
  const next = m.applyImportedSettings(current, settings);
  assert.deepEqual(next.allowlist, ['keep.example']);
  assert.equal(next.paused, true);
  assert.equal(next.youtubeSponsorBlock, false);
});

test('site keys are normalized, and entries nothing could match are dropped', () => {
  const { settings } = m.sanitizeImportedSettings({
    allowlist: ['WWW.Example.COM', 'example.com', 'go.dev', '10.0.0', 42, 'bad host'],
    siteFixes: { 'Shop.Example': 'cosmetics', 'www.shop.example': 'injection', 'x.example': 'off' },
    darkModeSiteOverrides: { 'WWW.News.Example': 'off', 'https://x.example/': 'on', 'y.example': 'dim' },
  });
  assert.deepEqual(settings.allowlist, ['example.com', 'go.dev']);
  // Two spellings of one site: the stronger fix, as resolveSiteFix would decide between them.
  assert.deepEqual(settings.siteFixes, { 'shop.example': 'injection' });
  assert.deepEqual(settings.darkModeSiteOverrides, { 'news.example': 'off' });
});

test('list and category switches must be booleans', () => {
  const { settings } = m.sanitizeImportedSettings({
    enabledLists: { easylist: 'false', easyprivacy: false, '': true },
    sponsorBlockCategories: { sponsor: 1, intro: true },
  });
  assert.deepEqual(settings.enabledLists, { easyprivacy: false });
  assert.deepEqual(settings.sponsorBlockCategories, { intro: true });
});

test('custom filters over the cap are cut at a whole line', () => {
  const line = 'example.com##.a-fairly-long-selector-name\n';
  const text = line.repeat(Math.ceil(m.CUSTOM_FILTERS_MAX_CHARS / line.length) + 1);
  const { settings, truncated } = m.sanitizeImportedSettings({ customFilters: text });
  assert.equal(truncated, true);
  assert.ok(settings.customFilters.length <= m.CUSTOM_FILTERS_MAX_CHARS);
  assert.ok(settings.customFilters.endsWith(line), 'a rule was cut in half');
  assert.deepEqual(m.capFilterText('short\n'), { text: 'short\n', truncated: false });
  assert.deepEqual(m.capFilterText('x'.repeat(20), 10), { text: '', truncated: true });
});

test('anything but an object imports nothing', () => {
  for (const raw of [null, 'x', [], 3]) {
    assert.deepEqual(m.sanitizeImportedSettings(raw), { settings: {}, ignored: [], truncated: false });
  }
});
