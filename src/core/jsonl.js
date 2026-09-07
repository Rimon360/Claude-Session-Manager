'use strict';
/**
 * Streaming JSONL reader with explicit corruption detection.
 *
 * Design rules this module exists to enforce:
 *  - Never read a whole transcript into memory. Real sessions on disk reach
 *    tens of megabytes today and gigabytes have been reported; a single
 *    readFileSync would both blow the heap and exceed V8's string cap.
 *  - Never silently skip a line we could not parse. A dropped line is silent
 *    data loss, which is the exact failure this product exists to prevent.
 *    Every bad line is recorded with its line number and byte offset.
 *  - Distinguish "damaged in the middle" from "truncated at the tail". A file
 *    whose final line is unterminated and unparseable is the classic
 *    partially-written file (writer died mid-append); that is recoverable
 *    information, not the same as interior corruption.
 */
const fs = require('fs');

/** A file with no newline terminator on its last line may be mid-write. */
const MAX_ERRORS_KEPT = 200;

/**
 * Integrity classifications.
 *  ok         - every non-blank line parsed
 *  empty      - zero bytes, or only whitespace
 *  truncated  - only defect is an unterminated, unparseable final line
 *  damaged    - one or more interior lines failed to parse
 *  unreadable - the file could not be opened or streamed at all
 */
const INTEGRITY = {
  OK: 'ok',
  EMPTY: 'empty',
  TRUNCATED: 'truncated',
  DAMAGED: 'damaged',
  UNREADABLE: 'unreadable',
};

/**
 * Stream a .jsonl file, invoking onRow(obj, ctx) for every successfully
 * parsed line. Returns an integrity report. Never throws for malformed
 * content -- malformed content is data about the file, and is reported.
 *
 * onRow may return the string 'stop' to end the scan early (used by fast
 * discovery passes that only need the head of a file).
 */
function readJsonl(filePath, onRow, options = {}) {
  const { signal } = options;
  return new Promise((resolve) => {
    const report = {
      filePath,
      integrity: INTEGRITY.OK,
      totalLines: 0,
      parsedRows: 0,
      blankLines: 0,
      errors: [],
      errorCount: 0,
      bytesRead: 0,
      lastLineTerminated: true,
      stoppedEarly: false,
    };

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (err) {
      report.integrity = INTEGRITY.UNREADABLE;
      report.errors.push({ line: 0, offset: 0, message: err.message, kind: 'open' });
      report.errorCount = 1;
      return resolve(report);
    }
    report.sizeBytes = stat.size;

    if (stat.size === 0) {
      report.integrity = INTEGRITY.EMPTY;
      return resolve(report);
    }

    const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1 << 20 });
    let buffer = '';
    let lineNo = 0;
    let offset = 0;      // byte offset of the start of `buffer`
    let sawAnyContent = false;
    let stopped = false;
    let firstChunk = true;

    const recordError = (line, off, message, kind, sample) => {
      report.errorCount++;
      if (report.errors.length < MAX_ERRORS_KEPT) {
        report.errors.push({ line, offset: off, message: String(message).slice(0, 300), kind, sample });
      }
    };

    const handleLine = (raw, isFinal) => {
      lineNo++;
      const byteLen = Buffer.byteLength(raw, 'utf8');
      const lineOffset = offset;
      offset += byteLen + (isFinal ? 0 : 1); // +1 for the consumed newline

      const trimmed = raw.trim();
      if (!trimmed) { report.blankLines++; return; }
      sawAnyContent = true;

      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch (err) {
        recordError(
          lineNo,
          lineOffset,
          err.message,
          isFinal && !report.lastLineTerminated ? 'truncated-tail' : 'parse',
          trimmed.length > 160 ? trimmed.slice(0, 80) + ' ... ' + trimmed.slice(-40) : trimmed
        );
        return;
      }
      report.parsedRows++;
      if (onRow) {
        const res = onRow(obj, { line: lineNo, offset: lineOffset, filePath });
        if (res === 'stop') { stopped = true; report.stoppedEarly = true; }
      }
    };

    const finish = () => {
      report.totalLines = lineNo;
      report.bytesRead = offset;

      if (!sawAnyContent) {
        report.integrity = INTEGRITY.EMPTY;
      } else if (report.errorCount === 0) {
        report.integrity = INTEGRITY.OK;
      } else {
        // Only defect is the final unterminated line -> partially written.
        const onlyTailError =
          report.errorCount === 1 &&
          report.errors.length === 1 &&
          report.errors[0].kind === 'truncated-tail';
        report.integrity = onlyTailError ? INTEGRITY.TRUNCATED : INTEGRITY.DAMAGED;
      }
      resolve(report);
    };

    stream.on('data', (chunk) => {
      if (stopped) { stream.destroy(); return; }
      if (firstChunk) {
        firstChunk = false;
        if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1); // strip BOM
      }
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, nl);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        buffer = buffer.slice(nl + 1);
        handleLine(line, false);
        if (stopped) { stream.destroy(); return; }
      }
      // Guard against a pathological single line with no newline at all.
      if (buffer.length > 512 * 1024 * 1024) {
        recordError(lineNo + 1, offset, 'single line exceeds 512MB without a newline', 'oversized-line');
        stream.destroy();
        report.integrity = INTEGRITY.DAMAGED;
        finish();
      }
    });

    stream.on('error', (err) => {
      recordError(lineNo, offset, err.message, 'stream');
      report.integrity = INTEGRITY.UNREADABLE;
      resolve(report);
    });

    stream.on('close', () => {
      if (stopped) { finish(); return; }
    });

    stream.on('end', () => {
      if (buffer.length) {
        // No trailing newline: the writer may have been interrupted mid-append.
        report.lastLineTerminated = false;
        let line = buffer;
        if (line.endsWith('\r')) line = line.slice(0, -1);
        buffer = '';
        handleLine(line, true);
      }
      finish();
    });

    if (signal) {
      signal.addEventListener('abort', () => { stopped = true; stream.destroy(); }, { once: true });
    }
  });
}

