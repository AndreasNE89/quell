// Service-worker lifecycle through the real worker: a tab that does not answer (B33), an update
// with ExtensionPay slow or hanging (B34), init running twice on start and update, the ruleset
// degrade loop, tabs open across an update (M2), re-verifying the license when the popup opens
// (M16), dark-mode registration syncs racing each other, and the paid-state edge cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bootServiceWorker, capturingWarnings, workerBundleBytes } from './helpers/sw-harness.mjs';

const META = JSON.parse(readFileSync('src/generated/meta.json', 'utf8'));
const DEFAULTS = META.lists.filter((l) => l.enabledByDefault).map((l) => l.id);
const DAY = 24 * 60 * 60 * 1000;
const PAID = () => ({ paid: true, provider: 'extensionpay', verifiedAt: Date.now() });

/** `p`, or the string 'timeout' after `ms`. */
function within(p, ms) {
  let timer;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise((r) => {
      timer = setTimeout(() => r('timeout'), ms);
    }),
  ]);
}

/** A getUser the test answers when it chooses, and a count of calls. */
function heldExtPay() {
  const pending = [];
  const ext = {
    calls: 0,
    getUser: () => {
      ext.calls++;
      return new Promise((resolve) => pending.push(resolve));
    },
    answer: (user) => pending.splice(0).forEach((r) => r(user)),
  };
  return ext;
}

test('a tab that never answers does not hold up the next toggle (B33)', async () => {
  // A tab with an alert() open answers nothing until it is closed.
  const sw = await bootServiceWorker({
    host: 'news.example',
    license: PAID(),
    tabs: [
      { id: 1, url: 'https://news.example/', active: true },
      { id: 2, url: 'https://stuck.example/' },
    ],
    tabMessage: (tabId) => (tabId === 2 ? new Promise(() => {}) : Promise.resolve(null)),
  });
  await sw.settle();
  const t0 = Date.now();
  assert.notEqual(await within(sw.send({ type: 'darkmode:setEnabled', enabled: true }), 3000), 'timeout');
  assert.notEqual(await within(sw.send({ type: 'popup:setPaused', paused: true }), 3000), 'timeout');
  assert.notEqual(
    await within(sw.send({ type: 'lists:setEnabled', id: 'easylist-cookie', enabled: true }), 3000),
    'timeout',
    'settings writes queued behind a broadcast',
  );
  assert.ok(Date.now() - t0 < 2500, `took ${Date.now() - t0} ms`);
  assert.ok(sw.tabMessages().some((m) => m.tabId === 2 && m.msg.type === 'darkmode:refresh'), 'the tab was still told');
});

test('after an update, rulesets and scripts are reconciled before ExtensionPay answers (B34)', async () => {
  // Chrome puts the manifest's rulesets back and drops registered scripts on update.
  const ext = heldExtPay();
  const sw = await bootServiceWorker({
    host: 'news.example',
    settings: { enabledLists: { easyprivacy: false } },
    license: { paid: false, provider: 'extensionpay', verifiedAt: Date.now() - 7 * DAY },
    enabledRulesets: DEFAULTS,
    extpay: ext,
  });
  sw.install({ reason: 'update' });
  await sw.settle();
  assert.ok(!sw.enabledRulesets().includes('easyprivacy'), 'a list the user switched off came back on');
  assert.ok(sw.script('quell-generic-cosmetic'), 'element hiding waited on ExtensionPay');
  assert.ok(ext.calls >= 1, 'the license is still refreshed');
  ext.answer({ paid: false });
  await sw.settle();
});

test('start and update run init once, with one ExtensionPay request', async () => {
  const ext = heldExtPay();
  const sw = await bootServiceWorker({
    host: 'news.example',
    license: { paid: false, provider: 'extensionpay', verifiedAt: Date.now() - 7 * DAY },
    extpay: ext,
  });
  // The module's own wake init and onInstalled's full one start together.
  sw.install({ reason: 'update' });
  sw.startup();
  await sw.settle();
  ext.answer({ paid: false });
  await sw.settle();
  assert.equal(ext.calls, 1);
});

