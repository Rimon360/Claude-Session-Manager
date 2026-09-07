'use strict';
/**
 * Multi-account sync and cross-tool conversion.
 */
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const sync = require('../src/core/sync');
const discovery = require('../src/core/discovery');
const merge = require('../src/core/merge');
const claudeExporter = require('../src/core/exporters/claude-code');
const uss = require('../src/core/uss');

describe('sync: multi-account', () => {
  let base, rootA, rootB;

  beforeAll(() => {
    base = H.tmpDir('sync');
    // Two Claude Code profile roots, surfaced as separate accounts.
    rootA = path.join(base, 'profileA', '.claude');
    rootB = path.join(base, 'profileB', '.claude');
    for (const r of [rootA, rootB]) fs.mkdirSync(path.join(r, 'projects', 'F--projects-demo'), { recursive: true });
    fs.writeFileSync(path.join(base, 'profileA', '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acct-A', emailAddress: 'a@example.com' } }));
    fs.writeFileSync(path.join(base, 'profileB', '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acct-B', emailAddress: 'b@example.com' } }));

    process.env.CLAUDE_CONFIG_DIR = rootA + ';' + rootB;
    process.env.AISM_HOME_OVERRIDE = path.join(base, 'nohome');
    process.env.AISM_DATA_OVERRIDE = path.join(base, 'appdata');
    fs.mkdirSync(path.join(base, 'nohome'), { recursive: true });
    return { base, rootA, rootB };
  });

  afterAll(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.AISM_HOME_OVERRIDE;
    delete process.env.AISM_DATA_OVERRIDE;
    H.rmrf(base);
  });

  it('detects both profile roots as separate accounts', async () => {
    const tools = discovery.detectTools().filter((t) => t.tool === 'claude-code');
    assert.equal(tools.length, 2);
    assert.notEqual(tools[0].accountId.id, tools[1].accountId.id);
  });

  it('plans a copy for a session that only one account has', async () => {
    const onlyA = 'aaaaaaaa-0000-0000-0000-00000000000a';
    H.writeJsonl(path.join(rootA, 'projects', 'F--projects-demo', onlyA + '.jsonl'),
      H.claudeTranscript({ sessionId: onlyA, exchanges: 3 }));

    const plan = await sync.planSync('claude-code');
    assert.equal(plan.summary.copy, 1);
    assert.equal(plan.summary.conflict, 0);
    const copy = plan.actions.find((a) => a.kind === 'copy');
    assert.includes(copy.destPath, 'profileB');
    assert.notOk(fs.existsSync(copy.destPath), 'planning must not write');
  });

  it('copies the missing session into the other account', async () => {
    const plan = await sync.planSync('claude-code');
    const res = await sync.executeSync(plan.token, {});
    const copied = res.results.filter((r) => r.applied === 'copied');
    assert.equal(copied.length, 1);
    assert.ok(fs.existsSync(copied[0].destPath));

    const srcBytes = fs.readFileSync(path.join(rootA, 'projects', 'F--projects-demo', 'aaaaaaaa-0000-0000-0000-00000000000a.jsonl'));
    assert.equal(Buffer.compare(srcBytes, fs.readFileSync(copied[0].destPath)), 0, 'sync copies raw bytes');
  });

  it('reports both accounts as in sync once the union is complete', async () => {
    const plan = await sync.planSync('claude-code');
    assert.equal(plan.summary.copy, 0);
    assert.equal(plan.summary.alreadyEverywhere, 1);
  });

  it('unions by CONTENT, so the same conversation under two ids is not duplicated', async () => {
    const rows = H.claudeTranscript({ sessionId: 'shared-content', exchanges: 2 });
    // Same conversation, different file name and different uuids per row.
    H.writeJsonl(path.join(rootA, 'projects', 'F--projects-demo', 'id-one.jsonl'), rows);
    H.writeJsonl(path.join(rootB, 'projects', 'F--projects-demo', 'id-two.jsonl'), rows);

    const plan = await sync.planSync('claude-code');
    const copies = plan.actions.filter((a) => a.kind === 'copy' && (a.sessionId === 'shared-content'));
    assert.equal(copies.length, 0, 'identical content already in both accounts needs no copy, whatever the filename');

    fs.rmSync(path.join(rootA, 'projects', 'F--projects-demo', 'id-one.jsonl'));
    fs.rmSync(path.join(rootB, 'projects', 'F--projects-demo', 'id-two.jsonl'));
  });

  it('surfaces a diverging session as a conflict rather than resolving it', async () => {
    const sid = 'cccccccc-0000-0000-0000-00000000000c';
    H.writeJsonl(path.join(rootA, 'projects', 'F--projects-demo', sid + '.jsonl'),
      H.claudeTranscript({ sessionId: sid, exchanges: 3 }));
    const other = H.claudeTranscript({ sessionId: sid, exchanges: 3 });
    other.push({
      parentUuid: null, isSidechain: false, userType: 'external', cwd: 'F:\\projects\\demo',
      sessionId: sid, version: '2.1.0', uuid: H.seqUuid('b'), timestamp: '2026-02-02T00:00:00.000Z',
      type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'B-only tail' }] },
    });
    H.writeJsonl(path.join(rootB, 'projects', 'F--projects-demo', sid + '.jsonl'), other);

    const plan = await sync.planSync('claude-code');
    assert.greater(plan.summary.conflict, 0);
    const conflict = plan.conflicts.find((c) => c.sessionId === sid);
    assert.ok(conflict, 'the diverging session must appear in the conflict list');
    assert.ok(conflict.diff, 'with a diff for the merge screen');
    assert.ok(conflict.recommendation);

    // Applying with no resolution changes nothing.
    const aBefore = fs.readFileSync(path.join(rootA, 'projects', 'F--projects-demo', sid + '.jsonl'), 'utf8');
    const bBefore = fs.readFileSync(path.join(rootB, 'projects', 'F--projects-demo', sid + '.jsonl'), 'utf8');
    const res = await sync.executeSync(plan.token, {});
    assert.ok(res.results.some((r) => r.applied === 'skipped-unresolved'));
    assert.equal(fs.readFileSync(path.join(rootA, 'projects', 'F--projects-demo', sid + '.jsonl'), 'utf8'), aBefore);
    assert.equal(fs.readFileSync(path.join(rootB, 'projects', 'F--projects-demo', sid + '.jsonl'), 'utf8'), bBefore);
  });

  it('syncs a CHOSEN PAIR and leaves the third account untouched', async () => {
    // "Sync A with B, not C." C must not be read from, written to, or listed
    // as a destination -- picking a subset has to mean it exactly.
    const rootC = path.join(base, 'profileC', '.claude');
    fs.mkdirSync(path.join(rootC, 'projects', 'F--projects-demo'), { recursive: true });
    fs.writeFileSync(path.join(base, 'profileC', '.claude.json'),
      JSON.stringify({ oauthAccount: { accountUuid: 'acct-C', emailAddress: 'c@example.com' } }));
    process.env.CLAUDE_CONFIG_DIR = [rootA, rootB, rootC].join(';');

    // A session only A has. The exchange count must differ from every other
    // fixture in this suite: the content hash ignores ids and timestamps, so
    // two transcripts with the same text ARE the same conversation and would
    // correctly need no copying.
    const onlyA = 'ffffffff-0000-0000-0000-00000000000f';
    H.writeJsonl(path.join(rootA, 'projects', 'F--projects-demo', onlyA + '.jsonl'),
      H.claudeTranscript({ sessionId: onlyA, exchanges: 7 }));

    const listC = () => {
      const dir = path.join(rootC, 'projects', 'F--projects-demo');
      return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    };
    const cBefore = listC();

    const plan = await sync.planSync('claude-code', { accountRoots: [rootA, rootB] });
    assert.equal(plan.summary.copy, 1, 'the fixture must be genuinely new to B');
    assert.equal(plan.accounts.length, 2, 'only the chosen pair takes part');
    assert.equal(plan.excluded.length, 1, 'the third is reported as excluded');
    assert.includes(plan.excluded[0].root, 'profileC');

    // No action may reference C at all.
    const mentionsC = plan.actions.some((a) =>
      String(a.destPath || '').includes('profileC') ||
      String(a.sourcePath || '').includes('profileC') ||
      String(a.destAccount?.root || '').includes('profileC'));
    assert.notOk(mentionsC, 'no planned action may touch the excluded account');

    const res = await sync.executeSync(plan.token, {});
    assert.ok(res.results.some((r) => r.applied === 'copied'), 'the chosen pair still syncs');
    assert.deepEqual(listC(), cBefore, 'the excluded account must be byte-for-byte unchanged');

    // And A -> B did happen.
    assert.ok(fs.existsSync(path.join(rootB, 'projects', 'F--projects-demo', onlyA + '.jsonl')),
      'B must have received the session that only A had');

    process.env.CLAUDE_CONFIG_DIR = rootA + ';' + rootB + ';' + rootC;
  });

  it('reports a requested account it cannot find instead of silently skipping it', async () => {
    const plan = await sync.planSync('claude-code', {
      accountRoots: [rootA, path.join(base, 'does-not-exist', '.claude')],
    });
    assert.equal(plan.actions.length, 0, 'nothing may be planned when the selection is wrong');
    assert.equal(plan.unmatched.length, 1);
    assert.includes(plan.note, 'not found');
  });

  it('explains itself when fewer than two accounts are selected', async () => {
    const plan = await sync.planSync('claude-code', { accountRoots: [rootA] });
    assert.equal(plan.actions.length, 0);
    assert.includes(plan.note, 'at least two');
  });

  it('syncs every account when no selection is given', async () => {
    const plan = await sync.planSync('claude-code');
    assert.atLeast(plan.accounts.length, 3, 'unscoped sync still means all of them');
    assert.equal(plan.excluded.length, 0);
  });

  it('refuses to execute a sync without a plan token', async () => {
    await assert.throws(() => sync.executeSync('nope', {}), 'PLAN_REQUIRED');
  });
});

