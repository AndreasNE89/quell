// Hostname helpers shared by the cosmetic matcher (service worker) and the content
// scripts. We deliberately avoid a full Public Suffix List: filter authors target
// concrete domains, so matching every dotted suffix of the hostname is correct and
// cheap. `ads.sub.example.co.uk` yields suffixes down to `co.uk` — a filter written
// for any of them matches, and no real filter targets a bare public suffix.

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
 * Well-known multi-tenant / platform public suffixes (no full PSL).
 * Chrome `requestDomains: ['github.io']` matches every `*.github.io` tenant —
 * allowlisting the apex would disable network blocking across unrelated sites.
 * Keep this list curated; it does not replace a real Public Suffix List.
 */
const MULTI_TENANT_SUFFIXES = new Set([
  'github.io',
  'gitlab.io',
  'blogspot.com',
  'appspot.com',
  'herokuapp.com',
  'pages.dev',
  'vercel.app',
  'netlify.app',
  'workers.dev',
  'web.app',
  'firebaseapp.com',
  'azurewebsites.net',
  'azurestaticapps.net',
  'wordpress.com',
  'tumblr.com',
  'webflow.io',
  'ghost.io',
  'notion.site',
  'gitbook.io',
  'readthedocs.io',
  'sourceforge.io',
  'fly.dev',
  'deno.dev',
  'repl.co',
  'glitch.me',
  'codesandbox.io',
]);

/**
 * Canonical dotted-quad IPv4 only: four octets, each 0-255 with no leading zero. Chrome
 * canonicalizes `010.0.0.1` to `8.0.0.1` and `10.1` to `10.0.0.1`, so accepting any other
 * spelling would store a key that never equals the host Chrome reports for the page.
 */
export function isIPv4Host(host: string): boolean {
  return /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(host);
}

/**
 * The URL host parser treats a host whose last label is a number (decimal, or `0x` hex) as an
 * IPv4 address. `192.168` and `10.0.0` then become shorthand for other addresses, and
 * `www.192.168` or `foo.123` fail to parse at all, which Chrome reports as "Invalid host".
 */
function endsInNumber(host: string): boolean {
  const last = host.slice(host.lastIndexOf('.') + 1);
  return /^(\d+|0x[0-9a-f]*)$/i.test(last);
}

/**
 * Heuristic public-suffix / bare-TLD check (no full PSL). Used so allowlisting
 * `www.com` / `www.co.uk` cannot store `com` / `co.uk` and disable the whole TLD.
 */
export function isPublicSuffixHost(host: string): boolean {
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 1) return true;
  if (parts.length === 2 && MULTI_TLD_SECONDS.has(parts[0])) return true;
  return false;
}

/**
 * Platform / multi-tenant suffix whose subdomains are unrelated sites
 * (github.io, blogspot.com, …). Not a bare TLD — still unsafe for user allowlist
 * AAR / requestDomains, which match the listed domain and all subdomains.
 */
export function isMultiTenantPublicSuffix(host: string): boolean {
  if (!host) return false;
  return MULTI_TENANT_SUFFIXES.has(host.toLowerCase());
}

/**
 * Strip a leading `www.` for stable allowlist / exception keys — but never when
 * the remainder would be a bare public suffix (`www.com` → keep `www.com`) or a
 * multi-tenant platform suffix (`www.github.io` → keep `www.github.io`).
 */
export function normalizeHostname(hostname: string): string {
  const h = hostname.trim().toLowerCase();
  if (!h.startsWith('www.')) return h;
  const rest = h.slice(4);
  if (!rest || isPublicSuffixHost(rest) || isMultiTenantPublicSuffix(rest)) return h;
  return rest;
}

