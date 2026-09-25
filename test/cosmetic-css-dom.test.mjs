// Compiled cosmetic CSS against a real CSS parser and cascade (Playwright Chromium).
//
// Node has no CSS parser, so what the compiler emits is checked where it is used: Blink ignores
// the selectors of one rule past component 8,192 (so the old single-rule revert of 13,923
// selectors left generic hiding on for most of them, B16), one invalid selector drops its whole
// rule (B19), and `:style()` declarations must make exactly one style rule (B12).
//
// Skips (does not fail) when Chromium cannot be launched.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLine, preprocessFilterText } from '../scripts/lib/parse-filter.mjs';
import { genericCssText } from '../scripts/lib/cosmetic-compile.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let browser;
let launchError;

before(async () => {
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    launchError = e;
  }
});

after(async () => {
  await browser?.close();
});

/** A blank page with `css` applied as stylesheets, in order. */
async function pageWith(sheets, body) {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><head></head><body>${body}</body></html>`);
  for (const content of sheets) await page.addStyleTag({ content });
  return page;
}

const display = (page, id) => page.$eval(`#${id}`, (el) => getComputedStyle(el).display);

test('generic reverts are chunked, so every selector of a 9,000-selector set reverts (B16)', async (t) => {
  if (!browser) return t.skip(`Chromium unavailable: ${launchError?.message ?? 'unknown'}`);
  const selectors = Array.from({ length: 9000 }, (_, i) => `.gen-${i}`);
  const body = '<div id="early" class="gen-10"></div><div id="late" class="gen-8900"></div>';
  const hide = genericCssText('t', selectors);
  const page = await pageWith([hide, genericCssText('t', selectors, true)], body);
  assert.notEqual(await display(page, 'early'), 'none');
  assert.notEqual(await display(page, 'late'), 'none');
  await page.close();

  // What a single rule does (the shape of the per-page revert before): past component 8,192 the
  // revert is ignored and the generic hide stays.
  const single = `${selectors.join(',\n')} { display: revert !important; }`;
  const control = await pageWith([hide, single], body);
  assert.notEqual(await display(control, 'early'), 'none');
  const late = await display(control, 'late');
  await control.close();
  if (late !== 'none') t.diagnostic('this Chromium applies selectors past component 8,192');
});

test('a selector Chromium rejects does not take the other generic hides down with it (B19)', async (t) => {
  if (!browser) return t.skip(`Chromium unavailable: ${launchError?.message ?? 'unknown'}`);
  // `:has()` may not nest in `:has()`; `::-moz-selection` is Firefox-only.
  const selectors = ['.plain-a', '.x:has(.y:has(.z))', '::-moz-selection', '.plain-b'];
  const body = '<div id="a" class="plain-a"></div><div id="b" class="plain-b"></div>';
  const page = await pageWith([genericCssText('t', selectors)], body);
  assert.equal(await display(page, 'a'), 'none');
  assert.equal(await display(page, 'b'), 'none');
  await page.close();
  const control = await pageWith([`${selectors.join(',\n')} { display: none !important; }`], body);
  assert.equal(await display(control, 'a'), 'block', 'one bad selector drops a joined rule');
  await control.close();
});

test('every shipped :style() action is one style rule with its declarations, nothing more (B12)', async (t) => {
  if (!browser) return t.skip(`Chromium unavailable: ${launchError?.message ?? 'unknown'}`);
  const rules = [];
  for (const list of JSON.parse(readFileSync(join(ROOT, 'filters/lists.json'), 'utf8')).lists) {
    let text;
    try {
      text = readFileSync(join(ROOT, 'filters', list.file), 'utf8');
    } catch {
      continue;
    }
    for (const line of preprocessFilterText(text).lines) {
      const p = parseLine(line);
      if (p?.kind === 'action' && p.action === 'style' && !p.procedural) {
        rules.push({ line, css: `${p.target} { ${p.arg} }` });
      }
    }
  }
  assert.ok(rules.length > 400, `only ${rules.length} :style() actions`);
  const page = await browser.newPage();
  const results = await page.evaluate((list) => {
    return list.map(({ css }) => {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        const r = sheet.cssRules;
        return { count: r.length, style: r[0] instanceof CSSStyleRule, decls: r[0]?.style?.length ?? 0 };
      } catch (e) {
        return { error: String(e) };
      }
    });
  }, rules);
  await page.close();
  const escaped = rules.filter((_, i) => results[i].count > 1 || (results[i].count === 1 && !results[i].style));
  assert.deepEqual(escaped.map((r) => r.line), [], 'a declaration list escaped its rule');
  const ok = results.filter((r) => r.count === 1 && r.style && r.decls > 0).length;
  t.diagnostic(`${ok} of ${rules.length} :style() rules apply`);
  // The rest carry a selector Chromium rejects; the content script drops those one by one.
  assert.ok(ok / rules.length > 0.97, `${rules.length - ok} of ${rules.length} :style() rules do not apply`);
});

test('every chunk of every shipped generic sheet parses, so no selector takes 499 others down (B19)', async (t) => {
  if (!browser) return t.skip(`Chromium unavailable: ${launchError?.message ?? 'unknown'}`);
  const dir = join(ROOT, 'src', 'generated', 'generic-cosmetic');
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.css'));
  } catch {
    return t.skip('src/generated/generic-cosmetic is missing: run npm run compile-filters');
  }
  // Rules as the compiler writes them: `sel,\nsel,\n… { decl }`, one per line group.
  const rules = [];
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8').replace(/\/\*[^]*?\*\//g, '');
    for (const chunk of text.split(/\}\s*/)) {
      if (!chunk.trim()) continue;
      const selectors = chunk.slice(0, chunk.indexOf('{')).split(',\n').length;
      rules.push({ file: f, css: `${chunk}}`, selectors });
    }
  }
  assert.ok(rules.length > 100, `only ${rules.length} generic rules`);
  const page = await browser.newPage();
  const parsed = await page.evaluate((list) => {
    const sheet = new CSSStyleSheet();
    return list.map(({ css }) => {
      try {
        sheet.replaceSync(css);
        return sheet.cssRules.length === 1 && sheet.cssRules[0] instanceof CSSStyleRule;
      } catch {
        return false;
      }
    });
  }, rules);
  await page.close();
  // A chunk that fails to parse loses every selector in it. The compiler gives each selector it
  // cannot vouch for a rule of its own, so only those may fail, and they fail alone.
  const lostChunks = rules.filter((r, i) => !parsed[i] && r.selectors > 1);
  assert.deepEqual(lostChunks.map((r) => `${r.file}: ${r.css.slice(0, 80)}`), []);
  const lone = rules.filter((r, i) => !parsed[i]).length;
  t.diagnostic(`${rules.length} generic rules, ${lone} single-selector rules Chromium rejects`);
});
