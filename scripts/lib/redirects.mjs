// Curated set of "redirect" resources. When a filter says `$redirect=noopjs`, DNR
// redirects the request to one of these neutered, same-behavior-minus-ads stand-ins
// (served from the extension via web_accessible_resources).
//
// The files live in src/redirects/ and are copied verbatim into dist/redirects/.
// Aliases map the various token spellings uBO/AdGuard use onto one file.

export const REDIRECT_RESOURCES = {
  // Empty / inert primitives
  noopjs: { file: 'noop.js', type: 'application/javascript' },
  'noop.js': { file: 'noop.js', type: 'application/javascript' },
  noopframe: { file: 'noop.html', type: 'text/html' },
  'noop.html': { file: 'noop.html', type: 'text/html' },
  nooptext: { file: 'noop.txt', type: 'text/plain' },
  'noop.txt': { file: 'noop.txt', type: 'text/plain' },
  noopcss: { file: 'noop.css', type: 'text/css' },

  // Neutered popular ad/analytics scripts (pages feature-detect these globals)
  'googlesyndication_adsbygoogle.js': { file: 'adsbygoogle.js', type: 'application/javascript' },
  'googlesyndication.com/adsbygoogle.js': { file: 'adsbygoogle.js', type: 'application/javascript' },
  'google-analytics_analytics.js': { file: 'google-analytics.js', type: 'application/javascript' },
  'google-analytics_ga.js': { file: 'google-analytics.js', type: 'application/javascript' },
  'googletagmanager_gtm.js': { file: 'google-analytics.js', type: 'application/javascript' },
  'googletagservices_gpt.js': { file: 'gpt.js', type: 'application/javascript' },
};

// The distinct files that must ship as web_accessible_resources.
export const REDIRECT_FILES = [
  ...new Set(Object.values(REDIRECT_RESOURCES).map((r) => r.file)),
];