/**
 * Hostnames safe for Chrome match patterns and DNR `requestDomains`.
 * Empty / garbage must be rejected so one bad allowlist entry cannot abort
 * `chrome.scripting` registration for cosmetics + YouTube hooks: Chrome rejects the whole
 * `registerContentScripts` call over a single invalid exclude pattern.
 *
 * IPv6 literals are rejected by policy. Match patterns can express `[::1]`, but it is
 * unverified that DNR `requestDomains` matches a bracketed host, and a host we cannot
 * allowlist on the network layer must not look switchable in the popup.
 */
export function isValidMatchPatternHost(host: string): boolean {
  if (!host) return false;
  if (host.includes(':') || host.includes('[') || host.includes(']')) return false;
  if (isIPv4Host(host)) return true;
  // Partial or non-canonical IPv4 (`192.168`, `10.0.0`, `010.0.0.1`) and names that end in a
  // numeric label (`foo.123`) are either rewritten to another address or rejected outright.
  if (endsInNumber(host)) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(host);
}

/**
 * Hosts safe to store on the user allowlist / emit as DNR requestDomains.
 * Rejects bare TLDs, multi-part public suffixes, and multi-tenant platform
 * suffixes that would match unrelated sites.
 */
export function isSafeAllowlistHost(host: string): boolean {
  const h = normalizeHostname(host);
  if (!isValidMatchPatternHost(h)) return false;
  if (isIPv4Host(h) || h === 'localhost') return true;
  if (isPublicSuffixHost(h) || isMultiTenantPublicSuffix(h)) return false;
  return true;
}

/**
 * The host a site typed into Options > Add a site stands for, or '' when the service worker
 * would refuse it (so the page can say so instead of clearing the field). A pasted URL keeps
 * only its host, as the tab would report it; a trailing port or path is dropped; an
 * internationalized name becomes its punycode form. A bare entry is otherwise checked as
 * typed, so `10.0.0` is refused rather than quietly turned into 10.0.0.0.
 */
