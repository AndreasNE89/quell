// Runtime constants. Mirrors scripts/lib/limits.mjs (build side) for the values the
// service worker needs. Kept small and separate so the SW doesn't import build tooling.

/** Dynamic-rule id range reserved for per-site page allowlisting (allowAllRequests) rules. */
export const ALLOWLIST_ID_START = 1_000_000;

/** Exclusive upper bound for allowlist dynamic rule ids (custom rules start here). */
export const ALLOWLIST_ID_END = 2_000_000;

/**
 * Priority for allowlist rules. Must beat every static block/allow priority we emit
 * (compiler caps those at 4000 for `@@ $important`). A large constant leaves headroom.
 */
export const ALLOWLIST_PRIORITY = 1_000_000;

/** chrome.scripting id for the dynamically-managed generic cosmetic stylesheet. */
export const GENERIC_CSS_SCRIPT_ID = 'quell-generic-cosmetic';

/** Legacy id — unregistered on sync so older builds don't double-inject. */
export const SCRIPTLETS_SCRIPT_ID = 'quell-scriptlets';

/** Path (relative to extension root) of the combined generic cosmetic stylesheet. */
export const GENERIC_CSS_PATH = 'generated/generic-cosmetic.css';

export const STORAGE_KEY = 'quell.settings';
