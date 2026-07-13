// Hostname helpers shared by the cosmetic matcher (service worker) and the content
// scripts. We deliberately avoid a full Public Suffix List: filter authors target
// concrete domains, so matching every dotted suffix of the hostname is correct and
// cheap. `ads.sub.example.co.uk` yields suffixes down to `co.uk` — a filter written
// for any of them matches, and no real filter targets a bare public suffix.

/** Return the hostname and each of its parent domains, most specific first. */
export function domainSuffixes(hostname: string): string[] {
  const host = hostname.replace(/^www\./, '');
  const parts = host.split('.');
  const out: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    out.push(parts.slice(i).join('.'));
  }
  // Always include the exact hostname too (covers the www-stripped form above).
  if (!out.includes(hostname)) out.unshift(hostname);
  return out;
}

/** Does `hostname` fall under `domain` (equal or a subdomain of it)? */
export function hostMatchesDomain(hostname: string, domain: string): boolean {
  if (hostname === domain) return true;
  return hostname.endsWith('.' + domain);
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
