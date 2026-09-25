// The compiled cosmetic data as the service worker loads it (REVIEW_2026-09-24 B35).
//
// cosmetic.json used to be inlined into background.js: 2.8 MB of object literal that V8 parsed
// and built on every service-worker wake, about 80 ms before the first reply (40 ms in Node),
// whether or not the wake needed it. It ships as package files instead, read with fetch() when
// needed and parsed as JSON (about 7 ms for the default lists):
//   - core.json: everything but the per-list rules (network and page exceptions, the generic
//     sheet plan). A wake needs only this, for the generic sheet's registration.
//   - list.<id>.json: one list's rules, read when a page first asks for cosmetics, for the
//     enabled lists only. A list switched off is never parsed.
// The split is by key, not by content, so it holds whatever fields compile-filters emits.
// src/background/service-worker.ts reads these paths; test/helpers/sw-harness.mjs serves them
// from this function, so the two cannot drift apart unnoticed.

export const COSMETIC_DIR = 'generated/cosmetic';

/** `cosmetic` (src/generated/cosmetic.json) as the files the worker fetches, paths under dist/. */
export function cosmeticDataFiles(cosmetic) {
  const files = [
    { path: `${COSMETIC_DIR}/core.json`, content: JSON.stringify({ ...cosmetic, byList: {} }) },
  ];
  for (const [id, data] of Object.entries(cosmetic.byList ?? {})) {
    files.push({ path: `${COSMETIC_DIR}/list.${id}.json`, content: JSON.stringify(data) });
  }
  return files;
}
