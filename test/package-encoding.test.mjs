// Chrome refuses to load an extension script that is not "UTF-8" by its own test
// (base::IsStringUTF8), which also rejects Unicode noncharacters such as U+FFFF: executeScript
// fails with "Could not load file 'picker.js'. It isn't UTF-8 encoded", and a manifest content
// script with one stops the extension from loading at all. esbuild copies such a character from
// a regex literal into the bundle unchanged, so the element picker shipped unloadable once
// (`/[^a-zA-Z0-9_<U+00A0>-<U+FFFF>-]/` written with the raw characters in selector.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeRejectsText } from '../scripts/lib/text-encoding.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'generated') yield* files(p);
    } else if (/\.(ts|mjs|js|css|html|json)$/.test(name)) {
      yield p;
    }
  }
}

test('no source file carries a character Chrome refuses in a script', () => {
  const bad = [];
  for (const f of files(join(ROOT, 'src'))) {
    const why = chromeRejectsText(readFileSync(f));
    if (why) bad.push(`${relative(ROOT, f)}: ${why}`);
  }
  assert.deepEqual(bad, [], 'write such characters as \\u escapes');
});

test('the bundled content scripts and picker load in Chrome', async () => {
  for (const entry of ['content/content.ts', 'content/picker.ts', 'content/scriptlets-runtime.ts']) {
    const out = await build({
      entryPoints: [join(ROOT, 'src', entry)],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'chrome120',
      write: false,
      logLevel: 'silent',
      define: { __STAMPSTACK_DEV__: 'false' },
    });
    assert.equal(chromeRejectsText(out.outputFiles[0].contents), null, entry);
  }
});

test('the check matches what Chrome refuses', () => {
  assert.equal(chromeRejectsText(Buffer.from('const a = "é ↑ —";', 'utf8')), null);
  assert.match(chromeRejectsText(Buffer.from('/[ -￿]/', 'utf8')), /U\+FFFF/);
  assert.match(chromeRejectsText(Buffer.from('x﷐', 'utf8')), /U\+FDD0/);
  assert.match(chromeRejectsText(Buffer.from([0x61, 0xff, 0x62])), /not valid UTF-8/);
});
