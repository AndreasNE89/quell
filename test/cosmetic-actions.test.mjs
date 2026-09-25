// uBO action operators and other selector shapes the runtime cannot hide by (REVIEW_2026-09-24
// B12): `:style()`, `:remove-attr()` and `:remove-class()` compile to action records; `:others()`,
// `:matches-media()`, `:shadow()` and shapes the procedural engine would widen are skipped and
// counted. None of them may reach the content script as a hide: shipped as one, hianime.ms's
// `:remove-class(is-locked)` hid the play button and networkhint.com's `:style(display: block)`
// hid the captcha form.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLine, preprocessFilterText } from '../scripts/lib/parse-filter.mjs';
import {
  analyzeCosmeticBody,
  validStyleDeclarations,
  topLevelFunctions,
} from '../scripts/lib/procedural-ops.mjs';
import { applyCosmeticRule, emptyCosmeticBucket, serializeBucket } from '../scripts/lib/cosmetic-compile.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let engine;

before(async () => {
  const out = await build({
    stdin: {
      contents: `export { matchCosmetic } from './src/engine/cosmetic-match.ts';`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
  });
  engine = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
});

/** Compile filter lines into one list's cosmetic.json bucket, with the skip counts. */
function compile(lines) {
  const cos = emptyCosmeticBucket();
  const skips = {};
  for (const line of lines) {
    const p = parseLine(line);
    if (p?.type === 'cosmetic') applyCosmeticRule(p, cos, { cosmetic: 0 }, skips);
  }
  return { bucket: serializeBucket(cos), skips };
}

function asData(bucket, networkExceptions = {}) {
  return {
    byList: { l: bucket },
    networkExceptions: { generichide: {}, elemhide: {}, specifichide: {}, ...networkExceptions },
  };
}

test('action operators split into what they act on and what they do', () => {
  assert.deepEqual(analyzeCosmeticBody('.pi-btn--play.pi-btn:watch-attr(disabled):remove-class(is-locked)'), {
    kind: 'action',
    selector: '.pi-btn--play.pi-btn:watch-attr(disabled)',
    procedural: true,
    action: 'remove-class',
    arg: 'is-locked',
  });
  assert.deepEqual(analyzeCosmeticBody('.g-recaptcha:upward(form > div):style(display: block !important;)'), {
    kind: 'action',
    selector: '.g-recaptcha:upward(form > div)',
    procedural: true,
    action: 'style',
    arg: 'display: block !important;',
  });
  // The action applies to the whole selector list before it.
  assert.deepEqual(analyzeCosmeticBody('html, html > body:style(overflow: auto !important;)'), {
    kind: 'action',
    selector: 'html, html > body',
    procedural: false,
    action: 'style',
    arg: 'overflow: auto !important;',
  });
  assert.equal(analyzeCosmeticBody('#clickfakeplayer:remove-attr(href)').action, 'remove-attr');
});

test('selectors are classified the way the runtime will evaluate them', () => {
  const kind = (b) => {
    const a = analyzeCosmeticBody(b);
    return a.kind === 'unsupported' ? `unsupported:${a.reason}` : a.kind;
  };
  // Native `:has()` is CSS (Chrome 105+), so it goes into the stylesheet.
  assert.equal(kind('div:has(> .x)'), 'css');
  assert.equal(kind('li:nth-child(2n+1 of .ad)'), 'css');
  assert.equal(kind('a[href*=":has-text("]'), 'css', 'text inside an attribute value is not an operator');
  assert.equal(kind('.x:has-text(y)'), 'procedural');
  assert.equal(kind('.a:upward(2)'), 'procedural');
  assert.equal(kind('div.item:has(span:has-text(ad))'), 'procedural');
  assert.equal(kind('.ad:has-text(x):not(.keep)'), 'procedural');
  // Nothing here implements these.
  assert.equal(kind('#wpsafe-generate, #wpsafe-link:others()'), 'unsupported:others');
  assert.equal(kind('.grid:matches-media((min-width: 1280px)):style(x: y)'), 'unsupported:matches-media');
  assert.equal(kind('body > div:shadow(div)'), 'unsupported:shadow');
  // An action must end the filter.
  assert.equal(kind('.x:style(color: red):remove()'), 'unsupported:style-not-last');
  assert.equal(kind(':style(color: red)'), 'unsupported:style-without-selector');
  // procedural.ts evaluates these now (plain CSS after an operator, operators nested in
  // :if-not()), and fails closed on an operator it does not know, so they ship.
  assert.equal(kind('.ad:has-text(x):nth-child(2)'), 'procedural');
  assert.equal(kind('.ad:has-text(x):if-not(span:has-text(y))'), 'procedural');
  // An unclosed quote made procedural.ts drop every operator after the prefix.
  assert.equal(kind(".x:has-text(don't)"), 'unsupported:unbalanced');
  assert.deepEqual(topLevelFunctions('.a:not(.b:has(.c)) .d:nth-child(2)').map((f) => f.name), [
    'not',
    'nth-child',
  ]);
});

test(':style() takes declarations only: nothing that closes the rule, escapes or loads a URL', () => {
  assert.equal(validStyleDeclarations('opacity: 1 !important;'), 'opacity: 1 !important;');
  assert.equal(
    validStyleDeclarations('grid-template-columns: minmax(180px,250px) 0 !important; --x: "a;b"'),
    'grid-template-columns: minmax(180px,250px) 0 !important; --x: "a;b"',
  );
  for (const bad of [
    '',
    'color: red} body {display: none',
    'background: url(https://tracker.example/p.gif)',
    'background-image: image-set("a.png" 1x)',
    'content: "\\41"',
    'color: red /* x */',
    '@import "x"',
    'display',
    'width: calc(1px',
    'color: "red',
  ]) {
    assert.equal(validStyleDeclarations(bad), null, bad);
  }
  const p = parseLine('example.com##.x:style(background: url(//evil.example/x))');
  assert.equal(p.kind, 'ignored');
  assert.equal(p.unsupported, 'style-declarations');
});

test('action filters compile to action records, never to hides or procedural rules', () => {
  const { bucket, skips } = compile([
    'hianime.ms##.pi-btn--play.pi-btn:watch-attr(disabled):remove-class(is-locked)',
    'networkhint.com##.g-recaptcha:upward(form > div):style(display: block !important;)',
    'bitdefender.com##body[style="opacity: 0;"]:style(opacity: 1 !important;)',
    'dvdgayonline.com###clickfakeplayer:remove-attr(href)',
    'ufacw.com###wpsafe-generate, #wpsafe-link:others()',
    'glosbe.com##.dictionary-grid:matches-media((min-width: 768px)):style(grid-template-rows: 0 auto !important;)',
    '##.everywhere:style(color: red)',
    'justjared.com##.banner-spacer-top {max-height: 50px !important;}',
  ]);
  assert.deepEqual(bucket.hideSpecific, {});
  assert.deepEqual(bucket.procedural, []);
  assert.deepEqual(bucket.hideGeneric, []);
  assert.deepEqual(
    bucket.actions.map((a) => [a.domains.include[0], a.action, a.selector, a.procedural]),
    [
      ['hianime.ms', 'remove-class', '.pi-btn--play.pi-btn:watch-attr(disabled)', true],
      ['networkhint.com', 'style', '.g-recaptcha:upward(form > div)', true],
      ['bitdefender.com', 'style', 'body[style="opacity: 0;"]', false],
      ['dvdgayonline.com', 'remove-attr', '#clickfakeplayer', false],
    ],
  );
  assert.deepEqual(skips, {
    'cosmetic-unsupported:others': 1,
    'cosmetic-unsupported:matches-media': 1,
    'cosmetic-action-generic:style': 1,
    'cosmetic-unsupported:css-injection': 1,
  });
});

test('the content script gets a page’s actions, and exceptions and $specifichide cancel them', () => {
  const { bucket } = compile([
    'hianime.ms##.pi-btn--play.pi-btn:watch-attr(disabled):remove-class(is-locked)',
    'hianime.ms##.pi-btn--play.pi-btn:remove-attr(disabled)',
    'wp.pl##html, html > body:style(overflow: auto !important;)',
    'tv.wp.pl#@#html, html > body:style(overflow: auto !important;)',
  ]);
  const data = asData(bucket, { specifichide: { l: ['nohide.hianime.ms'] } });
  const m = engine.matchCosmetic('hianime.ms', data, ['l']);
  assert.deepEqual(m.hide, [], 'an action is never a hide');
  assert.deepEqual(m.procedural, []);
  assert.deepEqual(
    m.actions.map((a) => [a.action, a.selector, a.arg, a.procedural]),
    [
      ['remove-class', '.pi-btn--play.pi-btn:watch-attr(disabled)', 'is-locked', true],
      ['remove-attr', '.pi-btn--play.pi-btn', 'disabled', false],
    ],
  );
  assert.equal(engine.matchCosmetic('www.wp.pl', data, ['l']).actions.length, 1);
  assert.deepEqual(engine.matchCosmetic('tv.wp.pl', data, ['l']).actions, [], 'the list exception cancels it');
  assert.deepEqual(engine.matchCosmetic('nohide.hianime.ms', data, ['l']).actions, [], '$specifichide');
});

test('no shipped filter reaches the runtime as a hide or procedural rule with an action or unknown operator', () => {
  const lists = JSON.parse(readFileSync(join(ROOT, 'filters/lists.json'), 'utf8')).lists;
  const offenders = [];
  let actions = 0;
  for (const list of lists) {
    let text;
    try {
      text = readFileSync(join(ROOT, 'filters', list.file), 'utf8');
    } catch {
      continue;
    }
    for (const line of preprocessFilterText(text).lines) {
      const p = parseLine(line);
      if (p?.type !== 'cosmetic') continue;
      if (p.kind === 'action') actions++;
      if (p.kind !== 'hide' && p.kind !== 'procedural') continue;
      const names = topLevelFunctions(p.selector)?.map((f) => f.name) ?? ['unbalanced'];
      if (names.some((n) => /^(style|remove-attr|remove-class|others|matches-media|shadow|unbalanced)$/.test(n))) {
        offenders.push(`${list.id}: ${line}`);
      }
    }
  }
  assert.deepEqual(offenders.slice(0, 5), []);
  assert.ok(actions > 500, `only ${actions} action filters found in the shipped lists`);
});
