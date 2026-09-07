'use strict';
/**
 * Streaming ZIP writer and reader with ZIP64 support.
 *
 * Why not adm-zip: it builds archives in memory. Session transcripts on disk
 * already reach ~90MB on the reference machine, and 1-2GB transcripts have
 * been reported, so a buffer-everything archiver would exhaust the heap on
 * exactly the sessions a backup tool most needs to protect. Everything here
 * streams: bytes go file -> deflate -> archive without a whole-file buffer,
 * and ZIP64 records are emitted so entries and archives may exceed 4GB.
 *
 * Entries are written with general-purpose flag bit 3 (sizes in a trailing
 * data descriptor), because when streaming we do not know the compressed size
 * until after the data has been written.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

const LOCAL_SIG = 0x04034b50;
const DATA_DESC_SIG = 0x08074b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EXTRA_ID = 0x0001;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/* ---------------------------------------------------------------- CRC32 */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32Update(crc, buf) {
  let c = crc ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/** Passthrough stream that accumulates a CRC32 and a byte count. */
class CrcCounter extends Transform {
  constructor() { super(); this.crc = 0; this.bytes = 0; }
  _transform(chunk, _enc, cb) {
    this.crc = crc32Update(this.crc, chunk);
    this.bytes += chunk.length;
    this.push(chunk);
    cb();
  }
}

/* ---------------------------------------------------------------- Writer */

function dosDateTime(date) {
  const d = date instanceof Date && !isNaN(date) ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const dt = (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date: dt };
}

class ZipWriter {
  constructor(outPath) {
    this.outPath = outPath;
    this.entries = [];
    this.offset = 0;
    this.out = null;
  }

  async open() {
    await fsp.mkdir(path.dirname(this.outPath), { recursive: true });
    this.out = fs.createWriteStream(this.outPath);
    await new Promise((res, rej) => { this.out.once('open', res); this.out.once('error', rej); });
  }

  _write(buf) {
    this.offset += buf.length;
    if (!this.out.write(buf)) {
      return new Promise((res) => this.out.once('drain', res));
    }
    return null;
  }

  async _writeAsync(buf) {
    const p = this._write(buf);
    if (p) await p;
  }

  _localHeader(name, method, dt) {
    const nameBuf = Buffer.from(name, 'utf8');
    const b = Buffer.alloc(30);
    b.writeUInt32LE(LOCAL_SIG, 0);
    b.writeUInt16LE(45, 4);                    // version needed (4.5 = zip64)
    b.writeUInt16LE(0x0008 | 0x0800, 6);       // bit 3 data descriptor, bit 11 UTF-8
    b.writeUInt16LE(method, 8);
    b.writeUInt16LE(dt.time, 10);
    b.writeUInt16LE(dt.date, 12);
    b.writeUInt32LE(0, 14);                    // crc (in descriptor)
    b.writeUInt32LE(0, 18);                    // csize (in descriptor)
    b.writeUInt32LE(0, 22);                    // usize (in descriptor)
    b.writeUInt16LE(nameBuf.length, 26);
    b.writeUInt16LE(0, 28);
    return Buffer.concat([b, nameBuf]);
  }

  _dataDescriptor(crc, csize, usize) {
    // ZIP64 descriptor: 8-byte sizes.
    const b = Buffer.alloc(24);
    b.writeUInt32LE(DATA_DESC_SIG, 0);
    b.writeUInt32LE(crc >>> 0, 4);
    b.writeBigUInt64LE(BigInt(csize), 8);
    b.writeBigUInt64LE(BigInt(usize), 16);
    return b;
  }

  /** Add a file from disk, streamed. */
  async addFile(name, filePath, options = {}) {
    const stat = await fsp.stat(filePath);
    const method = options.store ? METHOD_STORE : METHOD_DEFLATE;
    const dt = dosDateTime(stat.mtime);
    const localOffset = this.offset;

    await this._writeAsync(this._localHeader(name, method, dt));

    const crcCounter = new CrcCounter();
    const source = fs.createReadStream(filePath, { highWaterMark: 1 << 20 });

    // CRC is taken over the *uncompressed* bytes, so it sits before deflate.
    const stages = method === METHOD_DEFLATE
      ? [source, crcCounter, zlib.createDeflateRaw({ level: 6 })]
      : [source, crcCounter];

    // Terminal sink: forwards compressed bytes into the archive and keeps the
    // running offset. The archive stream stays open across entries, so we
    // cannot let pipeline end it -- hence a Writable of our own rather than
    // piping straight into this.out.
    let compressedBytes = 0;
    const sink = new (require('stream').Writable)({
      highWaterMark: 1 << 20,
      write: (chunk, _enc, cb) => {
        compressedBytes += chunk.length;
        this.offset += chunk.length;
        if (this.out.write(chunk)) cb();
        else this.out.once('drain', cb);
      },
    });

    await pipeline(...stages, sink);

    await this._writeAsync(this._dataDescriptor(crcCounter.crc, compressedBytes, crcCounter.bytes));

    this.entries.push({
      name, method, dt,
      crc: crcCounter.crc,
      csize: compressedBytes,
      usize: crcCounter.bytes,
      localOffset,
    });
  }

  /** Add an in-memory buffer or string. */
  async addBuffer(name, data, options = {}) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const method = options.store ? METHOD_STORE : METHOD_DEFLATE;
    const dt = dosDateTime(options.mtime ? new Date(options.mtime) : new Date());
    const localOffset = this.offset;

    await this._writeAsync(this._localHeader(name, method, dt));
    const crc = crc32Update(0, buf);
    const payload = method === METHOD_DEFLATE ? zlib.deflateRawSync(buf, { level: 6 }) : buf;
    await this._writeAsync(payload);
    await this._writeAsync(this._dataDescriptor(crc, payload.length, buf.length));

    this.entries.push({ name, method, dt, crc, csize: payload.length, usize: buf.length, localOffset });
  }

  async close() {
    const centralStart = this.offset;

    for (const e of this.entries) {
      const nameBuf = Buffer.from(e.name, 'utf8');
      // Always emit a ZIP64 extra field so large entries are representable.
      const extra = Buffer.alloc(4 + 24);
      extra.writeUInt16LE(ZIP64_EXTRA_ID, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(e.usize), 4);
      extra.writeBigUInt64LE(BigInt(e.csize), 12);
      extra.writeBigUInt64LE(BigInt(e.localOffset), 20);

      const h = Buffer.alloc(46);
      h.writeUInt32LE(CENTRAL_SIG, 0);
      h.writeUInt16LE(45, 4);                  // version made by
      h.writeUInt16LE(45, 6);                  // version needed
      h.writeUInt16LE(0x0008 | 0x0800, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.dt.time, 12);
      h.writeUInt16LE(e.dt.date, 14);
      h.writeUInt32LE(e.crc >>> 0, 16);
      h.writeUInt32LE(0xffffffff, 20);         // csize -> zip64
      h.writeUInt32LE(0xffffffff, 24);         // usize -> zip64
      h.writeUInt16LE(nameBuf.length, 28);
      h.writeUInt16LE(extra.length, 30);
      h.writeUInt16LE(0, 32);                  // comment length
      h.writeUInt16LE(0, 34);                  // disk number
      h.writeUInt16LE(0, 36);                  // internal attrs
      h.writeUInt32LE(0, 38);                  // external attrs
      h.writeUInt32LE(0xffffffff, 42);         // local offset -> zip64

      await this._writeAsync(Buffer.concat([h, nameBuf, extra]));
    }

    const centralSize = this.offset - centralStart;

    // ZIP64 end of central directory
    const z64 = Buffer.alloc(56);
    z64.writeUInt32LE(ZIP64_EOCD_SIG, 0);
    z64.writeBigUInt64LE(BigInt(44), 4);       // size of this record - 12
    z64.writeUInt16LE(45, 12);
    z64.writeUInt16LE(45, 14);
    z64.writeUInt32LE(0, 16);
    z64.writeUInt32LE(0, 20);
    z64.writeBigUInt64LE(BigInt(this.entries.length), 24);
    z64.writeBigUInt64LE(BigInt(this.entries.length), 32);
    z64.writeBigUInt64LE(BigInt(centralSize), 40);
    z64.writeBigUInt64LE(BigInt(centralStart), 48);
    const z64Offset = this.offset;
    await this._writeAsync(z64);

    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(ZIP64_LOCATOR_SIG, 0);
    loc.writeUInt32LE(0, 4);
    loc.writeBigUInt64LE(BigInt(z64Offset), 8);
    loc.writeUInt32LE(1, 16);
    await this._writeAsync(loc);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(Math.min(this.entries.length, 0xffff), 8);
    eocd.writeUInt16LE(Math.min(this.entries.length, 0xffff), 10);
    eocd.writeUInt32LE(centralSize > 0xffffffff ? 0xffffffff : centralSize, 12);
    eocd.writeUInt32LE(centralStart > 0xffffffff ? 0xffffffff : centralStart, 16);
    eocd.writeUInt16LE(0, 20);
    await this._writeAsync(eocd);

    await new Promise((res, rej) => { this.out.end((err) => (err ? rej(err) : res())); });
    return { path: this.outPath, entries: this.entries.length, bytes: this.offset };
  }
}

