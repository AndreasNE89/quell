// Shared types and the message protocol between the service worker, content scripts,
// popup, and options page. Keeping every message in one discriminated union means the
// compiler catches a mismatched handler.

import type { SponsorSegment } from './sponsorblock.js';
import type { SiteRuleRefusal } from './site-rules.js';

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
   * Per-category SponsorBlock choice. Absent key = the category's own default
   * (SPONSORBLOCK_DEFAULT_ON — sponsor only). Explicit true/false always wins.
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
  /**
   * True when a list Chrome has loaded right now blocks this domain outright. False = seen but
   * not blocked (or blocked only on some paths or pages: see `partial`).
   */
  blocked: boolean;
  /** Only some of this domain's requests are blocked (path- or page-scoped rules). */
  partial?: boolean;
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
  /**
   * The text was longer than CUSTOM_FILTERS_MAX_CHARS and was cut at the last whole line that
   * fits; the lines after it were not saved.
   */
  truncated?: boolean;
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

type DomainSpec = { include: string[]; exclude: string[] };

/** A uBO action filter (`sel:style(…)`, `sel:remove-attr(…)`, `sel:remove-class(…)`). */
export interface CosmeticActionRule {
  domains: DomainSpec;
  /** The filter body as the list wrote it; a `#@#` exception matches on this. */
  expr: string;
  /** What the action applies to: plain CSS, or a procedural expression when `procedural`. */
  selector: string;
  procedural: boolean;
  action: 'style' | 'remove-attr' | 'remove-class';
  /** Declarations for `style` (validated when compiled), else the attribute or class name. */
  arg: string;
}

/** A domain-scoped hide or exception that carries `~domain` exclusions. */
export interface ScopedSelector {
  domains: DomainSpec;
  selector: string;
}

/** `~a.com##.ad`: a generic hide its list withdraws on the hosts of each `exclude` set. */
export interface GenericExcept {
  selector: string;
  exclude: string[][];
}

/** One generic stylesheet of a list, with its revert twin (paths relative to `generated/`). */
export interface GenericCssSheet {
  file: string;
  revert: string;
  count: number;
  /** Registered only while none of these lists is enabled: they except its selectors. */
  unless?: string[];
}

/**
 * Per-list compiled cosmetic slice. The optional fields were added later (REVIEW_2026-09-24
 * B11, B12, P3), so data compiled before them still loads.
 */
export interface CosmeticListData {
  hideGeneric: string[];
  unhideGeneric: string[];
  hideSpecific: Record<string, string[]>;
  unhideSpecific: Record<string, string[]>;
  procedural: ProceduralRule[];
  actions?: CosmeticActionRule[];
  hideScoped?: ScopedSelector[];
  unhideScoped?: ScopedSelector[];
  genericExcept?: GenericExcept[];
}

/** Compiled cosmetic dataset held by the service worker (list-scoped). */
export interface CosmeticData {
  byList: Record<string, CosmeticListData>;
  /**
   * Network cosmetic exceptions keyed by list id.
   * Runtime merges only the enabled lists — a disabled list must not suppress hiding.
   */
  networkExceptions: {
    generichide: Record<string, string[]>;
    elemhide: Record<string, string[]>;
    specifichide: Record<string, string[]>;
  };
  /**
   * The same exceptions limited to one page of a site, as `host/path-glob` entries keyed by
   * list id (`bing.com/search?*`, or `google.*` + `/search?*`). The glob is tested against
   * the page's path and query, as a Chrome match pattern's path is.
   */
  pathExceptions?: {
    generichide: Record<string, string[]>;
    elemhide: Record<string, string[]>;
    specifichide: Record<string, string[]>;
  };
  /**
   * Each list's generic stylesheets (compile-filters planGenericCss): its base sheet, plus sheets
   * of selectors other lists except, registered only while those lists are off.
   */
  genericCss?: Record<string, GenericCssSheet[]>;
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
  /**
   * Content script, every frame. `topHost` and `isTop` are the frame's own view of its page
   * (frame-scope.ts); the worker only needs them for a prerendered page, whose tab still shows
   * the page before it. `refetch`: this document asked before, or its copy of the script came in
   * after it loaded, so it may hold sheets a worker inserted and has since forgotten.
   */
  | {
      type: 'cosmetic:get';
      hostname: string;
      topHost?: string | null;
      isTop?: boolean;
      refetch?: boolean;
    }
  /**
   * Content script, every frame: list scriptlets for this document. `registered` and `topHost`
   * are the frame's own view (src/shared/frame-scope.ts): registered frames already got theirs
   * from the document_start content scripts, and the worker only fills a gap; for the others
   * it decides against the top page and injects.
   */
  | { type: 'scriptlets:get'; hostname: string; topHost?: string | null; registered?: boolean }
  | { type: 'popup:get' }
  /** Popup switch and Options site rules. Answered with SiteToggleData. */
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
  /**
   * Popup ladder. A level applies to this host and its subdomains and leaves a parent's fix for
   * its other hosts; `null` steps back to full blocking, removing every entry that covers the host.
   */
  | { type: 'sitefix:set'; hostname: string; level: SiteFixLevel | null }
  /** Options: remove exactly this stored entry, never a parent or child. Answered with SiteRulesData. */
  | { type: 'sitefix:remove'; hostname: string }
  /** Options: remove exactly this allowlist entry. Answered with SiteRulesData & { applied }. */
  | { type: 'allowlist:remove'; hostname: string }
  | { type: 'sitefix:list' }
  | { type: 'settings:export' }
  | { type: 'settings:import'; json: string }
  | {
      type: 'popup:setYoutubeOptions';
      youtubeBlockSponsored: boolean;
      youtubeBlockShorts: boolean;
      youtubeSponsorBlock: boolean;
    }
  | { type: 'youtube:getOptions'; hostname: string; topHost?: string | null }
  | { type: 'sponsorblock:getSegments'; videoId: string }
  | { type: 'lists:get' }
  | { type: 'lists:setEnabled'; id: string; enabled: boolean }
  | { type: 'stats:get' }
  /**
   * Content scripts get DarkModePageData, resolved against the top page: from the tab, or from
   * `topHost` for a prerendered page. Extension pages get DarkModeData for `hostname` (or the
   * active tab).
   */
  | { type: 'darkmode:get'; hostname?: string | null; topHost?: string | null }
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
  /**
   * SW → content on YouTube pages: re-fetch youtube:getOptions. Sent whenever something it
   * answers from changes (the YouTube switches, pause, the allowlist, repair steps, an import),
   * so a content script does not need chrome.storage to follow them.
   */
  | { type: 'youtube:refresh' }
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
  /** uBO action filters for this page (`sel:style(…)`, `:remove-attr(…)`, `:remove-class(…)`). */
  actions?: CosmeticActionData[];
}

