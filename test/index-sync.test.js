'use strict';
/**
 * Copying history records between Claude Desktop accounts.
 *
 * This is the one place the app writes into another application's data, so the
 * promises worth pinning down are the negative ones: it never deletes, never
 * overwrites, never resurrects something the target deleted, and never invents
 * a record for a session no account has one for. Every test here checks what
 * did NOT happen as much as what did.
 */
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const A = 'aaaaaaaa-1111-2222-3333-444444444444';
const B = 'bbbbbbbb-1111-2222-3333-444444444444';
const ORG_A = 'cccccccc-1111-2222-3333-444444444444';
const ORG_B = 'dddddddd-1111-2222-3333-444444444444';

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
  // An override left set by the developer's shell would point the whole suite
  // at the real installation.
  delete process.env.AISM_CLAUDE_DESKTOP_ROOTS;
  fs.mkdirSync(process.env.APPDATA, { recursive: true });
  // The fixture builds a Windows-shaped Desktop root. APPDATA alone only
  // reaches it on Windows, so the tests point the explicit override at it
  // too and then run identically on every platform.
  process.env.AISM_CLAUDE_DESKTOP_ROOTS = path.join(base, 'AppData', 'Roaming', 'Claude');
  fs.mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
}

function orgDir(base, account, org) {
  return path.join(base, 'AppData', 'Roaming', 'Claude', 'claude-code-sessions', account, org);
}

/** Write a local_<id>.json record, returning its path. */
function record(dir, id, over = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'local_' + id + '.json');
  fs.writeFileSync(file, JSON.stringify({
    sessionId: 'local_' + id,
    cliSessionId: 'cli-' + id,
    title: 'Session ' + id,
    originCwd: 'F:\\demo',
    model: 'claude-opus-5',
    createdAt: 1785307143603,
    lastActivityAt: 1785307720266,
    lastFocusedAt: 1786049596270,
    completedTurns: 2,
    isArchived: false,
    ...over,
  }, null, 0));
  return file;
}

function tombstone(dir, id) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'deleted_' + id), '1786454253433');
}

function listRecords(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.startsWith('local_')).sort(); } catch { return []; }
}

/** Two accounts, each with one organization folder. */
function twoAccounts(name, layout) {
  const base = H.tmpDir(name);
  isolate(base);
  const dirA = orgDir(base, A, ORG_A);
  const dirB = orgDir(base, B, ORG_B);
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  for (const id of layout.a || []) record(dirA, id);
  for (const id of layout.b || []) record(dirB, id);
  return { base, dirA, dirB };
}

// Required lazily so the environment is isolated before anything reads paths.
function mods() {
  return {
    indexSync: require('../src/core/index-sync'),
    safety: require('../src/core/safety'),
  };
}

