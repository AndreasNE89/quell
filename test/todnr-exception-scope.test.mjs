// Exception (`@@`) domain scope in the filter → DNR converter (review 2026-09-24 B6).
// An exception may be narrowed when converted, never widened: a wider allow unblocks traffic
// the filter list meant to keep blocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLine } from '../scripts/lib/parse-filter.mjs';
import { toDnrRule } from '../scripts/lib/to-dnr.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const convert = (line) => toDnrRule(parseLine(line));
const rulesOf = (out) => out.rules ?? (out.rule ? [out.rule] : []);

test('a suffix-only domain= list stays on a URL-scoped exception', () => {
  // EasyPrivacy. With wordpress.com stripped, the Jetpack tracker was allowed on every site.
  const wp = convert('@@||stats.wp.com/w.js$script,domain=wordpress.com');
  assert.equal(wp.rule.action.type, 'allow');
  assert.deepEqual(wp.rule.condition.initiatorDomains, ['wordpress.com']);

  const tld = convert('@@||cdn.example.net/ads.js$script,domain=co.uk');
  assert.deepEqual(tld.rule.condition.initiatorDomains, ['co.uk']);

  const to = convert('@@||cdn.example.net/ads.js$script,to=shop|autos');
  assert.deepEqual(to.rule.condition.requestDomains, ['shop', 'autos']);
});

test('a suffix-only list with nothing else to scope the rule is still skipped', () => {
  assert.equal(convert('@@$script,domain=com').skip, 'too-broad-allow');
  assert.equal(convert('@@*$script,domain=wordpress.com').skip, 'too-broad-allow');
  assert.equal(convert('@@$document,to=github.io').skip, 'too-broad-allow-all');
});

test('suffix entries next to real hosts are still stripped (narrowing is safe)', () => {
  const { rule } = convert('@@||cdn.example.net/ads.js$script,domain=real.example|com');
  assert.deepEqual(rule.condition.initiatorDomains, ['real.example']);
});

test('chrome-extension-scheme scope is dead in DNR and never becomes a global allow', () => {
  // EasyList: `@@||lastpass.com/ads.php$subdocument,domain=chrome-extension-scheme` shipped as
  // an allow for that ad frame on every site.
  const lastpass = convert('@@||lastpass.com/ads.php$subdocument,domain=chrome-extension-scheme');
  assert.equal(lastpass.rule, undefined);
  assert.equal(lastpass.skip, 'scheme-domain');
  // Beside a real host the pseudo-host is simply dropped.
  const mixed = convert('@@||x.example/a.js$script,domain=chrome-extension-scheme|real.example');
  assert.deepEqual(mixed.rule.condition.initiatorDomains, ['real.example']);
});

test('no shipped exception is emitted with a wider domain scope than its filter', () => {
  const lists = JSON.parse(readFileSync(join(ROOT, 'filters', 'lists.json'), 'utf8')).lists;
  let checked = 0;
  for (const list of lists) {
    const file = join(ROOT, 'filters', list.file);
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      if (!raw.startsWith('@@')) continue;
      const parsed = parseLine(raw);
      if (!parsed || parsed.type !== 'network') continue;
      const o = parsed.options;
      // A top-level document's `domain=` scopes the request host (see the B9 tests), so
      // either include list may carry it; the union is the most the rule may allow.
      const sourceIncludes = new Set([...o.initiatorDomains, ...o.requestDomains]);
      for (const rule of rulesOf(toDnrRule(parsed))) {
        const c = rule.condition;
        const isDocument = (c.resourceTypes || []).every((t) => t === 'main_frame');
        if (o.initiatorDomains.length && !isDocument) {
          assert.ok(c.initiatorDomains?.length, `${list.id}: ${raw} lost its domain= scope`);
        }
        if (o.requestDomains.length) {
          assert.ok(c.requestDomains?.length, `${list.id}: ${raw} lost its to= scope`);
        }
        for (const d of [...(c.initiatorDomains || []), ...(c.requestDomains || [])]) {
          assert.ok(sourceIncludes.has(d), `${list.id}: ${raw} gained ${d}`);
        }
        checked++;
      }
    }
  }
  assert.ok(checked > 1000, `expected the shipped lists to have exceptions (${checked})`);
});
