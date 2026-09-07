'use strict';
/**
 * Relinking index records that lost their transcript id.
 *
 * The risk here is not failing to repair -- it is repairing wrongly. A record
 * pointed at the wrong conversation looks fixed, so most of these tests are
 * about the cases where the code must refuse: two equally good candidates, a
 * transcript already claimed by another record, a near-miss that is merely the
 * closest thing available.
 */
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const ACCT = 'aaaaaaaa-1111-2222-3333-444444444444';
const ORG = 'cccccccc-1111-2222-3333-444444444444';
const CWD = 'F:\\demo\\project';
const T0 = Date.parse('2026-06-09T10:00:00Z');

function savedEnv() {
  return {
    home: process.env.AISM_HOME_OVERRIDE,
    data: process.env.AISM_DATA_OVERRIDE,
    appdata: process.env.APPDATA,
    localappdata: process.env.LOCALAPPDATA,
    roots: process.env.AISM_CLAUDE_DESKTOP_ROOTS,
  };
}
function restoreEnv(prev) {
  const set = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  set('AISM_HOME_OVERRIDE', prev.home);
  set('AISM_DATA_OVERRIDE', prev.data);
  set('APPDATA', prev.appdata);
  set('LOCALAPPDATA', prev.localappdata);
  set('AISM_CLAUDE_DESKTOP_ROOTS', prev.roots);
}
function isolate(base) {
  process.env.AISM_HOME_OVERRIDE = base;
  process.env.AISM_DATA_OVERRIDE = path.join(base, 'appdata');
  process.env.APPDATA = path.join(base, 'AppData', 'Roaming');
  process.env.LOCALAPPDATA = path.join(base, 'AppData', 'Local');
  delete process.env.AISM_CLAUDE_DESKTOP_ROOTS;
  fs.mkdirSync(process.env.APPDATA, { recursive: true });
  fs.mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
}

const enc = (p) => String(p).replace(/[^A-Za-z0-9]/g, '-');

/** Write an index record; omit cliSessionId to make it a broken one. */
function record(base, id, over = {}) {
  const dir = path.join(base, 'AppData', 'Roaming', 'Claude', 'claude-code-sessions', ACCT, ORG);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'local_' + id + '.json');
  const body = {
    sessionId: 'local_' + id,
    title: 'Guest signup feedback popup',
    cwd: CWD,
    originCwd: CWD,
    model: 'claude-opus-5',
    createdAt: T0,
    lastActivityAt: T0 + 30 * 60 * 1000,
    isArchived: false,
    ...over,
  };
  if (!over.keepCli) delete body.cliSessionId;
  if (over.cliSessionId) body.cliSessionId = over.cliSessionId;
  delete body.keepCli;
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

