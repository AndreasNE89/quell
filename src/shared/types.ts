// Shared types and the message protocol between the service worker, content scripts,
// popup, and options page. Keeping every message in one discriminated union means the
// compiler catches a mismatched handler.

export type ListGroup = 'ads' | 'privacy' | 'security' | 'annoyances';

export interface ListMeta {
  id: string;
  title: string;
  group: ListGroup;
  enabledByDefault: boolean;
  ruleCount: number;
  rulesetFile: string;
  genericCssFile?: string;
  genericHideCount?: number;
}

export interface GeneratedMeta {
  generatedAt: string | null;
  lists: ListMeta[];
  regexRulesUsed: number;
}

/** Per-site dark mode override; absent key = follow global. */
export type DarkModeSiteOverride = 'on' | 'off';

/** Persisted settings (chrome.storage.local). */
export interface Settings {
  /** Master switch. When true, no blocking happens anywhere. */
  paused: boolean;
  /** Per-list enable state, keyed by list id. Absent = use enabledByDefault. */
  enabledLists: Record<string, boolean>;
  /** Hostnames the user has turned blocking off for (page allowlist). */
  allowlist: string[];
  /** Running total of blocked network requests (best-effort; only reliable in unpacked/dev). */
  blockedTotal: number;
  /** Hide YouTube sponsored/promoted videos and scrub player ad payloads. */
  youtubeBlockSponsored: boolean;
  /** Hide YouTube Shorts shelves/entries and leave /shorts/ pages. */
  youtubeBlockShorts: boolean;
  /** Global paid dark-mode preference (gated by license). */
  darkModeEnabled: boolean;
  /** Hostname → force on/off; missing key follows `darkModeEnabled`. */
  darkModeSiteOverrides: Record<string, DarkModeSiteOverride>;
  /**
   * Hosts auto force-off because the page looked already dark.
   * Cleared when the user changes that host’s override.
   */
  darkModeAutoOff: Record<string, boolean>;
}

/** Cached license / purchase state (`stampstack.license`). */
export interface LicenseState {
  paid: boolean;
  provider: 'extensionpay' | 'none';
  /** Epoch ms of last successful online verify (or local unlock). */
  verifiedAt: number | null;
  /** Receipt email from provider when available. */
  email?: string;
}

/** Procedural cosmetic rule: a raw uBO/ABP-style selector the JS engine evaluates. */
export interface ProceduralRule {
  domains: { include: string[]; exclude: string[] };
  expr: string;
}

/** Per-list compiled cosmetic slice. */
export interface CosmeticListData {
  hideGeneric: string[];
  unhideGeneric: string[];
  hideSpecific: Record<string, string[]>;
  unhideSpecific: Record<string, string[]>;
  procedural: ProceduralRule[];
}

/** Compiled cosmetic dataset held by the service worker (list-scoped). */
export interface CosmeticData {
  byList: Record<string, CosmeticListData>;
  networkExceptions: {
    generichide: string[];
    elemhide: string[];
    specifichide: string[];
  };
}

/** A scriptlet invocation targeted at some domains. */
export interface ScriptletRule {
  domains: { include: string[]; exclude: string[] };
  name: string;
  args: string[];
}

export interface ScriptletListData {
  scriptlets: ScriptletRule[];
  exceptions: ScriptletRule[];
}

export interface ScriptletData {
  byList: Record<string, ScriptletListData>;
}

// ---------------------------------------------------------------------------
// Messages (content/popup/options → service worker)
// ---------------------------------------------------------------------------

export type Message =
  | { type: 'cosmetic:get'; hostname: string }
  | { type: 'scriptlets:get'; hostname: string }
  | { type: 'scriptlets:inject'; scriptlets: ScriptletRule[] }
  | { type: 'popup:get' }
  | { type: 'popup:toggleSite'; hostname: string; enabled: boolean }
  | { type: 'popup:setPaused'; paused: boolean }
  | {
      type: 'popup:setYoutubeOptions';
      youtubeBlockSponsored: boolean;
      youtubeBlockShorts: boolean;
    }
  | { type: 'youtube:getOptions'; hostname: string }
  | { type: 'lists:get' }
  | { type: 'lists:setEnabled'; id: string; enabled: boolean }
  | { type: 'stats:get' }
  | { type: 'darkmode:get'; hostname?: string | null }
  | { type: 'darkmode:setEnabled'; enabled: boolean }
  | {
      type: 'darkmode:setSiteOverride';
      hostname: string;
      override: DarkModeSiteOverride | null;
    }
  /** Content script: page looks already dark — persist force-off if allowed. */
  | { type: 'darkmode:autoSkip'; hostname: string; reason?: string }
  /** SW → content: re-apply or remove dark styles without reloading the tab. */
  | { type: 'darkmode:refresh' }
  | { type: 'license:get' }
  | { type: 'license:openCheckout' }
  | { type: 'license:openRestore' }
  | { type: 'license:refresh' }
  /** Unpacked installs only — unlocks paid gate for local QA. */
  | { type: 'license:devUnlock' };

export interface CosmeticResponse {
  allowlisted: boolean;
  /** Specific hide selectors for this hostname (generic ones come via injected CSS). */
  hide: string[];
  /** Selectors to un-hide on this hostname (exceptions to generic rules / generichide). */
  unhide: string[];
  procedural: ProceduralRule[];
  /** When true, registered generic CSS should be treated as cancelled for this host. */
  disableGeneric: boolean;
  /** When true, no specific cosmetic hides apply. */
  disableSpecific: boolean;
}

export interface ScriptletsResponse {
  allowlisted: boolean;
  scriptlets: ScriptletRule[];
}

export interface PopupData {
  hostname: string | null;
  url: string | null;
  paused: boolean;
  allowlisted: boolean;
  /** Blocked-request count for the active tab (dev builds via onRuleMatchedDebug). */
  tabBlocked: number;
  blockedTotal: number;
  /** False in packaged/CWS builds where onRuleMatchedDebug is unavailable. */
  statsReliable: boolean;
  youtubeBlockSponsored: boolean;
  youtubeBlockShorts: boolean;
}

export interface YoutubeOptionsData {
  allowlisted: boolean;
  paused: boolean;
  youtubeBlockSponsored: boolean;
  youtubeBlockShorts: boolean;
}

export interface ListsData {
  lists: (ListMeta & { enabled: boolean })[];
}

export interface StatsData {
  blockedTotal: number;
  paused: boolean;
  lists: (ListMeta & { enabled: boolean })[];
  regexRulesUsed: number;
  statsReliable: boolean;
}

export interface LicenseData {
  paid: boolean;
  /** True when paid only because of offline grace (stale verify). */
  grace: boolean;
  verifiedAt: number | null;
  email?: string;
  provider: LicenseState['provider'];
  /** ExtensionPay id is configured (not placeholder). */
  configured: boolean;
  /** Unpacked install — `license:devUnlock` available. */
  unpacked: boolean;
  priceLabel: string;
}

export interface DarkModeData {
  paid: boolean;
  enabled: boolean;
  /** Effective apply for the requested hostname (if any). */
  apply: boolean;
  hostname: string | null;
  override: DarkModeSiteOverride | null;
  /** Chrome blocks injection on Web Store / gallery hosts — dark mode cannot apply. */
  restricted?: boolean;
  /** True when this host’s force-off was auto-detected (site looked dark). */
  autoOff: boolean;
  /** All hosts marked auto-off (for options list labels). */
  autoOffHosts: Record<string, boolean>;
  siteOverrides: Record<string, DarkModeSiteOverride>;
  license: LicenseData;
}
