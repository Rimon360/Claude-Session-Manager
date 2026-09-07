'use strict';
/**
 * Corruption detection.
 *
 * The product promise is "you will never lose your session history", so the
 * failure this suite exists to catch is the quiet one: a parser that hits a
 * broken line, shrugs, and returns a session that looks fine but is missing
 * content. Every test here asserts both that the damage is REPORTED and that
 * the undamaged rows are still recovered.
 */
const fs = require('fs');
const path = require('path');
const H = require('./helpers');
const { readJsonl, readJsonlHead, readJsonlTail, INTEGRITY, isUsable } = require('../src/core/jsonl');

describe('jsonl: corruption detection', () => {
  let dir;
  beforeAll(() => { dir = H.tmpDir('jsonl'); return { dir }; });
  afterAll(() => H.rmrf(dir));

  it('reads a clean file and reports ok', async () => {
    const f = H.writeJsonl(path.join(dir, 'clean.jsonl'), H.claudeTranscript({ exchanges: 3 }));
    const rows = [];
    const r = await readJsonl(f, (o) => rows.push(o));
    assert.equal(r.integrity, INTEGRITY.OK);
    assert.equal(r.errorCount, 0);
    assert.equal(rows.length, r.parsedRows);
    assert.greater(rows.length, 10);
  });

  it('reports an empty file as empty rather than as a valid session', async () => {
    const f = path.join(dir, 'empty.jsonl');
    fs.writeFileSync(f, '');
    const r = await readJsonl(f, () => {});
    assert.equal(r.integrity, INTEGRITY.EMPTY);
  });

  it('reports a whitespace-only file as empty', async () => {
    const f = path.join(dir, 'blank.jsonl');
    fs.writeFileSync(f, '\n\n   \n\n');
    const r = await readJsonl(f, () => {});
    assert.equal(r.integrity, INTEGRITY.EMPTY);
    assert.equal(r.parsedRows, 0);
  });

  it('classifies a mid-line truncation as truncated, not as damaged', async () => {
    const f = H.writeJsonl(path.join(dir, 'trunc.jsonl'), H.claudeTranscript({ exchanges: 6 }));
    H.truncateFile(f, 0.63);
    const rows = [];
    const r = await readJsonl(f, (o) => rows.push(o));
    assert.equal(r.integrity, INTEGRITY.TRUNCATED, 'a partially written tail is recoverable and must not be called damaged');
    assert.equal(r.errorCount, 1);
    assert.equal(r.errors[0].kind, 'truncated-tail');
    assert.notOk(r.lastLineTerminated);
    assert.greater(rows.length, 0, 'rows before the cut must still be recovered');
  });

  it('detects an unparseable interior line and still recovers the rest', async () => {
    const rows0 = H.claudeTranscript({ exchanges: 6 });
    const f = H.writeJsonl(path.join(dir, 'mid.jsonl'), rows0);
    H.corruptLine(f, 5);
    const rows = [];
    const r = await readJsonl(f, (o) => rows.push(o));
    assert.equal(r.integrity, INTEGRITY.DAMAGED);
    assert.equal(r.errorCount, 1);
    assert.equal(r.errors[0].line, 6, 'error must carry a 1-based line number');
    assert.ok(r.errors[0].offset >= 0, 'error must carry a byte offset');
    assert.equal(rows.length, rows0.length - 1, 'every line except the broken one must be recovered');
  });

  it('reports a record split across physical lines by an unescaped newline', async () => {
    // A record broken in two by a raw newline inside a string value: neither
    // half is valid JSON, and reassembling them would be guesswork.
    const f = H.writeJsonl(path.join(dir, 'split.jsonl'), H.claudeTranscript({ exchanges: 4 }));
    H.splitRecordAcrossLines(f, 3);
    const r = await readJsonl(f, () => {});
    assert.equal(r.integrity, INTEGRITY.DAMAGED);
    assert.equal(r.errorCount, 2, 'both halves of the split record are unparseable and both must be reported');
  });

  it('counts multiple corrupt lines rather than stopping at the first', async () => {
    const f = H.writeJsonl(path.join(dir, 'multi.jsonl'), H.claudeTranscript({ exchanges: 8 }));
    H.corruptLine(f, 3);
    H.corruptLine(f, 9);
    H.corruptLine(f, 14);
    const r = await readJsonl(f, () => {});
    assert.equal(r.integrity, INTEGRITY.DAMAGED);
    assert.equal(r.errorCount, 3);
  });

  it('never silently drops content: parsed + errors + blanks accounts for every line', async () => {
    const f = H.writeJsonl(path.join(dir, 'account.jsonl'), H.claudeTranscript({ exchanges: 5 }));
    H.corruptLine(f, 4);
    H.corruptLine(f, 7);
    const r = await readJsonl(f, () => {});
    assert.equal(r.parsedRows + r.errorCount + r.blankLines, r.totalLines,
      'every physical line must be accounted for as parsed, failed, or blank');
  });

  it('treats a missing file as unreadable instead of empty', async () => {
    const r = await readJsonl(path.join(dir, 'does-not-exist.jsonl'), () => {});
    assert.equal(r.integrity, INTEGRITY.UNREADABLE);
    assert.equal(r.errors[0].kind, 'open');
  });

  it('handles CRLF line endings without treating them as corruption', async () => {
    const rows = H.claudeTranscript({ exchanges: 3 });
    const f = path.join(dir, 'crlf.jsonl');
    fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\r\n') + '\r\n', 'utf8');
    const r = await readJsonl(f, () => {});
    assert.equal(r.integrity, INTEGRITY.OK);
    assert.equal(r.parsedRows, rows.length);
  });

  it('strips a UTF-8 BOM rather than failing the first line', async () => {
    const rows = H.claudeTranscript({ exchanges: 2 });
    const f = path.join(dir, 'bom.jsonl');
    fs.writeFileSync(f, '﻿' + rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    const r = await readJsonl(f, () => {});
    assert.equal(r.integrity, INTEGRITY.OK);
    assert.equal(r.errorCount, 0);
  });

  it('marks damaged files as unusable and truncated files as usable', () => {
    assert.ok(isUsable(INTEGRITY.OK));
    assert.ok(isUsable(INTEGRITY.TRUNCATED), 'a clean prefix is still safe to copy');
    assert.notOk(isUsable(INTEGRITY.DAMAGED));
    assert.notOk(isUsable(INTEGRITY.UNREADABLE));
  });

  it('reads only the head when asked, without walking the whole file', async () => {
    const f = H.writeJsonl(path.join(dir, 'head.jsonl'), H.claudeTranscript({ exchanges: 40 }));
    const { rows, report } = await readJsonlHead(f, 5);
    assert.equal(rows.length, 5);
    assert.ok(report.stoppedEarly);
    assert.atMost(report.totalLines, 8, 'head scan must not read the whole file');
  });

  it('reads the tail by seeking from the end', async () => {
    const rows0 = H.claudeTranscript({ exchanges: 20 });
    const f = H.writeJsonl(path.join(dir, 'tail.jsonl'), rows0);
    const { rows } = await readJsonlTail(f, 3);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[rows.length - 1], rows0[rows0.length - 1]);
  });

  it('keeps a bounded number of error records on a heavily corrupted file', async () => {
    const f = path.join(dir, 'shredded.jsonl');
    fs.writeFileSync(f, Array.from({ length: 900 }, (_, i) => `{"broken":${i}`).join('\n') + '\n');
    const r = await readJsonl(f, () => {});
    assert.equal(r.integrity, INTEGRITY.DAMAGED);
    assert.equal(r.errorCount, 900, 'the true count must be reported');
    assert.atMost(r.errors.length, 200, 'but retained samples must stay bounded');
  });
});
