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
  const outfile = join(tmpdir(), `quell-extpay-config-${process.pid}.mjs`);
  await build({
    stdin: {
      contents: `export {
  EXTPAY_EXTENSION_ID,
  EXTPAY_EXTENSION_ID_TRACKED,
  CWS_ITEM_ID,
  isExtPayConfigured,
} from './src/shared/extpay-config.js';`,
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

test('should expose live CWS item id for ExtensionPay linking', () => {
  assert.equal(mod.CWS_ITEM_ID, 'hfioggmggaefiiaehnfoiaajcdodnkkd');
});

test('should ship a non-placeholder tracked ExtensionPay id', () => {
  assert.ok(mod.EXTPAY_EXTENSION_ID_TRACKED);
  assert.notEqual(mod.EXTPAY_EXTENSION_ID_TRACKED, 'YOUR_EXTENSIONPAY_ID');
  assert.equal(mod.isExtPayConfigured(), true);
  assert.ok(mod.EXTPAY_EXTENSION_ID.length > 0);
});
