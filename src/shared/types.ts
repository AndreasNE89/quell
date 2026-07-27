// Shared types and the message protocol between the service worker, content scripts,
// popup, and options page. Keeping every message in one discriminated union means the
// compiler catches a mismatched handler.

import type { SponsorSegment } from './sponsorblock.js';

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
  /** Skip mid-video sponsor/intro/etc. segments via the SponsorBlock API. */
  youtubeSponsorBlock: boolean;
  /** Global paid dark-mode preference (gated by license). */
  darkModeEnabled: boolean;
  /** Hostname → force on/off; missing key follows `darkModeEnabled`. */
  darkModeSiteOverrides: Record<string, DarkModeSiteOverride>;
  /**
   * Hosts auto force-off because the page looked already dark.
   * Cleared when the user changes that host’s override.
   */
  darkModeAutoOff: Record<string, boolean>;
  /**
   * Breakage repair, per host. Absent = everything on. The full disable step is the
   * existing `allowlist`, so the ladder is: none → cosmetics → injection → allowlist.
   */
  siteFixes: Record<string, SiteFixLevel>;
  /** The user's own cosmetic filters, as raw editable text (one rule per line). */
  customFilters: string;
  /**
   * Per-category SponsorBlock opt-out. Absent key = enabled, so a settings blob written before
   * this was configurable keeps the all-categories behavior it had.
   */
  sponsorBlockCategories: Record<string, boolean>;
}

/**
 * How much filtering to switch off on a site that broke.
 *
 * Most breakage is caused by element hiding or by a scriptlet patching a page global — not by
 * network blocking. Turning *everything* off (the allowlist) to fix a misplaced element also
 * hands the site back its ads and trackers, so it is the last step, not the only one.
 *
 * - `cosmetics`  — element hiding off. Network blocking and scriptlets stay on.
 * - `injection`  — element hiding and scriptlets off. Network blocking stays on.
 */
export type SiteFixLevel = 'cosmetics' | 'injection';

/** One named third party observed on the page. */
export interface ReportTracker {
  host: string;
  /** Organization a user would recognize, e.g. "Google Analytics". */
  label: string;
  /** True when a shipped block rule matches this domain. False = seen but not blocked. */
  blocked: boolean;
}

/**
 * What StampStack can honestly say about the current page.
 *
 * Deliberately not a "requests blocked" count: Chrome withholds per-request match events from
 * store builds, so any such number would be invented. These are page observations instead —
 * what the document reached for, and what our own rules hid.
 */
export interface PageReport {
  available: boolean;
  /** Why the report is empty, when it is. */
  reason?: 'no-content-script' | 'restricted' | 'paused' | 'allowlisted';
  hostname: string | null;
  /** Named trackers/ad services, most notable first. */
  trackers: ReportTracker[];
  /** Third-party hosts we saw but cannot name. */
  unnamedThirdParty: number;
  /** Elements hidden by site-specific and procedural cosmetic rules on this page. */
  hiddenElements: number;
  /** The host cap was reached, so counts are a floor rather than exact. */
  truncated: boolean;
}

/** The user's own filters plus whatever the parser could not use. */
export interface CustomFiltersData {
  text: string;
  /** How many rules actually parsed. */
  count: number;
  errors: { line: number; text: string; reason: string }[];
}

/** SponsorBlock category rows for the Options page. */
export interface SponsorCategoriesData {
  categories: { id: string; label: string; hint: string; enabled: boolean }[];
  /** True when every category is off, i.e. the API is never contacted. */
  allOff: boolean;
}

/** Every per-site rule the user has set, for the Options manager. */
export interface SiteRulesData {
  allowlist: string[];
  siteFixes: Record<string, SiteFixLevel>;
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
  | { type: 'report:get' }
  /** Compose (but never send) a breakage report for this host. */
  | { type: 'report:breakage'; hostname: string }
  | { type: 'picker:start' }
  | { type: 'customfilters:add'; line: string }
  | { type: 'customfilters:get' }
  | { type: 'customfilters:set'; text: string }
  | { type: 'sponsorblock:getCategories' }
  | { type: 'sponsorblock:setCategory'; category: string; enabled: boolean }
  /** SW → content script: hand back what this page has observed. */
  | { type: 'page:collect' }
  | { type: 'sitefix:set'; hostname: string; level: SiteFixLevel | null }
  | { type: 'sitefix:list' }
  | { type: 'settings:export' }
  | { type: 'settings:import'; json: string }
  | {
      type: 'popup:setYoutubeOptions';
      youtubeBlockSponsored: boolean;
      youtubeBlockShorts: boolean;
      youtubeSponsorBlock: boolean;
    }
  | { type: 'youtube:getOptions'; hostname: string }
  | { type: 'sponsorblock:getSegments'; videoId: string }
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
  /** SW → content: re-apply or remove dark styles without reloading the tab. */
  | { type: 'darkmode:refresh' }
  /** SW → content: re-fetch cosmetics after the user's own filters changed. */
  | { type: 'cosmetic:refresh' }
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
  /** Rules across the currently enabled lists — shown instead of the dead counters. */
  activeRuleCount: number;
  /** An allowlist entry that covers this host without being equal to it (parent domain). */
  coveredBy: string | null;
  /** Active breakage-repair rung for this host, if any. */
  siteFix: SiteFixLevel | null;
  /** A list the user enabled could not be loaded — protection is lower than requested. */
  degraded: boolean;
  youtubeBlockSponsored: boolean;
  youtubeBlockShorts: boolean;
  youtubeSponsorBlock: boolean;
}

export interface YoutubeOptionsData {
  allowlisted: boolean;
  paused: boolean;
  youtubeBlockSponsored: boolean;
  youtubeBlockShorts: boolean;
  youtubeSponsorBlock: boolean;
}

export interface SponsorBlockSegmentsData {
  videoId: string;
  segments: SponsorSegment[];
}

/**
 * `enabled` is what the user asked for; `active` is what Chrome actually loaded.
 *
 * They diverge when the shared static-rule pool is exhausted — syncRulesets drops the largest
 * ruleset to keep the rest working, and without this distinction the UI went on reporting full
 * protection the user did not have.
 */
export type ListRow = ListMeta & { enabled: boolean; active: boolean };

export interface ListsData {
  lists: ListRow[];
  /** True when at least one list the user enabled could not be loaded. */
  degraded: boolean;
}

export interface StatsData {
  blockedTotal: number;
  paused: boolean;
  lists: ListRow[];
  regexRulesUsed: number;
  statsReliable: boolean;
  degraded: boolean;
  /** When the packaged lists were fetched upstream — `GeneratedMeta.generatedAt`. */
  listsGeneratedAt: string | null;
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
  siteOverrides: Record<string, DarkModeSiteOverride>;
  license: LicenseData;
}

/** Compiled tracker-naming index (`src/generated/trackers.json`). */
export interface TrackerIndex {
  domains: Record<string, { label: string; blocked: boolean }>;
}
