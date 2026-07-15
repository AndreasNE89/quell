/**
 * Optional local ExtPay id override.
 * Copy to `extpay-config.local.ts` (gitignored) and paste your ExtensionPay id:
 *
 *   export const EXTPAY_EXTENSION_ID_OVERRIDE = 'your-extpay-id';
 *
 * Leave null to use the tracked placeholder in `extpay-config.ts`.
 */
export const EXTPAY_EXTENSION_ID_OVERRIDE: string | null = null;
