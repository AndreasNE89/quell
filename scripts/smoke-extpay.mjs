/**
 * Week-1 ExtPay launch gate (automated portion).
 *
 * Verifies:
 * 1. The tracked ExtensionPay id is not a placeholder (a local override is dev-only)
 * 2. The store bundles carry exactly the tracked id — never the local override
 * 3. Dev unlock is unreachable in the store background.js (constant-false gate)
 * 4. Obfuscation scan on dist/
 *
 * Manual follow-up (published CWS build): Buy → paid → dark toggle; Restore after
 * clear storage. See docs/RELEASE_CHECKLIST.md.
 *
 *   npm run smoke-extpay
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  devUnlockReachableProblems,
  readExtPayIds,
  storeBundleExtPayProblems,
} from './lib/store-gates.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function fail(lines) {
  for (const l of [].concat(lines)) console.error(`✗ ${l}`);
  process.exit(1);
}

const ids = await readExtPayIds(ROOT);
if (!ids.tracked) fail('Tracked ExtensionPay id is a placeholder — cannot smoke checkout wiring.');
console.log(`✓ Tracked ExtensionPay id: ${ids.tracked}`);
if (ids.override && ids.override !== ids.tracked) {
  console.log(`  (local override "${ids.override}" is dev-only; the store build must not carry it)`);
}

const tracked = readFileSync(join(SRC, 'shared', 'extpay-config.ts'), 'utf8');
if (!tracked.includes('hfioggmggaefiiaehnfoiaajcdodnkkd')) {
  fail('CWS_ITEM_ID missing from extpay-config.ts');
}
console.log('✓ CWS item id documented (hfioggmggaefiiaehnfoiaajcdodnkkd)');

console.log('\nBuilding store package for gate checks…');
if (!existsSync(join(SRC, 'generated', 'meta.json'))) {
  run('npm', ['run', 'compile-filters']);
}
run('node', ['scripts/build.mjs', '--store']);
run('node', ['scripts/scan-package-obfuscation.mjs']);

const bg = readFileSync(join(DIST, 'background.js'), 'utf8');
const bridge = readFileSync(join(DIST, 'extpay-bridge.js'), 'utf8');

// Store define must bake DEV_BUILD false; esbuild may inline as !1 / false.
if (/\b__STAMPSTACK_DEV__\b/.test(bg)) {
  fail('background.js still references __STAMPSTACK_DEV__ (define failed)');
}

const idProblems = storeBundleExtPayProblems(
  [
    ['background.js', bg],
    ['extpay-bridge.js', bridge],
  ],
  ids,
);
if (idProblems.length) fail(idProblems);
console.log(`✓ Store bundles carry the tracked ExtensionPay id "${ids.tracked}" and no override`);

const devProblems = devUnlockReachableProblems(bg);
if (devProblems.length) fail(devProblems);
console.log('✓ Store background.js: Dev unlock gate compiles to constant false');

const popupHtml = readFileSync(join(DIST, 'popup.html'), 'utf8');
const optionsHtml = readFileSync(join(DIST, 'options.html'), 'utf8');
if (!popupHtml.includes('darkDevUnlockBtn') || !optionsHtml.includes('darkDevUnlock')) {
  fail('Dev unlock controls missing from HTML (hidden-by-JS expected)');
}
// The controls ship in both builds; the popup/options show them only when license.unpacked,
// which the worker answers from the gate verified above.
console.log('✓ Dev unlock UI present but driven by license.unpacked (the gate above)');

// Restore a normal [dev] dist so local unpacked QA (Dev unlock) still works after smoke.
// Without this, smoke leaves DEV_BUILD=false in dist/ and Dev unlock appears broken.
console.log('\nRestoring non-store dist for local unpacked QA…');
run('node', ['scripts/build.mjs']);

console.log('\n✓ ExtPay smoke (automated) passed.');
console.log('Manual (published CWS): Buy → unlock → restart Chrome; Restore after clear storage.');
console.log('Note: dist/ is a [dev] build again — Dev unlock works when loaded unpacked.');
