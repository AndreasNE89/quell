// Resolve the ExtensionPay id from source the same way runtime does (extpay-config.ts):
// a non-placeholder local override wins, then the tracked id, then nothing.
//
// Shared by scripts/build.mjs and scripts/smoke-extpay.mjs so the two cannot drift. Both used
// to require a type annotation (`OVERRIDE: string | null = …`), which missed the plain
// `export const EXTPAY_EXTENSION_ID_OVERRIDE = '…';` form the example file itself suggests —
// and a missed override is one the runtime still honours.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const EXTPAY_PLACEHOLDER = 'YOUR_EXTENSIONPAY_ID';

/** Drop block and whole-line comments: the example file documents the override form in one. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Value assigned to `name` in a TS source (annotated or not), or null when it is `null`,
 * empty, the placeholder, or absent.
 */
export function parseExtPayConst(text, name) {
  const re = new RegExp(
    `\\b${name}(?:\\s*:[^=]*)?\\s*=\\s*(?:(['"\`])([^'"\`]*)\\1|null\\b)`,
  );
  const m = stripComments(text).match(re);
  if (!m || m[2] == null) return null;
  const v = m[2];
  return v.length > 0 && v !== EXTPAY_PLACEHOLDER ? v : null;
}

/** Local override value (from the gitignored extpay-config.local.ts), or null. */
export function readExtPayOverride(srcDir) {
  const localPath = join(srcDir, 'shared', 'extpay-config.local.ts');
  if (!existsSync(localPath)) return null;
  return parseExtPayConst(readFileSync(localPath, 'utf8'), 'EXTPAY_EXTENSION_ID_OVERRIDE');
}

/** @returns {{ id: string | null, source: 'local' | 'tracked' | 'none', override: string | null, tracked: string | null }} */
export function resolveExtPayId(srcDir) {
  const override = readExtPayOverride(srcDir);
  const tracked = parseExtPayConst(
    readFileSync(join(srcDir, 'shared', 'extpay-config.ts'), 'utf8'),
    'EXTPAY_EXTENSION_ID_TRACKED',
  );
  if (override) return { id: override, source: 'local', override, tracked };
  if (tracked) return { id: tracked, source: 'tracked', override, tracked };
  return { id: null, source: 'none', override, tracked };
}

/**
 * Why a store build must not proceed with this resolution, or null when it may.
 * A store package ships the TRACKED id only: a developer's local override is a gitignored
 * experiment, and baking it into an upload would sell a slug nobody reviewed.
 */
export function storeExtPayProblem(resolved) {
  if (resolved.override) {
    return (
      `src/shared/extpay-config.local.ts sets EXTPAY_EXTENSION_ID_OVERRIDE = '${resolved.override}'.\n` +
      'Store builds must ship the tracked id (EXTPAY_EXTENSION_ID_TRACKED in extpay-config.ts).\n' +
      'Set the override back to null (or delete the local file) and rebuild.'
    );
  }
  if (!resolved.id) {
    return (
      'ExtensionPay id is not configured. Paid dark mode would be unpurchasable.\n' +
      'Set EXTPAY_EXTENSION_ID_TRACKED in src/shared/extpay-config.ts.'
    );
  }
  return null;
}
