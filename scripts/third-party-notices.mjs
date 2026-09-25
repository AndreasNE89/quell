// THIRD_PARTY_NOTICES.txt — the third-party code inside the shipped bundles, and the
// licences it declares.
//
// The bundles are minified with `legalComments: 'none'`, so without this file the package
// carries no trace of the libraries compiled into it. Every licence among them asks for at
// least its notice to travel with the code: webextension-polyfill is MPL-2.0, and ExtPay
// declares AGPL-3.0-or-later in its package.json while its LICENSE file says LGPL-3.0. This
// file records what each package itself declares and where its source is published; it
// does not decide which of ExtPay's two declarations governs — that is a legal question.
//
// Built from esbuild's metafile rather than a hand-kept list, so a dependency added later
// is listed without anyone remembering to, and one tree-shaken to nothing is not.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/** Package root for a bundled file, or null for our own source. Handles @scope/name. */
function packageRoot(absPath) {
  const marker = `${sep}node_modules${sep}`;
  const at = absPath.lastIndexOf(marker);
  if (at === -1) return null;
  const rest = absPath.slice(at + marker.length).split(sep);
  const depth = rest[0].startsWith('@') ? 2 : 1;
  return absPath.slice(0, at + marker.length) + rest.slice(0, depth).join(sep);
}

/**
 * Every npm package that contributes bytes to any output. `bytesInOutput > 0` is the test,
 * not mere presence in `inputs`: a module esbuild resolved and then tree-shook away ships
 * nothing, and listing it would claim code the package does not contain.
 */
export function bundledPackages(metafiles, workingDir = process.cwd()) {
  const roots = new Set();
  for (const meta of metafiles) {
    for (const output of Object.values(meta.outputs)) {
      for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
        if (bytesInOutput <= 0) continue;
        const root = packageRoot(resolve(workingDir, input));
        if (root) roots.add(root);
      }
    }
  }
  return [...roots].sort();
}

function licenceFiles(root) {
  return readdirSync(root)
    .filter((f) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(f))
    .sort();
}

const RULE = '-'.repeat(78);

export function renderNotices(roots) {
  const sections = roots
    .map((root) => {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
      const lines = [
        `${pkg.name} ${pkg.version}`,
        `Source: https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`,
        ...(repo ? [`Repository: ${repo.replace(/^git\+/, '')}`] : []),
        `Licence declared in its package.json: ${pkg.license ?? '(none)'}`,
      ];
      for (const file of licenceFiles(root)) {
        const text = readFileSync(join(root, file), 'utf8').split('\r\n').join('\n').trim();
        lines.push('', `Its ${file} file:`, '', text);
      }
      return { name: pkg.name, text: lines.join('\n') };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    [
      'Third-party software in this extension',
      '',
      'The JavaScript in this package has the open-source packages below compiled into it.',
      'Each is listed with the licence information it publishes and the address of its',
      'original source.',
      ...sections.flatMap((s) => ['', RULE, s.text]),
    ].join('\n') + '\n'
  );
}

/** Writes the notices for these builds' metafiles to `outFile`. Returns the package names. */
export function writeThirdPartyNotices(metafiles, outFile, workingDir = process.cwd()) {
  const roots = bundledPackages(metafiles, workingDir).filter((root) => existsSync(join(root, 'package.json')));
  writeFileSync(outFile, renderNotices(roots));
  return roots.map((root) => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name);
}
