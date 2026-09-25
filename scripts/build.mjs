// Bundle StampStack into a loadable unpacked extension in dist/.
//
// Flags:
//   --watch   rebuild on change: JS through esbuild, and the manifest, rulesets, CSS and other
//             static files whenever compile-filters finishes or a static source changes
//   --store   Chrome Web Store build (minified, no feedback permission)
//
// Assumes `npm run compile-filters` has produced src/generated/.

import { build, context } from 'esbuild';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  cpSync,
  readdirSync,
  statSync,
  watchFile,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinScriptletBundle } from './lib/scriptlet-shards.mjs';
import { cosmeticDataFiles } from './lib/cosmetic-files.mjs';
import { chromeRejectsText } from './lib/text-encoding.mjs';
import { rulesetProblems } from './lib/package-checks.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// STAMPSTACK_BUILD_ROOT points the build at another tree; test/build-script.test.mjs builds a
// small fixture that way instead of the real sources.
const ROOT = process.env.STAMPSTACK_BUILD_ROOT
  ? resolve(process.env.STAMPSTACK_BUILD_ROOT)
  : join(__dirname, '..');
const SRC = join(ROOT, 'src');
const GEN = join(SRC, 'generated');
const DIST = join(ROOT, 'dist');

const watch = process.argv.includes('--watch');
const store = process.argv.includes('--store');

const COMMON = {
  bundle: true,
  target: 'chrome120',
  platform: 'browser',
  logLevel: 'info',
  // The bundled packages' notices and licence texts ship as files instead (docs/licenses/ →
  // dist/licenses/, linked from attributions.html); their sources carry no legal comments.
  legalComments: 'none',
  minify: store,
  sourcemap: false,
  // Compile-time dev flag (src/shared/build-flags.ts). Store builds → false, so the
  // dev-unlock / test-license paths can never fire in a packaged extension.
  define: { __STAMPSTACK_DEV__: store ? 'false' : 'true' },
};

/** Entry points: [srcFile, outFile, format]. */
const ENTRIES = [
  ['background/service-worker.ts', 'background.js', 'esm'],
  ['content/content.ts', 'content.js', 'iife'],
  // List scriptlets: the last file of every generated/scriptlets/ registration and fallback, and
  // the tail of every bundle (writeScriptletBundles).
  // Built twice because Chrome injects one file only once per document, and a page can match a
  // host bucket and the broad (entity) registration at once (src/engine/scriptlet-shards.ts).
  ['content/scriptlets-runtime.ts', 'scriptlets-runtime.js', 'iife'],
  ['content/scriptlets-runtime.ts', 'scriptlets-runtime-broad.js', 'iife'],
  ['content/scriptlets-youtube.ts', 'scriptlets-youtube.js', 'iife'],
  ['content/scriptlets-youtube-frames.ts', 'scriptlets-youtube-frames.js', 'iife'],
  ['content/extpay-bridge.ts', 'extpay-bridge.js', 'iife'],
  // Injected on demand by chrome.scripting, so it is NOT a manifest content script.
  ['content/picker.ts', 'picker.js', 'iife'],
  ['popup/popup.ts', 'popup.js', 'esm'],
  ['options/options.ts', 'options.js', 'esm'],
];

/** A build that must stop. Thrown rather than exiting so watch mode can report it and go on. */
class BuildError extends Error {}

function assertGenerated() {
  if (!existsSync(join(GEN, 'meta.json'))) {
    console.error('Missing src/generated/. Run `npm run compile-filters` first.');
    process.exit(1);
  }
}

/** Ensure gitignored local ExtPay override exists so imports resolve. */
function ensureExtPayLocalConfig() {
  const local = join(SRC, 'shared', 'extpay-config.local.ts');
  const example = join(SRC, 'shared', 'extpay-config.local.example.ts');
  if (!existsSync(local)) {
    if (!existsSync(example)) {
      console.error('Missing extpay-config.local.example.ts');
      process.exit(1);
    }
    cpSync(example, local);
  }
}

/**
 * Resolve the ExtensionPay id the same way runtime does (local override → tracked → placeholder).
 * A store build with a placeholder would ship unpurchasable paid dark mode.
 * Override with ALLOW_UNCONFIGURED_EXTPAY=1 for local testing only.
 */
