// List scriptlets delivered as document_start content scripts (REVIEW_2026-09-24 B2).
//
// The rules used to reach a page by message and executeScript, 30-200 ms after the page's own
// inline <head> scripts had run, so most anti-adblock defusers did nothing. They now ship as
// MAIN-world files keyed by host (scripts/lib/scriptlet-shards.mjs) that the service worker
// registers per bucket, and a small runtime picks each page's rules
// (src/engine/scriptlet-shards.ts).
//
// The contract checked here: what a page gets from the registrations Chrome would inject is
// exactly what matchScriptlets gives it, for the shipped lists, and the registrations stay
// inside the limits Chrome and page-load time allow.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  buildScriptletShards,
  planScriptletBundles,
  joinScriptletBundle,
  bucketOf,
  classifyKey,
  siteOf,
  SHARD_BUCKETS,
} from '../scripts/lib/scriptlet-shards.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let host;
let engine;

async function bundle(contents) {
  const out = await build({
    stdin: { contents, resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

before(async () => {
  host = await bundle(`export * from './src/shared/hostname.ts';`);
  engine = await bundle(`
    export * from './src/engine/scriptlet-shards.ts';
    export { matchScriptlets } from './src/engine/cosmetic-match.ts';
    export { scopeOf, frameHostOf } from './src/shared/frame-scope.ts';
  `);
});

const rule = (include, name, args = [], exclude = []) => ({ domains: { include, exclude }, name, args });

/** Build, then index every file's pushed data by path, the way the runtime receives it. */
function compile(byList, order = Object.keys(byList)) {
  const out = buildScriptletShards(byList, order, host);
  const data = new Map();
  for (const f of out.files) {
    const ctx = vm.createContext({});
    vm.runInContext(f.content, ctx);
    const queue = ctx[out.index.key];
    assert.ok(Array.isArray(queue) && queue.length === 1, `${f.path} pushes one entry`);
    data.set(f.path, queue[0]);
  }
  return { ...out, data };
}

/**
 * What a top frame ends up running on each host: every registration Chrome would inject there
 * (its patterns tested the way Chrome tests them), each a separate injection with its own
 * runtime pass.
 */
function servedBy(compiled, enabled) {
  const regs = engine.shardRegistrations(compiled.index, enabled);
  const everywhere = [];
  const subdomains = new Map(); // `*://*.h/*` → registrations
  const exact = new Map(); // `*://h/*`
  for (const r of regs) {
    for (const p of r.matches()) {
      if (p === '*://*/*') {
        everywhere.push(r);
        continue;
      }
      const m = /^\*:\/\/(\*\.)?([^/*]+)\/\*$/.exec(p);
      if (!m) throw new Error(`unexpected pattern ${p}`);
      const map = m[1] ? subdomains : exact;
      map.set(m[2], [...(map.get(m[2]) ?? []), r]);
    }
  }
  return (pageHost) => {
    const hit = new Set([...everywhere, ...(exact.get(pageHost) ?? [])]);
    const labels = pageHost.split('.');
    for (let i = 0; i < labels.length; i++) {
      for (const r of subdomains.get(labels.slice(i).join('.')) ?? []) hit.add(r);
    }
    const out = [];
    for (const r of regs.filter((x) => hit.has(x))) {
      const datas = r.parts.slice(0, -1).map((f) => compiled.data.get(f));
      for (const s of engine.matchShards(pageHost, datas)) out.push([s.name, ...s.args].join('\0'));
    }
    return out;
  };
}

function served(compiled, pageHost, enabled) {
  return servedBy(compiled, enabled)(pageHost);
}

/** matchScriptlets, reduced to what the page runs: each name+args once. */
function reference(byList, pageHost, enabled) {
  return [
    ...new Set(
      engine.matchScriptlets(pageHost, { byList }, enabled).map((r) => [r.name, ...r.args].join('\0')),
    ),
  ];
}

test('keys: a site and all its subdomains share a bucket; what a pattern cannot name goes broad', () => {
  const ps = host.isPublicSuffixHost;
  assert.equal(siteOf('a.b.example.co.uk', ps), 'example.co.uk');
  assert.equal(siteOf('espn.go.com', ps), 'espn.go.com');
  assert.equal(bucketOf('example.co.uk', ps), bucketOf('deep.sub.example.co.uk', ps));
  assert.equal(bucketOf('example.com', ps), bucketOf('www.example.com', ps));

  const kind = (k) => {
    const c = classifyKey(k, host);
    return `${c.kind}:${c.key}`;
  };
  assert.equal(kind('Example.COM'), 'concrete:example.com');
  // A filter's `www.` is kept: www.example.com and below, as matchScriptlets has it.
  assert.equal(kind('www.example.com'), 'concrete:www.example.com');
  assert.equal(bucketOf('www.example.com', ps), bucketOf('example.com', ps));
  assert.equal(kind('1.2.3.4'), 'concrete:1.2.3.4');
  assert.equal(kind('yts.*'), 'broad:yts.*');
  assert.equal(kind('co.uk'), 'broad:co.uk');
  // A multi-label entity is live (EasyList's `www.google.*`, `read.amazon.*`).
  assert.equal(kind('vr.pornhat.*'), 'broad:vr.pornhat.*');
  // filterDomainMatches can never match these (the parser strips `>>` and punycodes names).
  assert.equal(kind('noxx.to>>'), 'dead:noxx.to>>');
  assert.equal(kind('пример.рф'), 'dead:пример.рф');
});

test('a page gets its rules at document start, subdomains and exclusions as matchScriptlets has them', () => {
  const byList = {
    a: {
      scriptlets: [
        rule(['example.com'], 'aopr', ['one']),
        rule(['example.com'], 'aopr', ['two'], ['quiet.example.com']),
        rule(['www.other.org'], 'set', ['x', 'true']),
        rule(['site.*', 'site.org'], 'nowoif'),
        rule(['co.uk'], 'aopr', ['suffix']),
      ],
      exceptions: [],
    },
  };
  const c = compile(byList);
  for (const h of [
    'example.com',
    'www.example.com',
    'quiet.example.com',
    'deep.quiet.example.com',
    'other.org',
    'site.org',
    'www.site.de',
    'thing.co.uk',
    'example.net',
  ]) {
    assert.deepEqual(served(c, h, ['a']).sort(), reference(byList, h, ['a']).sort(), h);
  }
  assert.deepEqual(served(c, 'quiet.example.com', ['a']), ['aopr\0one']);
  // `site.org` is also covered by `site.*`: shipping it in a bucket too would run nowoif twice.
  assert.deepEqual(served(c, 'site.org', ['a']), ['nowoif']);
});

test('exceptions cancel rules across lists and across the bucket/broad split', () => {
  const byList = {
    a: {
      scriptlets: [
        rule(['a.com'], 'aopr', ['x']),
        rule(['site.org'], 'aopr', ['y']),
        rule(['film.*'], 'aopr', ['z']),
      ],
      exceptions: [],
    },
    b: {
      scriptlets: [],
      exceptions: [
        rule(['a.com'], 'aopr', ['x']),
        // An entity exception must reach a bucket registration it has no rules in…
        rule(['site.*'], 'aopr', ['y']),
        // …and a host exception the broad registration.
        rule(['film.net'], 'aopr', ['z']),
      ],
    },
  };
  const c = compile(byList);
  for (const [h, withB, withoutB] of [
    ['a.com', [], ['aopr\0x']],
    ['site.org', [], ['aopr\0y']],
    ['film.net', [], ['aopr\0z']],
    ['film.org', ['aopr\0z'], ['aopr\0z']],
  ]) {
    assert.deepEqual(served(c, h, ['a', 'b']), withB, `${h} with b`);
    assert.deepEqual(served(c, h, ['a']), withoutB, `${h} without b`);
    assert.deepEqual(served(c, h, ['a', 'b']).sort(), reference(byList, h, ['a', 'b']).sort());
  }
});

test('the build is reproducible and content-addressed', () => {
  const byList = { a: { scriptlets: [rule(['a.com'], 'aopr', ['x'])], exceptions: [] } };
  const one = buildScriptletShards(byList, ['a'], host);
  const two = buildScriptletShards(structuredClone(byList), ['a'], host);
  assert.deepEqual(two.files, one.files);
  assert.deepEqual(two.index, one.index);
  // The service worker compares registrations by file name, so new rules must mean new names.
  byList.a.scriptlets[0].args = ['y'];
  const three = buildScriptletShards(byList, ['a'], host);
  assert.notEqual(three.index.version, one.index.version);
  assert.notDeepEqual(
    three.files.map((f) => f.path),
    one.files.map((f) => f.path),
  );
});

test('a broad file is only parsed on a host it can match', () => {
  const broad = { k: '|yts.*|', p: 'not json: parsing it would throw' };
  const originalParse = JSON.parse;
  let parsed = 0;
  JSON.parse = (...a) => {
    parsed++;
    return originalParse(...a);
  };
  try {
    assert.deepEqual(engine.matchShards('example.com', [broad]), []);
    assert.equal(parsed, 0);
    assert.deepEqual(engine.matchShards('yts.mx', [broad]), [], 'a damaged file is skipped');
    assert.equal(parsed, 1);
  } finally {
    JSON.parse = originalParse;
  }
});

test('the fallback plan names the registrations a host needs, for enabled lists only', () => {
  const byList = {
    a: { scriptlets: [rule(['yts.mx'], 'rmnt', ['script', 'x']), rule(['yts.*'], 'nowoif')], exceptions: [] },
    b: { scriptlets: [rule(['news.example'], 'aopr', ['w'])], exceptions: [] },
  };
  const c = compile(byList);
  const plan = engine.planShardInjection(c.index, 'www.yts.mx', ['a', 'b']);
  const bucket = `${engine.SCRIPTLET_SHARD_ID_PREFIX}${bucketOf('yts.mx', host.isPublicSuffixHost)}`;
  assert.deepEqual(
    plan.registrations.map((r) => r.id),
    [bucket, engine.SCRIPTLET_BROAD_ID],
  );
  assert.ok(plan.registrations.every((r) => r.files.every((f) => c.data.has(f))));
  assert.equal(engine.planShardInjection(c.index, 'www.yts.mx', ['b']), null);
  assert.equal(engine.planShardInjection(c.index, 'unrelated.example', ['a', 'b']), null);
});

test('frame scope: the registrations serve the top page and frames on its host, the worker the rest', () => {
  // excludeMatches sees the frame's own URL while the switches belong to the top page (B24), so
  // only where the two hosts are the same can the registered runtime act on its own.
  const { scopeOf, frameHostOf } = engine;
  assert.equal(scopeOf('news.example', true, []).registered, true);
  assert.equal(scopeOf('news.example', false, ['https://news.example']).registered, true);
  assert.equal(scopeOf('player.example', false, ['https://news.example']).registered, false);
  // The top page is the last ancestor, not the parent.
  assert.equal(scopeOf('news.example', false, ['https://player.example', 'https://news.example']).registered, true);
  assert.equal(scopeOf('news.example', false, ['https://news.example', 'https://portal.example']).top, 'portal.example');
  // Opaque or unknown top: the worker decides from the tab.
  assert.equal(scopeOf('news.example', false, ['null']).registered, false);
  assert.equal(scopeOf('news.example', false, undefined).registered, false);
  // about:blank, srcdoc and blob: frames have no host of their own; they run as their creator.
  assert.equal(frameHostOf('', 'https://News.Example'), 'news.example');
  assert.equal(frameHostOf('', 'null'), '');
  assert.equal(scopeOf('', true, []).registered, false);
});

// ---------------------------------------------------------------------------
// Bundles: one file per registration
// ---------------------------------------------------------------------------
//
// The registrations reach sandboxed about:blank frames (matchOriginAsFallback), and in one
// without `allow-scripts` Chrome logs "Blocked script execution in 'about:blank'…" once for
// every file it may not run. With each registration carrying its data files and runtime
// separately that was 8 errors on every YouTube page, against none with 2.2.3.
// chrome.scripting cannot skip sandboxed frames, so a registration now injects one file.

/** The index with bundles for `defaults`, as compile-filters writes it. */
function withBundles(compiled, defaults) {
  const index = structuredClone(compiled.index);
  index.bundles = planScriptletBundles(
    engine.shardRegistrations(index, defaults),
    engine.SCRIPTLET_SHARD_ID_PREFIX,
  );
  return index;
}

test('bundles: the default lists get one file per registration, any other set its parts', () => {
  const byList = {
    a: { scriptlets: [rule(['a.com'], 'aopr', ['x']), rule(['film.*'], 'nowoif')], exceptions: [] },
    b: { scriptlets: [rule(['a.com'], 'aopr', ['y'])], exceptions: [rule(['film.*'], 'nowoif')] },
  };
  const c = compile(byList);
  const index = withBundles(c, ['a', 'b']);
  const regs = engine.shardRegistrations(index, ['a', 'b']);
  assert.deepEqual(
    regs.map((r) => r.id),
    [`${engine.SCRIPTLET_SHARD_ID_PREFIX}${bucketOf('a.com', host.isPublicSuffixHost)}`, engine.SCRIPTLET_BROAD_ID],
  );
  for (const r of regs) {
    assert.deepEqual(r.js, [index.bundles[r.id].file], r.id);
    assert.deepEqual(index.bundles[r.id].parts, r.parts, r.id);
    // The worker still knows which data files a registered bundle has already run.
    assert.deepEqual(engine.shardParts(index, r.js), r.parts, r.id);
  }
  // A list switched off: the bundle no longer holds exactly what is on, so the parts go in.
  for (const r of engine.shardRegistrations(index, ['a'])) {
    assert.deepEqual(r.js, r.parts, r.id);
    assert.ok(r.parts.every((f) => !f.includes('/b.')), r.id);
  }
  // Same registrations either way, only the files Chrome is handed differ.
  const plain = engine.shardRegistrations(c.index, ['a', 'b']);
  assert.deepEqual(
    regs.map((r) => [r.id, r.parts, r.matches()]),
    plain.map((r) => [r.id, r.parts, r.matches()]),
  );
  assert.deepEqual(plain.map((r) => r.js), plain.map((r) => r.parts), 'no bundles, no stand-ins');
});

test('bundles: a name follows its parts', () => {
  const regs = [{ id: 'quell-sl-3', parts: ['generated/scriptlets/a.3.v1.js', 'scriptlets-runtime.js'] }];
  const one = planScriptletBundles(regs, 'quell-sl-');
  assert.match(one['quell-sl-3'].file, /^generated\/scriptlets\/bundle\.3\.[0-9a-f]{12}\.js$/);
  assert.deepEqual(planScriptletBundles(structuredClone(regs), 'quell-sl-'), one);
  // New data means new part names, and so a new bundle name: the worker compares by name.
  const two = planScriptletBundles(
    [{ id: 'quell-sl-3', parts: ['generated/scriptlets/a.3.v2.js', 'scriptlets-runtime.js'] }],
    'quell-sl-',
  );
  assert.notEqual(two['quell-sl-3'].file, one['quell-sl-3'].file);
});

test('bundles: joined, the parts run as Chrome runs them back to back, the runtime still strict', () => {
  const byList = {
    a: { scriptlets: [rule(['a.com'], 'aopr', ['x'])], exceptions: [] },
    b: { scriptlets: [rule(['a.com'], 'set', ['y', 'true'])], exceptions: [] },
  };
  const c = compile(byList);
  const [r] = engine.shardRegistrations(c.index, ['a', 'b']);
  const texts = r.parts.slice(0, -1).map((p) => c.files.find((f) => f.path === p).content);
  assert.equal(texts.length, 2);
  // A stand-in with esbuild's shape: the directive, then an IIFE that reads the hand-off.
  const runtime =
    '"use strict";\n(() => {\n  globalThis.out = {\n' +
    '    strict: (function () { return this; })() === undefined,\n' +
    `    queue: globalThis[${JSON.stringify(c.index.key)}],\n  };\n})();\n`;
  const run = (scripts) => {
    const ctx = vm.createContext({});
    for (const s of scripts) vm.runInContext(s, ctx);
    return JSON.parse(JSON.stringify(ctx.out));
  };
  const separate = run([...texts, runtime]);
  assert.equal(separate.strict, true);
  assert.equal(separate.queue.length, 2);
  for (const rt of [runtime, runtime.replace(/\n\s*/g, '')]) {
    const joined = joinScriptletBundle([...texts, rt]);
    assert.ok(joined.startsWith('"use strict";\n'), 'the directive only counts at the top');
    assert.deepEqual(run([joined]), separate);
  }
});

test('bundles: a part without its closing semicolon keeps to itself; only the runtime may be strict', () => {
  const ctx = vm.createContext({ log: [] });
  vm.runInContext(joinScriptletBundle(['log.push(1)', '(function () { log.push(2); })()']), ctx);
  assert.deepEqual([...ctx.log], [1, 2]);
  assert.throws(() => joinScriptletBundle(["'use strict';\nlog.push(1);", 'log.push(2);']), /strict/);
});

// ---------------------------------------------------------------------------
// The shipped lists
// ---------------------------------------------------------------------------

function shipped() {
  const data = JSON.parse(readFileSync(join(ROOT, 'src/generated/scriptlets.json'), 'utf8'));
  const meta = JSON.parse(readFileSync(join(ROOT, 'src/generated/meta.json'), 'utf8'));
  return { byList: data.byList, lists: meta.lists };
}

/** Deterministic sample: every exclusion and exception host, entities, and a spread of hosts. */
function sampleHosts(byList) {
  const hosts = new Set();
  const all = Object.values(byList).flatMap((b) => [...b.scriptlets, ...b.exceptions]);
  for (const r of all) {
    for (const d of [...r.domains.include, ...r.domains.exclude]) {
      const c = classifyKey(d, host);
      if (c.kind === 'dead') continue;
      if (c.key.endsWith('.*')) {
        const label = c.key.slice(0, -2);
        hosts.add(`${label}.to`);
        hosts.add(`www.${label}.co.uk`);
      } else {
        hosts.add(c.key);
      }
    }
  }
  const keys = [...hosts].sort();
  const pick = new Set();
  for (let i = 0; i < keys.length; i += 37) {
    pick.add(keys[i]);
    // An IP has no subdomains: `www.1.2.3.4` is not a host a page can have.
    if (host.isIPv4Host(keys[i])) continue;
    pick.add(`www.${keys[i]}`);
    pick.add(`cdn.${keys[i]}`);
  }
  for (const r of all) {
    for (const d of r.domains.exclude) if (!d.endsWith('.*')) pick.add(d);
  }
  for (const b of Object.values(byList)) {
    for (const r of b.exceptions) for (const d of r.domains.include) if (!d.endsWith('.*')) pick.add(d);
  }
  return [...pick];
}

test('shipped lists: every sampled page gets exactly what matchScriptlets gives it', () => {
  const { byList, lists } = shipped();
  const order = lists.map((l) => l.id);
  const c = compile(byList, order);
  const sets = [order, lists.filter((l) => l.enabledByDefault).map((l) => l.id)];
  const hosts = sampleHosts(byList);
  assert.ok(hosts.length > 1000, `sample too small: ${hosts.length}`);
  for (const enabled of sets) {
    const serve = servedBy(c, enabled);
    const diffs = [];
    for (const h of hosts) {
      const got = serve(h).sort();
      const want = reference(byList, h, enabled).sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) diffs.push({ h, got, want });
    }
    assert.deepEqual(diffs.slice(0, 5), [], `${diffs.length} hosts differ with ${enabled.join(',')}`);
  }
});

test('shipped lists: registrations stay inside the limits page load and Chrome allow', () => {
  const { byList, lists } = shipped();
  const c = compile(
    byList,
    lists.map((l) => l.id),
  );
  const regs = engine.shardRegistrations(
    c.index,
    lists.map((l) => l.id),
  );
  // One per bucket plus the broad one; Chrome re-checks every registration on every navigation.
  assert.ok(regs.length <= SHARD_BUCKETS + 1);
  const ids = regs.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  let patterns = 0;
  for (const r of regs) {
    const m = r.matches();
    patterns += m.length;
    // Chrome tests every pattern of every registration against every frame's URL (measured at
    // ~70 ns each); a bucket growing far past its share means the hashing broke.
    assert.ok(m.length < 4000, `${r.id} has ${m.length} patterns`);
    // Runtimes are separate files: Chrome injects one file once per document, so a shared
    // runtime would never run after the second registration's data.
    assert.equal(r.parts.filter((f) => !c.data.has(f)).length, 1, `${r.id} ends with its own runtime`);
    assert.ok(!c.data.has(r.parts.at(-1)));
  }
  assert.ok(patterns < 40000, `${patterns} patterns in total`);
  const runtimes = new Set(regs.map((r) => r.parts.at(-1)));
  assert.equal(runtimes.size, 2, 'bucket and broad registrations need different runtime files');
  // Every data file is parsed whole on a matching page (broad ones on every page).
  for (const f of c.files) {
    assert.ok(f.content.length < 160 * 1024, `${f.path} is ${f.content.length} bytes`);
    assert.match(f.content, /^[\x20-\x7e\n]*$/, `${f.path} must be plain ASCII`);
  }
});

test('shipped lists: with the default lists on, every scriptlet registration injects one file', () => {
  const index = JSON.parse(readFileSync(join(ROOT, 'src/generated/scriptlet-shards.json'), 'utf8'));
  const { lists } = shipped();
  const defaults = lists.filter((l) => l.enabledByDefault).map((l) => l.id);
  const regs = engine.shardRegistrations(index, defaults);
  assert.ok(regs.length > 2, 'no scriptlet registrations');
  for (const r of regs) {
    assert.deepEqual(r.js, [index.bundles?.[r.id]?.file], `${r.id} injects ${r.js.length} files`);
    assert.match(r.js[0], /^generated\/scriptlets\/bundle\.[^/]+\.js$/);
    assert.deepEqual(engine.shardParts(index, r.js), r.parts, r.id);
  }
  // www.youtube.com is matched by its bucket and by the broad registration. In a sandboxed
  // frame there, Chrome logged 8 "Blocked script execution" errors (5 + 3 files); now 2.
  const onYouTube = regs.filter((r) =>
    r.matches().some((p) => p === '*://*/*' || p === '*://*.youtube.com/*'),
  );
  assert.equal(onYouTube.length, 2);
  assert.equal(onYouTube.flatMap((r) => r.js).length, 2);
  assert.ok(onYouTube.flatMap((r) => r.parts).length > 2, 'the parts are what it used to inject');
});
