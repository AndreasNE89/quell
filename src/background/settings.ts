// Load/save of persisted settings with sane defaults.
// Migrates pre-rebrand keys → `stampstack.settings`.

import type { Settings } from '../shared/types.js';
import { LEGACY_STORAGE_KEYS, STORAGE_KEY } from '../shared/constants.js';

export function defaultSettings(): Settings {
  return {
    paused: false,
    enabledLists: {},
    allowlist: [],
    blockedTotal: 0,
    youtubeBlockSponsored: true,
    youtubeBlockShorts: false,
    darkModeEnabled: false,
    darkModeSiteOverrides: {},
    darkModeAutoOff: {},
  };
}

export async function loadSettings(): Promise<Settings> {
  const keys = [STORAGE_KEY, ...LEGACY_STORAGE_KEYS];
  const stored = await chrome.storage.local.get([...keys]);
  const current = stored[STORAGE_KEY] as Partial<Settings> | undefined;
  if (current) {
    const stale = LEGACY_STORAGE_KEYS.filter((k) => k in stored);
    if (stale.length) await chrome.storage.local.remove([...stale]);
    return { ...defaultSettings(), ...current };
  }

  for (const legacyKey of LEGACY_STORAGE_KEYS) {
    const legacy = stored[legacyKey] as Partial<Settings> | undefined;
    if (!legacy) continue;
    const migrated = { ...defaultSettings(), ...legacy };
    await chrome.storage.local.set({ [STORAGE_KEY]: migrated });
    await chrome.storage.local.remove([...LEGACY_STORAGE_KEYS]);
    return migrated;
  }

  return defaultSettings();
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: settings });
}

/** Resolve whether a list is enabled, honoring the user override then the default. */
export function isListEnabled(
  settings: Settings,
  listId: string,
  enabledByDefault: boolean,
): boolean {
  return listId in settings.enabledLists ? settings.enabledLists[listId] : enabledByDefault;
}
