// Manifest V3 declarativeNetRequest (DNR) limits, centralized so the compiler and
// runtime agree. Values reflect current Chromium (Chrome 120+). Sources are noted;
// if Chrome raises these, update here in one place.
//
// Refs:
//  - https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#property
//  - GUARANTEED_MINIMUM_STATIC_RULES, MAX_NUMBER_OF_* constants

export const DNR = {
  // Rules across enabled static rulesets that are guaranteed to be honored per extension.
  // Rules beyond this draw from a larger global pool shared across all installed extensions
  // (opaque; query getAvailableStaticRuleCount() at runtime). We ship past the guaranteed
  // minimum for coverage, and the service worker enables rulesets with graceful degradation
  // so a tight pool never leaves the user with zero blocking.
  GUARANTEED_MINIMUM_STATIC_RULES: 30000,

  // Max rules compiled into a single ruleset file. Decoupled from the guaranteed minimum:
  // the 30k guarantee is across ALL enabled rulesets, not per list, so capping each list at
  // 30k needlessly truncated EasyList/EasyPrivacy (~48k rules dropped). Large lists are still
  // bounded so one file can't dominate the global pool alone.
  MAX_STATIC_RULES_PER_LIST: 75000,

  // How many static rulesets may ship, and how many may be enabled at once.
  MAX_NUMBER_OF_STATIC_RULESETS: 100,
  MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50,

  // Dynamic + session rules (added at runtime, e.g. user allowlist / custom rules).
  MAX_NUMBER_OF_DYNAMIC_RULES: 30000,
  MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5000,
  MAX_NUMBER_OF_SESSION_RULES: 5000,

  // Rules using `regexFilter` are far more expensive and separately capped.
  MAX_NUMBER_OF_REGEX_RULES: 1000,
};

// Priority bands. DNR resolves conflicts by highest numeric priority first; only when
// priorities tie does it fall back to action order (allow > block > redirect). We use
// disjoint bands so intent is unambiguous regardless of action tiebreak rules.
export const PRIORITY = {
  BLOCK: 1000,
  // Redirects must outrank plain block: a broad domain block and a specific
  // `$redirect` to our neutered stub can both match a script URL, and DNR's
  // same-priority tiebreak is allow > block > redirect — so block would win and
  // the page would get nothing instead of the working stub. Sit redirect above
  // block but below allow, so allowlisting still beats redirecting.
  REDIRECT: 1500,
  ALLOW: 2000, // @@ exceptions beat blocks and redirects
  IMPORTANT_BLOCK: 3000, // $important beats normal exceptions
  // Important redirects must sit above important blocks for the same reason as
  // REDIRECT > BLOCK — equal priority would let block win the tiebreak.
  IMPORTANT_REDIRECT: 3500,
  IMPORTANT_ALLOW: 4000, // @@ ...$important beats important blocks/redirects
};

// Reserve dynamic-rule ID ranges so runtime subsystems never collide.
export const DYNAMIC_ID_RANGES = {
  ALLOWLIST_START: 1_000_000, // per-site page allowlisting (allowAllRequests)
  ALLOWLIST_END: 2_000_000, // exclusive upper bound for allowlist GC
  CUSTOM_START: 2_000_000, // user custom network rules
};
