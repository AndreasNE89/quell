// Zip dist/ into release/stampstack-<version>.zip for Chrome Web Store upload.
//
// Usage:
//   npm run package              # update-lists + lock check + store build + zip
//   npm run package -- --skip-lists
//
// The zip root must be the extension files themselves (manifest.json at zip root),
// not a nested dist/ folder.

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { listFloorProblems, rulesetProblems } from './lib/package-checks.mjs';
import { devUnlockReachableProblems, readExtPayIds, storeBundleExtPayProblems } from './lib/store-gates.mjs';
import { readZipEntries, zipDirectory } from './lib/zip.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');
const OUT_DIR = join(ROOT, 'release');
const skipLists = process.argv.includes('--skip-lists');
// A healthy build compiles ~120k rules; the built-in seed alone is ~100. Anything in between
// means the downloadable lists did not make it into this build. Per-list floors (`minRules` in
// filters/lists.json) catch the case this total cannot: one large list missing or truncated.
const MIN_PACKAGED_RULES = 50_000;

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: cmd === 'npm' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

/** Write the zip, then read it back the way an unzipper would and prove it holds what we wrote. */
function zipDist(zipPath) {
  mkdirSync(OUT_DIR, { recursive: true });
  if (existsSync(zipPath)) rmSync(zipPath);
  const { bytes, names } = zipDirectory(DIST);
  writeFileSync(zipPath, bytes);
  assertReadableZip(zipPath, names);
  return names.length;
}

/**
 * Checking only for "no backslash entry names" is not enough: a non-ZIP file has no central
 * directory records at all, so it passes that test trivially. Assert the entries as well.
 */
function assertReadableZip(zipPath, expected) {
  let entries;
  try {
    entries = readZipEntries(readFileSync(zipPath));
  } catch (e) {
    console.error(`${zipPath} is not a readable ZIP archive: ${e.message}`);
    process.exit(1);
  }
  const names = entries.map((e) => e.name);
  if (names.length !== expected.length || names.some((n, i) => n !== expected[i])) {
    console.error(`Zip central directory has ${names.length} entries, expected ${expected.length}.`);
    process.exit(1);
  }
  const bad = names.filter((n) => n.includes(String.fromCharCode(92)));
  if (bad.length) {
    console.error(`Zip has non-POSIX entry names: ${bad.slice(0, 5).join(', ')}`);
    process.exit(1);
  }
  if (!names.includes('manifest.json')) {
    console.error('Zip has no manifest.json at its root - Chrome will reject it.');
    process.exit(1);
  }
}

async function validateDist() {
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
  for (const req of [
    'icons/icon-128.png',
    'background.js',
    'content.js',
    // Without it ExtensionPay's checkout page cannot tell the worker a purchase went through.
    'extpay-bridge.js',
    'privacy.html',
    // The worker fetches cosmetic data at run time; without it nothing is hidden (B35).
    'generated/cosmetic/core.json',
    // Attribution and the licence texts the bundled lists and packages require (M17).
    'attributions.html',
    'licenses/THIRD_PARTY_NOTICES.txt',
    'licenses/GPL-3.0.txt',
    'licenses/LGPL-3.0.txt',
    'licenses/MPL-2.0.txt',
  ]) {
    if (!existsSync(join(DIST, req))) {
      console.error(`Missing required package file: ${req}`);
      process.exit(1);
    }
  }
  // Store packages must not ship unused/dev-only permissions (CWS review risk).
  const forbidden = ['declarativeNetRequestFeedback', 'tabs', 'webNavigation'].filter((p) =>
    man.permissions?.includes(p),
  );
  if (forbidden.length) {
    console.error(
      `Store package must not include: ${forbidden.join(', ')}. Use npm run build:store / --store.`,
    );
    process.exit(1);
  }

  // A dev bundle is byte-identical to a store bundle in every check above, but it carries the
  // Dev-unlock path that hands out the paid feature for free. `npm run smoke-extpay` restores
  // a [dev] dist as its last act, so "whatever is in dist/" is genuinely often a dev build.
  const background = readFileSync(join(DIST, 'background.js'), 'utf8');
  const devProblems = devUnlockReachableProblems(background);
  if (devProblems.length) {
    console.error(
      `dist/background.js is not a store build (${devProblems.join('; ')}). ` +
        'Run npm run build:store before packaging.',
    );
    process.exit(1);
  }

  // The ExtensionPay id is where the money goes: a local override in a store zip bills buyers
  // against a project that is not linked to this CWS item.
  const idProblems = storeBundleExtPayProblems(
    ['background.js', 'extpay-bridge.js'].map((f) => [f, readFileSync(join(DIST, f), 'utf8')]),
    await readExtPayIds(ROOT),
  );
  if (idProblems.length) {
    console.error(`ExtensionPay id check failed: ${idProblems.join('; ')}.`);
    process.exit(1);
  }

  const countRules = (path) => {
    try {
      return JSON.parse(readFileSync(join(DIST, path), 'utf8')).length;
    } catch {
      return null;
    }
  };
  // Every registry list must be in the package at its floor, and Chrome's ruleset limits hold.
  const registry = JSON.parse(readFileSync(join(ROOT, 'filters', 'lists.json'), 'utf8'));
  const problems = [...rulesetProblems(rules), ...listFloorProblems(registry, rules, countRules)];
  if (problems.length) {
    console.error(`The package's rulesets are incomplete:\n  ${problems.join('\n  ')}`);
    console.error('Run npm run update-lists (or fix filters/) and rebuild.');
    process.exit(1);
  }

  // Guard against shipping a seed-only package: `--skip-lists` on a machine whose filters/
  // downloads are missing compiles cleanly, just with almost nothing in it.
  const ruleTotal = rules.reduce((n, r) => n + (countRules(r.path) ?? 0), 0);
  if (ruleTotal < MIN_PACKAGED_RULES) {
    console.error(
      `Only ${ruleTotal} DNR rules in dist/ (expected at least ${MIN_PACKAGED_RULES}). ` +
        'The filter lists are missing or stale — run npm run update-lists and rebuild.',
    );
    process.exit(1);
  }
  console.log(`  validated: ${rules.length} rulesets, ${ruleTotal} DNR rules, store build`);
  return { man, rules };
}

