// StampStack service worker — the coordinator.
//
// Responsibilities:
//   - Sync per-list static rulesets with user settings (updateEnabledRulesets).
//   - Maintain the per-site allowlist as dynamic allowAllRequests rules.
//   - Register/update generic cosmetic CSS, the YouTube hooks and the per-host list scriptlets
//     (MAIN world, document_start) excluding allowlisted sites.
//   - Answer cosmetic/popup/options messages with list-scoped data.
//   - Count blocked requests per tab and drive the toolbar badge (dev builds).
//
// The SW is ephemeral: in-memory maps are rebuilt on wake, durable state lives in
// chrome.storage. Every sync function is idempotent so waking mid-state is safe.

import type {
  Message,
  CosmeticResponse,
  ScriptletsResponse,
  PopupData,
  SiteToggleData,
  ListsData,
  DarkModePageData,
  SettingsImportResult,
  StatsData,
  Settings,
  CosmeticData,
  GeneratedMeta,
  YoutubeOptionsData,
  SponsorBlockSegmentsData,
  DarkModeData,
  DarkModeSiteOverride,
  LicenseData,
  LicenseState,
  SiteFixLevel,
  SiteRulesData,
  PageReport,
  TrackerIndex,
  CustomFiltersData,
  SponsorCategoriesData,
  ListRow,
} from '../shared/types.js';
import { lookupSponsorSegments } from './sponsorblock-api.js';
import {
  SPONSORBLOCK_SKIP_CATEGORIES,
  SPONSORBLOCK_CATEGORY_INFO,
  enabledSponsorCategories,
  migrateLegacySponsorCategories,
  SPONSORBLOCK_DEFAULT_ON,
} from '../shared/sponsorblock.js';
import {
  ALLOWLIST_ID_START,
  ALLOWLIST_ID_END,
  ALLOWLIST_PRIORITY,
  GENERIC_CSS_SCRIPT_ID,
  SCRIPTLETS_SCRIPT_ID,
  YOUTUBE_SCRIPTLETS_SCRIPT_ID,
  YOUTUBE_FRAME_SCRIPTLETS_SCRIPT_ID,
  DARK_MODE_SCRIPT_ID,
  DARK_MODE_FORCE_ON_SCRIPT_ID,
  DARK_MODE_CSS_PATH,
} from '../shared/constants.js';
import {
  loadSettings,
  saveSettings,
  isListEnabled,
  buildSettingsExportDocument,
  applyImportedSettings,
} from './settings.js';
import {
  syncOneRegisteredScript,
  syncRegisteredScriptGroup,
  type LazyContentScript,
} from './registered-scripts.js';
import {
  defaultLicense,
  initLicense,
  loadLicense,
  refreshLicenseDetailed,
  openCheckout,
  openRestore,
  devUnlock,
  ensureUnpackedTestLicense,
  isUnpackedInstall,
  probeInstallEnvironment,
  toLicenseData,
} from './license.js';
import { classifyHosts } from '../shared/page-report.js';
import {
  customCosmeticsFor,
  parseCustomFilters,
  appendFilterLine,
  filterAppliesTo,
} from '../shared/custom-filters.js';
import {
  resolveSiteFix,
  resolveSiteFixEntry,
  fixDisablesCosmetics,
  fixDisablesScriptlets,
  hostsWithCosmeticsOff,
  hostsWithScriptletsOff,
} from '../shared/site-fix.js';
import {
  siteRuleScope,
  siteRuleRefusal,
  siteRuleKey,
  siteRuleCovers,
  siteRuleKeyFromInput,
  isSiteAllowlisted,
  siteRuleMatchPatterns,
  siteRuleDnrConditions,
} from '../shared/site-rules.js';
import {
  sanitizeImportedSettings,
  capFilterText,
  CUSTOM_FILTERS_MAX_CHARS,
} from './settings-import.js';
import { localeDefaultLists } from '../shared/locale-lists.js';
import {
  buildBreakageReport,
  browserLabel,
  type BreakageReport,
} from '../shared/breakage-report.js';
import {
  isLicenseEffectivelyPaid,
  licenseIsFresh,
  resolveDarkModeForHost,
  hostsWithForceOff,
  hostsWithForceOn,
  isExtensionRestrictedHostname,
  isHttpOrHttpsUrl,
} from '../shared/dark-mode.js';
import {
  matchCosmetic,
  genericCssRegistration,
  genericCssFiles,
  genericSheetApplies,
} from '../engine/cosmetic-match.js';
import {
  SCRIPTLET_SHARD_ID_PREFIX,
  SCRIPTLET_RUNTIME_FILE,
  shardRegistrations,
  shardParts,
  planShardInjection,
  type ShardIndex,
} from '../engine/scriptlet-shards.js';
import {
  normalizeHostname,
  isValidMatchPatternHost,
  exactHostMatchPatterns,
} from '../shared/hostname.js';

import scriptletShardJson from '../generated/scriptlet-shards.json';
import metaJson from '../generated/meta.json';
import trackerJson from '../generated/trackers.json';

// Only the host index: the rules themselves ship as MAIN-world files (scriptlet-shards.ts).
const SHARDS = scriptletShardJson as ShardIndex;
const META = metaJson as GeneratedMeta;
const TRACKERS = trackerJson as TrackerIndex;

const STATS_RELIABLE = !!chrome.declarativeNetRequest.onRuleMatchedDebug;

// Settings and the license live in storage.local, which Chrome opens to content scripts by
// default: a page that compromised its renderer could rewrite them directly, past every check
// in this worker (REVIEW_2026-09-24 P3). Content scripts ask the worker instead (youtube:getOptions,
// youtube:refresh). Chromium 151 then answers a content script "Access to storage is not allowed
// from this context"; Chromium 131 has setAccessLevel on storage.session only, and there the
// area stays open. Set on every wake: it is cheap, and nothing documents it as persisted.
void chrome.storage.local
  .setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' as chrome.storage.AccessLevel })
  ?.catch((e: unknown) => console.warn('[StampStack] storage access level not set', e));

// Per-tab blocked counters (rebuilt on SW wake; best-effort for the badge).
const tabBlocked = new Map<number, number>();

// ---------------------------------------------------------------------------
// Compiled cosmetic data, read from the package when needed (REVIEW_2026-09-24 B35)
// ---------------------------------------------------------------------------
//
// Inlined, cosmetic.json was 2.8 MB of object literal parsed and built on every wake, about
// 80 ms before the first reply. scripts/lib/cosmetic-files.mjs splits it into core.json (all but
// the per-list rules) and one file per list; a wake reads the core only, and the first page that
// asks for cosmetics the enabled lists' files. Each is read once per worker lifetime.

const COSMETIC_DIR = 'generated/cosmetic';

async function fetchPackageJson<T>(path: string): Promise<T> {
  const res = await fetch(chrome.runtime.getURL(path));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

const cosmeticFiles = new Map<string, Promise<unknown>>();

/** One file, fetched once; a failed read is forgotten so the next caller tries again. */
function cosmeticFile<T>(name: string): Promise<T> {
  let p = cosmeticFiles.get(name) as Promise<T> | undefined;
  if (!p) {
    p = fetchPackageJson<T>(`${COSMETIC_DIR}/${name}`);
    cosmeticFiles.set(name, p);
    p.catch(() => cosmeticFiles.delete(name));
  }
  return p;
}

/** The core with no list rules. Enough for everything but matching a page. */
function cosmeticCore(): Promise<CosmeticData> {
  return cosmeticFile<CosmeticData>('core.json');
}

/**
 * The dataset for these lists. The same object for the same lists, so matchCosmetic's merged
 * view (memoized on it, one entry) survives from one page to the next. The promise is what is
 * kept: every frame of a page asks at once after a wake, and each assembling its own object
 * rebuilt the merged view once per frame (about 40 ms each in Chromium).
 */
let cosmeticAssembled: { key: string; data: Promise<CosmeticData> } | null = null;

function cosmeticData(ids: string[]): Promise<CosmeticData> {
  const key = ids.join('\0');
  if (cosmeticAssembled?.key === key) return cosmeticAssembled.data;
  const entry = {
    key,
    data: (async (): Promise<CosmeticData> => {
      const [core, ...lists] = await Promise.all([
        cosmeticCore(),
        ...ids.map((id) => cosmeticFile<CosmeticData['byList'][string]>(`list.${id}.json`)),
      ]);
      const byList: CosmeticData['byList'] = {};
      ids.forEach((id, i) => {
        byList[id] = lists[i];
      });
      return { ...core, byList };
    })(),
  };
  cosmeticAssembled = entry;
  // A failed read is forgotten, as in cosmeticFile, so the next page tries again.
  entry.data.catch(() => {
    if (cosmeticAssembled === entry) cosmeticAssembled = null;
  });
  return entry.data;
}

/** A dataset with the core only, per enabled-list key, for the registration's merged view. */
let cosmeticCoreView: { key: string; data: CosmeticData } | null = null;

/** The dataset for these lists when it is loaded or on its way, else the core-only view. */
async function cosmeticRegistrationData(ids: string[]): Promise<CosmeticData> {
  const key = ids.join('\0');
  if (cosmeticAssembled?.key === key) {
    try {
      return await cosmeticAssembled.data;
    } catch {
      /* the core alone is enough for the registration */
    }
  }
  if (cosmeticCoreView?.key !== key) {
    cosmeticCoreView = { key, data: { ...(await cosmeticCore()), byList: {} } };
  }
  return cosmeticCoreView.data;
}

/**
 * The generic sheet's list-driven registration: its stylesheets, and the hosts and pages the
 * enabled lists take out of generic hiding. Both come from the core, so a wake does not read the
 * lists. Data compiled before cosmetic.json carried `genericCss` has one sheet per list, named
 * in meta.json.
 */
async function genericSheetRegistration(
  ids: string[],
): Promise<{ css: string[]; excludeMatches: string[] }> {
  const reg = genericCssRegistration(await cosmeticRegistrationData(ids), ids);
  if (reg.css.length) return reg;
  const css = ids
    .map((id) => META.lists.find((l) => l.id === id)?.genericCssFile)
    .filter((p): p is string => !!p)
    .map((p) => `generated/${p}`);
  return { css, excludeMatches: reg.excludeMatches };
}

/**
 * The revert twins of the generic sheets registered for these lists (paths under the root), for
 * a frame the registered sheet reached; null where the lists keep it out (www.youtube.com,
 * docs.google.com, a search results page). There a revert has nothing to undo, and would only
 * override the frame's own display on every element matching one of ~29k selectors.
 */
async function genericRevertFilesFor(
  hostname: string,
  ids: string[],
  frameUrl: string | undefined,
): Promise<string[] | null> {
  const data = await cosmeticRegistrationData(ids);
  if (!genericSheetApplies(hostname, data, ids, frameUrl)) return null;
  return genericCssFiles(data, ids).map((s) => `generated/${s.revert}`);
}

/**
 * matchCosmetic over the enabled lists for one frame. Where an entity exception switches generic
 * hiding off (EasyList's `www.google.*` search-results generichide: every Google results page),
 * the registered sheet is undone with its packaged revert files, not ~14,000 selectors sent to
 * the page.
 */
async function cosmeticMatchFor(
  hostname: string,
  ids: string[],
  pageUrl: string | undefined,
  userUnhide: string[],
): Promise<ReturnType<typeof matchCosmetic>> {
  return matchCosmetic(hostname, await cosmeticData(ids), ids, pageUrl, {
    userUnhide,
    genericRevert: 'files',
  });
}

function enabledListIds(settings: Settings): string[] {
  return META.lists
    .filter((l) => !settings.paused && isListEnabled(settings, l.id, l.enabledByDefault))
    .map((l) => l.id);
}

// ---------------------------------------------------------------------------
// Rule / script synchronization
// ---------------------------------------------------------------------------

/** What the last ruleset sync could not load, so a wake that changes nothing logs nothing. */
const REFUSED_LISTS_KEY = 'stampstack.refusedLists';

async function syncRulesets(settings: Settings): Promise<void> {
  const want = META.lists
    .filter((l) => !settings.paused && isListEnabled(settings, l.id, l.enabledByDefault))
    .map((l) => l.id);

  // The service worker is ephemeral, so this runs on every wake — many times a day. Enabling
  // a ruleset that is already enabled is not free: Chrome re-indexes, and with ~120k rules
  // that is the most expensive thing the worker does. Skip the call entirely when the live
  // state already matches.
  let live: string[] | null = null;
  try {
    live = await chrome.declarativeNetRequest.getEnabledRulesets();
  } catch {
    /* fall through and do the work */
  }
  if (live && [...live].sort().join(',') === [...want].sort().join(',')) {
    await noteRefusedLists([]);
    return;
  }
  const liveSet = new Set(live ?? []);

  // Disable unwanted rulesets first — always succeeds and frees global-pool budget.
  const disable = META.lists
    .map((l) => l.id)
    .filter((id) => !want.includes(id) && (live == null || liveSet.has(id)));
  if (disable.length) {
    try {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: disable });
    } catch (e) {
      console.error('[StampStack] disable rulesets failed', e);
    }
  }

  // Enable wanted rulesets. We ship well past the 30k guaranteed minimum, so the extra rules
  // draw from a global pool shared with every other installed extension. If that pool is
  // exhausted, enabling the full set THROWS and would leave the user with zero blocking.
  // Degrade gracefully: leave out the largest ruleset until the rest fit (the built-in seed is
  // never left out), so a tight pool costs coverage rather than all protection. Self-heals —
  // every sync asks again, so a list left out comes back once the pool frees up.
  //
  // Only lists that are not live yet are candidates: a live list already holds its share, so
  // leaving it out of an enable call changes nothing (the old loop "dropped" live lists and
  // logged it every wake). Chrome says how much room is left, so a pool that cannot fit a list
  // costs one query per wake rather than a refused call and a warning.
  const ruleCount = (id: string): number => META.lists.find((l) => l.id === id)?.ruleCount ?? 0;
  let pending = want.filter((id) => !liveSet.has(id));
  const largestDroppable = (ids: string[]): string | null => {
    const droppable = ids.filter((id) => id !== 'quell-seed');
    return droppable.length
      ? droppable.reduce((a, b) => (ruleCount(b) > ruleCount(a) ? b : a))
      : null;
  };
  let room: number | null = null;
  try {
    room = (await chrome.declarativeNetRequest.getAvailableStaticRuleCount?.()) ?? null;
  } catch {
    room = null;
  }
  if (room != null) {
    while (pending.reduce((n, id) => n + ruleCount(id), 0) > room) {
      const largest = largestDroppable(pending);
      if (!largest) break;
      pending = pending.filter((id) => id !== largest);
    }
  }
  while (pending.length) {
    try {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: pending });
      break;
    } catch (e) {
      const largest = largestDroppable(pending);
      if (!largest) {
        console.error('[StampStack] updateEnabledRulesets failed for the minimal set', e);
        pending = [];
        break;
      }
      pending = pending.filter((id) => id !== largest);
    }
  }
  const loaded = new Set([...liveSet, ...pending]);
  await noteRefusedLists(want.filter((id) => !loaded.has(id)));
}

