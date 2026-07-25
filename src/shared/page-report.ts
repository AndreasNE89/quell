// Pure shaping for the per-page report: raw hostnames in, named organizations out.
//
// Split from the service worker so the naming rules are testable. The subdomain walk and the
// per-organization dedupe are both easy to get subtly wrong in ways that only show up as a
// misleading popup — e.g. labeling `notdoubleclick.net` as Google, or listing one org five
// times because it serves from five hosts.

import type { ReportTracker, TrackerIndex } from './types.js';

/**
 * Resolve a hostname to a named organization.
 *
 * Walks up the labels so `cdn.eu.criteo.com` resolves via `criteo.com`, but only ever matches
 * on a full label boundary — `notcriteo.com` must not match `criteo.com`.
 */
export function lookupTracker(
  host: string,
  index: TrackerIndex,
): { label: string; blocked: boolean } | null {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!h) return null;
  const direct = index.domains[h];
  if (direct) return direct;

  const parts = h.split('.');
  // Start at 1: index 0 is the full host, already tried. Stop before the bare TLD so a
  // single-label suffix can never match.
  for (let i = 1; i <= parts.length - 2; i++) {
    const hit = index.domains[parts.slice(i).join('.')];
    if (hit) return hit;
  }
  return null;
}

export interface ClassifiedHosts {
  /** One row per organization, unblocked first — those are what deserve attention. */
  trackers: ReportTracker[];
  /** Third-party hosts we saw but cannot name. */
  unnamedThirdParty: number;
}

/** Classify the hosts a page reached for into named orgs plus an unnamed count. */
export function classifyHosts(hosts: readonly unknown[], index: TrackerIndex): ClassifiedHosts {
  const byLabel = new Map<string, ReportTracker>();
  let unnamed = 0;

  for (const raw of hosts) {
    if (typeof raw !== 'string' || !raw) continue;
    const host = raw.toLowerCase();
    const hit = lookupTracker(host, index);
    if (!hit) {
      unnamed++;
      continue;
    }
    const prev = byLabel.get(hit.label);
    // Collapse to one row per organization. When an org serves from both a blocked and an
    // unblocked host, show the unblocked one — that is the actionable half.
    if (!prev || (prev.blocked && !hit.blocked)) {
      byLabel.set(hit.label, { host, label: hit.label, blocked: hit.blocked });
    }
  }

  return {
    trackers: [...byLabel.values()].sort(
      (a, b) => Number(a.blocked) - Number(b.blocked) || a.label.localeCompare(b.label),
    ),
    unnamedThirdParty: unnamed,
  };
}
