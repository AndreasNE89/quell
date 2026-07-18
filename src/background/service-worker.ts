// StampStack service worker — the coordinator.
//
// Responsibilities:
//   - Sync per-list static rulesets with user settings (updateEnabledRulesets).
//   - Maintain the per-site allowlist as dynamic allowAllRequests rules.
//   - Register/update generic cosmetic CSS (+ MAIN scriptlets) excluding allowlisted sites.
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
  ScriptletData,
  ScriptletRule,
  GeneratedMeta,
  YoutubeOptionsData,
} from '../shared/types.js';
import {
  ALLOWLIST_ID_START,
  ALLOWLIST_ID_END,
  ALLOWLIST_PRIORITY,
  GENERIC_CSS_SCRIPT_ID,
  SCRIPTLETS_SCRIPT_ID,
  YOUTUBE_SCRIPTLETS_SCRIPT_ID,
} from '../shared/constants.js';
import { loadSettings, saveSettings, isListEnabled } from './settings.js';
import { matchCosmetic, matchScriptlets } from '../engine/cosmetic-match.js';
import {
  normalizeHostname,
  isAllowlistedHost,
  isValidMatchPatternHost,
} from '../shared/hostname.js';

import cosmeticJson from '../generated/cosmetic.json';
import scriptletJson from '../generated/scriptlets.json';
import metaJson from '../generated/meta.json';

const COSMETIC = cosmeticJson as CosmeticData;
const SCRIPTLETS = scriptletJson as ScriptletData;
const META = metaJson as GeneratedMeta;

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
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: enable,
      disableRulesetIds: disable,
    });
  } catch (e) {
    console.error('[StampStack] updateEnabledRulesets failed', e);
  }
}

function allowlistPatterns(host: string): string[] {
  const h = normalizeHostname(host);
  // Match patterns reject IPv6 / empty / garbage hosts; one bad entry must not abort
  // chrome.scripting registration for cosmetics + YouTube hooks.
  if (!isValidMatchPatternHost(h)) return [];
  return [`*://${h}/*`, `*://*.${h}/*`, `*://www.${h}/*`];
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
        .filter((h) => isValidMatchPatternHost(h)),
    ),
  ];
  const addRules: chrome.declarativeNetRequest.Rule[] = hosts.map((host, i) => ({
    id: ALLOWLIST_ID_START + i,
    priority: ALLOWLIST_PRIORITY,
    action: { type: 'allowAllRequests' as chrome.declarativeNetRequest.RuleActionType },
    condition: {
      requestDomains: [host],
      resourceTypes: [
        'main_frame' as chrome.declarativeNetRequest.ResourceType,
        'sub_frame' as chrome.declarativeNetRequest.ResourceType,
      ],
    },
  }));

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  } catch (e) {
    console.error('[StampStack] updateDynamicRules (allowlist) failed', e);
  }
}

/**
 * Register (or update / unregister) generic cosmetic CSS and YouTube MAIN hooks.
 * Both honor pause + allowlist excludes. List-scoped scriptlets still inject on demand.
 */
async function syncRegisteredScripts(settings: Settings): Promise<void> {
  const shouldExist = !settings.paused;
  const excludeMatches = settings.allowlist.flatMap(allowlistPatterns);
  const exclude = excludeMatches.length ? excludeMatches : undefined;
  const ids = enabledListIds(settings);
  const cssFiles = ids
    .map((id) => META.lists.find((l) => l.id === id)?.genericCssFile)
    .filter((p): p is string => !!p)
    .map((p) => `generated/${p}`);

  const cosmetic: chrome.scripting.RegisteredContentScript = {
    id: GENERIC_CSS_SCRIPT_ID,
    css: cssFiles.length ? cssFiles : undefined,
    matches: ['<all_urls>'],
    excludeMatches: exclude,
    runAt: 'document_start',
    allFrames: true,
    persistAcrossSessions: true,
  };

  const youtube: chrome.scripting.RegisteredContentScript = {
    id: YOUTUBE_SCRIPTLETS_SCRIPT_ID,
    js: ['scriptlets-youtube.js'],
    matches: [
      '*://*.youtube.com/*',
      '*://*.youtube-nocookie.com/*',
      '*://youtu.be/*',
      '*://*.youtubekids.com/*',
    ],
    excludeMatches: exclude,
    runAt: 'document_start',
    allFrames: true,
    world: 'MAIN',
    persistAcrossSessions: true,
  };

  try {
    // Drop any legacy MAIN scriptlets registration from older builds.
    try {
      await chrome.scripting.unregisterContentScripts({
        ids: ['StampStack-scriptlets', SCRIPTLETS_SCRIPT_ID],
      });
    } catch {
      /* not registered */
    }

    await syncOneRegisteredScript(cosmetic, shouldExist && cssFiles.length > 0);
    // Sponsored scrub runs only when the YouTube sponsored toggle is on.
    await syncOneRegisteredScript(
      youtube,
      shouldExist && settings.youtubeBlockSponsored !== false,
    );
  } catch (e) {
    console.error('[StampStack] syncRegisteredScripts failed', e);
  }
}

