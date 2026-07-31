// Tests for regional list defaults (src/shared/locale-lists.ts).
//
// EasyList/EasyPrivacy/uBO barely cover Chinese ad networks, so a Chinese-locale install had
// weak blocking on the sites those users actually visit. The list is shipped opt-in — regional
// lists are dead weight elsewhere, and the default-enabled set already exceeds Chrome's
// guaranteed 30,000 static rules — so it is switched on only where it earns its place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const { outputFiles } = await build({
  entryPoints: ['src/shared/locale-lists.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'neutral',
});
const { localeDefaultLists, primaryLanguage } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

test('every Chinese locale gets the Chinese list', () => {
  // Simplified and Traditional alike: the list targets Chinese-language sites, not a territory.
  for (const tag of ['zh', 'zh-CN', 'zh-TW', 'zh-HK', 'zh-Hans', 'zh-Hant-TW', 'ZH-cn', 'zh_TW']) {
    assert.deepEqual(localeDefaultLists(tag), ['easylist-china'], `failed for ${tag}`);
  }
});

test('other languages get nothing extra', () => {
  for (const tag of ['en', 'en-GB', 'nb-NO', 'de', 'ja', 'ko', 'ru']) {
    assert.deepEqual(localeDefaultLists(tag), [], `unexpected list for ${tag}`);
  }
});

test('a language that merely starts with the same letters is not matched', () => {
  // "zu" (Zulu) shares a first letter with zh and must not collide.
  assert.deepEqual(localeDefaultLists('zu-ZA'), []);
  assert.deepEqual(localeDefaultLists('zza'), []);
});

test('a missing or malformed UI language yields nothing rather than throwing', () => {
  for (const bad of [null, undefined, '', '   ', '-', '_', '--']) {
    assert.deepEqual(localeDefaultLists(bad), []);
  }
});

test('the primary subtag is extracted from either separator', () => {
  assert.equal(primaryLanguage('zh-TW'), 'zh');
  assert.equal(primaryLanguage('zh_TW'), 'zh');
  assert.equal(primaryLanguage('EN-gb'), 'en');
  assert.equal(primaryLanguage('  zh-CN  '), 'zh');
});

test('every id it returns is a real list in the registry', () => {
  // A default naming a list that does not exist would silently enable nothing.
  const ids = new Set(JSON.parse(readFileSync('filters/lists.json', 'utf8')).lists.map((l) => l.id));
  for (const tag of ['zh-CN', 'zh-TW']) {
    for (const id of localeDefaultLists(tag)) {
      assert.ok(ids.has(id), `${id} is not in filters/lists.json`);
    }
  }
});

test('the Chinese lists ship opt-in, not default-enabled', () => {
  // Turning them on for everyone would push the default set further past Chrome's guarantee and
  // risk a ruleset being dropped for users who gain nothing from it.
  const lists = JSON.parse(readFileSync('filters/lists.json', 'utf8')).lists;
  for (const id of ['easylist-china', 'cjx-annoyance']) {
    const list = lists.find((l) => l.id === id);
    assert.ok(list, `${id} missing from the registry`);
    assert.equal(list.enabledByDefault, false, `${id} must not be default-enabled`);
  }
});
