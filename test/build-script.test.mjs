// scripts/build.mjs, run against a small fixture tree (STAMPSTACK_BUILD_ROOT) instead of the
// real sources.
//
// - _locales was copied raw, so the zip carried the checkout's CRLF and the same commit hashed
//   differently on Windows and on the Linux runner.
// - Chrome refuses an extension that declares over 100 static rulesets, enables over 50, or
//   repeats an id; nothing checked before load time.
// - `npm run watch` rebuilt background.js after compile-filters but left the manifest, rulesets
//   and CSS from startup, so the worker enabled rulesets the manifest never declared.
// - The licence texts the attributions page links to must be in the package.
// (REVIEW_2026-09-24 P3 build entries and M17.)
// - A `--store` build must carry the tracked ExtensionPay id, not a developer's local override.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'scripts', 'build.mjs');
// The entry points build.mjs bundles, read from it so a new entry does not break the fixture.
const ENTRIES = [...readFileSync(BUILD, 'utf8').matchAll(/\['([\w/-]+\.ts)', '[\w.-]+\.js', '(?:esm|iife)'\]/g)].map(
  (m) => m[1],
);

function put(dir, rel, content) {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

/** src/generated/ as compile-filters leaves it, for `lists` ({ id, on }). */
function generated(dir, lists) {
  put(
    dir,
    'src/generated/meta.json',
    JSON.stringify({
      generatedAt: null,
      lists: lists.map((l) => ({
        id: l.id,
        title: l.id,
        group: 'ads',
        enabledByDefault: l.on,
        ruleCount: 0,
        rulesetFile: `rulesets/${l.id}.json`,
        genericCssFile: `generic-cosmetic/${l.id}.css`,
      })),
    }),
  );
  for (const l of lists) {
    put(dir, `src/generated/rulesets/${l.id}.json`, '[]');
    put(dir, `src/generated/generic-cosmetic/${l.id}.css`, '.ad-banner { display: none !important }\r\n');
  }
  put(dir, 'src/generated/scriptlet-shards.json', JSON.stringify({ bundles: {} }));
  mkdirSync(join(dir, 'src/generated/scriptlets'), { recursive: true });
  put(dir, 'src/generated/cosmetic.json', JSON.stringify({ byList: {} }));
}

/** A source tree with everything build.mjs reads, text files written with CRLF. */
function fixture(lists = [{ id: 'a', on: true }]) {
  const dir = mkdtempSync(join(tmpdir(), 'stampstack-build-'));
  assert.ok(ENTRIES.length >= 5, `found ${ENTRIES.length} entries in build.mjs`);
  put(dir, 'package.json', JSON.stringify({ version: '9.9.9' }));
  put(
    dir,
    'src/manifest.json',
    JSON.stringify({ manifest_version: 3, name: 'fixture', version: '0', permissions: ['storage'], declarative_net_request: {} }),
  );
  for (const entry of ENTRIES) put(dir, `src/${entry}`, 'console.log(1);\r\n');
  put(dir, 'src/shared/extpay-config.local.ts', 'export {};\r\n');
  for (const f of ['popup/popup.html', 'options/options.html']) put(dir, `src/${f}`, '<!doctype html>\r\n<p>x</p>\r\n');
  for (const f of ['popup/popup.css', 'options/options.css', 'content/dark-mode.css']) put(dir, `src/${f}`, 'p {}\r\n');
  put(dir, 'src/icons/icon-16.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  put(dir, 'src/_locales/en/messages.json', '{\r\n  "extName": { "message": "Fixture" }\r\n}\r\n');
  put(dir, 'src/_locales/zh_CN/messages.json', '{\r\n  "extName": { "message": "测试" }\r\n}\r\n');
  put(dir, 'src/redirects/noop.js', '/* noop */\r\n');
  put(dir, 'docs/attributions.html', '<!doctype html>\r\n<a href="licenses/GPL-3.0.txt">GPL</a>\r\n');
  put(dir, 'docs/licenses/GPL-3.0.txt', 'GNU GENERAL PUBLIC LICENSE\r\nVersion 3, 29 June 2007\r\n');
  put(dir, 'docs/licenses/THIRD_PARTY_NOTICES.txt', 'notices\r\n');
  generated(dir, lists);
  return dir;
}

function build(dir, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BUILD, ...args], {
      env: { ...process.env, STAMPSTACK_BUILD_ROOT: dir },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

const dist = (dir, rel) => readFileSync(join(dir, 'dist', rel), 'utf8');

test('locales and licence texts ship with LF line endings, whatever the checkout has', async () => {
  const dir = fixture();
  try {
    const r = await build(dir);
    assert.equal(r.code, 0, r.out);
    for (const rel of ['_locales/en/messages.json', '_locales/zh_CN/messages.json', 'licenses/GPL-3.0.txt', 'attributions.html']) {
      assert.ok(existsSync(join(dir, 'dist', rel)), `${rel} is not in the package`);
      assert.equal(dist(dir, rel).includes('\r'), false, `${rel} kept CRLF`);
    }
    assert.equal(dist(dir, '_locales/zh_CN/messages.json'), '{\n  "extName": { "message": "测试" }\n}\n');
    assert.ok(existsSync(join(dir, 'dist', 'licenses', 'THIRD_PARTY_NOTICES.txt')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('more than 100 static rulesets, more than 50 enabled, or a repeated id fails the build', async () => {
  const cases = [
    [Array.from({ length: 101 }, (_, i) => ({ id: `l${i}`, on: false })), /101 static rulesets; Chrome allows at most 100/],
    [Array.from({ length: 51 }, (_, i) => ({ id: `l${i}`, on: true })), /51 rulesets enabled by default; Chrome allows at most 50/],
    [[{ id: 'a', on: true }, { id: 'a', on: false }], /duplicate ruleset id "a"/],
  ];
  for (const [lists, message] of cases) {
    const dir = fixture(lists);
    try {
      const r = await build(dir);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, message);
      assert.equal(existsSync(join(dir, 'dist', 'manifest.json')), false, 'no manifest Chrome would refuse');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const ok = fixture(Array.from({ length: 50 }, (_, i) => ({ id: `l${i}`, on: true })));
  try {
    assert.equal((await build(ok)).code, 0, 'exactly 50 enabled is allowed');
  } finally {
    rmSync(ok, { recursive: true, force: true });
  }
});

test("a store build ships the tracked ExtensionPay id, never the local override", async () => {
  // The old gate read the override with a regex that needed a `: string` annotation, so the
  // example's own spelling slipped past it and the runtime then preferred the local slug.
  const dir = fixture();
  try {
    for (const f of ['extpay-config.ts', 'build-flags.ts']) {
      put(dir, `src/shared/${f}`, readFileSync(join(ROOT, 'src', 'shared', f)));
    }
    put(dir, 'src/shared/extpay-config.local.ts', "export const EXTPAY_EXTENSION_ID_OVERRIDE = 'dev-slug';\r\n");
    put(
      dir,
      'src/content/extpay-bridge.ts',
      "import { EXTPAY_EXTENSION_ID } from '../shared/extpay-config.js';\r\nconsole.log(EXTPAY_EXTENSION_ID);\r\n",
    );
    const tracked = /EXTPAY_EXTENSION_ID_TRACKED: string = '([^']+)'/.exec(
      readFileSync(join(ROOT, 'src', 'shared', 'extpay-config.ts'), 'utf8'),
    )[1];

    const store = await build(dir, ['--store']);
    assert.equal(store.code, 0, store.out);
    const bridge = dist(dir, 'extpay-bridge.js');
    assert.equal(bridge.includes('dev-slug'), false, 'the local slug reached the store bundle');
    assert.ok(bridge.includes(`"${tracked}"`), bridge);
    assert.match(store.out, /Ignoring local ExtensionPay override "dev-slug"/);

    // A dev build still honours it: the override is a dev affordance, not dead.
    const dev = await build(dir);
    assert.equal(dev.code, 0, dev.out);
    assert.ok(dist(dir, 'extpay-bridge.js').includes('dev-slug'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a local override does not rescue a store build whose tracked id is the placeholder', async () => {
  const dir = fixture();
  try {
    put(
      dir,
      'src/shared/extpay-config.ts',
      readFileSync(join(ROOT, 'src', 'shared', 'extpay-config.ts'), 'utf8').replace(
        /(EXTPAY_EXTENSION_ID_TRACKED: string = ')[^']+'/,
        "$1YOUR_EXTENSIONPAY_ID'",
      ),
    );
    put(dir, 'src/shared/build-flags.ts', readFileSync(join(ROOT, 'src', 'shared', 'build-flags.ts')));
    put(dir, 'src/shared/extpay-config.local.ts', "export const EXTPAY_EXTENSION_ID_OVERRIDE = 'dev-slug';\r\n");

    const store = await build(dir, ['--store']);
    assert.equal(store.code, 1, store.out);
    assert.match(store.out, /ExtensionPay id is not configured/);
    assert.match(store.out, /Ignoring local ExtensionPay override "dev-slug"/);
    // It used to name the missing id as the tracked id "null".
    assert.doesNotMatch(store.out, /"null"/);
    assert.equal(existsSync(join(dir, 'dist', 'manifest.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function until(check, ms = 20_000) {
  const start = Date.now();
  for (;;) {
    if (check()) return true;
    if (Date.now() - start > ms) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

test('watch mode follows compile-filters: manifest, rulesets and CSS, and edited static files', async () => {
  const dir = fixture([{ id: 'a', on: true }]);
  const child = spawn(process.execPath, [BUILD, '--watch'], { env: { ...process.env, STAMPSTACK_BUILD_ROOT: dir } });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  try {
    assert.ok(await until(() => /watching for changes/.test(out)), `watch never started:\n${out}`);
    const manifest = () => {
      try {
        return JSON.parse(dist(dir, 'manifest.json'));
      } catch {
        return null;
      }
    };
    assert.deepEqual(manifest().declarative_net_request.rule_resources.map((r) => r.id), ['a']);

    // What `npm run compile-filters` does when a list is added: new rulesets and CSS, meta last.
    generated(dir, [{ id: 'a', on: true }, { id: 'b', on: false }]);
    const followed = await until(
      () =>
        manifest()?.declarative_net_request.rule_resources.some((r) => r.id === 'b') &&
        existsSync(join(dir, 'dist', 'generated', 'rulesets', 'b.json')) &&
        existsSync(join(dir, 'dist', 'generated', 'generic-cosmetic', 'b.css')),
    );
    assert.ok(followed, `the manifest and rulesets stayed as they were at startup:\n${out}`);

    put(dir, 'src/_locales/en/messages.json', '{\r\n  "extName": { "message": "Renamed" }\r\n}\r\n');
    assert.ok(
      await until(() => dist(dir, '_locales/en/messages.json').includes('Renamed')),
      'an edited locale file never reached dist/',
    );
  } finally {
    child.kill();
    await new Promise((r) => child.once('close', r));
    rmSync(dir, { recursive: true, force: true });
  }
});
