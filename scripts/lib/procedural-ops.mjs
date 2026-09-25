// Shared procedural-operator vocabulary.
//
// The compiler (parse-filter.mjs) uses this to classify a cosmetic as procedural vs hide.
// The runtime evaluator (src/engine/procedural.ts) must implement the same names — a test
// compares the two lists so an operator cannot ship in one place and be dropped in the other.

/** Operators `queryProcedural` / `applyOp` implement. */
export const PROCEDURAL_OP_NAMES = [
  'has-text',
  'contains',
  '-abp-contains',
  'matches-css',
  'matches-css-before',
  'matches-css-after',
  'matches-attr',
  'matches-path',
  'xpath',
  'upward',
  'min-text-length',
  'if',
  'if-not',
  'watch-attr',
  'remove',
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Native `:has()` / `:-abp-` stay classified as procedural so they take the JS path
// (querySelectorAll on the prefix still handles a plain `:has()` with no further ops).
const PROCEDURAL_BODY_RE = new RegExp(
  `:-abp-|:has\\(|:not\\(:has|:(?:${PROCEDURAL_OP_NAMES.map(escapeRegExp).join('|')})\\(`,
);

/** True when a cosmetic selector body must go through the procedural engine, not plain CSS. */
export function isProceduralCosmeticBody(body) {
  return typeof body === 'string' && PROCEDURAL_BODY_RE.test(body);
}

/**
 * Rewrite ABP extended-selector names to the ones the runtime evaluates, as uBO does when it
 * reads an ABP list.
 *
 * - `:-abp-has()` is `:has()`. The runtime has no `-abp-has` operator, so without this 149 of
 *   EasyList China's 166 procedural rules matched nothing.
 * - `:-abp-contains()` is `:has-text()`.
 * - `:-abp-properties()` matches elements by the declarations of the *stylesheet rules* that
 *   style them. `:matches-css()` tests computed style instead, which is not the same test
 *   (`:-abp-properties(base64)` has no computed-style equivalent), and uBO does not implement
 *   it either. Such rules, and any other `:-abp-` operator, are reported as unsupported.
 *
 * @param {string} body
 * @returns {{ selector: string, unsupported: string | null }}
 */
export function normalizeAbpSelector(body) {
  if (typeof body !== 'string' || !body.includes(':-abp-')) {
    return { selector: body, unsupported: null };
  }
  const selector = body.replace(/:-abp-has\(/g, ':has(').replace(/:-abp-contains\(/g, ':has-text(');
  const left = /:(-abp-[a-z-]+)/.exec(selector);
  return { selector, unsupported: left ? left[1] : null };
}