function resolveExtPayId() {
  const placeholder = 'YOUR_EXTENSIONPAY_ID';
  const localPath = join(SRC, 'shared', 'extpay-config.local.ts');
  if (existsSync(localPath)) {
    const m = readFileSync(localPath, 'utf8').match(
      /EXTPAY_EXTENSION_ID_OVERRIDE\s*:[^=]*=\s*(['"])([^'"]*)\1/,
    );
    if (m && m[2] && m[2] !== placeholder) return m[2];
  }
  const trackedPath = join(SRC, 'shared', 'extpay-config.ts');
  const tm = readFileSync(trackedPath, 'utf8').match(
    /EXTPAY_EXTENSION_ID_TRACKED(?:\s*:\s*[^=]+)?\s*=\s*(['"])([^'"]*)\1/,
  );
  if (tm && tm[2] && tm[2] !== placeholder) return tm[2];
  return null;
}

function assertExtPayConfiguredForStore() {
  if (process.env.ALLOW_UNCONFIGURED_EXTPAY === '1') return;
  const id = resolveExtPayId();
  if (!id) {
    console.error(
      `\n[--store] ExtensionPay id is not configured. Paid dark mode would be unpurchasable.\n` +
        `Set EXTPAY_EXTENSION_ID_TRACKED in src/shared/extpay-config.ts (or local override), ` +
        `or set ALLOW_UNCONFIGURED_EXTPAY=1 to build anyway for testing.`,
    );
    process.exit(1);
  }
}

function buildManifest() {
  const manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'));
  const meta = JSON.parse(readFileSync(join(GEN, 'meta.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

  // Keep extension version aligned with package.json.
  if (pkg.version) manifest.version = pkg.version;

  // Dev-only: optional feedback for badge counts when loading unpacked with --dev-feedback.
  // webNavigation only resets the badge counter, which is itself dev-only — so it ships
  // only alongside the feedback permission, never in a store build.
  if (process.argv.includes('--dev-feedback')) {
    for (const perm of ['declarativeNetRequestFeedback', 'webNavigation']) {
      if (!manifest.permissions.includes(perm)) manifest.permissions.push(perm);
    }
  }

  if (!meta.lists.length) {
    throw new BuildError('No compiled filter lists in meta.json — refusing to build an empty blocker.');
  }

  manifest.declarative_net_request.rule_resources = meta.lists.map((l) => ({
    id: l.id,
    enabled: l.enabledByDefault,
    path: `generated/${l.rulesetFile}`,
  }));
  // Chrome refuses the whole extension over these, so fail here rather than at load time.
  const problems = rulesetProblems(manifest.declarative_net_request.rule_resources);
  if (problems.length) {
    throw new BuildError(`The manifest's rulesets break Chrome's limits:\n  ${problems.join('\n  ')}`);
  }

  writeFileSync(join(DIST, 'manifest.json'), JSON.stringify(manifest, null, store ? 0 : 2));
}

/**
 * Copy a text asset, normalizing CRLF to LF.
 *
 * On Windows git checks the working tree out with CRLF, so a plain copy bakes the local
 * autocrlf setting into the package — the same commit produced two different zips depending on
 * who built it. HTML and CSS do not care, but a store artifact whose bytes depend on the
 * machine cannot be diffed or reproduced, so normalize on the way in.
 */
function copyText(src, dest) {
  writeFileSync(dest, readFileSync(src, 'utf8').split('\r\n').join('\n'));
}

/** Extensions worth normalizing. Anything else (icons) is copied byte-for-byte. */
const TEXT_EXT = new Set(['.html', '.css', '.js', '.txt', '.json', '.svg']);

function copyTree(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    const from = join(srcDir, name);
    const to = join(destDir, name);
    if (statSync(from).isDirectory()) {
      copyTree(from, to);
      continue;
    }
    const dot = name.lastIndexOf('.');
    const ext = dot < 0 ? '' : name.slice(dot).toLowerCase();
    if (TEXT_EXT.has(ext)) copyText(from, to);
    else cpSync(from, to);
  }
}

function copyStatic() {
  for (const [dir, files] of [
    ['popup', ['popup.html', 'popup.css']],
    ['options', ['options.html', 'options.css']],
  ]) {
    for (const f of files) copyText(join(SRC, dir, f), join(DIST, f));
  }
  copyText(join(SRC, 'content', 'dark-mode.css'), join(DIST, 'dark-mode.css'));
  cpSync(join(SRC, 'icons'), join(DIST, 'icons'), { recursive: true });

  // _locales must sit at the package root for chrome.i18n to find it. Chrome picks the
  // browser's UI language and falls back to default_locale, so nothing detects anything.
  // Normalized like every other text file: a raw copy kept the checkout's CRLF, so the same
  // commit zipped differently on Windows and on the Linux runner.
  const localesSrc = join(SRC, '_locales');
  if (existsSync(localesSrc)) copyTree(localesSrc, join(DIST, '_locales'));
  copyTree(join(SRC, 'redirects'), join(DIST, 'redirects'));

  // In-extension privacy page (also publish docs/privacy-policy.html on the web).
  const privacySrc = join(ROOT, 'docs', 'privacy-policy.html');
  if (existsSync(privacySrc)) copyText(privacySrc, join(DIST, 'privacy.html'));

  // Filter-list attribution must ship with the package: the compiled rulesets are derived
  // from EasyList / uBO data under GPLv3 / CC BY-SA.
  const attribSrc = join(ROOT, 'docs', 'attributions.html');
  if (existsSync(attribSrc)) copyText(attribSrc, join(DIST, 'attributions.html'));
  // The notices and licence texts the page links to: GPLv3 / LGPLv3 for the lists and ExtPay,
  // MPL-2.0 for webextension-polyfill. Those licences require the text to travel with a copy.
  const licensesSrc = join(ROOT, 'docs', 'licenses');
  if (existsSync(licensesSrc)) copyTree(licensesSrc, join(DIST, 'licenses'));

  mkdirSync(join(DIST, 'generated', 'rulesets'), { recursive: true });
  mkdirSync(join(DIST, 'generated', 'generic-cosmetic'), { recursive: true });
  for (const f of readdirSync(join(GEN, 'rulesets'))) {
    copyText(join(GEN, 'rulesets', f), join(DIST, 'generated', 'rulesets', f));
  }
  const genericDir = join(GEN, 'generic-cosmetic');
  if (existsSync(genericDir)) {
    for (const f of readdirSync(genericDir)) {
      copyText(join(genericDir, f), join(DIST, 'generated', 'generic-cosmetic', f));
    }
  }
  // Per-host list scriptlet data, registered as MAIN-world content scripts by the SW.
  const shardDir = join(GEN, 'scriptlets');
  if (!existsSync(join(GEN, 'scriptlet-shards.json')) || !existsSync(shardDir)) {
    throw new BuildError('Missing src/generated/scriptlets/. Run `npm run compile-filters` first.');
  }
  copyTree(shardDir, join(DIST, 'generated', 'scriptlets'));
  // Cosmetic rules as the files the worker fetches (core + one per list, REVIEW_2026-09-24 B35).
  // Without them a fresh install registers no generic sheet and hides nothing site-specific.
  const cosmetic = JSON.parse(readFileSync(join(GEN, 'cosmetic.json'), 'utf8'));
  for (const f of cosmeticDataFiles(cosmetic)) {
    const out = join(DIST, f.path);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, f.content);
  }
  // NOT copied: generated/generic-cosmetic.css. syncRegisteredScripts injects the per-list
  // sheets under generated/generic-cosmetic/, so the combined file is ~530 KB of package
  // weight nothing ever loads. It stays in src/generated for local inspection.
}

/**
 * The scriptlet bundles compile-filters named in scriptlet-shards.json: each default-list
 * registration's data files and runtime as one file, so Chrome logs one "Blocked script
 * execution" error per registration in a script-less sandboxed frame instead of one per file
 * (scripts/lib/scriptlet-shards.mjs). Written here because they end with this build's runtime,
 * minified for the store. `lenient` skips a bundle whose runtime is not built yet: in watch mode
 * each runtime entry rewrites the bundles once its own file is out.
 */
function writeScriptletBundles({ lenient = false } = {}) {
  const index = JSON.parse(readFileSync(join(GEN, 'scriptlet-shards.json'), 'utf8'));
  for (const bundle of Object.values(index.bundles ?? {})) {
    const paths = bundle.parts.map((p) => (p.startsWith('generated/') ? join(SRC, p) : join(DIST, p)));
    if (lenient && !paths.every((p) => existsSync(p))) continue;
    const texts = paths.map((p) => readFileSync(p, 'utf8').split('\r\n').join('\n'));
    const out = join(DIST, bundle.file);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, joinScriptletBundle(texts));
  }
}

/**
 * Every script and stylesheet in dist/ must be text Chrome loads. A noncharacter such as U+FFFF,
 * which esbuild copies from a regex literal as is, made executeScript refuse picker.js ("It isn't
 * UTF-8 encoded"); in a manifest content script it stops the extension from loading.
 */
function assertChromeLoadsText(dir = DIST) {
  const bad = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|css|html|json)$/.test(name)) {
        const why = chromeRejectsText(readFileSync(p));
        if (why) bad.push(`${p.slice(DIST.length + 1)}: ${why}`);
      }
    }
  };
  walk(dir);
  if (bad.length) {
    console.error(`Chrome would refuse to load these files:\n  ${bad.join('\n  ')}`);
    process.exit(1);
  }
}

