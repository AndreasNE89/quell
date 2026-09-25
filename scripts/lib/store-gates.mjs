// Store-build gates shared by build.mjs, smoke-extpay.mjs and package.mjs: which ExtensionPay id
// a bundle carries, and whether Dev unlock is reachable in it.
//
// The ids are read by bundling the real TypeScript modules rather than by regex. The regexes
// these scripts used to carry required a `: string` annotation on the local override, while the
// committed example shows the un-annotated form — so with the example's own spelling a `--store`
// build shipped the local slug while every gate reported the tracked id.

import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const EXTPAY_PLACEHOLDER = 'YOUR_EXTENSIONPAY_ID';

/** The module specifier extpay-config.ts imports; stubbed out of store bundles. */
export const EXTPAY_LOCAL_IMPORT = /^\.\/extpay-config\.local(?:\.js|\.ts)?$/;

function usable(id) {
  return typeof id === 'string' && id.length > 0 && id !== EXTPAY_PLACEHOLDER ? id : null;
}

/**
 * `{ tracked, override }` — each a usable id or null. `override` is the gitignored local value,
 * which only dev builds honour.
 */
export async function readExtPayIds(root) {
  const shared = join(root, 'src', 'shared');
  const hasLocal = existsSync(join(shared, 'extpay-config.local.ts'));
  const out = await build({
    stdin: {
      contents:
        `export { EXTPAY_EXTENSION_ID_TRACKED } from './extpay-config.ts';\n` +
        (hasLocal
          ? `export { EXTPAY_EXTENSION_ID_OVERRIDE } from './extpay-config.local.ts';\n`
          : `export const EXTPAY_EXTENSION_ID_OVERRIDE = null;\n`),
      resolveDir: shared,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
    // extpay-config.ts imports the local file unconditionally; without it on disk, resolve it
    // to nothing rather than failing (the build scripts create it before bundling anyway).
    plugins: hasLocal ? [] : [storeExtPayLocalStub()],
  });
  const code = out.outputFiles[0].text;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  return {
    tracked: usable(mod.EXTPAY_EXTENSION_ID_TRACKED),
    override: usable(mod.EXTPAY_EXTENSION_ID_OVERRIDE),
  };
}

/**
 * esbuild plugin: resolve the local override module to `null`. Used for `--store` bundles so a
 * developer's local slug cannot reach a packaged build even as dead code.
 */
export function storeExtPayLocalStub() {
  return {
    name: 'store-extpay-local-stub',
    setup(b) {
      b.onResolve({ filter: EXTPAY_LOCAL_IMPORT }, (args) => ({
        path: args.path,
        namespace: 'store-extpay-local',
      }));
      b.onLoad({ filter: /.*/, namespace: 'store-extpay-local' }, () => ({
        contents: 'export const EXTPAY_EXTENSION_ID_OVERRIDE = null;\n',
        loader: 'js',
      }));
    },
  };
}

function hasLiteral(text, id) {
  return [`"${id}"`, `'${id}'`, `\`${id}\``].some((q) => text.includes(q));
}

/**
 * Problems with the ExtPay id in built bundles, as strings (empty = fine). Every file must carry
 * the tracked id as a literal, and none may carry the local override.
 */
export function storeBundleExtPayProblems(files, { tracked, override }) {
  const problems = [];
  for (const [name, text] of files) {
    if (!tracked || !hasLiteral(text, tracked)) {
      problems.push(`${name} does not contain the tracked ExtensionPay id "${tracked}"`);
    }
    if (override && override !== tracked && hasLiteral(text, override)) {
      problems.push(`${name} contains the local ExtensionPay override "${override}"`);
    }
  }
  return problems;
}

/** A dev bundle's define, unminified: `var DEV_BUILD = true ? true : false;`. */
const DEV_BUNDLE_RE = /DEV_BUILD\s*=\s*(?:true|!0)\b/;

/** The guard in front of license:devUnlock's refusal; captures the guard function's name. */
const DEV_UNLOCK_GATE_RE =
  /if\s*\(\s*!\s*([\w$]+)\s*\(\s*\)\s*\)\s*\{?\s*return\s*\{\s*ok\s*:\s*(?:false|!1)\s*,\s*error\s*:\s*["'`]Dev unlock is only available/;

/**
 * Reasons dist/background.js may hand out Dev unlock (empty = a store build). Both signals must
 * say "store":
 *
 * - no dev-build define (`DEV_BUILD = true ? …`), the pattern package.mjs has always refused;
 * - the guard in front of "Dev unlock is only available…" is a constant `return false`. With
 *   `__STAMPSTACK_DEV__` defined false, esbuild folds isUnpackedInstall() to exactly that, so
 *   this checks the gate itself. The old smoke checks looked for strings both builds share
 *   (the error text, the word "unpacked") and passed on a dev bundle.
 *
 * A guard that cannot be located is reported too: if a toolchain change moves the shape, this
 * fails closed rather than passing on nothing.
 */
export function devUnlockReachableProblems(background) {
  const problems = [];
  if (DEV_BUNDLE_RE.test(background)) {
    problems.push('background.js carries the dev-build define (DEV_BUILD = true)');
  }
  const gate = DEV_UNLOCK_GATE_RE.exec(background);
  if (!gate) {
    problems.push('could not locate the guard in front of "Dev unlock is only available…"');
    return problems;
  }
  const name = gate[1].replace(/\$/g, '\\$');
  const constantFalse = new RegExp(
    `function\\s+${name}\\s*\\(\\s*\\)\\s*\\{\\s*return\\s*(?:false|!1)\\s*;?\\s*\\}`,
  );
  if (!constantFalse.test(background)) {
    problems.push(`Dev-unlock guard ${gate[1]}() is not a constant false — Dev unlock is reachable`);
  }
  return problems;
}
