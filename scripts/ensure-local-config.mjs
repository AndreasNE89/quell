// Materialize the gitignored local ExtPay override from its committed example.
//
// src/shared/extpay-config.ts imports './extpay-config.local.js' unconditionally, but that
// file is gitignored — so on any checkout that has never run a build (a fresh clone, a CI
// runner) it does not exist, and both `tsc --noEmit` and the tests that bundle that module
// fail on an unresolvable import.
//
// scripts/build.mjs has always created it, but only once a build is under way, which is too
// late for a typecheck or test step that runs first. This is that same step, callable on its
// own, wired as `pretypecheck` and `pretest` in package.json — the two entry points that
// resolve TypeScript imports before any build has run. compile-filters does not need it: it
// reads the filter lists and never touches src/shared.
//
// It never overwrites an existing file: a developer's real override must survive this.

import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = join(ROOT, 'src', 'shared');
const local = join(SHARED, 'extpay-config.local.ts');
const example = join(SHARED, 'extpay-config.local.example.ts');

if (existsSync(local)) {
  process.exit(0);
}
if (!existsSync(example)) {
  console.error('Missing src/shared/extpay-config.local.example.ts — cannot create the local override.');
  process.exit(1);
}
copyFileSync(example, local);
console.log('Created src/shared/extpay-config.local.ts from the example (gitignored).');