/** Log a refused set once per change, not on every wake that finds the pool still full. */
async function noteRefusedLists(refused: string[]): Promise<void> {
  const key = [...refused].sort().join(',');
  let before = '';
  try {
    before = String((await chrome.storage.session?.get(REFUSED_LISTS_KEY))?.[REFUSED_LISTS_KEY] ?? '');
  } catch {
    /* no session storage: log every time rather than never */
  }
  if (before === key) return;
  if (refused.length) {
    console.warn(
      `[StampStack] static rule pool full — not loaded: ${refused
        .map((id) => `${id} (${META.lists.find((l) => l.id === id)?.ruleCount ?? 0} rules)`)
        .join(', ')}`,
    );
  } else if (before) {
    console.info('[StampStack] every enabled list is loaded again');
  }
  try {
    await chrome.storage.session?.set({ [REFUSED_LISTS_KEY]: key });
  } catch {
    /* see above */
  }
}

/**
 * Exact-host match patterns for dark-mode registration — no `*://*.h/*` subdomain wildcard.
 * resolveDarkModeForHost resolves per-site overrides by EXACT (www-stripped) host, so the
 * registered FOUC scope must match that, or a force-off/on on example.com would wrongly
 * exclude/include sub.example.com and diverge from what the content script applies.
 */
function darkModeHostPatterns(host: string): string[] {
  return exactHostMatchPatterns(host);
}

async function syncAllowlist(settings: Settings): Promise<void> {
  // Rebuild only the allowlist id band — never touch custom rules (>= ALLOWLIST_ID_END).
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing
    .filter((r) => r.id >= ALLOWLIST_ID_START && r.id < ALLOWLIST_ID_END)
    .map((r) => r.id);

  const entries = [...new Set(settings.allowlist.map(siteRuleKey).filter(Boolean))];
  // main_frame only. allowAllRequests on the top-level navigation already allows every request
  // in that tab's frame tree, iframes included. Adding sub_frame would also match an iframe
  // FROM the allowlisted host embedded on any other site, so allowlisting youtube.com would
  // unblock every YouTube embed everywhere. uBO keys its trusted-site switch on the top page.
  // An exact entry (go.dev, an intranet name: site-rules.ts) is two anchored URL rules, each
  // also held to that host by requestDomains, which alone would cover every host under it.
  const conditions = entries.flatMap(siteRuleDnrConditions);
  const addRules: chrome.declarativeNetRequest.Rule[] = conditions.map((condition, i) => ({
    id: ALLOWLIST_ID_START + i,
    priority: ALLOWLIST_PRIORITY,
    action: { type: 'allowAllRequests' as chrome.declarativeNetRequest.RuleActionType },
    condition: {
      ...condition,
      resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType],
    },
  }));

  // Same reasoning as syncRulesets: this runs on every wake, and rewriting identical dynamic
  // rules is pure churn. The key covers resourceTypes too, so rules written by an older build
  // with a different shape are replaced on upgrade rather than kept forever.
  const bandKey = (r: chrome.declarativeNetRequest.Rule): string => {
    const domains = (r.condition.requestDomains ?? []).join('|');
    const types = [...(r.condition.resourceTypes ?? [])].sort().join('|');
    return `${r.id}:${domains}:${r.condition.urlFilter ?? ''}:${types}`;
  };
  const liveBand = existing
    .filter((r) => r.id >= ALLOWLIST_ID_START && r.id < ALLOWLIST_ID_END)
    .map(bandKey)
    .sort()
    .join(',');
  const wantBand = addRules.map(bandKey).sort().join(',');
  if (liveBand === wantBand) return;

  // Rejects rather than logs: Chrome applies an update whole or not at all, so a failure means
  // network blocking for these hosts is unchanged, and a caller that just changed the allowlist
  // must say so (handleToggleSite). A long profile path on Windows (MAX_PATH under
  // `DNR Extension Rules/`) is one way to get "Internal error while updating dynamic rules."
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

/**
 * Register (or update / unregister) generic cosmetic CSS, the YouTube MAIN hooks and the list
 * scriptlet shards. All honor pause + allowlist excludes.
 *
 * The allowlist and breakage fixes belong to the top-level page (see policyHost), but
 * excludeMatches is tested against each frame's own URL. The YouTube hooks get that right by
 * splitting top frames from embeds, and the scriptlet runtime by acting only where the frame's
 * host is the top page's (frame-scope.ts), leaving other frames to handleScriptlets. The generic
 * sheet cannot: an allowlisted page's third-party iframes still get it, and an embed from an
 * allowlisted host goes without it on other sites. handleCosmetic corrects both per frame, with
 * the sheet's revert files or the sheet itself (B24).
 */
async function syncRegisteredScripts(settings: Settings): Promise<void> {
  const shouldExist = !settings.paused;
  // User entries cover what the popup and the network layer say they cover (site-rules.ts): a
  // legacy or imported `github.io` excludes github.io itself here, never every tenant.
  const userCosmeticsOff = [...settings.allowlist, ...hostsWithCosmeticsOff(settings.siteFixes)];
  const userScriptletsOff = [...settings.allowlist, ...hostsWithScriptletsOff(settings.siteFixes)];
  // Always an array, never undefined: syncOneRegisteredScript compares against the live
  // registration, and an absent property would read as "leave whatever is there".
  // The YouTube MAIN-world hooks are scriptlets, so an `injection`-level fix must exclude
  // them too or "scriptlets off" would not actually be off on YouTube.
  const allowlistExclude = [...new Set(userScriptletsOff.flatMap(siteRuleMatchPatterns))];

  const ids = enabledListIds(settings);
  // Only exceptions from *enabled* lists exclude the generic sheet (a disabled cookie list must
  // not keep its @@$generichide hosts unhidden), and only hosts and pages a match pattern can
  // name: matchCosmetic reverts the sheet per page for entity exceptions (example.*), and
  // assumes exactly these excludes when it decides a page needs that (genericCssRegistration).
  // Unreadable data leaves the generic sheet as it is rather than taking the YouTube hooks and
  // the scriptlets down with it.
  let generic: { css: string[]; excludeMatches: string[] } | null = null;
  try {
    generic = await genericSheetRegistration(ids);
  } catch (e) {
    console.error('[StampStack] cosmetic data unreadable; generic sheet left as it was', e);
  }
  const cosmeticExclude = [
    ...new Set([
      // Breakage fixes must also drop the registered generic sheet — it is injected by
      // chrome.scripting, so suppressing the per-page payload in handleCosmetic is not
      // enough to stop generic hiding on that host.
      ...userCosmeticsOff.flatMap(siteRuleMatchPatterns),
      ...(generic?.excludeMatches ?? []),
    ]),
  ];
  const cssFiles = generic?.css ?? [];

  const cosmetic: chrome.scripting.RegisteredContentScript = {
    id: GENERIC_CSS_SCRIPT_ID,
    css: cssFiles,
    matches: ['<all_urls>'],
    excludeMatches: cosmeticExclude,
    runAt: 'document_start',
    allFrames: true,
    // about:blank, srcdoc and document.write frames a page makes for itself are that page (its
    // origin): friendly-iframe ads are written into exactly those, as the content script's
    // cosmetic:get already assumes (B25). The excludes see the creator's origin there.
    matchOriginAsFallback: true,
    persistAcrossSessions: true,
  };

  const youtubeMatches = [
    '*://*.youtube.com/*',
    '*://*.youtube-nocookie.com/*',
    '*://youtu.be/*',
    '*://*.youtubekids.com/*',
  ];
  // Top-level YouTube pages: here the frame URL is the page, so the allowlist excludes work.
  const youtube: chrome.scripting.RegisteredContentScript = {
    id: YOUTUBE_SCRIPTLETS_SCRIPT_ID,
    js: ['scriptlets-youtube.js'],
    matches: youtubeMatches,
    excludeMatches: allowlistExclude,
    runAt: 'document_start',
    allFrames: false,
    world: 'MAIN',
    persistAcrossSessions: true,
  };
  // Embeds follow the page they sit on, which excludeMatches cannot test: switching off
  // youtube.com must not unhook YouTube players on every other site. The script itself skips
  // the top frame. Known limit, the other way round: a YouTube frame on an allowlisted page
  // (youtube.com's own subframes included) is still hooked.
  const youtubeFrames: chrome.scripting.RegisteredContentScript = {
    id: YOUTUBE_FRAME_SCRIPTLETS_SCRIPT_ID,
    js: ['scriptlets-youtube-frames.js'],
    matches: youtubeMatches,
    excludeMatches: [],
    runAt: 'document_start',
    allFrames: true,
    world: 'MAIN',
    persistAcrossSessions: true,
  };
  const youtubeOn = shouldExist && settings.youtubeBlockSponsored !== false;

  await settleEach('syncRegisteredScripts', [
    ['legacy scriptlets cleanup', removeLegacyScriptlets()],
    [
      cosmetic.id,
      generic || !shouldExist
        ? syncOneRegisteredScript(cosmetic, shouldExist && cssFiles.length > 0)
        : Promise.resolve(),
    ],
    // Sponsored scrub runs only when the YouTube sponsored toggle is on.
    [youtube.id, syncOneRegisteredScript(youtube, youtubeOn)],
    [youtubeFrames.id, syncOneRegisteredScript(youtubeFrames, youtubeOn)],
    ['scriptlet shards', syncScriptletShards(ids, allowlistExclude)],
  ]);
}

/**
 * Data files Chrome injects per scriptlet shard registration (id → js), as of the last sync or
 * lookup. null whenever it is not known (every wake, and during a sync), so handleScriptlets
 * looks it up rather than trust a guess. `liveShardsGen` stops a lookup that started before a
 * sync from overwriting what the sync found.
 */
let liveShards: Map<string, string[]> | null = null;
let liveShardsGen = 0;

/**
 * What the last successful shard sync left registered, in storage.session. Reading the
 * registrations back from Chrome returns all ~22k patterns (about 10 ms, measured); a wake only
 * needs to know whether anything changed. storage.session is emptied by everything else that
 * can touch the registrations (browser restart, extension update or reload), so a stored state
 * is always one Chrome still holds.
 */
