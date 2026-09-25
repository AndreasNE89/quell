import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootServiceWorker } from './helpers/sw-harness.mjs';

const page = (url) => ({ id: 'test', frameId: 0, documentId: 'DOC', url, origin: new URL(url).origin, tab: { id: 1, url } });
const YT = page('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
const MSG = { type: 'sponsorblock:getSegments', videoId: 'dQw4w9WgXcQ' };

async function askWith(sw, respond) {
  const p = sw.send(MSG, YT);
  const pkg = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).startsWith('https://sponsor.ajay.app/') ? respond() : pkg(url, init));
  return p;
}

test('the worker marks a lookup SponsorBlock did not answer, and answers a real empty one plainly', async () => {
  const sw = await bootServiceWorker({ host: 'www.youtube.com' });
  await sw.settle();
  assert.deepEqual(await askWith(sw, () => new Response('{}', { status: 429 })), { videoId: 'dQw4w9WgXcQ', segments: [], failed: true });
  assert.deepEqual(await askWith(sw, () => new Response('nf', { status: 404 })), { videoId: 'dQw4w9WgXcQ', segments: [] });
});

test('an update from 2.2.0 keeps "everything but sponsors" meaning that', async () => {
  const sw = await bootServiceWorker({ host: 'www.youtube.com', settings: { sponsorBlockCategories: { sponsor: false } } });
  await sw.settle();
  sw.install({ reason: 'update', previousVersion: '2.2.0' });
  await sw.settle();
  const cats = sw.settings().sponsorBlockCategories;
  assert.equal(cats.sponsor, false);
  assert.equal(cats.intro, true);
  assert.equal(cats.music_offtopic, true);
});

test('an update from 2.3.0 leaves the categories alone', async () => {
  const sw = await bootServiceWorker({ host: 'www.youtube.com', settings: { sponsorBlockCategories: { sponsor: false } } });
  await sw.settle();
  sw.install({ reason: 'update', previousVersion: '2.3.0' });
  await sw.settle();
  assert.deepEqual(sw.settings().sponsorBlockCategories, { sponsor: false });
});
