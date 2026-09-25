import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let mod;

before(async () => {
  const outfile = join(tmpdir(), `quell-extpay-config-${process.pid}.mjs`);
  await build({
    stdin: {
      contents: `export {
  EXTPAY_EXTENSION_ID,
  EXTPAY_EXTENSION_ID_TRACKED,
  CWS_ITEM_ID,
  isExtPayConfigured,
} from './src/shared/extpay-config.js';`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile,
  });
  mod = await import(`file://${outfile}?t=${Date.now()}`);
  process.on('exit', () => {
    try {
      rmSync(outfile);
    } catch {
      /* ignore */
    }
  });
});

test('should expose live CWS item id for ExtensionPay linking', () => {
  assert.equal(mod.CWS_ITEM_ID, 'hfioggmggaefiiaehnfoiaajcdodnkkd');
});

test('should ship a non-placeholder tracked ExtensionPay id', () => {
  assert.ok(mod.EXTPAY_EXTENSION_ID_TRACKED);
  assert.notEqual(mod.EXTPAY_EXTENSION_ID_TRACKED, 'YOUR_EXTENSIONPAY_ID');
  assert.equal(mod.isExtPayConfigured(), true);
  assert.ok(mod.EXTPAY_EXTENSION_ID.length > 0);
});

/** EXTPAY_EXTENSION_ID as a build with this `__STAMPSTACK_DEV__` sees it, with a local override set. */
async function resolvedIdWithOverride(dev, override = `'dev-slug'`) {
  const out = await build({
    stdin: { contents: `export { EXTPAY_EXTENSION_ID } from './src/shared/extpay-config.js';`, resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
    define: { __STAMPSTACK_DEV__: String(dev) },
    plugins: [
      {
        name: 'local-override',
        setup(b) {
          b.onResolve({ filter: /^\.\/extpay-config\.local(\.js|\.ts)?$/ }, (a) => ({ path: a.path, namespace: 'local' }));
          b.onLoad({ filter: /.*/, namespace: 'local' }, () => ({
            contents: `export const EXTPAY_EXTENSION_ID_OVERRIDE = ${override};\n`,
            loader: 'ts',
          }));
        },
      },
    ],
  });
  const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
  return m.EXTPAY_EXTENSION_ID;
}

test('a local ExtensionPay override counts in dev builds only', async () => {
  // A store build carrying a developer's slug bills buyers against a project that is not linked
  // to the CWS item.
  assert.equal(await resolvedIdWithOverride(true), 'dev-slug');
  assert.equal(await resolvedIdWithOverride(false), mod.EXTPAY_EXTENSION_ID_TRACKED);
  assert.equal(await resolvedIdWithOverride(true, `'YOUR_EXTENSIONPAY_ID'`), mod.EXTPAY_EXTENSION_ID_TRACKED);
  assert.equal(await resolvedIdWithOverride(true, 'null'), mod.EXTPAY_EXTENSION_ID_TRACKED);
});

test("extpay-config.ts typechecks with the example's own un-annotated override", async (t) => {
  let ts;
  try {
    ts = (await import('typescript')).default;
  } catch (e) {
    t.skip(`typescript unavailable: ${e.message}`);
    return;
  }
  // `export const X = 'slug'` is a literal type, and comparing it with the placeholder literal
  // was TS2367 — `npm run typecheck` failed on the spelling the example file suggests.
  const dir = mkdtempSync(join(tmpdir(), 'stampstack-extpay-tsc-'));
  try {
    const shared = join(dir, 'shared');
    mkdirSync(shared);
    for (const f of ['extpay-config.ts', 'build-flags.ts']) copyFileSync(join(ROOT, 'src', 'shared', f), join(shared, f));
    const errors = {};
    for (const local of [
      `export const EXTPAY_EXTENSION_ID_OVERRIDE = 'your-extpay-id';\n`,
      `export const EXTPAY_EXTENSION_ID_OVERRIDE = null;\n`,
      `export const EXTPAY_EXTENSION_ID_OVERRIDE: string | null = null;\n`,
    ]) {
      writeFileSync(join(shared, 'extpay-config.local.ts'), local);
      const program = ts.createProgram([join(shared, 'extpay-config.ts')], {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict: true,
        noUnusedLocals: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
        lib: ['lib.es2022.d.ts'],
      });
      errors[local.trim()] = ts
        .getPreEmitDiagnostics(program)
        .map((d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
    }
    for (const [local, list] of Object.entries(errors)) assert.deepEqual(list, [], local);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