test('a pool that cannot fit a list costs no refused call and no warning on the next wake', async () => {
  const room = DEFAULTS.reduce((n, id) => n + (META.lists.find((l) => l.id === id)?.ruleCount ?? 0), 0);
  const settings = { enabledLists: { 'easylist-cookie': true } };
  let first;
  const firstLog = await capturingWarnings(async () => {
    first = await bootServiceWorker({ host: 'news.example', settings, ruleRoom: room });
    await first.settle();
  });
  const refused = DEFAULTS.concat('easylist-cookie').filter((id) => !first.enabledRulesets().includes(id));
  assert.equal(refused.length, 1, 'one list is left out');
  assert.equal(firstLog.filter((l) => l.includes('pool')).length, 1, firstLog.join('\n'));
  assert.ok(firstLog.some((l) => l.includes(refused[0])), 'the warning names the list left out');

  const left = room - first.enabledRulesets().reduce((n, id) => n + (META.lists.find((l) => l.id === id)?.ruleCount ?? 0), 0);
  let wake;
  const wakeLog = await capturingWarnings(async () => {
    wake = await bootServiceWorker({
      host: 'news.example',
      settings,
      ruleRoom: left,
      enabledRulesets: first.enabledRulesets(),
      session: first.session(),
      registered: first.scripts(),
    });
    await wake.settle();
  });
  assert.deepEqual(wake.rulesetCalls(), [], 'the old loop "dropped" live lists and retried every wake');
  assert.deepEqual(wakeLog.filter((l) => l.includes('pool')), []);
});

test('tabs open across an update get the content script again (M2)', async () => {
  const sw = await bootServiceWorker({
    host: 'news.example',
    tabs: [
      { id: 1, url: 'https://news.example/', active: true },
      { id: 2, url: 'http://intranet/' },
      { id: 3, url: 'https://sleeping.example/', discarded: true },
      { id: 4, url: 'chrome://settings/' },
      { id: 5, url: 'https://chromewebstore.google.com/detail/x' },
    ],
  });
  await sw.settle();
  sw.install({ reason: 'update' });
  await sw.settle();
  const injected = sw.executed().filter((c) => c.files?.includes('content.js'));
  assert.deepEqual(injected.map((c) => c.target.tabId).sort(), [1, 2]);
  for (const c of injected) assert.equal(c.target.allFrames, true);

  // Chrome's own update and a browser update leave the content scripts connected.
  const again = await bootServiceWorker({ host: 'news.example' });
  await again.settle();
  again.install({ reason: 'chrome_update' });
  await again.settle();
  assert.equal(again.executed().filter((c) => c.files?.includes('content.js')).length, 0);
});

test('opening the popup re-verifies the purchase, at most once per ten minutes (M16)', async () => {
  const ext = { calls: 0, getUser: async () => (ext.calls++, { paid: true, email: 'a@b.c' }) };
  const sw = await bootServiceWorker({
    host: 'news.example',
    // Fresh enough that a wake does not ask, stale enough for the popup to.
    license: { paid: false, provider: 'extensionpay', verifiedAt: Date.now() - 60 * 60 * 1000 },
    extpay: ext,
  });
  await sw.settle();
  assert.equal(ext.calls, 0);
  await sw.send({ type: 'popup:get' });
  await sw.settle();
  assert.equal(ext.calls, 1);
  assert.equal(sw.local()['stampstack.license'].paid, true, 'a purchase made elsewhere shows up');
  await sw.send({ type: 'popup:get' });
  await sw.send({ type: 'darkmode:get' });
  await sw.settle();
  assert.equal(ext.calls, 1);
});

test('opening the popup re-verifies a paid stamp from the future', async () => {
  // Within the day of skew loadLicense tolerates, a wake counts it as fresh and it reads as a
  // check made "just now". The popup re-check skipped it, and the in-flight purchase guard then
  // kept it over ExtensionPay's unpaid answer.
  const ext = { calls: 0, getUser: async () => (ext.calls++, { paid: false }) };
  const sw = await bootServiceWorker({
    host: 'news.example',
    settings: { darkModeEnabled: true },
    license: { paid: true, provider: 'extensionpay', verifiedAt: Date.now() + 60 * 60 * 1000 },
    extpay: ext,
  });
  await sw.settle();
  assert.equal(ext.calls, 0);
  assert.ok(sw.script('quell-dark-mode'));
  await sw.send({ type: 'popup:get' });
  await sw.settle();
  assert.equal(ext.calls, 1);
  assert.equal(sw.local()['stampstack.license'].paid, false);
  assert.ok(sw.local()['stampstack.license'].verifiedAt <= Date.now());
  assert.equal(sw.script('quell-dark-mode'), undefined);
});

test('dark mode switched on then off in quick succession leaves nothing registered', async () => {
  // The registration sync ran outside settingsChain: the "on" sync, still registering, finished
  // after the "off" sync had found nothing to remove (9 of 60 fast toggles).
  const sw = await bootServiceWorker({ host: 'news.example', license: PAID(), registerDelay: 30 });
  await sw.settle();
  const on = sw.send({ type: 'darkmode:setEnabled', enabled: true });
  const off = sw.send({ type: 'darkmode:setEnabled', enabled: false });
  await Promise.all([on, off]);
  await sw.settle();
  assert.equal(sw.settings().darkModeEnabled, false);
  assert.equal(sw.script('quell-dark-mode'), undefined, 'the FOUC shell stayed registered with dark mode off');
});