/* ---------------------------------------------------------------- Reader */

/**
 * Read the central directory. We locate the EOCD by scanning backwards from
 * the end of the file, then follow the ZIP64 locator when present.
 */
async function readCentralDirectory(zipPath) {
  const fh = await fsp.open(zipPath, 'r');
  try {
    const { size } = await fh.stat();
    if (size < 22) throw new Error('file is too small to be a zip archive');

    const tailLen = Math.min(size, 66 * 1024);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);

    let eocdPos = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocdPos = i; break; }
    }
    if (eocdPos < 0) throw new Error('end of central directory not found — file is not a zip archive or is truncated');

    let entryCount = tail.readUInt16LE(eocdPos + 10);
    let centralSize = tail.readUInt32LE(eocdPos + 12);
    let centralStart = tail.readUInt32LE(eocdPos + 16);

    // ZIP64 locator sits immediately before the EOCD.
    const locPos = eocdPos - 20;
    if (locPos >= 0 && tail.readUInt32LE(locPos) === ZIP64_LOCATOR_SIG) {
      const z64Off = Number(tail.readBigUInt64LE(locPos + 8));
      const z64 = Buffer.alloc(56);
      await fh.read(z64, 0, 56, z64Off);
      if (z64.readUInt32LE(0) === ZIP64_EOCD_SIG) {
        entryCount = Number(z64.readBigUInt64LE(32));
        centralSize = Number(z64.readBigUInt64LE(40));
        centralStart = Number(z64.readBigUInt64LE(48));
      }
    }

    const central = Buffer.alloc(centralSize);
    await fh.read(central, 0, centralSize, centralStart);

    const entries = [];
    let p = 0;
    for (let i = 0; i < entryCount && p + 46 <= central.length; i++) {
      if (central.readUInt32LE(p) !== CENTRAL_SIG) break;
      const method = central.readUInt16LE(p + 10);
      const crc = central.readUInt32LE(p + 16);
      let csize = central.readUInt32LE(p + 20);
      let usize = central.readUInt32LE(p + 24);
      const nameLen = central.readUInt16LE(p + 28);
      const extraLen = central.readUInt16LE(p + 30);
      const commentLen = central.readUInt16LE(p + 32);
      let localOffset = central.readUInt32LE(p + 42);
      const name = central.toString('utf8', p + 46, p + 46 + nameLen);

      // Parse the ZIP64 extra field for any 0xffffffff placeholders.
      let ep = p + 46 + nameLen;
      const extraEnd = ep + extraLen;
      while (ep + 4 <= extraEnd) {
        const id = central.readUInt16LE(ep);
        const sz = central.readUInt16LE(ep + 2);
        if (id === ZIP64_EXTRA_ID) {
          let q = ep + 4;
          if (usize === 0xffffffff) { usize = Number(central.readBigUInt64LE(q)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(central.readBigUInt64LE(q)); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = Number(central.readBigUInt64LE(q)); q += 8; }
        }
        ep += 4 + sz;
      }

      entries.push({ name, method, crc, csize, usize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await fh.close();
  }
}

/** Byte offset where an entry's data begins (after its local header). */
async function dataOffset(fh, localOffset) {
  const h = Buffer.alloc(30);
  await fh.read(h, 0, 30, localOffset);
  if (h.readUInt32LE(0) !== LOCAL_SIG) throw new Error('local file header signature mismatch — archive is corrupt');
  const nameLen = h.readUInt16LE(26);
  const extraLen = h.readUInt16LE(28);
  return localOffset + 30 + nameLen + extraLen;
}

/** Stream one entry out of the archive to a destination path. */
async function extractEntryToFile(zipPath, entry, destPath, options = {}) {
  const fh = await fsp.open(zipPath, 'r');
  try {
    const start = await dataOffset(fh, entry.localOffset);
    await fsp.mkdir(path.dirname(destPath), { recursive: true });

    const tmp = destPath + '.aism-unzip-' + process.pid;
    const source = fh.createReadStream({ start, end: start + entry.csize - 1, autoClose: false });
    const crcCounter = new CrcCounter();
    const out = fs.createWriteStream(tmp);

    if (entry.method === METHOD_DEFLATE) {
      await pipeline(source, zlib.createInflateRaw(), crcCounter, out);
    } else {
      await pipeline(source, crcCounter, out);
    }

    if (options.verifyCrc !== false && (crcCounter.crc >>> 0) !== (entry.crc >>> 0)) {
      await fsp.unlink(tmp).catch(() => {});
      throw new Error(
        `CRC mismatch extracting ${entry.name}: archive says ${(entry.crc >>> 0).toString(16)}, ` +
        `content hashes to ${(crcCounter.crc >>> 0).toString(16)}. The bundle is corrupt; nothing was written.`
      );
    }
    await fsp.rename(tmp, destPath);
    return { destPath, bytes: crcCounter.bytes };
  } finally {
    await fh.close();
  }
}

/** Read a (small) entry fully into memory -- manifests and normalized JSON. */
async function readEntryBuffer(zipPath, entry, options = {}) {
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  if (entry.usize > maxBytes) {
    throw new Error(`entry ${entry.name} is ${entry.usize} bytes, above the ${maxBytes}-byte in-memory limit; extract it to disk instead`);
  }
  const fh = await fsp.open(zipPath, 'r');
  try {
    const start = await dataOffset(fh, entry.localOffset);
    const raw = Buffer.alloc(entry.csize);
    await fh.read(raw, 0, entry.csize, start);
    const out = entry.method === METHOD_DEFLATE ? zlib.inflateRawSync(raw) : raw;
    if (options.verifyCrc !== false && (crc32Update(0, out) >>> 0) !== (entry.crc >>> 0)) {
      throw new Error(`CRC mismatch reading ${entry.name}; the bundle is corrupt`);
    }
    return out;
  } finally {
    await fh.close();
  }
}

module.exports = {
  ZipWriter, readCentralDirectory, extractEntryToFile, readEntryBuffer, crc32Update,
  METHOD_STORE, METHOD_DEFLATE,
};
