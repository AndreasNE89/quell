// SponsorBlock's player loop (src/content/sponsorblock.ts) against a fake page: which requests
// it sends, when it retries, and what it skips. Each test imports a fresh copy of the module,
// drives its 200 ms tick by hand and owns the clock the retry backoff reads.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rmSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = join(tmpdir(), `stampstack-sb-runtime-${process.pid}.mjs`);
let copies = 0;
const realNow = Date.now;

before(async () => {
  await build({
    stdin: {
      contents: `export * from './src/content/sponsorblock.ts';`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile,
    logLevel: 'silent',
  });
});

after(() => {
  Date.now = realNow;
  delete globalThis.chrome;
  rmSync(outfile, { force: true });
});

/** A module instance of its own: no state carried over from another test. */
function freshModule() {
  return import(`${pathToFileURL(outfile).href}?copy=${++copies}`);
}

function fakeElement() {
  return {
    style: {},
    children: [],
    parentElement: null,
    listeners: {},
    setAttribute() {},
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    append(...c) {
      this.children.push(...c);
    },
    appendChild(c) {
      c.parentElement = this;
      this.children.push(c);
    },
    set textContent(v) {
      if (v === '') this.children = [];
      this.text = v;
    },
    get textContent() {
      return this.text;
    },
  };
}

function fakePlayer(video) {
  const classes = new Set();
  return {
    classes,
    classList: { contains: (c) => classes.has(c) },
    querySelector: (sel) => (sel.startsWith('video') ? video : null),
  };
}

function fakeVideo({ duration = 600, paused = false } = {}) {
  const video = {
    paused,
    duration,
    t: 0,
    seeks: [],
    get currentTime() {
      return this.t;
    },
    set currentTime(v) {
      this.seeks.push([this.t, v]);
      this.t = v;
    },
  };
  return video;
}

/**
 * A YouTube page at `href` with #movie_player playing `video`. `byId` adds elements by id and
 * `query` answers for document.querySelector (the miniplayer's ytd-app and ytd-watch-flexy).
 */
function fakePage(href, { video = fakeVideo(), byId = {}, query = {} } = {}) {
  const setUrl = (h) => {
    const u = new URL(h);
    globalThis.location = { href: h, hostname: u.hostname, pathname: u.pathname, search: u.search };
  };
  setUrl(href);
  const player = fakePlayer(video);
  const ids = { movie_player: player, ...byId };
  const docListeners = {};
  const root = fakeElement();
  // Whichever way the module looks for the watch player's video, it finds this one.
  const watchVideo = { '#movie_player video.html5-main-video': video, '#movie_player video': video, 'ytd-player video': video };
  globalThis.document = {
    fullscreenElement: null,
    documentElement: root,
    body: root,
    addEventListener(type, fn) {
      (docListeners[type] ||= []).push(fn);
    },
    removeEventListener() {},
    getElementById: (id) => ids[id] ?? null,
    querySelector: (sel) => query[sel] ?? watchVideo[sel] ?? null,
    querySelectorAll: (sel) => (sel === 'video' ? [video] : []),
    createElement: () => fakeElement(),
  };
  const intervals = [];
  const win = {
    setInterval(fn) {
      intervals.push(fn);
      return intervals.length;
    },
    clearInterval() {},
    setTimeout: () => 0,
    clearTimeout() {},
    addEventListener() {},
    removeEventListener() {},
  };
  win.top = win;
  globalThis.window = win;
  return {
    video,
    player,
    root,
    tick: () => intervals.forEach((f) => f()),
    navigate(h) {
      setUrl(h);
      for (const f of docListeners['yt-navigate-finish'] ?? []) f();
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function opts(over = {}) {
  return {
    paused: false,
    allowlisted: false,
    cosmeticsOff: false,
    scriptletsOff: false,
    youtubeBlockSponsored: true,
    youtubeBlockShorts: false,
    youtubeSponsorBlock: true,
    sponsorBlockCategories: ['sponsor'],
    ...over,
  };
}

const SPONSOR = { category: 'sponsor', actionType: 'skip', segment: [10, 20], UUID: 's1' };

/** Count calls, answer with `answer(videoId, callNumber)`. */
function fetcher(answer = () => [SPONSOR]) {
  const calls = [];
  const fn = async (videoId) => {
    calls.push(videoId);
    return answer(videoId, calls.length);
  };
  fn.calls = calls;
  return fn;
}

test('switching off the last category stops skipping the video on screen (B60)', async () => {
  const sb = await freshModule();
  const page = fakePage('https://www.youtube.com/watch?v=AAAAAAAAAAA');
  let current = opts();
  const fetchSegments = fetcher();
  sb.startSponsorBlock({ getOpts: () => current, fetchSegments });
  await flush();
  assert.equal(fetchSegments.calls.length, 1);

  // Options: Sponsor unticked, "every category is off".
  current = opts({ sponsorBlockCategories: [] });
  sb.refreshSponsorBlock();
  await flush();
  page.video.t = 10.5;
  page.tick();
  assert.deepEqual(page.video.seeks, [], 'skipped a category the user had just switched off');
  assert.equal(fetchSegments.calls.length, 1, 'no category means no request');

  current = opts();
  sb.refreshSponsorBlock();
  await flush();
  page.tick();
  assert.deepEqual(page.video.seeks, [[10.5, 20]], 'switching it back on skips again');
});

test('a page load and later unrelated settings writes send one request and keep the segments (B63)', async () => {
  const sb = await freshModule();
  const page = fakePage('https://www.youtube.com/watch?v=AAAAAAAAAAA');
  let current = null;
  const fetchSegments = fetcher();
  // content.ts: start before any options, then the storage fast path, then the worker's answer.
  sb.startSponsorBlock({ getOpts: () => current, fetchSegments });
  current = opts();
  sb.refreshSponsorBlock();
  current = opts();
  sb.refreshSponsorBlock();
  await flush();
  assert.equal(fetchSegments.calls.length, 1, 'one video, one category set: one request');

  // Allowlisting some other site, a filter edit, dark mode: the settings blob changes, the
  // YouTube options do not.
  current = { ...opts() };
  sb.refreshSponsorBlock();
  page.video.t = 10.5;
  page.tick();
  assert.deepEqual(page.video.seeks, [[10.5, 20]], 'the refresh wiped the loaded segments');
  await flush();
  assert.equal(fetchSegments.calls.length, 1);

  // A category change on the same video is a new request.
  current = opts({ sponsorBlockCategories: ['intro', 'sponsor'] });
  sb.refreshSponsorBlock();
  await flush();
  assert.equal(fetchSegments.calls.length, 2);
});

test('a load that got no answer is retried with backoff, and each video has its own retries (B61)', async () => {
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const sb = await freshModule();
    const page = fakePage('https://www.youtube.com/watch?v=AAAAAAAAAAA');
    // Video A: the worker is never reached. Video B: not reached once, then no answer (null)
    // once, then the segments.
    const fetchSegments = fetcher((id, n) => {
      if (id === 'AAAAAAAAAAA' || n === 5) throw new Error('Could not establish connection');
      return n === 6 ? null : [SPONSOR];
    });
    sb.startSponsorBlock({ getOpts: () => opts(), fetchSegments });
    await flush();
    for (let i = 0; i < 40; i++) {
      now += 500;
      page.tick();
      await flush();
    }
    const onA = fetchSegments.calls.filter((id) => id === 'AAAAAAAAAAA').length;
    assert.equal(onA, 4, 'the first try and three retries, then it stops');

    page.navigate('https://www.youtube.com/watch?v=BBBBBBBBBBB');
    await flush();
    now += 1500;
    page.tick();
    await flush();
    assert.equal(fetchSegments.calls.filter((id) => id === 'BBBBBBBBBBB').length, 2, 'B inherited no retries');
    now += 2500;
    page.tick();
    await flush();
    assert.equal(fetchSegments.calls.filter((id) => id === 'BBBBBBBBBBB').length, 3);
    page.video.t = 10.5;
    page.tick();
    assert.deepEqual(page.video.seeks, [[10.5, 20]]);
  } finally {
    Date.now = realNow;
  }
});

test('a real empty answer is not retried', async () => {
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const sb = await freshModule();
    const page = fakePage('https://www.youtube.com/watch?v=AAAAAAAAAAA');
    const fetchSegments = fetcher(() => []);
    sb.startSponsorBlock({ getOpts: () => opts(), fetchSegments });
    await flush();
    for (let i = 0; i < 20; i++) {
      now += 1000;
      page.tick();
      await flush();
    }
    assert.equal(fetchSegments.calls.length, 1);
  } finally {
    Date.now = realNow;
  }
});

test('the worker fetcher tells no answer from an empty one (B61)', async () => {
  const sb = await freshModule();
  const answers = [
    [null, null],
    [undefined, null],
    [{ videoId: 'AAAAAAAAAAA', segments: [], failed: true }, null],
    [{ videoId: 'AAAAAAAAAAA' }, null],
    [{ videoId: 'AAAAAAAAAAA', segments: [] }, []],
    [{ videoId: 'AAAAAAAAAAA', segments: [SPONSOR] }, [SPONSOR]],
  ];
  const sent = [];
  for (const [response, expected] of answers) {
    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          sent.push(msg);
          return response;
        },
      },
    };
    assert.deepEqual(await sb.requestSegmentsFromWorker('AAAAAAAAAAA'), expected, JSON.stringify(response));
  }
  assert.deepEqual(sent[0], { type: 'sponsorblock:getSegments', videoId: 'AAAAAAAAAAA' });
  globalThis.chrome = {
    runtime: {
      sendMessage: async () => {
        throw new Error('Receiving end does not exist');
      },
    },
  };
  await assert.rejects(sb.requestSegmentsFromWorker('AAAAAAAAAAA'), /Receiving end/);
  delete globalThis.chrome;
});