const SHARD_STATE_KEY = 'stampstack.scriptletShards';

interface ShardState {
  shape: string;
  live: Record<string, string[]>;
}

async function readShardState(): Promise<ShardState | null> {
  try {
    const got = await chrome.storage.session?.get(SHARD_STATE_KEY);
    const state = got?.[SHARD_STATE_KEY] as ShardState | undefined;
    return state && typeof state.shape === 'string' && state.live ? state : null;
  } catch {
    return null;
  }
}

async function writeShardState(state: ShardState | null): Promise<void> {
  try {
    if (state) await chrome.storage.session?.set({ [SHARD_STATE_KEY]: state });
    else await chrome.storage.session?.remove(SHARD_STATE_KEY);
  } catch {
    /* no session storage: every wake asks Chrome instead */
  }
}

async function liveShardFiles(): Promise<Map<string, string[]>> {
  if (liveShards) return liveShards;
  const gen = liveShardsGen;
  const state = await readShardState();
  const live = state
    ? new Map(Object.entries(state.live))
    : new Map(
        (await chrome.scripting.getRegisteredContentScripts())
          .filter((s) => s.id.startsWith(SCRIPTLET_SHARD_ID_PREFIX))
          .map((s) => [s.id, s.js ?? []]),
      );
  if (gen === liveShardsGen) liveShards = live;
  return live;
}

/**
 * List scriptlets as document_start MAIN-world content scripts (REVIEW_2026-09-24 B2): one per
 * host bucket plus one broad script for entity rules, each carrying the enabled lists' data
 * files and the runtime, as one bundled file when the default lists are on. Before this they
 * were fetched by message and injected with executeScript, which landed after the page's inline
 * <head> scripts, too late for most anti-adblock defusers. `ids` is empty while paused, which
 * unregisters them all.
 */
async function syncScriptletShards(ids: string[], excludeMatches: string[]): Promise<void> {
  const desired = shardRegistrations(SHARDS, ids).map(
    (r): LazyContentScript => ({
      id: r.id,
      js: r.js,
      matches: r.matches,
      excludeMatches,
      runAt: 'document_start',
      // about:blank / srcdoc frames a page makes for itself (friendly-iframe ads) run as their
      // creator's origin, so they match and get their host's rules. Sandboxed ones without
      // `allow-scripts` match too, and Chrome logs one "Blocked script execution" error there
      // per file: hence the bundles (shardRegistrations).
      matchOriginAsFallback: true,
      allFrames: true,
      world: 'MAIN',
      persistAcrossSessions: true,
    }),
  );
  // `matches` is a function and drops out; the js names already pin it (content-addressed).
  const shape = JSON.stringify(desired);
  const state = await readShardState();
  if (state?.shape === shape) {
    liveShardsGen++;
    liveShards = new Map(Object.entries(state.live));
    return;
  }
  liveShardsGen++;
  liveShards = null;
  // Forget the old state first: a sync that dies halfway must not leave one a wake would trust.
  await writeShardState(null);
  const live = await syncRegisteredScriptGroup(SCRIPTLET_SHARD_ID_PREFIX, desired);
  liveShardsGen++;
  liveShards = live;
  await writeShardState({ shape, live: Object.fromEntries(live) });
}

/**
 * Registrations are settled independently: Chrome rejects a payload as a whole, and one rejected
 * script (an unparseable exclude pattern, say) must not also skip the syncs next to it.
 */
