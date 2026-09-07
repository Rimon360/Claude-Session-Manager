'use strict';
/**
 * Behaviour on very large sessions.
 *
 * Real transcripts reach 1-2GB and the reference machine
 * already holds an 88MB Claude Code transcript, so "does not hang and does not
 * run out of memory" is a functional requirement, not a nicety.
 *
 * The default fixture is ~180MB so the suite stays runnable. Set
 * AISM_TEST_HUGE_MB to raise it (e.g. AISM_TEST_HUGE_MB=1500 for a 1.5GB run).
 */
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const { readJsonl, readJsonlHead, readJsonlTail } = require('../src/core/jsonl');
const claudeCode = require('../src/core/parsers/claude-code');
const discovery = require('../src/core/discovery');
const bundle = require('../src/core/bundle');
const uss = require('../src/core/uss');

const TARGET_MB = Number(process.env.AISM_TEST_HUGE_MB || 180);

function rssMB() { return process.memoryUsage().rss / 1048576; }
function heapMB() { return process.memoryUsage().heapUsed / 1048576; }

/** Write a syntactically real Claude Code transcript of roughly `mb` megabytes. */
async function buildLarge(filePath, mb) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const ws = fs.createWriteStream(filePath);
  const target = mb * 1048576;
  const sessionId = 'ffffffff-0000-0000-0000-ffffffffffff';
  let written = 0;
  let i = 0;
  const blob = 'x'.repeat(2000);

  while (written < target) {
    const rows = [
      { parentUuid: null, isSidechain: false, userType: 'external', cwd: 'F:\\big', sessionId, version: '2.1.0', uuid: `u-${i}-a`, timestamp: new Date(1767225600000 + i * 1000).toISOString(), type: 'user', message: { role: 'user', content: [{ type: 'text', text: `q${i} ${blob}` }] } },
      { parentUuid: `u-${i}-a`, isSidechain: false, userType: 'external', cwd: 'F:\\big', sessionId, version: '2.1.0', uuid: `u-${i}-b`, timestamp: new Date(1767225600000 + i * 1000 + 1).toISOString(), type: 'assistant', message: { id: `msg_${i}`, role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: `a${i} ${blob}` }] } },
    ];
    for (const r of rows) {
      const line = JSON.stringify(r) + '\n';
      written += Buffer.byteLength(line);
      if (!ws.write(line)) await new Promise((res) => ws.once('drain', res));
    }
    i++;
  }
  await new Promise((res) => ws.end(res));
  return { path: filePath, sessionId, exchanges: i, bytes: fs.statSync(filePath).size };
}

