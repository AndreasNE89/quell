// Regenerate the tiny image, media and ad-XML stand-ins that `$redirect=` rules serve from
// src/redirects/ (uBO's 1x1.gif, 2x2.png, noopmp3-0.1s, noopmp4-1s, noopvast-*, …; the name
// map lives in scripts/lib/redirects.mjs). The files are committed; this script only exists
// so their bytes are reproducible and reviewable instead of opaque blobs.
//
//   node scripts/gen-redirect-media.mjs [outDir]    (default: src/redirects)
//
// No dependencies. The PNG IDAT bytes come from Node's zlib and could differ with another zlib
// build; they decode to the same transparent pixels either way.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] ?? join(ROOT, 'src', 'redirects');
mkdirSync(out, { recursive: true });

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// --- 1x1 transparent GIF (the classic 43-byte GIF89a) ---
writeFileSync(
  join(out, '1x1.gif'),
  Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64'),
);

// --- transparent PNGs (8-bit RGBA, every pixel 0) ---
function png(w, h) {
  const chunk = (type, data) => {
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    return Buffer.concat([u32(data.length), td, u32(crc32(td))]);
  };
  const ihdr = Buffer.concat([u32(w), u32(h), Buffer.from([8, 6, 0, 0, 0])]);
  const raw = Buffer.alloc(h * (1 + 4 * w)); // per row: filter byte 0, then transparent pixels
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
writeFileSync(join(out, '2x2.png'), png(2, 2));
writeFileSync(join(out, '3x2.png'), png(3, 2));
writeFileSync(join(out, '32x32.png'), png(32, 32));

// --- silent MP3 ---
// MPEG-2 Layer III (LSF), 8 kbit/s, 16 kHz, mono, no CRC (header FF F3 18 C0): 36-byte frames
// of 576 samples. All-zero side info (main_data_begin, part2_3_length and big_values all 0)
// decodes to digital silence.
const SR = 16000;
const SPF = 576;
const FRAME = Buffer.alloc(36);
FRAME.set([0xff, 0xf3, 0x18, 0xc0]);
const frames = (n) => Buffer.concat(Array.from({ length: n }, () => FRAME));
writeFileSync(join(out, 'noop-0.1s.mp3'), frames(Math.ceil((0.1 * SR) / SPF))); // 3 frames = 0.108 s

// --- 1 s MP4: one audio track carrying the same silent MP3 frames (ISO/IEC 14496-12/-14) ---
function box(type, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'ascii'), body]);
}
const full = (type, version, flags, ...parts) =>
  box(type, Buffer.from([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts);
const MATRIX = Buffer.concat(
  [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map((n) => u32(n)),
);
const N = Math.ceil(SR / SPF); // 28 frames = 1.008 s
const durTs = N * SPF; // in the media timescale (SR)
const movieTs = 1000;
const movieDur = Math.round((durTs / SR) * movieTs);
// ES_Descriptor: objectTypeIndication 0x69 (MPEG-2 audio, ISO/IEC 13818-3), streamType audio.
const desc = (tag, body) => Buffer.concat([Buffer.from([tag, body.length]), body]);
const decConfig = desc(
  0x04,
  Buffer.concat([
    Buffer.from([0x69, (0x05 << 2) | 1]), // OTI; streamType << 2 | reserved bit
    Buffer.from([0, 0, 0]), // bufferSizeDB
    u32(8000), // maxBitrate
    u32(8000), // avgBitrate
  ]),
);
const slConfig = desc(0x06, Buffer.from([0x02]));
const esDesc = desc(0x03, Buffer.concat([u16(1), Buffer.from([0]), decConfig, slConfig]));
const mp4a = box(
  'mp4a',
  Buffer.alloc(6), // reserved
  u16(1), // data_reference_index
  Buffer.alloc(8), // reserved
  u16(1), // channelcount
  u16(16), // samplesize
  u16(0), // pre_defined
  u16(0), // reserved
  u32(SR << 16), // samplerate, 16.16
  full('esds', 0, 0, esDesc),
);
function buildHeader(stcoOffset) {
  const stbl = box(
    'stbl',
    full('stsd', 0, 0, u32(1), mp4a),
    full('stts', 0, 0, u32(1), u32(N), u32(SPF)),
    full('stsc', 0, 0, u32(1), u32(1), u32(N), u32(1)),
    full('stsz', 0, 0, u32(FRAME.length), u32(N)),
    full('stco', 0, 0, u32(1), u32(stcoOffset)),
  );
  const minf = box(
    'minf',
    full('smhd', 0, 0, u16(0), u16(0)),
    box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
    stbl,
  );
  const mdia = box(
    'mdia',
    full('mdhd', 0, 0, u32(0), u32(0), u32(SR), u32(durTs), u16(0x55c4), u16(0)), // language 'und'
    full('hdlr', 0, 0, u32(0), Buffer.from('soun'), Buffer.alloc(12), Buffer.from('SoundHandler\0')),
    minf,
  );
  const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(movieDur),
    Buffer.alloc(8), u16(0), u16(0), u16(0x0100), u16(0), MATRIX, u32(0), u32(0));
  const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(movieTs), u32(movieDur),
    u32(0x10000), u16(0x0100), Buffer.alloc(10), MATRIX, Buffer.alloc(24), u32(2));
  const ftyp = box('ftyp', Buffer.from('isom'), u32(0x200), Buffer.from('isomiso2mp41'));
  const moov = box('moov', mvhd, box('trak', tkhd, mdia));
  return { ftyp, moov };
}
// stco points at the first byte of the mdat payload, which sits after ftyp + moov + mdat header.
let { ftyp, moov } = buildHeader(0);
({ ftyp, moov } = buildHeader(ftyp.length + moov.length + 8));
writeFileSync(join(out, 'noop-1s.mp4'), Buffer.concat([ftyp, moov, box('mdat', frames(N))]));

// --- empty JSON and ad-XML documents ---
writeFileSync(join(out, 'noop.json'), '{}');
writeFileSync(join(out, 'noop-vast2.xml'), '<VAST version="2.0"></VAST>');
writeFileSync(join(out, 'noop-vast3.xml'), '<VAST version="3.0"></VAST>');
writeFileSync(join(out, 'noop-vast4.xml'), '<VAST version="4.0"></VAST>');
writeFileSync(
  join(out, 'noop-vmap1.xml'),
  '<vmap:VMAP xmlns:vmap="http://www.iab.net/videosuite/vmap" version="1.0"></vmap:VMAP>',
);