// ALLOW_UNCONFIGURED_EXTPAY=1 is a local-testing escape hatch for build.mjs --store. It is
// inherited by the build this script spawns, so without this check a variable left exported from
// an earlier test session would package an upload with paid dark mode unpurchasable. Checked
// first, before the list refresh and the build it would otherwise sit through.
if (process.env.ALLOW_UNCONFIGURED_EXTPAY) {
  console.error(
    'ALLOW_UNCONFIGURED_EXTPAY is set. A store package must never be built unconfigured — ' +
      'unset it (e.g. `unset ALLOW_UNCONFIGURED_EXTPAY`) and re-run npm run package.',
  );
  process.exit(1);
}

console.log('== StampStack store package ==');
if (!skipLists) {
  console.log('\n[1/5] Updating filter lists…');
  // Directly, not through `npm run update-lists`: it checks every download, writes all or
  // nothing, and stamps the lock itself.
  run(process.execPath, [join('scripts', 'update-lists.mjs')]);
} else {
  console.log('\n[1/5] Skipping list update (--skip-lists)');
}

// The lists compiled next must be the ones the lock records. A refresh that failed part way,
// or a list edited by hand, is caught here instead of shipping unrecorded bytes.
console.log('\n[2/5] Checking filters/ against lists.lock.json…');
run(process.execPath, [join('scripts', 'lock-lists.mjs'), '--check']);
{
  const git = spawnSync('git', ['status', '--porcelain', '--', 'filters'], { cwd: ROOT, encoding: 'utf8' });
  if (git.status === 0 && git.stdout.trim()) {
    console.log('  ⚠ filters/ has uncommitted changes, so this zip matches no commit:');
    console.log(git.stdout.replace(/^/gm, '      ').trimEnd());
    console.log('    Commit them (and tag) before submitting, then package again from the tag.');
  }
}

console.log('\n[3/5] Store build…');
run('npm', ['run', 'compile-filters']);
run(process.execPath, [join('scripts', 'build.mjs'), '--store']);

const { man, rules } = await validateDist();

console.log('\n[4/5] Obfuscation scan…');
run(process.execPath, [join('scripts', 'scan-package-obfuscation.mjs')]);

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = man.version || pkg.version || '0.0.0';
const zipPath = join(OUT_DIR, `stampstack-${version}.zip`);

console.log('\n[5/5] Zipping…');
const n = zipDist(zipPath);
const size = statSync(zipPath).size;
console.log(`\n✓ ${zipPath}`);
console.log(`  files≈${n}  size=${(size / 1024 / 1024).toFixed(2)} MiB  version=${version}`);
console.log(`  rulesets=${rules.length}: ${rules.map((r) => r.id).join(', ')}`);

// The submission doc quotes this zip's sha256 so a reviewer can be told the artifact is
// reproducible. Any source change since the doc was written silently invalidates that number,
// and nothing else notices — a merged follow-up PR left the shipped 2.1.0 doc pointing at a
// zip built before the fixes it described. Warn rather than fail: the doc legitimately lags
// while a release is still being assembled.
{
  const digest = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
  // Every text file is normalized to LF on the way into dist/, so the same commit gives the same
  // zip on Windows and Linux. Through 2.3.0 the locales were copied raw and carried the
  // checkout's CRLF: that, not a Node or zlib update, is why CI printed a different hash for the
  // same commit. The Node version stays in the log because deflate output is only pinned for a
  // given zlib.
  console.log(`  sha256=${digest} (node ${process.version})`);
  const docPath = join(ROOT, 'store', `SUBMIT-${version}.md`);
  if (existsSync(docPath)) {
    const doc = readFileSync(docPath, 'utf8');
    const quoted = doc.match(/\b[0-9a-f]{64}\b/)?.[0];
    if (!quoted) {
      console.log(`\n  note: store/SUBMIT-${version}.md quotes no sha256.`);
    } else if (quoted !== digest) {
      console.log(`\n  ⚠ store/SUBMIT-${version}.md is stale — it quotes a different build:`);
      console.log(`      doc: ${quoted}`);
      console.log(`      zip: ${digest}`);
      console.log('    Update it before submitting, or a reviewer is given a hash that does not verify.');
      console.log('    The tree differs from the one the doc describes. (A doc for 2.3.0 or earlier');
      console.log('    was hashed with CRLF locales from a Windows checkout; rebuild from its tag to compare.)');
    }
  }
}

console.log('\nUpload this zip in Chrome Web Store Developer Dashboard → Package.');
console.log('Release checklist: docs/RELEASE_CHECKLIST.md');
console.log('Follow docs/CHROME_WEB_STORE.md for listing fields and review notes.');
