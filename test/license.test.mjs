// license.ts against a fake chrome.storage and ExtensionPay: a hung ExtensionPay request is
// bounded (B34), and a stored verify stamp from the future is not trusted — neither on load nor
// by the guard that keeps a purchase made while a request was in flight.
import { test, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.env.SS_SW_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
let lic;
const store = {};

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stampstack-license-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  const stub = join(dir, 'extpay.js');
  writeFileSync(
    stub,
    'export default function ExtPay(){return{getUser:()=>globalThis.__getUser(),' +
      'onPaid:{addListener(){}},openPaymentPage(){},openLoginPage(){},startBackground(){}};}\n',
  );
  const out = join(dir, 'license.mjs');
  await build({
    entryPoints: [join(ROOT, 'src/background/license.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile: out,
    alias: { extpay: stub },
    logLevel: 'silent',
  });
  globalThis.chrome = {
    storage: {
      local: {
        get: async (k) => (k in store ? { [k]: structuredClone(store[k]) } : {}),
        set: async (o) => Object.assign(store, structuredClone(o)),
      },
    },
    management: { getSelf: async () => ({ installType: 'normal' }) },
  };
  lic = await import(pathToFileURL(out).href);
});

test('a hung ExtensionPay request falls back to the cache instead of holding the lock', async () => {
  store['stampstack.license'] = { paid: true, provider: 'extensionpay', verifiedAt: Date.now() - 1000 };
  globalThis.__getUser = () => new Promise(() => {});
  mock.timers.enable({ apis: ['setTimeout'] });
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    let settled = null;
    lic.refreshLicenseDetailed().then((r) => (settled = r));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(settled, null, 'answered before the timeout');
    mock.timers.tick(10_000);
    for (let i = 0; i < 20 && !settled; i++) await new Promise((r) => setImmediate(r));
    assert.ok(settled, 'still waiting on ExtensionPay');
    assert.equal(settled.reached, false);
    assert.equal(settled.license.paid, true, 'the cached purchase stands within grace');
  } finally {
    mock.timers.reset();
    console.warn = origWarn;
  }
  // The lock was released: the next refresh gets through.
  globalThis.__getUser = async () => ({ paid: true, email: 'x@y.z' });
  const next = await lic.refreshLicenseDetailed();
  assert.equal(next.reached, true);
  assert.equal(next.license.email, 'x@y.z');
});

test('a verify stamp more than a day ahead reads as never verified', async () => {
  const now = Date.now();
  store['stampstack.license'] = { paid: true, provider: 'extensionpay', verifiedAt: now + 400 * 86_400_000 };
  assert.equal((await lic.loadLicense(now)).verifiedAt, null);
  // A clock corrected by a few hours keeps its verify.
  store['stampstack.license'] = { paid: true, provider: 'extensionpay', verifiedAt: now + 3_600_000 };
  assert.equal((await lic.loadLicense(now)).verifiedAt, now + 3_600_000);
  store['stampstack.license'] = { paid: 'yes', provider: 'extensionpay', verifiedAt: 'soon' };
  const odd = await lic.loadLicense(now);
  assert.deepEqual([odd.paid, odd.verifiedAt], [false, null]);
});

test('an unpaid answer corrects a paid stamp from the future', async () => {
  // Within the day of skew loadLicense tolerates, so the stamp survives the load. The guard that
  // keeps a purchase made mid-request read it as "newer than this request" and kept it.
  store['stampstack.license'] = { paid: true, provider: 'extensionpay', verifiedAt: Date.now() + 3_600_000 };
  globalThis.__getUser = async () => ({ paid: false });
  const r = await lic.refreshLicenseDetailed();
  assert.equal(r.reached, true);
  assert.equal(r.license.paid, false);
  assert.equal(store['stampstack.license'].paid, false);
  assert.ok(store['stampstack.license'].verifiedAt <= Date.now());
});

test('a purchase written while the request was in flight still outlives its unpaid answer', async () => {
  store['stampstack.license'] = { paid: false, provider: 'extensionpay', verifiedAt: Date.now() - 60_000 };
  globalThis.__getUser = async () => {
    // What ExtensionPay's onPaid writes, landing before this request's answer.
    store['stampstack.license'] = { paid: true, provider: 'extensionpay', verifiedAt: Date.now(), email: 'a@b.c' };
    return { paid: false };
  };
  const r = await lic.refreshLicenseDetailed();
  assert.equal(r.license.paid, true);
  assert.equal(store['stampstack.license'].paid, true);
  assert.equal(store['stampstack.license'].email, 'a@b.c');
});
