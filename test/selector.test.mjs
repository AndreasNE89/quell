// Selector generation for the element picker.
//
// The requirement is that a generated selector still matches after a reload. Sites ship
// build-hashed class names, so the *shortest* selector is usually the most fragile one — these
// tests pin the "prefer stable hooks" behavior that makes a pick survive the next deploy.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let mod;

before(async () => {
  const outfile = join(tmpdir(), `quell-selector-${process.pid}.mjs`);
  await build({
    stdin: { contents: `export * from './src/shared/selector.js';`, resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile,
  });
  mod = await import(`file://${outfile}?t=${process.pid}`);
  process.on('exit', () => {
    try {
      rmSync(outfile);
    } catch {
      /* ignore */
    }
  });
});

/** Terse node builder for the snapshot shape buildSelector consumes. */
const node = (tagName, extra = {}) => ({ tagName, ...extra });

test('build-hashed tokens are recognized as unstable', () => {
  for (const t of [
    'css-1x2y3z',
    'sc-fzXfLZ',
    'jsx-1029384756',
    'emotion-9xk2p',
    '_3fKlM',
    '--x1y2z3',
    '8f3a2b1c',
    '1048576',
    'aB3xK9qL2',
  ]) {
    assert.equal(mod.looksGenerated(t), true, `${t} should look generated`);
  }
});

test('human-written tokens are kept', () => {
  for (const t of [
    'ad-slot',
    'sidebar',
    'promo_banner',
    'article-body',
    'nav',
    'cookie-consent',
    'sponsored',
  ]) {
    assert.equal(mod.looksGenerated(t), false, `${t} should look stable`);
  }
});

test('a stable id wins outright', () => {
  const el = node('DIV', { id: 'sidebar-ad', classList: ['a', 'b'] });
  assert.equal(mod.stepFor(el), '#sidebar-ad');
});

test('a hashed id is ignored in favour of a stable class', () => {
  const el = node('DIV', { id: 'r_8f3a2b1c', classList: ['promo-box'] });
  assert.equal(mod.stepFor(el), 'div.promo-box');
});

test('generated classes are filtered out, stable ones kept and capped', () => {
  assert.deepEqual(mod.stableClasses(['css-1a2b3c', 'ad-slot', 'wide', 'extra', '_9fKq2']), [
    'ad-slot',
    'wide',
  ]);
  assert.deepEqual(mod.stableClasses(['css-1a2b3c', '_9fKq2']), []);
});

test('an attribute hook is used when there is no class or id', () => {
  const el = node('DIV', { classList: ['css-1a2b3c'], attrs: { 'data-testid': 'ad-unit' } });
  assert.equal(mod.stepFor(el), 'div[data-testid="ad-unit"]');
});

test('nth-of-type only appears when it disambiguates', () => {
  const lone = node('SPAN', { indexOfType: 0, countOfType: 1 });
  assert.equal(mod.stepFor(lone), 'span');
  const third = node('SPAN', { indexOfType: 2, countOfType: 5 });
  assert.equal(mod.stepFor(third), 'span:nth-of-type(3)');
});

test('the path stops at an id rather than climbing past it', () => {
  const el = node('SPAN', {
    classList: ['label'],
    parent: node('DIV', {
      id: 'promo',
      parent: node('SECTION', { classList: ['wrap'], parent: node('BODY') }),
    }),
  });
  assert.equal(mod.buildSelector(el), '#promo > span.label');
});

test('the path is bounded so an added wrapper cannot break it', () => {
  let deep = node('BODY');
  for (let i = 0; i < 10; i++) deep = node('DIV', { classList: [`level-${i}`], parent: deep });
  const sel = mod.buildSelector(node('SPAN', { classList: ['x'], parent: deep }));
  assert.ok(sel.split('>').length <= 4, `too deep: ${sel}`);
});

test('the walk never includes html or body', () => {
  const el = node('DIV', { classList: ['ad'], parent: node('BODY', { parent: node('HTML') }) });
  const sel = mod.buildSelector(el);
  assert.ok(!/\bbody\b/.test(sel), sel);
  assert.ok(!/\bhtml\b/.test(sel), sel);
});

test('structural elements are not pickable', () => {
  for (const t of ['HTML', 'BODY', 'HEAD', 'SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE']) {
    assert.equal(mod.isPickable(t), false, t);
  }
  for (const t of ['DIV', 'SPAN', 'IFRAME', 'IMG', 'ASIDE']) {
    assert.equal(mod.isPickable(t), true, t);
  }
});

test('the filter line is always domain-scoped', () => {
  // A picker that emitted a global rule would let one click hide an element on every site.
  assert.equal(mod.filterLineFor('example.com', '.ad'), 'example.com##.ad');
  assert.ok(mod.filterLineFor('example.com', '.ad').startsWith('example.com#'));
});

test('special characters in a class are escaped', () => {
  const el = node('DIV', { classList: ['ad:slot'] });
  const step = mod.stepFor(el);
  // Unescaped, `ad:slot` would parse as a pseudo-class and match nothing.
  assert.ok(step.includes('\\'), step);
});

test('a readable prefix with a hash tail is still generated', () => {
  // The common real-world shape: testing the token as a whole misses these entirely.
  for (const t of ['r_8f3a2b1c', 'wrap-1a2b3c', 'item_9xKq2p', 'ad-a1b2c3d4', 'box_deadbeef']) {
    assert.equal(mod.looksGenerated(t), true, `${t} should look generated`);
  }
});

test('ordinary hyphenated names with short numeric parts survive', () => {
  // The length floor is what keeps these out; without it the picker would refuse good hooks.
  for (const t of ['col-md-6', 'data-2024', 'h1-title', 'grid-3', 'ad-slot-2', 'level-0']) {
    assert.equal(mod.looksGenerated(t), false, `${t} should look stable`);
  }
});
