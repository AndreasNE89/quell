// Tests for `update-lists` (scripts/update-lists.mjs, scripts/lib/list-update.mjs).
//
// A refresh is unattended and whatever it writes is stamped and shipped. It used to accept
// anything over 100 characters, write each list as it arrived, and follow a redirect to plain
// HTTP: a 175-byte "Service Unavailable" page became easyprivacy.txt, a failure half way left
// filters/ half old and half new, and `npm run update-lists -- <id>` refreshed every list
// (REVIEW_2026-09-24 B74 and its P3 entries). The CLI tests run the real script against lists
// served from a loopback HTTP server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertFetchable,
  commitLists,
  notAFilterList,
  parseUpdateArgs,
  redirectTarget,
  shrunkTooFar,
} from '../scripts/lib/list-update.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const LIST = (title, rules = 200) =>
  `[Adblock Plus 2.0]\n! Title: ${title}\n! Expires: 4 days\n${Array.from({ length: rules }, (_, i) => `||ads${i}.example^`).join('\n')}\n`;
// The page from the review's reproduction, byte for byte in spirit: a maintenance page served 200.
const OUTAGE = '<!doctype html><html><head><title>503</title></head><body>Service Unavailable</body></html>\n';

// --- checks ------------------------------------------------------------------------------------

test('a filter list passes; an HTML page, a JSON body or a header-less file does not', () => {
  assert.equal(notAFilterList({ text: LIST('EasyList'), contentType: 'text/plain; charset=utf-8' }), null);
  assert.equal(notAFilterList({ text: `\uFEFF! Title: uBlock filters\n${LIST('x').slice(19)}` }), null);
  assert.match(notAFilterList({ text: OUTAGE, contentType: 'text/plain' }), /HTML/);
  assert.match(notAFilterList({ text: `\n\n  <HTML><body>${'x'.repeat(200)}` }), /HTML/);
  assert.match(notAFilterList({ text: LIST('ok'), contentType: 'text/html; charset=utf-8' }), /text\/html/);
  assert.match(notAFilterList({ text: `{"error":"rate limited","retry":${'1'.repeat(120)}}` }), /header/);
  assert.match(notAFilterList({ text: '! Title: x\n' }), /small/);
});

test('a list may not lose more than half of its locked size unless allowed', () => {
  const locked = { bytes: 800_000 };
  assert.equal(shrunkTooFar(790_000, locked), null);
  assert.equal(shrunkTooFar(400_000, locked), null, 'exactly half is still accepted');
  assert.match(shrunkTooFar(230, locked), /shrank/);
  assert.equal(shrunkTooFar(230, locked, { allowShrink: true }), null);
  assert.equal(shrunkTooFar(230, undefined), null, 'a list the lock has never seen has nothing to shrink from');
});

test('HTTPS only: redirects may not downgrade, and plain HTTP is loopback-only', () => {
  assert.equal(
    redirectTarget('https://easylist.to/easylist/easylist.txt', '/mirror/easylist.txt'),
    'https://easylist.to/mirror/easylist.txt',
  );
  assert.equal(redirectTarget('https://a.example/x.txt', 'https://b.example/x.txt'), 'https://b.example/x.txt');
  assert.throws(() => redirectTarget('https://a.example/x.txt', 'http://a.example/x.txt'), /HTTPS to http:/);
  assert.throws(() => redirectTarget('https://a.example/x.txt', 'http://127.0.0.1/x.txt'), /HTTPS to http:/);
  assert.throws(() => assertFetchable('http://easylist.to/easylist/easylist.txt'), /HTTPS only/);
  assert.throws(() => assertFetchable('ftp://easylist.to/easylist.txt'), /HTTPS only/);
  assert.equal(assertFetchable('http://127.0.0.1:8080/x.txt').hostname, '127.0.0.1');
});

