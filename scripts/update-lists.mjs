// Fetch the upstream filter lists declared in filters/lists.json (those with a `url`)
// and save them next to the seed. After running this, run `npm run build` and reload
// the extension. This is the path to full uBlock-Origin-parity coverage.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get as httpsGet } from 'node:https';
import { get as httpGet } from 'node:http';

const FILTERS = join(dirname(fileURLToPath(import.meta.url)), '..', 'filters');
const registry = JSON.parse(readFileSync(join(FILTERS, 'lists.json'), 'utf8'));
const MAX_REDIRECTS = 8;
const ATTEMPTS = 3;

const only = process.argv.slice(2); // optional list ids to restrict to

/** node:https/http download — avoids flaky undici assert(!this.paused) on some TLS paths. */
function downloadOnce(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const getter = url.startsWith('http:') ? httpGet : httpsGet;
    const req = getter(
      url,
      {
        headers: { 'User-Agent': 'Quell-adblock/1.0 (+https://github.com/AndreasNE89/quell)' },
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
          const next = new URL(res.headers.location, url).href;
          resolve(downloadOnce(next, redirects + 1));
          return;
        }
        if (code !== 200) {
          res.resume();
          reject(new Error(`HTTP ${code}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
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
      if (i < ATTEMPTS) await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
  throw last;
}

let ok = 0;
let failed = 0;
for (const list of registry.lists) {
  if (!list.url) continue;
  if (only.length && !only.includes(list.id)) continue;
  process.stdout.write(`  ↓ ${list.id} … `);
  try {
    const text = await download(list.url);
    if (text.length < 100) throw new Error('suspiciously small response');
    writeFileSync(join(FILTERS, list.file), text);
    console.log(`ok (${(text.length / 1024).toFixed(0)} KB)`);
    ok++;
  } catch (e) {
    console.log(`FAILED (${e.message})`);
    failed++;
  }
}
console.log(`\nDone: ${ok} updated, ${failed} failed.`);
if (failed) process.exitCode = 1;
