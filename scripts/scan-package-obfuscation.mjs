/**
 * Fail a store package if dist/ still contains CWS “obfuscated code” needles
 * that previously caused Red Titanium rejection: `atob(` / `btoa(` in shipped JS,
 * and long base64 blobs in the service worker / scriptlet bundles (uBO scriptlet args).
 *
 * DNR ruleset JSON is excluded from the long-base64 check — filter patterns often
 * contain long alphanumeric runs that are not obfuscated payloads.
 *
 *   node scripts/scan-package-obfuscation.mjs
 *   node scripts/scan-package-obfuscation.mjs --dir dist
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const dirFlag = process.argv.indexOf('--dir');
const DIST = join(ROOT, dirFlag >= 0 ? process.argv[dirFlag + 1] || 'dist' : 'dist');

const ATOB_LIKE = /\b(?:window\.)?atob\s*\(|\bbtoa\s*\(/;
const LONG_BASE64 = /[A-Za-z0-9+/]{80,}={0,2}/;

/** Bundles where scriptlet args / ExtPay payloads must not look obfuscated. */
const LONG_BASE64_TARGETS = new Set([
  'background.js',
  'scriptlets.js',
  'scriptlets-youtube.js',
  'content.js',
  'extpay-bridge.js',
]);

function walkJs(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkJs(p, out);
    else if (/\.js$/i.test(name)) out.push(p);
  }
  return out;
}

if (!existsSync(join(DIST, 'manifest.json'))) {
  console.error(`Missing ${DIST}/manifest.json — build first.`);
  process.exit(1);
}

const hits = [];
for (const file of walkJs(DIST)) {
  const text = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (ATOB_LIKE.test(text)) {
    hits.push(`${rel} (atob/btoa)`);
    continue;
  }
  if (LONG_BASE64_TARGETS.has(basename(file)) && LONG_BASE64.test(text)) {
    hits.push(`${rel} (long base64)`);
  }
}

if (hits.length) {
  console.error('\n✗ Obfuscation scan failed — CWS may reject this package:\n');
  for (const h of hits) console.error(`  - ${h}`);
  console.error('\nEnsure compile-filters drops scriptlet-obfuscated rules (scriptlet-safe.mjs).');
  process.exit(1);
}

console.log(`✓ Obfuscation scan clean (${DIST})`);
