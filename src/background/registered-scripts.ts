// Registration helpers for chrome.scripting content scripts.
//
// Extracted from the service worker so the delta-update trap has a test seam: the SW itself
// can only be exercised in a real browser, and this is the one piece whose failure mode is
// silent and permanent (a stale excludeMatches survives restarts via persistAcrossSessions).

/** Comparable normal form of the fields that decide what a registration actually does. */
export function registrationShape(s: Partial<chrome.scripting.RegisteredContentScript>): string {
  const arr = (v?: string[]): string[] => [...(v ?? [])].sort();
  return JSON.stringify({
    js: arr(s.js),
    css: arr(s.css),
    matches: arr(s.matches),
    excludeMatches: arr(s.excludeMatches),
    runAt: s.runAt ?? 'document_idle',
    allFrames: s.allFrames ?? false,
    matchOriginAsFallback: s.matchOriginAsFallback ?? false,
    world: s.world ?? 'ISOLATED',
  });
}

/** chrome.scripting treats an absent array as "none"; pass absent rather than empty. */
export function forApi(
  s: chrome.scripting.RegisteredContentScript,
): chrome.scripting.RegisteredContentScript {
  const out = { ...s };
  if (out.js && !out.js.length) delete out.js;
  if (out.css && !out.css.length) delete out.css;
  if (out.excludeMatches && !out.excludeMatches.length) delete out.excludeMatches;
  return out;
}

/**
 * Bring one registered content script to the desired state.
 *
 * `updateContentScripts` is a DELTA update: a property absent from the payload is left
 * untouched. An excludeMatches set that shrinks to empty would therefore keep its stale value
 * forever — e.g. allowlisting youtube.com and then un-allowlisting it would leave the YouTube
 * MAIN-world hooks permanently excluded from YouTube. Replace the registration outright
 * instead of patching it, and skip the write entirely when nothing changed.
 *
 * Replacing means a window with no registration at all. If Chrome rejects the new payload
 * (one invalid excludeMatches entry fails the whole call), the previous registration is put
 * back and the original error is rethrown: otherwise a bad pattern would silently delete a
 * working script, and persistAcrossSessions would keep it deleted.
 */
export async function syncOneRegisteredScript(
  script: chrome.scripting.RegisteredContentScript,
  enabled: boolean,
): Promise<void> {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [script.id] });
  if (!enabled) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [script.id] });
    return;
  }
  const desired = forApi(script);
  const previous = existing[0];
  if (previous) {
    if (registrationShape(previous) === registrationShape(script)) return;
    await chrome.scripting.unregisterContentScripts({ ids: [script.id] });
  }
  try {
    await chrome.scripting.registerContentScripts([desired]);
  } catch (err) {
    const live = await chrome.scripting
      .getRegisteredContentScripts({ ids: [script.id] })
      .catch(() => []);
    if (live.length) {
      // Lost a race with a concurrent sync that re-registered this id — patch it instead.
      await chrome.scripting.updateContentScripts([desired]);
      return;
    }
    const duplicate = DUPLICATE_ID_RE.test(String((err as Error)?.message ?? err));
    if (duplicate && (await retryAfterDuplicate(script, desired))) {
      console.warn(`[StampStack] ${script.id}: registered on a second try after a duplicate-id refusal`, err);
      return;
    }
    if (previous) {
      try {
        await chrome.scripting.registerContentScripts([forApi(previous)]);
      } catch (restoreErr) {
        console.error(`[StampStack] could not restore ${script.id}`, restoreErr);
      }
    }
    throw err;
  }
}

/** Chrome's refusal when an id is already registered, e.g. "Duplicate script ID 'quell-dark-mode'". */
const DUPLICATE_ID_RE = /Duplicate script ID/i;
const DUPLICATE_RETRY_MS = 150;

/**
 * Chrome refused an id as a duplicate while a read shows no such id (seen for quell-dark-mode):
 * a registration kept by persistAcrossSessions can still be restoring, or an unregister made
 * elsewhere has not settled. Look once more after a moment and write our shape over whatever
 * is there then, replacing rather than patching (see syncOneRegisteredScript).
 */
