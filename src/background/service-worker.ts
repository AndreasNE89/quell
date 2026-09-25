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
  ListsData,
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
import { fetchSponsorSegments } from './sponsorblock-api.js';
import {
  SPONSORBLOCK_SKIP_CATEGORIES,
  SPONSORBLOCK_CATEGORY_INFO,
  enabledSponsorCategories,
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
  refreshLicense,
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
} from '../shared/custom-filters.js';
import {
  resolveSiteFix,
  fixDisablesCosmetics,
  fixDisablesScriptlets,
  hostsWithCosmeticsOff,
  hostsWithScriptletsOff,
} from '../shared/site-fix.js';
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
  isDarkModeInjectibleUrl,
  isHttpOrHttpsUrl,
} from '../shared/dark-mode.js';
import {
  matchCosmetic,
  mergeNetworkExceptions,
  mergePathExceptions,
} from '../engine/cosmetic-match.js';
import {
  SCRIPTLET_SHARD_ID_PREFIX,
  SCRIPTLET_RUNTIME_FILE,
  shardRegistrations,
  planShardInjection,
  type ShardIndex,
} from '../engine/scriptlet-shards.js';
import {
  normalizeHostname,
  isAllowlistedHost,
  isSafeAllowlistHost,
  isValidMatchPatternHost,
  allowlistMatchPatterns,
  exactHostMatchPatterns,
  pathExceptionMatchPatterns,
} from '../shared/hostname.js';

import cosmeticJson from '../generated/cosmetic.json';
import scriptletShardJson from '../generated/scriptlet-shards.json';
import metaJson from '../generated/meta.json';
import trackerJson from '../generated/trackers.json';

const COSMETIC = cosmeticJson as unknown as CosmeticData;
// Only the host index: the rules themselves ship as MAIN-world files (scriptlet-shards.ts).
const SHARDS = scriptletShardJson as ShardIndex;
const META = metaJson as GeneratedMeta;
const TRACKERS = trackerJson as TrackerIndex;

const STATS_RELIABLE = !!chrome.declarativeNetRequest.onRuleMatchedDebug;

// Per-tab blocked counters (rebuilt on SW wake; best-effort for the badge).
const tabBlocked = new Map<number, number>();

function enabledListIds(settings: Settings): string[] {
  return META.lists
    .filter((l) => !settings.paused && isListEnabled(settings, l.id, l.enabledByDefault))
    .map((l) => l.id);
}

// ---------------------------------------------------------------------------
// Rule / script synchronization
// ---------------------------------------------------------------------------

