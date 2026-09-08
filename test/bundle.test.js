'use strict';
/**
 * Export / import against a destination that already holds sessions.
 *
 * The three collision cases the brief calls out are each tested: completely
 * identical content, near-duplicate content that diverges, and a colliding id
 * over genuinely unrelated conversations.
 */
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const bundle = require('../src/core/bundle');
const discovery = require('../src/core/discovery');
const merge = require('../src/core/merge');
const safety = require('../src/core/safety');

/** Build a synthetic home with a Claude Code install. */
function makeHome(name) {
  const base = H.tmpDir(name);
  const cc = H.claudeRoot(base);
  return { base, cc };
}

const SID = 'aaaaaaaa-1111-2222-3333-444444444444';

describe('bundle: export', () => {
  let home;
  beforeAll(() => {
    home = makeHome('bundle-export');
    process.env.AISM_HOME_OVERRIDE = home.base;
    process.env.AISM_DATA_OVERRIDE = path.join(home.base, 'appdata');
    return { home };
  });
  afterAll(() => {
    delete process.env.AISM_HOME_OVERRIDE;
    delete process.env.AISM_DATA_OVERRIDE;
    H.rmrf(home.base);
  });

  it('writes a manifest, a raw copy and a normalized copy for each session', async () => {
    H.writeJsonl(path.join(home.cc.projectsDir, SID + '.jsonl'), H.claudeTranscript({ sessionId: SID, exchanges: 3 }));
    const scan = await discovery.scanAll();
    const entries = scan.tools.flatMap((t) => t.sessions);
    assert.equal(entries.length, 1);

    const zip = path.join(home.base, 'out.zip');
    const res = await bundle.exportBundle(entries, zip);
    assert.ok(fs.existsSync(zip));
    assert.equal(res.manifest.sessions.length, 1);

    const rec = res.manifest.sessions[0];
    assert.equal(rec.sourceTool, 'claude-code');
    assert.equal(rec.integrity, 'ok');
    assert.greater(rec.messageCount, 0);
    assert.ok(rec.contentHash.startsWith('sha256:'));
    assert.equal(rec.rawEntries.length, 1);
    assert.ok(rec.rawEntries[0].sha256.startsWith('sha256:'), 'raw entries carry their own digest for verification on import');
    assert.ok(rec.normalizedEntry.startsWith('normalized/'));

    const { manifest, entries: zipEntries } = await bundle.readManifest(zip);
    assert.equal(manifest.sessions.length, 1);
    assert.ok(zipEntries.some((e) => e.name === 'manifest.json'));
    assert.ok(zipEntries.some((e) => e.name.startsWith('raw/claude-code/')));
    assert.ok(zipEntries.some((e) => e.name.startsWith('normalized/')));
  });

  it('flags a damaged session in the manifest instead of exporting it as healthy', async () => {
    const badId = 'bbbbbbbb-1111-2222-3333-444444444444';
    const f = H.writeJsonl(path.join(home.cc.projectsDir, badId + '.jsonl'), H.claudeTranscript({ sessionId: badId, exchanges: 5 }));
    H.corruptLine(f, 6);

    const scan = await discovery.scanAll();
    const entry = scan.tools.flatMap((t) => t.sessions).find((s) => s.sessionId === badId);
    const zip = path.join(home.base, 'damaged.zip');
    const res = await bundle.exportBundle([entry], zip);

    const rec = res.manifest.sessions[0];
    assert.equal(rec.integrity, 'damaged');
    assert.equal(res.manifest.warnings.length, 1);
    assert.includes(res.manifest.warnings[0].message, 'damaged');
    assert.equal(rec.rawEntries.length, 1, 'the raw bytes still travel so nothing is lost');
    fs.rmSync(path.join(home.cc.projectsDir, badId + '.jsonl'));
  });

  it('carries sub-agent transcripts alongside their parent session', async () => {
    const wf = path.join(home.cc.projectsDir, SID, 'subagents', 'workflows', 'wf_a1');
    H.writeJsonl(path.join(wf, 'agent-aaa.jsonl'), H.claudeTranscript({ exchanges: 1 }));
    const scan = await discovery.scanAll();
    const entry = scan.tools.flatMap((t) => t.sessions).find((s) => s.sessionId === SID);
    assert.equal(entry.subAgentCount, 1);

    const zip = path.join(home.base, 'sub.zip');
    const res = await bundle.exportBundle([entry], zip);
    assert.equal(res.manifest.sessions[0].rawEntries.length, 2, 'main transcript plus the sub-agent file');
    H.rmrf(path.join(home.cc.projectsDir, SID));
  });
});

