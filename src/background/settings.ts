// Load/save of persisted settings with sane defaults.

import type { Settings } from '../shared/types.js';
import { STORAGE_KEY } from '../shared/constants.js';

export function defaultSettings(): Settings {
  return {
    paused: false,
    enabledLists: {},
    allowlist: [],
    blockedTotal: 0,
    youtubeBlockSponsored: true,
    youtubeBlockShorts: false,
  };
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return { ...defaultSettings(), ...(stored[STORAGE_KEY] as Partial<Settings> | undefined) };
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
