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
  const outfile = join(tmpdir(), `quell-dark-smart-${process.pid}.mjs`);
  await build({
    stdin: {
      contents: `export {
  relativeLuminance,
  contrastRatio,
  parseCssColor,
  luminanceOfCssColor,
  isConfidentlyAlreadyDark,
  buildSmartDarkCss,
  buildDarkResetCss,
} from './src/shared/dark-mode-smart.js';`,
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

test('should compute relative luminance for black and white', () => {
  assert.ok(mod.relativeLuminance(0, 0, 0) < 0.01);
  assert.ok(mod.relativeLuminance(255, 255, 255) > 0.99);
});

test('should parse hex and rgb colors', () => {
  assert.deepEqual(mod.parseCssColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(mod.parseCssColor('#112233'), { r: 0x11, g: 0x22, b: 0x33, a: 1 });
  const rgb = mod.parseCssColor('rgb(10, 20, 30)');
  assert.equal(rgb.r, 10);
  assert.equal(rgb.g, 20);
  assert.equal(rgb.b, 30);
  assert.equal(mod.parseCssColor('transparent').a, 0);
  assert.equal(mod.parseCssColor('color(rec2020 1 0 0)'), null, 'unknown space → null (kept)');
});

test('should parse CSS Color 4 functions with correct conversion', () => {
  const near = (got, want, tol, label) =>
    assert.ok(Math.abs(got - want) <= tol, `${label}: got ${got}, want ~${want}`);

  // display-p3 shares the D65 white point → white maps to white, black to black.
  const w = mod.parseCssColor('color(display-p3 1 1 1)');
  near(w.r, 255, 1.5, 'p3 white r'); near(w.g, 255, 1.5, 'p3 white g'); near(w.b, 255, 1.5, 'p3 white b');
  const blk = mod.parseCssColor('color(display-p3 0 0 0)');
  near(blk.r, 0, 0.5, 'p3 black');

  // The exact color VG.no's headlines use — must parse to a very dark red.
  const vg = mod.parseCssColor('color(display-p3 0.09696 0.00495 0.00255)');
  assert.ok(vg, 'VG display-p3 dark red parses');
  near(vg.r, 28, 3, 'vg r'); near(vg.g, 0, 2, 'vg g'); near(vg.b, 0, 2, 'vg b');

  // oklch of pure sRGB red (L=0.628 C=0.2577 H=29.23) → rgb(255,0,0)-ish.
  const red = mod.parseCssColor('oklch(0.628 0.2577 29.23)');
  near(red.r, 255, 4, 'oklch red r'); near(red.g, 0, 5, 'oklch red g'); near(red.b, 0, 5, 'oklch red b');

  // CIELAB neutral gray: L*=53.585 → Y≈0.2159 → rgb(128,128,128) (Bradford keeps neutrals).
  const gray = mod.parseCssColor('lab(53.585 0 0)');
  near(gray.r, 128, 2, 'lab gray r'); near(gray.g, 128, 2, 'lab gray g'); near(gray.b, 128, 2, 'lab gray b');

  // hsl / hwb basics + alpha forms.
  const green = mod.parseCssColor('hsl(120 100% 25%)');
  near(green.g, 127.5, 1, 'hsl green g'); near(green.r, 0, 0.5, 'hsl green r');
  const hwbRed = mod.parseCssColor('hwb(0 0% 0%)');
  near(hwbRed.r, 255, 0.5, 'hwb red');
  assert.equal(mod.parseCssColor('color(display-p3 1 0 0 / 0.5)').a, 0.5);
  assert.equal(mod.parseCssColor('oklch(0.5 0.1 30 / 50%)').a, 0.5);
});

test('should treat transparent as missing luminance', () => {
  assert.equal(mod.luminanceOfCssColor('transparent'), null);
  assert.equal(mod.luminanceOfCssColor('rgba(0,0,0,0)'), null);
  assert.ok(mod.luminanceOfCssColor('#111') < 0.05);
});

test('should detect color-scheme dark as high confidence', () => {
  const v = mod.isConfidentlyAlreadyDark({
    htmlBgLuminance: 0.3,
    bodyBgLuminance: null,
    htmlTextLuminance: 0.8,
    bodyTextLuminance: null,
    htmlColorScheme: 'dark',
    bodyColorScheme: '',
    metaThemeLuminance: null,
  });
  assert.equal(v.dark, true);
  assert.equal(v.confidence, 'high');
});

test('should detect very dark background as high confidence', () => {
  const v = mod.isConfidentlyAlreadyDark({
    htmlBgLuminance: 0.08,
    bodyBgLuminance: 0.1,
    htmlTextLuminance: 0.7,
    bodyTextLuminance: 0.7,
    htmlColorScheme: 'normal',
    bodyColorScheme: '',
    metaThemeLuminance: null,
  });
  assert.equal(v.dark, true);
  assert.equal(v.confidence, 'high');
});

test('should not auto-flag bright light pages', () => {
  const v = mod.isConfidentlyAlreadyDark({
    htmlBgLuminance: 0.96,
    bodyBgLuminance: 0.96,
    htmlTextLuminance: 0.1,
    bodyTextLuminance: 0.1,
    htmlColorScheme: 'light',
    bodyColorScheme: '',
    metaThemeLuminance: 0.9,
  });
  assert.equal(v.dark, false);
  assert.equal(v.confidence, 'none');
});

test('should keep borderline dark at low confidence', () => {
  const v = mod.isConfidentlyAlreadyDark({
    htmlBgLuminance: 0.25,
    bodyBgLuminance: 0.25,
    htmlTextLuminance: 0.5,
    bodyTextLuminance: 0.5,
    htmlColorScheme: '',
    bodyColorScheme: '',
    metaThemeLuminance: null,
  });
  assert.equal(v.dark, true);
  assert.equal(v.confidence, 'low');
});

test('smart CSS is a clean symmetric invert (no contrast/bg/color-scheme that would touch images)', () => {
  const css = mod.buildSmartDarkCss({
    htmlBgLuminance: 0.97,
    bodyBgLuminance: 0.97,
    htmlTextLuminance: 0.05,
    bodyTextLuminance: 0.05,
    htmlColorScheme: '',
    bodyColorScheme: '',
    metaThemeLuminance: null,
  });
  assert.match(css, /invert\(1\) hue-rotate\(180deg\)/);
  // The media re-invert must be the exact inverse of the html filter so images cancel to
  // natural — i.e. NO contrast (a >1 contrast clamps and distorts them), NO forced bg/scheme.
  assert.doesNotMatch(css, /contrast/);
  assert.doesNotMatch(css, /color-scheme/);
  assert.doesNotMatch(css, /background-color/);
});

test('should emit reset CSS that clears invert', () => {
  const css = mod.buildDarkResetCss();
  assert.match(css, /filter:\s*none/);
});

test('should report WCAG-ish contrast ratio', () => {
  const black = mod.relativeLuminance(0, 0, 0);
  const white = mod.relativeLuminance(255, 255, 255);
  assert.ok(mod.contrastRatio(white, black) > 20);
});
