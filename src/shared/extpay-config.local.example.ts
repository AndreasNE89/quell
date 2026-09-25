/**
 * Optional local ExtPay id override.
 * Copy to `extpay-config.local.ts` (gitignored) only if you need a different slug
 * than `EXTPAY_EXTENSION_ID_TRACKED` in `extpay-config.ts`.
 *
 *   export const EXTPAY_EXTENSION_ID_OVERRIDE = 'your-extpay-id';
 *
 * Dev builds only: `npm run build:store` ignores this file and always ships the tracked id.
 * Leave null to use the tracked production id.
 */
export const EXTPAY_EXTENSION_ID_OVERRIDE: string | null = null;
