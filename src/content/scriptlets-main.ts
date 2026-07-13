// Quell scriptlet library entry (MAIN world).
//
// Loaded via chrome.scripting.executeScript from the service worker with the
// enabled-list-filtered rule set. Exposes `__quellApplyScriptlets` for the injector
// and also self-applies if `__quellPendingScriptlets` was staged first.

import type { ScriptletRule } from '../shared/types.js';
import { runScriptlet } from '../scriptlets/library.js';

function keyOf(r: ScriptletRule): string {
  return `${r.name}\0${r.args.join('\0')}`;
}

function applyScriptlets(rules: ScriptletRule[]): void {
  const seen = new Set<string>();
  for (const rule of rules) {
    const k = keyOf(rule);
    if (seen.has(k)) continue;
    seen.add(k);
    try {
      runScriptlet(rule.name, rule.args);
    } catch {
      /* never break the page */
    }
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __quellApplyScriptlets: ((rules: ScriptletRule[]) => void) | undefined;
  // eslint-disable-next-line no-var
  var __quellPendingScriptlets: ScriptletRule[] | undefined;
}

globalThis.__quellApplyScriptlets = applyScriptlets;

const pending = globalThis.__quellPendingScriptlets;
if (Array.isArray(pending) && pending.length) {
  globalThis.__quellPendingScriptlets = undefined;
  applyScriptlets(pending);
}