async function syncOneRegisteredScript(
  script: chrome.scripting.RegisteredContentScript,
  enabled: boolean,
): Promise<void> {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [script.id] });
  if (!enabled) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [script.id] });
    return;
  }
  if (existing.length) {
    await chrome.scripting.updateContentScripts([script]);
  } else {
    try {
      await chrome.scripting.registerContentScripts([script]);
    } catch {
      await chrome.scripting.updateContentScripts([script]);
    }
  }
}

async function applyAll(settings: Settings): Promise<void> {
  await Promise.all([
    syncRulesets(settings),
    syncAllowlist(settings),
    syncRegisteredScripts(settings),
  ]);
}

// Serialize read-modify-write of the single settings blob. Message handlers and the
// blocked-count flush run concurrently; without this, two `loadSettings → mutate →
// saveSettings` cycles interleave and the second clobbers the first's field change.
let settingsChain: Promise<Settings> = loadSettings();
function mutateSettings(mutator: (s: Settings) => void): Promise<Settings> {
  const next = settingsChain.then(async () => {
    const s = await loadSettings();
    mutator(s);
    await saveSettings(s);
    return s;
  });
  settingsChain = next.catch(() => loadSettings());
  return next;
}

/** Run work after the current settings chain (and extend the chain so init can't race). */
function withSettings<T>(fn: (s: Settings) => Promise<T>): Promise<T> {
  const next = settingsChain.then(async (s) => fn(s));
  settingsChain = next.then(() => loadSettings()).catch(() => loadSettings());
  return next;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  await withSettings(async (settings) => {
    await applyAll(settings);
    await chrome.action.setBadgeBackgroundColor({ color: '#2f6f4f' });
  });
}

chrome.runtime.onInstalled.addListener(() => void init());
chrome.runtime.onStartup.addListener(() => void init());

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

chrome.webNavigation?.onBeforeNavigate.addListener((d) => {
  if (d.frameId !== 0) return;
  tabBlocked.set(d.tabId, 0);
  void chrome.action.setBadgeText({ tabId: d.tabId, text: '' });
});

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
      return handleCosmetic(msg.hostname);

    case 'scriptlets:get':
      return handleScriptlets(msg.hostname);

    case 'scriptlets:inject':
      return handleScriptletsInject(msg.scriptlets, sender);

    case 'popup:get':
      return handlePopupGet();

    case 'popup:toggleSite':
      return handleToggleSite(msg.hostname, msg.enabled);

    case 'popup:setPaused':
      return handleSetPaused(msg.paused);

    case 'popup:setYoutubeOptions':
      return handleSetYoutubeOptions(msg.youtubeBlockSponsored, msg.youtubeBlockShorts);

    case 'youtube:getOptions':
      return handleYoutubeGetOptions(msg.hostname);

    case 'lists:get':
      return handleListsGet();

    case 'lists:setEnabled':
      return handleListSetEnabled(msg.id, msg.enabled);

    case 'stats:get':
      return handleStatsGet();

    default:
      void (msg satisfies never);
      return null;
  }
}

async function handleCosmetic(hostname: string): Promise<CosmeticResponse> {
  const settings = await loadSettings();
  if (settings.paused || isAllowlistedHost(hostname, settings.allowlist)) {
    return {
      allowlisted: true,
      hide: [],
      unhide: [],
      procedural: [],
      disableGeneric: true,
      disableSpecific: true,
    };
  }
  const m = matchCosmetic(hostname, COSMETIC, enabledListIds(settings));
  return {
    allowlisted: false,
    hide: m.hide,
    unhide: m.unhide,
    procedural: m.procedural,
    disableGeneric: m.disableGeneric,
    disableSpecific: m.disableSpecific,
  };
}

async function handleScriptlets(hostname: string): Promise<ScriptletsResponse> {
  const settings = await loadSettings();
  if (settings.paused || isAllowlistedHost(hostname, settings.allowlist)) {
    return { allowlisted: true, scriptlets: [] };
  }
  return {
    allowlisted: false,
    scriptlets: matchScriptlets(hostname, SCRIPTLETS, enabledListIds(settings)),
  };
}

