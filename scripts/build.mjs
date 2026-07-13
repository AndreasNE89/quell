// Bundle Quell into a loadable unpacked extension in dist/.
//
// - Service worker + popup + options → ESM bundles.
// - Content scripts (content.js, scriptlets.js) → classic IIFE bundles, because
//   manifest-declared content scripts are NOT ES modules.
// - Static assets (HTML/CSS/icons/redirects/rulesets) are copied.
// - The manifest's declarative_net_request.rule_resources is generated from meta.json.
//
// Assumes `npm run compile-filters` has produced src/generated/. Run via `npm run build`.

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

const COMMON = {
  bundle: true,
  target: 'chrome120',
  platform: 'browser',
  logLevel: 'info',
  legalComments: 'none',
};

/** Entry points: [srcFile, outFile, format]. */
const ENTRIES = [
  ['background/service-worker.ts', 'background.js', 'esm'],
  ['content/content.ts', 'content.js', 'iife'],
  ['content/scriptlets-main.ts', 'scriptlets.js', 'iife'],
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
  manifest.declarative_net_request.rule_resources = meta.lists.map((l) => ({
    id: l.id,
    enabled: l.enabledByDefault,
    path: `generated/${l.rulesetFile}`,
  }));
  writeFileSync(join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

function copyStatic() {
  // HTML + CSS for popup/options.
  for (const [dir, files] of [
    ['popup', ['popup.html', 'popup.css']],
    ['options', ['options.html', 'options.css']],
  ]) {
    for (const f of files) cpSync(join(SRC, dir, f), join(DIST, f));
  }
  // Icons, redirect resources.
  cpSync(join(SRC, 'icons'), join(DIST, 'icons'), { recursive: true });
  cpSync(join(SRC, 'redirects'), join(DIST, 'redirects'), { recursive: true });
  // Generated DNR rulesets + per-list generic cosmetic CSS.
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
    // Rebuild static bits once; JS rebuilds on change.
    buildManifest();
    copyStatic();
    console.log('watching for changes… (re-run `npm run compile-filters` if filters change)');
  } else {
    await Promise.all(configs.map((c) => build(c)));
    buildManifest();
    copyStatic();
    console.log(`\nBuilt unpacked extension → dist/  (load it via chrome://extensions → Load unpacked)`);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
