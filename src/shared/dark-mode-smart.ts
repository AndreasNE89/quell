// Pure helpers for smart dark mode: color math, already-dark detection, CSS builder.
// No chrome.* — unit-tested.

export interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Page signals gathered by the content script (pre-computed luminances). */
export interface DarkPageSignals {
  htmlBgLuminance: number | null;
  bodyBgLuminance: number | null;
  htmlTextLuminance: number | null;
  bodyTextLuminance: number | null;
  /** Computed `color-scheme` on html (e.g. "dark", "light", "normal"). */
  htmlColorScheme: string;
  bodyColorScheme: string;
  metaThemeLuminance: number | null;
}

export interface AlreadyDarkVerdict {
  dark: boolean;
  /** Only persist auto-off when high. */
  confidence: 'high' | 'low' | 'none';
  reason: string;
}

/** WCAG relative luminance (sRGB 0–255). */
export function relativeLuminance(r: number, g: number, b: number): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two relative luminances. */
export function contrastRatio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Parse CSS color values as serialized by getComputedStyle: `#rgb(a)` hex, `rgb()/rgba()`,
 * plus the CSS Color 4 forms Chrome preserves in computed styles — `color(display-p3 …)`,
 * `color(srgb …)`, `oklch()`, `oklab()`, `lab()`, `lch()`, `hsl()`, `hwb()`. Wide-gamut values
 * are converted to (clamped) sRGB. Returns null for unknown forms (safe: the caller keeps the
 * original color). Sites like vg.no define their whole palette in display-p3, so missing these
 * means the dynamic dark engine silently skips every element.
 */
