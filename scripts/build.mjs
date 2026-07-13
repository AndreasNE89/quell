// Bundle StampStack into a loadable unpacked extension in dist/.
//
// Flags:
//   --watch   rebuild JS on change
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
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
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
  legalComments: 'none',
  minify: store,
  sourcemap: false,
};

/** Entry points: [srcFile, outFile, format]. */
const ENTRIES = [
  ['background/service-worker.ts', 'background.js', 'esm'],
  ['content/content.ts', 'content.js', 'iife'],
  ['content/scriptlets-main.ts', 'scriptlets.js', 'iife'],
  ['content/scriptlets-youtube.ts', 'scriptlets-youtube.js', 'iife'],
  ['popup/popup.ts', 'popup.js', 'esm'],
  ['options/options.ts', 'options.js', 'esm'],
];

function assertGenerated() {
  if (!existsSync(join(GEN, 'meta.json'))) {
    console.error('Missing src/generated/. Run `npm run compile-filters` first.');
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
  if (process.argv.includes('--dev-feedback')) {
    if (!manifest.permissions.includes('declarativeNetRequestFeedback')) {
      manifest.permissions.push('declarativeNetRequestFeedback');
    }
  }

  if (!meta.lists.length) {
    console.error('No compiled filter lists in meta.json — refusing to build an empty blocker.');
    process.exit(1);
  }

  manifest.declarative_net_request.rule_resources = meta.lists.map((l) => ({
    id: l.id,
    enabled: l.enabledByDefault,
    path: `generated/${l.rulesetFile}`,
  }));

  writeFileSync(join(DIST, 'manifest.json'), JSON.stringify(manifest, null, store ? 0 : 2));
}

function copyStatic() {
  for (const [dir, files] of [
    ['popup', ['popup.html', 'popup.css']],
    ['options', ['options.html', 'options.css']],
  ]) {
    for (const f of files) cpSync(join(SRC, dir, f), join(DIST, f));
  }
  cpSync(join(SRC, 'icons'), join(DIST, 'icons'), { recursive: true });
  cpSync(join(SRC, 'redirects'), join(DIST, 'redirects'), { recursive: true });

  // In-extension privacy page (also publish docs/privacy-policy.html on the web).
  const privacySrc = join(ROOT, 'docs', 'privacy-policy.html');
  if (existsSync(privacySrc)) cpSync(privacySrc, join(DIST, 'privacy.html'));

  mkdirSync(join(DIST, 'generated', 'rulesets'), { recursive: true });
  mkdirSync(join(DIST, 'generated', 'generic-cosmetic'), { recursive: true });
  for (const f of readdirSync(join(GEN, 'rulesets'))) {
    cpSync(join(GEN, 'rulesets', f), join(DIST, 'generated', 'rulesets', f));
  }
  const genericDir = join(GEN, 'generic-cosmetic');
  if (existsSync(genericDir)) {
    for (const f of readdirSync(genericDir)) {
      cpSync(join(genericDir, f), join(DIST, 'generated', 'generic-cosmetic', f));
    }
  }
  if (existsSync(join(GEN, 'generic-cosmetic.css'))) {
    cpSync(join(GEN, 'generic-cosmetic.css'), join(DIST, 'generated', 'generic-cosmetic.css'));
  }
}

async function run() {
  assertGenerated();
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  const configs = ENTRIES.map(([src, out, format]) => ({
    ...COMMON,
    entryPoints: [join(SRC, src)],
    outfile: join(DIST, out),
    format,
  }));

  if (watch) {
    const ctxs = await Promise.all(configs.map((c) => context(c)));
    await Promise.all(ctxs.map((c) => c.watch()));
    buildManifest();
    copyStatic();
    console.log('watching for changes… (re-run `npm run compile-filters` if filters change)');
  } else {
    await Promise.all(configs.map((c) => build(c)));
    buildManifest();
    copyStatic();
    const mode = store ? 'store' : 'dev';
    console.log(
      `\nBuilt unpacked extension → dist/  [${mode}]  (chrome://extensions → Load unpacked)`,
    );
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