async function settleEach(label: string, jobs: [string, Promise<void>][]): Promise<void> {
  const settled = await Promise.allSettled(jobs.map(([, job]) => job));
  settled.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[StampStack] ${label}: ${jobs[i][0]} failed`, r.reason);
    }
  });
}

/**
 * 0.1.0 registered list scriptlets globally (MAIN world, <all_urls>, persisted); they are now
 * registered per host bucket (syncScriptletShards). unregisterContentScripts rejects the whole
 * call when any id is not registered, so remove only what is actually there.
 */
async function removeLegacyScriptlets(): Promise<void> {
  const live = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPTLETS_SCRIPT_ID] });
  for (const s of live) await chrome.scripting.unregisterContentScripts({ ids: [s.id] });
}


/**
 * Paid dark mode — independent of pause/allowlist cosmetics.
 * Global on → register with force-off excludes; global off → force-on matches only.
 */
async function syncDarkModeScripts(
  settings: Settings,
  license: LicenseState = defaultLicense(),
): Promise<void> {
  const paid = isLicenseEffectivelyPaid(license);
  const forceOffExclude = [
    ...new Set(hostsWithForceOff(settings.darkModeSiteOverrides).flatMap(darkModeHostPatterns)),
  ];
  const forceOnMatches = [
    ...new Set(hostsWithForceOn(settings.darkModeSiteOverrides).flatMap(darkModeHostPatterns)),
  ];

  // Top frame ONLY (allFrames: false): the FOUC shell forces an opaque charcoal canvas, which
  // must never hit iframes — transparent-by-design embeds (Stripe fields, sign-in buttons,
  // overlay widgets) would become opaque dark slabs with un-recolored text. Subframes are
  // darkened by the engine itself (runs in every frame, gated on the TOP host via sender.tab),
  // which keeps transparent backgrounds transparent.
  const globalScript: chrome.scripting.RegisteredContentScript = {
    id: DARK_MODE_SCRIPT_ID,
    css: [DARK_MODE_CSS_PATH],
    matches: ['http://*/*', 'https://*/*'],
    excludeMatches: forceOffExclude,
    runAt: 'document_start',
    allFrames: false,
    persistAcrossSessions: true,
  };

  const forceOnScript: chrome.scripting.RegisteredContentScript = {
    id: DARK_MODE_FORCE_ON_SCRIPT_ID,
    css: [DARK_MODE_CSS_PATH],
    matches: forceOnMatches.length ? forceOnMatches : ['http://*/*'],
    runAt: 'document_start',
    allFrames: false,
    persistAcrossSessions: true,
  };

  const globalOn = paid && settings.darkModeEnabled;
  await settleEach('syncDarkModeScripts', [
    [globalScript.id, syncOneRegisteredScript(globalScript, globalOn)],
    // When global is on, force-on hosts are already covered; only need force script when global off.
    [
      forceOnScript.id,
      syncOneRegisteredScript(
        forceOnScript,
        paid && !settings.darkModeEnabled && forceOnMatches.length > 0,
      ),
    ],
  ]);
}

/** How long one tab gets to take a broadcast before the worker stops waiting on it. */
const TAB_MESSAGE_TIMEOUT_MS = 1000;

/** `p`, or `fallback` once `ms` have passed. The timer never outlives the race. */
function settleWithin<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/**
 * Send `msg` to every open web tab (top frames and subframes alike: each content script that
 * listens answers for itself).
 *
 * Never awaited inside settingsChain (REVIEW_2026-09-24 B33). A tab answers only when its main
 * thread is free: with an alert() open, even in a background tab, one toggle waited 13 s, and a
 * busy page 59 s, while every queued toggle and filter write waited behind it. Each tab gets
 * TAB_MESSAGE_TIMEOUT_MS; one that misses it picks the change up on its next navigation.
 */
async function broadcastToTabs(
  msg: Message,
  urls: string[] = ['http://*/*', 'https://*/*'],
  perTab?: (tabId: number) => Promise<unknown>,
): Promise<void> {
  let tabs: chrome.tabs.Tab[] = [];
  try {
    tabs = await chrome.tabs.query({ url: urls });
  } catch {
    return;
  }
  await Promise.all(
    tabs.map((tab) => {
      // A discarded tab has no page to tell, and Chrome keeps content scripts off the Web Store.
      if (tab.id == null || tab.discarded || isExtensionRestrictedHostname(hostOf(tab.url))) {
        return undefined;
      }
      const tabId = tab.id;
      const send = (async () => {
        if (perTab) await perTab(tabId).catch(() => {});
        await chrome.tabs.sendMessage(tabId, msg);
      })();
      return settleWithin(send, TAB_MESSAGE_TIMEOUT_MS, undefined);
    }),
  );
}

/**
 * Live-update open tabs after a toggle, instantly and without a reload. The content script
 * re-evaluates and applies the correct visual itself: the matte smart invert on a light page,
 * or a no-op reset on an already-dark page.
 *
 * We deliberately do NOT insertCSS the invert here. Doing so applied it to every tab whose
 * host resolves to "on" — including already-dark pages, which would flash to light for a frame
 * before the content script cancelled it. Letting the content script decide keeps the toggle
 * both instant and flash-free.
 *
 * No paid gate here: on a paid→unpaid transition we still need to reach open tabs so the
 * content script can cancel any lingering invert (it resets itself when darkmode:get reports
 * unpaid). The content script is the authority on what to apply. Fire-and-forget: see
 * broadcastToTabs.
 */
function refreshDarkModeInOpenTabs(): Promise<void> {
  return broadcastToTabs({ type: 'darkmode:refresh' }, undefined, async (tabId) => {
    // Clean up any invert sheet an older build inserted via insertCSS (harmless if none).
    await chrome.scripting.removeCSS({
      target: { tabId, allFrames: true },
      files: [DARK_MODE_CSS_PATH],
    });
  }).catch(() => {});
}

/** Re-apply the user's filters and site-specific hiding on open pages, without a reload. */
function refreshCosmeticsInOpenTabs(): Promise<void> {
  return broadcastToTabs({ type: 'cosmetic:refresh' }).catch(() => {});
}

/** YouTube pages re-read their options (youtube:getOptions) after something they follow changed. */
function refreshYoutubeInOpenTabs(): Promise<void> {
  return broadcastToTabs({ type: 'youtube:refresh' }, [
    '*://*.youtube.com/*',
    '*://*.youtube-nocookie.com/*',
    '*://*.youtubekids.com/*',
  ]).catch(() => {});
}

/**
 * Bring the dark-mode registrations in line with the stored settings, inside settingsChain so a
 * quick on/off cannot leave the older sync last (the FOUC shell stayed registered with dark mode
 * off in 9 of 60 fast toggles), then tell open tabs without waiting on them.
 */
async function syncDarkModeNow(license: LicenseState): Promise<void> {
  await withSettings((s) => syncDarkModeScripts(s, license));
  void refreshDarkModeInOpenTabs();
}

/**
 * Every registration and ruleset from `settings`. Touches no tab: callers that changed
 * something a page shows broadcast after leaving settingsChain (B33).
 */
async function applyAll(settings: Settings, license?: LicenseState): Promise<void> {
  const lic = license ?? (await loadLicense());
  await Promise.all([
    syncRulesets(settings),
    // A resync has no one to tell; the next wake tries again.
    syncAllowlist(settings).catch((e) =>
      console.error('[StampStack] updateDynamicRules (allowlist) failed', e),
    ),
    syncRegisteredScripts(settings),
    syncDarkModeScripts(settings, lic),
  ]);
}

// Serialize read-modify-write of the single settings blob. Message handlers and the
// blocked-count flush run concurrently; without this, two `loadSettings → mutate →
// saveSettings` cycles interleave and the second clobbers the first's field change.
// Every step must `await loadSettings()` itself — never pass a stale chain value into
// nested mutateSettings (that deadlocks: mutate waits for the outer job that awaits it).
let settingsChain: Promise<unknown> = Promise.resolve();
function mutateSettings(mutator: (s: Settings) => void): Promise<Settings> {
  const next = settingsChain.then(async () => {
    const s = await loadSettings();
    mutator(s);
    await saveSettings(s);
    return s;
  });
  settingsChain = next.catch(() => undefined);
  return next;
}

/** Run exclusive settings-aware work; always reloads settings after prior chain jobs. */
function withSettings<T>(fn: (s: Settings) => Promise<T>): Promise<T> {
  const next = settingsChain.then(async () => {
    const s = await loadSettings();
    return fn(s);
  });
  settingsChain = next.catch(() => undefined);
  return next;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * `full` runs on install/update/browser-start; `wake` runs on every service-worker revival.
 *
 * Everything in the wake path must be idempotent AND cheap when nothing changed — the syncs
 * stay because they are the safety net against state drift, but each now short-circuits when
 * the live state already matches.
 */
/**
 * Turn on any regional list this browser's UI language calls for, once, at install.
 *
 * Only fills in ids the user has no stored opinion about, so it can never overwrite a choice.
 * Failures are logged and swallowed: a missing regional list must not stop the extension from
 * finishing its first run.
 */
async function applyLocaleDefaults(): Promise<void> {
  try {
    const ui = chrome.i18n?.getUILanguage?.() ?? '';
    const wanted = localeDefaultLists(ui).filter((id) => META.lists.some((l) => l.id === id));
    if (!wanted.length) return;

    const settings = await mutateSettings((s) => {
      for (const id of wanted) {
        if (!(id in s.enabledLists)) s.enabledLists[id] = true;
      }
    });
    console.info(`[StampStack] UI language ${ui}: enabled ${wanted.join(', ')}`);
    await withSettings((s) => Promise.allSettled([syncRulesets(s), syncRegisteredScripts(s)]));
    void settings;
  } catch (e) {
    console.error('[StampStack] locale default lists failed', e);
  }
}

type InitMode = 'full' | 'wake';

let initRunning: { mode: InitMode; done: Promise<void> } | null = null;
let initFullQueued: Promise<void> | null = null;

/**
 * Single-flight. This module's own wake init and onInstalled/onStartup's full one start
 * together on every browser start and update; run side by side they asked ExtensionPay twice
 * and resynced everything twice. A wake is covered by any run already going; a full start
 * waits for a running wake and then runs once.
 */
function init(mode: InitMode = 'full'): Promise<void> {
  const running = initRunning;
  if (running) {
    if (mode === 'wake' || running.mode === 'full') return running.done;
    initFullQueued ??= running.done.then(() => {
      initFullQueued = null;
      return init('full');
    });
    return initFullQueued;
  }
  const done: Promise<void> = runInit(mode)
    .catch((e) => console.error(`[StampStack] init (${mode}) failed`, e))
    .finally(() => {
      if (initRunning?.done === done) initRunning = null;
    });
  initRunning = { mode, done };
  return done;
}

async function runInit(mode: InitMode): Promise<void> {
  // Must run before license.unpacked / Dev unlock decisions. Module-scope state, so it is lost
  // on every wake and has to be re-probed regardless of mode.
  await probeInstallEnvironment();

  const cached = await loadLicense();
  const wasPaid = isLicenseEffectivelyPaid(cached);
  // Someone who paid before the first-unlock marker existed has had their unlock already.
  if (wasPaid) await markDarkModeUnlockedOnce();

  // One-shot migration, and already flag-guarded; onInstalled covers the upgrade case, so it
  // does not need to touch storage on every wake.
  if (mode === 'full') await clearBuggyAutoOffOverrides();

  // Reconcile first, from the cached license (REVIEW_2026-09-24 B34). An update resets the
  // rulesets to the manifest defaults and clears every registered script: until this runs, a
  // paused user gets full blocking and a list switched off is back on. It used to wait on
  // ExtensionPay first: 21 s with extensionpay.com slow, and for good with it hanging, since
  // every wake then hung again.
  await withSettings(async (settings) => {
    await applyAll(settings, cached);
    // Neutral grey, not brand green: a green badge melts into the green icon. White text 6:1.
    await chrome.action.setBadgeBackgroundColor({ color: '#5f6368' });
  });

  // Then the license, bounded by LICENSE_FETCH_TIMEOUT_MS inside refreshLicense.
  let license = cached;
  if (mode === 'full' || !licenseIsFresh(cached)) license = await refreshLicenseShared();
  license = await ensureUnpackedTestLicense();

  if (isUnpackedInstall() && isLicenseEffectivelyPaid(license)) {
    // One-shot on first unpacked run. init() re-runs on every SW cold-start, so without
    // this persisted flag a dev who later turns dark mode OFF would have it flipped back on.
    const flag = await chrome.storage.local.get(DARK_AUTO_ENABLE_KEY);
    if (!flag[DARK_AUTO_ENABLE_KEY]) {
      await mutateSettings((s) => {
        if (!s.darkModeEnabled) s.darkModeEnabled = true;
      });
      await chrome.storage.local.set({ [DARK_AUTO_ENABLE_KEY]: true });
      license = await loadLicense();
    }
  }

  // The dark-mode registrations follow the license: resync them when the paid state moved
  // (grace expiry, an ExtPay cancel, a dev unlock). Messaging every open tab is only needed
  // then, or on a genuine start; on an ordinary wake it would tell every tab nothing changed.
  const paidChanged = isLicenseEffectivelyPaid(license) !== wasPaid;
  if (paidChanged) await withSettings((s) => syncDarkModeScripts(s, license));
  if (mode === 'full' || paidChanged) void refreshDarkModeInOpenTabs();
}

const AUTO_OFF_RESET_KEY = 'stampstack.darkAutoOffReset.v1';
const DARK_AUTO_ENABLE_KEY = 'stampstack.darkAutoEnable.v1';
/** Set once dark mode has been switched on for a first unlock; later unlocks leave it alone. */
const DARK_UNLOCKED_ONCE_KEY = 'stampstack.darkUnlockedOnce.v1';

/** Record the first unlock. True only for the call that recorded it. */
async function markDarkModeUnlockedOnce(): Promise<boolean> {
  const flag = await chrome.storage.local.get(DARK_UNLOCKED_ONCE_KEY);
  if (flag[DARK_UNLOCKED_ONCE_KEY]) return false;
  await chrome.storage.local.set({ [DARK_UNLOCKED_ONCE_KEY]: true });
  return true;
}

/** Remove force-off entries that were auto-persisted under the invert false-positive bug. */
async function clearBuggyAutoOffOverrides(): Promise<void> {
  const flag = await chrome.storage.local.get(AUTO_OFF_RESET_KEY);
  if (flag[AUTO_OFF_RESET_KEY]) return;
  await mutateSettings((s) => {
    if (!s.darkModeAutoOff) s.darkModeAutoOff = {};
    for (const host of Object.keys(s.darkModeAutoOff)) {
      if (s.darkModeSiteOverrides[host] === 'off') delete s.darkModeSiteOverrides[host];
      delete s.darkModeAutoOff[host];
    }
  });
  await chrome.storage.local.set({ [AUTO_OFF_RESET_KEY]: true });
}

/**
 * The cache just turned paid: a purchase, a restore, or a verify after the cache had lapsed.
 * Dark mode switches itself on for the first unlock only. A buyer who turned it off must not
 * find it back on because a grace period ran out while offline, or ExtensionPay once answered
 * "unpaid" and then "paid" again.
 */
async function onLicenseUnlocked(license: LicenseState): Promise<void> {
  if (await markDarkModeUnlockedOnce()) {
    await mutateSettings((s) => {
      s.darkModeEnabled = true;
    });
  }
  await syncDarkModeNow(license);
}

interface LicenseRefresh {
  at: number;
  settled: boolean;
  result: Promise<{ license: LicenseState; reached: boolean }>;
}

/**
 * The last license refresh, shared. init's wake and full runs, the popup and Options opening,
 * and "Refresh license" all ask, often within a second of each other, and ExtensionPay's answer
 * does not change in between. A caller that needs a newer answer passes a smaller `maxAgeMs`;
 * one still in flight is always joined.
 */
let licenseRefresh: LicenseRefresh | null = null;

function refreshLicenseSharedDetailed(
  maxAgeMs = 60_000,
): Promise<{ license: LicenseState; reached: boolean }> {
  const last = licenseRefresh;
  if (last && (!last.settled || Date.now() - last.at < maxAgeMs)) return last.result;
  const entry: LicenseRefresh = { at: Date.now(), settled: false, result: refreshLicenseDetailed() };
  const settle = (): void => {
    entry.settled = true;
  };
  entry.result.then(settle, settle);
  licenseRefresh = entry;
  return entry.result;
}

async function refreshLicenseShared(maxAgeMs?: number): Promise<LicenseState> {
  return (await refreshLicenseSharedDetailed(maxAgeMs)).license;
}

/**
 * Opening the popup or Options re-verifies the purchase (spec B.2, REVIEW_2026-09-24 M16), so
 * a purchase made on another device, or a refund, shows up where the user looks for it. At most
 * once per LICENSE_UI_RECHECK_MS, and never awaited by the page that triggered it.
 */
const LICENSE_UI_RECHECK_MS = 10 * 60 * 1000;
let licenseUiRecheckAt = 0;

async function maybeReverifyLicense(): Promise<void> {
  const now = Date.now();
  if (now - licenseUiRecheckAt < LICENSE_UI_RECHECK_MS) return;
  licenseUiRecheckAt = now;
  const cached = await loadLicense();
  if (cached.verifiedAt != null && now - cached.verifiedAt < LICENSE_UI_RECHECK_MS) return;
  const wasPaid = isLicenseEffectivelyPaid(cached);
  const license = await refreshLicenseShared(LICENSE_UI_RECHECK_MS);
  // A new unlock has already re-synced through onLicenseUnlocked; a lapse or refund must here.
  if (wasPaid && !isLicenseEffectivelyPaid(license)) await syncDarkModeNow(license);
}

/**
 * Keyboard shortcut for the element picker.
 *
 * The picker is the one feature that is actively worse via the popup: opening the panel to
 * start it means the thing you want to point at is behind the panel. `commands` needs no
 * permission, and the user can rebind or clear it in chrome://extensions/shortcuts.
 */
chrome.commands?.onCommand.addListener((command) => {
  if (command !== 'pick-element') return;
  void handlePickerStart();
});

initLicense(onLicenseUnlocked);

chrome.runtime.onInstalled.addListener((details) => {
  // Fresh installs only. On an update the user's toggles are already their own answer, and
  // re-applying a regional default would silently switch back on a list they turned off.
  if (details.reason === 'install') void applyLocaleDefaults();
  if (details.reason === 'update') void migrateSponsorCategories(details.previousVersion);
  void init('full');
  if (details.reason === 'install' || details.reason === 'update') void reinjectContentScripts();
});
chrome.runtime.onStartup.addListener(() => void init('full'));
// Module scope: this is the every-wake path, not a start. Keep it cheap.
void init('wake');

/**
 * 2.2.0 and older read an absent SponsorBlock category as on; 2.2.1 as its default (sponsor
 * only). On the update that leaves such a version, the user's choices are written out so they
 * keep meaning what they meant (migrateLegacySponsorCategories).
 */
async function migrateSponsorCategories(previousVersion: string | undefined): Promise<void> {
  const settings = await loadSettings();
  if (!migrateLegacySponsorCategories(settings.sponsorBlockCategories, previousVersion)) return;
  await mutateSettings((s) => {
    const next = migrateLegacySponsorCategories(s.sponsorBlockCategories, previousVersion);
    if (next) s.sponsorBlockCategories = next;
  });
}

/**
 * Tabs open across an install or update have no live content script (REVIEW_2026-09-24 M2).
 * Chrome injects the manifest's content scripts only into pages loaded afterwards, and an update
 * cuts the old ones off from the worker, so those tabs lost SponsorBlock, live toggles, the
 * filter refresh and the page report until reloaded while the popup described them as covered.
 * The new content script goes into each of their frames; the orphaned one stands down by itself.
 */
async function reinjectContentScripts(): Promise<void> {
  let tabs: chrome.tabs.Tab[] = [];
  try {
    tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  } catch {
    return;
  }
  const files =
    chrome.runtime.getManifest().content_scripts?.find((c) => c.js?.includes('content.js'))?.js ??
    ['content.js'];
  await Promise.all(
    tabs.map(async (tab) => {
      // A discarded tab reloads, and gets the manifest's scripts, when it is next shown.
      if (tab.id == null || tab.discarded || isExtensionRestrictedHostname(hostOf(tab.url))) return;
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files });
      } catch {
        /* a page Chrome keeps extensions out of (an error page, the PDF viewer) */
      }
    }),
  );
}

function hostOf(url: string | undefined | null): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Blocked-request counting + badge (fires only for unpacked/dev builds)
// ---------------------------------------------------------------------------

const debug = chrome.declarativeNetRequest.onRuleMatchedDebug;
if (debug) {
  const DYNAMIC = chrome.declarativeNetRequest.DYNAMIC_RULESET_ID;
  const SESSION = chrome.declarativeNetRequest.SESSION_RULESET_ID;
  debug.addListener((info) => {
    const tabId = info.request.tabId;
    if (tabId < 0) return;
    if (info.rule.rulesetId === DYNAMIC || info.rule.rulesetId === SESSION) return;
    const next = (tabBlocked.get(tabId) ?? 0) + 1;
    tabBlocked.set(tabId, next);
    void chrome.action.setBadgeText({ tabId, text: next > 999 ? '999+' : String(next) });
    void bumpTotal();
  });

  // Reset the per-tab badge counter on top-frame navigation. Only meaningful alongside
  // onRuleMatchedDebug (dev/--dev-feedback builds), so it lives here — the `webNavigation`
  // permission is added only for those builds (scripts/build.mjs) and never ships to store.
  chrome.webNavigation?.onBeforeNavigate.addListener((d) => {
    if (d.frameId !== 0) return;
    tabBlocked.set(d.tabId, 0);
    void chrome.action.setBadgeText({ tabId: d.tabId, text: '' });
  });
}

