'use strict';
/**
 * Which organization folder holds an account's history.
 *
 * Claude Desktop shows the sidebar history from ONE folder under
 * `claude-code-sessions/<account>/`, and an account can carry more than one --
 * on the reference machine one account has a folder for the other account's
 * organization, holding nothing. Writing an index entry into the wrong folder
 * does not fail loudly; the session simply never appears. So the rule this
 * suite pins down is: identify it from evidence, or refuse.
 */
const fs = require('fs');
const path = require('path');
const H = require('./helpers');
const desktop = require('../src/core/parsers/claude-desktop');

const A = 'aaaaaaaa-1111-2222-3333-444444444444';
const B = 'bbbbbbbb-1111-2222-3333-444444444444';
const ORG_A = 'cccccccc-1111-2222-3333-444444444444';
const ORG_B = 'dddddddd-1111-2222-3333-444444444444';

/** Build <root>/claude-code-sessions/<account>/<org>/ with N entries. */
function makeTree(base, layout) {
  const root = path.join(base, 'Claude');
  for (const [account, orgs] of Object.entries(layout)) {
    for (const [org, count] of Object.entries(orgs)) {
      const dir = path.join(root, 'claude-code-sessions', account, org);
      fs.mkdirSync(dir, { recursive: true });
      // Every org folder gets this, real or not -- so its presence must never
      // be read as "this folder holds history".
      fs.writeFileSync(path.join(dir, 'scheduled-tasks.json'), '{"scheduledTasks":[]}');
      for (let i = 0; i < count; i++) {
        fs.writeFileSync(path.join(dir, `local_s${i}.json`), JSON.stringify({
          sessionId: `local_s${i}`, cliSessionId: `cli-${org.slice(0, 4)}-${i}`,
          title: `Session ${i}`, originCwd: 'F:\\demo', model: 'claude-opus-5',
          createdAt: 1785307143603, lastActivityAt: 1785307720266,
        }));
      }
    }
  }
  return root;
}

/** A candidate list, for exercising the decision without a filesystem. */
function cand(org, over = {}) {
  return {
    accountUuid: A, organizationUuid: org, dir: '/fake/' + org,
    sessionCount: 0, deletedCount: 0, createdMs: null, accountCreatedMs: null,
    ...over,
  };
}

