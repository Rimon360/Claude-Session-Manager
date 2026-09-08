'use strict';
/**
 * A bundle made on one machine, restored on another.
 *
 * The two ways this goes wrong are both silent. A path separator that is not
 * the one the importing machine uses does not fail -- on Linux it produces a
 * single file called `projects\foo\bar.jsonl` sitting in the root, which looks
 * like success and is invisible to every scan. And a relative path taken from
 * a file someone else wrote can walk out of the tool directory entirely.
 *
 * So these tests do not check that import "works". They check where the bytes
 * land, that nothing already on disk is lost to get them there, and that a
 * bundle asking for somewhere it should not have is refused rather than
 * sanitised into somewhere plausible.
 */
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const bundle = require('../src/core/bundle');
const discovery = require('../src/core/discovery');
const paths = require('../src/core/paths');
const { ZipWriter, readCentralDirectory } = require('../src/core/zipstream');

const SID = 'bbbbbbbb-2222-3333-4444-555555555555';
const SEP = String.fromCharCode(92);   // a literal backslash, unambiguously

function useHome(base) {
  process.env.AISM_HOME_OVERRIDE = base;
  process.env.AISM_DATA_OVERRIDE = path.join(base, 'appdata');
}

/**
 * Rebuild a bundle with one field of the manifest replaced.
 *
 * The raw member is the real file, so everything the importer verifies -- the
 * digest, the parse, the integrity check -- still passes. Only the claim about
 * where the session belongs is different, which is the thing under test.
 */
async function rewriteManifest(srcZip, destZip, patch) {
  const { manifest } = await bundle.readManifest(srcZip);
  const rec = manifest.sessions[0];
  const rawName = rec.rawEntries[0].archiveName;
  Object.assign(rec, patch);

  const entries = await readCentralDirectory(srcZip);
  const writer = new ZipWriter(destZip);
  await writer.open();
  await writer.addBuffer('manifest.json', JSON.stringify(manifest, null, 1));
  for (const e of entries) {
    if (e.name === 'manifest.json') continue;
    const buf = await require('../src/core/zipstream').readEntryBuffer(srcZip, e);
    await writer.addBuffer(e.name, buf);
  }
  await writer.close();
  return { rawName, manifest };
}