let pendingTotal = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
async function bumpTotal(): Promise<void> {
  pendingTotal++;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const add = pendingTotal;
    pendingTotal = 0;
    void mutateSettings((s) => {
      s.blockedTotal += add;
    });
  }, 5000);
}

chrome.tabs.onRemoved.addListener((tabId) => tabBlocked.delete(tabId));

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

/**
 * What a content script may ask. A content script runs in a web page's renderer, and a renderer
 * the page has compromised can send whatever a content script can. These messages read what one
 * page needs, or (the picker) add one hide rule for the sender's own site. Everything else
 * changes settings or reads them whole, and is answered only for the extension's own pages: the
 * popup and Options. Web pages and other extensions cannot reach onMessage at all.
 */
const CONTENT_SCRIPT_MESSAGES: ReadonlySet<Message['type']> = new Set<Message['type']>([
  'cosmetic:get',
  'scriptlets:get',
  'youtube:getOptions',
  'sponsorblock:getSegments',
  'darkmode:get',
  'customfilters:add',
]);

/** The popup, Options, or another page of this extension (never a content script). */
function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || typeof sender.url !== 'string') return false;
  return sender.url.startsWith(chrome.runtime.getURL(''));
}

chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) => {
  // ExtPay's own content script messages the worker too, with plain strings its listener answers.
  if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') {
    return false;
  }
  const trusted = isExtensionPage(sender);
  if (!trusted && !CONTENT_SCRIPT_MESSAGES.has(msg.type)) {
    console.warn('[StampStack] refused', msg.type, 'from a content script', sender.url ?? '');
    sendResponse(null);
    return false;
  }
  handleMessage(msg, sender, trusted)
    .then((r) => sendResponse(r))
    .catch((e) => {
      console.error('[StampStack] message handler error', msg.type, e);
      sendResponse(null);
    });
  return true;
});

async function handleMessage(
  msg: Message,
  sender: chrome.runtime.MessageSender,
  trusted: boolean,
): Promise<unknown> {
  switch (msg.type) {
    case 'cosmetic:get':
      return handleCosmetic(msg, sender);

    case 'scriptlets:get':
      return handleScriptlets(msg, sender);

    case 'popup:get':
      void maybeReverifyLicense().catch(() => {});
      return handlePopupGet();

    case 'popup:toggleSite':
      return handleToggleSite(msg.hostname, msg.enabled);

    case 'popup:setPaused':
      return handleSetPaused(msg.paused);

    case 'report:get':
      return handleReportGet();

    case 'report:breakage':
      return handleBreakageReport(msg.hostname);

    case 'picker:start':
      return handlePickerStart();

    case 'customfilters:add':
      return handleCustomFilterAdd(msg.line, sender, trusted);

    case 'customfilters:get':
      return handleCustomFiltersGet();

    case 'customfilters:set':
      return handleCustomFiltersSet(msg.text);

    case 'page:collect':
      // SW → content script only; a tab must never answer this to itself.
      return null;

    case 'sitefix:set':
      return handleSiteFixSet(msg.hostname, msg.level);

    case 'sitefix:remove':
      return handleSiteFixRemove(msg.hostname);

    case 'allowlist:remove':
      return handleAllowlistRemove(msg.hostname);

    case 'sitefix:list':
      return handleSiteFixList();

    case 'settings:export':
      return handleSettingsExport();

    case 'settings:import':
      return handleSettingsImport(msg.json);

    case 'popup:setYoutubeOptions':
      return handleSetYoutubeOptions(
        msg.youtubeBlockSponsored,
        msg.youtubeBlockShorts,
        msg.youtubeSponsorBlock,
      );

    case 'youtube:getOptions':
      return handleYoutubeGetOptions(policyHost(msg.hostname, sender, msg.topHost));

    case 'sponsorblock:getCategories':
      return handleSponsorCategoriesGet();

    case 'sponsorblock:setCategory':
      return handleSponsorCategorySet(msg.category, msg.enabled);

    case 'sponsorblock:getSegments':
      return handleSponsorBlockGetSegments(msg.videoId);

    case 'lists:get':
      return handleListsGet();

    case 'lists:setEnabled':
      return handleListSetEnabled(msg.id, msg.enabled);

    case 'stats:get':
      return handleStatsGet();

    case 'darkmode:get':
      // Content scripts, every frame: the decision for the page the frame is on, and nothing
      // else. Extension pages: the full state for the host they name (or the active tab).
      if (!trusted) return handleDarkModeGetForPage(msg, sender);
      void maybeReverifyLicense().catch(() => {});
      return handleDarkModeGet(msg.hostname);

    case 'darkmode:setEnabled':
      return handleDarkModeSetEnabled(msg.enabled);

    case 'darkmode:setSiteOverride':
      return handleDarkModeSetSiteOverride(msg.hostname, msg.override);

    case 'cosmetic:refresh':
    case 'darkmode:refresh':
    case 'youtube:refresh':
      // SW → content only; tabs should not message the SW with these.
      return null;

    case 'license:get':
      void maybeReverifyLicense().catch(() => {});
      return handleLicenseGet();

    case 'license:openCheckout':
      return openCheckout();

    case 'license:openRestore':
      return openRestore();

    case 'license:refresh':
      return handleLicenseRefresh();

    case 'license:devUnlock':
      return handleLicenseDevUnlock();

    default:
      void (msg satisfies never);
      return null;
  }
}

/**
 * Host whose switches (the allowlist and breakage fixes) govern a content script's request: the
 * tab's top-level page, as for network blocking (syncAllowlist) and in uBO. A YouTube embed on
 * news.example follows news.example's switch, not youtube.com's, and a comment iframe on a
 * switched-off page is off too. Rules are still matched against the frame's own host.
 *
 * A prerendered page is not yet the tab's page (`sender.tab.url` is the page on screen), so its
 * subframes use the top host they report themselves (location.ancestorOrigins) when they do,
 * and their own host otherwise.
 */
function policyHost(
  frameHost: string,
  sender: chrome.runtime.MessageSender,
  reportedTopHost?: string | null,
): string {
  const topUrl = sender.tab?.url;
  if (!sender.frameId) return frameHost;
  if (sender.documentLifecycle === 'prerender') return reportedTopHost || frameHost;
  if (!topUrl || !isHttpOrHttpsUrl(topUrl)) return frameHost;
  try {
    return new URL(topUrl).hostname || frameHost;
  } catch {
    return frameHost;
  }
}

async function handleCosmetic(
  msg: Extract<Message, { type: 'cosmetic:get' }>,
  sender: chrome.runtime.MessageSender,
): Promise<CosmeticResponse> {
  const settings = await loadSettings();
  const hostname = String(msg.hostname ?? '');
  const site = policyHost(hostname, sender, msg.topHost);
  const ids = enabledListIds(settings);
  const top = isTopDocument(sender, msg);
  // The document may hold sheets an earlier worker inserted (syncDocumentSheet).
  const refetch = msg.refetch === true;
  // A breakage fix suppresses element hiding while leaving network blocking in place. The
  // registered generic stylesheet is excluded separately in syncRegisteredScripts — returning
  // nothing here only covers the per-page specific/procedural payload.
  if (
    settings.paused ||
    isSiteAllowlisted(site, settings.allowlist) ||
    fixDisablesCosmetics(resolveSiteFix(site, settings.siteFixes))
  ) {
    void syncDocumentSheet('USER', sender, null, refetch && top);
    // The registered sheet's excludes test each frame's own URL, so a third-party frame on a
    // switched-off page still got generic hiding (B24). uBO switches element hiding off for the
    // whole page: undo the sheet in that frame. Not while paused, when nothing is registered,
    // nor where the frame's own host or page kept the sheet out.
    // Elsewhere a revert already in the document stays (its sheet was injected before the switch),
    // including one the worker no longer remembers.
    const revert =
      !settings.paused && !top && !userCosmeticsOff(hostname, settings)
        ? await genericRevertFilesFor(hostname, ids, sender.url).catch(() => null)
        : null;
    void syncDocumentSheet('AUTHOR', sender, revert ?? revertsIn(sender), refetch && revert !== null);
    return {
      allowlisted: true,
      hide: [],
      unhide: [],
      procedural: [],
      disableGeneric: true,
      disableSpecific: true,
    };
  }
  // The user's own rules ride along with the list-derived ones. Their exceptions are applied
  // inside customCosmeticsFor, and their unhides also cancel list hides, procedural rules and
  // actions (matchCosmetic's userUnhide) — a user must be able to override a filter list, not
  // just their own picks.
  const custom = customCosmeticsFor(settings.customFilters, hostname);
  // The frame's own URL: page-scoped exceptions (EasyList's search-results generichide) need it.
  const m = await cosmeticMatchFor(hostname, ids, sender.url, custom.unhide);
  const hide = [...new Set([...m.hide, ...custom.hide])].filter(
    (s) => !custom.unhide.includes(s),
  );
  // Only what the generic sheet really hides here needs a `display: revert` (matchCosmetic
  // folds the user's exceptions in). Reverting every user `#@#` selector would override the
  // page's own CSS on elements nothing hid.
  const unhide = m.unhide;
  // The reverse of the B24 case above: a frame whose own host the user switched off, embedded in
  // a page that is on, had no generic sheet, since the excludes see only the frame's URL.
  const lostSheet = !top && !m.disableGeneric && userCosmeticsOff(hostname, settings);
  const authorFiles = [
    ...(lostSheet ? (await genericSheetRegistration(ids)).css : []),
    ...m.revertGenericCss,
  ];
  void syncDocumentSheet('AUTHOR', sender, authorFiles, refetch);
  const procedural = [
    ...m.procedural.filter((p) => !custom.unhide.includes(p.expr)),
    ...(custom.procedural ?? []),
  ];
  // The generic sheet again, as a USER-origin sheet (B21), where nothing asks for it to be
  // reverted or restyled: an element-hiding exception undoes generic hides with an author-origin
  // rule, and a `:style()` filter shows an element with one, which a user-origin `!important`
  // would beat.
  const restyles =
    m.actions.some((a) => a.action === 'style') || procedural.some((p) => p.expr.includes(':style('));
  const userSheet =
    top && !m.disableGeneric && !unhide.length && !restyles
      ? (await genericSheetRegistration(ids)).css
      : null;
  void syncDocumentSheet('USER', sender, userSheet, refetch && top);
  return {
    allowlisted: false,
    hide,
    unhide,
    procedural,
    ...(m.actions.length ? { actions: m.actions } : {}),
    disableGeneric: m.disableGeneric,
    disableSpecific: m.disableSpecific,
  };
}

/**
 * The user's own switches (the allowlist, a repair step) cover `frameHost` itself, so the
 * registered generic sheet's excludes (syncRegisteredScripts) keep it out of that frame.
 */
function userCosmeticsOff(frameHost: string, settings: Settings): boolean {
  if (!frameHost) return false;
  return (
    isSiteAllowlisted(frameHost, settings.allowlist) ||
    fixDisablesCosmetics(resolveSiteFix(frameHost, settings.siteFixes))
  );
}

/** A tab's top-level document, prerendered ones included (their frameId is not 0 until shown). */
function isTopDocument(
  sender: chrome.runtime.MessageSender,
  msg: { isTop?: boolean },
): boolean {
  if (sender.frameId === 0) return true;
  return sender.documentLifecycle === 'prerender' && msg.isTop === true;
}

type SheetOrigin = 'USER' | 'AUTHOR';

/**
 * documentId → the package stylesheets inserted there, per origin, so a refresh neither stacks
 * a second copy nor leaves one behind on a page that was switched off meanwhile. Lost on every
 * wake and bounded for a long-lived worker; a document that asks again says so (`refetch`), and
 * syncDocumentSheet then clears what an earlier worker may have left there.
 */
const documentSheets: Record<SheetOrigin, Map<string, string>> = {
  USER: new Map(),
  AUTHOR: new Map(),
};
const DOCUMENT_SHEET_MEMORY = 200;

/** The generic revert files already inserted into the sender's document, or null. */
function revertsIn(sender: chrome.runtime.MessageSender): string[] | null {
  const now = sender.documentId ? documentSheets.AUTHOR.get(sender.documentId) : undefined;
  const reverts = (now ?? '').split('\n').filter((f) => f.endsWith('.revert.css'));
  return reverts.length ? reverts : null;
}

