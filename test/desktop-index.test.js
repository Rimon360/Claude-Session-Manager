'use strict';
/**
 * Claude Desktop's per-account session index.
 *
 * This is the only source that names every account's sessions. A `~/.claude`
 * folder mixes the transcripts of every account that has ever signed in, so
 * counting config folders reports one account when there may be several.
 */
const fs = require('fs');
const path = require('path');
const H = require('./helpers');
const desktop = require('../src/core/parsers/claude-desktop');

const A = 'aaaaaaaa-1111-2222-3333-444444444444';
const B = 'bbbbbbbb-1111-2222-3333-444444444444';
const ORG1 = 'cccccccc-1111-2222-3333-444444444444';
const ORG2 = 'dddddddd-1111-2222-3333-444444444444';

/** Build <root>/claude-code-sessions/<account>/<org>/local_*.json */
function makeIndex(base, layout) {
  const root = path.join(base, 'Claude');
  for (const [account, orgs] of Object.entries(layout)) {
    for (const [org, sessions] of Object.entries(orgs)) {
      const dir = path.join(root, 'claude-code-sessions', account, org);
      fs.mkdirSync(dir, { recursive: true });
      for (const s of sessions) {
        if (s.deleted) {
          fs.writeFileSync(path.join(dir, 'deleted_' + s.id), String(s.deletedAt ?? 1786454253433));
          continue;
        }
        fs.writeFileSync(path.join(dir, 'local_' + s.id + '.json'), JSON.stringify({
          sessionId: 'local_' + s.id,
          cliSessionId: s.cli,
          title: s.title ?? null,
          originCwd: s.cwd ?? 'F:\\demo',
          model: 'claude-opus-5',
          createdAt: 1785307143603,
          lastActivityAt: s.activity ?? 1785307720266,
          isArchived: !!s.archived,
          completedTurns: 2,
        }));
      }
    }
  }
  return root;
}


/**
 * Point every location the Desktop index can live at into the sandbox.
 *
 * LOCALAPPDATA matters as much as APPDATA: the Store build lives under
 * %LOCALAPPDATA%\Packages\Claude_*, so leaving it alone lets the real
 * machine's index leak into the test.
 */
function savedEnv() {
  return {
    home: process.env.AISM_HOME_OVERRIDE,
    data: process.env.AISM_DATA_OVERRIDE,
    appdata: process.env.APPDATA,
    localappdata: process.env.LOCALAPPDATA,
  };
}
function isolate(base) {
  process.env.AISM_HOME_OVERRIDE = base;
  process.env.AISM_DATA_OVERRIDE = path.join(base, 'appdata');
  process.env.APPDATA = path.join(base, 'AppData', 'Roaming');
  process.env.LOCALAPPDATA = path.join(base, 'AppData', 'Local');
  fs.mkdirSync(process.env.APPDATA, { recursive: true });
  fs.mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
}
function restoreEnv(prev) {
  const set = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  set('AISM_HOME_OVERRIDE', prev.home);
  set('AISM_DATA_OVERRIDE', prev.data);
  set('APPDATA', prev.appdata);
  set('LOCALAPPDATA', prev.localappdata);
}

describe('claude desktop: reading the index', () => {
  it('reads accounts, organizations, sessions and tombstones', () => {
    const base = H.tmpDir('desktop-index');
    const root = makeIndex(base, {
      [A]: { [ORG1]: [{ id: 's1', cli: 'cli-1', title: 'One' }, { id: 's2', cli: 'cli-2', title: 'Two' }] },
      [B]: { [ORG2]: [{ id: 's3', cli: 'cli-3', title: 'Three' }, { id: 'gone', deleted: true }] },
    });

    assert.equal(desktop.listAccounts(root).length, 2, 'one entry per account/org pair');

    const { entries, problems } = desktop.readIndex(root);
    assert.equal(problems.length, 0);
    assert.equal(entries.filter((e) => e.kind === 'session').length, 3);
    assert.equal(entries.filter((e) => e.kind === 'deleted').length, 1);

    const one = entries.find((e) => e.cliSessionId === 'cli-1');
    assert.equal(one.accountUuid, A);
    assert.equal(one.organizationUuid, ORG1);
    assert.equal(one.title, 'One');
    assert.ok(String(one.createdAt).startsWith('20'), 'epoch millis become an ISO date');

    const tomb = entries.find((e) => e.kind === 'deleted');
    assert.ok(tomb.deletedAt, 'the tombstone timestamp is read');

    const summary = desktop.summarize(entries);
    assert.equal(summary.length, 2);
    assert.equal(summary.find((s) => s.accountUuid === B).deletedCount, 1);
    H.rmrf(base);
  });

  it('reports a malformed entry instead of skipping it silently', () => {
    const base = H.tmpDir('desktop-bad');
    const root = makeIndex(base, { [A]: { [ORG1]: [{ id: 'ok', cli: 'cli-ok' }] } });
    fs.writeFileSync(path.join(root, 'claude-code-sessions', A, ORG1, 'local_broken.json'), '{ not json');

    const { entries, problems } = desktop.readIndex(root);
    assert.equal(entries.filter((e) => e.kind === 'session').length, 1, 'the good entry still loads');
    assert.equal(problems.length, 1, 'and the broken one is reported');
    assert.includes(problems[0].message, 'unparseable');
    H.rmrf(base);
  });

  it('ignores directories that are not account/org uuids', () => {
    const base = H.tmpDir('desktop-junk');
    const root = makeIndex(base, { [A]: { [ORG1]: [{ id: 'ok', cli: 'cli-ok' }] } });
    fs.mkdirSync(path.join(root, 'claude-code-sessions', 'not-a-uuid', 'nor-this'), { recursive: true });
    assert.equal(desktop.listAccounts(root).length, 1);
    H.rmrf(base);
  });
});

