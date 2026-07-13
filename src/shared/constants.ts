// Runtime constants. Mirrors scripts/lib/limits.mjs (build side) for the values the
// service worker needs. Kept small and separate so the SW doesn't import build tooling.

/** Dynamic-rule id range reserved for per-site allowlist (allowAllRequests) rules. */
export const ALLOWLIST_ID_START = 1_000_000;

/**
 * Priority for allowlist rules. Must beat every static block/allow priority we emit
 * (compiler caps those at 4000 for `@@ $important`). A large constant leaves headroom.
 */
export const ALLOWLIST_PRIORITY = 1_000_000;

/** chrome.scripting id for the dynamically-managed generic cosmetic stylesheet. */
export const GENERIC_CSS_SCRIPT_ID = 'quell-generic-cosmetic';

/**
 * chrome.scripting id for the MAIN-world scriptlet injector. Registered dynamically
 * (rather than statically in the manifest) so its `excludeMatches` can drop allowlisted
 * sites — MAIN world can't read chrome.storage to self-gate.
 */
export const SCRIPTLETS_SCRIPT_ID = 'quell-scriptlets';

/** Path (relative to extension root) of the generated generic cosmetic stylesheet. */
export const GENERIC_CSS_PATH = 'generated/generic-cosmetic.css';

export const STORAGE_KEY = 'quell.settings';
