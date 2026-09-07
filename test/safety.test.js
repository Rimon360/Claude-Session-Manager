'use strict';
/**
 * Write guardrails: no blind overwrites, atomic writes, backups, and the
 * plan-token gate that makes the dry run impossible to skip.
 */
const fs = require('fs');
const path = require('path');
const H = require('./helpers');
const safety = require('../src/core/safety');

describe('safety: write guardrails', () => {
  let dir;
  beforeAll(() => {
    dir = H.tmpDir('safety');
    process.env.AISM_DATA_OVERRIDE = path.join(dir, 'appdata');
    return { dir };
  });
  afterAll(() => { delete process.env.AISM_DATA_OVERRIDE; H.rmrf(dir); });

  it('writes a new file atomically and leaves no temp files behind', async () => {
    const f = path.join(dir, 'new.jsonl');
    await safety.writeFileAtomic(f, 'hello\n');
    assert.equal(fs.readFileSync(f, 'utf8'), 'hello\n');
    const leftovers = fs.readdirSync(dir).filter((n) => n.includes('aism-tmp'));
    assert.equal(leftovers.length, 0);
  });

  it('REFUSES to overwrite an existing file by default', async () => {
    const f = path.join(dir, 'guard.jsonl');
    fs.writeFileSync(f, 'original\n');
    const err = await assert.throws(() => safety.writeFileAtomic(f, 'replacement\n'), 'OVERWRITE_REFUSED');
    assert.includes(err.message, 'refusing to overwrite');
    assert.equal(fs.readFileSync(f, 'utf8'), 'original\n', 'the original bytes must be untouched');
  });

  it('backs up the previous bytes before an approved overwrite', async () => {
    const f = path.join(dir, 'backed.jsonl');
    fs.writeFileSync(f, 'version-one\n');
    const res = await safety.writeFileAtomic(f, 'version-two\n', { allowOverwrite: true, reason: 'test' });
    assert.equal(fs.readFileSync(f, 'utf8'), 'version-two\n');
    assert.ok(res.backupPath, 'an overwrite must produce a backup path');
    assert.equal(fs.readFileSync(res.backupPath, 'utf8'), 'version-one\n',
      'the previous version must be recoverable byte for byte');
    const meta = JSON.parse(fs.readFileSync(res.backupPath + '.backup-meta.json', 'utf8'));
    assert.equal(meta.originalPath, f);
    assert.equal(meta.reason, 'test');
  });

  it('refuses to copy over an existing file by default', async () => {
    const src = path.join(dir, 'src.jsonl');
    const dst = path.join(dir, 'dst.jsonl');
    fs.writeFileSync(src, 'source\n');
    fs.writeFileSync(dst, 'destination\n');
    await assert.throws(() => safety.copyFileAtomic(src, dst), 'OVERWRITE_REFUSED');
    assert.equal(fs.readFileSync(dst, 'utf8'), 'destination\n');
  });

  it('copies large files by streaming rather than buffering', async () => {
    const src = path.join(dir, 'big.bin');
    const chunk = Buffer.alloc(1024 * 1024, 7);
    const ws = fs.createWriteStream(src);
    for (let i = 0; i < 40; i++) ws.write(chunk);
    await new Promise((r) => ws.end(r));

    const before = process.memoryUsage().heapUsed;
    const dst = path.join(dir, 'big-copy.bin');
    await safety.copyFileAtomic(src, dst);
    const growth = process.memoryUsage().heapUsed - before;

    assert.equal(fs.statSync(dst).size, fs.statSync(src).size);
    assert.atMost(growth, 24 * 1024 * 1024, 'a 40MB copy must not grow the heap by anything near 40MB');
  });

  it('refuses to use a damaged file as a copy source', () => {
    assert.ok(safety.assertUsableSource('ok', 'x') === undefined);
    assert.ok(safety.assertUsableSource('truncated', 'x') === undefined);
    let threw = false;
    try { safety.assertUsableSource('damaged', 'session.jsonl'); } catch (e) { threw = true; assert.equal(e.code, 'SOURCE_DAMAGED'); }
    assert.ok(threw, 'a damaged source must be rejected');
  });
});

describe('safety: the dry run cannot be skipped', () => {
  it('rejects execution without a plan token', () => {
    let threw = false;
    try { safety.consumePlan(undefined); } catch (e) { threw = true; assert.equal(e.code, 'PLAN_REQUIRED'); }
    assert.ok(threw);
  });

  it('rejects a made-up plan token', () => {
    let threw = false;
    try { safety.consumePlan('00000000-0000-0000-0000-000000000000'); } catch (e) { threw = true; assert.equal(e.code, 'PLAN_REQUIRED'); }
    assert.ok(threw, 'a token that never came from a dry run must not authorize a write');
  });

  it('accepts a real token exactly once, so a plan cannot be replayed', () => {
    const token = safety.registerPlan({ kind: 'import', actions: [] });
    const plan = safety.consumePlan(token);
    assert.equal(plan.kind, 'import');
    let threw = false;
    try { safety.consumePlan(token); } catch (e) { threw = true; assert.equal(e.code, 'PLAN_REQUIRED'); }
    assert.ok(threw, 'replaying a consumed plan must fail — state on disk may have changed since the preview');
  });

  it('lets a plan be inspected without consuming it', () => {
    const token = safety.registerPlan({ kind: 'sync', actions: [1, 2] });
    assert.equal(safety.peekPlan(token).actions.length, 2);
    assert.equal(safety.peekPlan(token).actions.length, 2, 'peeking must not consume');
    safety.consumePlan(token);
    assert.equal(safety.peekPlan(token), null);
  });
});
