// Regional filter lists that should be on by default for a given browser UI language.
//
// EasyList and EasyPrivacy barely touch Chinese ad networks, so a user in a Chinese locale
// installing StampStack gets weak blocking on the sites they actually visit — no matter what
// language the interface is in. The list exists; nothing was turning it on.
//
// Deliberately not shipped `enabledByDefault`. Regional lists are dead weight for everyone
// outside the region, and the default-enabled set already sits far above Chrome's guaranteed
// 30,000 static rules and relies on the shared global pool. Enabling one only where it earns
// its place keeps that pressure off every other user.
//
// Applied once, at install. After that the toggle is the user's: a later re-enable would
// override someone who deliberately turned it off.

/** Regional lists keyed by the language subtag they serve. */
const BY_LANGUAGE: Record<string, string[]> = {
  // Covers Simplified and Traditional alike — the list targets Chinese-language sites, not one
  // territory, so zh-CN, zh-TW and zh-HK all get it.
  zh: ['easylist-china'],
};

/**
 * Primary language subtag of a BCP-47 tag, lowercased.
 * `chrome.i18n.getUILanguage()` returns things like "zh-CN", "zh-TW", "en-GB".
 */
export function primaryLanguage(uiLanguage: string | null | undefined): string {
  if (!uiLanguage) return '';
  // Split on both separators: Chrome reports "zh-CN", but underscore turns up in stored values.
  return uiLanguage.trim().toLowerCase().split(/[-_]/)[0] ?? '';
}

/**
 * List ids to enable for this UI language. Empty for every language without a regional list,
 * which is the common case.
 */
export function localeDefaultLists(uiLanguage: string | null | undefined): string[] {
  return BY_LANGUAGE[primaryLanguage(uiLanguage)] ?? [];
}
