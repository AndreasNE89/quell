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
      contents: `export { isDevUnlockLicense } from './src/shared/dark-mode.js';`,
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