describe('claude desktop: account attribution', () => {
  it('treats a session listed under two accounts as claimed by BOTH', async () => {
    // The per-account folders overlap heavily -- on the reference machine 94 of
    // 97 indexed sessions appear under both accounts, byte-identical. Taking
    // the first one seen would hand almost every session to whichever
    // directory happened to be read first.
    const base = H.tmpDir('desktop-shared');
    const prev = savedEnv();
    isolate(base);

    const cc = H.claudeRoot(base);
    H.writeJsonl(path.join(cc.projectsDir, 'cli-shared.jsonl'), H.claudeTranscript({ sessionId: 'cli-shared', exchanges: 2 }));
    H.writeJsonl(path.join(cc.projectsDir, 'cli-solo.jsonl'), H.claudeTranscript({ sessionId: 'cli-solo', exchanges: 3 }));

    makeIndex(process.env.APPDATA, {
      [A]: { [ORG1]: [{ id: 'x1', cli: 'cli-shared', title: 'Shared' }, { id: 'x2', cli: 'cli-solo', title: 'Solo' }] },
      [B]: { [ORG2]: [{ id: 'y1', cli: 'cli-shared', title: 'Shared' }] },
    });

    const discovery = require('../src/core/discovery');
    const scan = await discovery.scanAll();
    const tool = scan.tools.find((t) => t.tool === 'claude-code');

    const shared = tool.sessions.find((s) => s.sessionId === 'cli-shared');
    const solo = tool.sessions.find((s) => s.sessionId === 'cli-solo');

    assert.equal(shared.indexedAccountUuids.length, 2, 'both accounts claim it');
    assert.equal(shared.ownerAccountUuid, null, 'so no single owner may be asserted');
    assert.equal(shared.ownerSource, 'shared');

    assert.deepEqual(solo.indexedAccountUuids, [A], 'only one account claims this one');
    assert.equal(solo.ownerAccountUuid, A, 'so it does get a definite owner');
    assert.equal(solo.ownerSource, 'desktop-index');

    assert.equal(tool.sharedAcrossAccounts, 1);
    const acctA = tool.ownerAccounts.find((o) => o.accountUuid === A);
    assert.equal(acctA.sessionCount, 2, 'A lists both');
    assert.equal(acctA.exclusiveCount, 1, 'but only one exclusively');

    restoreEnv(prev);
    H.rmrf(base);
  });

  it('takes the title from the index when the transcript has none', async () => {
    const base = H.tmpDir('desktop-title');
    const prev = savedEnv();
    isolate(base);

    const cc = H.claudeRoot(base);
    // A transcript with no title rows at all.
    const rows = H.claudeTranscript({ sessionId: 'cli-untitled', exchanges: 2 }).filter((r) => r.type !== 'ai-title');
    H.writeJsonl(path.join(cc.projectsDir, 'cli-untitled.jsonl'), rows);

    makeIndex(process.env.APPDATA, {
      [A]: { [ORG1]: [{ id: 't1', cli: 'cli-untitled', title: 'Named by the desktop index' }] },
    });

    const discovery = require('../src/core/discovery');
    const scan = await discovery.scanAll();
    const s = scan.tools.find((t) => t.tool === 'claude-code').sessions[0];
    assert.equal(s.title, 'Named by the desktop index');

    restoreEnv(prev);
    H.rmrf(base);
  });

});
