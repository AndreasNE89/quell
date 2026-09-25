// Pure helpers for paid dark-mode gating and per-host override resolution.
// Kept free of chrome.* so unit tests can exercise grace + apply logic.

import type { DarkModeSiteOverride, LicenseState, Settings } from './types.js';
import { LICENSE_CLOCK_SKEW_MS, LICENSE_GRACE_MS } from './constants.js';
import { normalizeHostname } from './hostname.js';

/**
 * A `verifiedAt` we could actually have written: present and not further in the future than
 * ordinary clock skew allows. A far-future value is a forged storage blob, not a verification.
 */
export function isPlausibleVerifiedAt(
  verifiedAt: number | null | undefined,
  nowMs: number = Date.now(),
): verifiedAt is number {
  return (
    typeof verifiedAt === 'number' &&
    Number.isFinite(verifiedAt) &&
    verifiedAt <= nowMs + LICENSE_CLOCK_SKEW_MS
  );
}

/** Honor cached paid within the offline grace window; never for a missing or future verify. */
export function isLicenseEffectivelyPaid(
  license: Pick<LicenseState, 'paid' | 'verifiedAt'>,
  nowMs: number = Date.now(),
): boolean {
  if (!license.paid) return false;
  if (!isPlausibleVerifiedAt(license.verifiedAt, nowMs)) return false;
  return nowMs - license.verifiedAt <= LICENSE_GRACE_MS;
}

/** Local dev unlock on unpacked installs (`license:devUnlock` / auto-grant). */
export function isDevUnlockLicense(license: Pick<LicenseState, 'paid' | 'provider' | 'verifiedAt'>): boolean {
  return license.paid && license.provider === 'none' && license.verifiedAt != null;
}

export interface DarkModeResolveInput {
  paid: boolean;
  enabled: boolean;
  overrides: Settings['darkModeSiteOverrides'];
  hostname: string | null | undefined;
}

export interface DarkModeResolveResult {
  /** Whether dark CSS should apply on this host. */
  apply: boolean;
  /** Effective override for the host (`null` = follow global). */
  override: DarkModeSiteOverride | null;
}

/** Resolve global × per-site override × paid → apply dark mode? */
export function resolveDarkModeForHost(input: DarkModeResolveInput): DarkModeResolveResult {
  if (!input.paid) {
    return { apply: false, override: null };
  }
  const host = input.hostname ? normalizeHostname(input.hostname) : '';
  const override = host && host in input.overrides ? input.overrides[host] : null;
  if (override === 'off') return { apply: false, override: 'off' };
  if (override === 'on') return { apply: true, override: 'on' };
  return { apply: input.enabled, override: null };
}

/** Hosts with force-off (exclude from global registration). */
export function hostsWithForceOff(overrides: Settings['darkModeSiteOverrides']): string[] {
  return Object.entries(overrides)
    .filter(([, v]) => v === 'off')
    .map(([h]) => normalizeHostname(h));
}

/** Hosts with force-on (register when global is off). */
export function hostsWithForceOn(overrides: Settings['darkModeSiteOverrides']): string[] {
  return Object.entries(overrides)
    .filter(([, v]) => v === 'on')
    .map(([h]) => normalizeHostname(h));
}

/** True for ordinary web tabs we can reload / inject into (not chrome://, etc.). */
export function isHttpOrHttpsUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Hosts where Chromium blocks extension CSS/script injection (hardcoded in the browser).
 * Includes Chrome Web Store + developer dashboard (chrome.google.com).
 */
const RESTRICTED_INJECTION_HOSTS = new Set([
  'chrome.google.com',
  'chromewebstore.google.com',
]);

export function isExtensionRestrictedHostname(hostname: string | null | undefined): boolean {
  if (!hostname) return false;
  return RESTRICTED_INJECTION_HOSTS.has(normalizeHostname(hostname));
}

/** Whether paid dark mode can inject CSS on this tab URL. */
export function isDarkModeInjectibleUrl(url: string | undefined | null): boolean {
  if (!isHttpOrHttpsUrl(url)) return false;
  try {
    return !isExtensionRestrictedHostname(new URL(url!).hostname);
  } catch {
    return false;
  }
}

/**
 * How stale a cached license may be before a service-worker wake pays for a network round trip.
 *
 * The worker restarts constantly and init() used to refresh on every single wake — a hundred
 * requests a day to answer a question whose answer changes about never. Grace expiry is still
 * evaluated at use time by isLicenseEffectivelyPaid, so gating the refresh does not extend
 * anyone's access; it only stops re-asking.
 */
export const LICENSE_FRESH_MS = 6 * 60 * 60 * 1000;

export function licenseIsFresh(license: LicenseState, nowMs: number = Date.now()): boolean {
  // A future-dated blob is not fresh: it must not suppress the refresh that would correct it.
  return isPlausibleVerifiedAt(license.verifiedAt, nowMs) && nowMs - license.verifiedAt < LICENSE_FRESH_MS;
}
