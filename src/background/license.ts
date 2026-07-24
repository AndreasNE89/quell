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

/**
 * Serializes every read-modify-write of the license blob.
 *
 * `refreshLicense` reads the cache, awaits a network round trip, then writes. Without a lock
 * an ExtPay `onPaid` callback that lands mid-flight is overwritten by the in-flight refresh's
 * stale `paid: false` — the customer pays, dark mode unlocks, then silently re-locks.
 */
let licenseChain: Promise<unknown> = Promise.resolve();
function withLicenseLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = licenseChain.then(fn, fn);
  licenseChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** Cached from chrome.management.getSelf(); null until probeInstallEnvironment(). */
let runtimeInstallType: string | null = null;

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
 * Probe Chrome install type once at SW startup.
 * CWS installs are `normal`; unpacked Load unpacked is `development`.
 * getSelf() does not require the management permission.
 */
export async function probeInstallEnvironment(): Promise<void> {
  try {
    const self = await chrome.management.getSelf();
    runtimeInstallType = self.installType;
  } catch {
    // Tests / odd hosts: leave null and fall back to DEV_BUILD only.
    runtimeInstallType = null;
  }
}

/**
 * True only for local unpacked QA builds — never for Chrome Web Store installs.
 *
 * Requires compile-time DEV_BUILD (from `npm run build`, not `--store`) AND, when
 * known, Chrome installType `development`. A store zip accidentally built without
 * `--store` still reports installType `normal`, so Dev unlock stays hidden.
 */
export function isUnpackedInstall(): boolean {
  if (!DEV_BUILD) return false;
  if (runtimeInstallType != null) return runtimeInstallType === 'development';
  return true;
}

// One instance for the life of the worker. ExtPay tracks the paid transition on the instance
// it polls, so a throwaway `ExtPay(...)` created for a getUser() call can consume the
// false->true edge and the onPaid listener registered in initLicense never fires — the
// customer pays and nothing happens until they find the toggle themselves.
let extPayInstance: ReturnType<typeof ExtPay> | null = null;
function getExtPay() {
  if (!extPayInstance) extPayInstance = ExtPay(EXTPAY_EXTENSION_ID);
  return extPayInstance;
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
        await withLicenseLock(() => saveLicense(next));
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
  const before = await loadLicense();
  const next = await withLicenseLock(() => refreshLicenseLocked());
  // Restore-purchase and any refresh that observes the unlock before ExtPay's own onPaid does
  // must still light up the paid features. The listener is idempotent (it re-syncs state), so
  // firing here as well as from onPaid is safe.
  if (!before.paid && next.paid && paidListener) await paidListener(next);
  return next;
}

async function refreshLicenseLocked(): Promise<LicenseState> {
  const cached = await loadLicense();
  const startedAt = Date.now();

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
    // A purchase that completed while this request was in flight has already been written with
    // a newer verifiedAt. Never let this response downgrade it — that is the "I paid and it
    // locked itself again" report.
    if (!user.paid) {
      const now = await loadLicense();
      if (now.paid && now.verifiedAt != null && now.verifiedAt >= startedAt) return now;
    }
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

function extPayMisconfiguredError(action: 'checkout' | 'restore'): string {
  if (isUnpackedInstall()) {
    return (
      `ExtensionPay is not configured — cannot open ${action}. ` +
      'Set EXTPAY_EXTENSION_ID_TRACKED (or extpay-config.local.ts), or use Dev unlock for local testing.'
    );
  }
  return (
    `Purchase ${action} is temporarily unavailable. ` +
    'Try again later, or use Restore purchase from Options if you already paid.'
  );
}

export async function openCheckout(): Promise<{ ok: boolean; error?: string }> {
  if (!isExtPayConfigured()) {
    return { ok: false, error: extPayMisconfiguredError('checkout') };
  }
  try {
    await getExtPay().openPaymentPage();
    return { ok: true };
  } catch (e) {
    console.error('[StampStack] openCheckout failed', e);
    const detail = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: `Checkout failed (${detail}). Confirm the ExtensionPay project is linked to the Chrome Web Store item.`,
    };
  }
}

export async function openRestore(): Promise<{ ok: boolean; error?: string }> {
  if (!isExtPayConfigured()) {
    return { ok: false, error: extPayMisconfiguredError('restore') };
  }
  try {
    await getExtPay().openLoginPage();
    return { ok: true };
  } catch (e) {
    console.error('[StampStack] openRestore failed', e);
    const detail = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: `Restore failed (${detail}). Use the email from your ExtensionPay / Stripe receipt.`,
    };
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
