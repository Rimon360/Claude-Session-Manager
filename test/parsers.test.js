'use strict';
/**
 * Parser correctness, with emphasis on the format trap that causes silent
 * loss: Claude Code split turns.
 */
const fs = require('fs');
const path = require('path');
const H = require('./helpers');
const claudeCode = require('../src/core/parsers/claude-code');
const uss = require('../src/core/uss');

describe('parser: claude-code', () => {
  let dir;
  beforeAll(() => { dir = H.tmpDir('parse-cc'); return { dir }; });
  afterAll(() => H.rmrf(dir));

  it('parses messages, roles and tool calls out of a clean transcript', async () => {
    const f = H.writeJsonl(path.join(dir, 'a.jsonl'), H.claudeTranscript({ exchanges: 3 }));
    const { session } = await claudeCode.parseSession(f, { accountId: 'acct' });
    assert.equal(session.sourceTool, 'claude-code');
    assert.equal(session.model, 'claude-opus-5');
    assert.equal(session.projectPath, 'F:\\projects\\demo');
    const s = uss.summarize(session);
    assert.equal(s.roleCounts.user, 3);
    assert.equal(s.roleCounts.assistant, 6, '3 text + 3 tool_use blocks');
    assert.equal(s.roleCounts.tool, 3);
    assert.equal(uss.validate(session).length, 0);
  });

  it('KEEPS every block of a split turn instead of deduping by message.id', async () => {
    // Three rows share one message.id, each carrying different content. A
    // parser that keys on the id alone would keep one and drop two.
    const rows = H.claudeTranscript({ exchanges: 4, splitTurns: true });
    const f = H.writeJsonl(path.join(dir, 'split.jsonl'), rows);

    const assistantRows = rows.filter((r) => r.type === 'assistant');
    const uniqueIds = new Set(assistantRows.map((r) => r.message.id)).size;
    assert.equal(assistantRows.length, 12);
    assert.equal(uniqueIds, 4, 'fixture must actually reuse ids across rows');

    const { session } = await claudeCode.parseSession(f, {});
    const assistantMsgs = session.messages.filter((m) => m.role === 'assistant');
    assert.equal(assistantMsgs.length, 12, 'all 12 blocks must survive; id-only dedupe would leave 4');
    assert.equal(session.meta.duplicateBlocksCollapsed, 0);

    const texts = assistantMsgs.filter((m) => m.type === 'text').map((m) => m.text);
    assert.deepEqual(texts, ['answer 0', 'answer 1', 'answer 2', 'answer 3']);
    assert.equal(assistantMsgs.filter((m) => m.type === 'thinking').length, 4);
    assert.equal(assistantMsgs.filter((m) => m.type === 'tool_use').length, 4);
  });

  it('collapses a genuinely repeated block (same id AND same content)', async () => {
    const rows = H.claudeTranscript({ exchanges: 1 });
    const dup = JSON.parse(JSON.stringify(rows.find((r) => r.type === 'assistant')));
    rows.push(dup);
    const f = H.writeJsonl(path.join(dir, 'dup.jsonl'), rows);
    const { session } = await claudeCode.parseSession(f, {});
    assert.greater(session.meta.duplicateBlocksCollapsed, 0, 'an exact repeat must be collapsed');
  });

  it('preserves unmodelled row types for lossless round trip', async () => {
    const rows = H.claudeTranscript({ exchanges: 2 });
    rows.push({ type: 'atis-latch', payload: { odd: true } });
    rows.push({ type: 'cost-state', total: 1.23 });
    const f = H.writeJsonl(path.join(dir, 'exotic.jsonl'), rows);
    const { session } = await claudeCode.parseSession(f, { includeRawRows: true });
    const kept = session.meta.rawRows.map((r) => r.type);
    assert.includes(kept.join(','), 'atis-latch');
    assert.includes(kept.join(','), 'cost-state');
    assert.ok(session.meta.rowTypeCounts['ai-title'] > 0);
  });

  it('reports damage in meta rather than returning a clean-looking session', async () => {
    const f = H.writeJsonl(path.join(dir, 'bad.jsonl'), H.claudeTranscript({ exchanges: 5 }));
    H.corruptLine(f, 6);
    const { session, report } = await claudeCode.parseSession(f, {});
    assert.equal(report.integrity, 'damaged');
    assert.equal(session.meta.integrity, 'damaged');
    assert.equal(session.meta.integrityReport.errorCount, 1);
    assert.greater(session.messages.length, 0, 'undamaged rows are still recovered');
  });

  it('produces a stable content hash across repeated parses', async () => {
    const f = H.writeJsonl(path.join(dir, 'stable.jsonl'), H.claudeTranscript({ exchanges: 4 }));
    const a = await claudeCode.parseSession(f, {});
    const b = await claudeCode.parseSession(f, {});
    assert.equal(a.session.contentHash, b.session.contentHash);
  });

  it('finds sub-agent transcripts nested under the session directory', () => {
    const base = H.tmpDir('cc-tree');
    const { root, projectsDir } = H.claudeRoot(base);
    const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    H.writeJsonl(path.join(projectsDir, sid + '.jsonl'), H.claudeTranscript({ sessionId: sid, exchanges: 2 }));
    const wf = path.join(projectsDir, sid, 'subagents', 'workflows', 'wf_1234');
    H.writeJsonl(path.join(wf, 'agent-abc123.jsonl'), H.claudeTranscript({ exchanges: 1 }));
    H.writeJsonl(path.join(wf, 'journal.jsonl'), [{ type: 'note', text: 'x' }]);

    const found = claudeCode.listSessionFiles(root);
    assert.equal(found.main.length, 1);
    assert.equal(found.subagents.length, 2);
    assert.equal(found.subagents.filter((s) => s.kind === 'journal').length, 1);
    assert.equal(found.subagents[0].parentSessionId, sid);
    H.rmrf(base);
  });
});