describe('bundle: import collisions', () => {
  let src, dst, zip;

  beforeAll(async () => {
    // Build the bundle from a source home...
    src = makeHome('bundle-src');
    process.env.AISM_HOME_OVERRIDE = src.base;
    process.env.AISM_DATA_OVERRIDE = path.join(src.base, 'appdata');

    H.writeJsonl(path.join(src.cc.projectsDir, SID + '.jsonl'),
      H.claudeTranscript({ sessionId: SID, exchanges: 4 }));

    const scan = await discovery.scanAll();
    zip = path.join(src.base, 'transfer.zip');
    await bundle.exportBundle(scan.tools.flatMap((t) => t.sessions), zip);

    // ...then point everything at a fresh destination home.
    dst = makeHome('bundle-dst');
    process.env.AISM_HOME_OVERRIDE = dst.base;
    process.env.AISM_DATA_OVERRIDE = path.join(dst.base, 'appdata');
    return { src, dst, zip };
  });

  afterAll(() => {
    delete process.env.AISM_HOME_OVERRIDE;
    delete process.env.AISM_DATA_OVERRIDE;
    H.rmrf(src.base);
    H.rmrf(dst.base);
  });

  it('plans a plain write when the destination does not have the session', async () => {
    const plan = await bundle.planImport(zip);
    assert.equal(plan.summary.write, 1);
    assert.equal(plan.summary.conflict, 0);
    assert.equal(plan.actions[0].kind, 'write');
    // A dry run must not have touched anything.
    assert.notOk(fs.existsSync(plan.actions[0].destPath), 'planning must not write');
  });

  it('writes the session, verifying the extracted bytes against the manifest digest', async () => {
    const plan = await bundle.planImport(zip);
    const res = await bundle.executeImport(plan.token, {});
    assert.equal(res.results[0].applied, 'written');
    const dest = res.results[0].destPath;
    assert.ok(fs.existsSync(dest));

    const srcBytes = fs.readFileSync(path.join(src.cc.projectsDir, SID + '.jsonl'));
    const dstBytes = fs.readFileSync(dest);
    assert.equal(Buffer.compare(srcBytes, dstBytes), 0,
      'a same-tool import restores the original bytes exactly, so the round trip is lossless by construction');
  });

  it('CASE 1 — completely identical content is skipped as a no-op', async () => {
    const plan = await bundle.planImport(zip);
    assert.equal(plan.summary.skipIdentical, 1);
    assert.equal(plan.summary.write, 0);
    assert.equal(plan.summary.conflict, 0);
    assert.includes(plan.actions[0].reason, 'identical');

    const before = fs.statSync(plan.actions[0].destPath ?? plan.actions[0].existing.filePath).mtimeMs;
    const res = await bundle.executeImport(plan.token, {});
    assert.equal(res.results[0].applied, 'skipped-identical');
    const after = fs.statSync(plan.actions[0].existing.filePath).mtimeMs;
    assert.equal(before, after, 'an identical import must not rewrite the file');
  });

  it('CASE 2 — near-duplicate content is reported as a conflict, never overwritten silently', async () => {
    // Diverge the local copy: same first exchanges, different tail.
    const localRows = H.claudeTranscript({ sessionId: SID, exchanges: 4 });
    localRows.push({
      parentUuid: null, isSidechain: false, userType: 'external',
      cwd: 'F:\\projects\\demo', sessionId: SID, version: '2.1.0',
      uuid: H.seqUuid('extra'), timestamp: '2026-01-02T00:00:00.000Z',
      type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'only on this machine' }] },
    });
    const local = path.join(dst.cc.projectsDir, SID + '.jsonl');
    H.writeJsonl(local, localRows);

    const plan = await bundle.planImport(zip);
    assert.equal(plan.summary.conflict, 1);
    const a = plan.actions[0];
    assert.equal(a.kind, 'conflict');
    assert.equal(a.comparison.relation, merge.RELATION.PREFIX);
    assert.ok(a.diff, 'a conflict must carry a diff preview for the merge screen');
    assert.ok(a.recommendation, 'and a recommendation');

    // Executing with no resolution must leave the file alone.
    const before = fs.readFileSync(local, 'utf8');
    const res = await bundle.executeImport(plan.token, {});
    assert.equal(res.results[0].applied, 'skipped-unresolved');
    assert.equal(fs.readFileSync(local, 'utf8'), before,
      'silence is never consent: an unresolved conflict must not modify the file');
  });

  it('keep-both writes alongside instead of replacing', async () => {
    const local = path.join(dst.cc.projectsDir, SID + '.jsonl');
    const before = fs.readFileSync(local, 'utf8');

    const plan = await bundle.planImport(zip);
    const res = await bundle.executeImport(plan.token, { [SID]: merge.RESOLUTION.KEEP_BOTH });
    assert.equal(res.results[0].applied, 'written-alongside');
    assert.notEqual(res.results[0].destPath, local);
    assert.ok(fs.existsSync(res.results[0].destPath));
    assert.equal(fs.readFileSync(local, 'utf8'), before, 'the original must be untouched');
    fs.rmSync(res.results[0].destPath);
  });

  it('keep-incoming overwrites but backs up the replaced bytes first', async () => {
    const local = path.join(dst.cc.projectsDir, SID + '.jsonl');
    const before = fs.readFileSync(local, 'utf8');

    const plan = await bundle.planImport(zip);
    const res = await bundle.executeImport(plan.token, { [SID]: merge.RESOLUTION.KEEP_INCOMING });
    assert.equal(res.results[0].applied, 'overwritten');
    assert.ok(res.results[0].backupPath, 'an overwrite must record where the old bytes went');
    assert.equal(fs.readFileSync(res.results[0].backupPath, 'utf8'), before,
      'the replaced version must be recoverable');
    assert.notEqual(fs.readFileSync(local, 'utf8'), before);
  });

  it('CASE 3 — a colliding id over unrelated content is flagged as unrelated, not merged', async () => {
    // Same id, completely different conversation.
    const unrelated = H.claudeTranscript({ sessionId: SID, exchanges: 3, startTime: Date.parse('2027-01-01T00:00:00Z') });
    unrelated.forEach((r) => {
      if (r.type === 'user' && r.message?.content?.[0]?.text?.startsWith('question')) {
        r.message.content[0].text = 'totally different topic ' + Math.random();
      }
    });
    H.writeJsonl(path.join(dst.cc.projectsDir, SID + '.jsonl'), unrelated);

    const plan = await bundle.planImport(zip);
    const a = plan.actions[0];
    assert.equal(a.kind, 'conflict');
    assert.equal(a.comparison.relation, merge.RELATION.UNRELATED);
    assert.equal(a.comparison.commonPrefixLength, 0);
    assert.equal(a.recommendation.resolution, merge.RESOLUTION.KEEP_BOTH);
    assert.includes(a.recommendation.reason, 'id collision');
  });

  it('refuses a bundle written by a newer format version', async () => {
    // Rewrite the manifest with a future schema version.
    const zipstream = require('../src/core/zipstream');
    const future = path.join(dst.base, 'future.zip');
    const w = new zipstream.ZipWriter(future);
    await w.open();
    await w.addBuffer('manifest.json', JSON.stringify({ bundleSchemaVersion: 99, sessions: [] }));
    await w.close();
    await assert.throws(() => bundle.readManifest(future), 'format version 99');
  });

  it('refuses a zip that is not a bundle at all', async () => {
    const zipstream = require('../src/core/zipstream');
    const notBundle = path.join(dst.base, 'not-a-bundle.zip');
    const w = new zipstream.ZipWriter(notBundle);
    await w.open();
    await w.addBuffer('readme.txt', 'hello');
    await w.close();
    await assert.throws(() => bundle.readManifest(notBundle), 'not a Claude Session Manager bundle');
  });

  it('refuses to execute an import without a plan token from a dry run', async () => {
    await assert.throws(() => bundle.executeImport('made-up-token', {}), 'PLAN_REQUIRED');
  });

  it('writes the RIGHT bytes when two sessions share a session id', async () => {
    // A session id is not unique on disk: resuming or forking a session can
    // leave the same id in two files. Indexing the manifest by session id
    // therefore collapses two records into one and writes one session's bytes
    // over the other's -- silent corruption of a file the user asked us to
    // restore.
    const home = makeHome('bundle-dupid');
    const prevHome = process.env.AISM_HOME_OVERRIDE;
    const prevData = process.env.AISM_DATA_OVERRIDE;
    process.env.AISM_HOME_OVERRIDE = home.base;
    process.env.AISM_DATA_OVERRIDE = path.join(home.base, 'appdata');

    const sharedId = '019ff018-8411-7aaa-bbbb-cccccccccccc';
    const fileA = path.join(home.cc.projectsDir, 'shared-a.jsonl');
    const fileB = path.join(home.cc.projectsDir, 'shared-b.jsonl');
    // Same id inside both files, deliberately different content and lengths.
    H.writeJsonl(fileA, H.claudeTranscript({ sessionId: sharedId, exchanges: 2 }));
    H.writeJsonl(fileB, H.claudeTranscript({ sessionId: sharedId, exchanges: 7 }));

    const shaOf = (p) => require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    const wantA = shaOf(fileA);
    const wantB = shaOf(fileB);
    assert.notEqual(wantA, wantB, 'fixture must actually differ');

    const scan = await discovery.scanAll();
    const sharedIdEntries = scan.tools.flatMap((t) => t.sessions);
    assert.equal(sharedIdEntries.length, 2, 'both files must be discovered despite the shared id');
    assert.equal(new Set(sharedIdEntries.map((s) => s.sessionId)).size, 1, 'and they must in fact share an id');

    const zip = path.join(home.base, 'dupid.zip');
    await bundle.exportBundle(sharedIdEntries, zip);

    // Restore onto a clean machine.
    const dest = makeHome('bundle-dupid-dest');
    process.env.AISM_HOME_OVERRIDE = dest.base;
    process.env.AISM_DATA_OVERRIDE = path.join(dest.base, 'appdata');

    const plan = await bundle.planImport(zip);
    assert.equal(plan.summary.write, 2, 'both must be planned as writes');
    assert.deepEqual(plan.actions.map((a) => a.manifestIndex), [0, 1],
      'each action must carry its own manifest position');

    const res = await bundle.executeImport(plan.token, {});
    assert.ok(res.results.every((r) => r.applied === 'written'), 'both must be written');

    const outA = res.results.find((r) => r.destPath.includes('shared-a')).destPath;
    const outB = res.results.find((r) => r.destPath.includes('shared-b')).destPath;
    assert.equal(shaOf(outA), wantA, 'the first rollout must restore its OWN bytes, not its sibling\'s');
    assert.equal(shaOf(outB), wantB, 'and so must the second');

    // A re-import must now be a clean no-op rather than a phantom conflict.
    const again = await bundle.planImport(zip);
    assert.equal(again.summary.skipIdentical, 2, JSON.stringify(again.summary));
    assert.equal(again.summary.conflict, 0);

    process.env.AISM_HOME_OVERRIDE = prevHome;
    process.env.AISM_DATA_OVERRIDE = prevData;
    H.rmrf(home.base);
    H.rmrf(dest.base);
  });
});