test('a lapsed purchase coming back does not switch dark mode on again', async () => {
  // Dark mode switches itself on for the first unlock only; this buyer had turned it off.
  const sw = await bootServiceWorker({
    host: 'news.example',
    settings: { darkModeEnabled: false },
    license: { paid: false, provider: 'extensionpay', verifiedAt: Date.now() - 20 * DAY },
    local: { 'stampstack.darkUnlockedOnce.v1': true },
    extpay: { getUser: async () => ({ paid: true }) },
  });
  await sw.settle();
  assert.equal(sw.local()['stampstack.license'].paid, true);
  assert.equal(sw.settings()?.darkModeEnabled ?? false, false);
});

test('the first unlock still switches dark mode on', async () => {
  const sw = await bootServiceWorker({
    host: 'news.example',
    settings: { darkModeEnabled: false },
    license: { paid: false, provider: 'extensionpay', verifiedAt: Date.now() - 20 * DAY },
    extpay: { getUser: async () => ({ paid: true }) },
  });
  await sw.settle();
  assert.equal(sw.settings().darkModeEnabled, true);
  assert.equal(sw.local()['stampstack.darkUnlockedOnce.v1'], true);
  await sw.settle();
  assert.ok(sw.script('quell-dark-mode'));
});

test('a buyer who turned dark mode off after the first unlock keeps it off through a lapse', async () => {
  // No flag seeded: the first unlock records it.
  const answer = { paid: true };
  const sw = await bootServiceWorker({
    host: 'news.example',
    settings: { darkModeEnabled: false },
    license: { paid: false, provider: 'extensionpay', verifiedAt: Date.now() - 20 * DAY },
    extpay: { getUser: async () => ({ ...answer }) },
  });
  await sw.settle();
  assert.equal(sw.settings().darkModeEnabled, true, 'the first unlock switches it on');
  await sw.send({ type: 'darkmode:setEnabled', enabled: false });
  answer.paid = false;
  assert.equal((await sw.send({ type: 'license:refresh' })).paid, false);
  answer.paid = true;
  assert.equal((await sw.send({ type: 'license:refresh' })).paid, true);
  await sw.settle();
  assert.equal(sw.settings().darkModeEnabled, false);
});

test('a buyer from before the first-unlock flag is recorded on start and keeps dark mode off', async () => {
  const answer = { paid: true };
  const sw = await bootServiceWorker({
    host: 'news.example',
    settings: { darkModeEnabled: false },
    license: PAID(),
    extpay: { getUser: async () => ({ ...answer }) },
  });
  sw.startup();
  await sw.settle();
  assert.equal(sw.local()['stampstack.darkUnlockedOnce.v1'], true);
  answer.paid = false;
  await sw.send({ type: 'license:refresh' });
  answer.paid = true;
  await sw.send({ type: 'license:refresh' });
  await sw.settle();
  assert.equal(sw.local()['stampstack.license'].paid, true);
  assert.equal(sw.settings().darkModeEnabled, false);
});

test('a verify stamp from the future does not keep dark mode unlocked', async () => {
  const ext = heldExtPay();
  const sw = await bootServiceWorker({
    host: 'news.example',
    settings: { darkModeEnabled: true },
    license: { paid: true, provider: 'extensionpay', verifiedAt: Date.now() + 365 * DAY },
    extpay: ext,
  });
  await sw.settle();
  const dark = await sw.send({ type: 'darkmode:get', hostname: 'news.example' });
  assert.equal(dark.paid, false);
  assert.equal(sw.script('quell-dark-mode'), undefined);
  assert.ok(ext.calls >= 1, 'it is re-verified instead');
  ext.answer({ paid: true });
  await sw.settle();
  assert.equal((await sw.send({ type: 'darkmode:get', hostname: 'news.example' })).paid, true);
});

test('"Refresh license" says when ExtensionPay could not be reached', async () => {
  const sw = await bootServiceWorker({
    host: 'news.example',
    license: PAID(),
    extpay: { getUser: async () => Promise.reject(new Error('offline')) },
  });
  await sw.settle();
  const orig = console.warn;
  console.warn = () => {};
  try {
    const data = await sw.send({ type: 'license:refresh' });
    assert.equal(data.unreachable, true);
    assert.equal(data.paid, true, 'the cache still counts within grace');
  } finally {
    console.warn = orig;
  }
});

// --- cosmetic data read from the package, not inlined (REVIEW_2026-09-24 B35) ------------

