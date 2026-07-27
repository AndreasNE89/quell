// Every var(--x) used without a fallback must actually be defined in that stylesheet.
//
// A custom property that does not exist makes the whole declaration invalid at computed-value
// time, so the rule silently does nothing — `border-top: 1px solid var(--nope)` renders as no
// border at all rather than as an error. Nothing in a typecheck or a unit test sees it, and in
// a popup it is easy to miss by eye.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIRS = ['src/popup', 'src/options', 'src/content'];

function stylesheets() {
  const out = [];
  for (const dir of DIRS) {
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.css')) out.push(join(dir, name));
    }
  }
  return out;
}

/** `var(--x)` with no comma — i.e. no fallback to fall back to. */
function usedWithoutFallback(css) {
  return [...css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((m) => m[1]);
}

function defined(css) {
  return new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
}

test('stylesheets exist to check', () => {
  assert.ok(stylesheets().length >= 3);
});

for (const file of stylesheets()) {
  test(`${file}: no undefined custom properties`, () => {
    const css = readFileSync(file, 'utf8');
    const known = defined(css);
    const missing = [...new Set(usedWithoutFallback(css))].filter((v) => !known.has(v));
    assert.deepEqual(
      missing,
      [],
      `${file} uses ${missing.join(', ')} without defining it and without a fallback — ` +
        'those declarations are dropped at computed-value time.',
    );
  });
}

test('the detector catches a genuinely missing property', () => {
  // Guards the test itself: a regex that matched nothing would make every file above pass.
  const css = ':root { --a: red; }\n.x { color: var(--a); border: 1px solid var(--nope); }';
  const missing = [...new Set(usedWithoutFallback(css))].filter((v) => !defined(css).has(v));
  assert.deepEqual(missing, ['--nope']);
});

test('a var with a fallback is not reported', () => {
  const css = '.x { color: var(--absent, #b4443a); }';
  assert.deepEqual(usedWithoutFallback(css), []);
});