/**
 * Package stylesheets inserted into the sender's document (null or [] removes what is there).
 *
 * USER: generic element hiding at user origin for a top-level page (REVIEW_2026-09-24 B21).
 * The registered generic sheet (syncRegisteredScripts) is author-origin: a page rule
 * `display: block !important`, or the same inline, beats it, and anti-adblock scripts that
 * re-show a hidden slot do exactly that. A user-origin `!important` beats both. chrome.scripting
 * can only insert user-origin CSS per document (registerContentScripts takes no origin:
 * "Unexpected property", Chromium 131), which lands after the content script's first message.
 * So the registered sheet stays, for first paint, and this one follows it: no flash of ads
 * before, and nothing a page can override after. Top frames only: measured with the default
 * lists, a second copy cost the top document about 5 ms of style work, and on a page with 20
 * ad iframes another copy in each delayed `load` by about 100 ms, for frames that are
 * themselves the ads.
 *
 * AUTHOR: the generic sheet's revert twins where an exception or a switched-off page undoes it,
 * or the sheet itself where the registration's excludes wrongly left a frame out (B24). Author
 * origin, inserted after the registered sheet, so a revert wins over it at equal specificity.
 */
async function syncDocumentSheet(
  origin: SheetOrigin,
  sender: chrome.runtime.MessageSender,
  files: string[] | null,
  mayHold = false,
): Promise<void> {
  const tabId = sender.tab?.id;
  const documentId = sender.documentId;
  if (tabId == null || !documentId) return;
  const sheets = documentSheets[origin];
  const target: chrome.scripting.InjectionTarget = { tabId, documentIds: [documentId] };
  const before = sheets.get(documentId);
  const next = files?.length ? files.join('\n') : undefined;
  // Forgotten, but the document may still hold what an earlier worker inserted: a user sheet
  // that now has to go (a new `#@#`, a switched-off page) would stay, and a copy inserted next
  // to it would outlive the next removal, which takes out one copy per call (Chromium 131). So
  // every file this origin could hold goes first; removing CSS never inserted is a no-op.
  const unknown = before === undefined && mayHold;
  if (before === next && !unknown) return;
  try {
    if (before) {
      sheets.delete(documentId);
      await chrome.scripting.removeCSS({ target, files: before.split('\n'), origin });
    } else if (unknown) {
      await chrome.scripting.removeCSS({ target, files: await insertableSheets(origin), origin });
    }
    if (next) {
      sheets.set(documentId, next);
      if (sheets.size > DOCUMENT_SHEET_MEMORY) {
        sheets.delete(sheets.keys().next().value as string);
      }
      await chrome.scripting.insertCSS({ target, files: files!, origin });
    }
  } catch {
    // Usually the document is already gone. The registered sheet still hides as before.
    sheets.delete(documentId);
  }
}

/** Every package stylesheet syncDocumentSheet can insert at `origin`, whatever the lists. */
async function insertableSheets(origin: SheetOrigin): Promise<string[]> {
  const plan = Object.values((await cosmeticCore().catch(() => null))?.genericCss ?? {}).flat();
  const sheets = [
    ...plan.map((s) => s.file),
    ...META.lists.map((l) => l.genericCssFile).filter((p): p is string => !!p),
  ];
  const reverts = origin === 'AUTHOR' ? plan.map((s) => s.revert) : [];
  return [...new Set([...sheets, ...reverts])].map((p) => `generated/${p}`);
}

/**
 * The fallback for list scriptlets; the document_start registrations (syncScriptletShards) are
 * the main path. Every frame asks once, and gets an injection only when:
 *   - it is a frame the registrations do not serve: its host differs from the top page's, so
 *     the switch that governs it is the top page's (B24), which only this worker knows;
 *   - or it is one they do serve, but the registration for its host is missing or behind (a
 *     failed sync, a list switched on a moment ago).
 * A single executeScript lands the data files and the runtime together, targeted at the
 * document that asked rather than its frame slot (B26).
 */
async function handleScriptlets(
  msg: Extract<Message, { type: 'scriptlets:get' }>,
  sender: chrome.runtime.MessageSender,
): Promise<ScriptletsResponse> {
  const settings = await loadSettings();
  const frameHost = String(msg.hostname ?? '').toLowerCase();
  // A registered frame is the top page or shares its host (frame-scope.ts), so its own host is
  // the page's, and matches what the registrations' excludeMatches saw.
  const site = msg.registered ? frameHost : policyHost(frameHost, sender, msg.topHost);
  if (
    settings.paused ||
    isSiteAllowlisted(site, settings.allowlist) ||
    fixDisablesScriptlets(resolveSiteFix(site, settings.siteFixes))
  ) {
    return { allowlisted: true, injected: false };
  }
  const ids = enabledListIds(settings);
  const live = msg.registered ? await liveShardFiles() : null;
  // The usual case for a top frame: every registration is in place, so there is nothing to
  // look up (the host index is only built when a frame actually needs it).
  if (
    live &&
    shardRegistrations(SHARDS, ids).every((r) => (live.get(r.id) ?? []).join('\n') === r.js.join('\n'))
  ) {
    return { allowlisted: false, injected: false };
  }
  const plan = frameHost ? planShardInjection(SHARDS, frameHost, ids) : null;
  if (!plan) return { allowlisted: false, injected: false };
  let groups = plan.registrations;
  if (live) {
    groups = groups.map((g) => {
      // A registered bundle already ran every data file inside it.
      const ran = shardParts(SHARDS, live.get(g.id) ?? []);
      return { id: g.id, files: g.files.filter((f) => !ran.includes(f)) };
    });
  }
  const files = groups.flatMap((g) => g.files);
  if (!files.length) return { allowlisted: false, injected: false };
  return { allowlisted: false, injected: await injectScriptletFallback(files, sender) };
}

async function injectScriptletFallback(
  files: string[],
  sender: chrome.runtime.MessageSender,
): Promise<boolean> {
  const tabId = sender.tab?.id;
  if (tabId == null) return false;
  // The document, not the frame: a frame that navigated since it asked would otherwise get the
  // previous site's scriptlets, and a prerendered page changes frameId when it is activated.
  const target: chrome.scripting.InjectionTarget = sender.documentId
    ? { tabId, documentIds: [sender.documentId] }
    : { tabId, frameIds: [sender.frameId ?? 0] };
  try {
    await chrome.scripting.executeScript({
      target,
      world: 'MAIN',
      injectImmediately: true,
      files: [...files, SHARDS.fallback, SCRIPTLET_RUNTIME_FILE],
    });
    return true;
  } catch (e) {
    // Usually the document is already gone (navigated or closed), which needs nothing.
    console.warn('[StampStack] scriptlet injection failed', e);
    return false;
  }
}

async function handlePopupGet(): Promise<PopupData> {
  const settings = await loadSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let hostname: string | null = null;
  const url = tab?.url ?? null;
  // Only real web pages get a host — chrome://, about:, file:, view-source: etc. can't be
  // acted on, so leaving hostname null disables the per-site controls there.
  if (url && isHttpOrHttpsUrl(url)) {
    try {
      hostname = new URL(url).hostname;
    } catch {
      hostname = null;
    }
  }
  const allowlisted = !!hostname && isSiteAllowlisted(hostname, settings.allowlist);
  // Count what Chrome actually loaded. Reporting the requested total would overstate
  // protection on a profile whose static-rule pool is exhausted.
  const { rows: listRows, degraded } = await buildListRows(settings);
  const activeRules = listRows.filter((l) => l.active).reduce((n, l) => n + l.ruleCount, 0);
  // A parent entry (example.com) allowlists sub.example.com, but removing the *sub* host from
  // the list cannot undo it. The popup needs to say so instead of offering a dead toggle.
  const ownKey = siteRuleKey(hostname);
  const coveredBy =
    hostname && allowlisted
      ? settings.allowlist
          .map(siteRuleKey)
          .find((h) => !!h && h !== ownKey && siteRuleCovers(h, hostname)) ?? null
      : null;
  const fix = resolveSiteFixEntry(hostname, settings.siteFixes);
  return {
    hostname,
    url,
    paused: settings.paused,
    allowlisted,
    tabBlocked: tab?.id != null ? tabBlocked.get(tab.id) ?? 0 : 0,
    blockedTotal: settings.blockedTotal,
    statsReliable: STATS_RELIABLE,
    activeRuleCount: activeRules,
    coveredBy,
    siteFix: fix?.level ?? null,
    siteFixHost: fix?.entry ?? null,
    siteActionable: !!hostname && siteRuleScope(hostname) !== null,
    siteRefusal: hostname ? siteRuleRefusal(hostname) : null,
    ...(tab?.incognito ? { incognito: true } : {}),
    degraded,
    youtubeBlockSponsored: settings.youtubeBlockSponsored !== false,
    youtubeBlockShorts: !!settings.youtubeBlockShorts,
    youtubeSponsorBlock: settings.youtubeSponsorBlock !== false,
  };
}

const YOUTUBE_HOST_RE = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|youtubekids\.com)$/;

/**
 * Compose a breakage report for the user to send.
 *
 * Everything here is the extension's own state plus the hostname the user is looking at.
 * Nothing about the page itself is read, and nothing is transmitted — the popup hands the
 * result to a mail client, where the user sees it before deciding to send.
 */
async function handleBreakageReport(hostname: string): Promise<BreakageReport> {
  const settings = await loadSettings();
  const host = normalizeHostname(String(hostname ?? ''));
  // Same gate as allowlist / DNR match patterns — refuse garbage or CRLF-bearing hosts so
  // they cannot land in a mailto subject (normal tab hosts already pass).
  if (!isValidMatchPatternHost(host)) {
    throw new Error('invalid hostname for breakage report');
  }
  const { rows, degraded } = await buildListRows(settings);
  const license = await loadLicense();
  const dark = resolveDarkModeForHost({
    paid: isLicenseEffectivelyPaid(license),
    enabled: settings.darkModeEnabled,
    overrides: settings.darkModeSiteOverrides,
    hostname: host,
  });
  const custom = customCosmeticsFor(settings.customFilters, host);
  return buildBreakageReport({
    hostname: host,
    siteFix: resolveSiteFix(host, settings.siteFixes),
    allowlisted: isSiteAllowlisted(host, settings.allowlist),
    paused: settings.paused,
    version: chrome.runtime.getManifest().version,
    listsGeneratedAt: META.generatedAt,
    activeRuleCount: rows.filter((l) => l.active).reduce((n, l) => n + l.ruleCount, 0),
    degraded,
    // What Chrome actually loaded; a list it refused is named apart, as the likely suspect is
    // the one missing.
    enabledLists: rows.filter((l) => l.active).map((l) => l.id),
    refusedLists: rows.filter((l) => l.refused).map((l) => l.id),
    customRules: custom.hide.length + custom.unhide.length + (custom.procedural?.length ?? 0),
    darkMode: isLicenseEffectivelyPaid(license) ? dark.apply : null,
    youtube: YOUTUBE_HOST_RE.test(host)
      ? {
          sponsored: settings.youtubeBlockSponsored !== false,
          shorts: !!settings.youtubeBlockShorts,
          sponsorBlock: settings.youtubeSponsorBlock !== false,
        }
      : null,
    browser: browserLabel(typeof navigator === 'undefined' ? null : navigator.userAgent),
    now: Date.now(),
  });
}

async function handleYoutubeGetOptions(hostname: string): Promise<YoutubeOptionsData> {
  const settings = await loadSettings();
  // The repair ladder reaches YouTube's own features too (B32): its hide CSS is element hiding,
  // and the sponsored scrub, the Shorts redirect and SponsorBlock's skips are script patches.
  const fix = resolveSiteFix(hostname, settings.siteFixes);
  return {
    paused: settings.paused,
    allowlisted: isSiteAllowlisted(hostname, settings.allowlist),
    cosmeticsOff: fixDisablesCosmetics(fix),
    scriptletsOff: fixDisablesScriptlets(fix),
    youtubeBlockSponsored: settings.youtubeBlockSponsored !== false,
    youtubeBlockShorts: !!settings.youtubeBlockShorts,
    youtubeSponsorBlock: settings.youtubeSponsorBlock !== false,
    sponsorBlockCategories: enabledSponsorCategories(settings.sponsorBlockCategories),
  };
}