/** Watch mode: a rebuilt runtime must reach the bundles that carry it. */
const scriptletBundlesOnRebuild = {
  name: 'scriptlet-bundles',
  setup(b) {
    b.onEnd((result) => {
      if (result.errors.length) return;
      try {
        writeScriptletBundles({ lenient: true });
      } catch (e) {
        console.error('[scriptlet-bundles]', e);
      }
    });
  },
};

/** Every file copyStatic reads, other than src/generated/ (watched through meta.json). */
function staticSources() {
  const files = [
    join(SRC, 'manifest.json'),
    join(SRC, 'popup', 'popup.html'),
    join(SRC, 'popup', 'popup.css'),
    join(SRC, 'options', 'options.html'),
    join(SRC, 'options', 'options.css'),
    join(SRC, 'content', 'dark-mode.css'),
    join(ROOT, 'docs', 'privacy-policy.html'),
    join(ROOT, 'docs', 'attributions.html'),
  ];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  for (const dir of [join(SRC, '_locales'), join(SRC, 'redirects'), join(SRC, 'icons'), join(ROOT, 'docs', 'licenses')]) {
    walk(dir);
  }
  return files;
}

/**
 * Watch mode for everything esbuild does not bundle.
 *
 * esbuild rebuilds background.js when compile-filters rewrites src/generated/*.json, because the
 * worker imports them. The manifest's rule_resources, the ruleset files and the generic CSS used
 * to stay as they were at startup, so the worker enabled rulesets the manifest never declared
 * and registered CSS files that did not exist. compile-filters writes meta.json last, so a change
 * to it means the generated tree is complete. fs.watchFile polls, which also sees a file that is
 * replaced rather than edited. A file added while watching needs a restart.
 */