/**
 * Read only the first N parseable rows. Used by discovery so that listing a
 * directory of gigabyte transcripts stays fast -- we need the header rows for
 * metadata, not the whole conversation.
 */
async function readJsonlHead(filePath, limit = 40) {
  const rows = [];
  const report = await readJsonl(filePath, (obj) => {
    rows.push(obj);
    if (rows.length >= limit) return 'stop';
    return undefined;
  });
  return { rows, report };
}

/**
 * Read the last N non-blank lines by seeking from the end, without reading the
 * file front to back. Needed to get updatedAt / final model out of a huge
 * transcript cheaply.
 */
function readJsonlTail(filePath, limit = 5, maxScanBytes = 2 * 1024 * 1024) {
  return new Promise((resolve) => {
    let fd;
    try {
      fd = fs.openSync(filePath, 'r');
    } catch (err) {
      return resolve({ rows: [], error: err.message });
    }
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - maxScanBytes);
      const len = size - start;
      if (len <= 0) return resolve({ rows: [] });
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      const text = buf.toString('utf8');
      // If we started mid-file, drop the first (likely partial) line.
      const lines = text.split('\n');
      if (start > 0) lines.shift();
      const rows = [];
      for (let i = lines.length - 1; i >= 0 && rows.length < limit; i--) {
        const t = lines[i].trim();
        if (!t) continue;
        try { rows.push(JSON.parse(t)); } catch { /* tail junk is expected; ignore for metadata */ }
      }
      resolve({ rows: rows.reverse() });
    } catch (err) {
      resolve({ rows: [], error: err.message });
    } finally {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  });
}

/** True when the file is safe to use as a source for a copy/convert operation. */
function isUsable(integrity) {
  return integrity === INTEGRITY.OK || integrity === INTEGRITY.TRUNCATED;
}

module.exports = { readJsonl, readJsonlHead, readJsonlTail, INTEGRITY, isUsable };
