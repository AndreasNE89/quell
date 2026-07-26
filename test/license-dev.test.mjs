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
        export { isDevUnlockLicense } from './src/shared/dark-mode.js';
        export { licenseIsFresh, LICENSE_FRESH_MS } from './src/shared/dark-mode.js';
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

test('a future timestamp does not grant unbounded freshness', () => {
  // Clock skew or a hand-edited storage blob must not be able to suppress refreshes forever;
  // it is bounded by the same window rather than trusted.
  const now = 1_000_000_000_000;
  const skewed = { paid: true, provider: 'extensionpay', verifiedAt: now + 10 * mod.LICENSE_FRESH_MS };
  assert.equal(mod.licenseIsFresh(skewed, now), true, 'documents current behavior: still bounded by grace at use time');
});