test('the worker no longer carries the cosmetic data in its own script', async () => {
  // Inlined, it was 2.8 MB of object literal V8 parsed on every wake (about 80 ms).
  assert.ok((await workerBundleBytes()) < 1_000_000, `${await workerBundleBytes()} bytes`);
});

test('a wake reads the core only, and a page the enabled lists once', async () => {
  const sw = await bootServiceWorker({ host: 'news.example' });
  await sw.settle();
  assert.deepEqual(sw.fetched(), ['generated/cosmetic/core.json']);
  assert.ok(sw.script('quell-generic-cosmetic'), 'the generic sheet registers from the core');
  const top = { frameId: 0, url: 'https://news.example/', tab: { id: 1, url: 'https://news.example/' } };
  await sw.send({ type: 'cosmetic:get', hostname: 'news.example' }, top);
  await sw.send({ type: 'cosmetic:get', hostname: 'news.example' }, top);
  const lists = sw.fetched().filter((p) => p.includes('/list.')).sort();
  assert.deepEqual(lists, DEFAULTS.map((id) => `generated/cosmetic/list.${id}.json`).sort());
  assert.ok(!sw.fetched().includes('generated/cosmetic/list.easylist-cookie.json'), 'a list that is off is never read');
});

test('frames asking at once after a wake share one assembled dataset', async () => {
  // matchCosmetic's merged view is memoized on the dataset object, one entry deep. Each frame
  // assembling its own object rebuilt the view once per frame, blocking the worker for ~40 ms
  // each in Chromium. Reads of one list's generic hides count the builds.
  const builds = async (frames) => {
    let reads = 0;
    const sw = await bootServiceWorker({
      host: 'news.example',
      packageJson: (path, value) => {
        if (!path.endsWith('/list.easylist.json')) return value;
        const hides = value.hideGeneric;
        Object.defineProperty(value, 'hideGeneric', { get: () => (reads++, hides), enumerable: true });
        return value;
      },
    });
    await sw.settle();
    await Promise.all(
      Array.from({ length: frames }, (_, i) =>
        sw.send(
          { type: 'cosmetic:get', hostname: i ? `ads${i}.example` : 'news.example' },
          {
            frameId: i,
            documentId: `D${i}`,
            url: i ? `https://ads${i}.example/f` : 'https://news.example/',
            tab: { id: 1, url: 'https://news.example/' },
          },
        ),
      ),
    );
    return reads;
  };
  const one = await builds(1);
  assert.ok(one > 0);
  assert.equal(await builds(8), one);
});

test('the answer for a page is the same as with the data inlined', async () => {
  // www.google.de/search: an entity exception reverts the generic sheet; a specific hide list.
  const sw = await bootServiceWorker({ host: 'www.google.de' });
  await sw.settle();
  const url = 'https://www.google.de/search?q=x';
  const r = await sw.send(
    { type: 'cosmetic:get', hostname: 'www.google.de' },
    { frameId: 0, url, documentId: 'SERP', tab: { id: 1, url } },
  );
  assert.equal(r.disableGeneric, true);
  assert.ok(r.hide.length > 0);
  await sw.settle();
  // The whole generic set is undone, by the packaged revert twins of the registered sheets.
  const reverts = sw.script('quell-generic-cosmetic').css.map((f) => f.replace(/\.css$/, '.revert.css'));
  const inserted = sw.cssCalls().filter((c) => c.op === 'insert' && c.origin === 'AUTHOR');
  assert.deepEqual(inserted.map((c) => c.files), [reverts]);
});

test('unreadable cosmetic data leaves the other registrations working', async () => {
  const first = await bootServiceWorker({ host: 'news.example' });
  await first.settle();
  const generic = structuredClone(first.script('quell-generic-cosmetic'));
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.map(String).join(' '));
  try {
    const sw = await bootServiceWorker({
      host: 'news.example',
      settings: { allowlist: ['off.example'] },
      registered: first.scripts(),
      missingFiles: ['generated/cosmetic/core.json'],
    });
    await sw.settle();
    assert.deepEqual(sw.script('quell-generic-cosmetic'), generic, 'kept as it was');
    assert.ok(sw.script('quell-scriptlets-youtube').excludeMatches.includes('*://*.off.example/*'));
  } finally {
    console.error = orig;
  }
  assert.ok(logged.some((l) => l.includes('cosmetic data unreadable')));
});

test('the build writes the cosmetic data files the worker fetches', () => {
  // Without them a fresh install registers no generic sheet and hides nothing site-specific.
  const build = readFileSync('scripts/build.mjs', 'utf8');
  assert.match(build, /cosmeticDataFiles/, 'scripts/build.mjs must write scripts/lib/cosmetic-files.mjs output into dist');
});
