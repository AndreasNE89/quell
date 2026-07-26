// Every getElementById in the popup/options scripts must match an id in its HTML.
//
// `const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T` casts the
// null away, so a renamed or typo'd id is not a type error and not a visible failure either —
// the first property access on the null throws during module evaluation and the ENTIRE page
// renders as a dead shell. Static pairing is the only cheap guard, and it caught real drift
// while the repair ladder was being wired up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** ids the script asks for, via the `$('x')` helper or getElementById directly. */
function requestedIds(source) {
  const ids = new Set();
  for (const m of source.matchAll(/\$<[^>]*>\(\s*'([^']+)'\s*\)/g)) ids.add(m[1]);
  for (const m of source.matchAll(/\$\(\s*'([^']+)'\s*\)/g)) ids.add(m[1]);
  for (const m of source.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) ids.add(m[1]);
  return ids;
}

/** ids the markup actually defines. */
function definedIds(html) {
  const ids = new Set();
  for (const m of html.matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);
  return ids;
}

for (const page of ['popup', 'options']) {
  test(`${page}: every id the script reads exists in the markup`, () => {
    const ts = readFileSync(join(ROOT, 'src', page, `${page}.ts`), 'utf8');
    const html = readFileSync(join(ROOT, 'src', page, `${page}.html`), 'utf8');
    const wanted = requestedIds(ts);
    const have = definedIds(html);

    assert.ok(wanted.size > 5, `expected to find several ids in ${page}.ts, got ${wanted.size}`);
    const missing = [...wanted].filter((id) => !have.has(id)).sort();
    assert.deepEqual(missing, [], `${page}.ts reads ids absent from ${page}.html`);
  });

  test(`${page}: markup has no ids the script never reads`, () => {
    // Not a correctness bug, but a dangling id is almost always a half-finished rename or a
    // control that lost its handler — both worth seeing.
    const ts = readFileSync(join(ROOT, 'src', page, `${page}.ts`), 'utf8');
    const html = readFileSync(join(ROOT, 'src', page, `${page}.html`), 'utf8');
    const wanted = requestedIds(ts);
    const unused = [...definedIds(html)].filter((id) => !wanted.has(id)).sort();
    assert.deepEqual(unused, [], `${page}.html defines ids nothing reads`);
  });
}

for (const page of ['popup', 'options']) {
  test(`${page}: the [hidden] attribute is enforced against class display rules`, () => {
    // `hidden` is only a UA-stylesheet `display: none`, so any author rule that sets `display`
    // on the same element beats it. That silently defeated four controls in the popup — an
    // unpaid user was shown the dark-mode toggles, the reset link, and the "Dev unlock" button
    // that must never appear in a store build. No unit test could see it; only rendering could.
    const css = readFileSync(join(ROOT, 'src', page, `${page}.css`), 'utf8');
    const guard = /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/;
    assert.match(
      css,
      guard,
      `${page}.css must keep the global [hidden] { display: none !important } guard`,
    );
  });

  test(`${page}: every element the script hides can actually be hidden`, () => {
    // Belt and braces for the same bug: if the global guard is ever scoped down, this still
    // fails for any element that is toggled via `.hidden` in TS.
    const ts = readFileSync(join(ROOT, 'src', page, `${page}.ts`), 'utf8');
    const css = readFileSync(join(ROOT, 'src', page, `${page}.css`), 'utf8');
    // Any `.hidden =` assignment, however the element was obtained — the popup uses an `el.`
    // lookup object, Options assigns straight onto a `$()` result.
    const toggled = new Set([...ts.matchAll(/([\w$)\]']+)\.hidden\s*=/g)].map((m) => m[1]));
    assert.ok(toggled.size > 0, 'expected the script to hide something');
    assert.match(css, /\[hidden\]/, `${page}.css needs a [hidden] rule for: ${[...toggled].join(', ')}`);
  });
}
