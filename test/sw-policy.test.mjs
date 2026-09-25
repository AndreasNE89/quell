// Per-site policy through the real service worker: the site switch and repair ladder on hosts
// the suffix heuristics refuse (B28), what a ladder step or an Options "Remove" deletes (B29),
// turning blocking back on after the last rung (B30), the ladder reaching YouTube's features
// (B32), list rows while paused or just switched on (B36, B37), and what the page report and
// the breakage report say (B39, breakage-report P3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bootServiceWorker, patternIsValid } from './helpers/sw-harness.mjs';

const allowRules = (sw) => sw.rules().filter((r) => r.action?.type === 'allowAllRequests');

test('go.dev can be switched off, with a rule that covers go.dev alone (B28)', async () => {
  const sw = await bootServiceWorker({ host: 'go.dev' });
  await sw.settle();
  const before = await sw.send({ type: 'popup:get' });
  assert.equal(before.siteActionable, true, 'the popup may offer the switch here');
  assert.equal(before.siteRefusal, null);

  const data = await sw.send({ type: 'popup:toggleSite', hostname: 'go.dev', enabled: false });
  assert.equal(data.applied, true);
  assert.equal(data.allowlisted, true, 'used to answer "on" after storing nothing');
  assert.deepEqual(sw.settings().allowlist, ['go.dev']);
  assert.deepEqual(
    allowRules(sw).map((r) => r.condition),
    [
      { urlFilter: '|https://go.dev^', requestDomains: ['go.dev'], resourceTypes: ['main_frame'] },
      { urlFilter: '|http://go.dev^', requestDomains: ['go.dev'], resourceTypes: ['main_frame'] },
    ],
    'requestDomains alone would also switch off every host under go.dev',
  );
  await sw.settle();
  for (const id of ['quell-generic-cosmetic', 'quell-scriptlets-youtube']) {
    const excl = sw.script(id)?.excludeMatches ?? [];
    assert.ok(excl.includes('*://go.dev/*'), `${id} still runs on go.dev`);
    assert.ok(!excl.some((p) => p.includes('*.go.dev')), `${id} is off under go.dev too`);
    assert.deepEqual(excl.filter((p) => !patternIsValid(p)), []);
  }
  // Elsewhere on go.dev's subdomains, and on the page itself, the worker agrees with the rule.
  const page = (url) => ({ frameId: 0, documentId: 'D', url, tab: { id: 1, url } });
  assert.equal((await sw.send({ type: 'cosmetic:get', hostname: 'go.dev' }, page('https://go.dev/'))).allowlisted, true);
  assert.equal(
    (await sw.send({ type: 'cosmetic:get', hostname: 'pkg.go.dev' }, page('https://pkg.go.dev/'))).allowlisted,
    false,
  );

  // And back on.
  const on = await sw.send({ type: 'popup:toggleSite', hostname: 'go.dev', enabled: true });
  assert.equal(on.allowlisted, false);
  assert.deepEqual(allowRules(sw), []);
});

test('wordpress.com and a single-label intranet host get exact entries; a tenant is its own site (B28)', async () => {
  const sw = await bootServiceWorker({ host: 'intranet' });
  await sw.settle();
  for (const host of ['wordpress.com', 'intranet', 'someblog.wordpress.com']) {
    const r = await sw.send({ type: 'popup:toggleSite', hostname: host, enabled: false });
    assert.equal(r.applied, true, host);
  }
  assert.deepEqual(sw.settings().allowlist.sort(), ['intranet', 'someblog.wordpress.com', 'wordpress.com']);
  const conds = allowRules(sw).map((r) => r.condition);
  assert.ok(conds.some((c) => c.urlFilter === '|https://wordpress.com^'));
  assert.ok(conds.some((c) => c.urlFilter === '|https://intranet^'));
  assert.ok(conds.some((c) => c.requestDomains?.[0] === 'someblog.wordpress.com'));
  // requestDomains holds an exact rule to its host; without the anchored URL it covers tenants.
  assert.ok(
    conds.filter((c) => c.requestDomains?.[0] === 'wordpress.com').every((c) => c.urlFilter?.endsWith('://wordpress.com^')),
    'every tenant would be off',
  );

  // A repair step is keyed the same way.
  await sw.send({ type: 'sitefix:set', hostname: 'lg.com', level: 'cosmetics' });
  assert.deepEqual(sw.settings().siteFixes, { 'lg.com': 'cosmetics' });
  await sw.settle();
  assert.ok(sw.script('quell-generic-cosmetic').excludeMatches.includes('*://lg.com/*'));
});

test('a host no rule can hold is refused out loud, not stored and answered as done (B28)', async () => {
  const sw = await bootServiceWorker({ host: '[::1]' });
  await sw.settle();
  const popup = await sw.send({ type: 'popup:get' });
  assert.equal(popup.siteActionable, false);
  assert.equal(popup.siteRefusal, 'ipv6');
  const r = await sw.send({ type: 'popup:toggleSite', hostname: '[::1]', enabled: false });
  assert.equal(r.applied, false);
  assert.equal(r.allowlisted, false);
  assert.deepEqual(sw.settings()?.allowlist ?? [], []);
});

