/**
 * ExtensionPay extension id — register at https://extensionpay.com and link to the
 * Chrome Web Store item below. Plan: $2 USD one-time (no trial).
 *
 * Setup:
 * 1. Create an ExtensionPay account and register StampStack
 * 2. Link ExtensionPay → CWS item id `CWS_ITEM_ID`
 * 3. Confirm the $2 one-time plan
 * 4. Keep `EXTPAY_EXTENSION_ID_TRACKED` in sync with the ExtensionPay dashboard slug
 * 5. Optional: override via `extpay-config.local.ts` (gitignored) for experiments
 * 6. Rebuild (`npm run bundle` / `npm run build:store`) and reload
 *
 * Until configured (placeholder only), checkout/restore no-op; unpacked builds can use
 * license:devUnlock. Store builds refuse to package while the resolved id is a placeholder
 * (see scripts/build.mjs).
 */
import { EXTPAY_EXTENSION_ID_OVERRIDE } from './extpay-config.local.js';

/** Chrome Web Store item id (dashboard / listing). Not the ExtensionPay slug. */
export const CWS_ITEM_ID = 'hfioggmggaefiiaehnfoiaajcdodnkkd';

/**
 * Production ExtensionPay slug linked to {@link CWS_ITEM_ID}.
 * ExtensionPay ids are developer-chosen and may end with `-`.
 * Typed as `string` so a temporary placeholder still typechecks during setup.
 */
export const EXTPAY_EXTENSION_ID_TRACKED: string = 'stampstack-';

const PLACEHOLDER = 'YOUR_EXTENSIONPAY_ID';

const fromLocal =
  typeof EXTPAY_EXTENSION_ID_OVERRIDE === 'string' &&
  EXTPAY_EXTENSION_ID_OVERRIDE.length > 0 &&
  EXTPAY_EXTENSION_ID_OVERRIDE !== PLACEHOLDER
    ? EXTPAY_EXTENSION_ID_OVERRIDE
    : null;

const fromTracked =
  EXTPAY_EXTENSION_ID_TRACKED.length > 0 && EXTPAY_EXTENSION_ID_TRACKED !== PLACEHOLDER
    ? EXTPAY_EXTENSION_ID_TRACKED
    : null;

/** Resolved ExtensionPay id (local override wins when set). */
export const EXTPAY_EXTENSION_ID: string = fromLocal ?? fromTracked ?? PLACEHOLDER;

/** True when a real ExtensionPay id has been set (tracked or local). */
export function isExtPayConfigured(): boolean {
  return (
    typeof EXTPAY_EXTENSION_ID === 'string' &&
    EXTPAY_EXTENSION_ID.length > 0 &&
    EXTPAY_EXTENSION_ID !== PLACEHOLDER
  );
}