export function parseCssColor(input: string): Rgb | null {
  const s = input.trim().toLowerCase();
  if (!s || s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

  if (s.startsWith('#')) {
    const h = s.slice(1);
    if (h.length === 3 || h.length === 4) {
      const r = parseInt(h[0] + h[0], 16);
      const g = parseInt(h[1] + h[1], 16);
      const b = parseInt(h[2] + h[2], 16);
      const a = h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1;
      if ([r, g, b].some((n) => Number.isNaN(n))) return null;
      return { r, g, b, a };
    }
    if (h.length === 6 || h.length === 8) {
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      if ([r, g, b].some((n) => Number.isNaN(n))) return null;
      return { r, g, b, a };
    }
    return null;
  }

  const m = s.match(
    /^rgba?\(\s*([+-]?[\d.]+%?)\s*[,\s]\s*([+-]?[\d.]+%?)\s*[,\s]\s*([+-]?[\d.]+%?)(?:\s*[,/]\s*([+-]?[\d.]+%?))?\s*\)$/,
  );
  if (!m) return parseModernColor(s);

  const chan = (raw: string): number => {
    if (raw.endsWith('%')) return Math.max(0, Math.min(255, (parseFloat(raw) / 100) * 255));
    return Math.max(0, Math.min(255, parseFloat(raw)));
  };
  const r = chan(m[1]);
  const g = chan(m[2]);
  const b = chan(m[3]);
  let a = 1;
  if (m[4] != null) {
    a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    if (Number.isNaN(a)) a = 1;
  }
  if ([r, g, b].some((n) => Number.isNaN(n))) return null;
  return { r, g, b, a };
}

// ---------------------------------------------------------------------------
// CSS Color 4 functional notations. Chrome serializes computed colors in the
// author's color space, so `color(display-p3 …)` / `oklch()` / `lab()` reach the
// engine verbatim and must be converted to sRGB here.
// ---------------------------------------------------------------------------

type Vec3 = [number, number, number];

function srgbDecode(c: number): number {
  const a = Math.abs(c);
  const v = a <= 0.04045 ? a / 12.92 : ((a + 0.055) / 1.055) ** 2.4;
  return c < 0 ? -v : v;
}

function srgbEncode(c: number): number {
  const a = Math.abs(c);
  const v = a <= 0.0031308 ? a * 12.92 : 1.055 * a ** (1 / 2.4) - 0.055;
  return c < 0 ? -v : v;
}

function mul3(m: number[], v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

// prettier-ignore
const P3_TO_XYZ = [
  0.4865709486, 0.2656676932, 0.1982172852,
  0.2289745641, 0.6917385218, 0.0792869141,
  0.0,          0.0451133819, 1.0439443689,
];
// prettier-ignore
const XYZ_TO_SRGB = [
   3.2409699419, -1.5373831776, -0.4986107603,
  -0.9692436363,  1.8759675015,  0.0415550574,
   0.0556300797, -0.2039769589,  1.0569715142,
];
// Bradford chromatic adaptation D50 → D65 (CSS lab()/lch() use a D50 white point).
// prettier-ignore
const D50_TO_D65 = [
   0.9554734527, -0.0230985369, 0.0632593087,
  -0.0283697070,  1.0099954580, 0.0210413990,
   0.0123140017, -0.0205076964, 1.3303659366,
];

function linearSrgbToRgb(lin: Vec3, alpha: number): Rgb {
  const clamp = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
  return {
    r: clamp(srgbEncode(lin[0])) * 255,
    g: clamp(srgbEncode(lin[1])) * 255,
    b: clamp(srgbEncode(lin[2])) * 255,
    a: alpha,
  };
}

function oklabToRgb(L: number, a: number, b: number, alpha: number): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return linearSrgbToRgb(
    [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ],
    alpha,
  );
}

function labToRgb(L: number, a: number, b: number, alpha: number): Rgb {
  // CIELAB (D50) → XYZ(D50) → Bradford → XYZ(D65) → sRGB.
  const e = 216 / 24389;
  const k = 24389 / 27;
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const xr = fx ** 3 > e ? fx ** 3 : (116 * fx - 16) / k;
  const yr = L > k * e ? fy ** 3 : L / k;
  const zr = fz ** 3 > e ? fz ** 3 : (116 * fz - 16) / k;
  const xyzD50: Vec3 = [xr * 0.9642956764, yr, zr * 0.8251046025];
  return linearSrgbToRgb(mul3(XYZ_TO_SRGB, mul3(D50_TO_D65, xyzD50)), alpha);
}

/** CSS Color 4 HSL→RGB channel (h degrees, s/l 0–1; n = 0|8|4 for r|g|b). */
function hslChannel(h: number, s: number, l: number, n: number): number {
  const k = (((n + h / 30) % 12) + 12) % 12;
  const a = s * Math.min(l, 1 - l);
  return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
}

function parseModernColor(s: string): Rgb | null {
  const m = /^([a-z-]+)\(([^()]*)\)$/.exec(s);
  if (!m) return null;
  const fn = m[1];
  let body = m[2].trim();

  let alpha = 1;
  const slash = body.indexOf('/');
  if (slash !== -1) {
    const rawA = body.slice(slash + 1).trim();
    body = body.slice(0, slash).trim();
    const av = rawA === 'none' ? 0 : rawA.endsWith('%') ? parseFloat(rawA) / 100 : parseFloat(rawA);
    if (Number.isNaN(av)) return null;
    alpha = Math.max(0, Math.min(1, av));
  }
  const toks = body.split(/[\s,]+/).filter(Boolean);

  // One component: number, percentage (scaled per-channel), 'none' → 0, optional deg suffix.
  const comp = (tok: string | undefined, pctScale: number): number | null => {
    if (tok == null) return null;
    if (tok === 'none') return 0;
    const t = tok.endsWith('deg') ? tok.slice(0, -3) : tok;
    if (t.endsWith('%')) {
      const v = parseFloat(t);
      return Number.isNaN(v) ? null : (v / 100) * pctScale;
    }
    const v = parseFloat(t);
    return Number.isNaN(v) ? null : v;
  };
  const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

  switch (fn) {
    case 'color': {
      const space = toks.shift();
      const c1 = comp(toks[0], 1);
      const c2 = comp(toks[1], 1);
      const c3 = comp(toks[2], 1);
      if (space == null || c1 == null || c2 == null || c3 == null) return null;
      switch (space) {
        case 'srgb':
          return { r: clamp01(c1) * 255, g: clamp01(c2) * 255, b: clamp01(c3) * 255, a: alpha };
        case 'srgb-linear':
          return linearSrgbToRgb([c1, c2, c3], alpha);
        case 'display-p3':
          return linearSrgbToRgb(
            mul3(XYZ_TO_SRGB, mul3(P3_TO_XYZ, [srgbDecode(c1), srgbDecode(c2), srgbDecode(c3)])),
            alpha,
          );
        case 'xyz':
        case 'xyz-d65':
          return linearSrgbToRgb(mul3(XYZ_TO_SRGB, [c1, c2, c3]), alpha);
        case 'xyz-d50':
          return linearSrgbToRgb(mul3(XYZ_TO_SRGB, mul3(D50_TO_D65, [c1, c2, c3])), alpha);
        default:
          return null; // a98-rgb / prophoto-rgb / rec2020 — rare; keep the original color
      }
    }
    case 'oklab': {
      const L = comp(toks[0], 1);
      const a = comp(toks[1], 0.4);
      const b = comp(toks[2], 0.4);
      if (L == null || a == null || b == null) return null;
      return oklabToRgb(L, a, b, alpha);
    }
    case 'oklch': {
      const L = comp(toks[0], 1);
      const C = comp(toks[1], 0.4);
      const H = comp(toks[2], 1);
      if (L == null || C == null || H == null) return null;
      const hr = (H * Math.PI) / 180;
      return oklabToRgb(L, C * Math.cos(hr), C * Math.sin(hr), alpha);
    }
    case 'lab': {
      const L = comp(toks[0], 100);
      const a = comp(toks[1], 125);
      const b = comp(toks[2], 125);
      if (L == null || a == null || b == null) return null;
      return labToRgb(L, a, b, alpha);
    }
    case 'lch': {
      const L = comp(toks[0], 100);
      const C = comp(toks[1], 150);
      const H = comp(toks[2], 1);
      if (L == null || C == null || H == null) return null;
      const hr = (H * Math.PI) / 180;
      return labToRgb(L, C * Math.cos(hr), C * Math.sin(hr), alpha);
    }
    case 'hsl':
    case 'hsla': {
      const h = comp(toks[0], 1);
      const sat = comp(toks[1], 1);
      const l = comp(toks[2], 1);
      if (h == null || sat == null || l == null) return null;
      if (toks[3] != null) {
        const a4 = comp(toks[3], 1);
        if (a4 != null) alpha = Math.max(0, Math.min(1, a4));
      }
      const ss = clamp01(sat);
      const ll = clamp01(l);
      return {
        r: hslChannel(h, ss, ll, 0) * 255,
        g: hslChannel(h, ss, ll, 8) * 255,
        b: hslChannel(h, ss, ll, 4) * 255,
        a: alpha,
      };
    }
    case 'hwb': {
      const h = comp(toks[0], 1);
      const w = comp(toks[1], 1);
      const bk = comp(toks[2], 1);
      if (h == null || w == null || bk == null) return null;
      const ww = clamp01(w);
      const bb = clamp01(bk);
      if (ww + bb >= 1) {
        const gray = (ww / (ww + bb)) * 255;
        return { r: gray, g: gray, b: gray, a: alpha };
      }
      const f = (n: number): number => (hslChannel(h, 1, 0.5, n) * (1 - ww - bb) + ww) * 255;
      return { r: f(0), g: f(8), b: f(4), a: alpha };
    }
    default:
      return null;
  }
}

/** Luminance of a CSS color, or null if transparent / unparseable. */
export function luminanceOfCssColor(color: string): number | null {
  const rgb = parseCssColor(color);
  if (!rgb || rgb.a < 0.5) return null;
  return relativeLuminance(rgb.r, rgb.g, rgb.b);
}

function schemeLooksDark(scheme: string): boolean {
  const parts = scheme.toLowerCase().split(/\s+/);
  return parts.includes('dark') && !parts.includes('only');
}

/**
 * High-confidence already-dark detection.
 * Prefers explicit color-scheme / very dark backgrounds + light text over weak signals.
 */
export function isConfidentlyAlreadyDark(signals: DarkPageSignals): AlreadyDarkVerdict {
  const bgCandidates = [signals.htmlBgLuminance, signals.bodyBgLuminance].filter(
    (n): n is number => n != null,
  );
  const bg = bgCandidates.length ? Math.min(...bgCandidates) : null;
  const textCandidates = [signals.htmlTextLuminance, signals.bodyTextLuminance].filter(
    (n): n is number => n != null,
  );
  const text = textCandidates.length ? Math.max(...textCandidates) : null;

  const schemeDark =
    schemeLooksDark(signals.htmlColorScheme) || schemeLooksDark(signals.bodyColorScheme);

  // Explicit color-scheme: dark + not a light background
  if (schemeDark && (bg == null || bg < 0.45)) {
    return {
      dark: true,
      confidence: 'high',
      reason: 'color-scheme: dark',
    };
  }

  // Very dark background
  if (bg != null && bg < 0.12) {
    return {
      dark: true,
      confidence: 'high',
      reason: `bg luminance ${bg.toFixed(3)}`,
    };
  }

  // Dark bg + light text (classic dark theme)
  if (bg != null && bg < 0.22 && text != null && text > 0.55) {
    return {
      dark: true,
      confidence: 'high',
      reason: `dark bg (${bg.toFixed(3)}) + light text (${text.toFixed(3)})`,
    };
  }

  // Meta theme-color dark + supporting dark bg
  if (
    signals.metaThemeLuminance != null &&
    signals.metaThemeLuminance < 0.2 &&
    bg != null &&
    bg < 0.3
  ) {
    return {
      dark: true,
      confidence: 'high',
      reason: 'dark theme-color + dark bg',
    };
  }

  // Borderline — do not auto-persist
  if (bg != null && bg < 0.28 && text != null && text > 0.45) {
    return {
      dark: true,
      confidence: 'low',
      reason: `borderline dark (${bg.toFixed(3)})`,
    };
  }

  return { dark: false, confidence: 'none', reason: 'looks light' };
}

/** Selector for elements the page-wide invert must NOT touch (media + inline bg images).
 *  Exported so the content script can re-apply the same re-invert inside shadow roots. */
export const MEDIA_REINVERT = `img, video, picture, canvas, svg, iframe, embed, object,
[style*="background-image"],
[style*="background:url"],
[style*="background: url"]`;

/** The rule that re-inverts media so it cancels back to natural under the page filter. */
export const MEDIA_REINVERT_RULE = `${MEDIA_REINVERT} { filter: invert(1) hue-rotate(180deg) !important; }`;

/**
 * Build a smart dark stylesheet for a light page.
 * Uses a controlled invert stack (pre-light bg → consistent dark) + contrast bump when needed.
 * Injected with `data-stampstack="dark-smart"` and overrides FOUC registered invert.
 */
export function buildSmartDarkCss(_signals: DarkPageSignals): string {
  // Symmetric clean invert so media cancels to its natural appearance (see dark-mode.css).
  // No contrast: an ancestor contrast also hits media and clamps, visibly distorting images.
  // No forced background-color / color-scheme: forcing background would pollute the content
  // script's already-dark re-sample, and color-scheme:dark under invert mis-paints controls.
  return `/* StampStack smart dark — clean invert */
html {
  filter: invert(1) hue-rotate(180deg) !important;
}
${MEDIA_REINVERT} {
  filter: invert(1) hue-rotate(180deg) !important;
}
`;
}

/** CSS that cancels registered invert (already-dark / auto-skip). Only the filter needs
 * neutralizing — the FOUC sheet no longer forces background-color or color-scheme, so the
 * site's own colors and color-scheme show through untouched. */
export function buildDarkResetCss(): string {
  return `/* StampStack dark reset — site already dark */
html {
  filter: none !important;
}
${MEDIA_REINVERT} {
  filter: none !important;
}
`;
}