test('a ladder step on a subdomain leaves the parent fix its sibling hosts rely on (B29)', async () => {
  const sw = await bootServiceWorker({
    host: 'forum.example.com',
    settings: { siteFixes: { 'example.com': 'cosmetics', 'a.forum.example.com': 'cosmetics' } },
  });
  await sw.settle();
  const data = await sw.send({ type: 'sitefix:set', hostname: 'forum.example.com', level: 'injection' });
  assert.deepEqual(sw.settings().siteFixes, {
    'example.com': 'cosmetics',
    'forum.example.com': 'injection',
  });
  assert.equal(data.siteFix, 'injection');
  assert.equal(data.siteFixHost, 'forum.example.com');
});

test('the popup says when a fix is inherited, and stepping back from it restores the parent (B29)', async () => {
  const sw = await bootServiceWorker({
    host: 'forum.example.com',
    settings: { siteFixes: { 'example.com': 'cosmetics', 'other.org': 'cosmetics' } },
  });
  await sw.settle();
  const popup = await sw.send({ type: 'popup:get' });
  assert.equal(popup.siteFix, 'cosmetics');
  assert.equal(popup.siteFixHost, 'example.com');
  const back = await sw.send({ type: 'sitefix:set', hostname: 'forum.example.com', level: null });
  assert.equal(back.siteFix, null);
  assert.deepEqual(sw.settings().siteFixes, { 'other.org': 'cosmetics' });
});

test('Options removes exactly the row it names, never its parent (B29)', async () => {
  const sw = await bootServiceWorker({
    host: 'news.example',
    settings: {
      allowlist: ['example.com', 'shop.example.com'],
      siteFixes: { 'example.com': 'injection', 'forum.example.com': 'cosmetics' },
    },
  });
  await sw.settle();
  const a = await sw.send({ type: 'allowlist:remove', hostname: 'shop.example.com' });
  assert.equal(a.applied, true);
  assert.deepEqual(a.allowlist, ['example.com']);
  assert.deepEqual(
    allowRules(sw).map((r) => r.condition.requestDomains),
    [['example.com']],
  );
  const f = await sw.send({ type: 'sitefix:remove', hostname: 'forum.example.com' });
  assert.deepEqual(f.siteFixes, { 'example.com': 'injection' });
  await sw.settle();
  assert.ok(!sw.script('quell-generic-cosmetic').excludeMatches.includes('*://forum.example.com/*'));
});

test('turning blocking back on after the last rung clears the repair step too (B30)', async () => {
  const sw = await bootServiceWorker({ host: 'shop.example' });
  await sw.settle();
  await sw.send({ type: 'sitefix:set', hostname: 'shop.example', level: 'cosmetics' });
  await sw.send({ type: 'sitefix:set', hostname: 'shop.example', level: 'injection' });
  await sw.send({ type: 'popup:toggleSite', hostname: 'shop.example', enabled: false });
  const on = await sw.send({ type: 'popup:toggleSite', hostname: 'shop.example', enabled: true });
  assert.equal(on.allowlisted, false);
  assert.equal(on.siteFix, null, 'the popup showed green while hiding and scriptlets stayed off');
  assert.deepEqual(sw.settings().siteFixes, {});
  await sw.settle();
  assert.ok(!(sw.script('quell-generic-cosmetic').excludeMatches ?? []).includes('*://shop.example/*'));
  assert.ok(!(sw.script('quell-scriptlets-youtube').excludeMatches ?? []).includes('*://shop.example/*'));
});

test('YouTube options carry the repair step, so the ladder reaches YouTube too (B32)', async () => {
  const sw = await bootServiceWorker({ host: 'www.youtube.com' });
  await sw.settle();
  const url = 'https://www.youtube.com/watch?v=x';
  const top = { frameId: 0, url, tab: { id: 1, url } };
  const ask = () => sw.send({ type: 'youtube:getOptions', hostname: 'www.youtube.com' }, top);
  assert.deepEqual([(await ask()).cosmeticsOff, (await ask()).scriptletsOff], [false, false]);
  await sw.send({ type: 'sitefix:set', hostname: 'www.youtube.com', level: 'cosmetics' });
  assert.deepEqual([(await ask()).cosmeticsOff, (await ask()).scriptletsOff], [true, false]);
  await sw.send({ type: 'sitefix:set', hostname: 'www.youtube.com', level: 'injection' });
  assert.deepEqual([(await ask()).cosmeticsOff, (await ask()).scriptletsOff], [true, true]);
});

test('while paused no list reads as refused by Chrome (B36)', async () => {
  const sw = await bootServiceWorker({ host: 'news.example' });
  await sw.settle();
  await sw.send({ type: 'popup:setPaused', paused: true });
  const data = await sw.send({ type: 'lists:get' });
  assert.equal(data.paused, true);
  assert.equal(data.degraded, false);
  const on = data.lists.filter((l) => l.enabled);
  assert.ok(on.length > 0);
  for (const l of on) assert.deepEqual([l.active, l.refused], [false, false], l.id);
});

