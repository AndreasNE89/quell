// Generate StampStack toolbar/store icons (16/32/48/128) from brand source art.
// Requires Python 3 + Pillow (`pip install pillow`). Source: store/brand/stampstack-source.png

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = join(__dirname, 'render-brand-assets.py');

console.log('== StampStack icons + promo ==');
const r = spawnSync('python', [script], { stdio: 'inherit', shell: true });
if (r.status !== 0) {
  console.error('Icon render failed. Install Pillow: python -m pip install pillow');
  process.exit(r.status ?? 1);
}
