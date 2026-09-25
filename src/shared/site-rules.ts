// Which hosts a per-site switch (the allowlist, the repair ladder) can hold, and what one entry
// covers (REVIEW_2026-09-24 B28).
//
// An entry normally covers its host and every subdomain, like uBO's trusted-site switch and like
// DNR `requestDomains`. Without a Public Suffix List that is only safe for hosts the heuristics
// in hostname.ts accept (isSafeAllowlistHost): `co.uk` or `github.io` as such an entry would
// switch off every site under it. The same heuristics also refuse real sites: go.dev and lg.com
// look like go.jp and lg.jp, wordpress.com and codesandbox.io are tenant platforms, and
// `intranet` or `nas` have one label. The switch used to accept those silently and store
// nothing, while the popup said "Reload the page to apply this".
//
// Those hosts now get an exact entry: the same stored key, covering that host alone, so the
// switch works there and can never reach a tenant or a sibling under the suffix. The scope is
// derived from the key, never stored, so a legacy or imported `github.io` also means "github.io
// itself" rather than being ignored or covering every tenant.

import {
  normalizeHostname,
  isSafeAllowlistHost,
  isValidMatchPatternHost,
  hostMatchesDomain,
  allowlistMatchPatterns,
} from './hostname.js';
import { isExtensionRestrictedHostname } from './dark-mode.js';

/** `domain`: the host and its subdomains. `exact`: that host only. */
export type SiteRuleScope = 'domain' | 'exact';

/**
 * Why a host cannot carry a site rule: an IPv6 literal (unverified in DNR, see
 * isValidMatchPatternHost), a Web Store page (Chrome keeps extensions off it entirely), or
 * anything that is not a host at all.
 */
export type SiteRuleRefusal = 'ipv6' | 'restricted' | 'invalid';

/** The scope a site rule for `host` has, or null when the host cannot carry one. */
export function siteRuleScope(host: string | null | undefined): SiteRuleScope | null {
  if (!host) return null;
  const h = normalizeHostname(host);
  if (!isValidMatchPatternHost(h) || isExtensionRestrictedHostname(h)) return null;
  return isSafeAllowlistHost(h) ? 'domain' : 'exact';
}

/** Why siteRuleScope refused `host`; null when it did not. */
export function siteRuleRefusal(host: string | null | undefined): SiteRuleRefusal | null {
  if (siteRuleScope(host)) return null;
  const h = normalizeHostname(host ?? '');
  if (h.includes(':') || h.startsWith('[')) return 'ipv6';
  if (h && isExtensionRestrictedHostname(h)) return 'restricted';
  return 'invalid';
}

/** The key a site rule for `host` is stored under, or '' when it cannot have one. */
export function siteRuleKey(host: string | null | undefined): string {
  return siteRuleScope(host) ? normalizeHostname(host!) : '';
}

/** Does the stored rule `entry` apply to a page on `host`? */
export function siteRuleCovers(entry: string, host: string | null | undefined): boolean {
  if (!host) return false;
  const scope = siteRuleScope(entry);
  if (scope === 'domain') return hostMatchesDomain(host, entry);
  if (scope === 'exact') return normalizeHostname(host) === normalizeHostname(entry);
  return false;
}

/** The first stored rule covering `host`, or null. */
export function coveringSiteRule(host: string | null | undefined, entries: string[]): string | null {
  return entries.find((e) => siteRuleCovers(e, host)) ?? null;
}

/** Is `host` switched off by the allowlist? Replaces isAllowlistedHost wherever policy is decided. */
export function isSiteAllowlisted(host: string | null | undefined, allowlist: string[]): boolean {
  return coveringSiteRule(host, allowlist) !== null;
}

/**
 * Chrome match patterns for the pages a rule covers, for registered-script excludes. An exact
 * rule has no `www.` twin: normalizeHostname keeps `www.go.dev` apart from `go.dev`.
 */
export function siteRuleMatchPatterns(entry: string): string[] {
  const scope = siteRuleScope(entry);
  if (scope === 'domain') return allowlistMatchPatterns(entry);
  if (scope === 'exact') return [`*://${normalizeHostname(entry)}/*`];
  return [];
}

/**
 * The DNR conditions that allowlist a rule's pages as top-level documents. A domain rule is
 * `requestDomains`, which covers subdomains. An exact rule anchors the URL as well:
 * `|https://go.dev^` matches go.dev on any port and never sub.go.dev, go.dev.evil.com or a query
 * string that mentions go.dev. Alone it also matched `https://go.dev@evil.example/`, since `^`
 * matches the `@` of a user name, so any site could be switched off by a link written that way.
 * `requestDomains` tests the real host, and together they cover go.dev alone, with no regex rule
 * spent (checked with testMatchOutcome, Chromium 131).
 */
export function siteRuleDnrConditions(
  entry: string,
): Pick<chrome.declarativeNetRequest.RuleCondition, 'requestDomains' | 'urlFilter'>[] {
  const scope = siteRuleScope(entry);
  const h = normalizeHostname(entry);
  if (scope === 'domain') return [{ requestDomains: [h] }];
  if (scope === 'exact') {
    return [
      { urlFilter: `|https://${h}^`, requestDomains: [h] },
      { urlFilter: `|http://${h}^`, requestDomains: [h] },
    ];
  }
  return [];
}

/**
 * The key Options > Add a site stores for what the user typed, or '' when the worker would
 * refuse it. A pasted URL keeps only its host, a trailing port or path is dropped, and an
 * internationalized name becomes its punycode form, as the tab would report it. A bare entry is
 * otherwise checked as typed, so `10.0.0` is refused rather than quietly becoming 10.0.0.0.
 */
export function siteRuleKeyFromInput(raw: string): string {
  let s = (raw ?? '').trim();
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
  return siteRuleKey(s);
}