describe('uss: schema', () => {
  it('validates a well-formed session', () => {
    const s = uss.emptySession({ sourceTool: 'claude-code', sessionId: 'x' });
    s.messages = [uss.makeMessage({ role: 'user', type: 'text', text: 'hi' })];
    uss.finalize(s);
    assert.equal(uss.validate(s).length, 0);
  });

  it('rejects an unknown source tool, role or message type', () => {
    const s = uss.emptySession({ sourceTool: 'not-a-tool', sessionId: 'x' });
    s.messages = [uss.makeMessage({ role: 'wizard', type: 'telepathy' })];
    uss.finalize(s);
    const problems = uss.validate(s).map((p) => p.path);
    assert.ok(problems.includes('sourceTool'));
    assert.ok(problems.includes('messages[0].role'));
    assert.ok(problems.includes('messages[0].type'));
  });

  it('detects a content hash that does not match the messages', () => {
    const s = uss.emptySession({ sourceTool: 'claude-code', sessionId: 'x' });
    s.messages = [uss.makeMessage({ role: 'user', type: 'text', text: 'hi' })];
    uss.finalize(s);
    s.messages[0].text = 'tampered';
    const problems = uss.validate(s);
    assert.ok(problems.some((p) => p.path === 'contentHash'),
      'a bundle whose normalized content was edited after export must fail validation');
  });

  it('serializes deterministically regardless of key order', () => {
    assert.equal(uss.stableStringify({ b: 1, a: 2 }), uss.stableStringify({ a: 2, b: 1 }));
    assert.notEqual(uss.stableStringify([1, 2]), uss.stableStringify([2, 1]), 'array order is meaningful');
  });
});