async function syncRulesets(settings: Settings): Promise<void> {
  const enable: string[] = [];
  const disable: string[] = [];
  for (const list of META.lists) {
    const on = !settings.paused && isListEnabled(settings, list.id, list.enabledByDefault);
    (on ? enable : disable).push(list.id);
  }

  // The service worker is ephemeral, so this runs on every wake — many times a day. Enabling
  // a ruleset that is already enabled is not free: Chrome re-indexes, and with ~120k rules
  // that is the most expensive thing the worker does. Skip the call entirely when the live
  // state already matches.
  try {
    const live = await chrome.declarativeNetRequest.getEnabledRulesets();
    const want = [...enable].sort().join(',');
    if (live.slice().sort().join(',') === want) return;
  } catch {
    /* fall through and do the work */
  }

  // Disable unwanted rulesets first — always succeeds and frees global-pool budget.
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
  // Degrade gracefully: drop the largest ruleset and retry (the built-in seed is never
  // dropped), so a tight pool costs coverage rather than all protection. Self-heals — every
  // sync retries the full set, so dropped lists re-enable once the pool frees up.
  const ruleCount = (id: string): number => META.lists.find((l) => l.id === id)?.ruleCount ?? 0;
  let toEnable = [...enable];
  while (toEnable.length) {
    try {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: toEnable });
      return;
    } catch (e) {
      const droppable = toEnable.filter((id) => id !== 'quell-seed');
      if (!droppable.length) {
        console.error('[StampStack] updateEnabledRulesets failed for the minimal set', e);
        return;
      }
      const largest = droppable.reduce((a, b) => (ruleCount(b) > ruleCount(a) ? b : a));
      console.warn(
        `[StampStack] static rule pool tight — dropping "${largest}" (${ruleCount(largest)} rules) and retrying`,
      );
      toEnable = toEnable.filter((id) => id !== largest);
    }
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

  const hosts = [
    ...new Set(
      settings.allowlist
        .map(normalizeHostname)
        .filter((h) => isSafeAllowlistHost(h)),
    ),
  ];
  // main_frame only. allowAllRequests on the top-level navigation already allows every request
  // in that tab's frame tree, iframes included. Adding sub_frame would also match an iframe
  // FROM the allowlisted host embedded on any other site, so allowlisting youtube.com would
  // unblock every YouTube embed everywhere. uBO keys its trusted-site switch on the top page.
  const addRules: chrome.declarativeNetRequest.Rule[] = hosts.map((host, i) => ({
    id: ALLOWLIST_ID_START + i,
    priority: ALLOWLIST_PRIORITY,
    action: { type: 'allowAllRequests' as chrome.declarativeNetRequest.RuleActionType },
    condition: {
      requestDomains: [host],
      resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType],
    },
  }));

  // Same reasoning as syncRulesets: this runs on every wake, and rewriting identical dynamic
  // rules is pure churn. The key covers resourceTypes too, so rules written by an older build
  // with a different shape are replaced on upgrade rather than kept forever.
  const bandKey = (r: chrome.declarativeNetRequest.Rule): string => {
    const domains = (r.condition.requestDomains ?? []).join('|');
    const types = [...(r.condition.resourceTypes ?? [])].sort().join('|');
    return `${r.id}:${domains}:${types}`;
  };
  const liveBand = existing
    .filter((r) => r.id >= ALLOWLIST_ID_START && r.id < ALLOWLIST_ID_END)
    .map(bandKey)
    .sort()
    .join(',');
  const wantBand = addRules.map(bandKey).sort().join(',');
  if (liveBand === wantBand) return;

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  } catch (e) {
    console.error('[StampStack] updateDynamicRules (allowlist) failed', e);
  }
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
 * allowlisted host goes without it on other sites.
 */
async function syncRegisteredScripts(settings: Settings): Promise<void> {
  const shouldExist = !settings.paused;
  // User entries pass the same gate as isAllowlistedHost, so a legacy or imported `github.io`
  // cannot exclude every tenant here while the network layer and popup ignore it.
  const userCosmeticsOff = [
    ...settings.allowlist,
    ...hostsWithCosmeticsOff(settings.siteFixes),
  ].filter(isSafeAllowlistHost);
  const userScriptletsOff = [
    ...settings.allowlist,
    ...hostsWithScriptletsOff(settings.siteFixes),
  ].filter(isSafeAllowlistHost);
  // Always an array, never undefined: syncOneRegisteredScript compares against the live
  // registration, and an absent property would read as "leave whatever is there".
  // The YouTube MAIN-world hooks are scriptlets, so an `injection`-level fix must exclude
  // them too or "scriptlets off" would not actually be off on YouTube.
  const allowlistExclude = [...new Set(userScriptletsOff.flatMap(allowlistMatchPatterns))];

  const ids = enabledListIds(settings);
  // Only exceptions from *enabled* lists exclude the generic sheet. A disabled cookie
  // list must not keep its @@$generichide hosts unhidden.
  const netEx = mergeNetworkExceptions(COSMETIC, ids);
  const pathEx = mergePathExceptions(COSMETIC, ids);

  // Generic cosmetic CSS is additionally excluded on hosts with a $generichide/$elemhide
  // network exception, so those hosts never receive the sheet (and need no per-page revert
  // of the whole generic set). matchCosmetic mirrors this: it only emits the revert for
  // entity-domain (example.*) exceptions, which can't be expressed as a match pattern here.
  const cosmeticMatches = [
    ...new Set([
      ...[
        // Breakage fixes must also drop the registered generic sheet — it is injected by
        // chrome.scripting, so suppressing the per-page payload in handleCosmetic is not
        // enough to stop generic hiding on that host.
        ...userCosmeticsOff,
        ...netEx.generichide,
        ...netEx.elemhide,
      ].flatMap(allowlistMatchPatterns),
      // Page-scoped exceptions keep their path: EasyList's `@@||duckduckgo.com/?q=` excludes
      // the results page (`*://*.duckduckgo.com/?q=*`), not the whole site.
      ...[...pathEx.generichide, ...pathEx.elemhide].flatMap(pathExceptionMatchPatterns),
    ]),
  ];
  const cosmeticExclude = cosmeticMatches;
  const cssFiles = ids
    .map((id) => META.lists.find((l) => l.id === id)?.genericCssFile)
    .filter((p): p is string => !!p)
    .map((p) => `generated/${p}`);

  const cosmetic: chrome.scripting.RegisteredContentScript = {
    id: GENERIC_CSS_SCRIPT_ID,
    css: cssFiles,
    matches: ['<all_urls>'],
    excludeMatches: cosmeticExclude,
    runAt: 'document_start',
    allFrames: true,
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
    [cosmetic.id, syncOneRegisteredScript(cosmetic, shouldExist && cssFiles.length > 0)],
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
 * files and the runtime. Before this they were fetched by message and injected with
 * executeScript, which landed after the page's inline <head> scripts, too late for most
 * anti-adblock defusers. `ids` is empty while paused, which unregisters them all.
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
      // creator's origin, so they match and get their host's rules.
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

/**
 * Live-update open tabs after a toggle, instantly and without a reload. The content script
 * re-evaluates and applies the correct visual itself: the matte smart invert on a light page,
 * or a no-op reset on an already-dark page.
 *
 * We deliberately do NOT insertCSS the invert here. Doing so applied it to every tab whose
 * host resolves to "on" — including already-dark pages, which would flash to light for a frame
 * before the content script cancelled it. Letting the content script decide keeps the toggle
 * both instant and flash-free.
 */
async function applyDarkModeToOpenTabs(
  _settings: Settings,
  _license: LicenseState,
): Promise<void> {
  // No paid gate here: on a paid→unpaid transition we still need to reach open tabs so the
  // content script can cancel any lingering invert (it resets itself when darkmode:get reports
  // unpaid). The content script is the authority on what to apply.
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id == null || !isDarkModeInjectibleUrl(tab.url)) return;
      try {
        // Clean up any invert sheet an older build inserted via insertCSS (harmless if none).
        await chrome.scripting
          .removeCSS({ target: { tabId: tab.id, allFrames: true }, files: [DARK_MODE_CSS_PATH] })
          .catch(() => {});
        await chrome.tabs.sendMessage(tab.id, { type: 'darkmode:refresh' } satisfies Message);
      } catch {
        /* Discarded tab or content script not ready — next navigation picks up registration. */
      }
    }),
  );
}

