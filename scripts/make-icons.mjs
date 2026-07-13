// Generate Quell's toolbar/store icons (16/32/48/128) with zero dependencies.
// Draws a green disc with a white diagonal bar — the universal "blocked" mark —
// on a transparent background. PNG is hand-encoded (IHDR + zlib IDAT + IEND).

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'src', 'icons');

// Accent green (matches the UI --accent).
const GREEN = [47, 111, 79];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixels /* Uint8Array RGBA */) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // rest 0 (compression, filter, interlace)

  // Raw image data: each row prefixed with filter byte 0.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.subarray(y * stride, y * stride + stride).forEach((v, i) => {
      raw[y * (stride + 1) + 1 + i] = v;
    });
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function drawIcon(size) {
  const px = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  const R = size * 0.46;
  const barHalf = Math.max(1, size * 0.09);
  const barReach = R * 0.9;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      const dist = Math.hypot(dx, dy);
      const i = (y * size + x) * 4;
      if (dist > R + 0.5) continue; // transparent outside disc
      // Anti-diagonal signed distance from the center line.
      const sd = (dx - dy) / Math.SQRT2;
      const onBar = Math.abs(sd) <= barHalf && dist <= barReach;
      if (onBar) {
        px[i] = 245;
        px[i + 1] = 248;
        px[i + 2] = 246;
        px[i + 3] = 255;
      } else {
        px[i] = GREEN[0];
        px[i + 1] = GREEN[1];
        px[i + 2] = GREEN[2];
        // Soft 1px edge.
        px[i + 3] = dist > R - 1 ? Math.round(255 * Math.max(0, R + 0.5 - dist)) : 255;
      }
    }
  }
  return px;
}

mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, drawIcon(size));
  writeFileSync(join(OUT, `icon-${size}.png`), png);
  console.log(`  ✓ icon-${size}.png (${png.length} bytes)`);
}
