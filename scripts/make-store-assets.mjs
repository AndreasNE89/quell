// Generate Chrome Web Store promo tile (440×280) from StampStack brand art.
// Same pipeline as npm run icons (scripts/render-brand-assets.py).

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = join(__dirname, 'render-brand-assets.py');

console.log('== StampStack store assets ==');
const r = spawnSync('python', [script], { stdio: 'inherit', shell: true });
if (r.status !== 0) {
  console.error('Store asset render failed. Install Pillow: python -m pip install pillow');
  process.exit(r.status ?? 1);
}
console.log('Upload store/promo-small.png as Small promotional tile in Chrome Web Store Dashboard.');
