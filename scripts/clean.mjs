// Remove build outputs.
import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const p of ['dist', join('src', 'generated')]) {
  rmSync(join(ROOT, p), { recursive: true, force: true });
  console.log(`  removed ${p}`);
}
