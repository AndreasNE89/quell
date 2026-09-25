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
  const outfile = join(tmpdir(), `quell-license-dev-${process.pid}.mjs`);
  await build({
    stdin: {
      contents: `
        export { isDevUnlockLicense, isLicenseEffectivelyPaid } from './src/shared/dark-mode.js';
        export { licenseIsFresh, LICENSE_FRESH_MS, LICENSE_FUTURE_SKEW_MS } from './src/shared/dark-mode.js';
        export { shouldRecheckLicense, LICENSE_UI_RECHECK_MS } from './src/shared/dark-mode.js';
      `,
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

test('should recognize dev unlock license', () => {
  assert.equal(
    mod.isDevUnlockLicense({ paid: true, provider: 'none', verifiedAt: Date.now() }),
    true,
  );
});

test('should not treat ExtensionPay license as dev unlock', () => {
  assert.equal(
    mod.isDevUnlockLicense({ paid: true, provider: 'extensionpay', verifiedAt: Date.now() }),
    false,
  );
});

test('should not treat unpaid as dev unlock', () => {
  assert.equal(
    mod.isDevUnlockLicense({ paid: false, provider: 'none', verifiedAt: null }),
    false,
  );
});

// --- wake-path license freshness --------------------------------------------------------
// init() used to refresh the license over the network on EVERY service-worker wake — a
// blocking request to extensionpay.com a hundred times a day to answer a question whose
// answer changes about never. This gate is what makes the common wake free; getting its
// boundaries wrong would either restore the cost or stop refreshing entirely.

test('a license verified just now is fresh', () => {
  const now = 1_000_000_000_000;
  assert.equal(mod.licenseIsFresh({ paid: true, provider: 'extensionpay', verifiedAt: now }, now), true);
});

test('freshness expires exactly at the window edge', () => {
  const now = 1_000_000_000_000;
  const justInside = { paid: true, provider: 'extensionpay', verifiedAt: now - mod.LICENSE_FRESH_MS + 1 };
  const atEdge = { paid: true, provider: 'extensionpay', verifiedAt: now - mod.LICENSE_FRESH_MS };
  assert.equal(mod.licenseIsFresh(justInside, now), true);
  assert.equal(mod.licenseIsFresh(atEdge, now), false, 'at the edge it must refresh, not skip');
});

test('a never-verified license always refreshes', () => {
  // Otherwise a fresh install would never reach the provider at all.
  assert.equal(mod.licenseIsFresh({ paid: false, provider: 'none', verifiedAt: null }), false);
});

// --- verifiedAt in the future -----------------------------------------------------------
// A future stamp reads as a negative age, which used to sit inside every window forever: one
// bad clock or hand-edited storage blob meant no refresh ever again AND unlimited offline grace.
// Past a small skew allowance it now counts as unverified — a real buyer whose clock jumped
// back is simply re-checked on the next wake.

test('a verifiedAt far in the future is neither fresh nor within grace', () => {
  const now = 1_000_000_000_000;
  const skewed = { paid: true, provider: 'extensionpay', verifiedAt: now + 10 * mod.LICENSE_FRESH_MS };
  assert.equal(mod.licenseIsFresh(skewed, now), false, 'must be re-checked on the next wake');
  assert.equal(mod.isLicenseEffectivelyPaid(skewed, now), false, 'must not grant offline grace');
});

test('a verifiedAt just past the skew allowance counts as unverified', () => {
  const now = 1_000_000_000_000;
  const atLimit = { paid: true, provider: 'extensionpay', verifiedAt: now + mod.LICENSE_FUTURE_SKEW_MS };
  const beyond = { paid: true, provider: 'extensionpay', verifiedAt: now + mod.LICENSE_FUTURE_SKEW_MS + 1 };
  assert.equal(mod.licenseIsFresh(atLimit, now), true, 'ordinary clock skew is tolerated');
  assert.equal(mod.isLicenseEffectivelyPaid(atLimit, now), true);
  assert.equal(mod.licenseIsFresh(beyond, now), false);
  assert.equal(mod.isLicenseEffectivelyPaid(beyond, now), false);
});

// --- UI-triggered re-check ----------------------------------------------------------------
// The popup and Options ask the worker to re-verify an unpaid license, because unlock would
// otherwise wait on ExtPay's onPaid edge. Someone who abandoned checkout holds an API key, so
// each ask is a real request to extensionpay.com — it has to be bounded.

const unpaid = (verifiedAt) => ({ paid: false, configured: true, verifiedAt });

test('an unpaid license that was never verified is re-checked', () => {
  assert.equal(mod.shouldRecheckLicense(unpaid(null), 1_000_000_000_000), true);
});

test('an unpaid license is re-checked at most once per interval', () => {
  const now = 1_000_000_000_000;
  assert.equal(mod.shouldRecheckLicense(unpaid(now - mod.LICENSE_UI_RECHECK_MS + 1), now), false);
  assert.equal(mod.shouldRecheckLicense(unpaid(now - mod.LICENSE_UI_RECHECK_MS), now), true);
});

test('a paid or unconfigured license is never re-checked by the UI', () => {
  const now = 1_000_000_000_000;
  assert.equal(mod.shouldRecheckLicense({ paid: true, configured: true, verifiedAt: null }, now), false);
  assert.equal(mod.shouldRecheckLicense({ paid: false, configured: false, verifiedAt: null }, now), false);
});

test('an unpaid license stamped in the future is re-checked, not trusted as recent', () => {
  const now = 1_000_000_000_000;
  assert.equal(mod.shouldRecheckLicense(unpaid(now + 10 * mod.LICENSE_FRESH_MS), now), true);
});
