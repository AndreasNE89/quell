/**
 * CWS Code Readability (Red Titanium) rejects packages that contain `atob("…")`
 * / long base64 blobs. uBO scriptlet args sometimes embed site JS that does
 * exactly that (e.g. zefoy.com `rpnt` payloads). Drop those at compile time so
 * they never land in `background.js` via `scriptlets.json`.
 */

const LONG_BASE64 = /[A-Za-z0-9+/]{80,}={0,2}/;
const ATOB_LIKE = /\b(?:window\.)?atob\s*\(|\bbtoa\s*\(|new\s+Function\s*\(\s*atob\b/i;

/**
 * @param {{ name?: string, args?: unknown[] } | null | undefined} scriptlet
 * @returns {boolean} true when the rule should be omitted from the package
 */
export function scriptletLooksObfuscated(scriptlet) {
  if (!scriptlet) return false;
  const parts = [scriptlet.name, ...(scriptlet.args || [])].map((x) => String(x ?? ''));
  const blob = parts.join('\0');
  if (ATOB_LIKE.test(blob)) return true;
  if (LONG_BASE64.test(blob)) return true;
  return false;
}

/**
 * Scriptlet names the runtime can actually execute — every key of `ALIASES` in
 * `src/scriptlets/library.ts`, including the uBO short forms.
 *
 * Filter lists reference far more scriptlets than we implement. Shipping a rule whose name has
 * no handler costs package size and runtime work for nothing: `runScriptlet` looks the name up,
 * finds no function, and returns — but the rule was still bundled into `scriptlets.json` and
 * still caused the domain to receive a MAIN-world injection. Dropping them at compile time is
 * purely a saving; behavior is identical.
 *
 * `test/scriptlets.test.mjs` asserts this set matches the runtime alias map exactly, so adding
 * a scriptlet without updating this list fails the build's tests rather than silently
 * discarding rules that would now work.
 */
export const SUPPORTED_SCRIPTLET_NAMES = new Set([
  'set',
  'set-constant',
  'aopr',
  'abort-on-property-read',
  'aopw',
  'abort-on-property-write',
  'acs',
  'acis',
  'abort-current-inline-script',
  'nostif',
  'no-setTimeout-if',
  'prevent-setTimeout',
  'nosiif',
  'no-setInterval-if',
  'prevent-setInterval',
  'ra',
  'remove-attr',
  'rc',
  'remove-class',
  'json-prune',
  'json-prune-fetch-response',
  'json-prune-xhr-response',
  'trusted-replace-fetch-response',
  'trusted-replace-xhr-response',
  // Global-patching family added in 1.6.0 — see src/scriptlets/library.ts.
  'nowoif',
  'no-window-open-if',
  'window.open-defuser',
  'aeld',
  'addEventListener-defuser',
  'prevent-addEventListener',
  'no-fetch-if',
  'prevent-fetch',
  'nano-stb',
  'nano-setTimeout-booster',
  'nano-sib',
  'nano-setInterval-booster',
  'noeval-if',
  'prevent-eval-if',
  'noeval',
  'noeval.js',
  'nowebrtc',
]);

/** True when no handler exists for this scriptlet name, so the rule is inert. */
export function scriptletUnsupported(name) {
  return !SUPPORTED_SCRIPTLET_NAMES.has(String(name ?? '').trim());
}