describe('discovery: identity', () => {
  it('gives each FILE its own uid, even when sessions share an id', async () => {
    // A resumed or forked session can appear in several files under one id.
    // uid keys the selection set and the main-process entry lookup, so a
    // collision meant selecting one session selected several, and exporting
    // any of them exported the same file repeatedly.
    const base = H.tmpDir('uid-collision');
    const prevHome = process.env.AISM_HOME_OVERRIDE;
    process.env.AISM_HOME_OVERRIDE = base;
    const cc = H.claudeRoot(base);

    // Three separate files all reporting the same sessionId inside, which is
    // what a resumed or forked session looks like on disk.
    const sharedId = '019ff018-841e-7d12-b17b-a26fa36339f1';
    for (const name of ['a', 'b', 'c']) {
      H.writeJsonl(
        path.join(cc.projectsDir, `${name}.jsonl`),
        H.claudeTranscript({ sessionId: sharedId, exchanges: 2 })
      );
    }

    const discovery = require('../src/core/discovery');
    const scan = await discovery.scanAll();
    const sessions = scan.tools.flatMap((t) => t.sessions);

    assert.equal(sessions.length, 3, 'all three files must be listed');
    assert.equal(new Set(sessions.map((s) => s.sessionId)).size, 1, 'and they must share a session id');
    assert.equal(new Set(sessions.map((s) => s.uid)).size, 3, 'but each must get its own uid');
    assert.equal(new Set(sessions.map((s) => s.filePath)).size, 3);

    process.env.AISM_HOME_OVERRIDE = prevHome;
    H.rmrf(base);
  });

  it('derives uid from the file path, so it is stable across scans', () => {
    const discovery = require('../src/core/discovery');
    const a = discovery.makeUid('claude-code', 'acct', '/x/y/z.jsonl');
    const b = discovery.makeUid('claude-code', 'acct', '/x/y/z.jsonl');
    const c = discovery.makeUid('claude-code', 'acct', '/x/y/other.jsonl');
    assert.equal(a, b, 'same file must produce the same uid every scan');
    assert.notEqual(a, c);
  });
});

