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
  if (existing.length) {
    if (registrationShape(existing[0]) === registrationShape(script)) return;
    await chrome.scripting.unregisterContentScripts({ ids: [script.id] });
  }
  try {
    await chrome.scripting.registerContentScripts([desired]);
  } catch {
    // Lost a race with a concurrent sync that re-registered this id — patch it instead.
    await chrome.scripting.updateContentScripts([desired]);
  }
}
