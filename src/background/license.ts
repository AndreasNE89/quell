// License cache + ExtensionPay integration for paid dark mode.
// Source of truth is ExtensionPay when configured; local cache supports offline grace.

import ExtPay from 'extpay';
import type { LicenseData, LicenseState } from '../shared/types.js';
import { DARK_MODE_PRICE_LABEL, LICENSE_STORAGE_KEY } from '../shared/constants.js';
import { EXTPAY_EXTENSION_ID, isExtPayConfigured } from '../shared/extpay-config.js';
import { isLicenseEffectivelyPaid, isDevUnlockLicense } from '../shared/dark-mode.js';
import { DEV_BUILD } from '../shared/build-flags.js';

export type LicensePaidListener = (license: LicenseState) => void | Promise<void>;

let paidListener: LicensePaidListener | null = null;
let backgroundStarted = false;

export function defaultLicense(): LicenseState {
  return {
    paid: false,
    provider: 'none',
    verifiedAt: null,
  };
}

export async function loadLicense(): Promise<LicenseState> {
  const stored = await chrome.storage.local.get(LICENSE_STORAGE_KEY);
  const raw = stored[LICENSE_STORAGE_KEY] as Partial<LicenseState> | undefined;
  if (!raw) return defaultLicense();
  return { ...defaultLicense(), ...raw };
}

export async function saveLicense(license: LicenseState): Promise<void> {
  await chrome.storage.local.set({ [LICENSE_STORAGE_KEY]: license });
}

/**
 * Dev / unpacked build (not a `--store` Chrome Web Store build).
 *
 * Uses the compile-time DEV_BUILD flag rather than `chrome.runtime.getManifest().update_url`:
 * whether getManifest() exposes `update_url` for store installs is undocumented and has been
 * reported inconsistent across Chromium versions (w3c/webextensions#400). A compile-time
 * constant is unambiguous — the dev-unlock / test-license paths simply do not evaluate to
 * true in a packaged store build, regardless of runtime browser behavior. Name kept for
 * call-site stability.
 */
export function isUnpackedInstall(): boolean {
  return DEV_BUILD;
}

function getExtPay() {
  return ExtPay(EXTPAY_EXTENSION_ID);
}

/** Call once from the service worker. Registers ExtPay background + onPaid when configured. */
export function initLicense(onPaidUnlocked: LicensePaidListener): void {
  paidListener = onPaidUnlocked;
  if (!isExtPayConfigured() || backgroundStarted) return;
  try {
    const extpay = getExtPay();
    extpay.startBackground();
    backgroundStarted = true;
    extpay.onPaid.addListener((user) => {
      void (async () => {
        const next: LicenseState = {
          paid: !!user.paid,
          provider: 'extensionpay',
          verifiedAt: Date.now(),
          email: user.email ?? undefined,
        };
        await saveLicense(next);
        if (paidListener) await paidListener(next);
      })();
    });
  } catch (e) {
    console.error('[StampStack] ExtPay init failed', e);
  }
}

export function toLicenseData(license: LicenseState, nowMs: number = Date.now()): LicenseData {
  const paid = isLicenseEffectivelyPaid(license, nowMs);
  const ageMs = license.verifiedAt != null ? nowMs - license.verifiedAt : null;
  // Soft stale: still within 14d grace but last verify older than 24h.
  const grace = paid && ageMs != null && ageMs > 24 * 60 * 60 * 1000;
  return {
    paid,
    grace,
    verifiedAt: license.verifiedAt,
    email: license.email,
    provider: license.provider,
    configured: isExtPayConfigured(),
    unpacked: isUnpackedInstall(),
    priceLabel: DARK_MODE_PRICE_LABEL,
  };
}

/**
 * Re-fetch provider status. On network failure, keep cached paid if within grace.
 * Returns the license state that should be used for gating.
 */
export async function refreshLicense(): Promise<LicenseState> {
  const cached = await loadLicense();

  // Unpacked QA: don't let ExtensionPay getUser() wipe a dev-unlock license.
  if (isUnpackedInstall() && isDevUnlockLicense(cached)) {
    if (!isLicenseEffectivelyPaid(cached)) {
      const expired = { ...cached, paid: false };
      await saveLicense(expired);
      return expired;
    }
    return cached;
  }

  if (!isExtPayConfigured()) {
    // Still re-evaluate grace expiry for cached / dev unlocks.
    if (cached.paid && !isLicenseEffectivelyPaid(cached)) {
      const expired = { ...cached, paid: false };
      await saveLicense(expired);
      return expired;
    }
    return cached;
  }

  try {
    const user = await getExtPay().getUser();
    const next: LicenseState = {
      paid: !!user.paid,
      provider: 'extensionpay',
      verifiedAt: Date.now(),
      email: user.email ?? undefined,
    };
    await saveLicense(next);
    return next;
  } catch (e) {
    console.warn('[StampStack] license refresh failed; using cache', e);
    if (cached.paid && isLicenseEffectivelyPaid(cached)) return cached;
    if (cached.paid && !isLicenseEffectivelyPaid(cached)) {
      const expired = { ...cached, paid: false };
      await saveLicense(expired);
      return expired;
    }
    return cached;
  }
}

export async function openCheckout(): Promise<{ ok: boolean; error?: string }> {
  if (!isExtPayConfigured()) {
    return {
      ok: false,
      error: 'ExtensionPay is not configured. Set EXTPAY_EXTENSION_ID or extpay-config.local.ts.',
    };
  }
  try {
    await getExtPay().openPaymentPage();
    return { ok: true };
  } catch (e) {
    console.error('[StampStack] openCheckout failed', e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function openRestore(): Promise<{ ok: boolean; error?: string }> {
  if (!isExtPayConfigured()) {
    return {
      ok: false,
      error: 'ExtensionPay is not configured. Set EXTPAY_EXTENSION_ID or extpay-config.local.ts.',
    };
  }
  try {
    await getExtPay().openLoginPage();
    return { ok: true };
  } catch (e) {
    console.error('[StampStack] openRestore failed', e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Dev-only unlock for unpacked (non-store) builds.
 * Sets paid cache so dark-mode registration can be tested without ExtensionPay.
 */
export async function devUnlock(): Promise<{ ok: boolean; error?: string; license?: LicenseState }> {
  if (!isUnpackedInstall()) {
    return { ok: false, error: 'Dev unlock is only available for unpacked installs.' };
  }
  const license: LicenseState = {
    paid: true,
    provider: 'none',
    verifiedAt: Date.now(),
    email: undefined,
  };
  await saveLicense(license);
  return { ok: true, license };
}

/**
 * Unpacked testing helper: ensure a paid license cache exists so dark mode is
 * usable without ExtensionPay. No-op for packaged CWS builds.
 */
export async function ensureUnpackedTestLicense(): Promise<LicenseState> {
  const current = await loadLicense();
  if (!isUnpackedInstall()) return current;
  if (isLicenseEffectivelyPaid(current)) return current;
  const unlocked = await devUnlock();
  return unlocked.license ?? current;
}

export { isLicenseEffectivelyPaid };
