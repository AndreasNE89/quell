// Zip dist/ into release/stampstack-<version>.zip for Chrome Web Store upload.
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
  writeFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');
const OUT_DIR = join(ROOT, 'release');
const skipLists = process.argv.includes('--skip-lists');
// A healthy build compiles ~120k rules; the built-in seed alone is ~100. Anything in between
// means the downloadable lists did not make it into this build.
const MIN_PACKAGED_RULES = 50_000;

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

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Write the store zip directly instead of shelling out to an archiver.
 *
 * Two archivers have already produced something Chrome would reject: PowerShell's
 * Compress-Archive writes nested entry names with BACKSLASHES (the ZIP spec, APPNOTE
 * 4.4.17.1, requires forward slashes), and GNU tar - which is what `tar` resolves to under
 * Git Bash - silently writes a plain TAR when handed a `.zip` name, because it has no zip
 * writer at all. Emitting the container ourselves removes the dependency, guarantees POSIX
 * separators, and pins timestamps so the same dist/ always yields the same bytes.
 */
async function zipDist(zipPath) {
  const files = walk(DIST)
    .map((f) => relative(DIST, f).split(sep).join('/'))
    .sort();
  mkdirSync(OUT_DIR, { recursive: true });
  if (existsSync(zipPath)) rmSync(zipPath);

  // Fixed 1980-01-01 DOS timestamp: build output should not differ run to run.
  const DOS_TIME = 0;
  const DOS_DATE = 0x0021;

  const chunks = [];
  const central = [];
  let offset = 0;

  for (const name of files) {
    const raw = readFileSync(join(DIST, name));
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const nameBuf = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  writeFileSync(zipPath, Buffer.concat([...chunks, cdBuf, eocd]));
  assertReadableZip(zipPath, files.length);
  return files.length;
}

/**
 * Read the archive back and prove it is a ZIP containing exactly what we wrote.
 *
 * Checking only for "no backslash entry names" is not enough: a non-ZIP file has no central
 * directory records at all, so it passes that test trivially. Assert the count as well.
 */
function assertReadableZip(zipPath, expected) {
  const buf = readFileSync(zipPath);
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) {
    console.error(`${zipPath} is not a ZIP archive (bad local file header signature).`);
    process.exit(1);
  }
  const names = [];
  for (let i = 0; i + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x02014b50) continue;
    const nameLen = buf.readUInt16LE(i + 28);
    names.push(buf.toString('utf8', i + 46, i + 46 + nameLen));
  }
  if (names.length !== expected) {
    console.error(`Zip central directory has ${names.length} entries, expected ${expected}.`);
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
  if (/DEV_BUILD\s*=\s*(?:true|!0)\b/.test(background)) {
    console.error(
      'dist/background.js is a DEV build (Dev unlock reachable). Run npm run build:store before packaging.',
    );
    process.exit(1);
  }

  // Guard against shipping a seed-only package: `--skip-lists` on a machine whose filters/
  // downloads are missing compiles cleanly, just with almost nothing in it.
  const ruleTotal = rules.reduce((n, r) => {
    const p = join(DIST, r.path);
    if (!existsSync(p)) return n;
    try {
      return n + JSON.parse(readFileSync(p, 'utf8')).length;
    } catch {
      return n;
    }
  }, 0);
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

console.log('== StampStack store package ==');
if (!skipLists) {
  console.log('\n[1/4] Updating filter lists…');
  run('npm', ['run', 'update-lists']);
} else {
  console.log('\n[1/4] Skipping list update (--skip-lists)');
}

console.log('\n[2/4] Store build…');
run('npm', ['run', 'compile-filters']);
run('node', ['scripts/build.mjs', '--store']);

const { man, rules } = validateDist();

console.log('\n[3/4] Obfuscation scan…');
run('node', ['scripts/scan-package-obfuscation.mjs']);

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = man.version || pkg.version || '0.0.0';
mkdirSync(OUT_DIR, { recursive: true });
const zipPath = join(OUT_DIR, `stampstack-${version}.zip`);

console.log('\n[4/4] Zipping…');
const n = await zipDist(zipPath);
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
  // The node version matters: the zip is deflate-compressed, and a zlib patch in a Node
  // update changes the compressed bytes while the content stays identical. Two "different"
  // hashes from identical trees cost half a day before that was understood — print the
  // toolchain next to the hash so the next drift explains itself.
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
      console.log('    (Identical source can hash differently across Node updates — the zip is');
      console.log('    deflate-compressed, and zlib patches change the bytes, not the content.)');
    }
  }
}

console.log('\nUpload this zip in Chrome Web Store Developer Dashboard → Package.');
console.log('Release checklist: docs/RELEASE_CHECKLIST.md');
console.log('Follow docs/CHROME_WEB_STORE.md for listing fields and review notes.');