/** Write a transcript under the project folder for CWD. */
function transcript(base, sessionId, opts = {}) {
  const {
    title = 'Guest signup feedback popup', start = T0, exchanges = 4, cwd = CWD,
    kind = 'custom',   // which title row to write: the typed one or the generated one
    aiTitle = null,
  } = opts;
  const dir = path.join(base, '.claude', 'projects', enc(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const rows = H.claudeTranscript({ sessionId, cwd, exchanges, startTime: start });
  if (title && kind === 'custom') rows.push({ type: 'custom-title', customTitle: title, sessionId });
  if (title && kind === 'ai') rows.push({ type: 'ai-title', aiTitle: title, sessionId });
  if (aiTitle) rows.push({ type: 'ai-title', aiTitle, sessionId });
  const file = path.join(dir, sessionId + '.jsonl');
  H.writeJsonl(file, rows);
  return file;
}

function mods() { return require('../src/core/repair'); }
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

describe('repair: relinking a record to its transcript', () => {
  const dirs = [];
  afterAll(() => { for (const d of dirs) H.rmrf(d); });

  /* ------------------------------- a transcript with no record at all */

  it('finds a transcript no account lists', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('orphan-find'); dirs.push(base); isolate(base);
    record(base, 'r1', { cliSessionId: 'aaaa1111-1111-1111-1111-111111111111' });
    transcript(base, 'aaaa1111-1111-1111-1111-111111111111', { title: 'Listed' });
    transcript(base, 'bbbb2222-2222-2222-2222-222222222222', { title: 'Nobody lists me' });
    const repair = mods();

    const found = await repair.scanOrphans();
    assert.equal(found.orphans.length, 1);
    assert.equal(found.orphans[0].sessionId, 'bbbb2222-2222-2222-2222-222222222222');
    assert.equal(found.orphans[0].title, 'Nobody lists me');
    restoreEnv(prev);
  });

  it('counts a session another account lists as missing from THIS one', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('orphan-elsewhere'); dirs.push(base); isolate(base);
    const cli = 'cccc3333-3333-3333-3333-333333333333';
    const otherDir = path.join(base, 'AppData', 'Roaming', 'Claude', 'claude-code-sessions',
      'bbbbbbbb-1111-2222-3333-444444444444', ORG);
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, 'local_x.json'), JSON.stringify({
      sessionId: 'local_x', cliSessionId: cli, title: 'Only in the other account',
      cwd: CWD, originCwd: CWD, createdAt: T0, lastActivityAt: T0 + 1000,
    }));
    transcript(base, cli, { title: 'Only in the other account' });
    const repair = mods();

    const mine = await repair.scanOrphans({ accountUuid: ACCT });
    assert.equal(mine.orphans.length, 1, 'this account does not list it');
    assert.ok(mine.orphans[0].elsewhere, 'and it says another account does');
    const anywhere = await repair.scanOrphans();
    assert.equal(anywhere.orphans.length, 0, 'but it is not orphaned overall');
    restoreEnv(prev);
  });

  it('builds a record from what the transcript records', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('orphan-build'); dirs.push(base); isolate(base);
    record(base, 'anchor', { cliSessionId: 'dddd0000-0000-0000-0000-000000000000' });
    transcript(base, 'dddd4444-4444-4444-4444-444444444444', { title: 'Recovered session' });
    const repair = mods();

    const plan = await repair.planCreateRecords({ accountUuid: ACCT });
    const a = plan.actions.find((x) => x.kind === 'create');
    assert.ok(a, 'the orphan is offered');
    assert.equal(a.record.cliSessionId, 'dddd4444-4444-4444-4444-444444444444');
    assert.equal(a.record.title, 'Recovered session');
    assert.equal(a.record.cwd, CWD);
    assert.equal(a.record.originCwd, CWD);
    assert.ok(/^local_/.test(a.record.sessionId), a.record.sessionId);
    assert.equal(a.record.model, 'claude-opus-5', 'taken from the transcript');
    assert.ok(a.record.createdAt > 0 && a.record.lastActivityAt >= a.record.createdAt);
    restoreEnv(prev);
  });

  it('never invents a permissive permission mode', async () => {
    // 249 of 265 real records say bypassPermissions. That is the setting that
    // stops Claude Code asking before it acts, and writing it into a record
    // nobody asked for is not this app to decide.
    const prev = savedEnv();
    const base = H.tmpDir('orphan-perm'); dirs.push(base); isolate(base);
    record(base, 'anchor', { cliSessionId: 'eeee0000-0000-0000-0000-000000000000' });
    transcript(base, 'eeee5555-5555-5555-5555-555555555555', { title: 'Recovered' });
    const repair = mods();

    const plan = await repair.planCreateRecords({ accountUuid: ACCT });
    const a = plan.actions.find((x) => x.kind === 'create');
    assert.equal(a.record.permissionMode, 'auto');
    assert.notEqual(a.record.permissionMode, 'bypassPermissions');
    restoreEnv(prev);
  });

  it('writes nothing during the create dry run, then creates on execute', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('orphan-write'); dirs.push(base); isolate(base);
    record(base, 'anchor', { cliSessionId: 'ffff0000-0000-0000-0000-000000000000' });
    const id = 'ffff6666-6666-6666-6666-666666666666';
    transcript(base, id, { title: 'Recovered' });
    const dir = path.join(base, 'AppData', 'Roaming', 'Claude', 'claude-code-sessions', ACCT, ORG);
    const before = fs.readdirSync(dir).length;
    const repair = mods();

    const plan = await repair.planCreateRecords({ accountUuid: ACCT });
    assert.equal(fs.readdirSync(dir).length, before, 'the preview writes nothing');

    const res = await repair.executeCreateRecords(plan.token);
    assert.equal(res.summary.created, 1);
    const written = fs.readdirSync(dir)
      .filter((f) => f.startsWith('local_') && !f.includes('anchor'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
      .find((j) => j.cliSessionId === id);
    assert.ok(written, 'the new record points at the transcript');
    restoreEnv(prev);
  });

  it('refuses a transcript with no title, which would be a blank row', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('orphan-thin'); dirs.push(base); isolate(base);
    record(base, 'anchor', { cliSessionId: '11110000-0000-0000-0000-000000000000' });
    transcript(base, '11117777-7777-7777-7777-777777777777', { title: null });
    const repair = mods();

    const plan = await repair.planCreateRecords({ accountUuid: ACCT });
    assert.equal(plan.summary.create, 0);
    assert.equal(plan.summary.blocked, 1);
    assert.ok(/blank|title/i.test(plan.actions[0].reason), plan.actions[0].reason);
    restoreEnv(prev);
  });

  it('records every creation in the audit log', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('orphan-audit'); dirs.push(base); isolate(base);
    record(base, 'anchor', { cliSessionId: '22220000-0000-0000-0000-000000000000' });
    const id = '22228888-8888-8888-8888-888888888888';
    transcript(base, id, { title: 'Recovered' });
    const repair = mods();
    const audit = require('../src/core/audit');

    await repair.executeCreateRecords((await repair.planCreateRecords({ accountUuid: ACCT })).token);
    const e = audit.read(50).find((x) => x.action === 'history-record-create' && x.sessionId === id);
    assert.ok(e, 'inventing a record in another application store must be auditable');
    assert.equal(e.outcome, 'created');
    restoreEnv(prev);
  });

  it('refuses a replayed create token', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('orphan-token'); dirs.push(base); isolate(base);
    record(base, 'anchor', { cliSessionId: '33330000-0000-0000-0000-000000000000' });
    transcript(base, '33339999-9999-9999-9999-999999999999', { title: 'Recovered' });
    const repair = mods();

    await assert.throws(() => repair.executeCreateRecords('made-up'), 'PLAN_REQUIRED');
    const plan = await repair.planCreateRecords({ accountUuid: ACCT });
    await repair.executeCreateRecords(plan.token);
    await assert.throws(() => repair.executeCreateRecords(plan.token), 'PLAN_REQUIRED');
    restoreEnv(prev);
  });

  it('encodes a project path the way Claude Code does', () => {
    const repair = mods();
    // Every non-alphanumeric character becomes a dash and runs are NOT
    // collapsed; the exporter's version collapsed them and matched nothing.
    assert.equal(repair.encodeProjectDir('F:\\0. Mobile apps'), 'F--0--Mobile-apps');
    assert.equal(repair.encodeProjectDir('F:\\1. Rimon Labs\\2. vidvers'), 'F--1--Rimon-Labs-2--vidvers');
  });

  it('finds the transcript when the title and the timestamps agree', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('repair-strong'); dirs.push(base); isolate(base);
    record(base, 'r1');
    transcript(base, '11111111-1111-1111-1111-111111111111');
    const repair = mods();

    const scan = await repair.scanBroken();
    assert.equal(scan.broken.length, 1);
    const b = scan.broken[0];
    assert.equal(b.confidence, repair.CONFIDENCE.STRONG, b.reason);
    assert.equal(b.best.sessionId, '11111111-1111-1111-1111-111111111111');
    assert.deepEqual(b.missing, ['cliSessionId']);
    restoreEnv(prev);
  });

  it('cannot find a session renamed after the index cached its title', async () => {
    // The known limit of searching by title: the record keeps the pre-rename
    // title, the transcript carries the new one. Measured on a real
    // installation, 4 of 40 good pairs. The folder cannot stand in -- a folder
    // holds many transcripts and identifies none of them.
    const prev = savedEnv();
    const base = H.tmpDir('repair-renamed'); dirs.push(base); isolate(base);
    record(base, 'r1');
    transcript(base, '22222222-2222-2222-2222-222222222222', { title: 'Something else entirely' });
    const repair = mods();

    const b = (await repair.scanBroken()).broken[0];
    assert.equal(b.confidence, repair.CONFIDENCE.NONE);
    assert.equal(b.best, null);
    assert.ok(/carries this title/i.test(b.reason), b.reason);
    restoreEnv(prev);
  });

  it('gives up on a renamed session however many transcripts the folder holds', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('repair-renamed2'); dirs.push(base); isolate(base);
    record(base, 'r1');
    transcript(base, '2c2c2c2c-2222-2222-2222-222222222222', { title: 'Something else entirely' });
    transcript(base, '2d2d2d2d-2222-2222-2222-222222222222', { title: 'A third thing' });
    const repair = mods();

    const b = (await repair.scanBroken()).broken[0];
    assert.equal(b.confidence, repair.CONFIDENCE.NONE);
    assert.equal(b.best, null, 'the path no longer identifies it and no title matches');
    restoreEnv(prev);
  });

  it('matches a title that differs only in punctuation', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('repair-punct'); dirs.push(base); isolate(base);
    record(base, 'r1', { title: 'Guest/signup feedback popup' });
    transcript(base, '2b2b2b2b-2222-2222-2222-222222222222', { title: 'Guest signup feedback popup' });
    // A second transcript, so the folder alone cannot answer it and the title
    // rung is the one under test.
    transcript(base, '2e2e2e2e-2222-2222-2222-222222222222', { title: 'Unrelated' });
    const repair = mods();

    const b = (await repair.scanBroken()).broken[0];
    assert.equal(b.best.sessionId, '2b2b2b2b-2222-2222-2222-222222222222');
    assert.equal(b.best.match, 'custom~', 'a custom title, matched after normalising');
    restoreEnv(prev);
  });

  it('prefers a typed title over a generated one', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('repair-titlekind'); dirs.push(base); isolate(base);
    record(base, 'r1');
    const generated = transcript(base, 'a1a1a1a1-1111-1111-1111-111111111111', { kind: 'ai' });
    const typed = transcript(base, 'b1b1b1b1-1111-1111-1111-111111111111', { kind: 'custom' });
    // Make the generated one newer, so only the title rule can decide it.
    const t = Date.now() / 1000;
    fs.utimesSync(typed, t - 7200, t - 7200);
    fs.utimesSync(generated, t, t);
    const repair = mods();

    const b = (await repair.scanBroken()).broken[0];
    assert.equal(b.best.sessionId, 'b1b1b1b1-1111-1111-1111-111111111111',
      'the title a person set outranks the generated one, even though it is older');
    assert.equal(b.best.match, 'custom');
    restoreEnv(prev);
  });

  it('falls back to a generated title when there is no typed one', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('repair-aionly'); dirs.push(base); isolate(base);
    record(base, 'r1');
    transcript(base, 'c1c1c1c1-1111-1111-1111-111111111111', { kind: 'ai' });
    transcript(base, 'c2c2c2c2-1111-1111-1111-111111111111', { title: 'Unrelated', kind: 'ai' });
    const repair = mods();

    const b = (await repair.scanBroken()).broken[0];
    assert.equal(b.best.sessionId, 'c1c1c1c1-1111-1111-1111-111111111111');
    assert.equal(b.best.match, 'ai');
    restoreEnv(prev);
  });

  it('prefers the recorded project folder when titles are equal', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('repair-folder'); dirs.push(base); isolate(base);
    record(base, 'r1');
    const elsewhere = transcript(base, 'd1d1d1d1-1111-1111-1111-111111111111', { cwd: 'F:\\other\\place' });
    const here = transcript(base, 'e1e1e1e1-1111-1111-1111-111111111111');
    // The wrong folder is newer, so only the folder rule can decide it.
    const t = Date.now() / 1000;
    fs.utimesSync(here, t - 7200, t - 7200);
    fs.utimesSync(elsewhere, t, t);
    const repair = mods();

    const b = (await repair.scanBroken()).broken[0];
    assert.equal(b.best.sessionId, 'e1e1e1e1-1111-1111-1111-111111111111',
      'the recorded folder wins over a newer file somewhere else');
    assert.equal(b.best.folderRank, 0);
    restoreEnv(prev);
  });

  it('still finds a worktree session, whose folder is not its originCwd', async () => {
    // 24 of 195 linked records on a real installation are worktree sessions:
    // originCwd names the project root while the transcript lives under
    // .claude/worktrees/... Filtering by the folder would lose them.
    const prev = savedEnv();
    const base = H.tmpDir('repair-worktree'); dirs.push(base); isolate(base);
    const file = record(base, 'r1', { cwd: undefined, originCwd: CWD });
    // Blank the cwd so only originCwd is left, as on a broken record.
    const j = read(file); delete j.cwd; fs.writeFileSync(file, JSON.stringify(j));
    transcript(base, 'f1f1f1f1-1111-1111-1111-111111111111', {
      cwd: CWD + '\\.claude\\worktrees\\brave-hopper',
    });
    const repair = mods();

    const b = (await repair.scanBroken()).broken[0];
    assert.equal(b.best.sessionId, 'f1f1f1f1-1111-1111-1111-111111111111',
      'the folder ranks candidates, it must not exclude them');
    assert.equal(b.best.folderRank, 1, 'and it is honestly reported as a different folder');
    restoreEnv(prev);
  });

  /* --------------------------------------------------------- the refusals */

  it('takes the most recently edited when several share a title', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('repair-tie'); dirs.push(base); isolate(base);
    record(base, 'r1');
    const older = transcript(base, '33333333-3333-3333-3333-333333333333');
    const newer = transcript(base, '44444444-4444-4444-4444-444444444444');
    // Set the times explicitly; writing them back to back is not a difference
    // a filesystem is obliged to record.
    const t = Date.now() / 1000;
    fs.utimesSync(older, t - 7200, t - 7200);
    fs.utimesSync(newer, t, t);
    const repair = mods();

    const b = (await repair.scanBroken()).broken[0];
    assert.equal(b.confidence, repair.CONFIDENCE.LIKELY);
    assert.equal(b.best.sessionId, '44444444-4444-4444-4444-444444444444');
    assert.equal(b.candidates.length, 2, 'the other is still reported');
    assert.ok(/most recently edited/i.test(b.reason), b.reason);
    restoreEnv(prev);
  });

  it('falls back to the largest file when the edit times are identical', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('repair-size'); dirs.push(base); isolate(base);
    record(base, 'r1');
    const small = transcript(base, '3a3a3a3a-3333-3333-3333-333333333333', { exchanges: 2 });
    const big = transcript(base, '4a4a4a4a-4444-4444-4444-444444444444', { exchanges: 30 });
    const t = Date.now() / 1000;
    fs.utimesSync(small, t, t);
    fs.utimesSync(big, t, t);
    assert.greater(fs.statSync(big).size, fs.statSync(small).size, 'fixture must actually differ');
    const repair = mods();

    const b = (await repair.scanBroken()).broken[0];
    assert.equal(b.best.sessionId, '4a4a4a4a-4444-4444-4444-444444444444',
      'the fuller record of the same conversation');
    restoreEnv(prev);
  });

  it('finds it when the OTHER account still points at the same transcript', async () => {
    // Two accounts listing one session is the normal case -- 97 of 124 on a
    // real installation. Delete one account's cliSessionId and the transcript
    // must still be offered to it, even though the sibling record claims it.
    // Treating claims as global made this exact manual test fail.
    const prev = savedEnv();
    const base = H.tmpDir('repair-sibling'); dirs.push(base); isolate(base);
    const cli = '12345678-1111-2222-3333-444444444444';

    // Account A's record has lost its pointer; account B's still has it.
    record(base, 's1');
    const otherDir = path.join(base, 'AppData', 'Roaming', 'Claude', 'claude-code-sessions',
      'bbbbbbbb-1111-2222-3333-444444444444', ORG);
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, 'local_s1.json'), JSON.stringify({
      sessionId: 'local_s1', cliSessionId: cli, title: 'Guest signup feedback popup',
      cwd: CWD, originCwd: CWD, createdAt: T0, lastActivityAt: T0 + 1800000,
    }));
    transcript(base, cli);
    const repair = mods();

    const scan = await repair.scanBroken();
    assert.equal(scan.broken.length, 1, 'only the account that lost it is broken');
    assert.equal(scan.broken[0].best && scan.broken[0].best.sessionId, cli,
      'the sibling account holding it must not hide it');
    restoreEnv(prev);
  });

  it('finds a session by a name it used to have', async () => {
    // Title rows repeat through a transcript, so a rename leaves the old name
    // in the earlier rows -- and the index may still be holding exactly that.
    // Worth 2 more recoveries out of 191 on a real installation.
    const prev = savedEnv();
    const base = H.tmpDir('repair-former'); dirs.push(base); isolate(base);
    record(base, 'r1', { title: 'The old name' });

    const dir = path.join(base, '.claude', 'projects', enc(CWD));
    fs.mkdirSync(dir, { recursive: true });
    const id = '7f7f7f7f-7777-7777-7777-777777777777';
    const rows = H.claudeTranscript({ sessionId: id, cwd: CWD, exchanges: 4, startTime: T0 });
    rows.push({ type: 'custom-title', customTitle: 'The old name', sessionId: id });
    rows.push({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'more' }] },
      timestamp: new Date(T0 + 60000).toISOString(), sessionId: id });
    rows.push({ type: 'custom-title', customTitle: 'The new name', sessionId: id });
    H.writeJsonl(path.join(dir, id + '.jsonl'), rows);
    // Something else must exist, or the search would have nothing to weigh it against.
    transcript(base, '7e7e7e7e-7777-7777-7777-777777777777', { title: 'Unrelated' });
    const repair = mods();

    const b = (await repair.scanBroken()).broken[0];
    assert.equal(b.best && b.best.sessionId, id, 'the earlier name still identifies it');
    assert.equal(b.best.match, 'former');
    assert.ok(/used to have/i.test(b.reason), b.reason);
    restoreEnv(prev);
  });

  it('prefers the current title over a former one', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('repair-formerorder'); dirs.push(base); isolate(base);
    record(base, 'r1', { title: 'Shared name' });

    // One transcript currently called it; another merely used to be.
    transcript(base, '8a8a8a8a-8888-8888-8888-888888888888', { title: 'Shared name' });
    const dir = path.join(base, '.claude', 'projects', enc(CWD));
    const id2 = '8b8b8b8b-8888-8888-8888-888888888888';
    const rows = H.claudeTranscript({ sessionId: id2, cwd: CWD, exchanges: 4, startTime: T0 });
    rows.push({ type: 'custom-title', customTitle: 'Shared name', sessionId: id2 });
    rows.push({ type: 'custom-title', customTitle: 'Renamed since', sessionId: id2 });
    H.writeJsonl(path.join(dir, id2 + '.jsonl'), rows);
    const repair = mods();

    const b = (await repair.scanBroken()).broken[0];
    assert.equal(b.best.sessionId, '8a8a8a8a-8888-8888-8888-888888888888',
      'the one that still carries the name wins');
    assert.equal(b.best.match, 'custom');
    restoreEnv(prev);
  });

  it('still refuses a transcript another record in the SAME account holds', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('repair-sameacct'); dirs.push(base); isolate(base);
    const taken = '87654321-1111-2222-3333-444444444444';
    record(base, 'r1');
    record(base, 'r2', { cliSessionId: taken, title: 'Another session' });
    transcript(base, taken);
    const repair = mods();

    const b = (await repair.scanBroken()).broken.find((x) => x.title === 'Guest signup feedback popup');
    assert.equal(b.best, null, 'one account may not point two records at one transcript');
    restoreEnv(prev);
  });

  it('never offers a transcript another record already points at', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('repair-claimed'); dirs.push(base); isolate(base);
    const taken = '55555555-5555-5555-5555-555555555555';
    record(base, 'r1');
    record(base, 'r2', { cliSessionId: taken, title: 'Another session' });
    transcript(base, taken);
    const repair = mods();

    const scan = await repair.scanBroken();
    const b = scan.broken.find((x) => x.title === 'Guest signup feedback popup');
    assert.equal(b.best, null, 'two records must not claim one transcript');
    assert.equal(b.candidates.length, 0);
    restoreEnv(prev);
  });

  it('says plainly when nothing on disk carries the title', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('repair-empty'); dirs.push(base); isolate(base);
    record(base, 'r1');
    fs.mkdirSync(path.join(base, '.claude', 'projects', enc(CWD)), { recursive: true });
    const repair = mods();

    const b = (await repair.scanBroken()).broken[0];
    assert.equal(b.confidence, repair.CONFIDENCE.NONE);
    assert.ok(/carries this title/i.test(b.reason), b.reason);
    restoreEnv(prev);
  });

  it('searches every project folder, not just the recorded one', async () => {
    // A record can have lost its cwd too, so the title has to be looked for
    // across the whole transcript directory.
    const prev = savedEnv();
    const base = H.tmpDir('repair-elsewhere'); dirs.push(base); isolate(base);
    record(base, 'r1');
    transcript(base, '5e5e5e5e-5555-5555-5555-555555555555', { cwd: 'F:\\somewhere\\else' });
    const repair = mods();

    const b = (await repair.scanBroken()).broken[0];
    assert.equal(b.best.sessionId, '5e5e5e5e-5555-5555-5555-555555555555');
    restoreEnv(prev);
  });

  it('shows only the account it was asked about', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('repair-scope'); dirs.push(base); isolate(base);
    record(base, 'r1');
    // A second account with its own broken record.
    const other = path.join(base, 'AppData', 'Roaming', 'Claude', 'claude-code-sessions',
      'bbbbbbbb-1111-2222-3333-444444444444', ORG);
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'local_x1.json'),
      JSON.stringify({ sessionId: 'local_x1', title: 'Other account session', cwd: CWD, createdAt: T0 }));
    const repair = mods();

    const all = await repair.scanBroken();
    assert.equal(all.broken.length, 2, 'both are broken');
    const mine = await repair.scanBroken({ accountUuid: ACCT });
    assert.equal(mine.broken.length, 1);
    assert.equal(mine.broken[0].accountUuid, ACCT);
    restoreEnv(prev);
  });

  it('refuses when neither the folder nor any title can single one out', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('repair-far'); dirs.push(base); isolate(base);
    record(base, 'r1');
    // Several in the folder, none carrying the title: no rung answers.
    transcript(base, '66666666-6666-6666-6666-666666666666', { title: 'Unrelated work' });
    transcript(base, '67676767-6666-6666-6666-666666666666', { title: 'Other work' });
    const repair = mods();

    const b = (await repair.scanBroken()).broken[0];
    assert.equal(b.confidence, repair.CONFIDENCE.NONE);
    assert.equal(b.best, null);
    restoreEnv(prev);
  });

  it('never offers one transcript to two broken records', async () => {
    // Two records in the same folder with one transcript between them: the
    // folder rung would hand it to both, and both would be written to point at
    // the same conversation.
    const prev = savedEnv();
    const base = H.tmpDir('repair-double'); dirs.push(base); isolate(base);
    // Both records carry the same title, and one transcript carries it too.
    record(base, 'r1', { title: 'Shared name' });
    record(base, 'r2', { title: 'Shared name' });
    transcript(base, '6a6a6a6a-6666-6666-6666-666666666666', { title: 'Shared name' });
    const repair = mods();

    const scan = await repair.scanBroken();
    const proposed = scan.broken.filter((b) => b.best).map((b) => b.best.sessionId);
    assert.equal(proposed.length, 1, 'only one record may claim it');
    assert.equal(new Set(proposed).size, proposed.length);
    restoreEnv(prev);
  });

  it('leaves records that are not broken alone', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('repair-healthy'); dirs.push(base); isolate(base);
    record(base, 'r1', { cliSessionId: '77777777-7777-7777-7777-777777777777' });
    transcript(base, '77777777-7777-7777-7777-777777777777');
    const repair = mods();

    const scan = await repair.scanBroken();
    assert.equal(scan.broken.length, 0);
    assert.equal(scan.recordsTotal, 1);
    restoreEnv(prev);
  });

  /* ----------------------------------------------------------- the write */

  it('writes nothing during the dry run', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('repair-dry'); dirs.push(base); isolate(base);
    const file = record(base, 'r1');
    transcript(base, '88888888-8888-8888-8888-888888888888');
    const before = fs.readFileSync(file);
    const repair = mods();

    const plan = await repair.planRepair();
    assert.equal(plan.summary.repair, 1);
    assert.ok(before.equals(fs.readFileSync(file)), 'the preview must not touch the record');
    restoreEnv(prev);
  });

  it('adds only the missing field and keeps everything else', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('repair-write'); dirs.push(base); isolate(base);
    const file = record(base, 'r1', { model: 'claude-fable-5-1', isArchived: true });
    const id = '99999999-9999-9999-9999-999999999999';
    transcript(base, id);
    const before = read(file);
    const repair = mods();

    const res = await repair.executeRepair((await repair.planRepair()).token);
    assert.equal(res.summary.repaired, 1);

    const after = read(file);
    assert.equal(after.cliSessionId, id, 'the pointer is restored');
    for (const k of Object.keys(before)) {
      assert.deepEqual(after[k], before[k], k + ' must be untouched');
    }
    restoreEnv(prev);
  });

  it('backs the record up before changing it', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('repair-backup'); dirs.push(base); isolate(base);
    const file = record(base, 'r1');
    transcript(base, 'aaaaaaa1-1111-1111-1111-111111111111');
    const original = fs.readFileSync(file);
    const repair = mods();

    const res = await repair.executeRepair((await repair.planRepair()).token);
    const backup = res.results[0].backupPath;
    assert.ok(backup, 'a change to another app\'s file must be recoverable');
    assert.ok(original.equals(fs.readFileSync(backup)));
    restoreEnv(prev);
  });

  it('does not write when no transcript carries the title', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('repair-noop'); dirs.push(base); isolate(base);
    const file = record(base, 'r1');
    transcript(base, 'bbbbbbb1-1111-1111-1111-111111111111', { title: 'A different session' });
    transcript(base, 'bbbbbbb2-2222-2222-2222-222222222222', { title: 'Another one' });
    const before = fs.readFileSync(file);
    const repair = mods();

    const plan = await repair.planRepair();
    assert.equal(plan.summary.repair, 0);
    assert.equal(plan.summary.blocked, 1);
    const res = await repair.executeRepair(plan.token);
    assert.equal(res.summary.repaired, 0);
    assert.ok(before.equals(fs.readFileSync(file)));
    restoreEnv(prev);
  });

  it('repairs only the records asked for', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('repair-subset'); dirs.push(base); isolate(base);
    const a = record(base, 'r1', { title: 'First session', createdAt: T0 });
    const b = record(base, 'r2', { title: 'Second session', createdAt: T0 + 5 * 3600 * 1000,
      lastActivityAt: T0 + 5.5 * 3600 * 1000 });
    transcript(base, 'ccccccc1-1111-1111-1111-111111111111', { title: 'First session' });
    transcript(base, 'ccccccc2-2222-2222-2222-222222222222', {
      title: 'Second session', start: T0 + 5 * 3600 * 1000,
    });
    const repair = mods();

    const plan = await repair.planRepair({ indexPaths: [a] });
    assert.equal(plan.actions.length, 1, 'only the chosen record is planned');
    await repair.executeRepair(plan.token);
    assert.ok(read(a).cliSessionId, 'the chosen one is repaired');
    assert.notOk(read(b).cliSessionId, 'the other is untouched');
    restoreEnv(prev);
  });

  it('refuses a replayed or foreign plan token', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('repair-token'); dirs.push(base); isolate(base);
    record(base, 'r1');
    transcript(base, 'ddddddd1-1111-1111-1111-111111111111');
    const repair = mods();
    const safety = require('../src/core/safety');

    await assert.throws(() => repair.executeRepair('made-up'), 'PLAN_REQUIRED');
    await assert.throws(() => repair.executeRepair(safety.registerPlan({ kind: 'import' })), 'PLAN_MISMATCH');

    const plan = await repair.planRepair();
    await repair.executeRepair(plan.token);
    await assert.throws(() => repair.executeRepair(plan.token), 'PLAN_REQUIRED');
    restoreEnv(prev);
  });

  it('records the repair in the audit log', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('repair-audit'); dirs.push(base); isolate(base);
    record(base, 'r1');
    const id = 'eeeeeee1-1111-1111-1111-111111111111';
    transcript(base, id);
    const repair = mods();
    const audit = require('../src/core/audit');

    await repair.executeRepair((await repair.planRepair()).token);
    const entry = audit.read(50).find((e) => e.action === 'index-record-repair');
    assert.ok(entry, 'writing into another app\'s data must be auditable');
    assert.equal(entry.outcome, 'repaired');
    assert.equal(entry.sessionId, id);
    assert.ok(entry.backupPath);
    restoreEnv(prev);
  });
});