async function syncDarkModeAndActiveTab(
  settings: Settings,
  license: LicenseState,
): Promise<void> {
  await syncDarkModeScripts(settings, license);
  await applyDarkModeToOpenTabs(settings, license);
}

async function applyAll(
  settings: Settings,
  license?: LicenseState,
  opts: { touchTabs?: boolean } = {},
): Promise<void> {
  const lic = license ?? (await loadLicense());
  await Promise.all([
    syncRulesets(settings),
    syncAllowlist(settings),
    syncRegisteredScripts(settings),
    syncDarkModeScripts(settings, lic),
  ]);
  // init()/applyAll unregisters dark CSS on paid→unpaid (grace expiry, ExtPay cancel),
  // but already-open tabs keep the dynamic engine until told to stop. license:refresh
  // already uses syncDarkModeAndActiveTab; cold-start must too or unpaid dark mode sticks.
  // Callers that know nothing user-visible changed opt out — see init('wake').
  if (opts.touchTabs !== false) await applyDarkModeToOpenTabs(settings, lic);
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

async function init(mode: 'full' | 'wake' = 'full'): Promise<void> {
  // Must run before license.unpacked / Dev unlock decisions. Module-scope state, so it is lost
  // on every wake and has to be re-probed regardless of mode.
  await probeInstallEnvironment();

  const cached = await loadLicense();
  const wasPaid = isLicenseEffectivelyPaid(cached);

  let license =
    mode === 'full' || !licenseIsFresh(cached) ? await refreshLicense() : cached;
  license = await ensureUnpackedTestLicense();

  // One-shot migration, and already flag-guarded; onInstalled covers the upgrade case, so it
  // does not need to touch storage on every wake.
  if (mode === 'full') await clearBuggyAutoOffOverrides();

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

  // Messaging every open tab is only needed when the paid state actually moved (grace expiry,
  // an ExtPay cancel), or on a genuine start. On an ordinary wake it is a broadcast to every
  // tab to tell them nothing changed.
  const paidChanged = isLicenseEffectivelyPaid(license) !== wasPaid;
  const touchTabs = mode === 'full' || paidChanged;

  await withSettings(async (settings) => {
    await applyAll(settings, license, { touchTabs });
    // Neutral grey, not brand green: a green badge melts into the green icon. White text 6:1.
    await chrome.action.setBadgeBackgroundColor({ color: '#5f6368' });
  });
}

const AUTO_OFF_RESET_KEY = 'stampstack.darkAutoOffReset.v1';
const DARK_AUTO_ENABLE_KEY = 'stampstack.darkAutoEnable.v1';

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

/** After purchase / restore: cache is paid — auto-enable dark mode once. */
async function onLicenseUnlocked(_license: LicenseState): Promise<void> {
  const settings = await mutateSettings((s) => {
    s.darkModeEnabled = true;
  });
  await syncDarkModeAndActiveTab(settings, _license);
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
  void init('full');
});
chrome.runtime.onStartup.addListener(() => void init('full'));
// Module scope: this is the every-wake path, not a start. Keep it cheap.
void init('wake');

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

chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((r) => sendResponse(r))
    .catch((e) => {
      console.error('[StampStack] message handler error', msg.type, e);
      sendResponse(null);
    });
  return true;
});

async function handleMessage(msg: Message, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {
    case 'cosmetic:get':
      return handleCosmetic(msg.hostname, sender);

    case 'scriptlets:get':
      return handleScriptlets(msg, sender);

    case 'popup:get':
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
      return handleCustomFilterAdd(msg.line, sender);

    case 'customfilters:get':
      return handleCustomFiltersGet();

    case 'customfilters:set':
      return handleCustomFiltersSet(msg.text);

    case 'page:collect':
      // SW → content script only; a tab must never answer this to itself.
      return null;

    case 'sitefix:set':
      return handleSiteFixSet(msg.hostname, msg.level);

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
      return handleYoutubeGetOptions(policyHost(msg.hostname, sender));

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
      // Content-script callers (incl. subframes) resolve against the TOP document's host so
      // every frame in a tab follows the top site's setting — a Stripe iframe on example.com
      // follows example.com's toggle, not stripe.com's. Popup/options callers have no sender
      // tab and use the hostname they pass (or the active tab).
      if (sender.tab?.url && isHttpOrHttpsUrl(sender.tab.url)) {
        try {
          return handleDarkModeGet(new URL(sender.tab.url).hostname);
        } catch {
          /* fall through to msg.hostname */
        }
      }
      return handleDarkModeGet(msg.hostname);

    case 'darkmode:setEnabled':
      return handleDarkModeSetEnabled(msg.enabled);

    case 'darkmode:setSiteOverride':
      return handleDarkModeSetSiteOverride(msg.hostname, msg.override);

    case 'cosmetic:refresh':
      // SW → content only.
      return null;

    case 'darkmode:refresh':
      // SW → content only; tabs should not message the SW with this type.
      return null;

    case 'license:get':
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
  hostname: string,
  sender: chrome.runtime.MessageSender,
): Promise<CosmeticResponse> {
  const settings = await loadSettings();
  const site = policyHost(hostname, sender);
  // A breakage fix suppresses element hiding while leaving network blocking in place. The
  // registered generic stylesheet is excluded separately in syncRegisteredScripts — returning
  // nothing here only covers the per-page specific/procedural payload.
  if (
    settings.paused ||
    isAllowlistedHost(site, settings.allowlist) ||
    fixDisablesCosmetics(resolveSiteFix(site, settings.siteFixes))
  ) {
    return {
      allowlisted: true,
      hide: [],
      unhide: [],
      procedural: [],
      disableGeneric: true,
      disableSpecific: true,
    };
  }
  // The frame's own URL: page-scoped exceptions (EasyList's search-results generichide) need it.
  const m = matchCosmetic(hostname, COSMETIC, enabledListIds(settings), sender.url);
  // The user's own rules ride along with the list-derived ones. Their exceptions are applied
  // inside customCosmeticsFor, and their unhides also cancel list hides below — a user must be
  // able to override a filter list, not just their own picks.
  const custom = customCosmeticsFor(settings.customFilters, hostname);
  const hide = [...new Set([...m.hide, ...custom.hide])].filter(
    (s) => !custom.unhide.includes(s),
  );
  return {
    allowlisted: false,
    hide,
    unhide: [...new Set([...m.unhide, ...custom.unhide])],
    procedural: m.procedural,
    disableGeneric: m.disableGeneric,
    disableSpecific: m.disableSpecific,
  };
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
    isAllowlistedHost(site, settings.allowlist) ||
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
    groups = groups.map((g) => ({
      id: g.id,
      files: g.files.filter((f) => !(live.get(g.id) ?? []).includes(f)),
    }));
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
  const allowlisted = !!hostname && isAllowlistedHost(hostname, settings.allowlist);
  // Count what Chrome actually loaded. Reporting the requested total would overstate
  // protection on a profile whose static-rule pool is exhausted.
  const { rows: listRows, degraded } = await buildListRows(settings);
  const activeRules = listRows.filter((l) => l.active).reduce((n, l) => n + l.ruleCount, 0);
  // A parent entry (example.com) allowlists sub.example.com, but removing the *sub* host from
  // the list cannot undo it. The popup needs to say so instead of offering a dead toggle.
  const coveredBy =
    hostname && allowlisted
      ? settings.allowlist
          .map(normalizeHostname)
          .find((h) => h !== normalizeHostname(hostname) && isAllowlistedHost(hostname, [h])) ?? null
      : null;
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
    siteFix: resolveSiteFix(hostname, settings.siteFixes),
    degraded,
    youtubeBlockSponsored: settings.youtubeBlockSponsored !== false,
    youtubeBlockShorts: !!settings.youtubeBlockShorts,
    youtubeSponsorBlock: settings.youtubeSponsorBlock !== false,
  };
}

