// Pure color logic for the dynamic dark-mode engine.
//
// Instead of inverting the whole page (which unavoidably hits images), the engine reads each
// element's OWN colors and remaps them onto a dark palette: light backgrounds → soft charcoal,
// dark text → gentle off-white, hues preserved. Media (img/video/canvas/…) is never remapped;
// the one exception is a transparent image drawn in flat dark ink (isDarkInkImage), which the
// engine inverts so it does not vanish. No chrome.* / DOM here — unit-tested.
//
// Keep/remap decisions use WCAG relative luminance, not HSL lightness: HSL "l" badly misjudges
// saturated hues (a teal #00a0a0 has l≈0.31 but reads mid-light; saturated blue #6666ff has
// l=0.7 but is dim on charcoal). Remap targets still use HSL so hue/saturation are preserved.

import { parseCssColor, relativeLuminance, type Rgb } from './dark-mode-smart.js';

export interface Hsl {
  h: number; // 0–360
  s: number; // 0–1
  l: number; // 0–1
  a: number; // 0–1
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function rgbToHsl(rgb: Rgb): Hsl {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h: h * 360, s, l, a: rgb.a };
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

export function hslToRgb(hsl: Hsl): Rgb {
  const h = (((hsl.h % 360) + 360) % 360) / 360;
  const s = clamp01(hsl.s);
  const l = clamp01(hsl.l);
  let r: number;
  let g: number;
  let b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return { r: r * 255, g: g * 255, b: b * 255, a: hsl.a };
}

export function rgbToCss(rgb: Rgb): string {
  const r = Math.round(clamp01(rgb.r / 255) * 255);
  const g = Math.round(clamp01(rgb.g / 255) * 255);
  const b = Math.round(clamp01(rgb.b / 255) * 255);
  if (rgb.a < 1) return `rgba(${r}, ${g}, ${b}, ${Math.round(rgb.a * 1000) / 1000})`;
  return `rgb(${r}, ${g}, ${b})`;
}

// Palette / tuning knobs (iterate on these for taste).
export const BG_KEEP_LUMINANCE = 0.15; // backgrounds dimmer than this are kept (already dark)
const FG_KEEP_LUMINANCE = 0.45; // text brighter than this is kept (already light enough)
const BORDER_KEEP_LUMINANCE = 0.18;

/** Root canvas + default text for the dark shell. */
export const ROOT_BG = 'rgb(28, 28, 30)'; // #1c1c1e — matte charcoal
export const ROOT_FG = 'rgb(232, 232, 232)'; // #e8e8e8 — gentle off-white

function lumOf(rgb: Rgb): number {
  return relativeLuminance(rgb.r, rgb.g, rgb.b);
}

/**
 * Remap a background color: light → charcoal (hue preserved). Returns null when there's
 * nothing to do: transparent (inherit), already-dark (keep the site's own dark surface), or a
 * translucent light overlay (glass/elevation layers read correctly over the darkened page —
 * darkening them flattens dark-surface elevation into mud).
 */
export function remapBackgroundColor(css: string): string | null {
  const rgb = parseCssColor(css);
  if (!rgb || rgb.a < 0.1) return null;
  const lum = lumOf(rgb);
  if (rgb.a < 0.5 && lum > 0.5) return null;
  if (lum < BG_KEEP_LUMINANCE) return null;
  const hsl = rgbToHsl(rgb);
  // Map lightness into a charcoal band; damp very-saturated light panels so they don't glow.
  const l = 0.1 + (1 - hsl.l) * 0.16; // white → 0.10, mid → ~0.18
  const s = hsl.s > 0.5 ? hsl.s * 0.55 : hsl.s;
  return rgbToCss(hslToRgb({ h: hsl.h, s, l, a: rgb.a }));
}

/**
 * Remap a foreground/text color: dark → soft off-white (hue preserved), keep already-light
 * text. Luminance-gated so dim saturated colors (blues) get lifted too.
 */
export function remapForegroundColor(css: string): string | null {
  const rgb = parseCssColor(css);
  if (!rgb || rgb.a < 0.1) return null;
  if (lumOf(rgb) > FG_KEEP_LUMINANCE) return null;
  const hsl = rgbToHsl(rgb);
  const l = 0.92 - hsl.l * 0.22; // black → 0.92, mid → ~0.81
  return rgbToCss(hslToRgb({ h: hsl.h, s: hsl.s, l, a: rgb.a }));
}

/** Remap a border color down to a subtle dark tone; keep already-dark borders. */
export function remapBorderColor(css: string): string | null {
  const rgb = parseCssColor(css);
  if (!rgb || rgb.a < 0.1) return null;
  if (lumOf(rgb) < BORDER_KEEP_LUMINANCE) return null;
  const hsl = rgbToHsl(rgb);
  const l = 0.28;
  return rgbToCss(hslToRgb({ h: hsl.h, s: hsl.s * 0.7, l, a: rgb.a }));
}

/**
 * Remap the color stops of a CSS gradient value. kind 'bg' darkens light stops (normal
 * background gradients); kind 'fg' lightens dark stops (background-clip:text gradient
 * headlines, where the gradient IS the text paint — darkening it makes headlines invisible).
 * Non-color parts (angles, positions) are untouched; unchanged when nothing remaps.
 */
export function remapGradient(value: string, kind: 'bg' | 'fg' = 'bg'): string {
  const remap = kind === 'fg' ? remapForegroundColor : remapBackgroundColor;
  return value.replace(
    /(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)/gi,
    (m) => remap(m) ?? m,
  );
}

/** Split a computed multi-background value on top-level commas (parens-aware, so commas
 *  inside gradient(...) / url("data:...,...") never split). */
export function splitBackgroundLayers(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Remap a computed background-image: gradient layers get their stops remapped, url()/image
 * layers pass through untouched (never touch media). Handles composites like
 * `linear-gradient(...), url("hero.jpg")` — the white scrim darkens, the photo doesn't.
 * Returns null when nothing changed.
 */
export function remapBackgroundImage(value: string, kind: 'bg' | 'fg' = 'bg'): string | null {
  if (!value || value === 'none' || !value.includes('gradient(')) return null;
  const layers = splitBackgroundLayers(value);
  let changed = false;
  const out = layers.map((layer) => {
    if (!layer.includes('gradient(') || layer.includes('url(')) return layer;
    const remapped = remapGradient(layer, kind);
    if (remapped !== layer) changed = true;
    return remapped;
  });
  return changed ? out.join(', ') : null;
}

/**
 * Near-black, low-chroma paint: monochrome icon ink and navy wordmarks (Stripe's #031323) that
 * vanish on a darkened surface. Vivid colors are rarely this dark, so the gate protects artwork.
 */
export function isDarkInkColor(css: string): boolean {
  const rgb = parseCssColor(css);
  if (!rgb || rgb.a < 0.5) return false;
  if (lumOf(rgb) >= 0.15) return false;
  return Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b) <= 90;
}

type Repeat = 'repeat' | 'space' | 'round' | 'no-repeat';

function repeatAxes(value: string): [Repeat, Repeat] {
  const t = value.trim().split(/\s+/);
  if (t[0] === 'repeat-x') return ['repeat', 'no-repeat'];
  if (t[0] === 'repeat-y') return ['no-repeat', 'repeat'];
  const x = (t[0] || 'repeat') as Repeat;
  return [x, (t[1] as Repeat | undefined) ?? x];
}

/** One background-size component against the box edge it sizes; null for `auto`. */
function sizeFraction(token: string | undefined, edge: number): number | null {
  if (!token || token === 'auto') return null;
  const v = parseFloat(token);
  if (Number.isNaN(v)) return null;
  if (token.endsWith('%')) return v / 100;
  return edge > 0 ? v / edge : 1;
}

/**
 * Whether any url() layer of a computed background plausibly paints the whole box — a photo,
 * pattern or tiled texture the engine refuses to darken, so text over it keeps its own color.
 *
 * A small untiled image does not: search-box magnifiers, list bullets and sprite icons sit in a
 * corner of a surface whose background COLOR the engine darkens, and treating them as a light
 * photo left dark text on charcoal (REVIEW_2026-09-24 B65). An untiled auto-sized image in a big
 * box stays "covering": it is usually a hero picture whose size the computed style cannot tell.
 */
export function urlLayersCoverBox(
  image: string,
  size: string,
  repeat: string,
  boxW: number,
  boxH: number,
): boolean {
  if (!image || !image.includes('url(')) return false;
  const layers = splitBackgroundLayers(image);
  const sizes = splitBackgroundLayers(size || 'auto');
  const repeats = splitBackgroundLayers(repeat || 'repeat');
  for (let i = 0; i < layers.length; i++) {
    if (!layers[i].includes('url(')) continue;
    const [rx, ry] = repeatAxes(repeats[i % repeats.length] ?? 'repeat');
    // Tiled in either direction: a texture or a header strip, not an icon.
    if (rx !== 'no-repeat' || ry !== 'no-repeat') return true;
    const s = (sizes[i % sizes.length] ?? 'auto').trim();
    if (s === 'cover' || s === 'contain') return true;
    const [sw, sh] = s.split(/\s+/);
    const fw = sizeFraction(sw, boxW);
    const fh = sizeFraction(sh ?? 'auto', boxH);
    if (fw == null && fh == null) {
      if (boxW >= 240 && boxH >= 120) return true;
      continue;
    }
    if ((fw ?? fh ?? 0) >= 0.5 && (fh ?? fw ?? 0) >= 0.5) return true;
  }
  return false;
}

const NUMERIC_TOKEN = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?(?:%|[a-z]+)?$/i;
const COLOR_FUNCTION = /#|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark|(?:repeating-)?(?:linear|radial|conic)-gradient|var)\(/i;

/**
 * Could this custom-property value feed a color? Scroll- and pointer-driven variables
 * (`--scroll-y: 412`, `--x: 37.5%`, `--vh: 7.2px`) cannot, and re-walking a subtree for each of
 * their per-frame writes cost a long task every frame (REVIEW_2026-09-24 B72). Anything
 * ambiguous counts as a color: channel triples (`255 255 255`, `0 0% 100%`) and var() chains.
 * `isColorKeyword` decides bare words (the engine passes CSS.supports).
 */
export function mightBeColorValue(
  value: string,
  isColorKeyword: (word: string) => boolean = () => true,
): boolean {
  const v = value.trim();
  if (!v) return false;
  if (COLOR_FUNCTION.test(v)) return true;
  let numbers = 0;
  for (const token of v.split(/[\s,/]+/)) {
    if (!token) continue;
    if (NUMERIC_TOKEN.test(token)) numbers++;
    else if (/^[a-z-]+$/i.test(token) && isColorKeyword(token)) return true;
  }
  return numbers >= 3;
}

/** Inline properties whose change can alter what the engine reads or writes on an element. */
export function isColorRelevantProperty(prop: string): boolean {
  return /^(?:background|border|color|fill|stroke|-webkit-text-fill-color|outline-color|all$)/.test(
    prop,
  );
}

/**
 * Pixels (RGBA, e.g. a downscaled getImageData) of an image drawn in flat dark ink on a
 * transparent background: a formula, a line diagram, a monochrome logo. Those vanish on the
 * darkened page (REVIEW_2026-09-24 M4); inverting them is safe. Photos fail the flatness test:
 * their opaque pixels spread across tones.
 */
export function isDarkInkImage(data: ArrayLike<number>): boolean {
  let transparent = 0;
  let opaque = 0;
  let ink = 0;
  const total = Math.floor(data.length / 4);
  if (!total) return false;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 26) {
      transparent++;
      continue;
    }
    if (a < 128) continue; // anti-aliased edge: neither ink nor background
    opaque++;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (
      relativeLuminance(r, g, b) < 0.1 &&
      Math.max(r, g, b) - Math.min(r, g, b) <= 60
    ) {
      ink++;
    }
  }
  return transparent / total >= 0.2 && opaque / total >= 0.01 && ink / opaque >= 0.85;
}