describe('discovery: multiple accounts in one folder', () => {
  it('finds every account from the transcripts, not just the logged-in one', async () => {
    // Switching login does not move or partition history: several accounts can
    // share one ~/.claude folder. The config file names only who is signed in
    // NOW, so ownership has to be read from the `bridge-session` rows inside
    // the transcripts. Looking only at config folders reports one account when
    // there are really several.
    const base = H.tmpDir('multi-account');
    const prevHome = process.env.AISM_HOME_OVERRIDE;
    process.env.AISM_HOME_OVERRIDE = base;
    const cc = H.claudeRoot(base, { accountUuid: 'acct-signed-in', email: 'me@example.com' });

    const withOwner = (sid, owner, org) => {
      const rows = H.claudeTranscript({ sessionId: sid, exchanges: 2 });
      rows.splice(3, 0, {
        type: 'bridge-session', sessionId: sid, bridgeSessionId: 'cse_' + sid,
        lastSequenceNum: 0, ownerAccountUuid: owner, ownerOrganizationUuid: org,
      });
      return rows;
    };

    H.writeJsonl(path.join(cc.projectsDir, 'a1.jsonl'), withOwner('a1', 'acct-signed-in', 'org-1'));
    H.writeJsonl(path.join(cc.projectsDir, 'a2.jsonl'), withOwner('a2', 'acct-signed-in', 'org-1'));
    H.writeJsonl(path.join(cc.projectsDir, 'b1.jsonl'), withOwner('b1', 'acct-other', 'org-2'));
    // A session that never recorded an owner: absent, not unowned.
    H.writeJsonl(path.join(cc.projectsDir, 'c1.jsonl'), H.claudeTranscript({ sessionId: 'c1', exchanges: 2 }));

    const discovery = require('../src/core/discovery');
    const scan = await discovery.scanAll();
    const tool = scan.tools.find((t) => t.tool === 'claude-code');

    assert.equal(tool.ownerAccounts.length, 2, 'both accounts must be found in one folder');
    const byId = Object.fromEntries(tool.ownerAccounts.map((o) => [o.accountUuid, o]));
    assert.equal(byId['acct-signed-in'].sessionCount, 2);
    assert.equal(byId['acct-other'].sessionCount, 1);
    assert.equal(byId['acct-signed-in'].isCurrent, true, 'the signed-in account is marked');
    assert.equal(byId['acct-other'].isCurrent, false, 'the other one is not');
    assert.equal(tool.unattributedSessions, 1, 'a session with no owner row is reported as such');

    const owned = tool.sessions.filter((s) => s.ownerAccountUuid);
    assert.equal(owned.length, 3, 'each session carries its own owner');

    process.env.AISM_HOME_OVERRIDE = prevHome;
    H.rmrf(base);
  });

  it('deep-scans for owners the head scan cannot reach', async () => {
    // Ownership usually sits around line 12, but not always -- on the reference
    // machine two of twelve were at line 731 and 8326. The listing pass reads
    // only the head, so a deeper pass has to exist.
    const base = H.tmpDir('deep-owner');
    const prevHome = process.env.AISM_HOME_OVERRIDE;
    process.env.AISM_HOME_OVERRIDE = base;
    const cc = H.claudeRoot(base);

    const rows = H.claudeTranscript({ sessionId: 'deep', exchanges: 40 });
    // Buried in the MIDDLE: past the 40-row head window and outside the
    // 8-row tail, so neither end of the fast scan can reach it.
    rows.splice(Math.floor(rows.length / 2), 0, {
      type: 'bridge-session', sessionId: 'deep', bridgeSessionId: 'cse_deep',
      lastSequenceNum: 0, ownerAccountUuid: 'acct-buried', ownerOrganizationUuid: 'org-x',
    });
    assert.greater(rows.length, 100, 'the owner row must sit well past the head window');
    H.writeJsonl(path.join(cc.projectsDir, 'deep.jsonl'), rows);

    const discovery = require('../src/core/discovery');
    const claudeCode = require('../src/core/parsers/claude-code');

    const shallow = await claudeCode.scanSessionMeta(path.join(cc.projectsDir, 'deep.jsonl'), 'x');
    assert.equal(shallow.ownerAccountUuid, null, 'the head scan cannot see it');
    assert.equal(shallow.ownerScan, 'shallow', 'and says its scan was shallow');

    const tool = discovery.detectTools().find((t) => t.tool === 'claude-code');
    const deep = await discovery.attributeAccounts(tool);
    assert.equal(deep.attributed, 1, 'the deep scan finds it');
    assert.equal(deep.accounts[0].accountUuid, 'acct-buried');

    process.env.AISM_HOME_OVERRIDE = prevHome;
    H.rmrf(base);
  });

  it('reads the signed-in identity from the config that actually has one', () => {
    // <root>/.claude.json holds machine state (machineID, userID) while
    // ~/.claude.json holds oauthAccount. Taking the first file with any id at
    // all reported a machine id as the account.
    const base = H.tmpDir('acct-config');
    const prevHome = process.env.AISM_HOME_OVERRIDE;
    process.env.AISM_HOME_OVERRIDE = base;
    H.claudeRoot(base, { accountUuid: 'real-account', email: 'real@example.com' });
    // The machine-state file, which must NOT win.
    fs.writeFileSync(path.join(base, '.claude', '.claude.json'),
      JSON.stringify({ machineID: 'mmm', userID: 'machine-user-id' }));

    const discovery = require('../src/core/discovery');
    const tool = discovery.detectTools().find((t) => t.tool === 'claude-code');
    assert.equal(tool.accountId.accountUuid, 'real-account');
    assert.equal(tool.accountId.email, 'real@example.com');
    assert.notEqual(tool.accountId.id, 'claude:machine-user-id');

    process.env.AISM_HOME_OVERRIDE = prevHome;
    H.rmrf(base);
  });
});
