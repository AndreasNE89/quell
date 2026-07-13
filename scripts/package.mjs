// Zip dist/ into release/quell-<version>.zip for Chrome Web Store upload.
//
// Usage:
//   npm run package              # update-lists + store build + zip
//   npm run package -- --skip-lists
//
// The zip root must be the extension files themselves (manifest.json at zip root),
// not a nested dist/ folder.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');
const OUT_DIR = join(ROOT, 'release');
const skipLists = process.argv.includes('--skip-lists');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(p);
  }
  return out;
}

async function zipDist(zipPath) {
  // Prefer system tar (Windows 10+ / macOS / Linux) — creates zip with files at root.
  const relFiles = walk(DIST).map((f) => relative(DIST, f).replace(/\\/g, '/'));
  // Use PowerShell Compress-Archive on Windows if tar zip layout is awkward.
  if (process.platform === 'win32') {
    const ps = `
      if (Test-Path -LiteralPath '${zipPath.replace(/'/g, "''")}') { Remove-Item -LiteralPath '${zipPath.replace(/'/g, "''")}' -Force }
      Compress-Archive -Path '${DIST.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -CompressionLevel Optimal
    `;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('Compress-Archive failed');
    return relFiles.length;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const r = spawnSync('tar', ['-a', '-cf', zipPath, '-C', DIST, '.'], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('tar zip failed');
  return relFiles.length;
}

function validateDist() {
  const manPath = join(DIST, 'manifest.json');
  if (!existsSync(manPath)) {
    console.error('dist/manifest.json missing — build first.');
    process.exit(1);
  }
  const man = JSON.parse(readFileSync(manPath, 'utf8'));
  if (man.manifest_version !== 3) {
    console.error('manifest_version must be 3');
    process.exit(1);
  }
  const rules = man.declarative_net_request?.rule_resources ?? [];
  if (!rules.length) {
    console.error('No DNR rulesets in manifest — run update-lists + compile-filters.');
    process.exit(1);
  }
  for (const req of ['icons/icon-128.png', 'background.js', 'content.js', 'privacy.html']) {
    if (!existsSync(join(DIST, req))) {
      console.error(`Missing required package file: ${req}`);
      process.exit(1);
    }
  }
  // Store packages must not ship unused/dev-only permissions (CWS review risk).
  const forbidden = ['declarativeNetRequestFeedback', 'tabs'].filter((p) =>
    man.permissions?.includes(p),
  );
  if (forbidden.length) {
    console.error(
      `Store package must not include: ${forbidden.join(', ')}. Use npm run build:store / --store.`,
    );
    process.exit(1);
  }
  return { man, rules };
}

console.log('== Quell store package ==');
if (!skipLists) {
  console.log('\n[1/3] Updating filter lists…');
  run('npm', ['run', 'update-lists']);
} else {
  console.log('\n[1/3] Skipping list update (--skip-lists)');
}

console.log('\n[2/3] Store build…');
run('npm', ['run', 'compile-filters']);
run('node', ['scripts/build.mjs', '--store']);

const { man, rules } = validateDist();
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = man.version || pkg.version || '0.0.0';
mkdirSync(OUT_DIR, { recursive: true });
const zipPath = join(OUT_DIR, `quell-${version}.zip`);

console.log('\n[3/3] Zipping…');
const n = await zipDist(zipPath);
const size = statSync(zipPath).size;
console.log(`\n✓ ${zipPath}`);
console.log(`  files≈${n}  size=${(size / 1024 / 1024).toFixed(2)} MiB  version=${version}`);
console.log(`  rulesets=${rules.length}: ${rules.map((r) => r.id).join(', ')}`);
console.log('\nUpload this zip in Chrome Web Store Developer Dashboard → Package.');
console.log('Follow docs/CHROME_WEB_STORE.md for listing fields and review notes.');
