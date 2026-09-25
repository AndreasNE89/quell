// scripts/lib/store-gates.mjs: the checks build.mjs, smoke-extpay.mjs and package.mjs run on a
// store build's ExtensionPay id and Dev-unlock gate, and package.mjs refusing to run with the
// unconfigured-ExtPay escape hatch set.
//
// The regexes these scripts used to carry missed the example file's own un-annotated override,
// and the old smoke checks looked for strings a dev bundle has too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  devUnlockReachableProblems,
  readExtPayIds,
  storeBundleExtPayProblems,
  storeExtPayLocalStub,
} from '../scripts/lib/store-gates.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TRACKED = /EXTPAY_EXTENSION_ID_TRACKED: string = '([^']+)'/.exec(
  readFileSync(join(ROOT, 'src', 'shared', 'extpay-config.ts'), 'utf8'),
)[1];

/** A src/shared/ with the real extpay-config.ts and, when given, this local override file. */
function configTree(local, { tracked } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stampstack-gates-'));
  const shared = join(dir, 'src', 'shared');
  mkdirSync(shared, { recursive: true });
  copyFileSync(join(ROOT, 'src', 'shared', 'build-flags.ts'), join(shared, 'build-flags.ts'));
  let config = readFileSync(join(ROOT, 'src', 'shared', 'extpay-config.ts'), 'utf8');
  if (tracked) config = config.replace(`= '${TRACKED}'`, `= '${tracked}'`);
  writeFileSync(join(shared, 'extpay-config.ts'), config);
  if (local != null) writeFileSync(join(shared, 'extpay-config.local.ts'), local);
  return dir;
}

test('readExtPayIds reads the override in every spelling the runtime honours', async () => {
  const cases = [
    ["export const EXTPAY_EXTENSION_ID_OVERRIDE: string | null = 'annotated';\n", 'annotated'],
    // The example file's own suggestion; the old regex needed the annotation.
    ["export const EXTPAY_EXTENSION_ID_OVERRIDE = 'plain';\n", 'plain'],
    ['export const EXTPAY_EXTENSION_ID_OVERRIDE = `templated`;\n', 'templated'],
    ["const slug = 'reexported' as const;\nexport { slug as EXTPAY_EXTENSION_ID_OVERRIDE };\n", 'reexported'],
    ["export let EXTPAY_EXTENSION_ID_OVERRIDE = 'let-bound';\n", 'let-bound'],
    // Only the commented example: no override.
    [
      "/**\n *   export const EXTPAY_EXTENSION_ID_OVERRIDE = 'your-extpay-id';\n */\nexport const EXTPAY_EXTENSION_ID_OVERRIDE: string | null = null;\n",
      null,
    ],
    ['export const EXTPAY_EXTENSION_ID_OVERRIDE = null;\n', null],
    ["export const EXTPAY_EXTENSION_ID_OVERRIDE = 'YOUR_EXTENSIONPAY_ID';\n", null],
    // build-script.test's fixture writes this; the tracked id must still read.
    ['export {};\n', null],
    // No local file at all (a fresh clone before ensure-local-config).
    [null, null],
  ];
  for (const [local, override] of cases) {
    const dir = configTree(local);
    try {
      assert.deepEqual(await readExtPayIds(dir), { tracked: TRACKED, override }, String(local));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('readExtPayIds reports a placeholder tracked id as unconfigured', async () => {
  const dir = configTree("export const EXTPAY_EXTENSION_ID_OVERRIDE = 'dev-slug';\n", { tracked: 'YOUR_EXTENSIONPAY_ID' });
  try {
    // The override does not stand in for it: store builds never use the override.
    assert.deepEqual(await readExtPayIds(dir), { tracked: null, override: 'dev-slug' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('storeBundleExtPayProblems wants the tracked id in every bundle and the override in none', () => {
  const ids = { tracked: 'stampstack-', override: 'dev-slug' };
  assert.deepEqual(
    storeBundleExtPayProblems(
      [
        ['background.js', 'var a="stampstack-";'],
        ['extpay-bridge.js', "x('stampstack-')"],
      ],
      ids,
    ),
    [],
  );
  const problems = storeBundleExtPayProblems(
    [
      ['background.js', 'var a="stampstack-",b="dev-slug";'],
      // A prefix of the id inside another literal is not the id.
      ['extpay-bridge.js', 'x("stampstack-extra")'],
    ],
    ids,
  );
  assert.equal(problems.length, 2, problems.join('\n'));
  assert.match(problems[0], /background\.js contains the local ExtensionPay override "dev-slug"/);
  assert.match(problems[1], /extpay-bridge\.js does not contain the tracked ExtensionPay id/);
  // No tracked id at all is a problem for every file, not a pass.
  assert.equal(storeBundleExtPayProblems([['background.js', '"x"']], { tracked: null, override: null }).length, 1);
  // An override equal to the tracked id is not a leak.
  assert.deepEqual(
    storeBundleExtPayProblems([['background.js', '"stampstack-"']], { tracked: 'stampstack-', override: 'stampstack-' }),
    [],
  );
});

/** The real worker, bundled as scripts/build.mjs bundles it (dev or --store). */
async function workerBundle(store) {
  const out = await build({
    entryPoints: [join(ROOT, 'src', 'background', 'service-worker.ts')],
    bundle: true,
    target: 'chrome120',
    platform: 'browser',
    format: 'esm',
    legalComments: 'none',
    minify: store,
    write: false,
    logLevel: 'silent',
    define: { __STAMPSTACK_DEV__: store ? 'false' : 'true' },
    plugins: store ? [storeExtPayLocalStub()] : [],
  });
  return out.outputFiles[0].text;
}

test('the Dev-unlock gate check passes the real store worker and refuses the dev one', async () => {
  // This check reads the shape of esbuild's minified output. If a toolchain update changes that
  // shape it fails closed, and this is where that shows up rather than at release time.
  const store = await workerBundle(true);
  assert.deepEqual(devUnlockReachableProblems(store), []);
  assert.deepEqual(storeBundleExtPayProblems([['background.js', store]], { tracked: TRACKED, override: null }), []);
  const dev = await workerBundle(false);
  const problems = devUnlockReachableProblems(dev);
  assert.ok(problems.some((p) => /DEV_BUILD = true/.test(p)), problems.join('\n'));
  assert.ok(problems.some((p) => /Dev unlock is reachable/.test(p)), problems.join('\n'));
});

test('a Dev-unlock guard that is not a constant false, or cannot be found, is reported', () => {
  const refusal = 'return{ok:!1,error:"Dev unlock is only available for unpacked installs."}';
  assert.deepEqual(devUnlockReachableProblems(`function Q(){return!1}async function d(){if(!Q())${refusal}}`), []);
  assert.deepEqual(devUnlockReachableProblems(`function $e(){return false;}async function d(){if(!$e())${refusal}}`), []);
  assert.match(
    devUnlockReachableProblems(`function Q(){return R!==null?R==="development":!0}async function d(){if(!Q())${refusal}}`)[0],
    /Q\(\) is not a constant false/,
  );
  // Only the strings both builds share, as the old smoke check looked for: not enough.
  assert.match(
    devUnlockReachableProblems(`var s="Dev unlock is only available for unpacked installs.";var u="unpacked";`)[0],
    /could not locate the guard/,
  );
});

test('npm run package refuses to start with ALLOW_UNCONFIGURED_EXTPAY set', async () => {
  // In a copy of the scripts, so a regression runs its build steps against an empty sandbox
  // instead of overwriting the real dist/ and src/generated/.
  const dir = mkdtempSync(join(tmpdir(), 'stampstack-package-'));
  const link = join(dir, 'node_modules');
  try {
    mkdirSync(join(dir, 'scripts'));
    copyFileSync(join(ROOT, 'scripts', 'package.mjs'), join(dir, 'scripts', 'package.mjs'));
    cpSync(join(ROOT, 'scripts', 'lib'), join(dir, 'scripts', 'lib'), { recursive: true });
    // store-gates.mjs imports esbuild.
    symlinkSync(join(ROOT, 'node_modules'), link, 'junction');
    const r = await new Promise((resolve) => {
      const child = spawn(process.execPath, [join(dir, 'scripts', 'package.mjs'), '--skip-lists'], {
        cwd: dir,
        env: { ...process.env, ALLOW_UNCONFIGURED_EXTPAY: '1' },
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('close', (code) => resolve({ code, out, err }));
    });
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.err, /ALLOW_UNCONFIGURED_EXTPAY/);
    assert.doesNotMatch(r.out, /\[1\/5\]/, 'it started packaging');
  } finally {
    // The junction first, on its own, so nothing below it can be reached by the recursive delete.
    if (existsSync(link)) unlinkSync(link);
    rmSync(dir, { recursive: true, force: true });
  }
});
