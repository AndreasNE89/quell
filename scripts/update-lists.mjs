// Fetch the upstream filter lists declared in filters/lists.json (those with a `url`)
// and save them next to the seed. After running this, run `npm run build` and reload
// the extension. This is the path to full uBlock-Origin-parity coverage.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILTERS = join(dirname(fileURLToPath(import.meta.url)), '..', 'filters');
const registry = JSON.parse(readFileSync(join(FILTERS, 'lists.json'), 'utf8'));

const only = process.argv.slice(2); // optional list ids to restrict to

let ok = 0;
let failed = 0;
for (const list of registry.lists) {
  if (!list.url) continue;
  if (only.length && !only.includes(list.id)) continue;
  process.stdout.write(`  ↓ ${list.id} … `);
  try {
    const res = await fetch(list.url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
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
