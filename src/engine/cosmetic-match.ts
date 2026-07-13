// Given a hostname and the compiled cosmetic dataset, compute the selectors that apply.
// Runs in the service worker so per-page payloads stay small (only this hostname's
// specific rules travel to the content script; generic hiding ships as injected CSS).

import type { CosmeticData, ProceduralRule } from '../shared/types.js';
import { domainSuffixes, domainSpecMatches } from '../shared/hostname.js';

export interface CosmeticMatch {
  hide: string[];
  unhide: string[];
  procedural: ProceduralRule[];
}

export function matchCosmetic(hostname: string, data: CosmeticData): CosmeticMatch {
  const suffixes = domainSuffixes(hostname);

  const hide = new Set<string>();
  const unhide = new Set<string>();

  for (const suffix of suffixes) {
    const h = data.hideSpecific[suffix];
    if (h) for (const s of h) hide.add(s);
    const u = data.unhideSpecific[suffix];
    if (u) for (const s of u) unhide.add(s);
  }

  // A specific unhide cancels a specific hide for the same hostname.
  for (const s of unhide) hide.delete(s);

  const procedural = data.procedural.filter((p) => domainSpecMatches(hostname, p.domains));

  return { hide: [...hide], unhide: [...unhide], procedural };
}
