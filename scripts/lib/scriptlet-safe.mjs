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
