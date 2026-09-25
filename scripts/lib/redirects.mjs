// Curated set of "redirect" resources. When a filter says `$redirect=noopjs`, DNR
// redirects the request to one of these neutered, same-behavior-minus-ads stand-ins
// (served from the extension via web_accessible_resources).
//
// The files live in src/redirects/ and are copied verbatim into dist/redirects/.
// Aliases map the various token spellings uBO/AdGuard use onto one file, including ABP's
// `$rewrite=abp-resource:<name>` tokens (uBO lists those as aliases of the same resources).

const JS = { file: 'noop.js', type: 'application/javascript' };
const HTML = { file: 'noop.html', type: 'text/html' };
const TEXT = { file: 'noop.txt', type: 'text/plain' };
const CSS = { file: 'noop.css', type: 'text/css' };
const JSON_ = { file: 'noop.json', type: 'application/json' };
const GIF_1X1 = { file: '1x1.gif', type: 'image/gif' };
const PNG_2X2 = { file: '2x2.png', type: 'image/png' };
const PNG_3X2 = { file: '3x2.png', type: 'image/png' };
const PNG_32X32 = { file: '32x32.png', type: 'image/png' };
// Silent media: the ad player gets a decodable clip that ends almost at once, instead of the
// network error an anti-adblock check listens for. A block is not a fallback here — music and
// video sites (SoundCloud, Spotify) serve content from the same paths as the ads.
const MP3 = { file: 'noop-0.1s.mp3', type: 'audio/mpeg' };
const MP4 = { file: 'noop-1s.mp4', type: 'video/mp4' };
// An empty VAST/VMAP document is the IAB's "no ad available" answer.
const VAST2 = { file: 'noop-vast2.xml', type: 'text/xml' };
const VAST3 = { file: 'noop-vast3.xml', type: 'text/xml' };
const VAST4 = { file: 'noop-vast4.xml', type: 'text/xml' };
const VMAP1 = { file: 'noop-vmap1.xml', type: 'text/xml' };

export const REDIRECT_RESOURCES = {
  // Empty / inert primitives
  noopjs: JS,
  'noop.js': JS,
  'abp-resource:blank-js': JS,
  noopframe: HTML,
  'noop.html': HTML,
  'abp-resource:blank-html': HTML,
  nooptext: TEXT,
  'noop.txt': TEXT,
  'abp-resource:blank-text': TEXT,
  // uBO's `empty` is a zero-byte response, which is exactly noop.txt.
  empty: TEXT,
  noopcss: CSS,
  'noop.css': CSS,
  'abp-resource:blank-css': CSS,
  noopjson: JSON_,
  'noop.json': JSON_,

  // Transparent images
  '1x1.gif': GIF_1X1,
  '1x1-transparent.gif': GIF_1X1,
  'abp-resource:1x1-transparent-gif': GIF_1X1,
  '2x2.png': PNG_2X2,
  '2x2-transparent.png': PNG_2X2,
  'abp-resource:2x2-transparent-png': PNG_2X2,
  '3x2.png': PNG_3X2,
  '3x2-transparent.png': PNG_3X2,
  'abp-resource:3x2-transparent-png': PNG_3X2,
  '32x32.png': PNG_32X32,
  '32x32-transparent.png': PNG_32X32,
  'abp-resource:32x32-transparent-png': PNG_32X32,

  // Silent media
  'noop-0.1s.mp3': MP3,
  'noopmp3-0.1s': MP3,
  'abp-resource:blank-mp3': MP3,
  'noop-1s.mp4': MP4,
  'noopmp4-1s': MP4,
  'abp-resource:blank-mp4': MP4,

  // Empty ad-server responses
  'noop-vast2.xml': VAST2,
  'noopvast-2.0': VAST2,
  'noop-vast3.xml': VAST3,
  'noopvast-3.0': VAST3,
  'noop-vast4.xml': VAST4,
  'noopvast-4.0': VAST4,
  'noop-vmap1.xml': VMAP1,
  'noopvmap-1.0': VMAP1,

  // Neutered popular ad/analytics scripts (pages feature-detect these globals)
  'googlesyndication_adsbygoogle.js': { file: 'adsbygoogle.js', type: 'application/javascript' },
  'googlesyndication.com/adsbygoogle.js': { file: 'adsbygoogle.js', type: 'application/javascript' },
  'google-analytics_analytics.js': { file: 'google-analytics.js', type: 'application/javascript' },
  'google-analytics_ga.js': { file: 'google-analytics.js', type: 'application/javascript' },
  'googletagmanager_gtm.js': { file: 'google-analytics.js', type: 'application/javascript' },
  'googletagservices_gpt.js': { file: 'gpt.js', type: 'application/javascript' },
};

/**
 * Resolve a `$redirect=` token to a bundled resource.
 *
 * uBO lets the token carry a priority suffix, `noopjs:10`: when several redirect filters match
 * one request, the highest priority wins (default 0). Returns null for a resource we don't ship
 * — the caller skips the filter rather than guessing, since a plain block is not equivalent.
 * @param {string} token
 * @returns {{ name: string, resource: { file: string, type: string }, priority: number } | null}
 */
export function resolveRedirect(token) {
  const m = /^(.+?)(?::(-?\d+))?$/.exec(String(token ?? '').trim());
  if (!m) return null;
  const name = m[1];
  // Own keys only: `constructor` / `toString` must not resolve to Object.prototype members.
  if (!Object.hasOwn(REDIRECT_RESOURCES, name)) return null;
  return { name, resource: REDIRECT_RESOURCES[name], priority: m[2] === undefined ? 0 : Number(m[2]) };
}

// The distinct files that must ship as web_accessible_resources.
export const REDIRECT_FILES = [
  ...new Set(Object.values(REDIRECT_RESOURCES).map((r) => r.file)),
];