describe('account history: copying records between accounts', () => {
  let dirs = [];
  afterAll(() => { for (const d of dirs) H.rmrf(d); });

  it('copies a record the target account does not have', async () => {
    const prev = savedEnv();
    const { base, dirA, dirB } = twoAccounts('idx-copy', { a: ['s1', 's2'], b: ['s1'] });
    dirs.push(base);
    const { indexSync } = mods();

    const plan = await indexSync.planMigrate({ cliSessionIds: ['cli-s2'], targetAccountUuid: B });
    assert.equal(plan.summary.copy, 1);
    assert.equal(listRecords(dirB).length, 1, 'the dry run must not write');

    await indexSync.execute(plan.token);
    assert.deepEqual(listRecords(dirB), ['local_s1.json', 'local_s2.json']);
    assert.deepEqual(listRecords(dirA), ['local_s1.json', 'local_s2.json'], 'the source is untouched');
    restoreEnv(prev);
  });

  it('never replaces a record the target already has', async () => {
    // The two accounts' copies differ in that account's own activity state.
    // Overwriting would silently throw the target's state away.
    const prev = savedEnv();
    const { base, dirA, dirB } = twoAccounts('idx-keep', {});
    dirs.push(base);
    record(dirA, 's1', { completedTurns: 99, lastFocusedAt: 2000000000000 });
    record(dirB, 's1', { completedTurns: 3, lastFocusedAt: 1000000000000 });
    const before = fs.readFileSync(path.join(dirB, 'local_s1.json'));
    const { indexSync } = mods();

    const plan = await indexSync.planMigrate({ cliSessionIds: ['cli-s1'], targetAccountUuid: B });
    assert.equal(plan.summary.copy, 0);
    assert.equal(plan.summary.alreadyPresent, 1);

    await indexSync.execute(plan.token);
    assert.ok(before.equals(fs.readFileSync(path.join(dirB, 'local_s1.json'))),
      "the target's own copy must be byte-for-byte unchanged");
    restoreEnv(prev);
  });

  it('never removes anything the target already had', async () => {
    const prev = savedEnv();
    const { base, dirB } = twoAccounts('idx-nodelete', { a: ['s1'], b: ['x1', 'x2', 'x3'] });
    dirs.push(base);
    const { indexSync } = mods();

    const plan = await indexSync.planMigrate({ cliSessionIds: ['cli-s1'], targetAccountUuid: B });
    await indexSync.execute(plan.token);

    const after = listRecords(dirB);
    for (const keep of ['local_x1.json', 'local_x2.json', 'local_x3.json']) {
      assert.ok(after.includes(keep), keep + ' must survive');
    }
    assert.equal(after.length, 4, 'exactly one record added, none removed');
    restoreEnv(prev);
  });

  it('refuses to resurrect a session the target deleted', async () => {
    const prev = savedEnv();
    const { base, dirB } = twoAccounts('idx-tombstone', { a: ['s1'], b: [] });
    dirs.push(base);
    tombstone(dirB, 's1');
    const { indexSync } = mods();

    const plan = await indexSync.planMigrate({ cliSessionIds: ['cli-s1'], targetAccountUuid: B });
    assert.equal(plan.summary.copy, 0);
    assert.equal(plan.summary.tombstoned, 1);
    assert.ok(/deleted/i.test(plan.actions[0].reason), plan.actions[0].reason);

    await indexSync.execute(plan.token);
    assert.equal(listRecords(dirB).length, 0, 'a deletion the user made must stand');
    restoreEnv(prev);
  });

  it('reports a session no account has a record for instead of inventing one', async () => {
    const prev = savedEnv();
    const { base, dirB } = twoAccounts('idx-norecord', { a: ['s1'], b: [] });
    dirs.push(base);
    const { indexSync } = mods();

    const plan = await indexSync.planMigrate({ cliSessionIds: ['cli-ghost'], targetAccountUuid: B });
    assert.equal(plan.summary.copy, 0);
    assert.equal(plan.summary.blocked, 1);
    assert.ok(/nothing to copy/i.test(plan.actions[0].reason), plan.actions[0].reason);

    await indexSync.execute(plan.token);
    assert.equal(listRecords(dirB).length, 0);
    restoreEnv(prev);
  });

  /* -------------------------------------------------------- the plan gate */

  it('writes nothing without a plan token from a dry run', async () => {
    const prev = savedEnv();
    const { base } = twoAccounts('idx-token', { a: ['s1'], b: [] });
    dirs.push(base);
    const { indexSync } = mods();
    await assert.throws(() => indexSync.execute('made-up-token'), 'PLAN_REQUIRED');
    restoreEnv(prev);
  });

  it('refuses to run the same plan twice', async () => {
    const prev = savedEnv();
    const { base, dirB } = twoAccounts('idx-replay', { a: ['s1'], b: [] });
    dirs.push(base);
    const { indexSync } = mods();

    const plan = await indexSync.planMigrate({ cliSessionIds: ['cli-s1'], targetAccountUuid: B });
    await indexSync.execute(plan.token);
    await assert.throws(() => indexSync.execute(plan.token), 'PLAN_REQUIRED');
    assert.equal(listRecords(dirB).length, 1, 'and the replay must not double-write');
    restoreEnv(prev);
  });

  it('rejects a token from a different kind of plan', async () => {
    const prev = savedEnv();
    const { base } = twoAccounts('idx-mismatch', { a: ['s1'], b: [] });
    dirs.push(base);
    const { indexSync, safety } = mods();
    const token = safety.registerPlan({ kind: 'import', actions: [] });
    await assert.throws(() => indexSync.execute(token), 'PLAN_MISMATCH');
    restoreEnv(prev);
  });

  it('refuses a target whose history folder cannot be identified', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('idx-ambiguous');
    dirs.push(base);
    isolate(base);
    // Two organization folders under B, both holding records: nothing says
    // which one Claude Desktop reads.
    record(orgDir(base, A, ORG_A), 's1');
    record(orgDir(base, B, ORG_A), 'x1');
    record(orgDir(base, B, ORG_B), 'y1');
    const { indexSync } = mods();

    await assert.throws(
      () => indexSync.planMigrate({ cliSessionIds: ['cli-s1'], targetAccountUuid: B }),
      'HISTORY_ORG_UNRESOLVED');
    assert.equal(listRecords(orgDir(base, B, ORG_A)).length, 1, 'and nothing is written anywhere');
    assert.equal(listRecords(orgDir(base, B, ORG_B)).length, 1);
    restoreEnv(prev);
  });

  /* ------------------------------------------------------------ sync all */

  it('gives every account the union, keeping what each already had', async () => {
    const prev = savedEnv();
    const { base, dirA, dirB } = twoAccounts('idx-union', {
      a: ['shared', 'onlyA1', 'onlyA2'],
      b: ['shared', 'onlyB1'],
    });
    dirs.push(base);
    const { indexSync } = mods();

    const plan = await indexSync.planSyncAll({});
    assert.equal(plan.summary.copy, 3, 'two into B, one into A');

    await indexSync.execute(plan.token);
    const want = ['local_onlyA1.json', 'local_onlyA2.json', 'local_onlyB1.json', 'local_shared.json'];
    assert.deepEqual(listRecords(dirA), want);
    assert.deepEqual(listRecords(dirB), want);
    restoreEnv(prev);
  });

  it('is a no-op when the accounts already match', async () => {
    const prev = savedEnv();
    const { base, dirA, dirB } = twoAccounts('idx-insync', { a: ['s1', 's2'], b: ['s1', 's2'] });
    dirs.push(base);
    const { indexSync } = mods();

    const plan = await indexSync.planSyncAll({});
    assert.equal(plan.summary.copy, 0);
    // Sessions are deduplicated across accounts first, so each of the two
    // sessions is checked once against the account that is not holding it.
    assert.equal(plan.summary.alreadyPresent, 2);

    const res = await indexSync.execute(plan.token);
    assert.equal(res.summary.written, 0);
    assert.deepEqual(listRecords(dirA), listRecords(dirB));
    restoreEnv(prev);
  });

  it('needs two identifiable accounts to have anything to combine', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('idx-single');
    dirs.push(base);
    isolate(base);
    record(orgDir(base, A, ORG_A), 's1');
    const { indexSync } = mods();

    const plan = await indexSync.planSyncAll({});
    assert.equal(plan.summary.copy, 0);
    assert.ok(/at least two/i.test(plan.note || ''), plan.note);
    restoreEnv(prev);
  });

  it('treats a session already present under another record id as present', async () => {
    const prev = savedEnv();
    const { base, dirA, dirB } = twoAccounts('idx-samecli', {});
    dirs.push(base);
    // Same conversation, different record id in each account.
    record(dirA, 'recA', { cliSessionId: 'cli-same' });
    record(dirB, 'recB', { cliSessionId: 'cli-same' });
    const { indexSync } = mods();

    const plan = await indexSync.planSyncAll({});
    assert.equal(plan.summary.copy, 0, 'matching on the transcript id, not the record id');

    await indexSync.execute(plan.token);
    assert.deepEqual(listRecords(dirA), ['local_recA.json'], 'no duplicate record added');
    assert.deepEqual(listRecords(dirB), ['local_recB.json']);
    restoreEnv(prev);
  });

  it('can sync a single session without touching the others', async () => {
    // What the Compare view's per-row button asks for: fix this one row.
    const prev = savedEnv();
    const { base, dirA, dirB } = twoAccounts('idx-scoped', { a: ['s1', 's2', 's3'], b: [] });
    dirs.push(base);
    const { indexSync } = mods();

    const plan = await indexSync.planSyncAll({ cliSessionIds: ['cli-s2'] });
    assert.equal(plan.summary.copy, 1, 'only the named session is planned');
    assert.deepEqual(plan.scopedTo, ['cli-s2']);

    await indexSync.execute(plan.token);
    assert.deepEqual(listRecords(dirB), ['local_s2.json'], 'and only that one is written');
    assert.deepEqual(listRecords(dirA), ['local_s1.json', 'local_s2.json', 'local_s3.json']);
    restoreEnv(prev);
  });

  it('scoping to a session every account already has plans nothing', async () => {
    const prev = savedEnv();
    const { base, dirB } = twoAccounts('idx-scoped-noop', { a: ['s1'], b: ['s1'] });
    dirs.push(base);
    const { indexSync } = mods();

    const plan = await indexSync.planSyncAll({ cliSessionIds: ['cli-s1'] });
    assert.equal(plan.summary.copy, 0);
    assert.equal(plan.summary.alreadyPresent, 1);
    assert.deepEqual(listRecords(dirB), ['local_s1.json']);
    restoreEnv(prev);
  });

  it('a scoped sync still refuses to resurrect a deleted session', async () => {
    const prev = savedEnv();
    const { base, dirB } = twoAccounts('idx-scoped-tomb', { a: ['s1'], b: [] });
    dirs.push(base);
    tombstone(dirB, 's1');
    const { indexSync } = mods();

    const plan = await indexSync.planSyncAll({ cliSessionIds: ['cli-s1'] });
    assert.equal(plan.summary.copy, 0);
    assert.equal(plan.summary.tombstoned, 1, 'narrowing the scope must not weaken the rules');

    await indexSync.execute(plan.token);
    assert.deepEqual(listRecords(dirB), []);
    restoreEnv(prev);
  });

  it('ignores a scope naming a session no account has', async () => {
    const prev = savedEnv();
    const { base, dirB } = twoAccounts('idx-scoped-ghost', { a: ['s1'], b: [] });
    dirs.push(base);
    const { indexSync } = mods();

    const plan = await indexSync.planSyncAll({ cliSessionIds: ['cli-nope'] });
    assert.equal(plan.summary.copy, 0);
    await indexSync.execute(plan.token);
    assert.deepEqual(listRecords(dirB), [], 'nothing invented, nothing written');
    restoreEnv(prev);
  });

  it('a pointed sync restores a session the target had deleted', async () => {
    // Sweeping every account must not undo a deletion, but asking for this one
    // session to go everywhere is an instruction about this one session.
    const prev = savedEnv();
    const { base, dirB } = twoAccounts('idx-force', { a: ['s1'], b: [] });
    dirs.push(base);
    tombstone(dirB, 's1');
    const { indexSync } = mods();

    const bulk = await indexSync.planSyncAll({});
    assert.equal(bulk.summary.copy, 0, 'the bulk sync still leaves it alone');
    assert.equal(bulk.summary.tombstoned, 1);

    const pointed = await indexSync.planSyncAll({ cliSessionIds: ['cli-s1'], allowTombstoned: true });
    assert.equal(pointed.summary.copy, 1);
    assert.equal(pointed.summary.tombstoned, 0);
    assert.ok(pointed.actions[0].wasTombstoned, 'and it is flagged, so the preview can say so');
    assert.deepEqual(listRecords(dirB), [], 'the dry run still writes nothing');

    await indexSync.execute(pointed.token);
    assert.deepEqual(listRecords(dirB), ['local_s1.json']);
    restoreEnv(prev);
  });

  it('clears the deletion marker when it restores, so it does not come back', async () => {
    const prev = savedEnv();
    const { base, dirB } = twoAccounts('idx-force-marker', { a: ['s1'], b: [] });
    dirs.push(base);
    tombstone(dirB, 's1');
    const { indexSync } = mods();

    const res = await indexSync.execute(
      (await indexSync.planSyncAll({ cliSessionIds: ['cli-s1'], allowTombstoned: true })).token);
    assert.ok(res.results[0].clearedTombstone, 'the marker must be cleared');
    assert.notOk(fs.existsSync(path.join(dirB, 'deleted_s1')), 'and gone from disk');
    assert.ok(res.results[0].backupPath, 'with the marker backed up first');

    // A later bulk sync must now see an ordinary, present record.
    const after = await indexSync.planSyncAll({});
    assert.equal(after.summary.tombstoned, 0);
    assert.equal(after.summary.copy, 0);
    assert.equal(after.summary.alreadyPresent, 1);
    restoreEnv(prev);
  });

  it('does not resurrect anything when the flag is not asked for', async () => {
    const prev = savedEnv();
    const { base, dirB } = twoAccounts('idx-force-off', { a: ['s1'], b: [] });
    dirs.push(base);
    tombstone(dirB, 's1');
    const { indexSync } = mods();

    // Scoped to the session, but without the flag: still refused.
    const plan = await indexSync.planSyncAll({ cliSessionIds: ['cli-s1'] });
    assert.equal(plan.summary.copy, 0);
    assert.equal(plan.summary.tombstoned, 1);
    await indexSync.execute(plan.token);
    assert.deepEqual(listRecords(dirB), []);
    assert.ok(fs.existsSync(path.join(dirB, 'deleted_s1')), 'and the marker stands');
    restoreEnv(prev);
  });

  /* ------------------------------------------------------------- unlink */

  it('removes a record from one account and leaves the other alone', async () => {
    const prev = savedEnv();
    const { base, dirA, dirB } = twoAccounts('idx-unlink', { a: ['s1', 's2'], b: ['s1', 's2'] });
    dirs.push(base);
    const { indexSync } = mods();

    const plan = await indexSync.planUnlink({ cliSessionIds: ['cli-s1'], accountUuid: B });
    assert.equal(plan.summary.remove, 1);
    assert.deepEqual(listRecords(dirB), ['local_s1.json', 'local_s2.json'], 'the dry run must not remove');

    await indexSync.execute(plan.token);
    assert.deepEqual(listRecords(dirB), ['local_s2.json']);
    assert.deepEqual(listRecords(dirA), ['local_s1.json', 'local_s2.json'], 'the other account is untouched');
    restoreEnv(prev);
  });

  it('backs the record up before removing it', async () => {
    const prev = savedEnv();
    const { base, dirB } = twoAccounts('idx-unlink-backup', { a: [], b: ['s1'] });
    dirs.push(base);
    const original = fs.readFileSync(path.join(dirB, 'local_s1.json'));
    const { indexSync } = mods();

    const plan = await indexSync.planUnlink({ cliSessionIds: ['cli-s1'], accountUuid: B });
    const res = await indexSync.execute(plan.token);
    const backup = res.results[0].backupPath;
    assert.ok(backup, 'a removal must be recoverable');
    assert.ok(original.equals(fs.readFileSync(backup)), 'the backup must be the record that was removed');
    restoreEnv(prev);
  });

  it('leaves the transcript on disk completely alone', async () => {
    const prev = savedEnv();
    const { base, dirB } = twoAccounts('idx-unlink-transcript', { a: [], b: ['s1'] });
    dirs.push(base);
    const cc = H.claudeRoot(base);
    const transcript = H.writeJsonl(path.join(cc.projectsDir, 'cli-s1.jsonl'), H.claudeTranscript({ exchanges: 3 }));
    const before = fs.readFileSync(transcript);
    const { indexSync } = mods();

    const plan = await indexSync.planUnlink({ cliSessionIds: ['cli-s1'], accountUuid: B });
    await indexSync.execute(plan.token);
    assert.ok(fs.existsSync(transcript), 'unlinking is not deleting');
    assert.ok(before.equals(fs.readFileSync(transcript)), 'and the transcript is byte-identical');
    restoreEnv(prev);
  });

  it('marks the session deleted so a later sync does not put it back', async () => {
    const prev = savedEnv();
    const { base, dirB } = twoAccounts('idx-unlink-sticks', { a: ['s1'], b: ['s1'] });
    dirs.push(base);
    const { indexSync } = mods();

    await indexSync.execute((await indexSync.planUnlink({ cliSessionIds: ['cli-s1'], accountUuid: B })).token);
    assert.deepEqual(listRecords(dirB), [], 'removed');

    // The other account still has it, so a naive sync would copy it straight back.
    const sync = await indexSync.planSyncAll({});
    assert.equal(sync.summary.copy, 0);
    assert.equal(sync.summary.tombstoned, 1, 'the removal has to survive the next sync');
    await indexSync.execute(sync.token);
    assert.deepEqual(listRecords(dirB), [], 'and it stays removed');
    restoreEnv(prev);
  });

  it('says when a session is not listed by that account rather than failing', async () => {
    const prev = savedEnv();
    const { base, dirB } = twoAccounts('idx-unlink-absent', { a: ['s1'], b: ['s2'] });
    dirs.push(base);
    const { indexSync } = mods();

    const plan = await indexSync.planUnlink({ cliSessionIds: ['cli-s1'], accountUuid: B });
    assert.equal(plan.summary.remove, 0);
    assert.equal(plan.summary.notPresent, 1);

    await indexSync.execute(plan.token);
    assert.deepEqual(listRecords(dirB), ['local_s2.json'], 'nothing else was touched');
    restoreEnv(prev);
  });

  it('reports which other accounts would still list it', async () => {
    const prev = savedEnv();
    const { base } = twoAccounts('idx-unlink-alsoin', { a: ['s1', 's2'], b: ['s1', 's2'] });
    dirs.push(base);
    const { indexSync } = mods();

    const plan = await indexSync.planUnlink({ cliSessionIds: ['cli-s1'], accountUuid: B });
    assert.equal(plan.actions[0].alsoIn.length, 1, 'the user needs to know it is not the last copy');
    restoreEnv(prev);
  });

  it('writes nothing without a plan token, and refuses a replay', async () => {
    const prev = savedEnv();
    const { base, dirB } = twoAccounts('idx-unlink-token', { a: [], b: ['s1'] });
    dirs.push(base);
    const { indexSync } = mods();

    await assert.throws(() => indexSync.execute('not-a-token'), 'PLAN_REQUIRED');
    assert.deepEqual(listRecords(dirB), ['local_s1.json'], 'still there');

    const plan = await indexSync.planUnlink({ cliSessionIds: ['cli-s1'], accountUuid: B });
    await indexSync.execute(plan.token);
    await assert.throws(() => indexSync.execute(plan.token), 'PLAN_REQUIRED');
    restoreEnv(prev);
  });

  it('refuses to remove from an account whose history folder is unclear', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('idx-unlink-ambiguous');
    dirs.push(base);
    isolate(base);
    record(orgDir(base, A, ORG_A), 's1');
    record(orgDir(base, B, ORG_A), 'x1');
    record(orgDir(base, B, ORG_B), 'y1');
    const { indexSync } = mods();

    await assert.throws(
      () => indexSync.planUnlink({ cliSessionIds: ['cli-x1'], accountUuid: B }),
      'HISTORY_ORG_UNRESOLVED');
    assert.equal(listRecords(orgDir(base, B, ORG_A)).length, 1, 'nothing removed anywhere');
    assert.equal(listRecords(orgDir(base, B, ORG_B)).length, 1);
    restoreEnv(prev);
  });

  it('records every removal in the audit log', async () => {
    const prev = savedEnv();
    const { base } = twoAccounts('idx-unlink-audit', { a: [], b: ['s1'] });
    dirs.push(base);
    const { indexSync } = mods();
    const audit = require('../src/core/audit');

    const plan = await indexSync.planUnlink({ cliSessionIds: ['cli-s1'], accountUuid: B });
    await indexSync.execute(plan.token);

    const entry = audit.read(50).find((e) => e.action === 'account-history-unlink' && e.sessionId === 'cli-s1');
    assert.ok(entry, 'a removal must be auditable');
    assert.equal(entry.outcome, 'removed');
    assert.ok(entry.backupPath, 'and the audit line must say where the backup went');
    restoreEnv(prev);
  });

  it('records every write in the audit log', async () => {
    const prev = savedEnv();
    const { base } = twoAccounts('idx-audit', { a: ['s1'], b: [] });
    dirs.push(base);
    const { indexSync } = mods();
    const audit = require('../src/core/audit');

    const plan = await indexSync.planMigrate({ cliSessionIds: ['cli-s1'], targetAccountUuid: B });
    await indexSync.execute(plan.token);

    const log = audit.read(50);
    const entry = log.find((e) => e.action === 'account-history-migrate' && e.sessionId === 'cli-s1');
    assert.ok(entry, 'the write must be auditable');
    assert.equal(entry.outcome, 'written');
    assert.equal(entry.targetAccount, B);
    restoreEnv(prev);
  });
});