test('an undone segment is passed over without hiding the segments overlapping it', async () => {
  const sb = await freshModule();
  const a = { category: 'sponsor', actionType: 'skip', segment: [100, 130], UUID: 'a' };
  const b = { category: 'selfpromo', actionType: 'skip', segment: [110, 200], UUID: 'b' };
  assert.equal(sb.findSkipSegment([a, b], 115), a);
  assert.equal(sb.findSkipSegment([a, b], 115, { suppressed: new Set(['a']) }), b);
  assert.equal(sb.findSkipSegment([a, b], 105, { suppressed: new Set(['a']) }), null);
});

test('a segment covering most of the video is never skipped', async () => {
  const sb = await freshModule();
  const page = fakePage('https://www.youtube.com/watch?v=AAAAAAAAAAA', { video: fakeVideo({ duration: 1200 }) });
  const vandal = { category: 'sponsor', actionType: 'skip', segment: [5, 1195], UUID: 'v' };
  sb.startSponsorBlock({ getOpts: () => opts(), fetchSegments: fetcher(() => [vandal, SPONSOR]) });
  await flush();
  page.video.t = 6;
  page.tick();
  assert.deepEqual(page.video.seeks, [], 'a 20-minute video was jumped to its end');
  page.video.t = 10.5;
  page.tick();
  assert.deepEqual(page.video.seeks, [[10.5, 20]], 'the plausible segment inside it still skips');
});