describe('claude desktop: which folder holds the history', () => {
  let dir;
  beforeAll(() => { dir = H.tmpDir('desktop-org'); return { dir }; });
  afterAll(() => H.rmrf(dir));

  it('lists empty organization folders, which listAccounts must still hide', () => {
    const base = path.join(dir, 'empties');
    const root = makeTree(base, { [A]: { [ORG_A]: 3, [ORG_B]: 0 } });

    const all = desktop.listOrgFolders(root);
    assert.equal(all.length, 2, 'an empty folder is still a folder and the resolver needs to see it');
    assert.equal(all.filter((f) => f.sessionCount === 0).length, 1);

    const populated = desktop.listAccounts(root);
    assert.equal(populated.length, 1, 'but an empty folder is not an account with history');
    assert.equal(populated[0].organizationUuid, ORG_A);
  });

  it('ignores directories that are not uuids', () => {
    const base = path.join(dir, 'junk');
    const root = makeTree(base, { [A]: { [ORG_A]: 1 } });
    fs.mkdirSync(path.join(root, 'claude-code-sessions', A, 'not-a-uuid'), { recursive: true });
    fs.mkdirSync(path.join(root, 'claude-code-sessions', 'also-not-a-uuid'), { recursive: true });
    const all = desktop.listOrgFolders(root);
    assert.equal(all.length, 1);
    assert.equal(all[0].organizationUuid, ORG_A);
  });

  /* ------------------------------------------------ the real-world shape */

  it('picks the populated folder over an empty decoy', () => {
    // The observed case: an account carrying a folder for another account's
    // organization, with nothing in it.
    const base = path.join(dir, 'decoy');
    const root = makeTree(base, { [A]: { [ORG_B]: 0, [ORG_A]: 5 } });
    const r = desktop.resolveHistoryOrg(root, A);
    assert.notOk(r.ambiguous);
    assert.equal(r.organizationUuid, ORG_A);
    assert.equal(r.confidence, 'populated');
    assert.equal(r.candidates.length, 2, 'the decoy is still reported');
  });

  it('reads the pairing from the signed-in config ahead of anything else', () => {
    const base = path.join(dir, 'signed-in');
    const root = makeTree(base, { [A]: { [ORG_A]: 0, [ORG_B]: 9 } });
    // Population alone would say ORG_B; the account's own config says ORG_A.
    const r = desktop.resolveHistoryOrg(root, A, {
      signedIn: { accountUuid: A, organizationUuid: ORG_A },
    });
    assert.equal(r.organizationUuid, ORG_A);
    assert.equal(r.confidence, 'signed-in');
  });

  it('ignores a signed-in hint that belongs to a different account', () => {
    const base = path.join(dir, 'other-signin');
    const root = makeTree(base, { [A]: { [ORG_A]: 4 } });
    const r = desktop.resolveHistoryOrg(root, A, {
      signedIn: { accountUuid: B, organizationUuid: ORG_B },
    });
    assert.equal(r.organizationUuid, ORG_A);
    assert.equal(r.confidence, 'populated', 'a hint about another account proves nothing about this one');
  });

  it('resolves an account that is not signed in, from transcript owner rows', () => {
    const base = path.join(dir, 'transcript');
    const root = makeTree(base, { [A]: { [ORG_A]: 0, [ORG_B]: 0 } });
    const r = desktop.resolveHistoryOrg(root, A, {
      transcriptPairs: new Map([[A, ORG_B]]),
    });
    assert.equal(r.organizationUuid, ORG_B);
    assert.equal(r.confidence, 'transcript', 'two empty folders are separable by what the transcripts recorded');
  });

  /* ---------------------------------------------------- the new account */

  it('takes the single folder of a brand-new account with no sessions yet', () => {
    const base = path.join(dir, 'new-account');
    const root = makeTree(base, { [B]: { [ORG_B]: 0 } });
    const r = desktop.resolveHistoryOrg(root, B);
    assert.notOk(r.ambiguous);
    assert.equal(r.organizationUuid, ORG_B);
    assert.equal(r.confidence, 'only-folder');
  });

  it('separates two empty folders by which was created with the account', () => {
    const r = desktop.pickHistoryOrg(A, [
      cand(ORG_B, { createdMs: 5_000_000, accountCreatedMs: 1_000_000 }),  // months later
      cand(ORG_A, { createdMs: 1_000_400, accountCreatedMs: 1_000_000 }),  // same operation
    ]);
    assert.notOk(r.ambiguous);
    assert.equal(r.organizationUuid, ORG_A);
    assert.equal(r.confidence, 'born-together');
  });

  /* ------------------------------------------------------ the refusals */

  it('refuses when two folders both hold sessions and nothing identifies either', () => {
    const base = path.join(dir, 'both-populated');
    const root = makeTree(base, { [A]: { [ORG_A]: 3, [ORG_B]: 4 } });
    const r = desktop.resolveHistoryOrg(root, A);
    assert.ok(r.ambiguous, 'guessing here is what makes history invisible');
    assert.equal(r.organizationUuid, null);
    assert.equal(r.confidence, 'none');
    assert.ok(/[Ss]ign in/.test(r.reason), 'and it must say how to settle it: ' + r.reason);
  });

  it('refuses when the birth times cannot separate two empty folders', () => {
    // ext4 reports no birth time at all, and a restored backup loses them.
    const r = desktop.pickHistoryOrg(A, [cand(ORG_A), cand(ORG_B)]);
    assert.ok(r.ambiguous);
    assert.equal(r.organizationUuid, null);
  });

  it('refuses when both empty folders look equally newly born', () => {
    const r = desktop.pickHistoryOrg(A, [
      cand(ORG_A, { createdMs: 1_000_100, accountCreatedMs: 1_000_000 }),
      cand(ORG_B, { createdMs: 1_000_200, accountCreatedMs: 1_000_000 }),
    ]);
    assert.ok(r.ambiguous, 'two plausible answers is not an answer');
  });

  it('refuses to invent an organization when the account has no folder at all', () => {
    const base = path.join(dir, 'no-folder');
    const root = makeTree(base, { [A]: { [ORG_A]: 2 } });
    const r = desktop.resolveHistoryOrg(root, B);
    assert.ok(r.ambiguous);
    assert.equal(r.organizationUuid, null);
    assert.equal(r.candidates.length, 0);
    assert.ok(/cannot be invented/.test(r.reason), r.reason);
  });

  it('never returns a directory it did not actually find', () => {
    const base = path.join(dir, 'dir-real');
    const root = makeTree(base, { [A]: { [ORG_A]: 1 } });
    const r = desktop.resolveHistoryOrg(root, A);
    assert.ok(fs.existsSync(r.dir), 'the resolved directory must exist on disk');
    assert.equal(path.basename(r.dir), ORG_A);
  });

  it('counts a tombstone-only folder as holding history', () => {
    // Every session deleted is still the folder Desktop reads.
    const base = path.join(dir, 'tombstones');
    const root = makeTree(base, { [A]: { [ORG_A]: 0, [ORG_B]: 0 } });
    fs.writeFileSync(path.join(root, 'claude-code-sessions', A, ORG_A, 'deleted_x'), '1786454253433');
    const r = desktop.resolveHistoryOrg(root, A);
    assert.equal(r.organizationUuid, ORG_A);
    assert.equal(r.confidence, 'populated');
  });
});