test('a list Chrome cannot fit reads as refused, and only that one (B36)', async () => {
  const meta = JSON.parse(readFileSync('src/generated/meta.json', 'utf8'));
  const cookie = meta.lists.find((l) => l.id === 'easylist-cookie');
  const sw = await bootServiceWorker({
    host: 'news.example',
    ruleRoom: meta.lists.filter((l) => l.enabledByDefault).reduce((n, l) => n + l.ruleCount, 0),
  });
  await sw.settle();
  const data = await sw.send({ type: 'lists:setEnabled', id: cookie.id, enabled: true });
  const row = data.lists.find((l) => l.id === cookie.id);
  assert.deepEqual([row.enabled, row.active, row.refused], [true, false, true]);
  assert.equal(data.degraded, true);
  assert.ok(data.lists.filter((l) => l.id !== cookie.id && l.enabled).every((l) => l.active && !l.refused));
});

test('lists:get asked while a toggle is syncing answers with the sync done (B37)', async () => {
  const sw = await bootServiceWorker({ host: 'news.example', rulesetDelay: 50 });
  await sw.settle();
  // Options re-reads on the storage change the toggle makes, which lands while Chrome is still
  // enabling the ruleset.
  const toggled = sw.send({ type: 'lists:setEnabled', id: 'easylist-cookie', enabled: true });
  while (sw.settings()?.enabledLists?.['easylist-cookie'] !== true) {
    await new Promise((r) => setTimeout(r, 0));
  }
  const reread = sw.send({ type: 'lists:get' });
  const [a, b] = await Promise.all([toggled, reread]);
  for (const data of [a, b]) {
    const row = data.lists.find((l) => l.id === 'easylist-cookie');
    assert.deepEqual([row.enabled, row.active, row.refused], [true, true, false]);
  }
});

test('the page report calls a tracker blocked only while a list that blocks it is loaded (B39)', async () => {
  const trackers = JSON.parse(readFileSync('src/generated/trackers.json', 'utf8'));
  // An index that names its lists (compile-filters writes them); a stale one is answered as before.
  const hasLists = Object.values(trackers.domains).some((d) => Array.isArray(d.lists));
  const sw = await bootServiceWorker({
    host: 'news.example',
    tabMessage: async (_tab, msg) =>
      msg.type === 'page:collect' ? { hosts: ['www.google-analytics.com', 'cdn.cookielaw.org'], hiddenCount: 0 } : null,
  });
  await sw.settle();
  const report = await sw.send({ type: 'report:get' });
  assert.equal(report.available, true);
  const onetrust = report.trackers.find((t) => t.host === 'cdn.cookielaw.org');
  if (hasLists && onetrust) {
    // EasyList Cookie is off by default: OneTrust is seen, not blocked.
    assert.equal(onetrust.blocked, false);
  }
  assert.ok(report.trackers.length >= 1);
});

test('the breakage report names the user filters, dark mode, YouTube switches and a refused list', async () => {
  const meta = JSON.parse(readFileSync('src/generated/meta.json', 'utf8'));
  const sw = await bootServiceWorker({
    host: 'www.youtube.com',
    settings: {
      customFilters: 'youtube.com##.promo\nyoutube.com#@#.keep\nother.org##.x\n',
      youtubeBlockShorts: true,
      enabledLists: { 'easylist-cookie': true },
    },
    ruleRoom: meta.lists.filter((l) => l.enabledByDefault).reduce((n, l) => n + l.ruleCount, 0),
  });
  await sw.settle();
  const report = await sw.send({ type: 'report:breakage', hostname: 'www.youtube.com' });
  assert.match(report.body, /your filters:\s+2 for this site/);
  assert.match(report.body, /dark mode:\s+not purchased/);
  assert.match(report.body, /youtube:\s+sponsored hidden, shorts hidden, sponsorblock on/);
  // The pool fits the default lists only, so one list the user asked for is left out.
  const refused = (await sw.send({ type: 'lists:get' })).lists.filter((l) => l.refused).map((l) => l.id);
  assert.equal(refused.length, 1);
  assert.match(report.body, new RegExp(`not loaded:\\s+${refused[0]}`));
  const listsOn = /lists on:\s+(.*)/.exec(report.body)[1].split(', ');
  assert.ok(!listsOn.includes(refused[0]), 'a list Chrome refused is not "on"');
});

test('the picker is refused where its rule could never apply, including from the shortcut', async () => {
  const sw = await bootServiceWorker({ host: 'news.example', settings: { allowlist: ['news.example'] } });
  await sw.settle();
  const r = await sw.send({ type: 'picker:start' });
  assert.deepEqual([r.ok, r.reason], [false, 'allowlisted']);
  assert.equal(sw.executed().length, 0);
  await sw.send({ type: 'popup:toggleSite', hostname: 'news.example', enabled: true });
  await sw.send({ type: 'sitefix:set', hostname: 'news.example', level: 'cosmetics' });
  assert.equal((await sw.send({ type: 'picker:start' })).reason, 'fix');
  await sw.send({ type: 'sitefix:set', hostname: 'news.example', level: null });
  assert.deepEqual(await sw.send({ type: 'picker:start' }), { ok: true });
});
