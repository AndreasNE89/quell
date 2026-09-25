// Which frames the registered document_start scriptlets may act in (REVIEW_2026-09-24 B2, B24).
//
// The allowlist, Pause and breakage fixes belong to the tab's top-level page, as in uBO and
// as network blocking does it. A registered content script's excludeMatches is tested against
// each frame's own URL, and a MAIN-world script has no synchronous way to learn the user's
// settings, so the registered scripts can only decide correctly where the frame's host is the
// top page's host: in the top frame itself, and in same-host subframes (including the
// about:blank / srcdoc frames a page creates for itself). Every other frame is left to the
// content script, which asks the service worker; the worker decides against the top page and
// injects through chrome.scripting. Both sides call frameScope(), so a frame is never served
// twice or not at all.

export interface FrameScope {
  /** Host the frame's rules are matched against; '' when it has none (data:, opaque origins). */
  host: string;
  /** Host of the top-level page as this frame sees it; null when unknown or opaque. */
  top: string | null;
  isTop: boolean;
  /** True when the registered scripts serve this frame, false when the service worker does. */
  registered: boolean;
}

function hostOfOrigin(origin: string | null | undefined): string {
  if (!origin || origin === 'null') return '';
  try {
    return new URL(origin).hostname;
  } catch {
    return '';
  }
}

/**
 * Host of this frame's document: its own URL's, or for about:blank, srcdoc and blob: frames
 * (which have none) the origin they inherited from the page that made them.
 */
export function frameHostOf(hostname: string, origin: string | null | undefined): string {
  return (hostname || hostOfOrigin(origin)).toLowerCase();
}

export function scopeOf(
  host: string,
  isTop: boolean,
  ancestorOrigins: ArrayLike<string> | null | undefined,
): FrameScope {
  let top: string | null = isTop ? host : null;
  if (!isTop && ancestorOrigins && ancestorOrigins.length) {
    top = hostOfOrigin(ancestorOrigins[ancestorOrigins.length - 1]) || null;
  }
  return { host, top, isTop, registered: !!host && (isTop || top === host) };
}

/** The scope of the frame this code runs in (content script or MAIN world). */
export function frameScope(): FrameScope {
  let isTop = true;
  try {
    isTop = window.top === window;
  } catch {
    isTop = false;
  }
  let origin: string | null = null;
  try {
    origin = self.origin;
  } catch {
    /* no origin: treat as opaque */
  }
  let ancestors: ArrayLike<string> | null = null;
  try {
    ancestors = location.ancestorOrigins ?? null;
  } catch {
    /* not exposed: the top page is unknown */
  }
  return scopeOf(frameHostOf(location.hostname, origin), isTop, ancestors);
}
