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
  const outfile = join(tmpdir(), `stampstack-dark-dynamic-${process.pid}.mjs`);
  await build({
    stdin: {
      contents: `export {
  rgbToHsl, hslToRgb, rgbToCss,
  remapBackgroundColor, remapForegroundColor, remapBorderColor,
} from './src/shared/dark-mode-dynamic.js';`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile,
  });
  mod = await import(`file://${outfile}?t=${Date.now()}`);
  rmSync(outfile, { force: true });
});

test('rgb<->hsl round-trips within rounding', () => {
  for (const c of [
    { r: 255, g: 255, b: 255, a: 1 },
    { r: 0, g: 0, b: 0, a: 1 },
    { r: 30, g: 120, b: 220, a: 1 },
    { r: 200, g: 40, b: 60, a: 0.5 },
  ]) {
    const back = mod.hslToRgb(mod.rgbToHsl(c));
    assert.ok(Math.abs(back.r - c.r) <= 1);
    assert.ok(Math.abs(back.g - c.g) <= 1);
    assert.ok(Math.abs(back.b - c.b) <= 1);
    assert.equal(back.a, c.a);
  }
});

test('background: white darkens to charcoal, black/dark is kept', () => {
  const white = mod.remapBackgroundColor('rgb(255,255,255)');
  assert.ok(white, 'white should remap');
  const hsl = mod.rgbToHsl(parse(white));
  assert.ok(hsl.l < 0.2, `charcoal lightness, got ${hsl.l}`);
  assert.equal(mod.remapBackgroundColor('rgb(20,20,22)'), null, 'already-dark bg kept');
  assert.equal(mod.remapBackgroundColor('rgba(0,0,0,0)'), null, 'transparent bg skipped');
});

test('foreground: black lightens to off-white, light text is kept', () => {
  const black = mod.remapForegroundColor('rgb(0,0,0)');
  assert.ok(black, 'black text should remap');
  const hsl = mod.rgbToHsl(parse(black));
  assert.ok(hsl.l > 0.85, `off-white lightness, got ${hsl.l}`);
  assert.equal(mod.remapForegroundColor('rgb(240,240,240)'), null, 'already-light text kept');
  assert.equal(mod.remapForegroundColor('transparent'), null, 'transparent text skipped');
});

test('hue is preserved when remapping (a light blue bg stays blue-ish)', () => {
  const remapped = mod.remapBackgroundColor('rgb(210,225,255)'); // light blue
  const hsl = mod.rgbToHsl(parse(remapped));
  assert.ok(hsl.h > 190 && hsl.h < 250, `hue kept blue-ish, got ${hsl.h}`);
});

test('alpha is preserved through a remap', () => {
  const r = mod.remapBackgroundColor('rgba(255,255,255,0.6)');
  assert.match(r, /rgba\(.*0\.6\)/);
});

// helper: parse an rgb()/rgba() string back to {r,g,b,a} for assertions
function parse(css) {
  const m = css.match(/rgba?\(([^)]+)\)/);
  const [r, g, b, a] = m[1].split(',').map((x) => parseFloat(x));
  return { r, g, b, a: a ?? 1 };
}
