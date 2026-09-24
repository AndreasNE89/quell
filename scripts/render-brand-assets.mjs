// Rasterize the brand SVG masters in store/brand/ into the extension icons and the store art.
//   npm run icons         → src/icons/icon-{16,32,48,128}.png (RGBA)
//   npm run store-assets  → store/promo-small.png (440×280), store/promo-marquee.png (1400×560)
//
// Headless Chromium does the rasterizing (SVG → <img> → canvas at the exact target size, the same
// engine that draws the toolbar icon). PNG encoding happens here rather than via a screenshot, so
// the bytes are stable run to run and the store art can be written as 24-bit RGB: the Chrome Web
// Store wants promo images as JPEG or 24-bit PNG without alpha, so they're flattened onto paper.
// The masters have no live text (store-art text is outlined), so output doesn't depend on fonts.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRAND = join(ROOT, 'store', 'brand');
const PAPER = '#f4ecd8';

const main = join(BRAND, 'stampstack-icon.svg');
const small = join(BRAND, 'stampstack-icon-small.svg');
const hinted48 = join(BRAND, 'stampstack-icon-48.svg');
const JOBS = {
  icons: [
    { src: small, out: 'src/icons/icon-16.png', w: 16, h: 16 },
    { src: small, out: 'src/icons/icon-32.png', w: 32, h: 32 },
    { src: existsSync(hinted48) ? hinted48 : main, out: 'src/icons/icon-48.png', w: 48, h: 48 },
    { src: main, out: 'src/icons/icon-128.png', w: 128, h: 128 },
  ],
  store: [
    { src: join(BRAND, 'promo-440x280.svg'), out: 'store/promo-small.png', w: 440, h: 280, flatten: PAPER },
    { src: join(BRAND, 'marquee-1400x560.svg'), out: 'store/promo-marquee.png', w: 1400, h: 560, flatten: PAPER },
  ],
};

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

/** RGBA pixels → PNG. `alpha: false` drops the alpha channel (colour type 2, 24-bit RGB). */
function encodePng(rgba, w, h, alpha) {
  const bpp = alpha ? 4 : 3;
  const raw = Buffer.alloc(h * (1 + w * bpp));
  for (let y = 0, o = 0; y < h; y++) {
    raw[o++] = 0; // filter: none, keeps the encoder trivial; flat art deflates well anyway
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      raw[o++] = rgba[i];
      raw[o++] = rgba[i + 1];
      raw[o++] = rgba[i + 2];
      if (alpha) raw[o++] = rgba[i + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const which = process.argv.includes('--icons') ? ['icons'] : process.argv.includes('--store') ? ['store'] : ['icons', 'store'];
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const group of which) {
    for (const job of JOBS[group]) {
      const svg = readFileSync(job.src, 'utf8');
      const pixels = await page.evaluate(async ({ svg, w, h, flatten }) => {
        const img = new Image();
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        await img.decode();
        const ctx = Object.assign(document.createElement('canvas'), { width: w, height: h }).getContext('2d');
        if (flatten) {
          ctx.fillStyle = flatten;
          ctx.fillRect(0, 0, w, h);
        }
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        let bin = '';
        for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
        return btoa(bin);
      }, { svg, w: job.w, h: job.h, flatten: job.flatten ?? null });
      const png = encodePng(Buffer.from(pixels, 'base64'), job.w, job.h, !job.flatten);
      writeFileSync(join(ROOT, job.out), png);
      console.log(`  ok ${job.out} ${job.w}x${job.h} ${job.flatten ? 'RGB' : 'RGBA'} (${png.length} bytes) ← ${relative(ROOT, job.src).split(sep).join('/')}`);
    }
  }
} finally {
  await browser.close();
}
if (which.includes('store')) {
  console.log('Upload store/promo-small.png (Small promo tile) and store/promo-marquee.png (Marquee) in the CWS dashboard.');
}
