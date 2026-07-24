// Build-time flags. `__STAMPSTACK_DEV__` is replaced by esbuild `define` in
// scripts/build.mjs: dev/unpacked builds → true, Chrome Web Store (`--store`) builds → false.
//
// This is the reliable signal for "is this a developer build" — unlike
// chrome.runtime.getManifest().update_url, whose presence in getManifest() is
// undocumented and contested across Chromium versions (see w3c/webextensions#400).
// Gating the local test-license + dev-unlock paths on a compile-time constant means
// they cannot fire in a packaged store build regardless of runtime browser behavior.
//
// Fail closed: if the define is missing, treat as production (never Dev unlock).

declare const __STAMPSTACK_DEV__: boolean;

/** True for local/unpacked dev builds; false for `--store` Chrome Web Store builds. */
export const DEV_BUILD: boolean =
  typeof __STAMPSTACK_DEV__ === 'boolean' ? __STAMPSTACK_DEV__ : false;
