// Hostname helpers shared by the cosmetic matcher (service worker) and the content
// scripts. We deliberately avoid a full Public Suffix List: filter authors target
// concrete domains, so matching every dotted suffix of the hostname is correct and
// cheap. `ads.sub.example.co.uk` yields suffixes down to `co.uk` — a filter written
// for any of them matches, and no real filter targets a bare public suffix.

/** Strip a leading `www.` for stable allowlist / exception keys. */
export function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^www\./, '');
}

/**
 * Hostnames safe for Chrome match patterns and DNR `requestDomains`.
 * IPv6 / empty / garbage must be rejected so one bad allowlist entry cannot
 * abort `chrome.scripting` registration for cosmetics + YouTube hooks.
 */
export function isValidMatchPatternHost(host: string): boolean {
  if (!host) return false;
  // IPv6 (raw or bracketed) is not expressible as a match-pattern host.
  if (host.includes(':') || host.includes('[') || host.includes(']')) return false;
  // Hostname or IPv4.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(host);
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

/** Common second-level labels in multi-part public suffixes (co.uk, com.au, …). */
const MULTI_TLD_SECONDS = new Set([
  'co',
  'com',
  'net',
  'org',
  'gov',
  'ac',
  'edu',
  'or',
  'ne',
  'go',
  'lg',
]);

/**
 * Entity domain `example.*` — match when the registrable name (hostname minus a
 * 1-label TLD, or a known 2-label suffix like `co.uk`) equals the entity label.
 */
function hostMatchesEntityDomain(hostname: string, entity: string): boolean {
  if (!entity || entity.includes('*') || entity.includes('.')) return false;
  const parts = hostname.split('.').filter(Boolean);
  if (parts.length < 2) return false;
  // example.com / www.example.org — entity is the label before a single-label TLD.
  if (parts[parts.length - 2] === entity) return true;
  // example.co.uk — entity before a known multi-part public suffix.
  if (
    parts.length >= 3 &&
    MULTI_TLD_SECONDS.has(parts[parts.length - 2]) &&
    parts[parts.length - 3] === entity
  ) {
    return true;
  }
  return false;
}

/** Entity keys (`example.*`) that could apply to this hostname for hideSpecific lookup. */
export function entityDomainKeys(hostname: string): string[] {
  const parts = normalizeHostname(hostname).split('.').filter(Boolean);
  const keys: string[] = [];
  if (parts.length >= 2) keys.push(`${parts[parts.length - 2]}.*`);
  if (parts.length >= 3 && MULTI_TLD_SECONDS.has(parts[parts.length - 2])) {
    keys.push(`${parts[parts.length - 3]}.*`);
  }
  return keys;
}

/** Does `hostname` fall under `domain` (equal or a subdomain of it)? */
export function hostMatchesDomain(hostname: string, domain: string): boolean {
  const host = normalizeHostname(hostname);
  const dom = normalizeHostname(domain);
  if (dom.endsWith('.*')) {
    return hostMatchesEntityDomain(host, dom.slice(0, -2));
  }
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