function watchStatic() {
  let timer = null;
  let retried = false;
  const refresh = (delay = 300) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        // Drop the old generated tree: a list removed from the registry must not linger.
        rmSync(join(DIST, 'generated'), { recursive: true, force: true });
        buildManifest();
        copyStatic();
        writeScriptletBundles({ lenient: true });
        retried = false;
        console.log('[static] manifest, rulesets, CSS and static files refreshed');
      } catch (e) {
        // Caught mid-write by compile-filters: one more look once it has finished.
        if (e instanceof SyntaxError && !retried) {
          retried = true;
          refresh(1500);
          return;
        }
        console.error(e instanceof BuildError ? `[static] ${e.message}` : e);
      }
    }, delay);
  };
  for (const file of [join(GEN, 'meta.json'), ...staticSources()]) {
    watchFile(file, { interval: 400 }, (cur, prev) => {
      if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) refresh();
    });
  }
}

async function run() {
  assertGenerated();
  ensureExtPayLocalConfig();
  if (store) assertExtPayConfiguredForStore();
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  const configs = ENTRIES.map(([src, out, format]) => ({
    ...COMMON,
    entryPoints: [join(SRC, src)],
    outfile: join(DIST, out),
    format,
    ...(watch && src === 'content/scriptlets-runtime.ts' ? { plugins: [scriptletBundlesOnRebuild] } : {}),
  }));

  if (watch) {
    const ctxs = await Promise.all(configs.map((c) => context(c)));
    await Promise.all(ctxs.map((c) => c.watch()));
    buildManifest();
    copyStatic();
    watchStatic();
    console.log(
      'watching for changes… (run `npm run compile-filters` after a list change; the manifest and rulesets follow)',
    );
  } else {
    await Promise.all(configs.map((c) => build(c)));
    buildManifest();
    copyStatic();
    writeScriptletBundles();
    assertChromeLoadsText();
    const mode = store ? 'store' : 'dev';
    console.log(
      `\nBuilt unpacked extension → dist/  [${mode}]  (chrome://extensions → Load unpacked)`,
    );
  }
}

run().catch((e) => {
  console.error(e instanceof BuildError ? e.message : e);
  process.exit(1);
});
