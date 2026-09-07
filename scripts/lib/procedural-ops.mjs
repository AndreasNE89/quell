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
