// Redirect coverage in the filter → DNR converter (review 2026-09-24 M1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLine } from '../scripts/lib/parse-filter.mjs';
import { toDnrRule } from '../scripts/lib/to-dnr.mjs';
import { REDIRECT_RESOURCES, REDIRECT_FILES, resolveRedirect } from '../scripts/lib/redirects.mjs';
import { PRIORITY, REDIRECT_PRIORITY_MAX_OFFSET } from '../scripts/lib/limits.mjs';

const REDIRECTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'redirects');
const convert = (line) => toDnrRule(parseLine(line));
const target = (line) => convert(line).rule?.action.redirect.extensionPath;

test('uBO\'s :N redirect priority suffix resolves and ranks within the redirect band', () => {
  // ubo-filters ships 17 of these; the whole filter used to be dropped.
  const out = convert(
    '||googlesyndication.com/pagead/js/adsbygoogle.js$script,redirect=noopjs:10,domain=shidurlive.com',
  );
  assert.equal(out.rule.action.redirect.extensionPath, '/redirects/noop.js');
  assert.equal(out.rule.priority, PRIORITY.REDIRECT + 10);
  assert.ok(out.rule.priority > convert('||x.example^$script,redirect=noopjs').rule.priority);

  assert.equal(target('||x.example^$media,redirect=noop-1s.mp4:10'), '/redirects/noop-1s.mp4');
  assert.equal(convert('||x.example^$script,important,redirect=noopjs:5').rule.priority, PRIORITY.IMPORTANT_REDIRECT + 5);

  // Clamped: a redirect never out-ranks an allow, never falls under the block it replaces.
  const high = convert('||x.example^$redirect=noopjs:99999').rule.priority;
  const low = convert('||x.example^$redirect=noopjs:-99999').rule.priority;
  assert.equal(high, PRIORITY.REDIRECT + REDIRECT_PRIORITY_MAX_OFFSET);
  assert.ok(high < PRIORITY.ALLOW);
  assert.ok(low > PRIORITY.BLOCK);
  const importantHigh = convert('||x.example^$important,redirect=noopjs:99999').rule.priority;
  assert.ok(importantHigh > PRIORITY.IMPORTANT_BLOCK && importantHigh < PRIORITY.IMPORTANT_ALLOW);
});

test('uBO resource names and aliases resolve to bundled files', () => {
  for (const [token, file] of [
    ['noop.css', 'noop.css'],
    ['empty', 'noop.txt'],
    ['noopjson', 'noop.json'],
    ['1x1.gif', '1x1.gif'],
    ['1x1-transparent.gif', '1x1.gif'],
    ['2x2.png', '2x2.png'],
    ['3x2.png', '3x2.png'],
    ['32x32.png', '32x32.png'],
    ['noopmp3-0.1s', 'noop-0.1s.mp3'],
    ['noop-0.1s.mp3', 'noop-0.1s.mp3'],
    ['noopmp4-1s', 'noop-1s.mp4'],
    ['noop-1s.mp4', 'noop-1s.mp4'],
    ['noopvast-3.0', 'noop-vast3.xml'],
    ['noopvmap-1.0', 'noop-vmap1.xml'],
  ]) {
    assert.equal(target(`||x.example^$redirect=${token}`), `/redirects/${file}`, token);
  }
});

test('ABP $rewrite=abp-resource:* is a redirect to the same resources', () => {
  for (const [name, file] of [
    ['blank-js', 'noop.js'],
    ['blank-css', 'noop.css'],
    ['blank-html', 'noop.html'],
    ['blank-text', 'noop.txt'],
    ['blank-mp3', 'noop-0.1s.mp3'],
    ['blank-mp4', 'noop-1s.mp4'],
    ['1x1-transparent-gif', '1x1.gif'],
    ['2x2-transparent-png', '2x2.png'],
    ['3x2-transparent-png', '3x2.png'],
    ['32x32-transparent-png', '32x32.png'],
  ]) {
    const out = convert(`||innovid.com/media/encoded/*.mp4$rewrite=abp-resource:${name},domain=ktla.com`);
    assert.equal(out.rule?.action.type, 'redirect', name);
    assert.equal(out.rule.action.redirect.extensionPath, `/redirects/${file}`, name);
    assert.deepEqual(out.rule.condition.initiatorDomains, ['ktla.com']);
  }
  assert.equal(convert('||x.example^$rewrite=abp-resource:nope').skip, 'redirect:abp-resource:nope');
});

test('unknown resources are still skipped, never turned into a block', () => {
  // A media block would break SoundCloud/Spotify, which share paths with their audio ads.
  assert.equal(convert('||x.example^$script,redirect=google-ima.js').skip, 'redirect:google-ima.js');
  assert.equal(convert('||x.example^$redirect=google-ima.js:5').skip, 'redirect:google-ima.js:5');
  assert.equal(resolveRedirect('constructor'), null);
  assert.equal(resolveRedirect('toString:5'), null);
  assert.deepEqual(resolveRedirect('noopjs:10')?.priority, 10);
});

test('@@…$redirect cancels only the redirect in uBO, so it never becomes an allow', () => {
  assert.equal(convert('@@||a.example^$redirect=noopjs').skip, 'exception-redirect');
  assert.equal(convert('@@||a.example^$redirect').skip, 'exception-redirect');
  assert.equal(convert('@@||a.example^$rewrite=abp-resource:blank-js').skip, 'exception-redirect');
});

