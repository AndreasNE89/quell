// Generate Chrome Web Store promo tile (440×280) matching Quell icon colors.
// Output: store/promo-small.png

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'store');
const W = 440;
const H = 280;
const GREEN = [47, 111, 79];
const BG = [246, 248, 247];

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

function encodePng(w, h, pixels) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    for (let i = 0; i < stride; i++) raw[y * (stride + 1) + 1 + i] = pixels[y * stride + i];
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function setPx(px, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  px[i] = r;
  px[i + 1] = g;
  px[i + 2] = b;
  px[i + 3] = a;
}

function fillRect(px, x0, y0, w, h, r, g, b) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) setPx(px, x, y, r, g, b);
  }
}

function drawDisc(px, cx, cy, R) {
  const barHalf = Math.max(2, R * 0.09);
  const barReach = R * 0.9;
  for (let y = Math.floor(cy - R - 1); y <= Math.ceil(cy + R + 1); y++) {
    for (let x = Math.floor(cx - R - 1); x <= Math.ceil(cx + R + 1); x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy);
      if (dist > R + 0.5) continue;
      const sd = (dx - dy) / Math.SQRT2;
      const onBar = Math.abs(sd) <= barHalf && dist <= barReach;
      if (onBar) setPx(px, x, y, 245, 248, 246);
      else {
        const a = dist > R - 1 ? Math.round(255 * Math.max(0, R + 0.5 - dist)) : 255;
        setPx(px, x, y, GREEN[0], GREEN[1], GREEN[2], a);
      }
    }
  }
}

/** Minimal 5×7 bitmap for A–Z / space / digits — enough for "QUELL". */
const GLYPHS = {
  Q: ['01110', '10001', '10001', '10001', '10001', '10011', '01110', '00001'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function drawText(px, text, x0, y0, scale, r, g, b) {
  let x = x0;
  for (const ch of text) {
    const rows = GLYPHS[ch] || GLYPHS[' '];
    for (let row = 0; row < rows.length; row++) {
      for (let col = 0; col < rows[row].length; col++) {
        if (rows[row][col] !== '1') continue;
        fillRect(px, x + col * scale, y0 + row * scale, scale, scale, r, g, b);
      }
    }
    x += (5 + 1) * scale;
  }
}

const px = new Uint8Array(W * H * 4);
fillRect(px, 0, 0, W, H, BG[0], BG[1], BG[2]);
// Soft left accent bar
fillRect(px, 0, 0, 8, H, GREEN[0], GREEN[1], GREEN[2]);
drawDisc(px, 130, 140, 72);
drawText(px, 'QUELL', 230, 118, 5, GREEN[0], GREEN[1], GREEN[2]);

mkdirSync(OUT, { recursive: true });
const png = encodePng(W, H, px);
writeFileSync(join(OUT, 'promo-small.png'), png);
console.log(`✓ store/promo-small.png (${W}×${H}, ${png.length} bytes)`);
console.log('  Upload as Small promotional tile in Chrome Web Store Dashboard.');
