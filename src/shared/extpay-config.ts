/**
 * ExtensionPay extension id — register at https://extensionpay.com and link to the
 * Chrome Web Store item below. Plan: $2 USD one-time (no trial).
 *
 * Setup:
 * 1. Create an ExtensionPay account and register StampStack
 * 2. Link ExtensionPay → CWS item id `CWS_ITEM_ID`
 * 3. Confirm the $2 one-time plan
 * 4. Keep `EXTPAY_EXTENSION_ID_TRACKED` in sync with the ExtensionPay dashboard slug
 * 5. Optional: override via `extpay-config.local.ts` (gitignored) for experiments —
 *    dev builds only; a `--store` build always uses the tracked id
 * 6. Rebuild (`npm run bundle` / `npm run build:store`) and reload
 *
 * Until configured (placeholder only), checkout/restore no-op; unpacked builds can use
 * license:devUnlock. Store builds refuse to package while the tracked id is a placeholder
 * (see scripts/build.mjs).
 */
import { EXTPAY_EXTENSION_ID_OVERRIDE } from './extpay-config.local.js';
import { DEV_BUILD } from './build-flags.js';

/** Chrome Web Store item id (dashboard / listing). Not the ExtensionPay slug. */
export const CWS_ITEM_ID = 'hfioggmggaefiiaehnfoiaajcdodnkkd';

/**
 * Production ExtensionPay slug linked to {@link CWS_ITEM_ID}.
 * ExtensionPay ids are developer-chosen and may end with `-`.
 * Typed as `string` so a temporary placeholder still typechecks during setup.
 */
export const EXTPAY_EXTENSION_ID_TRACKED: string = 'stampstack-';

const PLACEHOLDER: string = 'YOUR_EXTENSIONPAY_ID';

// `unknown` so both spellings of the local file typecheck: the example's un-annotated
// `= 'slug'` (a literal type) and `: string | null = null`.
const override: unknown = EXTPAY_EXTENSION_ID_OVERRIDE;

// The override is a dev-build affordance. A store build carrying a stray local slug would bill
// buyers against a project that is not linked to the CWS item, so it is gated on the compile-time
// flag (false for `--store`, where the whole branch folds away) — and scripts/build.mjs
// additionally stubs the local module out of store bundles so the literal cannot ship at all.
const fromLocal =
  DEV_BUILD && typeof override === 'string' && override.length > 0 && override !== PLACEHOLDER
    ? override
    : null;

const fromTracked =
  EXTPAY_EXTENSION_ID_TRACKED.length > 0 && EXTPAY_EXTENSION_ID_TRACKED !== PLACEHOLDER
    ? EXTPAY_EXTENSION_ID_TRACKED
    : null;

/** Resolved ExtensionPay id (local override wins in dev builds only). */
export const EXTPAY_EXTENSION_ID: string = fromLocal ?? fromTracked ?? PLACEHOLDER;

/** True when a real ExtensionPay id has been set (tracked or local). */
export function isExtPayConfigured(): boolean {
  return (
    typeof EXTPAY_EXTENSION_ID === 'string' &&
    EXTPAY_EXTENSION_ID.length > 0 &&
    EXTPAY_EXTENSION_ID !== PLACEHOLDER
  );
}