async function handleScriptletsInject(
  scriptlets: ScriptletRule[],
  sender: chrome.runtime.MessageSender,
): Promise<{ ok: boolean }> {
  const tabId = sender.tab?.id;
  if (tabId == null || !scriptlets.length) return { ok: false };
  const frameIds = sender.frameId != null ? [sender.frameId] : undefined;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds },
      world: 'MAIN',
      injectImmediately: true,
      files: ['scriptlets.js'],
    });
    await chrome.scripting.executeScript({
      target: { tabId, frameIds },
      world: 'MAIN',
      injectImmediately: true,
      func: (rules) => {
        const g = globalThis as unknown as {
          __quellApplyScriptlets?: (r: typeof rules) => void;
          __quellPendingScriptlets?: typeof rules;
        };
        if (typeof g.__quellApplyScriptlets === 'function') g.__quellApplyScriptlets(rules);
        else g.__quellPendingScriptlets = rules;
      },
      args: [scriptlets],
    });
    return { ok: true };
  } catch (e) {
    console.error('[StampStack] scriptlets inject failed', e);
    return { ok: false };
  }
}

async function handlePopupGet(): Promise<PopupData> {
  const settings = await loadSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let hostname: string | null = null;
  const url = tab?.url ?? null;
  if (url) {
    try {
      hostname = new URL(url).hostname;
    } catch {
      hostname = null;
    }
  }
  const allowlisted = !!hostname && isAllowlistedHost(hostname, settings.allowlist);
  return {
    hostname,
    url,
    paused: settings.paused,
    allowlisted,
    tabBlocked: tab?.id != null ? tabBlocked.get(tab.id) ?? 0 : 0,
    blockedTotal: settings.blockedTotal,
    statsReliable: STATS_RELIABLE,
    youtubeBlockSponsored: settings.youtubeBlockSponsored !== false,
    youtubeBlockShorts: !!settings.youtubeBlockShorts,
  };
}

async function handleYoutubeGetOptions(hostname: string): Promise<YoutubeOptionsData> {
  const settings = await loadSettings();
  return {
    paused: settings.paused,
    allowlisted: isAllowlistedHost(hostname, settings.allowlist),
    youtubeBlockSponsored: settings.youtubeBlockSponsored !== false,
    youtubeBlockShorts: !!settings.youtubeBlockShorts,
  };
}

async function handleSetYoutubeOptions(
  youtubeBlockSponsored: boolean,
  youtubeBlockShorts: boolean,
): Promise<PopupData> {
  await mutateSettings((s) => {
    s.youtubeBlockSponsored = youtubeBlockSponsored;
    s.youtubeBlockShorts = youtubeBlockShorts;
  });
  // Sync must ride settingsChain — overlapping applyAll/sync* with a stale snapshot
  // can undo a newer allowlist/pause/list change (last writer wins on DNR/scripts).
  await withSettings((s) => syncRegisteredScripts(s));
  return handlePopupGet();
}

async function handleToggleSite(hostname: string, enabled: boolean): Promise<PopupData> {
  const host = normalizeHostname(hostname);
  await mutateSettings((s) => {
    const set = new Set(s.allowlist.map(normalizeHostname));
    if (enabled) set.delete(host);
    else set.add(host);
    s.allowlist = [...set];
  });
  await withSettings((s) => Promise.all([syncAllowlist(s), syncRegisteredScripts(s)]));
  return handlePopupGet();
}

async function handleSetPaused(paused: boolean): Promise<PopupData> {
  await mutateSettings((s) => {
    s.paused = paused;
  });
  await withSettings((s) => applyAll(s));
  return handlePopupGet();
}

async function handleListsGet(): Promise<ListsData> {
  const settings = await loadSettings();
  return {
    lists: META.lists.map((l) => ({
      ...l,
      enabled: isListEnabled(settings, l.id, l.enabledByDefault),
    })),
  };
}

async function handleListSetEnabled(id: string, enabled: boolean): Promise<ListsData> {
  await mutateSettings((s) => {
    s.enabledLists[id] = enabled;
  });
  // Network + cosmetics + scriptlets all honor list enablement.
  await withSettings((s) => Promise.all([syncRulesets(s), syncRegisteredScripts(s)]));
  return handleListsGet();
}

async function handleStatsGet(): Promise<StatsData> {
  const settings = await loadSettings();
  return {
    blockedTotal: settings.blockedTotal,
    paused: settings.paused,
    lists: META.lists.map((l) => ({
      ...l,
      enabled: isListEnabled(settings, l.id, l.enabledByDefault),
    })),
    regexRulesUsed: META.regexRulesUsed,
    statsReliable: STATS_RELIABLE,
  };
}
