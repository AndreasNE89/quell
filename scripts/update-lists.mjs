// Fetch the upstream filter lists declared in filters/lists.json (those with a `url`), check
// each download, and replace the committed copies only when every one of them passed. Then
// re-stamp filters/lists.lock.json. After running this, run `npm run build` and reload the
// extension.
//
//   node scripts/update-lists.mjs                   # every list with a url
//   node scripts/update-lists.mjs easylist-china    # only the named lists
//   node scripts/update-lists.mjs --allow-shrink    # accept a list that lost over half its size
//
// What a download must pass is in scripts/lib/list-update.mjs.

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { get as httpsGet } from 'node:https';
import { get as httpGet } from 'node:http';

import { readLock, registryProblems } from './lib/list-lock.mjs';
import {
  assertFetchable,
  commitLists,
  notAFilterList,
  parseUpdateArgs,
  redirectTarget,
  shrunkTooFar,
} from './lib/list-update.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILTERS = join(ROOT, 'filters');
const registry = JSON.parse(readFileSync(join(FILTERS, 'lists.json'), 'utf8'));
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || '0';
const MAX_REDIRECTS = 8;
const ATTEMPTS = 3;

/** TLS-trust failures (usually a corporate proxy / VPN / AV intercepting HTTPS). */
function isCertError(e) {
  const s = `${e?.code ?? ''} ${e?.message ?? ''}`;
  return /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|first certificate/i.test(s);
}

/**
 * node:https/http download — avoids flaky undici assert(!this.paused) on some TLS paths.
 * Resolves to the raw bytes (written as received, so the lock hashes what upstream served) and
 * the declared content type.
 */
function downloadOnce(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = assertFetchable(url);
    } catch (e) {
      reject(e);
      return;
    }
    const getter = target.protocol === 'http:' ? httpGet : httpsGet;
    const req = getter(
      url,
      {
        headers: { 'User-Agent': `stampstack-adblock/${VERSION}` },
        timeout: 120_000,
      },
      (res) => {
        const code = res.statusCode ?? 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          if (redirects >= MAX_REDIRECTS) {
            reject(new Error('too many redirects'));
            return;
          }
          try {
            resolve(downloadOnce(redirectTarget(url, res.headers.location), redirects + 1));
          } catch (e) {
            reject(e);
          }
          return;
        }
        if (code !== 200) {
          res.resume();
          reject(new Error(`HTTP ${code}`));
          return;
        }
        const chunks = [];
        let received = 0;
        res.on('data', (c) => {
          chunks.push(c);
          received += c.length;
        });
        res.on('aborted', () => reject(new Error('connection closed before the response finished')));
        res.on('error', reject);
        res.on('end', () => {
          if (!res.complete) {
            reject(new Error('connection closed before the response finished'));
            return;
          }
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > 0 && declared !== received) {
            reject(new Error(`truncated: received ${received} of ${declared} bytes`));
            return;
          }
          resolve({ bytes: Buffer.concat(chunks), contentType: String(res.headers['content-type'] ?? '') });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

async function download(url) {
  let last;
  for (let i = 1; i <= ATTEMPTS; i++) {
    try {
      return await downloadOnce(url);
    } catch (e) {
      last = e;
      // Retrying cannot turn a refused URL into an acceptable one.
      if (/refus/.test(e?.message ?? '')) break;
      if (i < ATTEMPTS) await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
  throw last;
}

const invalid = registryProblems(registry);
if (invalid.length) {
  console.error(['filters/lists.json is invalid:', ...invalid].join('\n  '));
  process.exit(1);
}

const { ids, allowShrink, unknown, badFlags } = parseUpdateArgs(process.argv.slice(2), registry);
if (unknown.length || badFlags.length) {
  if (unknown.length) console.error(`Unknown list id(s): ${unknown.join(', ')}`);
  if (badFlags.length) console.error(`Unknown option(s): ${badFlags.join(', ')} (only --allow-shrink)`);
  console.error(`Lists with a url: ${registry.lists.filter((l) => l.url).map((l) => l.id).join(', ')}`);
  process.exit(1);
}
for (const id of ids) {
  if (!registry.lists.find((l) => l.id === id)?.url) console.warn(`  (${id} ships in-repo; nothing to download)`);
}
const selected = registry.lists.filter((l) => l.url && (!ids.length || ids.includes(l.id)));

// The shrink guard compares against what the lock pinned. Without a readable lock there is
// nothing to compare with, which is worth saying rather than silently skipping the check.
let lock = null;
try {
  lock = readLock(FILTERS);
} catch (e) {
  if (e?.code !== 'LOCK_CORRUPT') throw e;
  console.warn('filters/lists.lock.json is unreadable, so the shrink check is off for this run.');
}

const staged = [];
const failed = [];
let sawCertError = false;
for (const list of selected) {
  process.stdout.write(`  ↓ ${list.id} … `);
  try {
    const res = await download(list.url);
    const why =
      notAFilterList({ text: res.bytes.toString('utf8'), contentType: res.contentType }) ??
      shrunkTooFar(res.bytes.length, lock?.lists?.[list.id], { allowShrink });
    if (why) throw new Error(why);
    staged.push({ file: list.file, bytes: res.bytes });
    console.log(`ok (${(res.bytes.length / 1024).toFixed(0)} KB)`);
  } catch (e) {
    console.log(`FAILED (${e.message})`);
    if (isCertError(e)) sawCertError = true;
    failed.push(list.id);
  }
}

if (failed.length) {
  // All or nothing: writing the lists that did arrive would leave filters/ matching neither the
  // lock nor any upstream snapshot, and a package built from it would say so nowhere.
  console.log(
    `\nNothing written: ${failed.length} of ${selected.length} failed (${failed.join(', ')}). filters/ is unchanged.`,
  );
  const rest = selected.filter((l) => !failed.includes(l.id)).map((l) => l.id);
  if (rest.length) console.log(`To refresh the others now: node scripts/update-lists.mjs ${rest.join(' ')}`);
  if (sawCertError) {
    console.log(
      '\nTLS certificate verification failed — a proxy/VPN/AV on this network is likely\n' +
        'intercepting HTTPS with a CA that Node does not trust. Options:\n' +
        '  • Point Node at that CA:  set NODE_EXTRA_CA_CERTS=C:\\path\\to\\corp-root-ca.pem\n' +
        '  • Skip the download and build with the lists already in filters/:  npm run package -- --skip-lists\n' +
        '  • Retry off the intercepting network (the failure is often transient).',
    );
  }
  // exitCode, not exit(): exit() can cut the report above short when stdout is a pipe.
  process.exitCode = 1;
} else {
  commitLists(FILTERS, staged);
  console.log(`\nDone: ${staged.length} list(s) checked and written.`);

  const absent = registry.lists.filter((l) => l.url && !existsSync(join(FILTERS, l.file))).map((l) => l.id);
  if (absent.length) {
    console.warn(`Still not downloaded: ${absent.join(', ')}. npm run check-lists and npm run package fail until they are.`);
  }

  // Stamp here rather than in a second npm script: npm appends `-- <ids>` to the end of a
  // chained script, so the ids reached the stamping step and every list was re-downloaded.
  const stamp = spawnSync(process.execPath, [join(ROOT, 'scripts', 'lock-lists.mjs')], { stdio: 'inherit' });
  if (stamp.status !== 0) process.exitCode = stamp.status ?? 1;
}
