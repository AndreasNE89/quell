// Hostname helpers shared by the cosmetic matcher (service worker) and the content
// scripts. We deliberately avoid a full Public Suffix List: filter authors target
// concrete domains, so matching every dotted suffix of the hostname is correct and
// cheap. `ads.sub.example.co.uk` yields suffixes down to `co.uk` — a filter written
// for any of them matches, and no real filter targets a bare public suffix.

/** Strip a leading `www.` for stable allowlist / exception keys. */
export function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^www\./, '');
}

/** Return the hostname and each of its parent domains, most specific first. */
export function domainSuffixes(hostname: string): string[] {
  const host = normalizeHostname(hostname);
  const parts = host.split('.').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    out.push(parts.slice(i).join('.'));
  }
  // Always include the exact (www-stripped) hostname.
  if (host && !out.includes(host)) out.unshift(host);
  // Also keep the raw hostname if it differed (rare non-www exact filters).
  if (hostname && hostname !== host && !out.includes(hostname)) out.unshift(hostname);
  return out;
}

/** Does `hostname` fall under `domain` (equal or a subdomain of it)? */
export function hostMatchesDomain(hostname: string, domain: string): boolean {
  const host = normalizeHostname(hostname);
  const dom = normalizeHostname(domain);
  if (host === dom) return true;
  return host.endsWith('.' + dom);
}

/** True if hostname is covered by an include/exclude domain spec (uBO semantics). */
export function domainSpecMatches(
  hostname: string,
  spec: { include: string[]; exclude: string[] },
): boolean {
  if (spec.exclude.some((d) => hostMatchesDomain(hostname, d))) return false;
  if (spec.include.length === 0) return true; // generic
  return spec.include.some((d) => hostMatchesDomain(hostname, d));
}

/** Is this hostname on the user allowlist (exact or subdomain of an entry)? */
export function isAllowlistedHost(hostname: string, allowlist: string[]): boolean {
  return allowlist.some((h) => hostMatchesDomain(hostname, h));
}

/** True if any exception host matches this page hostname. */
export function matchesExceptionHost(hostname: string, hosts: string[]): boolean {
  return hosts.some((h) => hostMatchesDomain(hostname, h));
}
