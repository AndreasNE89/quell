// Quell service worker — the coordinator.
//
// Responsibilities:
//   - Sync per-list static rulesets with user settings (updateEnabledRulesets).
//   - Maintain the per-site allowlist as dynamic allowAllRequests rules.
//   - Register/update the generic cosmetic stylesheet, excluding allowlisted sites.
//   - Answer cosmetic/popup/options messages.
//   - Count blocked requests per tab and drive the toolbar badge (dev builds).
//
// The SW is ephemeral: in-memory maps are rebuilt on wake, durable state lives in
// chrome.storage. Every sync function is idempotent so waking mid-state is safe.

import type {
  Message,
  CosmeticResponse,
  PopupData,
  ListsData,
  StatsData,
  Settings,
  CosmeticData,
  GeneratedMeta,
} from '../shared/types.js';
import {
  ALLOWLIST_ID_START,
  ALLOWLIST_PRIORITY,
  GENERIC_CSS_SCRIPT_ID,
  SCRIPTLETS_SCRIPT_ID,
  GENERIC_CSS_PATH,
} from '../shared/constants.js';
import { loadSettings, saveSettings, isListEnabled } from './settings.js';
import { matchCosmetic } from '../engine/cosmetic-match.js';

import cosmeticJson from '../generated/cosmetic.json';
import metaJson from '../generated/meta.json';

const COSMETIC = cosmeticJson as CosmeticData;
const META = metaJson as GeneratedMeta;

// Per-tab blocked counters (rebuilt on SW wake; best-effort for the badge).
const tabBlocked = new Map<number, number>();

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
    console.error('[quell] updateEnabledRulesets failed', e);
  }
}

function allowlistPatterns(host: string): string[] {
  return [`*://${host}/*`, `*://*.${host}/*`];
}

async function syncAllowlist(settings: Settings): Promise<void> {
  // Rebuild the whole allowlist rule set from scratch (index-based ids).
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing
    .filter((r) => r.id >= ALLOWLIST_ID_START)
    .map((r) => r.id);

  const addRules: chrome.declarativeNetRequest.Rule[] = settings.allowlist.map((host, i) => ({
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
    console.error('[quell] updateDynamicRules (allowlist) failed', e);
  }
}

/**
 * Register (or update / unregister) the two dynamically-managed content scripts:
 * the generic cosmetic stylesheet (ISOLATED) and the scriptlet injector (MAIN).
 * Both carry `excludeMatches` = the allowlist, so allowlisted sites get neither —
 * which is how MAIN-world scriptlets (no chrome.storage access) honor the allowlist.
 */
async function syncRegisteredScripts(settings: Settings): Promise<void> {
  const shouldExist = !settings.paused;
  const excludeMatches = settings.allowlist.flatMap(allowlistPatterns);
  const exclude = excludeMatches.length ? excludeMatches : undefined;

  const scripts: chrome.scripting.RegisteredContentScript[] = [
    {
      id: GENERIC_CSS_SCRIPT_ID,
      css: [GENERIC_CSS_PATH],
      matches: ['<all_urls>'],
      excludeMatches: exclude,
      runAt: 'document_start',
      allFrames: true,
      persistAcrossSessions: true,
    },
    {
      id: SCRIPTLETS_SCRIPT_ID,
      js: ['scriptlets.js'],
      world: 'MAIN' as chrome.scripting.ExecutionWorld,
      matches: ['<all_urls>'],
      excludeMatches: exclude,
      runAt: 'document_start',
      allFrames: true,
      persistAcrossSessions: true,
    },
  ];

  for (const script of scripts) {
    try {
      const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [script.id] });
      if (!shouldExist) {
        if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [script.id] });
        continue;
      }
      if (existing.length) {
        await chrome.scripting.updateContentScripts([script]);
      } else {
        // register/update isn't atomic across overlapping syncs; fall back on the
        // duplicate-id error rather than dropping the update.
        try {
          await chrome.scripting.registerContentScripts([script]);
        } catch {
          await chrome.scripting.updateContentScripts([script]);
        }
      }
    } catch (e) {
      console.error('[quell] syncRegisteredScripts failed for', script.id, e);
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
  // Keep the chain usable even if one mutation rejects.
  settingsChain = next.catch(() => loadSettings());
  return next;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  const settings = await loadSettings();
  await applyAll(settings);
  await chrome.action.setBadgeBackgroundColor({ color: '#2f6f4f' });
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
    if (tabId < 0) return; // not tied to a tab
    // Our dynamic/session rules are the allowlist allowAllRequests — those aren't
    // blocks, so counting them would inflate the badge on allowlisted sites.
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
  if (d.frameId !== 0) return; // main frame only
  tabBlocked.set(d.tabId, 0);
  void chrome.action.setBadgeText({ tabId: d.tabId, text: '' });
});

chrome.tabs.onRemoved.addListener((tabId) => tabBlocked.delete(tabId));

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  handleMessage(msg)
    .then((r) => sendResponse(r))
    .catch((e) => {
      console.error('[quell] message handler error', msg.type, e);
      sendResponse(null);
    });
  return true; // async response
});

async function handleMessage(msg: Message): Promise<unknown> {
  switch (msg.type) {
    case 'cosmetic:get':
      return handleCosmetic(msg.hostname);

    case 'cosmetic:hidden':
      return { ok: true };

    case 'popup:get':
      return handlePopupGet();

    case 'popup:toggleSite':
      return handleToggleSite(msg.hostname, msg.enabled);

    case 'popup:setPaused':
      return handleSetPaused(msg.paused);

    case 'lists:get':
      return handleListsGet();

    case 'lists:setEnabled':
      return handleListSetEnabled(msg.id, msg.enabled);

    case 'stats:get':
      return handleStatsGet();

    default:
      // Exhaustiveness guard.
      void (msg satisfies never);
      return null;
  }
}

async function handleCosmetic(hostname: string): Promise<CosmeticResponse> {
  const settings = await loadSettings();
  const allowlisted =
    settings.paused || settings.allowlist.some((h) => hostname === h || hostname.endsWith('.' + h));
  if (allowlisted) return { allowlisted: true, hide: [], unhide: [], procedural: [] };
  const m = matchCosmetic(hostname, COSMETIC);
  return { allowlisted: false, hide: m.hide, unhide: m.unhide, procedural: m.procedural };
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
  const allowlisted =
    !!hostname &&
    settings.allowlist.some((h) => hostname === h || hostname!.endsWith('.' + h));
  return {
    hostname,
    url,
    paused: settings.paused,
    allowlisted,
    tabBlocked: tab?.id != null ? tabBlocked.get(tab.id) ?? 0 : 0,
    blockedTotal: settings.blockedTotal,
  };
}

async function handleToggleSite(hostname: string, enabled: boolean): Promise<PopupData> {
  const settings = await mutateSettings((s) => {
    const set = new Set(s.allowlist);
    if (enabled) set.delete(hostname); // enabled = blocking ON = not allowlisted
    else set.add(hostname);
    s.allowlist = [...set];
  });
  await Promise.all([syncAllowlist(settings), syncRegisteredScripts(settings)]);
  return handlePopupGet();
}

async function handleSetPaused(paused: boolean): Promise<PopupData> {
  const settings = await mutateSettings((s) => {
    s.paused = paused;
  });
  await applyAll(settings);
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
  const settings = await mutateSettings((s) => {
    s.enabledLists[id] = enabled;
  });
  await syncRulesets(settings);
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
  };
}