/**
 * Compose a breakage report for the user to send.
 *
 * Everything here is the extension's own state plus the hostname the user is looking at.
 * Nothing about the page itself is read, and nothing is transmitted — the popup hands the
 * result to a mail client, where the user sees it before deciding to send.
 */
async function handleBreakageReport(hostname: string): Promise<BreakageReport> {
  const settings = await loadSettings();
  const host = normalizeHostname(hostname);
  // Same gate as allowlist / DNR match patterns — refuse garbage or CRLF-bearing hosts so
  // they cannot land in a mailto subject (normal tab hosts already pass).
  if (!isValidMatchPatternHost(host)) {
    throw new Error('invalid hostname for breakage report');
  }
  const { rows, degraded } = await buildListRows(settings);
  return buildBreakageReport({
    hostname: host,
    siteFix: resolveSiteFix(host, settings.siteFixes),
    allowlisted: isAllowlistedHost(host, settings.allowlist),
    version: chrome.runtime.getManifest().version,
    listsGeneratedAt: META.generatedAt,
    activeRuleCount: rows.filter((l) => l.active).reduce((n, l) => n + l.ruleCount, 0),
    degraded,
    enabledLists: rows.filter((l) => l.enabled).map((l) => l.id),
    browser: browserLabel(typeof navigator === 'undefined' ? null : navigator.userAgent),
    now: Date.now(),
  });
}

