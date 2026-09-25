// No shipped ruleset may block YouTube's own video stream, now or once time moves on.
//
// uBlock Origin's Quick fixes list carried `/\.googlevideo\.com\/videoplayback\?expire=(?:[02-9]\d+|
// 1[1-68-9]\d+|17[1-7]\d+)&/$xhr,3p,method=get,domain=www.youtube.com`: it lets through the
// `expire=` stamps of these months (178…/179…) and blocks every stream from 2027-01-15, when the
// stamps reach 18…. uBO refreshes Quick fixes every 12 hours; a snapshot compiled into StampStack
// stays until the next release, so every YouTube video would stop playing on that day. Quick fixes
// is left out for that reason, and this pins the result for any list, today's or a later one.
//
// Reads src/generated/rulesets (npm run compile-filters) and matches rules the way DNR does, for
// the conditions that decide this request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RULESETS = join(ROOT, 'src', 'generated', 'rulesets');

const INITIATOR = 'www.youtube.com';
const STREAM_HOST = 'rr4---sn-uxax4vopj5qx-q0nl.googlevideo.com';
const stream = (expire) =>
  `https://${STREAM_HOST}/videoplayback?expire=${expire}&ei=Zx0aZ8nKBo&ip=192.0.2.1&id=o-AB1&itag=399` +
  '&aitags=133%2C134&source=youtube&requiressl=yes&mime=video%2Fmp4&dur=212.040&lmt=17&c=WEB&n=QmZ' +
  '&sparams=expire%2Cei&sig=AJfQdSs&rn=1&rbuf=0&pot=MlNk';

/** `host` is `domain` or one of its subdomains. */
const within = (host, domains) => domains.some((d) => host === d || host.endsWith(`.${d}`));

/** DNR urlFilter syntax as a RegExp (`||`, `|`, `^`, `*`). */
function urlFilterRegex(filter, caseSensitive) {
  let src = '';
  let rest = filter;
  if (rest.startsWith('||')) {
    src = '^[a-z][a-z0-9+.-]*://([^/?#]*\\.)?';
    rest = rest.slice(2);
  } else if (rest.startsWith('|')) {
    src = '^';
    rest = rest.slice(1);
  }
  const anchoredEnd = rest.endsWith('|');
  if (anchoredEnd) rest = rest.slice(0, -1);
  for (const ch of rest) {
    if (ch === '*') src += '.*';
    else if (ch === '^') src += '(?:[^a-zA-Z0-9_.%-]|$)';
    else src += ch.replace(/[.+?${}()|[\]\\/]/g, '\\$&');
  }
  if (anchoredEnd) src += '$';
  return new RegExp(src, caseSensitive ? '' : 'i');
}

function blocksStream(rule, url, type) {
  if (rule.action.type !== 'block' && rule.action.type !== 'redirect') return false;
  const c = rule.condition;
  if (c.resourceTypes && !c.resourceTypes.includes(type)) return false;
  if (c.excludedResourceTypes?.includes(type)) return false;
  if (c.requestMethods && !c.requestMethods.includes('get')) return false;
  if (c.excludedRequestMethods?.includes('get')) return false;
  if (c.domainType === 'firstParty') return false;
  if (c.initiatorDomains && !within(INITIATOR, c.initiatorDomains)) return false;
  if (c.excludedInitiatorDomains && within(INITIATOR, c.excludedInitiatorDomains)) return false;
  if (c.requestDomains && !within(STREAM_HOST, c.requestDomains)) return false;
  if (c.excludedRequestDomains && within(STREAM_HOST, c.excludedRequestDomains)) return false;
  const caseSensitive = c.isUrlFilterCaseSensitive === true;
  if (c.regexFilter) return new RegExp(c.regexFilter, caseSensitive ? '' : 'i').test(url);
  if (c.urlFilter) {
    // Cheap first: every literal piece of the filter must occur in the URL.
    const lower = url.toLowerCase();
    const pieces = c.urlFilter.toLowerCase().split(/[*^|]+/).filter(Boolean);
    if (!pieces.every((piece) => lower.includes(piece))) return false;
    return urlFilterRegex(c.urlFilter, caseSensitive).test(url);
  }
  return true;
}

test('the urlFilter reading used below matches the way DNR does', () => {
  const url = stream(1790000000);
  assert.ok(urlFilterRegex('||googlevideo.com^', false).test(url));
  assert.ok(urlFilterRegex('/videoplayback?expire=', false).test(url));
  assert.ok(!urlFilterRegex('||video.com^', false).test(url));
  assert.ok(!urlFilterRegex('|http://', false).test(url));
});

test('no shipped rule blocks a YouTube video stream, today or in the years ahead', (t) => {
  if (!existsSync(RULESETS)) return t.skip('src/generated/rulesets missing: run npm run compile-filters');
  const now = Math.floor(Date.now() / 1000);
  // Now, the day uBO's rule would have turned (2027-01-15), and well past it.
  const stamps = [now + 6 * 3600, 1_800_000_000 + 21_600, 1_850_000_000, 1_900_000_000, 2_000_000_000];
  const hits = [];
  for (const file of readdirSync(RULESETS).filter((f) => f.endsWith('.json'))) {
    const rules = JSON.parse(readFileSync(join(RULESETS, file), 'utf8'));
    for (const rule of rules) {
      for (const type of ['xmlhttprequest', 'media']) {
        const blocked = stamps.filter((s) => blocksStream(rule, stream(s), type));
        if (blocked.length) hits.push(`${file} #${rule.id} (${type}, expire=${blocked.join('|')})`);
      }
    }
  }
  assert.deepEqual(hits, []);
});