async function handleSetYoutubeOptions(
  youtubeBlockSponsored: boolean,
  youtubeBlockShorts: boolean,
  youtubeSponsorBlock: boolean,
): Promise<PopupData> {
  await mutateSettings((s) => {
    s.youtubeBlockSponsored = youtubeBlockSponsored;
    s.youtubeBlockShorts = youtubeBlockShorts;
    s.youtubeSponsorBlock = youtubeSponsorBlock;
  });
  // Sync must ride settingsChain — overlapping applyAll/sync* with a stale snapshot
  // can undo a newer allowlist/pause/list change (last writer wins on DNR/scripts).
  await withSettings((s) => syncRegisteredScripts(s));
  void refreshYoutubeInOpenTabs();
  return handlePopupGet();
}

async function handleSponsorBlockGetSegments(videoId: string): Promise<SponsorBlockSegmentsData> {
  const settings = await loadSettings();
  // Only ask for what the user wants skipped: a narrower request downloads less and discloses
  // less. All categories off short-circuits inside lookupSponsorSegments — no request at all.
  const categories = enabledSponsorCategories(settings.sponsorBlockCategories);
  const result = await lookupSponsorSegments(videoId, categories);
  // No answer is not "no segments": the page retries it (REVIEW_2026-09-24 B61).
  return result.ok ? { videoId, segments: result.segments } : { videoId, segments: [], failed: true };
}

async function handleSponsorCategoriesGet(): Promise<SponsorCategoriesData> {
  const settings = await loadSettings();
  const prefs = settings.sponsorBlockCategories ?? {};
  const categories = SPONSORBLOCK_SKIP_CATEGORIES.map((id) => ({
    id,
    label: SPONSORBLOCK_CATEGORY_INFO[id].label,
    hint: SPONSORBLOCK_CATEGORY_INFO[id].hint,
    // Same rule as the fetch path: explicit choice wins, absent falls back to the
    // category's default. These two must agree or the toggles lie about what is skipped.
    enabled: prefs[id] ?? SPONSORBLOCK_DEFAULT_ON[id],
  }));
  return { categories, allOff: categories.every((c) => !c.enabled) };
}

async function handleSponsorCategorySet(
  category: string,
  enabled: boolean,
): Promise<SponsorCategoriesData> {
  if ((SPONSORBLOCK_SKIP_CATEGORIES as readonly string[]).includes(category)) {
    await mutateSettings((s) => {
      if (!s.sponsorBlockCategories) s.sponsorBlockCategories = {};
      s.sponsorBlockCategories[category] = enabled;
    });
  }
  return handleSponsorCategoriesGet();
}

/** The allowlist after switching blocking on (`enabled`) or off for `host`. */
function toggledAllowlist(allowlist: string[], host: string, enabled: boolean): string[] {
  const set = new Set(allowlist.map(siteRuleKey).filter(Boolean));
  if (enabled) {
    // Deleting the exact host is not enough: a parent entry (example.com) also allowlists
    // sub.example.com, so the toggle would spring straight back with no explanation. Drop
    // every entry that covers this host.
    for (const h of [...set]) {
      if (siteRuleCovers(h, host)) set.delete(h);
    }
  } else {
    const key = siteRuleKey(host);
    if (key) set.add(key);
  }
  return [...set];
}

/** `fixes` without the entries that apply to `host`, parents included. */
function withoutCoveringFixes(
  fixes: Record<string, SiteFixLevel> | undefined,
  host: string,
): Record<string, SiteFixLevel> {
  const out = { ...(fixes ?? {}) };
  for (const entry of Object.keys(out)) {
    if (siteRuleCovers(entry, host)) delete out[entry];
  }
  return out;
}

async function handleToggleSite(hostname: string, enabled: boolean): Promise<SiteToggleData> {
  const host = normalizeHostname(String(hostname ?? ''));
  // A host no site rule can hold (an IPv6 literal, a Web Store page) used to store nothing and
  // answer as if it had worked, and the popup then asked for a reload that changed nothing.
  if (!enabled && !siteRuleScope(host)) return { ...(await handlePopupGet()), applied: false };
  // Chrome first, storage second, in one settings-chain step. Stored first, a refused
  // updateDynamicRules left the popup saying blocking was off for the site while every request
  // was still blocked, and each wake retried the refused change. Now a refusal stores nothing
  // and the answer says the switch did not take effect.
  const applied = await withSettings(async (s) => {
    const next = toggledAllowlist(s.allowlist, host, enabled);
    try {
      await syncAllowlist({ ...s, allowlist: next });
    } catch (e) {
      console.error('[StampStack] allowlist DNR sync failed; the site switch did not apply', e);
      return false;
    }
    s.allowlist = next;
    // Blocking back on means all of it (B30). The ladder's rungs come before the allowlist, so a
    // site switched off from the last rung still carries its repair step, which would otherwise
    // quietly keep element hiding and script patches off under a green "Blocking on this site".
    if (enabled) s.siteFixes = withoutCoveringFixes(s.siteFixes, host);
    await saveSettings(s);
    return true;
  });
  if (applied) {
    // Element hiding and script patches follow the stored allowlist. syncRegisteredScripts
    // keeps a working registration when Chrome refuses one; the catch attributes anything else.
    try {
      await withSettings((s) => syncRegisteredScripts(s));
    } catch (e) {
      console.error('[StampStack] cosmetic registration sync failed', e);
    }
    void refreshYoutubeInOpenTabs();
  }
  return { ...(await handlePopupGet()), applied };
}

/**
 * Per-page report. Asks the content script what the page reached for, then names the hosts.
 *
 * The naming index is compiled (`trackers.json`, ~9 KB): 171 domains for organizations a user
 * recognizes, each with the lists whose rules block it. Whether one is blocked is decided here,
 * from the lists Chrome has actually loaded (B39): a guess made at compile time called OneTrust
 * blocked with the cookie list off. Hosts outside the index are counted but not named — better
 * than mislabeling an asset CDN as a tracker.
 */
async function handleReportGet(): Promise<PageReport> {
  const settings = await loadSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? null;
  const hostname = url && isHttpOrHttpsUrl(url) ? new URL(url).hostname : null;

  const empty = (reason: PageReport['reason']): PageReport => ({
    available: false,
    reason,
    hostname,
    trackers: [],
    unnamedThirdParty: 0,
    hiddenElements: 0,
    truncated: false,
  });

  if (!hostname || tab?.id == null) return empty('restricted');
  if (settings.paused) return empty('paused');
  if (isSiteAllowlisted(hostname, settings.allowlist)) return empty('allowlisted');

  let page: { hosts?: unknown; hiddenCount?: unknown; truncated?: unknown } | undefined;
  try {
    // Top document only. all_frames content scripts each reply; without frameId the
    // first response wins and can be an iframe's hosts labeled as the tab hostname. Bounded: a
    // page with an alert() open answers nothing until it closes, and the popup would wait (B33).
    page = await settleWithin(
      chrome.tabs.sendMessage(tab.id, { type: 'page:collect' }, { frameId: 0 }),
      2 * TAB_MESSAGE_TIMEOUT_MS,
      undefined,
    );
  } catch {
    // No content script in this tab: a restricted page, or the tab predates the install.
    return empty('no-content-script');
  }
  if (!page || !Array.isArray(page.hosts)) return empty('no-content-script');

  const { rows } = await buildListRows(settings);
  const loaded = new Set(rows.filter((r) => r.active).map((r) => r.id));
  const { trackers, unnamedThirdParty } = classifyHosts(page.hosts, TRACKERS, loaded);

  return {
    available: true,
    hostname,
    trackers,
    unnamedThirdParty,
    hiddenElements: typeof page.hiddenCount === 'number' ? page.hiddenCount : 0,
    truncated: page.truncated === true,
  };
}

/**
 * Inject the picker into the active tab. Not part of the always-on content script.
 *
 * Refused where element hiding is off (paused, the site switched off, a repair step), since the
 * pick would save and then never apply, and on hosts a custom filter cannot name (the parser
 * needs a dotted host). The keyboard shortcut reaches this without the popup's own checks.
 * `reason` uses the popup's vocabulary (site-state.ts PickBlock).
 */
async function handlePickerStart(): Promise<{
  ok: boolean;
  error?: string;
  reason?: 'page' | 'host' | 'paused' | 'allowlisted' | 'fix';
}> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const host = hostOf(tab?.url);
  if (tab?.id == null || !tab.url || !isHttpOrHttpsUrl(tab.url) || isExtensionRestrictedHostname(host)) {
    return { ok: false, reason: 'page', error: 'The picker only works on ordinary web pages.' };
  }
  const settings = await loadSettings();
  // The picker saves `host##selector`; a host the filter parser will not take cannot be named.
  if (!host || parseCustomFilters(`${host.replace(/^www\./, '')}##.x`).errors.length) {
    return { ok: false, reason: 'host', error: 'A hiding rule cannot name this site.' };
  }
  if (settings.paused) {
    return { ok: false, reason: 'paused', error: 'StampStack is paused.' };
  }
  if (isSiteAllowlisted(host, settings.allowlist)) {
    return { ok: false, reason: 'allowlisted', error: 'Blocking is off on this site.' };
  }
  if (fixDisablesCosmetics(resolveSiteFix(host, settings.siteFixes))) {
    return { ok: false, reason: 'fix', error: 'Element hiding is off on this site.' };
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['picker.js'],
    });
    return { ok: true };
  } catch (e) {
    console.error('[StampStack] picker injection failed', e);
    return { ok: false, reason: 'page', error: 'Chrome would not let the picker run on this page.' };
  }
}

/**
 * Append one filter line from the picker.
 *
 * The line is re-parsed before it is stored: it arrives from a content script, and a content
 * script is only as trustworthy as the page it runs in. A malformed or unsafe selector is
 * rejected rather than persisted where it would break every later parse. From a content script
 * only what the picker makes is accepted: a hide for the sender's own site. A compromised
 * renderer could otherwise hide content on every other site, or unhide a list's rules.
 */
async function handleCustomFilterAdd(
  line: string,
  sender: chrome.runtime.MessageSender,
  trusted: boolean,
): Promise<{ ok: boolean; error?: string }> {
  if (typeof line !== 'string' || !line.trim()) return { ok: false, error: 'Empty filter.' };
  const { filters, errors } = parseCustomFilters(line);
  if (errors.length || filters.length !== 1) {
    return { ok: false, error: errors[0]?.reason ?? 'Could not parse that filter.' };
  }
  if (!trusted) {
    const f = filters[0];
    const pageHost = normalizeHostname(hostOf(sender.url));
    const ownSite = (d: string): boolean =>
      filterAppliesTo({ ...f, domains: [d] }, pageHost) &&
      (siteRuleScope(d) === 'domain' || normalizeHostname(d) === pageHost);
    if (f.kind !== 'hide' || !f.domains.length || !f.domains.every(ownSite)) {
      console.warn('[StampStack] refused a picker rule for another site', sender.url ?? '');
      return { ok: false, error: 'A picked rule can only hide something on the page it was picked on.' };
    }
  }
  let full = false;
  await mutateSettings((s) => {
    const next = appendFilterLine(s.customFilters ?? '', line.trim());
    // Past the cap the rule would be cut off on the next load and vanish while the pick said ok.
    if (next.length > CUSTOM_FILTERS_MAX_CHARS) full = true;
    else s.customFilters = next;
  });
  if (full) {
    return {
      ok: false,
      error: 'Your filter list is full. Remove some rules in Options, then pick again.',
    };
  }
  // Re-push cosmetics to the tab that picked, so the element stays hidden after a reload
  // without waiting for the next navigation. Bounded like every other tab message (B33).
  if (sender.tab?.id != null) {
    await settleWithin(
      chrome.tabs.sendMessage(sender.tab.id, { type: 'cosmetic:refresh' } satisfies Message),
      TAB_MESSAGE_TIMEOUT_MS,
      undefined,
    );
  }
  return { ok: true };
}

async function handleCustomFiltersGet(): Promise<CustomFiltersData> {
  const settings = await loadSettings();
  const text = settings.customFilters ?? '';
  const { filters, errors } = parseCustomFilters(text);
  return { text, count: filters.length, errors };
}

async function handleCustomFiltersSet(text: string): Promise<CustomFiltersData> {
  if (typeof text !== 'string') return handleCustomFiltersGet();
  const capped = capFilterText(text);
  await mutateSettings((s) => {
    s.customFilters = capped.text;
  });
  void refreshCosmeticsInOpenTabs();
  const data = await handleCustomFiltersGet();
  return capped.truncated ? { ...data, truncated: true } : data;
}

