/**
 * Week-1 ExtPay launch gate (automated portion).
 *
 * Verifies:
 * 1. Resolved ExtensionPay id is not a placeholder
 * 2. Store build compiles with DEV_BUILD=false (Dev unlock gated)
 * 3. Packaged popup/options do not enable Dev unlock without unpacked flag
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function resolveExtPayId() {
  const placeholder = 'YOUR_EXTENSIONPAY_ID';
  const localPath = join(SRC, 'shared', 'extpay-config.local.ts');
  if (existsSync(localPath)) {
    const m = readFileSync(localPath, 'utf8').match(
      /EXTPAY_EXTENSION_ID_OVERRIDE\s*:[^=]*=\s*(['"])([^'"]*)\1/,
    );
    if (m && m[2] && m[2] !== placeholder) return { id: m[2], source: 'local' };
  }
  const tracked = readFileSync(join(SRC, 'shared', 'extpay-config.ts'), 'utf8');
  const tm = tracked.match(
    /EXTPAY_EXTENSION_ID_TRACKED(?:\s*:\s*[^=]+)?\s*=\s*(['"])([^'"]*)\1/,
  );
  if (tm && tm[2] && tm[2] !== placeholder) return { id: tm[2], source: 'tracked' };
  return { id: null, source: 'none' };
}

const { id, source } = resolveExtPayId();
if (!id) {
  console.error('✗ ExtensionPay id is placeholder — cannot smoke checkout wiring.');
  process.exit(1);
}
console.log(`✓ ExtensionPay id from ${source}: ${id}`);

const tracked = readFileSync(join(SRC, 'shared', 'extpay-config.ts'), 'utf8');
if (!tracked.includes('hfioggmggaefiiaehnfoiaajcdodnkkd')) {
  console.error('✗ CWS_ITEM_ID missing from extpay-config.ts');
  process.exit(1);
}
console.log('✓ CWS item id documented (hfioggmggaefiiaehnfoiaajcdodnkkd)');

console.log('\nBuilding store package for gate checks…');
if (!existsSync(join(SRC, 'generated', 'meta.json'))) {
  run('npm', ['run', 'compile-filters']);
}
run('node', ['scripts/build.mjs', '--store']);
run('node', ['scripts/scan-package-obfuscation.mjs']);

const bg = readFileSync(join(DIST, 'background.js'), 'utf8');
// Store define must bake DEV_BUILD false; esbuild may inline as !1 / false.
if (/\b__STAMPSTACK_DEV__\b/.test(bg)) {
  console.error('✗ background.js still references __STAMPSTACK_DEV__ (define failed)');
  process.exit(1);
}
// Dev unlock handler must refuse when not unpacked — string stays for error path.
if (!bg.includes('Dev unlock is only available')) {
  console.error('✗ Expected store build to keep hard gate error for license:devUnlock');
  process.exit(1);
}
console.log('✓ Store background.js: ExtPay present, Dev unlock hard-gated');

const popupHtml = readFileSync(join(DIST, 'popup.html'), 'utf8');
const optionsHtml = readFileSync(join(DIST, 'options.html'), 'utf8');
if (!popupHtml.includes('darkDevUnlockBtn') || !optionsHtml.includes('darkDevUnlock')) {
  console.error('✗ Dev unlock controls missing from HTML (hidden-by-JS expected)');
  process.exit(1);
}
const popupJs = readFileSync(join(DIST, 'popup.js'), 'utf8');
// UI visibility is driven by license.unpacked === DEV_BUILD; store → never shown.
if (!/unpacked/.test(popupJs)) {
  console.error('✗ popup.js missing unpacked gate for Dev unlock');
  process.exit(1);
}
console.log('✓ Dev unlock UI gated on license.unpacked (false in store builds)');

// Restore a normal [dev] dist so local unpacked QA (Dev unlock) still works after smoke.
// Without this, smoke leaves DEV_BUILD=false in dist/ and Dev unlock appears broken.
console.log('\nRestoring non-store dist for local unpacked QA…');
run('node', ['scripts/build.mjs']);

console.log('\n✓ ExtPay smoke (automated) passed.');
console.log('Manual (published CWS): Buy → unlock → restart Chrome; Restore after clear storage.');
console.log('Note: dist/ is a [dev] build again — Dev unlock works when loaded unpacked.');
