// THIRD_PARTY_NOTICES.txt lists what esbuild actually bundled — see
// scripts/third-party-notices.mjs. These pin the two decisions that make it true: a module
// tree-shaken to nothing is not listed, and our own source never is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundledPackages, renderNotices } from '../scripts/third-party-notices.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A metafile shaped like esbuild's: outputs → inputs → bytesInOutput. */
const meta = (inputs) => ({ outputs: { 'dist/background.js': { inputs } } });

test('only packages that put bytes in an output are listed', () => {
  const roots = bundledPackages(
    [
      meta({
        'src/background/service-worker.ts': { bytesInOutput: 900 },
        'node_modules/extpay/dist/ExtPay.module.js': { bytesInOutput: 400 },
        'node_modules/webextension-polyfill/dist/browser-polyfill.js': { bytesInOutput: 300 },
        // Resolved, then shaken out entirely: it ships nothing, so it is not claimed.
        'node_modules/unused-helper/index.js': { bytesInOutput: 0 },
        'node_modules/@scope/pkg/lib/a.js': { bytesInOutput: 10 },
        'node_modules/@scope/pkg/lib/b.js': { bytesInOutput: 10 },
      }),
    ],
    ROOT,
  );
  assert.deepEqual(
    roots.map((r) => r.slice(ROOT.length + 1).split('\\').join('/')),
    ['node_modules/@scope/pkg', 'node_modules/extpay', 'node_modules/webextension-polyfill'],
  );
});

test('the notice names each package, its version, its declared licence and its source', () => {
  const text = renderNotices([join(ROOT, 'node_modules', 'extpay'), join(ROOT, 'node_modules', 'webextension-polyfill')]);
  for (const name of ['extpay', 'webextension-polyfill']) {
    const { version, license } = JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8'));
    assert.match(text, new RegExp(`^${name} ${version.replace(/\./g, '\\.')}$`, 'm'));
    assert.match(text, new RegExp(`https://www\\.npmjs\\.com/package/${name}/v/${version.replace(/\./g, '\\.')}`));
    assert.ok(text.includes(`Licence declared in its package.json: ${license}`), `${name}'s declared licence`);
  }
  // The MPL's full text travels with the polyfill: it is what the package ships.
  assert.match(text, /Mozilla Public License Version 2\.0/);
});