async function handleYoutubeGetOptions(hostname: string): Promise<YoutubeOptionsData> {
  const settings = await loadSettings();
  return {
    paused: settings.paused,
    allowlisted: isAllowlistedHost(hostname, settings.allowlist),
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
  return handlePopupGet();
}

async function handleSponsorBlockGetSegments(videoId: string): Promise<SponsorBlockSegmentsData> {
  const settings = await loadSettings();
  // Only ask for what the user wants skipped: a narrower request downloads less and discloses
  // less. All categories off short-circuits inside fetchSponsorSegments — no request at all.
  const categories = enabledSponsorCategories(settings.sponsorBlockCategories);
  const segments = await fetchSponsorSegments(videoId, categories);
  return { videoId, segments };
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

async function handleToggleSite(hostname: string, enabled: boolean): Promise<PopupData> {
  const host = normalizeHostname(hostname);
  await mutateSettings((s) => {
    const set = new Set(
      s.allowlist.map(normalizeHostname).filter((h) => isSafeAllowlistHost(h)),
    );
    if (enabled) {
      // Deleting the exact host is not enough: a parent entry (example.com) also allowlists
      // sub.example.com, so the toggle would spring straight back with no explanation. Drop
      // every entry that covers this host.
      for (const h of [...set]) {
        if (isAllowlistedHost(host, [h])) set.delete(h);
      }
    } else if (isSafeAllowlistHost(host)) set.add(host);
    s.allowlist = [...set];
  });
  // Settle these independently: they are unrelated layers, and one failing should not cost the
  // user the other. Defensive rather than load-bearing — syncRegisteredScripts and syncAllowlist
  // both swallow their own errors today, so neither can reject and reach the caller. Kept so
  // that stops being something the caller has to rely on, and so a failure is attributed to the
  // layer it came from instead of vanishing into one shared catch.
  const [allowlistResult, scriptsResult] = await withSettings((s) =>
    Promise.allSettled([syncAllowlist(s), syncRegisteredScripts(s)]),
  );
  if (allowlistResult.status === 'rejected') {
    console.error('[StampStack] allowlist DNR sync failed', allowlistResult.reason);
  }
  if (scriptsResult.status === 'rejected') {
    console.error('[StampStack] cosmetic registration sync failed', scriptsResult.reason);
  }
  return handlePopupGet();
}

/**
 * Per-page report. Asks the content script what the page reached for, then names the hosts.
 *
 * The naming index is compiled (`trackers.json`, ~9 KB): 171 domains for organizations a user
 * recognizes, each flagged with whether a shipped rule actually matches it. Hosts outside the
 * index are counted but not named — better than mislabeling an asset CDN as a tracker.
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
  if (isAllowlistedHost(hostname, settings.allowlist)) return empty('allowlisted');

  let page: { hosts?: unknown; hiddenCount?: unknown; truncated?: unknown } | undefined;
  try {
    // Top document only. all_frames content scripts each reply; without frameId the
    // first response wins and can be an iframe's hosts labeled as the tab hostname.
    page = await chrome.tabs.sendMessage(tab.id, { type: 'page:collect' }, { frameId: 0 });
  } catch {
    // No content script in this tab: a restricted page, or the tab predates the install.
    return empty('no-content-script');
  }
  if (!page || !Array.isArray(page.hosts)) return empty('no-content-script');

  const { trackers, unnamedThirdParty } = classifyHosts(page.hosts, TRACKERS);

  return {
    available: true,
    hostname,
    trackers,
    unnamedThirdParty,
    hiddenElements: typeof page.hiddenCount === 'number' ? page.hiddenCount : 0,
    truncated: page.truncated === true,
  };
}

/** Inject the picker into the active tab. Not part of the always-on content script. */
async function handlePickerStart(): Promise<{ ok: boolean; error?: string }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null || !tab.url || !isHttpOrHttpsUrl(tab.url)) {
    return { ok: false, error: 'The picker only works on ordinary web pages.' };
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['picker.js'],
    });
    return { ok: true };
  } catch (e) {
    console.error('[StampStack] picker injection failed', e);
    return { ok: false, error: 'Chrome would not let the picker run on this page.' };
  }
}

/**
 * Append one filter line from the picker.
 *
 * The line is re-parsed before it is stored: it arrives from a content script, and a content
 * script is only as trustworthy as the page it runs in. A malformed or unsafe selector is
 * rejected rather than persisted where it would break every later parse.
 */
async function handleCustomFilterAdd(
  line: string,
  sender: chrome.runtime.MessageSender,
): Promise<{ ok: boolean; error?: string }> {
  if (typeof line !== 'string' || !line.trim()) return { ok: false, error: 'Empty filter.' };
  const { filters, errors } = parseCustomFilters(line);
  if (errors.length || filters.length !== 1) {
    return { ok: false, error: errors[0]?.reason ?? 'Could not parse that filter.' };
  }
  await mutateSettings((s) => {
    s.customFilters = appendFilterLine(s.customFilters ?? '', line.trim());
  });
  // Re-push cosmetics to the tab that picked, so the element stays hidden after a reload
  // without waiting for the next navigation.
  if (sender.tab?.id != null) {
    try {
      await chrome.tabs.sendMessage(sender.tab.id, { type: 'cosmetic:refresh' });
    } catch {
      /* tab closed or navigated */
    }
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
  await mutateSettings((s) => {
    s.customFilters = text.slice(0, 100_000);
  });
  await notifyCosmeticRefresh();
  return handleCustomFiltersGet();
}

/** Re-apply hostname cosmetics on open pages after the user edits their own filters. */
async function notifyCosmeticRefresh(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id == null) return;
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'cosmetic:refresh' } satisfies Message);
      } catch {
        /* tab has no content script */
      }
    }),
  );
}

