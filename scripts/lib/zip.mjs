// The store zip: written directly, and read back through its central directory.
//
// Two archivers have already produced something Chrome would reject: PowerShell's
// Compress-Archive writes nested entry names with BACKSLASHES (the ZIP spec, APPNOTE 4.4.17.1,
// requires forward slashes), and GNU tar - which is what `tar` resolves to under Git Bash -
// silently writes a plain TAR when handed a `.zip` name, because it has no zip writer at all.
// Emitting the container ourselves removes the dependency, guarantees POSIX separators, and pins
// timestamps so the same dist/ always yields the same bytes.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * Every file under `dir` as a ZIP archive, entries sorted by POSIX path.
 * @returns {{ bytes: Buffer, names: string[] }}
 */
export function zipDirectory(dir) {
  const names = walk(dir)
    .map((f) => relative(dir, f).split(sep).join('/'))
    .sort();

  // Fixed 1980-01-01 DOS timestamp: build output should not differ run to run.
  const DOS_TIME = 0;
  const DOS_DATE = 0x0021;

  const chunks = [];
  const central = [];
  let offset = 0;

  for (const name of names) {
    const raw = readFileSync(join(dir, name));
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const nameBuf = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(CENTRAL, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(END, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return { bytes: Buffer.concat([...chunks, cdBuf, eocd]), names };
}

/**
 * The entries of a ZIP archive, read the way an unzipper does: find the end-of-central-directory
 * record, walk the central directory it points to, and inflate each entry to check its CRC.
 *
 * Scanning the whole file for the central-directory signature instead (as package.mjs used to)
 * also counts any `PK\x01\x02` that happens to occur inside compressed data, which fails a valid
 * package deterministically for as long as that content stays the same.
 * @returns {{ name: string, size: number }[]}
 * @throws {Error} when the archive is not a well-formed ZIP of this shape
 */
export function readZipEntries(buf) {
  if (buf.length < 22 || buf.readUInt32LE(0) !== LOCAL) throw new Error('not a ZIP archive (no local file header)');
  // The EOCD record is the last 22 bytes plus a comment of up to 65535 bytes.
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === END && i + 22 + buf.readUInt16LE(i + 20) === buf.length) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('no end-of-central-directory record');
  const count = buf.readUInt16LE(end + 10);
  const cdSize = buf.readUInt32LE(end + 12);
  const cdOffset = buf.readUInt32LE(end + 16);
  if (cdOffset + cdSize !== end) throw new Error('central directory does not end where the EOCD record begins');

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || buf.readUInt32LE(p) !== CENTRAL) throw new Error(`central directory entry ${i} is malformed`);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (buf.readUInt32LE(localAt) !== LOCAL) throw new Error(`${name}: no local header at ${localAt}`);
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const body = buf.subarray(dataAt, dataAt + compressed);
    const data = method === 8 ? inflateRawSync(body) : method === 0 ? body : null;
    if (!data) throw new Error(`${name}: unsupported compression method ${method}`);
    if (data.length !== size || crc32(data) !== crc) throw new Error(`${name}: content does not match its CRC`);

    entries.push({ name, size });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (p !== end) throw new Error('central directory holds more than its entry count');
  return entries;
}
