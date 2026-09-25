import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  parseExtPayConst,
  resolveExtPayId,
  storeExtPayProblem,
} from '../scripts/lib/extpay-id.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = readFileSync(join(ROOT, 'src/shared/extpay-config.local.example.ts'), 'utf8');
const TRACKED = readFileSync(join(ROOT, 'src/shared/extpay-config.ts'), 'utf8');
const NAME = 'EXTPAY_EXTENSION_ID_OVERRIDE';

function fakeSrc(localText) {
  const dir = mkdtempSync(join(tmpdir(), 'quell-extpay-id-'));
  mkdirSync(join(dir, 'shared'));
  writeFileSync(join(dir, 'shared', 'extpay-config.ts'), TRACKED);
  if (localText != null) writeFileSync(join(dir, 'shared', 'extpay-config.local.ts'), localText);
  return dir;
}

test('the shipped example resolves to no override (its commented form is not a value)', () => {
  assert.equal(parseExtPayConst(EXAMPLE, NAME), null);
});

test('an override is detected with or without a type annotation', () => {
  // The unannotated form is exactly what the example suggests; the old regex missed it.
  assert.equal(parseExtPayConst(`export const ${NAME} = 'my-slug';`, NAME), 'my-slug');
  assert.equal(parseExtPayConst(`export const ${NAME}: string | null = "my-slug";`, NAME), 'my-slug');
  assert.equal(parseExtPayConst(`export const ${NAME}: string = 'my-slug';`, NAME), 'my-slug');
  assert.equal(parseExtPayConst(`export const ${NAME} = null;`, NAME), null);
  assert.equal(parseExtPayConst(`export const ${NAME} = '';`, NAME), null);
  assert.equal(parseExtPayConst(`export const ${NAME} = 'YOUR_EXTENSIONPAY_ID';`, NAME), null);
});

test('the tracked id resolves when no override is set', () => {
  const src = fakeSrc(EXAMPLE);
  try {
    const r = resolveExtPayId(src);
    assert.equal(r.source, 'tracked');
    assert.equal(r.override, null);
    assert.ok(r.id);
    assert.equal(storeExtPayProblem(r), null);
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test('a local override wins (as at runtime) and blocks a store build', () => {
  const src = fakeSrc(`export const ${NAME} = 'your-extpay-id';\n`);
  try {
    const r = resolveExtPayId(src);
    assert.equal(r.source, 'local');
    assert.equal(r.id, 'your-extpay-id');
    assert.match(storeExtPayProblem(r), /tracked id/);
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test('an unconfigured id blocks a store build', () => {
  assert.match(
    storeExtPayProblem({ id: null, source: 'none', override: null, tracked: null }),
    /not configured/,
  );
});

test('npm run package refuses ALLOW_UNCONFIGURED_EXTPAY before doing any work', () => {
  const r = spawnSync(process.execPath, ['scripts/package.mjs', '--skip-lists'], {
    cwd: ROOT,
    env: { ...process.env, ALLOW_UNCONFIGURED_EXTPAY: '1' },
    encoding: 'utf8',
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ALLOW_UNCONFIGURED_EXTPAY/);
  assert.doesNotMatch(r.stdout, /Store build/);
});