export function siteRuleHostFromInput(raw: string): string {
  let s = raw.trim();
  if (s.includes('://')) {
    try {
      s = new URL(s).hostname;
    } catch {
      return '';
    }
  } else {
    s = s.replace(/[/?#].*$/, '').replace(/:\d*$/, '');
    if (/[^\x00-\x7f]/.test(s)) {
      try {
        s = new URL(`http://${s}`).hostname;
      } catch {
        return '';
      }
    }
  }
  const host = normalizeHostname(s);
  return isSafeAllowlistHost(host) ? host : '';
}

/**
 * Chrome match-pattern excludes for an allowlisted host (and for generichide
 * registration excludes).
 * IPv4 only gets an exact host pattern: an IP has no subdomains, and `www.10.0.0.1`
 * ends in a number, so Chrome rejects it and with it the whole registration batch.
 *
 * `localhost` is single-label, so the public-suffix check below would drop it, yet
 * isSafeAllowlistHost lets users switch it off; `*.localhost` also resolves to loopback.
 *
 * Bare TLDs are never emitted. Multi-tenant suffixes (github.io) ARE emitted so
 * EasyList `@@||github.io^$generichide` can exclude `*.github.io` from the
 * generic sheet — user allowlist storage still rejects them via isSafeAllowlistHost.
 */
export function allowlistMatchPatterns(host: string): string[] {
  const h = normalizeHostname(host);
  if (!isValidMatchPatternHost(h)) return [];
  if (isIPv4Host(h)) return [`*://${h}/*`];
  if (h === 'localhost') return [`*://${h}/*`, `*://*.${h}/*`];
  if (isPublicSuffixHost(h)) return [];
  return [`*://${h}/*`, `*://*.${h}/*`, `*://www.${h}/*`];
}

/** `bing.com/search?*` → host and path glob; null when the entry has no path. */
function splitPathException(entry: string): { host: string; path: string } | null {
  const slash = entry.indexOf('/');
  if (slash <= 0) return null;
  return { host: entry.slice(0, slash), path: entry.slice(slash) };
}

/**
 * Match patterns for a page-scoped cosmetic exception (`bing.com/search?*`, from EasyList's
 * `@@||bing.com/search?$generichide`). Chrome tests a pattern's path against the URL's path
 * and query, so the exception stays on the results page. An entity host (`google.*` +
 * `/search?*`) has no match pattern and yields none; matchCosmetic handles it per page.
 */
export function pathExceptionMatchPatterns(entry: string): string[] {
  const parts = splitPathException(entry);
  if (!parts) return [];
  return exceptionHostMatchPatterns(parts.host).map((p) => `${p.slice(0, -2)}${parts.path}`);
}

/** Does a page-scoped exception entry cover this host and path+query (`/search?q=x`)? */
export function pathExceptionMatches(
  entry: string,
  hostname: string,
  pathAndQuery: string,
): boolean {
  const parts = splitPathException(entry);
  if (!parts || !filterDomainMatches(hostname, parts.host)) return false;
  const body = parts.path
    .split('*')
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`).test(pathAndQuery);
}

/**
 * Exact-host match patterns (plus the `www.` twin that normalizeHostname folds into the same
 * key), with no subdomain wildcard. IPv4 gets no `www.` twin, for the reason above.
 */
export function exactHostMatchPatterns(host: string): string[] {
  const h = normalizeHostname(host);
  if (!isValidMatchPatternHost(h)) return [];
  if (isIPv4Host(h)) return [`*://${h}/*`];
  return [`*://${h}/*`, `*://www.${h}/*`];
}

/**
 * Match patterns for a host named by a filter-list exception (`@@||www.youtube.com^$generichide`):
 * the host and its subdomains, as the filter says. Unlike allowlistMatchPatterns the host is
 * kept verbatim: uBO scopes a `www.` exception to www and below, and folding it into the
 * registrable domain switched generic hiding off on m., music. and studio.youtube.com too.
 */
export function exceptionHostMatchPatterns(host: string): string[] {
  const h = host.trim().toLowerCase();
  if (!isValidMatchPatternHost(h)) return [];
  if (isIPv4Host(h)) return [`*://${h}/*`];
  if (h === 'localhost') return [`*://${h}/*`, `*://*.${h}/*`];
  if (isPublicSuffixHost(h)) return [];
  return [`*://${h}/*`, `*://*.${h}/*`];
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

/** A uBO regex hostname in a filter's domain list (`/^www\.site\d+\.xyz$/`), kept verbatim. */
export function isRegexDomain(domain: string): boolean {
  return domain.length > 2 && domain.startsWith('/') && domain.endsWith('/');
}

const regexDomainCache = new Map<string, RegExp | null>();

/** uBO tests a regex hostname against the whole hostname, unanchored unless the regex is. */
function regexDomainMatches(host: string, domain: string): boolean {
  let re = regexDomainCache.get(domain);
  if (re === undefined) {
    try {
      re = new RegExp(domain.slice(1, -1));
    } catch {
      re = null;
    }
    // Filter domains are a fixed, small set; the bound only guards against a runaway caller.
    if (regexDomainCache.size > 512) regexDomainCache.clear();
    regexDomainCache.set(domain, re);
  }
  return re !== null && re.test(host);
}

// Matching one page against many rules asks for the same host's keys over and over. The
// returned array is shared: callers must not mutate it.
let lastEntityHost = '';
let lastEntityKeys: string[] = [];

/**
 * Entity keys (`example.*`, `www.example.*`) a filter for this hostname can be filed under: each
 * label suffix of the hostname once its public suffix is removed, as uBO derives them, so
 * EasyList's `www.google.*` and `read.amazon.*` rules reach their pages. Without a PSL both
 * readings of an `x.co.uk`-style ending are tried. A `www.` is never stripped: `www.google.*`
 * is not `google.*` (News, Mail and Maps are other sites). IP addresses have no entity.
 */
export function entityDomainKeys(hostname: string): string[] {
  const host = hostname.trim().toLowerCase();
  if (host === lastEntityHost) return lastEntityKeys;
  const parts = host.split('.').filter(Boolean);
  const keys: string[] = [];
  const addLabelsBefore = (end: number): void => {
    for (let i = 0; i < end; i++) {
      const key = `${parts.slice(i, end).join('.')}.*`;
      if (!keys.includes(key)) keys.push(key);
    }
  };
  if (!isIPv4Host(host)) {
    if (parts.length >= 3 && MULTI_TLD_SECONDS.has(parts[parts.length - 2])) {
      addLabelsBefore(parts.length - 2);
    }
    if (parts.length >= 2) addLabelsBefore(parts.length - 1);
  }
  lastEntityHost = host;
  lastEntityKeys = keys;
  return keys;
}

/**
 * Every key a filter domain can take that matches this hostname: the hostname and each parent
 * domain down to the TLD (uBO's `pl#@#…` targets a whole ccTLD), then the entity keys.
 * `filterDomainMatches(host, d)` holds for a non-regex `d` exactly when `d` is in this list,
 * so a rule index keyed by domain can be probed with it instead of testing every rule.
 */
export function hostLookupKeys(hostname: string): string[] {
  const host = hostname.trim().toLowerCase();
  const parts = host.split('.').filter(Boolean);
  const keys: string[] = [];
  for (let i = 0; i < parts.length; i++) keys.push(parts.slice(i).join('.'));
  return [...keys, ...entityDomainKeys(host)];
}

/**
 * Does `hostname` fall under a domain a filter list names (equal or a subdomain of it, an
 * entity `name.*` / `sub.name.*`, or a `/regex/` hostname)?
 *
 * The filter's domain is compared as written, as uBO does: `www.yahoo.com##+js(…)` is for
 * www.yahoo.com and its subdomains, not mail.yahoo.com, and a `www.wp.pl` exception does not
 * cancel rules on sportowefakty.wp.pl. Folding `www.` is for the user's own entries only
 * (hostMatchesDomain).
 */
export function filterDomainMatches(hostname: string, domain: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (isRegexDomain(domain)) return regexDomainMatches(host, domain);
  const dom = domain.trim().toLowerCase();
  if (!dom || !host) return false;
  if (dom.endsWith('.*')) return entityDomainKeys(host).includes(dom);
  if (host === dom) return true;
  return host.endsWith('.' + dom);
}

/**
 * Does `hostname` fall under a host the user named (allowlist, repair ladder): equal or a
 * subdomain of it, both sides www-folded, so an entry saved from www.example.com covers the site.
 */
export function hostMatchesDomain(hostname: string, domain: string): boolean {
  const host = normalizeHostname(hostname);
  const dom = normalizeHostname(domain);
  if (dom.endsWith('.*')) return filterDomainMatches(host, dom);
  if (host === dom) return true;
  return host.endsWith('.' + dom);
}

/** True if hostname is covered by a filter's include/exclude domain spec (uBO semantics). */
export function domainSpecMatches(
  hostname: string,
  spec: { include: string[]; exclude: string[] },
): boolean {
  if (spec.exclude.some((d) => filterDomainMatches(hostname, d))) return false;
  if (spec.include.length === 0) return true; // generic
  return spec.include.some((d) => filterDomainMatches(hostname, d));
}

/** Is this hostname on the user allowlist (exact or subdomain of an entry)? */
export function isAllowlistedHost(hostname: string, allowlist: string[]): boolean {
  return allowlist.some((h) => {
    // Ignore corrupt/legacy bare-TLD entries so they cannot disable a whole suffix.
    if (!isSafeAllowlistHost(h)) return false;
    return hostMatchesDomain(hostname, h);
  });
}

/** True if any filter-list exception host (`@@||host^$generichide`) matches this page hostname. */
export function matchesExceptionHost(hostname: string, hosts: string[]): boolean {
  return hosts.some((h) => filterDomainMatches(hostname, h));
}
