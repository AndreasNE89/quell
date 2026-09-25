// The worker's SponsorBlock client (src/background/sponsorblock-api.ts) against a stubbed fetch:
// what counts as an answer, what is cached, and how many requests reach the API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rmSync } from 'node:fs';
import { webcrypto, createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = join(tmpdir(), `stampstack-sb-api-${process.pid}.mjs`);
let copies = 0;
const realFetch = globalThis.fetch;
const realNow = Date.now;

before(async () => {
  if (!globalThis.crypto) globalThis.crypto = webcrypto;
  await build({
    stdin: {
      contents: `export * from './src/background/sponsorblock-api.ts';`,
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
  globalThis.fetch = realFetch;
  Date.now = realNow;
  rmSync(outfile, { force: true });
});

/** A fresh module: its cache and in-flight map start empty. */
function freshModule() {
  return import(`${pathToFileURL(outfile).href}?copy=${++copies}`);
}

const VIDEO = 'dQw4w9WgXcQ';
const bucket = (videoID, segment = [10, 20]) => ({
  videoID,
  segments: [{ category: 'sponsor', actionType: 'skip', segment, UUID: `${videoID}-1`, videoDuration: 212 }],
});

/** Stub fetch with `respond(url, n)`: a Response, or a thrown error. Returns the call log. */
function stubFetch(respond) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return respond(String(url), calls.length);
  };
  return calls;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('the hash prefix is the first four hex digits of the id’s SHA-256', async () => {
  const api = await freshModule();
  const expected = createHash('sha256').update(VIDEO).digest('hex').slice(0, 4);
  assert.equal(expected, '5f6b');
  assert.equal(await api.videoIdHashPrefix(VIDEO), expected);
});

test('only this video’s bucket is used from a shared hash prefix', async () => {
  const api = await freshModule();
  stubFetch(() => json([bucket('zzzzzzzzzzz', [1, 5]), bucket(VIDEO)]));
  const res = await api.lookupSponsorSegments(VIDEO, ['sponsor']);
  assert.equal(res.ok, true);
  assert.deepEqual(res.segments.map((s) => s.UUID), [`${VIDEO}-1`]);
});

test('a timeout, a network error, a 429, a 5xx or an unreadable body is no answer, and is not cached (B61)', async () => {
  const failures = [
    () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    },
    () => {
      throw new TypeError('Failed to fetch');
    },
    () => json({ message: 'Too many requests' }, 429),
    () => new Response('bad gateway', { status: 502 }),
    () => new Response('<html>challenge</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  ];
  for (const fail of failures) {
    const api = await freshModule();
    const calls = stubFetch((_url, n) => (n === 1 ? fail() : json([bucket(VIDEO)])));
    const first = await api.lookupSponsorSegments(VIDEO, ['sponsor']);
    assert.deepEqual(first, { ok: false }, String(fail));
    const second = await api.lookupSponsorSegments(VIDEO, ['sponsor']);
    assert.equal(second.ok, true, 'the failure was cached');
    assert.equal(second.segments.length, 1);
    assert.equal(calls.length, 2);
  }
});

test('a 404 is a real "no segments" answer and is cached', async () => {
  const api = await freshModule();
  const calls = stubFetch(() => new Response('Not Found', { status: 404 }));
  assert.deepEqual(await api.lookupSponsorSegments(VIDEO, ['sponsor']), { ok: true, segments: [] });
  assert.deepEqual(await api.lookupSponsorSegments(VIDEO, ['sponsor']), { ok: true, segments: [] });
  assert.equal(calls.length, 1);
});

test('lookups for the same video and categories share one request (B63)', async () => {
  const api = await freshModule();
  let release;
  const gate = new Promise((r) => (release = r));
  const calls = stubFetch(async () => {
    await gate;
    return json([bucket(VIDEO)]);
  });
  const pending = [
    api.lookupSponsorSegments(VIDEO, ['sponsor']),
    api.lookupSponsorSegments(VIDEO, ['sponsor']),
    api.lookupSponsorSegments(VIDEO, ['sponsor']),
    api.lookupSponsorSegments(VIDEO, ['intro', 'sponsor']),
  ];
  await new Promise((r) => setTimeout(r, 10));
  release();
  const results = await Promise.all(pending);
  assert.equal(calls.length, 2, 'one request per category set');
  for (const r of results) assert.equal(r.ok && r.segments.length, 1);

  // Once answered, a failed request is not remembered as in flight.
  stubFetch(() => json({}, 503));
  assert.deepEqual(await api.lookupSponsorSegments('AAAAAAAAAAA', ['sponsor']), { ok: false });
  const retry = stubFetch(() => json([bucket('AAAAAAAAAAA')]));
  assert.equal((await api.lookupSponsorSegments('AAAAAAAAAAA', ['sponsor'])).ok, true);
  assert.equal(retry.length, 1);
});

test('an expired answer stands in while the API has none', async () => {
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const api = await freshModule();
    stubFetch(() => json([bucket(VIDEO)]));
    await api.lookupSponsorSegments(VIDEO, ['sponsor']);
    now += 2 * 60 * 60 * 1000;
    const calls = stubFetch(() => json({}, 503));
    const res = await api.lookupSponsorSegments(VIDEO, ['sponsor']);
    assert.equal(calls.length, 1, 'an expired entry is asked again');
    assert.equal(res.ok, true);
    assert.equal(res.segments.length, 1);
  } finally {
    Date.now = realNow;
  }
});

test('a segment longer than most of its video is dropped, by the duration SponsorBlock reports', async () => {
  const api = await freshModule();
  const seg = (segment, videoDuration) => ({ category: 'sponsor', actionType: 'skip', segment, videoDuration });
  const out = api.normalizeSegments([
    seg([5, 1195], 1200), // 99% of a 20-minute video
    seg([5, 900], 1200), // 75%: long, but can be a real sponsor read
    seg([5, 1195], 0), // no duration on file: only the absolute cap applies
    seg([5, 90], undefined),
  ]);
  assert.deepEqual(
    out.map((s) => s.segment),
    [
      [5, 900],
      [5, 1195],
      [5, 90],
    ],
  );
});