async function handleSiteFixSet(
  hostname: string,
  level: SiteFixLevel | null,
): Promise<PopupData> {
  const host = siteRuleKey(String(hostname ?? ''));
  if (!host || (level !== null && level !== 'cosmetics' && level !== 'injection')) {
    return handlePopupGet();
  }
  await mutateSettings((s) => {
    if (!s.siteFixes) s.siteFixes = {};
    for (const entry of Object.keys(s.siteFixes)) {
      // A step down the ladder applies to this host and the hosts under it (B29). A parent's
      // fix (example.com, on forum.example.com) also serves its other hosts, so it stays; the
      // most permissive entry covering a host still decides (resolveSiteFix).
      // Back to full blocking (null) removes every entry that covers this page, a parent's
      // included, since otherwise the page could not return to full blocking at all. The popup
      // names the parent first (PopupData.siteFixHost).
      const drop = level ? siteRuleCovers(host, entry) : siteRuleCovers(entry, host);
      if (drop) delete s.siteFixes[entry];
    }
    if (level) s.siteFixes[host] = level;
  });
  // Cosmetic/scriptlet excludes are part of the registered scripts, so they must be resynced;
  // network rules are untouched by a fix, which is the entire point of the ladder.
  await withSettings((s) => syncRegisteredScripts(s));
  void refreshYoutubeInOpenTabs();
  return handlePopupGet();
}

/** Does stored `entry` name the row `key` Options shows (the raw key, or its normal form)? */
function sameSiteKey(entry: string, key: string): boolean {
  return entry === key || normalizeHostname(entry) === normalizeHostname(key);
}

/** Options "Remove" on a repair row: that entry and nothing else, never a parent (B29). */
async function handleSiteFixRemove(hostname: string): Promise<SiteRulesData> {
  const key = String(hostname ?? '');
  if (key) {
    await mutateSettings((s) => {
      for (const entry of Object.keys(s.siteFixes ?? {})) {
        if (sameSiteKey(entry, key)) delete s.siteFixes[entry];
      }
    });
    await withSettings((s) => syncRegisteredScripts(s));
    void refreshYoutubeInOpenTabs();
  }
  return handleSiteFixList();
}

/**
 * Options "Remove" on an allowlist row: that entry and nothing else. popup:toggleSite with
 * `enabled` removes every entry covering the host, which from a subdomain row deleted the
 * parent (B29). Chrome first, as handleToggleSite.
 */
async function handleAllowlistRemove(hostname: string): Promise<SiteRulesData & { applied: boolean }> {
  const key = String(hostname ?? '');
  const applied = await withSettings(async (s) => {
    const next = s.allowlist.filter((e) => !sameSiteKey(e, key));
    if (next.length === s.allowlist.length) return true;
    try {
      await syncAllowlist({ ...s, allowlist: next });
    } catch (e) {
      console.error('[StampStack] allowlist DNR sync failed; the entry was not removed', e);
      return false;
    }
    s.allowlist = next;
    await saveSettings(s);
    return true;
  });
  if (applied) {
    await withSettings((s) => syncRegisteredScripts(s)).catch((e) =>
      console.error('[StampStack] cosmetic registration sync failed', e),
    );
    void refreshYoutubeInOpenTabs();
  }
  return { ...(await handleSiteFixList()), applied };
}

async function handleSiteFixList(): Promise<SiteRulesData> {
  const settings = await loadSettings();
  return {
    allowlist: [...settings.allowlist].sort(),
    siteFixes: { ...(settings.siteFixes ?? {}) },
  };
}

/** Settings as a portable JSON document (no license state — that is tied to the purchase). */
async function handleSettingsExport(): Promise<{ json: string }> {
  const s = await loadSettings();
  return { json: JSON.stringify(buildSettingsExportDocument(s), null, 2) };
}

async function handleSettingsImport(json: string): Promise<SettingsImportResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(json));
  } catch {
    return { ok: false, code: 'not_json', error: 'That file is not valid JSON.' };
  }
  const doc = parsed as { format?: unknown; settings?: unknown };
  if (doc?.format !== 'stampstack-settings' || !doc.settings || typeof doc.settings !== 'object') {
    return { ok: false, code: 'not_export', error: 'That is not a StampStack settings export.' };
  }
  // Field by field (settings-import.ts): a field of the wrong type keeps this install's value
  // instead of resetting it to the default, and site keys are normalized so every imported row
  // matches what the popup shows and can be removed. applyImportedSettings then keeps fields
  // the file never contained (older backups omit customFilters / sponsorBlockCategories).
  const { settings: clean, ignored, truncated } = sanitizeImportedSettings(doc.settings);
  await mutateSettings((s) => {
    Object.assign(s, applyImportedSettings(s, clean));
  });
  await withSettings((s) => applyAll(s));
  // Open pages follow without a reload: the user's filters and site rules, dark mode, YouTube.
  void refreshCosmeticsInOpenTabs();
  void refreshDarkModeInOpenTabs();
  void refreshYoutubeInOpenTabs();
  return {
    ok: true,
    ...(ignored.length ? { ignored } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

async function handleSetPaused(paused: boolean): Promise<PopupData> {
  if (typeof paused !== 'boolean') return handlePopupGet();
  await mutateSettings((s) => {
    s.paused = paused;
  });
  await withSettings((s) => applyAll(s));
  void refreshYoutubeInOpenTabs();
  return handlePopupGet();
}

/**
 * Rows describing both what the user asked for and what Chrome actually loaded.
 *
 * Cosmetics for a dropped list are deliberately left running: they cost nothing from the DNR
 * pool, so element hiding without network blocking is strictly better than nothing. What was
 * wrong was not the degradation, it was reporting it as full protection.
 */
async function buildListRows(settings: Settings): Promise<{ rows: ListRow[]; degraded: boolean }> {
  let live: string[] | null = null;
  try {
    live = await chrome.declarativeNetRequest.getEnabledRulesets();
  } catch {
    live = null; // Cannot tell — assume what the user asked for rather than crying wolf.
  }
  const rows = META.lists.map((l) => {
    const enabled = isListEnabled(settings, l.id, l.enabledByDefault);
    const wanted = enabled && !settings.paused;
    const active = live == null ? wanted : wanted && live.includes(l.id);
    // While paused nothing is loaded by design, so nothing is refused (B36): Options showed
    // every enabled list as "Not active — Chrome's shared rule limit is full".
    return { ...l, enabled, active, refused: wanted && !active };
  });
  return { rows, degraded: rows.some((r) => r.refused) };
}

/**
 * Queued behind settingsChain (B37): Options re-reads the lists on the storage change a toggle
 * makes, which lands before that toggle's syncRulesets has run, and read then, a list just
 * switched on showed as refused by Chrome until the page was reopened.
 */
async function handleListsGet(): Promise<ListsData> {
  return withSettings(async (settings) => {
    const { rows, degraded } = await buildListRows(settings);
    return { lists: rows, degraded, paused: settings.paused };
  });
}

async function handleListSetEnabled(id: string, enabled: boolean): Promise<ListsData> {
  if (!META.lists.some((l) => l.id === id) || typeof enabled !== 'boolean') return handleListsGet();
  await mutateSettings((s) => {
    s.enabledLists[id] = enabled;
  });
  // Network + cosmetics + scriptlets all honor list enablement.
  // Settled independently for the same reason as the site toggle: a cosmetic registration
  // failure must not make a successful ruleset change report as no change at all.
  const settled = await withSettings((s) =>
    Promise.allSettled([syncRulesets(s), syncRegisteredScripts(s)]),
  );
  settled.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[StampStack] ${i === 0 ? 'ruleset' : 'cosmetic'} sync failed`, r.reason);
    }
  });
  // Read after the sync, so the answer says what Chrome did with the change.
  return handleListsGet();
}

async function handleStatsGet(): Promise<StatsData> {
  const settings = await loadSettings();
  const { rows, degraded } = await buildListRows(settings);
  return {
    blockedTotal: settings.blockedTotal,
    paused: settings.paused,
    lists: rows,
    regexRulesUsed: META.regexRulesUsed,
    statsReliable: STATS_RELIABLE,
    degraded,
    listsGeneratedAt: META.generatedAt,
  };
}

async function buildDarkModeData(
  settings: Settings,
  license: LicenseState,
  hostname: string | null | undefined,
): Promise<DarkModeData> {
  const licenseData = toLicenseData(license);
  const host = hostname ? normalizeHostname(hostname) : null;
  const restricted = !!(host && isExtensionRestrictedHostname(host));
  const resolved = resolveDarkModeForHost({
    paid: licenseData.paid,
    enabled: settings.darkModeEnabled,
    overrides: settings.darkModeSiteOverrides,
    hostname: host,
  });
  return {
    paid: licenseData.paid,
    enabled: settings.darkModeEnabled,
    apply: restricted ? false : resolved.apply,
    hostname: host,
    override: resolved.override,
    restricted,
    siteOverrides: { ...settings.darkModeSiteOverrides },
    license: licenseData,
  };
}

async function handleDarkModeGet(hostname?: string | null): Promise<DarkModeData> {
  const settings = await loadSettings();
  let host = hostname ?? null;
  if (host === undefined || host === null) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && isHttpOrHttpsUrl(tab.url)) {
      try {
        host = new URL(tab.url).hostname;
      } catch {
        host = null;
      }
    }
  }
  const license = await loadLicense();
  return buildDarkModeData(settings, license, host);
}

/**
 * darkmode:get from a content script. Every frame follows the top page's setting — a Stripe
 * iframe on example.com follows example.com's toggle, not stripe.com's — so the host is the
 * tab's, or for a prerendered page (whose tab still shows the page before it, B27) the top host
 * the frame reports. The answer is the decision only: every frame of every site asks, and the
 * purchase email and the list of overridden sites are none of a page's business.
 */
async function handleDarkModeGetForPage(
  msg: Extract<Message, { type: 'darkmode:get' }>,
  sender: chrome.runtime.MessageSender,
): Promise<DarkModePageData> {
  const frameHost = String(msg.hostname ?? hostOf(sender.url));
  const host = policyHost(frameHost, sender, msg.topHost);
  const [settings, license] = await Promise.all([loadSettings(), loadLicense()]);
  const data = await buildDarkModeData(settings, license, host || null);
  return { paid: data.paid, apply: data.apply };
}

async function handleDarkModeSetEnabled(enabled: boolean): Promise<DarkModeData> {
  const license = await loadLicense();
  if (!isLicenseEffectivelyPaid(license) || typeof enabled !== 'boolean') {
    const settings = await loadSettings();
    return buildDarkModeData(settings, license, null);
  }
  await mutateSettings((s) => {
    s.darkModeEnabled = enabled;
  });
  await syncDarkModeNow(license);
  return handleDarkModeGet();
}

async function handleDarkModeSetSiteOverride(
  hostname: string,
  override: DarkModeSiteOverride | null,
): Promise<DarkModeData> {
  // The host a tab reports, from a host or a pasted URL: a URL or a stray word stored as a key
  // matched no page and could not be cleared.
  const host = siteRuleKeyFromInput(String(hostname ?? ''));
  const license = await loadLicense();
  const valid = override === null || override === 'on' || override === 'off';
  if (!isLicenseEffectivelyPaid(license) || !host || !valid) {
    const settings = await loadSettings();
    return buildDarkModeData(settings, license, host || null);
  }
  await mutateSettings((s) => {
    if (!s.darkModeAutoOff) s.darkModeAutoOff = {};
    if (override == null) {
      delete s.darkModeSiteOverrides[host];
      delete s.darkModeAutoOff[host];
    } else {
      s.darkModeSiteOverrides[host] = override;
      // User choice replaces any auto-off marker.
      delete s.darkModeAutoOff[host];
    }
  });
  await syncDarkModeNow(license);
  return handleDarkModeGet(host);
}

async function handleLicenseGet(): Promise<LicenseData> {
  const license = await loadLicense();
  return toLicenseData(license);
}

/** "Refresh license": a new answer (joining one in flight), and a word when there was none. */
async function handleLicenseRefresh(): Promise<LicenseData> {
  const { license, reached } = await refreshLicenseSharedDetailed(0);
  await syncDarkModeNow(license);
  return { ...toLicenseData(license), ...(reached ? {} : { unreachable: true }) };
}

async function handleLicenseDevUnlock(): Promise<{ ok: boolean; error?: string; darkMode?: DarkModeData }> {
  const result = await devUnlock();
  if (!result.ok || !result.license) return { ok: false, error: result.error };
  await markDarkModeUnlockedOnce();
  await mutateSettings((s) => {
    s.darkModeEnabled = true;
  });
  await syncDarkModeNow(result.license);
  return { ok: true, darkMode: await handleDarkModeGet() };
}