/**
 * One record id, two conversations.
 *
 * Continue a conversation on a second account -- which is what people do when
 * the first one hits a limit -- and Claude Desktop writes a NEW transcript
 * under the SAME record id. The two accounts then hold one record id pointing
 * at two different conversations.
 *
 * This shipped broken. The planner asked "does the target have this record
 * id?" before "does the target have this session?", so it reported the session
 * as already present and quietly refused to copy it -- the exact sessions
 * someone opens this app to fix. Found against a real two-account install
 * where 2 of 137 records collided this way.
 */
describe('index sync: one record id, two conversations', () => {
  const dirs = [];
  afterAll(() => { for (const d of dirs) H.rmrf(d); });

  /** Both accounts hold record `local_shared`, pointing at different sessions. */
  function collided(name) {
    const base = H.tmpDir(name); dirs.push(base);
    isolate(base);
    const dirA = orgDir(base, A, ORG_A);
    const dirB = orgDir(base, B, ORG_B);
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    const a = record(dirA, 'shared', { cliSessionId: 'transcript-in-A', title: 'Kaizen v1.0.0' });
    const b = record(dirB, 'shared', { cliSessionId: 'transcript-in-B', title: 'Kaizen v1.0.0' });
    return { base, dirA, dirB, a, b };
  }

  it('plans a copy instead of calling the session already present', async () => {
    const prev = savedEnv();
    const { dirB } = collided('collide-plan');
    const { indexSync } = mods();

    const plan = await indexSync.planSyncAll({ cliSessionIds: ['transcript-in-A'] });
    assert.equal(plan.summary.copy, 1, JSON.stringify(plan.summary));
    assert.equal(plan.summary.alreadyPresent, 0, 'the target does not have this conversation');
    const copy = plan.actions.find((x) => x.kind === 'copy');
    assert.equal(copy.cliSessionId, 'transcript-in-A');
    restoreEnv(prev);
  });

  it('gives the copy its own record id rather than landing on the taken one', async () => {
    const prev = savedEnv();
    const { dirB, b } = collided('collide-newid');
    const { indexSync } = mods();

    const plan = await indexSync.planSyncAll({ cliSessionIds: ['transcript-in-A'] });
    const copy = plan.actions.find((x) => x.kind === 'copy');
    assert.ok(copy.newRecordId, 'a colliding copy must be re-minted');
    assert.notEqual(copy.destPath, b, 'it must not be written over the record already there');
    restoreEnv(prev);
  });

  it('leaves the record already there byte-for-byte alone', async () => {
    const prev = savedEnv();
    const { dirB, b } = collided('collide-keep');
    const before = fs.readFileSync(b);
    const { indexSync } = mods();

    const plan = await indexSync.planSyncAll({ cliSessionIds: ['transcript-in-A'] });
    const res = await indexSync.execute(plan.token);
    assert.equal(res.summary.written, 1, JSON.stringify(res.summary));

    assert.equal(Buffer.compare(fs.readFileSync(b), before), 0,
      'the other conversation\'s record must be untouched');
    restoreEnv(prev);
  });

  it('ends with the target listing both conversations, each under its own id', async () => {
    const prev = savedEnv();
    const { dirB } = collided('collide-both');
    const { indexSync } = mods();

    const plan = await indexSync.planSyncAll({ cliSessionIds: ['transcript-in-A'] });
    await indexSync.execute(plan.token);

    const records = listRecords(dirB).map((f) =>
      JSON.parse(fs.readFileSync(path.join(dirB, f), 'utf8')));
    assert.equal(records.length, 2, 'the target keeps its own and gains the other');
    const sessions = records.map((r) => r.cliSessionId).sort();
    assert.deepEqual(sessions, ['transcript-in-A', 'transcript-in-B']);

    // A record has to carry the id it is filed under, or Desktop has two
    // files disagreeing about which record this is.
    for (const f of listRecords(dirB)) {
      const body = JSON.parse(fs.readFileSync(path.join(dirB, f), 'utf8'));
      assert.equal('local_' + body.sessionId.replace(/^local_/, '') + '.json', f,
        'record ' + f + ' calls itself ' + body.sessionId);
    }
    restoreEnv(prev);
  });

  it('still calls it present when the SAME conversation is there under another id', async () => {
    // The mirror case, which must keep working: same transcript, different
    // record id, is genuinely already present and must not be copied twice.
    const prev = savedEnv();
    const base = H.tmpDir('collide-mirror'); dirs.push(base);
    isolate(base);
    const dirA = orgDir(base, A, ORG_A);
    const dirB = orgDir(base, B, ORG_B);
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    record(dirA, 'idA', { cliSessionId: 'same-transcript' });
    record(dirB, 'idB', { cliSessionId: 'same-transcript' });
    const { indexSync } = mods();

    const plan = await indexSync.planSyncAll({ cliSessionIds: ['same-transcript'] });
    assert.equal(plan.summary.copy, 0, 'the conversation is already there');
    assert.greater(plan.summary.alreadyPresent, 0);
    restoreEnv(prev);
  });
});