// --- the bundled files themselves -------------------------------------------------------

test('every redirect resource ships in src/redirects', () => {
  for (const file of REDIRECT_FILES) assert.ok(existsSync(join(REDIRECTS, file)), file);
  for (const r of Object.values(REDIRECT_RESOURCES)) assert.ok(r.type, r.file);
});

test('transparent images decode to the size in their name', () => {
  const gif = readFileSync(join(REDIRECTS, '1x1.gif'));
  assert.equal(gif.subarray(0, 6).toString('latin1'), 'GIF89a');
  assert.deepEqual([gif.readUInt16LE(6), gif.readUInt16LE(8)], [1, 1]);
  assert.equal(gif[gif.length - 1], 0x3b, 'GIF trailer');
  for (const [file, w, h] of [
    ['2x2.png', 2, 2],
    ['3x2.png', 3, 2],
    ['32x32.png', 32, 32],
  ]) {
    const png = readFileSync(join(REDIRECTS, file));
    assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG', file);
    assert.equal(png.subarray(12, 16).toString('latin1'), 'IHDR', file);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [w, h], file);
    assert.equal(png[25], 6, `${file} is RGBA (transparent)`);
    assert.equal(png.subarray(-8, -4).toString('latin1'), 'IEND', file);
  }
});

/** MPEG audio frames: [count, seconds]. Throws on a byte that is not a frame header. */
function mp3Frames(buf) {
  const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000] };
  const KBPS = { 3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
  let i = 0;
  let n = 0;
  let seconds = 0;
  while (i < buf.length) {
    assert.ok(buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0, `frame sync at ${i}`);
    const version = (buf[i + 1] >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2
    assert.equal((buf[i + 1] >> 1) & 3, 1, 'Layer III');
    const kbps = KBPS[version][buf[i + 2] >> 4];
    const rate = RATES[version][(buf[i + 2] >> 2) & 3];
    const samples = version === 3 ? 1152 : 576;
    const size = Math.floor(((samples / 8) * kbps * 1000) / rate) + ((buf[i + 2] >> 1) & 1);
    i += size;
    n++;
    seconds += samples / rate;
  }
  assert.equal(i, buf.length, 'no trailing bytes');
  return [n, seconds];
}

test('noop-0.1s.mp3 is ~0.1 s of whole MPEG audio frames', () => {
  const [n, seconds] = mp3Frames(readFileSync(join(REDIRECTS, 'noop-0.1s.mp3')));
  assert.ok(n >= 2, `${n} frames`);
  assert.ok(seconds >= 0.1 && seconds < 0.15, `${seconds}s`);
});

test('noop-1s.mp4 is a ~1 s MP4 whose sample table points into mdat', () => {
  const buf = readFileSync(join(REDIRECTS, 'noop-1s.mp4'));
  const boxes = (start, end) => {
    const out = {};
    for (let i = start; i < end; ) {
      const size = buf.readUInt32BE(i);
      assert.ok(size >= 8 && i + size <= end, `box at ${i}`);
      out[buf.subarray(i + 4, i + 8).toString('latin1')] = { start: i + 8, end: i + size };
      i += size;
    }
    return out;
  };
  const top = boxes(0, buf.length);
  assert.deepEqual(Object.keys(top), ['ftyp', 'moov', 'mdat']);
  const moov = boxes(top.moov.start, top.moov.end);
  const mvhd = moov.mvhd.start;
  const seconds = buf.readUInt32BE(mvhd + 16) / buf.readUInt32BE(mvhd + 12);
  assert.ok(seconds >= 0.99 && seconds < 1.1, `${seconds}s`);
  const trak = boxes(moov.trak.start, moov.trak.end);
  const mdia = boxes(trak.mdia.start, trak.mdia.end);
  const minf = boxes(mdia.minf.start, mdia.minf.end);
  const stbl = boxes(minf.stbl.start, minf.stbl.end);
  const sampleSize = buf.readUInt32BE(stbl.stsz.start + 4);
  const sampleCount = buf.readUInt32BE(stbl.stsz.start + 8);
  const chunkOffset = buf.readUInt32BE(stbl.stco.start + 8);
  assert.equal(chunkOffset, top.mdat.start, 'stco points at the mdat payload');
  assert.equal(sampleSize * sampleCount, top.mdat.end - top.mdat.start, 'samples fill mdat');
  // The samples are the same silent MPEG audio frames as the mp3.
  mp3Frames(buf.subarray(top.mdat.start, top.mdat.end));
});

test('text resources parse', () => {
  assert.deepEqual(JSON.parse(readFileSync(join(REDIRECTS, 'noop.json'), 'utf8')), {});
  assert.equal(readFileSync(join(REDIRECTS, 'noop.txt'), 'utf8'), '', 'uBO `empty` is zero bytes');
  for (const [file, root] of [
    ['noop-vast2.xml', '<VAST version="2.0">'],
    ['noop-vast3.xml', '<VAST version="3.0">'],
    ['noop-vast4.xml', '<VAST version="4.0">'],
    ['noop-vmap1.xml', '<vmap:VMAP '],
  ]) {
    assert.ok(readFileSync(join(REDIRECTS, file), 'utf8').startsWith(root), file);
  }
});