async function handleSiteFixSet(
  hostname: string,
  level: SiteFixLevel | null,
): Promise<PopupData> {
  const host = normalizeHostname(hostname);
  if (!host || !isSafeAllowlistHost(host)) return handlePopupGet();
  await mutateSettings((s) => {
    if (!s.siteFixes) s.siteFixes = {};
    // Clear every entry that covers this host, not just the exact key — otherwise a fix
    // inherited from a parent domain could not be stepped back from the affected page.
    for (const entry of Object.keys(s.siteFixes)) {
      if (isAllowlistedHost(host, [entry])) delete s.siteFixes[entry];
    }
    if (level) s.siteFixes[host] = level;
  });
  // Cosmetic/scriptlet excludes are part of the registered scripts, so they must be resynced;
  // network rules are untouched by a fix, which is the entire point of the ladder.
  await withSettings((s) => syncRegisteredScripts(s));
  return handlePopupGet();
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

async function handleSettingsImport(json: string): Promise<{ ok: boolean; error?: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: 'That file is not valid JSON.' };
  }
  const doc = parsed as { format?: unknown; settings?: unknown };
  if (doc?.format !== 'stampstack-settings' || !doc.settings || typeof doc.settings !== 'object') {
    return { ok: false, error: 'That is not a StampStack settings export.' };
  }
  // applyImportedSettings validates via mergeSettings and keeps fields the file never
  // contained (older backups omit customFilters / sponsorBlockCategories).
  await mutateSettings((s) => {
    const next = applyImportedSettings(s, doc.settings as Partial<Settings>);
    Object.assign(s, next);
  });
  await withSettings((s) => applyAll(s));
  return { ok: true };
}

async function handleSetPaused(paused: boolean): Promise<PopupData> {
  await mutateSettings((s) => {
    s.paused = paused;
  });
  await withSettings((s) => applyAll(s));
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
    const enabled = isListEnabled(settings, l.id, l.enabledByDefault) && !settings.paused;
    return {
      ...l,
      enabled: isListEnabled(settings, l.id, l.enabledByDefault),
      active: live == null ? enabled : enabled && live.includes(l.id),
    };
  });
  return { rows, degraded: rows.some((r) => r.enabled && !settings.paused && !r.active) };
}

async function handleListsGet(): Promise<ListsData> {
  const settings = await loadSettings();
  const { rows, degraded } = await buildListRows(settings);
  return { lists: rows, degraded };
}

async function handleListSetEnabled(id: string, enabled: boolean): Promise<ListsData> {
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

async function handleDarkModeSetEnabled(enabled: boolean): Promise<DarkModeData> {
  const license = await loadLicense();
  if (!isLicenseEffectivelyPaid(license)) {
    const settings = await loadSettings();
    return buildDarkModeData(settings, license, null);
  }
  const settings = await mutateSettings((s) => {
    s.darkModeEnabled = enabled;
  });
  await syncDarkModeAndActiveTab(settings, license);
  return handleDarkModeGet();
}

async function handleDarkModeSetSiteOverride(
  hostname: string,
  override: DarkModeSiteOverride | null,
): Promise<DarkModeData> {
  const host = normalizeHostname(hostname);
  const license = await loadLicense();
  if (!isLicenseEffectivelyPaid(license) || !host) {
    const settings = await loadSettings();
    return buildDarkModeData(settings, license, host || null);
  }
  const settings = await mutateSettings((s) => {
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
  await syncDarkModeAndActiveTab(settings, license);
  return handleDarkModeGet(host);
}

/**
 * Content script detected a confidently already-dark page.
 * Persist force-off (exclude from registered invert) unless user Force on.
 */
async function handleLicenseGet(): Promise<LicenseData> {
  const license = await loadLicense();
  return toLicenseData(license);
}

async function handleLicenseRefresh(): Promise<LicenseData> {
  const license = await refreshLicense();
  const settings = await loadSettings();
  await syncDarkModeAndActiveTab(settings, license);
  return toLicenseData(license);
}

async function handleLicenseDevUnlock(): Promise<{ ok: boolean; error?: string; darkMode?: DarkModeData }> {
  const result = await devUnlock();
  if (!result.ok || !result.license) return { ok: false, error: result.error };
  const settings = await mutateSettings((s) => {
    s.darkModeEnabled = true;
  });
  await syncDarkModeAndActiveTab(settings, result.license);
  return { ok: true, darkMode: await handleDarkModeGet() };
}