describe('large sessions', () => {
  let dir, big;

  beforeAll(async () => {
    dir = H.tmpDir('large');
    process.env.AISM_HOME_OVERRIDE = dir;
    process.env.AISM_DATA_OVERRIDE = path.join(dir, 'appdata');
    const cc = H.claudeRoot(dir);
    big = await buildLarge(path.join(cc.projectsDir, 'ffffffff-0000-0000-0000-ffffffffffff.jsonl'), TARGET_MB);
    return { dir, big, cc };
  });

  afterAll(() => {
    delete process.env.AISM_HOME_OVERRIDE;
    delete process.env.AISM_DATA_OVERRIDE;
    H.rmrf(dir);
  });

  it(`builds a ~${TARGET_MB}MB transcript fixture`, () => {
    assert.atLeast(big.bytes, TARGET_MB * 1048576 * 0.95);
  });

  it('lists a huge session from head and tail without reading it all', async () => {
    const t0 = Date.now();
    const meta = await claudeCode.scanSessionMeta(big.path, 'acct');
    const ms = Date.now() - t0;
    assert.equal(meta.sessionId, big.sessionId);
    assert.equal(meta.model, 'claude-opus-5');
    assert.ok(meta.updatedAt, 'the tail read must recover a final timestamp');
    assert.atMost(ms, 2500, `metadata scan of a ${TARGET_MB}MB file took ${ms}ms; it must not read the whole file`);
  });

  it('scans a directory containing a huge session quickly', async () => {
    const t0 = Date.now();
    const scan = await discovery.scanAll();
    const ms = Date.now() - t0;
    assert.equal(scan.totals.sessions, 1);
    assert.atMost(ms, 4000, `full scan took ${ms}ms`);
  });

  it('streams the whole file for integrity checking with bounded memory', async () => {
    if (global.gc) global.gc();
    const before = rssMB();
    let rows = 0;
    const report = await readJsonl(big.path, () => { rows++; });
    const growth = rssMB() - before;

    assert.equal(report.integrity, 'ok');
    assert.equal(report.parsedRows, rows);
    assert.greater(rows, 1000);
    assert.atMost(growth, 260,
      `RSS grew ${growth.toFixed(0)}MB while streaming a ${TARGET_MB}MB file; it must not scale with file size`);
  });

  it('hashes a huge session incrementally without building a message array', async () => {
    if (global.gc) global.gc();
    const before = heapMB();
    const hasher = uss.createContentHasher();
    let sunk = 0;

    const { session } = await claudeCode.parseSession(big.path, {
      includeRawRows: false,
      messageSink: (m) => { hasher.update(m); sunk++; },
    });
    const growth = heapMB() - before;

    assert.equal(session.messages.length, 0, 'with a sink supplied, no messages may be retained');
    assert.equal(sunk, big.exchanges * 2);
    assert.ok(hasher.digest().startsWith('sha256:'));
    assert.atMost(growth, 220,
      `heap grew ${growth.toFixed(0)}MB streaming a ${TARGET_MB}MB file into the hasher`);
  });

  it('produces the same hash whether streamed or fully parsed', async () => {
    // Verify on a small file, where both paths are affordable.
    const small = H.writeJsonl(path.join(dir, 'small.jsonl'), H.claudeTranscript({ exchanges: 5 }));
    const { session: full } = await claudeCode.parseSession(small, {});
    const hasher = uss.createContentHasher();
    await claudeCode.parseSession(small, { messageSink: (m) => hasher.update(m) });
    assert.equal(hasher.digest(), full.contentHash,
      'the streamed digest must equal the fully-parsed one, or large and small sessions could never compare equal');
  });

  it('exports a huge session without loading it into memory', async () => {
    const scan = await discovery.scanAll();
    const entry = scan.tools.flatMap((t) => t.sessions).find((s) => s.sessionId === big.sessionId);
    assert.ok(entry);

    if (global.gc) global.gc();
    const before = rssMB();
    const t0 = Date.now();
    const zip = path.join(dir, 'huge.zip');
    const res = await bundle.exportBundle([entry], zip);
    const growth = rssMB() - before;
    const secs = (Date.now() - t0) / 1000;

    const rec = res.manifest.sessions[0];
    assert.ok(rec.streamed, 'a session over the threshold must take the streaming path');
    assert.equal(rec.messageCount, big.exchanges * 2);
    assert.ok(rec.contentHash.startsWith('sha256:'));
    assert.equal(rec.integrity, 'ok');
    assert.ok(fs.existsSync(zip));
    assert.atMost(growth, 300,
      `RSS grew ${growth.toFixed(0)}MB exporting a ${TARGET_MB}MB session`);
    assert.atMost(secs, 180, `export took ${secs.toFixed(1)}s`);
  });

  it('writes a normalized copy that is valid JSON and matches its own hash', async () => {
    const zip = path.join(dir, 'huge.zip');
    const { manifest, entries } = await bundle.readManifest(zip);
    const rec = manifest.sessions[0];
    const zipstream = require('../src/core/zipstream');
    const e = entries.find((x) => x.name === rec.normalizedEntry);
    assert.ok(e, 'the normalized entry must exist in the archive');

    const out = path.join(dir, 'normalized-out.json');
    await zipstream.extractEntryToFile(zip, e, out);

    // At 1GB+ the normalized document exceeds V8's ~512MB single-string cap,
    // so it cannot be read with readFileSync/JSON.parse. Validate it by
    // streaming instead: check the header, then re-hash the messages one at a
    // time and compare against the manifest.
    const size = fs.statSync(out).size;
    const head = Buffer.alloc(Math.min(4096, size));
    const fd = fs.openSync(out, 'r');
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    const headText = head.toString('utf8');
    assert.includes(headText, `"schemaVersion":${uss.SCHEMA_VERSION}`);
    assert.includes(headText, `"contentHash":"${rec.contentHash}"`);
    assert.includes(headText, '"messages":[');

    const hasher = uss.createContentHasher();
    let count = 0;
    await new Promise((resolve, reject) => {
      const rl = require('readline').createInterface({ input: fs.createReadStream(out) });
      rl.on('line', (line) => {
        let t = line.trim();
        if (!t || t === ']}' || t === '[') return;
        if (t.startsWith('{"schemaVersion"')) {
          // Header line ends with `,"messages":[` -- nothing to hash on it.
          const idx = t.indexOf('"messages":[');
          if (idx >= 0) t = t.slice(idx + '"messages":['.length).trim();
          if (!t) return;
        }
        if (t.endsWith(',')) t = t.slice(0, -1);
        if (t.endsWith(']}')) t = t.slice(0, -2);
        if (!t.startsWith('{')) return;
        try { hasher.update(JSON.parse(t)); count++; } catch { /* structural line */ }
      });
      rl.on('close', resolve);
      rl.on('error', reject);
    });

    assert.equal(count, rec.messageCount, 'every message must be present in the normalized copy');
    assert.equal(hasher.digest(), rec.contentHash,
      'a streamed normalized copy must hash to the value recorded in the manifest');
  });

  it('restores the huge session byte-for-byte from the bundle', async () => {
    const zip = path.join(dir, 'huge.zip');
    // Move the original aside so the import has somewhere to land.
    const stash = big.path + '.orig';
    fs.renameSync(big.path, stash);

    const plan = await bundle.planImport(zip);
    assert.equal(plan.summary.write, 1);
    const res = await bundle.executeImport(plan.token, {});
    assert.equal(res.results[0].applied, 'written');

    assert.equal(fs.statSync(big.path).size, fs.statSync(stash).size, 'restored size must match');

    // Compare in chunks rather than reading two large buffers.
    const a = fs.createReadStream(stash, { highWaterMark: 1 << 20 });
    const b = fs.createReadStream(big.path, { highWaterMark: 1 << 20 });
    const ha = require('crypto').createHash('sha256');
    const hb = require('crypto').createHash('sha256');
    await Promise.all([
      new Promise((r) => { a.on('data', (c) => ha.update(c)); a.on('end', r); }),
      new Promise((r) => { b.on('data', (c) => hb.update(c)); b.on('end', r); }),
    ]);
    assert.equal(ha.digest('hex'), hb.digest('hex'), 'the restored file must be byte-identical to the original');
    fs.rmSync(stash);
  });

  it('does not hang on a huge file that is corrupt in the middle', async () => {
    const f = path.join(dir, 'huge-corrupt.jsonl');
    fs.copyFileSync(big.path, f);
    // Corrupt a line deep inside the file without rewriting the whole thing.
    const fd = fs.openSync(f, 'r+');
    fs.writeSync(fd, Buffer.from('{"broken'), 0, 8, Math.floor(fs.statSync(f).size * 0.5));
    fs.closeSync(fd);

    const t0 = Date.now();
    const report = await readJsonl(f, () => {});
    const secs = (Date.now() - t0) / 1000;
    assert.equal(report.integrity, 'damaged');
    assert.greater(report.errorCount, 0);
    assert.atMost(secs, 120, `corrupt-file scan took ${secs.toFixed(1)}s`);
    fs.rmSync(f);
  });
});
