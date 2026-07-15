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
 * Parse common CSS color forms: `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`.
 * Returns null for unsupported (named colors, `lab()`, etc.).
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
  if (!m) return null;

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

const MEDIA_REINVERT = `img, video, picture, canvas, svg, iframe, embed, object,
[style*="background-image"],
[style*="background:url"],
[style*="background: url"]`;

/**
 * Build a smart dark stylesheet for a light page.
 * Uses a controlled invert stack (pre-light bg → consistent dark) + contrast bump when needed.
 * Injected with `data-stampstack="dark-smart"` and overrides FOUC registered invert.
 */
export function buildSmartDarkCss(signals: DarkPageSignals): string {
  const bgCandidates = [signals.htmlBgLuminance, signals.bodyBgLuminance].filter(
    (n): n is number => n != null,
  );
  const bg = bgCandidates.length ? Math.min(...bgCandidates) : 0.95;
  const textCandidates = [signals.htmlTextLuminance, signals.bodyTextLuminance].filter(
    (n): n is number => n != null,
  );
  const text = textCandidates.length ? Math.max(...textCandidates) : 0.15;

  // Pre-invert html background: slightly off-white so invert lands near charcoal, not pure black.
  let preBg = '#f0f0f0';
  if (bg > 0.9) preBg = '#ececec';
  else if (bg > 0.7) preBg = '#e4e4e4';
  else preBg = '#dedede';

  // Contrast bump when sampled text/bg contrast is weak (washed gray-on-gray pages).
  let contrast = 1.02;
  if (text != null && bg != null) {
    const c = contrastRatio(text, bg);
    if (c < 4.5) contrast = 1.08;
    else if (c < 7) contrast = 1.05;
  }

  return `/* StampStack smart dark — controlled invert + contrast */
html {
  filter: invert(1) hue-rotate(180deg) contrast(${contrast}) !important;
  background-color: ${preBg} !important;
  color-scheme: dark !important;
}
body {
  background-color: transparent !important;
  color-scheme: dark !important;
}
${MEDIA_REINVERT} {
  filter: invert(1) hue-rotate(180deg) !important;
}
input, textarea, select, button {
  color-scheme: dark;
}
`;
}

/** CSS that cancels registered invert (already-dark / auto-skip). */
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