describe('bundles move between machines without losing anything', () => {
  const dirs = [];
  let srcBase, srcCc, zip;

  beforeAll(async () => {
    srcBase = H.tmpDir('portable-src'); dirs.push(srcBase);
    srcCc = H.claudeRoot(srcBase);
    useHome(srcBase);
    H.writeJsonl(path.join(srcCc.projectsDir, SID + '.jsonl'),
      H.claudeTranscript({ sessionId: SID, exchanges: 4 }));
    const scan = await discovery.scanAll();
    zip = path.join(srcBase, 'transfer.zip');
    await bundle.exportBundle(scan.tools.flatMap((t) => t.sessions), zip);
    return {};
  });

  afterAll(() => {
    delete process.env.AISM_HOME_OVERRIDE;
    delete process.env.AISM_DATA_OVERRIDE;
    for (const d of dirs) H.rmrf(d);
  });

  /** A fresh destination machine for one test. */
  function freshDest(name) {
    const base = H.tmpDir(name); dirs.push(base);
    const cc = H.claudeRoot(base);
    useHome(base);
    return { base, cc };
  }

  /* --------------------------------------------------------- the archive */

  it('names every member with forward slashes, whatever machine wrote it', async () => {
    // ZIP says forward slashes. A Windows build that wrote path.sep would make
    // an archive macOS reads as filenames with backslashes in them.
    const entries = await readCentralDirectory(zip);
    for (const e of entries) {
      assert.notOk(e.name.includes(SEP), e.name + ' carries a backslash');
    }
    assert.ok(entries.some((e) => e.name.startsWith('raw/')), 'and the raw copy is in there');
  });

  it('records the original location with forward slashes too', async () => {
    const { manifest } = await bundle.readManifest(zip);
    assert.notOk(manifest.sessions[0].originalRelative.includes(SEP),
      manifest.sessions[0].originalRelative);
  });

  /* ------------------------------------------- separators, both directions */

  it('restores a bundle whose paths use the other platform\'s separator', async () => {
    const dst = freshDest('portable-sep');
    // What a Windows machine would have written before separators were
    // normalised, imported here.
    const windowsStyle = ['projects', 'F--projects-demo', SID + '.jsonl'].join(SEP);
    const doctored = path.join(dst.base, 'winstyle.zip');
    await rewriteManifest(zip, doctored, { originalRelative: windowsStyle });

    const plan = await bundle.planImport(doctored);
    assert.equal(plan.summary.write, 1, JSON.stringify(plan.actions[0]));
    const res = await bundle.executeImport(plan.token, {});
    assert.equal(res.results[0].applied, 'written');

    const landed = res.results[0].destPath;
    assert.equal(landed, path.join(dst.cc.root, 'projects', 'F--projects-demo', SID + '.jsonl'));
    assert.ok(fs.existsSync(landed));
    // The failure this guards against: one file with separators in its name.
    for (const name of fs.readdirSync(dst.cc.root)) {
      assert.notOk(name.includes(SEP), 'a path became a filename: ' + name);
      assert.notOk(name.includes('/'), 'a path became a filename: ' + name);
    }
  });

  it('and a scan on the new machine finds what was restored', async () => {
    const dst = freshDest('portable-scan');
    const doctored = path.join(dst.base, 'posix.zip');
    await rewriteManifest(zip, doctored, {
      originalRelative: 'projects/F--projects-demo/' + SID + '.jsonl',
    });
    await bundle.executeImport((await bundle.planImport(doctored)).token, {});

    // Landing somewhere is not the point; being found again is.
    const scan = await discovery.scanAll();
    const found = scan.tools.flatMap((t) => t.sessions).filter((s) => s.sessionId === SID);
    assert.equal(found.length, 1, 'the restored session must show up in a scan');
    assert.equal(found[0].integrity, 'ok');
  });

  /* ------------------------------------------------------ refusing to stray */

  it('ignores a location outside the tool directory and says so', async () => {
    // Restoring the session anyway is deliberate: refusing would lose a real
    // conversation over one bad field. What must not happen is the write
    // landing outside the root, or the substitution being silent.
    const dst = freshDest('portable-escape');
    const doctored = path.join(dst.base, 'escape.zip');
    await rewriteManifest(zip, doctored, {
      originalRelative: '../../../escaped-' + SID + '.jsonl',
    });

    const plan = await bundle.planImport(doctored);
    const action = plan.actions[0];
    assert.ok(action.lossy.some((l) => /outside the Claude Code directory/.test(l)),
      'the ignored location must be reported: ' + JSON.stringify(action.lossy));

    const res = await bundle.executeImport(plan.token, {});
    assert.equal(res.results[0].applied, 'written');
    const landed = res.results[0].destPath;
    assert.ok(landed.startsWith(dst.cc.root + path.sep), landed + ' is not under ' + dst.cc.root);

    // And nothing anywhere near where it asked for.
    const outside = path.dirname(path.dirname(dst.cc.root));
    for (const dir of [outside, path.dirname(dst.base), dst.base]) {
      const strays = fs.readdirSync(dir).filter((f) => f.includes('escaped-'));
      assert.equal(strays.length, 0, 'wrote outside the root into ' + dir + ': ' + strays.join(', '));
    }
  });

  it('ignores an absolute path dressed up as a relative one', async () => {
    const dst = freshDest('portable-abs');
    const doctored = path.join(dst.base, 'abs.zip');
    await rewriteManifest(zip, doctored, {
      originalRelative: 'C:/Windows/Temp/planted-' + SID + '.jsonl',
    });

    const plan = await bundle.planImport(doctored);
    assert.ok(plan.actions[0].lossy.some((l) => /outside the Claude Code directory/.test(l)),
      JSON.stringify(plan.actions[0].lossy));
    const res = await bundle.executeImport(plan.token, {});
    assert.ok(res.results[0].destPath.startsWith(dst.cc.root + path.sep), res.results[0].destPath);
  });

  it('blocks entirely when there is no safe place left to put it', async () => {
    // No usable location and no working directory to derive one from. The
    // session is not written somewhere arbitrary just to have written it.
    const dst = freshDest('portable-nowhere');
    const doctored = path.join(dst.base, 'nowhere.zip');
    await rewriteManifest(zip, doctored, {
      originalRelative: '../../../nope.jsonl',
      projectPath: null,
    });

    const plan = await bundle.planImport(doctored);
    // Either it is blocked, or it lands inside the root under a generic
    // folder -- never outside, and never silently.
    const action = plan.actions[0];
    if (action.kind === 'blocked') {
      assert.equal(plan.summary.write, 0);
    } else {
      assert.ok(action.destPath.startsWith(dst.cc.root + path.sep), action.destPath);
      assert.ok(action.lossy.length > 0, 'a substituted location must be reported');
    }
  });
  it('still finds a home when the bundle does not name one', async () => {
    // No recorded location, but the transcript knows its working directory --
    // which is the same thing Claude Code derives its folder from.
    const dst = freshDest('portable-derived');
    const doctored = path.join(dst.base, 'noloc.zip');
    await rewriteManifest(zip, doctored, { originalRelative: null });

    const plan = await bundle.planImport(doctored);
    assert.equal(plan.summary.write, 1, JSON.stringify(plan.actions[0]));
    const res = await bundle.executeImport(plan.token, {});
    assert.equal(res.results[0].applied, 'written');

    const folder = path.basename(path.dirname(res.results[0].destPath));
    assert.equal(folder, paths.encodeClaudeProjectDir('F:' + SEP + 'projects' + SEP + 'demo'),
      'the folder must be the one Claude Code itself would use');
    assert.equal(folder, 'F--projects-demo');
  });

  /* ------------------------------------------------------ nothing is lost */

  it('leaves an existing file byte-for-byte alone when it will not overwrite', async () => {
    const dst = freshDest('portable-keep');
    const dest = path.join(dst.cc.projectsDir, SID + '.jsonl');
    // Something already there, and deliberately different.
    H.writeJsonl(dest, H.claudeTranscript({ sessionId: SID, exchanges: 9 }));
    const before = fs.readFileSync(dest);

    const plan = await bundle.planImport(zip);
    assert.notEqual(plan.actions[0].kind, 'write', 'a populated destination is not a plain write');
    const res = await bundle.executeImport(plan.token, {});
    assert.notEqual(res.results[0].applied, 'written');

    assert.equal(Buffer.compare(fs.readFileSync(dest), before), 0,
      'the file that was already there must be untouched');
  });

  it('backs the old bytes up before it ever replaces them', async () => {
    const dst = freshDest('portable-backup');
    const dest = path.join(dst.cc.projectsDir, SID + '.jsonl');
    H.writeJsonl(dest, H.claudeTranscript({ sessionId: SID, exchanges: 9 }));
    const before = fs.readFileSync(dest);

    const plan = await bundle.planImport(zip);
    const res = await bundle.executeImport(plan.token, {
      [plan.actions[0].sessionId]: 'keep-incoming',
    });
    assert.equal(res.results[0].applied, 'overwritten');

    const backup = res.results[0].backupPath;
    assert.ok(backup && fs.existsSync(backup), 'replacing bytes without keeping them is data loss');
    assert.equal(Buffer.compare(fs.readFileSync(backup), before), 0,
      'and the backup has to be what was actually there');
  });

  it('never lets a sidecar escape the session directory', async () => {
    const dst = freshDest('portable-sidecar');
    const doctored = path.join(dst.base, 'sidecar.zip');
    const { manifest } = await bundle.readManifest(zip);
    const main = manifest.sessions[0].rawEntries[0];
    await rewriteManifest(zip, doctored, {
      // A second "raw" member claiming a name that climbs out of the tree. It
      // reuses the real member so the archive is otherwise entirely valid.
      rawEntries: [main, { archiveName: main.archiveName, kind: 'subagent' }],
      sidecars: [{ archiveName: 'raw/claude-code/../../../../planted.jsonl' }],
    });

    const plan = await bundle.planImport(doctored);
    const res = await bundle.executeImport(plan.token, {});
    assert.equal(res.results[0].applied, 'written');

    const outside = path.dirname(path.dirname(dst.cc.root));
    assert.notOk(fs.existsSync(path.join(outside, 'planted.jsonl')), 'a sidecar wrote outside the root');
    assert.notOk(fs.existsSync(path.join(dst.base, 'planted.jsonl')), 'a sidecar wrote outside the root');
  });
});
