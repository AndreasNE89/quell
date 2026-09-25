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
import { normalizeHostname } from './hostname.js';
import { siteRuleCovers } from './site-rules.js';

/** Ladder order, cheapest repair first. `null` is the top (nothing disabled). */
export const SITE_FIX_ORDER: readonly (SiteFixLevel | null)[] = [null, 'cosmetics', 'injection'];

/**
 * The fix that applies to `hostname`, or null.
 *
 * Matching mirrors the allowlist (`example.com` covers `www.example.com` and other
 * subdomains; a host the suffix heuristics refuse, like go.dev, only itself: site-rules.ts) so a
 * fix applied from the popup on `www.shop.example.com` behaves the way the user expects when
 * they navigate within the site.
 */
export function resolveSiteFix(
  hostname: string | null | undefined,
  fixes: Record<string, SiteFixLevel> | undefined,
): SiteFixLevel | null {
  return resolveSiteFixEntry(hostname, fixes)?.level ?? null;
}

/**
 * The fix that applies to `hostname` and the key it is stored under, which is a parent domain
 * when the fix is inherited (forum.example.com under example.com). The popup says so, since
 * stepping back from an inherited fix also restores every other host under that parent.
 */
export function resolveSiteFixEntry(
  hostname: string | null | undefined,
  fixes: Record<string, SiteFixLevel> | undefined,
): { level: SiteFixLevel; entry: string } | null {
  if (!hostname || !fixes) return null;
  const host = normalizeHostname(hostname);
  if (!host) return null;

  let best: { level: SiteFixLevel; entry: string } | null = null;
  for (const [entry, level] of Object.entries(fixes)) {
    if (level !== 'cosmetics' && level !== 'injection') continue;
    if (!siteRuleCovers(entry, host)) continue;
    const key = normalizeHostname(entry);
    // Several entries can cover one host (example.com and shop.example.com). Take the most
    // permissive, or the user would apply a fix and still see the page broken; between equals,
    // the host's own entry, then the nearest parent, names the source.
    const rank = (l: SiteFixLevel): number => (l === 'injection' ? 2 : 1);
    if (
      !best ||
      rank(level) > rank(best.level) ||
      (rank(level) === rank(best.level) && key.length > best.entry.length)
    ) {
      best = { level, entry: key };
    }
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
  if (level === 'injection') return 'Element hiding + script patches off';
  return 'Full blocking';
}