/** One action filter as the content script receives it. */
export type CosmeticActionData = Omit<CosmeticActionRule, 'domains'>;

export interface ScriptletsResponse {
  allowlisted: boolean;
  /** The worker injected scriptlets into this document through chrome.scripting. */
  injected: boolean;
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
  /**
   * The siteFixes key `siteFix` comes from: the host's own, or a parent's when inherited. Stepping
   * back from an inherited fix restores the parent, and with it every other host under it.
   */
  siteFixHost: string | null;
  /**
   * The allowlist and the repair ladder can hold this host (site-rules.ts). False on IPv6
   * literals, Web Store pages and non-web tabs, where a switch would do nothing.
   */
  siteActionable: boolean;
  /** Why `siteActionable` is false for a web page; null otherwise. */
  siteRefusal: SiteRuleRefusal | null;
  /**
   * The active tab is in an Incognito window. Site switches set here are saved like any other
   * (as uBO does) and apply in normal windows too; the popup says so before the user sets one.
   */
  incognito?: boolean;
  /** A list the user enabled could not be loaded — protection is lower than requested. */
  degraded: boolean;
  youtubeBlockSponsored: boolean;
  youtubeBlockShorts: boolean;
  youtubeSponsorBlock: boolean;
}

/**
 * Answer to `popup:toggleSite`. `applied: false` means Chrome refused the allowlist rule change,
 * so the switch did not take effect: nothing was stored, and the rest of the data describes the
 * site as it still is.
 */
export interface SiteToggleData extends PopupData {
  applied: boolean;
}

export interface YoutubeOptionsData {
  allowlisted: boolean;
  paused: boolean;
  /**
   * The page's repair step switches element hiding off (either rung): YouTube's own hide CSS
   * and the Shorts shelf hiding must stand down too. Optional in the message; the storage
   * fast path (youtubeOptsFromSettings) fills it and scriptletsOff alike.
   */
  cosmeticsOff?: boolean;
  /**
   * The page's repair step switches script patches off (the second rung): the sponsored scrub,
   * the Shorts redirect and SponsorBlock skipping must stand down too.
   */
  scriptletsOff?: boolean;
  youtubeBlockSponsored: boolean;
  youtubeBlockShorts: boolean;
  youtubeSponsorBlock: boolean;
  /** Enabled skip categories — content uses this as a refetch cache key. */
  sponsorBlockCategories: string[];
}

export interface SponsorBlockSegmentsData {
  videoId: string;
  segments: SponsorSegment[];
  /**
   * SponsorBlock gave no answer (timeout, network error, 429/5xx): the page retries with
   * backoff. Not the same as an empty `segments`, which is a real "nothing to skip".
   */
  failed?: boolean;
}

/**
 * `enabled` is what the user asked for; `active` is what Chrome actually loaded.
 *
 * They diverge when the shared static-rule pool is exhausted — syncRulesets drops the largest
 * ruleset to keep the rest working, and without this distinction the UI went on reporting full
 * protection the user did not have.
 */
export type ListRow = ListMeta & {
  enabled: boolean;
  active: boolean;
  /**
   * Enabled, not paused, and Chrome did not load it (the shared static-rule pool is full).
   * While paused no list is loaded, by design, and none is refused.
   */
  refused: boolean;
};

export interface ListsData {
  lists: ListRow[];
  /** True when at least one list the user enabled could not be loaded. */
  degraded: boolean;
  /** Paused everywhere: every row reads `active: false` and none is `refused`. */
  paused: boolean;
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
  /** Answer to license:refresh only: ExtensionPay could not be reached, so this is the cache. */
  unreachable?: boolean;
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

/**
 * darkmode:get as a content script sees it. Every frame of every site asks, so the answer
 * carries only the decision: not the purchase email, not the list of overridden sites.
 */
export interface DarkModePageData {
  paid: boolean;
  apply: boolean;
}

/** Answer to settings:import. `ignored` names the fields left as they were (wrong type). */
export interface SettingsImportResult {
  ok: boolean;
  error?: string;
  /** Why it failed, for the page to translate (popup_error_<code>). */
  code?: 'not_json' | 'not_export';
  ignored?: string[];
  /** The file's custom filters were over the size cap and were cut at a whole line. */
  truncated?: boolean;
}

/** Compiled tracker-naming index (`src/generated/trackers.json`). */
export interface TrackerIndex {
  /**
   * `lists`: the lists with a rule blocking the whole domain; the worker marks it blocked only
   * when one of them is loaded. `partial`: lists whose rules block only some paths or pages of
   * it. `blocked` is the compile-time answer for every list, kept for an index without `lists`.
   */
  domains: Record<string, { label: string; blocked: boolean; lists?: string[]; partial?: string[] }>;
}
