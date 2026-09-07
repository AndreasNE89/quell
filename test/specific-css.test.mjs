import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let buildSpecificCss;

globalThis.document = {
  createDocumentFragment() {
    return { querySelector() { return null; } };
  },
};

before(async () => {
  const outfile = join(tmpdir(), `stampstack-specific-css-${process.pid}.mjs`);
  await build({
    stdin: {
      contents: `export { buildSpecificCss } from './src/content/specific-css.ts';`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile,
  });
  ({ buildSpecificCss } = await import(`file://${outfile}`));
  rmSync(outfile, { force: true });
});

test('should emit hide CSS and treat an empty replacement as a clear', () => {
  const css = buildSpecificCss(['.ad'], []);
  assert.match(css, /\.ad/);
  assert.match(css, /display: none/);
  assert.equal(buildSpecificCss([], []), '', 'empty hide+unhide must clear the sheet');
});