test('the miniplayer keeps skipping after the URL moves on', async () => {
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const sb = await freshModule();
    const query = {};
    const page = fakePage('https://www.youtube.com/watch?v=AAAAAAAAAAA', { query });
    const fetchSegments = fetcher();
    sb.startSponsorBlock({ getOpts: () => opts(), fetchSegments });
    await flush();

    // "i", then Home: the URL leaves the video first, then YouTube marks the miniplayer active
    // and keeps the watch page, hidden, naming its video (youtube.com, 2026-09).
    const app = { miniplayer: false, hasAttribute(a) { return a === 'miniplayer-is-active' && this.miniplayer; } };
    query['ytd-app'] = app;
    query['ytd-watch-flexy'] = { getAttribute: (a) => (a === 'video-id' ? 'AAAAAAAAAAA' : null) };
    page.navigate('https://www.youtube.com/');
    now += 200;
    page.tick();
    app.miniplayer = true;
    now += 200;
    page.video.t = 10.5;
    page.tick();
    await flush();
    assert.deepEqual(page.video.seeks, [[10.5, 20]], 'the miniplayer played the sponsor');
    assert.equal(fetchSegments.calls.length, 1, 'the same video was fetched again');

    // Miniplayer closed: nothing plays that the page could name.
    app.miniplayer = false;
    page.tick();
    now += 1500;
    page.video.t = 12;
    page.tick();
    assert.equal(page.video.seeks.length, 1);
  } finally {
    Date.now = realNow;
  }
});

test('on Shorts the Shorts player is the one skipped, not the hidden watch player', async () => {
  const sb = await freshModule();
  const shortsVideo = fakeVideo({ duration: 45 });
  const shorts = fakePlayer(shortsVideo);
  // Left over from an earlier watch page: paused at 0 (youtube.com, 2026-09).
  const page = fakePage('https://www.youtube.com/shorts/AAAAAAAAAAA', {
    video: fakeVideo({ paused: true }),
    byId: { 'shorts-player': shorts },
  });
  const intro = { category: 'sponsor', actionType: 'skip', segment: [2, 6], UUID: 'i' };
  sb.startSponsorBlock({ getOpts: () => opts(), fetchSegments: fetcher(() => [intro]) });
  await flush();
  shortsVideo.t = 2.5;
  page.video.t = 2.5;
  page.tick();
  assert.deepEqual(shortsVideo.seeks, [[2.5, 6]]);
  assert.deepEqual(page.video.seeks, []);

  // An ad on the Shorts player holds the skip too.
  shorts.classes.add('ad-showing');
  shortsVideo.t = 2.5;
  page.tick();
  assert.equal(shortsVideo.seeks.length, 1);
});

test('an undo lasts for the video, through a pause and back', async () => {
  const sb = await freshModule();
  const page = fakePage('https://www.youtube.com/watch?v=AAAAAAAAAAA');
  let current = opts();
  sb.startSponsorBlock({ getOpts: () => current, fetchSegments: fetcher() });
  await flush();
  page.video.t = 10.5;
  page.tick();
  assert.deepEqual(page.video.seeks, [[10.5, 20]]);
  const toast = page.root.children.at(-1);
  const undo = toast.children.find((c) => c.type === 'button');
  for (const f of undo.listeners.click) f();
  assert.deepEqual(page.video.seeks.at(-1), [20, 10.5]);

  current = opts({ paused: true });
  sb.refreshSponsorBlock();
  current = opts();
  sb.refreshSponsorBlock();
  await flush();
  page.tick();
  assert.equal(page.video.seeks.length, 2, 'the undone segment was skipped again');
});