async function retryAfterDuplicate(
  script: chrome.scripting.RegisteredContentScript,
  desired: chrome.scripting.RegisteredContentScript,
): Promise<boolean> {
  await new Promise((r) => setTimeout(r, DUPLICATE_RETRY_MS));
  try {
    const live = await chrome.scripting.getRegisteredContentScripts({ ids: [script.id] });
    if (live[0] && registrationShape(live[0]) === registrationShape(script)) return true;
    if (live.length) await chrome.scripting.unregisterContentScripts({ ids: [script.id] });
    await chrome.scripting.registerContentScripts([desired]);
    return true;
  } catch {
    return false;
  }
}

/** A registration whose `matches` is only built when it has to be written. */
export interface LazyContentScript extends Omit<chrome.scripting.RegisteredContentScript, 'matches'> {
  matches: () => string[];
}

function shapeWithoutMatches(s: Partial<chrome.scripting.RegisteredContentScript>): string {
  return registrationShape({ ...s, matches: [] });
}

/** Unregister ids, one at a time if the batch is refused (it is all or nothing). */
async function unregisterAll(ids: string[]): Promise<void> {
  if (!ids.length) return;
  try {
    await chrome.scripting.unregisterContentScripts({ ids });
  } catch {
    for (const id of ids) {
      await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {});
    }
  }
}

/**
 * Bring every registration whose id starts with `prefix` to `desired`, and remove the others,
 * ids an older build used included. Resolves to what is live afterwards, id → js.
 *
 * Built for the scriptlet shards: thousands of `matches` each, re-checked on every
 * service-worker wake. Building and sorting those arrays just to find nothing changed would be
 * the expensive part of a wake, so the caller guarantees that `js` decides `matches`
 * (content-addressed file names) and they are compared without it.
 *
 * Changes go to Chrome as one unregister and one register call, because every call makes
 * Chrome reload the extension's scripts in each renderer. If Chrome refuses the batch, each
 * script is retried alone so one bad payload costs only itself, and one that still fails gets
 * its previous registration back (B4); the first error is then rethrown for the caller to log.
 */
export async function syncRegisteredScriptGroup(
  prefix: string,
  desired: LazyContentScript[],
): Promise<Map<string, string[]>> {
  const all = await chrome.scripting.getRegisteredContentScripts();
  const live = new Map(all.filter((s) => s.id.startsWith(prefix)).map((s) => [s.id, s]));
  const wanted = new Set(desired.map((s) => s.id));
  const stale = [...live.keys()].filter((id) => !wanted.has(id));
  const changed = desired.filter((s) => {
    const previous = live.get(s.id);
    return !previous || shapeWithoutMatches(previous) !== shapeWithoutMatches({ ...s, matches: [] });
  });
  const result = new Map<string, string[]>();
  for (const [id, s] of live) if (wanted.has(id)) result.set(id, s.js ?? []);
  if (!stale.length && !changed.length) return result;

  const replaced = changed.filter((s) => live.has(s.id)).map((s) => s.id);
  await unregisterAll([...stale, ...replaced]);
  for (const id of replaced) result.delete(id);
  if (!changed.length) return result;

  const payloads = changed.map((s) => forApi({ ...s, matches: s.matches() }));
  try {
    await chrome.scripting.registerContentScripts(payloads);
    for (const p of payloads) result.set(p.id, p.js ?? []);
    return result;
  } catch {
    let firstError: unknown = null;
    for (const p of payloads) {
      try {
        await chrome.scripting.registerContentScripts([p]);
        result.set(p.id, p.js ?? []);
      } catch (err) {
        firstError ??= err;
        const previous = live.get(p.id);
        if (!previous) continue;
        try {
          await chrome.scripting.registerContentScripts([forApi(previous)]);
          result.set(p.id, previous.js ?? []);
        } catch (restoreErr) {
          console.error(`[StampStack] could not restore ${p.id}`, restoreErr);
        }
      }
    }
    if (firstError) throw firstError;
    return result;
  }
}