test('arguments are list ids and --allow-shrink; anything else is reported', () => {
  const registry = { lists: [{ id: 'easylist' }, { id: 'easylist-china' }] };
  assert.deepEqual(parseUpdateArgs(['easylist-china'], registry), {
    ids: ['easylist-china'],
    allowShrink: false,
    unknown: [],
    badFlags: [],
  });
  const r = parseUpdateArgs(['--allow-shrink', 'easylst', '--force'], registry);
  assert.equal(r.allowShrink, true);
  assert.deepEqual(r.unknown, ['easylst']);
  assert.deepEqual(r.badFlags, ['--force']);
});

test('commitLists writes everything or restores what was there', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stampstack-commit-'));
  try {
    writeFileSync(join(dir, 'a.txt'), 'old a');
    // A directory where b.txt belongs makes the second rename fail after the first succeeded.
    mkdirSync(join(dir, 'b.txt'));
    mkdirSync(join(dir, 'b.txt', 'blocker'));
    assert.throws(() =>
      commitLists(dir, [
        { file: 'a.txt', bytes: Buffer.from('new a') },
        { file: 'b.txt', bytes: Buffer.from('new b') },
      ]),
    );
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'old a', 'the list that did land was put back');
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.download')), [], 'no temp files left');

    rmSync(join(dir, 'b.txt'), { recursive: true });
    commitLists(dir, [
      { file: 'a.txt', bytes: Buffer.from('new a') },
      { file: 'b.txt', bytes: Buffer.from('new b') },
    ]);
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'new a');
    assert.equal(readFileSync(join(dir, 'b.txt'), 'utf8'), 'new b');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- CLI ---------------------------------------------------------------------------------------

