// Pure color logic for the dynamic dark-mode engine.
//
// Instead of inverting the whole page (which unavoidably hits images), the engine reads each
// element's OWN colors and remaps them onto a dark palette: light backgrounds → soft charcoal,
// dark text → gentle off-white, hues preserved. Media (img/video/canvas/…) is never remapped.
// No chrome.* / DOM here — unit-tested.
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
const BG_KEEP_LUMINANCE = 0.15; // backgrounds dimmer than this are kept (already dark)
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
