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
  const outfile = join(tmpdir(), `quell-dark-mode-${process.pid}.mjs`);
  await build({
    stdin: {
      contents: `export {
  isLicenseEffectivelyPaid,
  resolveDarkModeForHost,
  hostsWithForceOff,
  hostsWithForceOn,
  isHttpOrHttpsUrl,
  isExtensionRestrictedHostname,
  isDarkModeInjectibleUrl,
} from './src/shared/dark-mode.js';
export { LICENSE_GRACE_MS } from './src/shared/constants.js';`,
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

test('should treat unpaid license as not paid', () => {
  assert.equal(mod.isLicenseEffectivelyPaid({ paid: false, verifiedAt: Date.now() }), false);
});

test('should reject paid without verifiedAt', () => {
  assert.equal(mod.isLicenseEffectivelyPaid({ paid: true, verifiedAt: null }), false);
});

test('should honor paid within grace window', () => {
  const now = 1_000_000_000_000;
  assert.equal(
    mod.isLicenseEffectivelyPaid({ paid: true, verifiedAt: now - 1000 }, now),
    true,
  );
});

test('should expire paid after grace window', () => {
  const now = 1_000_000_000_000;
  assert.equal(
    mod.isLicenseEffectivelyPaid(
      { paid: true, verifiedAt: now - mod.LICENSE_GRACE_MS - 1 },
      now,
    ),
    false,
  );
});

test('should not apply dark mode when unpaid', () => {
  const r = mod.resolveDarkModeForHost({
    paid: false,
    enabled: true,
    overrides: { 'example.com': 'on' },
    hostname: 'example.com',
  });
  assert.equal(r.apply, false);
});

test('should treat force-on override as off when license unpaid (lapse gate)', () => {
  // Paid→unpaid (grace expiry / cancel): per-site force-on must not keep dark mode alive.
  const r = mod.resolveDarkModeForHost({
    paid: false,
    enabled: false,
    overrides: { 'example.com': 'on' },
    hostname: 'example.com',
  });
  assert.equal(r.apply, false);
  assert.equal(r.override, null);
});

test('should expire cached paid after grace so open-tab refresh sees unpaid', () => {
  const now = 1_700_000_000_000;
  const expired = {
    paid: true,
    verifiedAt: now - mod.LICENSE_GRACE_MS - 60_000,
  };
  assert.equal(mod.isLicenseEffectivelyPaid(expired, now), false);
  assert.equal(
    mod.resolveDarkModeForHost({
      paid: mod.isLicenseEffectivelyPaid(expired, now),
      enabled: true,
      overrides: {},
      hostname: 'example.com',
    }).apply,
    false,
  );
});

test('should follow global when no override', () => {
  assert.equal(
    mod.resolveDarkModeForHost({
      paid: true,
      enabled: true,
      overrides: {},
      hostname: 'news.example.com',
    }).apply,
    true,
  );
  assert.equal(
    mod.resolveDarkModeForHost({
      paid: true,
      enabled: false,
      overrides: {},
      hostname: 'news.example.com',
    }).apply,
    false,
  );
});

test('should force off even when global enabled', () => {
  const r = mod.resolveDarkModeForHost({
    paid: true,
    enabled: true,
    overrides: { 'example.com': 'off' },
    hostname: 'www.example.com',
  });
  assert.equal(r.apply, false);
  assert.equal(r.override, 'off');
});

test('should force on even when global disabled', () => {
  const r = mod.resolveDarkModeForHost({
    paid: true,
    enabled: false,
    overrides: { 'example.com': 'on' },
    hostname: 'example.com',
  });
  assert.equal(r.apply, true);
  assert.equal(r.override, 'on');
});

test('should list force-on and force-off hosts', () => {
  const overrides = { 'a.com': 'on', 'b.com': 'off', 'c.com': 'on' };
  assert.deepEqual(mod.hostsWithForceOn(overrides).sort(), ['a.com', 'c.com']);
  assert.deepEqual(mod.hostsWithForceOff(overrides), ['b.com']);
});

test('should accept http(s) tab urls only', () => {
  assert.equal(mod.isHttpOrHttpsUrl('https://example.com/'), true);
  assert.equal(mod.isHttpOrHttpsUrl('http://localhost:3000'), true);
  assert.equal(mod.isHttpOrHttpsUrl('chrome://extensions'), false);
  assert.equal(mod.isHttpOrHttpsUrl('about:blank'), false);
  assert.equal(mod.isHttpOrHttpsUrl(null), false);
});

test('should mark Chrome Web Store hosts as restricted', () => {
  assert.equal(mod.isExtensionRestrictedHostname('chrome.google.com'), true);
  assert.equal(mod.isExtensionRestrictedHostname('chromewebstore.google.com'), true);
  assert.equal(mod.isExtensionRestrictedHostname('example.com'), false);
});

test('should not inject dark mode on restricted https urls', () => {
  const devconsole =
    'https://chrome.google.com/u/1/webstore/devconsole/1f8d61af-6eca-4c07-8551-2613a81caae5';
  assert.equal(mod.isDarkModeInjectibleUrl(devconsole), false);
  assert.equal(mod.isDarkModeInjectibleUrl('https://news.ycombinator.com/'), true);
  assert.equal(mod.isDarkModeInjectibleUrl('chrome://extensions'), false);
});
