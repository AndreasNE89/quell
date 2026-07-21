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
  remapGradient, remapBackgroundImage, splitBackgroundLayers,
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

test('background: luminance-gated — perceptually light saturated colors darken too', () => {
  // #00a0a0 teal: HSL l≈0.31 (old HSL gate kept it light) but WCAG luminance ≈0.28 → darken.
  const teal = mod.remapBackgroundColor('rgb(0, 160, 160)');
  assert.ok(teal, 'saturated light teal must darken');
  const hsl = mod.rgbToHsl(parse(teal));
  assert.ok(hsl.l < 0.25, `darkened, got l=${hsl.l}`);
  assert.ok(hsl.h > 150 && hsl.h < 210, `hue preserved, got ${hsl.h}`);
});

test('background: translucent light overlays are kept (elevation layers, glass)', () => {
  // White at 12% over a darkened page reads as a subtle lift; darkening it flattens
  // dark-surface elevation into mud.
  assert.equal(mod.remapBackgroundColor('rgba(255,255,255,0.12)'), null);
  assert.equal(mod.remapBackgroundColor('rgba(255,255,255,0.4)'), null);
  // But mostly-opaque light surfaces still darken.
  assert.ok(mod.remapBackgroundColor('rgba(255,255,255,0.6)'));
});

test('foreground: black lightens to off-white, light text is kept', () => {
  const black = mod.remapForegroundColor('rgb(0,0,0)');
  assert.ok(black, 'black text should remap');
  const hsl = mod.rgbToHsl(parse(black));
  assert.ok(hsl.l > 0.85, `off-white lightness, got ${hsl.l}`);
  assert.equal(mod.remapForegroundColor('rgb(240,240,240)'), null, 'already-light text kept');
  assert.equal(mod.remapForegroundColor('transparent'), null, 'transparent text skipped');
});

test('foreground: luminance-gated — dim saturated blue lifts, bright yellow is kept', () => {
  // #6666ff: HSL l=0.7 (old gate kept it) but luminance ≈0.2 → sub-AA on charcoal → lift.
  const blue = mod.remapForegroundColor('rgb(102, 102, 255)');
  assert.ok(blue, 'dim saturated blue text must lighten');
  const hsl = mod.rgbToHsl(parse(blue));
  assert.ok(hsl.l > 0.7, `lifted, got l=${hsl.l}`);
  assert.ok(hsl.h > 200 && hsl.h < 280, `hue preserved, got ${hsl.h}`);
  // Bright saturated yellow (luminance ≈0.64) is already readable on dark → kept.
  assert.equal(mod.remapForegroundColor('rgb(255, 204, 0)'), null);
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

test('VG.no regression: display-p3 colors remap (dark text lightens, red bar darkens)', () => {
  const fg = mod.remapForegroundColor('color(display-p3 0.09696 0.00495 0.00255)');
  assert.ok(fg, 'display-p3 dark red headline text must remap');
  const fgHsl = mod.rgbToHsl(parse(fg));
  assert.ok(fgHsl.l > 0.8, `lightened for readability, got l=${fgHsl.l}`);

  const bg = mod.remapBackgroundColor('color(display-p3 0.86 0.12 0.11)'); // brand-red bar
  assert.ok(bg, 'bright display-p3 red background must darken');
  const bgHsl = mod.rgbToHsl(parse(bg));
  assert.ok(bgHsl.l < 0.25, `darkened to charcoal band, got l=${bgHsl.l}`);
});

test('gradient: light stops darken, dark stops kept, structure intact', () => {
  const light = mod.remapGradient('linear-gradient(90deg, rgb(255, 255, 255), rgb(240, 240, 240))');
  assert.match(light, /^linear-gradient\(90deg, rgb\(/, 'keeps direction + shape');
  assert.doesNotMatch(light, /rgb\(255, 255, 255\)/, 'white stop darkened');
  const dark = mod.remapGradient('linear-gradient(rgb(13, 17, 23), rgb(20, 20, 20))');
  assert.equal(dark, 'linear-gradient(rgb(13, 17, 23), rgb(20, 20, 20))', 'dark gradient unchanged');
});

test('gradient fg mode lightens dark stops (background-clip:text headlines)', () => {
  const g = mod.remapGradient('linear-gradient(90deg, rgb(20, 20, 20), rgb(60, 20, 90))', 'fg');
  assert.doesNotMatch(g, /rgb\(20, 20, 20\)/, 'dark stop lightened');
  const hsl = mod.rgbToHsl(parse(g.match(/rgba?\([^)]*\)/)[0]));
  assert.ok(hsl.l > 0.8, `text-paint stop is light, got l=${hsl.l}`);
});

test('gradient with modern color stops darkens too', () => {
  const g = mod.remapGradient('linear-gradient(color(display-p3 1 1 1), rgb(255, 255, 255))');
  assert.doesNotMatch(g, /display-p3 1 1 1/, 'p3 white stop replaced');
  assert.doesNotMatch(g, /rgb\(255, 255, 255\)/, 'rgb white stop replaced');
});

test('splitBackgroundLayers: parens-aware (data-URI commas do not split)', () => {
  const layers = mod.splitBackgroundLayers(
    'linear-gradient(rgb(1, 2, 3), rgb(4, 5, 6)), url("data:image/png;base64,AAA,BBB")',
  );
  assert.equal(layers.length, 2);
  assert.match(layers[0], /^linear-gradient/);
  assert.match(layers[1], /^url\(/);
});

test('remapBackgroundImage: composite scrim + photo darkens the scrim, leaves the url()', () => {
  const out = mod.remapBackgroundImage(
    'linear-gradient(rgba(255, 255, 255, 0.92), rgba(255, 255, 255, 0.92)), url("https://x/hero.jpg")',
  );
  assert.ok(out, 'composite must be remapped');
  assert.match(out, /url\("https:\/\/x\/hero\.jpg"\)/, 'photo layer untouched');
  assert.doesNotMatch(out, /rgba\(255, 255, 255, 0\.92\)/, 'white scrim darkened');
  assert.equal(mod.remapBackgroundImage('url("https://x/a.png")'), null, 'pure image → no-op');
  assert.equal(mod.remapBackgroundImage('none'), null);
});

// helper: parse an rgb()/rgba() string back to {r,g,b,a} for assertions
function parse(css) {
  const m = css.match(/rgba?\(([^)]+)\)/);
  const [r, g, b, a] = m[1].split(',').map((x) => parseFloat(x));
  return { r, g, b, a: a ?? 1 };
}