/** Serve `routes` (path → { body, type?, status?, location? }) on loopback; records each path hit. */
async function serve(routes) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    const r = routes[req.url];
    if (!r) {
      res.writeHead(404).end();
      return;
    }
    if (r.location) {
      res.writeHead(r.status ?? 302, { location: r.location }).end();
      return;
    }
    res.writeHead(r.status ?? 200, { 'content-type': r.type ?? 'text/plain; charset=utf-8' }).end(r.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, hits, close: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * A throwaway repo root holding the real scripts and a registry of `lists` ({ id, path }), each
 * already on disk as `initial[id]` and locked. The real lock-lists stamps the initial lock.
 */
async function repo(base, lists, initial) {
  const dir = mkdtempSync(join(tmpdir(), 'stampstack-update-'));
  mkdirSync(join(dir, 'filters'));
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  for (const f of ['update-lists.mjs', 'lock-lists.mjs']) cpSync(join(ROOT, 'scripts', f), join(dir, 'scripts', f));
  for (const f of ['list-lock.mjs', 'list-update.mjs']) {
    cpSync(join(ROOT, 'scripts', 'lib', f), join(dir, 'scripts', 'lib', f));
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.0.0-test' }));
  const registry = {
    lists: lists.map((l) => ({ id: l.id, title: l.id, enabledByDefault: true, file: `${l.id}.txt`, url: `${base}${l.path}` })),
  };
  writeFileSync(join(dir, 'filters', 'lists.json'), JSON.stringify(registry, null, 2));
  for (const l of lists) writeFileSync(join(dir, 'filters', `${l.id}.txt`), initial[l.id]);
  const stamped = await node(dir, 'lock-lists.mjs', []);
  assert.equal(stamped.code, 0, stamped.out);
  return dir;
}

/** Run a script without blocking this process: the list server lives in it. */
function node(dir, script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(dir, 'scripts', script), ...args], { cwd: dir });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

const read = (dir, id) => readFileSync(join(dir, 'filters', `${id}.txt`), 'utf8');
const lockOf = (dir) => readFileSync(join(dir, 'filters', 'lists.lock.json'), 'utf8');

test('CLI: one bad download writes nothing, not even the lists that arrived fine', async () => {
  const srv = await serve({ '/a.txt': { body: LIST('A new') }, '/b.txt': { body: OUTAGE } });
  const dir = await repo(srv.base, [{ id: 'a', path: '/a.txt' }, { id: 'b', path: '/b.txt' }], {
    a: LIST('A old'),
    b: LIST('B old'),
  });
  try {
    const lockBefore = lockOf(dir);
    const r = await node(dir, 'update-lists.mjs', []);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /b … FAILED \(looks like an HTML page/);
    assert.match(r.out, /Nothing written/);
    assert.equal(read(dir, 'a'), LIST('A old'), 'a arrived fine but must not be written alone');
    assert.equal(read(dir, 'b'), LIST('B old'));
    assert.equal(lockOf(dir), lockBefore);
    assert.equal((await node(dir, 'lock-lists.mjs', ['--check'])).code, 0, 'filters/ still matches the lock');
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: a list served as text/html or cut to a fraction of its size is refused', async () => {
  const srv = await serve({
    '/a.txt': { body: LIST('A'), type: 'text/html; charset=utf-8' },
    '/b.txt': { body: LIST('B', 20) },
  });
  const dir = await repo(srv.base, [{ id: 'a', path: '/a.txt' }, { id: 'b', path: '/b.txt' }], {
    a: LIST('A old'),
    b: LIST('B old', 2000),
  });
  try {
    const r = await node(dir, 'update-lists.mjs', []);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /a … FAILED \(served as text\/html/);
    assert.match(r.out, /b … FAILED \(shrank from/);
    const allowed = await node(dir, 'update-lists.mjs', ['b', '--allow-shrink']);
    assert.equal(allowed.code, 0, allowed.out);
    assert.equal(read(dir, 'b'), LIST('B', 20));
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: a good refresh writes every list and stamps the lock in the same run', async () => {
  const srv = await serve({ '/a.txt': { body: LIST('A new') }, '/b.txt': { body: LIST('B new') } });
  const dir = await repo(srv.base, [{ id: 'a', path: '/a.txt' }, { id: 'b', path: '/b.txt' }], {
    a: LIST('A old'),
    b: LIST('B old'),
  });
  try {
    const r = await node(dir, 'update-lists.mjs', []);
    assert.equal(r.code, 0, r.out);
    assert.equal(read(dir, 'a'), LIST('A new'));
    assert.equal(read(dir, 'b'), LIST('B new'));
    assert.match(r.out, /lists\.lock\.json updated/);
    assert.equal((await node(dir, 'lock-lists.mjs', ['--check'])).code, 0, 'the lock matches without a second step');
    assert.equal(existsSync(join(dir, 'filters', '.a.txt.download')), false);
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: list ids limit the refresh to those lists, and a typo downloads nothing', async () => {
  const srv = await serve({ '/a.txt': { body: LIST('A new') }, '/b.txt': { body: LIST('B new') } });
  const dir = await repo(srv.base, [{ id: 'a', path: '/a.txt' }, { id: 'b', path: '/b.txt' }], {
    a: LIST('A old'),
    b: LIST('B old'),
  });
  try {
    const r = await node(dir, 'update-lists.mjs', ['b']);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(srv.hits, ['/b.txt']);
    assert.equal(read(dir, 'a'), LIST('A old'));
    assert.equal(read(dir, 'b'), LIST('B new'));

    const typo = await node(dir, 'update-lists.mjs', ['bb']);
    assert.equal(typo.code, 1);
    assert.match(typo.out, /Unknown list id\(s\): bb/);
    assert.deepEqual(srv.hits, ['/b.txt'], 'nothing fetched for a typo');
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: a redirect off loopback to plain HTTP is refused without being fetched', async () => {
  const srv = await serve({ '/a.txt': { location: 'http://lists.example.invalid/a.txt' } });
  const dir = await repo(srv.base, [{ id: 'a', path: '/a.txt' }], { a: LIST('A old') });
  try {
    const r = await node(dir, 'update-lists.mjs', []);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /refusing http:\/\/lists\.example\.invalid/);
    assert.deepEqual(srv.hits, ['/a.txt'], 'a refused URL is not retried');
    assert.equal(read(dir, 'a'), LIST('A old'));
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
