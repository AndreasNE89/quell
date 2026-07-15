// Pure color logic for the dynamic dark-mode engine.
//
// Instead of inverting the whole page (which unavoidably hits images), the engine reads each
// element's OWN colors and remaps them onto a dark palette: light backgrounds → soft charcoal,
// dark text → gentle off-white, hues preserved. Media (img/video/canvas/…) is never remapped.
// No chrome.* / DOM here — unit-tested.

import { parseCssColor, type Rgb } from './dark-mode-smart.js';

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
  const h = ((((hsl.h % 360) + 360) % 360) / 360);
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
const BG_LIGHT_THRESHOLD = 0.35; // backgrounds lighter than this get darkened
const FG_DARK_THRESHOLD = 0.6; // text darker than this gets lightened

/** Root canvas + default text for the dark shell. */
export const ROOT_BG = 'rgb(28, 28, 30)'; // #1c1c1e — matte charcoal
export const ROOT_FG = 'rgb(232, 232, 232)'; // #e8e8e8 — gentle off-white

/**
 * Remap a background color: light → charcoal (hue preserved), keep already-dark backgrounds.
 * Returns a CSS color string, or null when there's nothing to do (transparent → let it inherit,
 * or already dark enough → keep the site's own dark surface).
 */
export function remapBackgroundColor(css: string): string | null {
  const rgb = parseCssColor(css);
  if (!rgb || rgb.a < 0.1) return null;
  const hsl = rgbToHsl(rgb);
  if (hsl.l < BG_LIGHT_THRESHOLD) return null;
  // Map lightness into a charcoal band; damp very-saturated light panels so they don't glow.
  const l = 0.1 + (1 - hsl.l) * 0.16; // white → 0.10, mid → ~0.18
  const s = hsl.s > 0.5 ? hsl.s * 0.55 : hsl.s;
  return rgbToCss(hslToRgb({ h: hsl.h, s, l, a: rgb.a }));
}

/**
 * Remap a foreground/text color: dark → soft off-white (hue preserved), keep already-light text.
 */
export function remapForegroundColor(css: string): string | null {
  const rgb = parseCssColor(css);
  if (!rgb || rgb.a < 0.1) return null;
  const hsl = rgbToHsl(rgb);
  if (hsl.l > FG_DARK_THRESHOLD) return null;
  const l = 0.92 - hsl.l * 0.22; // black → 0.92, mid → ~0.81
  return rgbToCss(hslToRgb({ h: hsl.h, s: hsl.s, l, a: rgb.a }));
}

/** Remap a border color down to a subtle dark tone; keep already-dark borders. */
export function remapBorderColor(css: string): string | null {
  const rgb = parseCssColor(css);
  if (!rgb || rgb.a < 0.1) return null;
  const hsl = rgbToHsl(rgb);
  if (hsl.l <= 0.34) return null;
  const l = 0.28;
  return rgbToCss(hslToRgb({ h: hsl.h, s: hsl.s * 0.7, l, a: rgb.a }));
}

/**
 * Remap the color stops of a CSS gradient value (a computed `background-image` like
 * `linear-gradient(rgb(255,255,255), rgb(240,240,240))`). Each rgb/rgba stop is run through the
 * background remap (light → charcoal), non-color parts (angles, positions, stop %) are left
 * intact, and dark/transparent stops are kept. Returns the value unchanged when nothing darkened.
 */
export function remapGradient(value: string): string {
  return value.replace(/rgba?\([^)]*\)/gi, (m) => remapBackgroundColor(m) ?? m);
}
