// StampStack list-scriptlet runtime (MAIN world).
//
// Always the last file of an injection whose earlier files are compiled rule data
// (generated/scriptlets/*.js, see scripts/lib/scriptlet-shards.mjs). Two ways in:
//   - registered content scripts at document_start, so the scriptlets are in place before the
//     page's first inline <head> script (REVIEW_2026-09-24 B2);
//   - chrome.scripting.executeScript from the service worker, for frames those cannot serve.
//     A marker file in the same injection says so.
//
// Nothing is left on the page: the data files hand over through one property that this file
// deletes before any page script runs, and no function is exposed for a page to call or
// replace (the old `__quellApplyScriptlets` global could be hijacked by the page).

import { runScriptlet } from '../scriptlets/library.js';
import { matchShards, type ShardData } from '../engine/scriptlet-shards.js';
import { frameScope } from '../shared/frame-scope.js';
import runtimeKey from '../generated/scriptlet-runtime.json';

function drain(): unknown[] | null {
  const g = globalThis as unknown as Record<string, unknown>;
  const key = runtimeKey.key;
  try {
    if (!Object.prototype.hasOwnProperty.call(g, key)) return null;
    const queue = g[key];
    delete g[key];
    return Array.isArray(queue) ? queue : null;
  } catch {
    return null;
  }
}

function run(): void {
  const queue = drain();
  if (!queue) return;
  let fallback = false;
  const datas: ShardData[] = [];
  for (const item of queue) {
    const d = item as (ShardData & { fallback?: number }) | null;
    if (!d || typeof d !== 'object') continue;
    if (d.fallback === 1) fallback = true;
    else if (typeof d.p === 'string') datas.push(d);
  }
  const scope = frameScope();
  if (!scope.host) return;
  // A frame on another host than the top page may sit on an allowlisted or paused page, which
  // only the service worker can tell; the content script asks it (frame-scope.ts).
  if (!fallback && !scope.registered) return;
  for (const { name, args } of matchShards(scope.host, datas)) {
    try {
      runScriptlet(name, args, scope.host);
    } catch {
      /* never break the page */
    }
  }
}

try {
  run();
} catch {
  /* never break the page */
}
