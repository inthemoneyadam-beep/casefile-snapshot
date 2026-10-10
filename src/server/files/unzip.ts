/**
 * Zip reading for restore (scripts/restore.ts) and the backup tests. Small
 * and dependency-free on purpose: extract-zip's yauzl 2 / fd-slicer stops
 * after the first 64 KiB of an entry on Node 24, so a restore of any real
 * backup hung forever.
 *
 * Reads the central directory (zip64 included), then streams each entry
 * through inflate into a new file: every path must stay inside the target
 * folder, every size and CRC-32 is checked, and an existing file is never
 * overwritten (the restore target is a fresh folder).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  isDir: boolean;
}

let crcTable: Uint32Array | null = null;

/** CRC-32 (zlib.crc32 where Node has it, a table otherwise). */
function crc32(buf: Buffer, prev: number): number {
  const native = (zlib as unknown as { crc32?: (d: Buffer, v?: number) => number }).crc32;
  if (typeof native === 'function') return native(buf, prev);
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function readAt(fd: number, pos: number, len: number): Buffer {
  const b = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const n = fs.readSync(fd, b, off, len - off, pos + off);
    if (n === 0) throw new Error('unexpected end of the zip file');
    off += n;
  }
  return b;
}

function readCentralDirectory(fd: number, fileSize: number): ZipEntry[] {
  const tailLen = Math.min(fileSize, 22 + 0xffff);
  if (tailLen < 22) throw new Error('not a zip file (too short)');
  const tailStart = fileSize - tailLen;
  const tail = readAt(fd, tailStart, tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file (no end of central directory)');
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = readAt(fd, tailStart + eocd - 20, 20);
    if (loc.readUInt32LE(0) !== 0x07064b50) throw new Error('zip64 locator missing');
    const z64 = readAt(fd, Number(loc.readBigUInt64LE(8)), 56);
    if (z64.readUInt32LE(0) !== 0x06064b50) throw new Error('zip64 end of central directory missing');
    count = Number(z64.readBigUInt64LE(32));
    cdSize = Number(z64.readBigUInt64LE(40));
    cdOffset = Number(z64.readBigUInt64LE(48));
  }
  const cd = readAt(fd, cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new Error('damaged central directory');
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    let compressedSize = cd.readUInt32LE(p + 20);
    let size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let localOffset = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    for (let e = 0; e + 4 <= extra.length; ) {
      const id = extra.readUInt16LE(e);
      const len = extra.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) {
          size = Number(extra.readBigUInt64LE(q));
          q += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = Number(extra.readBigUInt64LE(q));
          q += 8;
        }
        if (localOffset === 0xffffffff) localOffset = Number(extra.readBigUInt64LE(q));
      }
      e += 4 + len;
    }
    if (flags & 0x1) throw new Error(`${name} uses zip encryption; this is not a Casefile backup`);
    entries.push({ name, method, crc, compressedSize, size, localOffset, isDir: name.endsWith('/') });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** The entries of a zip file, without extracting anything. */
export function listZipEntries(zipPath: string): ZipEntry[] {
  const fd = fs.openSync(zipPath, 'r');
  try {
    return readCentralDirectory(fd, fs.fstatSync(fd).size);
  } finally {
    fs.closeSync(fd);
  }
}

/** Where an entry lands; refuses absolute paths, drive letters and `..` (zip slip). */
export function targetFor(destDir: string, name: string): string {
  const clean = name.replace(/\\/g, '/');
  if (!clean || clean.startsWith('/') || /^[a-zA-Z]:/.test(clean) || clean.split('/').includes('..')) throw new Error(`unsafe path in zip: ${name}`);
  const root = path.resolve(destDir);
  const target = path.resolve(root, clean);
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`unsafe path in zip: ${name}`);
  return target;
}

async function extractEntry(zipPath: string, fd: number, e: ZipEntry, target: string): Promise<void> {
  if (e.isDir) {
    fs.mkdirSync(target, { recursive: true });
    return;
  }
  if (e.method !== 0 && e.method !== 8) throw new Error(`${e.name}: unsupported compression method ${e.method}`);
  const local = readAt(fd, e.localOffset, 30);
  if (local.readUInt32LE(0) !== 0x04034b50) throw new Error(`${e.name}: damaged local header`);
  const start = e.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let crc = 0;
  let written = 0;
  const check = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      crc = crc32(chunk, crc);
      written += chunk.length;
      cb(null, chunk);
    },
  });
  const source = e.compressedSize > 0 ? fs.createReadStream(zipPath, { start, end: start + e.compressedSize - 1 }) : Readable.from([]);
  const out = fs.createWriteStream(target, { flags: 'wx', mode: 0o600 });
  if (e.method === 8) await pipeline(source, zlib.createInflateRaw(), check, out);
  else await pipeline(source, check, out);
  if (written !== e.size || crc !== e.crc) throw new Error(`${e.name}: damaged (size or CRC-32 does not match the zip directory)`);
}

/**
 * Extract every entry of a zip into destDir (created when missing). Each
 * file is checked against the zip's size and CRC-32; an existing file is
 * never overwritten (the extraction stops with EEXIST instead).
 */
export async function extractZip(zipPath: string, destDir: string, opts: { onProgress?: (done: { files: number; bytes: number; totalFiles: number }) => void } = {}): Promise<{ files: number; bytes: number }> {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const entries = readCentralDirectory(fd, fs.fstatSync(fd).size);
    const targets = entries.map((e) => targetFor(destDir, e.name));
    const totalFiles = entries.filter((e) => !e.isDir).length;
    fs.mkdirSync(destDir, { recursive: true });
    let files = 0;
    let bytes = 0;
    for (let i = 0; i < entries.length; i++) {
      await extractEntry(zipPath, fd, entries[i], targets[i]);
      if (!entries[i].isDir) {
        files++;
        bytes += entries[i].size;
        opts.onProgress?.({ files, bytes, totalFiles });
      }
    }
    return { files, bytes };
  } finally {
    fs.closeSync(fd);
  }
}
