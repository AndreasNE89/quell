// $badfilter handling in the filter → DNR converter (review 2026-09-24 B8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine } from '../scripts/lib/parse-filter.mjs';
import { toDnrRule, networkFilterIdentity } from '../scripts/lib/to-dnr.mjs';

const convert = (line) => toDnrRule(parseLine(line));
const id = (line) => networkFilterIdentity(parseLine(line));

test('a $badfilter on a cosmetic exception is a badfilter, never the exception itself', () => {
  // Both ship in ubo-filters. Read as exceptions they turned off every cosmetic filter on
  // kobieta.wp.pl and all 13k generic hides on seznamzpravy.cz.
  for (const line of [
    '@@||kobieta.wp.pl^$ehide,badfilter',
    '@@||seznamzpravy.cz^$ghide,badfilter',
    '@@||example.com^$shide,badfilter',
  ]) {
    const out = convert(line);
    assert.equal(out.badfilter, true, line);
    assert.equal(out.cosmeticException, undefined, line);
  }
});

test('a cosmetic-exception badfilter cancels that exception and nothing else', () => {
  const bad = id('@@||kobieta.wp.pl^$ehide,badfilter');
  assert.equal(bad, id('@@||kobieta.wp.pl^$ehide'));
  assert.equal(bad, id('@@||kobieta.wp.pl^$elemhide'), 'uBO alias of the same option');
  assert.notEqual(bad, id('@@||kobieta.wp.pl^'), 'a plain network allow is a different filter');
  assert.notEqual(bad, id('@@||kobieta.wp.pl^$ghide'));
});

test('options the converter cannot map still tell badfilter identities apart', () => {
  // `||thegay.com^$csp=…,badfilter` must not cancel a plain `||thegay.com^` block.
  assert.notEqual(id('||thegay.com^$csp=script-src,badfilter'), id('||thegay.com^'));
  assert.equal(id('||thegay.com^$csp=script-src,badfilter'), id('||thegay.com^$csp=script-src'));
  assert.notEqual(id('*$popup,3p,domain=ds2play.com,badfilter'), id('*$3p,domain=ds2play.com'));
  assert.notEqual(id('||x.example^$method=post,badfilter'), id('||x.example^'));
  // $redirect-rule and $redirect are different filters in uBO.
  assert.notEqual(
    id('||x.example/a.js$script,redirect-rule=noopjs,badfilter'),
    id('||x.example/a.js$script,redirect=noopjs'),
  );
  // Option names are case-insensitive; values are not rewritten.
  assert.equal(id('||x.example^$CSP=script-src,badfilter'), id('||x.example^$csp=script-src'));
});
