// Breakage repair ladder: graded per-site relaxation instead of an all-or-nothing allowlist.
//
// When a site breaks, the cause is almost always element hiding (a layout collapses because a
// container was hidden) or a scriptlet (a page global was patched). Network blocking is rarely
// the culprit. Offering only "turn StampStack off here" therefore trades a cosmetic glitch for
// every ad and tracker on the page — so the ladder tries the cheap fixes first:
//
//   none → cosmetics off → cosmetics + scriptlets off → allowlist (everything off)
//
// Only the last rung is the existing allowlist; the first two keep network blocking on.

import type { SiteFixLevel } from './types.js';
import { normalizeHostname, isAllowlistedHost } from './hostname.js';

/** Ladder order, cheapest repair first. `null` is the top (nothing disabled). */
export const SITE_FIX_ORDER: readonly (SiteFixLevel | null)[] = [null, 'cosmetics', 'injection'];

/**
 * The fix that applies to `hostname`, or null.
 *
 * Matching mirrors the allowlist (`example.com` covers `www.example.com` and other
 * subdomains) so a fix applied from the popup on `www.shop.example.com` behaves the way the
 * user expects when they navigate within the site.
 */
export function resolveSiteFix(
  hostname: string | null | undefined,
  fixes: Record<string, SiteFixLevel> | undefined,
): SiteFixLevel | null {
  if (!hostname || !fixes) return null;
  const host = normalizeHostname(hostname);
  if (!host) return null;

  let best: SiteFixLevel | null = null;
  for (const [entry, level] of Object.entries(fixes)) {
    if (!isAllowlistedHost(host, [entry])) continue;
    // Several entries can cover one host (example.com and www.example.com). Take the most
    // permissive, or the user would apply a fix and still see the page broken.
    if (level === 'injection') return 'injection';
    best = best ?? level;
  }
  return best;
}

/** Element hiding is suppressed at every rung of the ladder. */
export function fixDisablesCosmetics(level: SiteFixLevel | null): boolean {
  return level === 'cosmetics' || level === 'injection';
}

/** Scriptlets (MAIN-world patches) are suppressed only at the second rung. */
export function fixDisablesScriptlets(level: SiteFixLevel | null): boolean {
  return level === 'injection';
}

/** Next rung down, or null when already at the bottom (caller should offer the allowlist). */
export function nextSiteFix(level: SiteFixLevel | null): SiteFixLevel | null {
  const i = SITE_FIX_ORDER.indexOf(level ?? null);
  if (i < 0 || i + 1 >= SITE_FIX_ORDER.length) return null;
  return SITE_FIX_ORDER[i + 1];
}

/** Hosts carrying a fix that suppresses element hiding. */
export function hostsWithCosmeticsOff(fixes: Record<string, SiteFixLevel> | undefined): string[] {
  return Object.entries(fixes ?? {})
    .filter(([, level]) => fixDisablesCosmetics(level))
    .map(([host]) => host);
}

/** Hosts carrying a fix that suppresses scriptlets. */
export function hostsWithScriptletsOff(fixes: Record<string, SiteFixLevel> | undefined): string[] {
  return Object.entries(fixes ?? {})
    .filter(([, level]) => fixDisablesScriptlets(level))
    .map(([host]) => host);
}

/** Short label for the popup / options rows. */
export function siteFixLabel(level: SiteFixLevel | null): string {
  if (level === 'cosmetics') return 'Element hiding off';
  if (level === 'injection') return 'Element hiding + scriptlets off';
  return 'Full blocking';
}
