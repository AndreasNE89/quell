// $method and $removeparam in the filter → DNR converter (review 2026-09-24 M5/M6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine } from '../scripts/lib/parse-filter.mjs';
import { toDnrRule } from '../scripts/lib/to-dnr.mjs';
import { PRIORITY } from '../scripts/lib/limits.mjs';

const convert = (line) => toDnrRule(parseLine(line));

test('$method maps to lowercase requestMethods', () => {
  // Chrome rejects uppercase values ("Value must be one of connect, delete, get, …").
  const post = convert('||void.nicopr.fr/rec$method=POST');
  assert.equal(post.rule.action.type, 'block');
  assert.deepEqual(post.rule.condition.requestMethods, ['post']);

  const several = convert('||speedrun.com/api/v2/PutSessionPing^$xhr,1p,method=post|put');
  assert.deepEqual(several.rule.condition.requestMethods, ['post', 'put']);
  assert.equal(several.rule.condition.domainType, 'firstParty');

  const negated = convert('||x.example^$method=~get|~head');
  assert.deepEqual(negated.rule.condition.excludedRequestMethods, ['get', 'head']);
  assert.equal(negated.rule.condition.requestMethods, undefined);
});

test('$method keeps its exceptions and other unsupported options honest', () => {
  const allow = convert('@@*$xhr,method=head|get,domain=app.axenthost.com,3p');
  assert.equal(allow.rule.action.type, 'allow');
  assert.deepEqual(allow.rule.condition.requestMethods, ['head', 'get']);
  // An unknown verb or an option we still can't express skips the whole filter.
  assert.equal(convert('||x.example^$method=brew').skip, 'unsupported:method');
  assert.equal(convert('||x.example^$xhr,method=get,header=x-a').skip, 'unsupported:header');
  assert.equal(convert('||x.example^$method=get|~get').skip, 'no-request-methods');
});

test('bare $removeparam clears the whole query', () => {
  const { rule } = convert('||tracker.example^$removeparam');
  assert.equal(rule.action.type, 'redirect');
  assert.deepEqual(rule.action.redirect.transform, { query: '' });
  assert.equal(rule.priority, PRIORITY.REMOVEPARAM);
  // Like the named form, a typeless strip reaches the address bar too.
  assert.ok(rule.condition.resourceTypes.includes('main_frame'));
  assert.deepEqual(convert('||x.example^$xhr,removeparam').rule.condition.resourceTypes, ['xmlhttprequest']);
});

test('@@$removeparam sits between the strips and the blocks', () => {
  // ubo-filters: the exception exists so adultswim live streams keep ssaiProfile.
  const out = convert('@@||medium.ngtv.io/v2/media/live*$xhr,removeparam=ssaiProfile,domain=adultswim.com');
  assert.equal(out.rule.action.type, 'allow');
  assert.equal(out.rule.priority, PRIORITY.REMOVEPARAM_ALLOW);
  assert.deepEqual(out.rule.condition.initiatorDomains, ['adultswim.com']);
  assert.ok(PRIORITY.REMOVEPARAM < PRIORITY.REMOVEPARAM_ALLOW);
  assert.ok(PRIORITY.REMOVEPARAM_ALLOW < PRIORITY.BLOCK, 'never out-ranks a block');

  const bare = convert('@@||tracker.example^$removeparam');
  assert.equal(bare.rule.priority, PRIORITY.REMOVEPARAM_ALLOW);
  // Even in its low band, an unscoped exception would switch every strip off: refuse it.
  assert.equal(convert('@@$removeparam=utm_source').skip, 'too-broad-allow');
});
