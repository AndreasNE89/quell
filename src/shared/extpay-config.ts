/**
 * ExtensionPay extension id — replace after registering at https://extensionpay.com
 *
 * Setup (pick one):
 * 1. Create an ExtensionPay account and register StampStack
 * 2. Set a one-time plan to $2 USD (no trial for MVP)
 * 3a. Paste the ExtensionPay extension id below (not the Chrome Web Store id), OR
 * 3b. Copy `extpay-config.local.example.ts` → `extpay-config.local.ts` (gitignored)
 *     and set `EXTPAY_EXTENSION_ID_OVERRIDE` there
 * 4. Rebuild (`npm run bundle`) and reload the unpacked extension
 *
 * Until configured, checkout/restore no-op; unpacked builds can use license:devUnlock.
 */
import { EXTPAY_EXTENSION_ID_OVERRIDE } from './extpay-config.local.js';

const PLACEHOLDER = 'YOUR_EXTENSIONPAY_ID';

const fromLocal =
  typeof EXTPAY_EXTENSION_ID_OVERRIDE === 'string' &&
  EXTPAY_EXTENSION_ID_OVERRIDE.length > 0 &&
  EXTPAY_EXTENSION_ID_OVERRIDE !== PLACEHOLDER
    ? EXTPAY_EXTENSION_ID_OVERRIDE
    : null;

/** Resolved ExtensionPay id (local override wins when set). */
export const EXTPAY_EXTENSION_ID = fromLocal ?? PLACEHOLDER;

/** True when a real ExtensionPay id has been pasted in (tracked or local). */
export function isExtPayConfigured(): boolean {
  return (
    typeof EXTPAY_EXTENSION_ID === 'string' &&
    EXTPAY_EXTENSION_ID.length > 0 &&
    EXTPAY_EXTENSION_ID !== PLACEHOLDER
  );
}
