// Quell scriptlet injector (MAIN world, document_start).
//
// A MAIN-world content script bypasses the page's CSP and runs at document_start —
// the two things ad-hoc injection can't guarantee under MV3. It has no chrome APIs,
// so the scriptlet map is embedded at build time and we match location.hostname here.
//
// Allowlisting is honored at the injection boundary: the service worker registers this
// script (chrome.scripting) with excludeMatches = the allowlist, so it is never
// injected on allowlisted sites. That's why MAIN world needing no chrome.storage is fine.

import scriptletData from '../generated/scriptlets.json';
import type { ScriptletRule } from '../shared/types.js';
import { domainSpecMatches } from '../shared/hostname.js';
import { runScriptlet } from '../scriptlets/library.js';

const rules = (scriptletData as { scriptlets: ScriptletRule[] }).scriptlets;
const host = location.hostname;

if (host && rules.length) {
  for (const rule of rules) {
    if (domainSpecMatches(host, rule.domains)) {
      runScriptlet(rule.name, rule.args);
    }
  }
}
