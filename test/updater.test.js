'use strict';
/**
 * Updater behaviour that can be tested without a packaged app.
 *
 * The parts that matter here are the guards, not the download: an update must
 * never install itself, never interrupt work in flight, and must degrade to a
 * clear explanation when it cannot run at all.
 */
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const { Updater, STATE, normalizeNotes, stripHtml, friendlyError } = require('../src/main/updater');
const settings = require('../src/core/settings');

describe('settings', () => {
  let dir;
  beforeAll(() => {
    dir = H.tmpDir('settings');
    process.env.AISM_DATA_OVERRIDE = dir;
    return { dir };
  });
  afterAll(() => { delete process.env.AISM_DATA_OVERRIDE; H.rmrf(dir); });

  it('returns defaults when nothing is saved', () => {
    const s = settings.load();
    assert.equal(s.updates.checkOnLaunch, true);
    // The update fetches itself so the only thing ever asked of anyone is one
    // click on Restart. Installing is the switch that stays off.
    assert.equal(s.updates.autoDownload, true, 'the update should arrive on its own');
    assert.equal(s.updates.channel, 'latest');
  });

  it('merges a patch without dropping the rest', () => {
    settings.save({ updates: { autoDownload: true } });
    const s = settings.load();
    assert.equal(s.updates.autoDownload, true);
    assert.equal(s.updates.checkOnLaunch, true, 'unrelated keys must survive');
  });

  it('writes atomically and leaves no temp file', () => {
    settings.save({ updates: { channel: 'beta' } });
    const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));
    assert.equal(leftovers.length, 0);
    assert.equal(settings.load().updates.channel, 'beta');
  });

  it('falls back to defaults rather than failing on a corrupt file', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), '{ this is not json');
    const s = settings.load();
    assert.equal(s.updates.checkOnLaunch, true, 'a broken settings file must not stop the app opening');
  });
});

describe('updater: guards', () => {
  let dir;
  beforeAll(() => {
    dir = H.tmpDir('updater');
    process.env.AISM_DATA_OVERRIDE = dir;
    return { dir };
  });
  afterAll(() => { delete process.env.AISM_DATA_OVERRIDE; H.rmrf(dir); });

  it('reports itself unsupported when running unpackaged', async () => {
    const u = new Updater({});
    assert.notOk(u.isSupported(), 'electron-updater cannot work from source');
    const s = await u.check();
    assert.equal(s.state, STATE.DISABLED);
    assert.includes(s.reason, 'installed builds only');
  });

  it('refuses to download when unsupported instead of throwing', async () => {
    const u = new Updater({});
    const s = await u.download();
    assert.equal(s.state, STATE.DISABLED);
  });

  it('refuses to install when nothing has been downloaded', () => {
    const u = new Updater({});
    let code = null;
    try { u.install(); } catch (e) { code = e.code; }
    assert.equal(code, 'UPDATE_NOT_READY');
  });

  it('REFUSES to install while an operation is in flight', () => {
    let busy = true;
    const u = new Updater({ isBusy: () => busy });
    u.set({ state: STATE.DOWNLOADED, version: '1.2.3' });

    let err = null;
    try { u.install(); } catch (e) { err = e; }
    assert.equal(err && err.code, 'UPDATE_BUSY',
      'restarting mid-import could leave a multi-session import half applied');
    assert.includes(err.message, 'still running');

    // Once the work finishes the same call is allowed through.
    busy = false;
    // isSupported() is false unpackaged, so quitAndInstall is never reached;
    // what matters is that the busy guard no longer rejects it.
    u.autoUpdater = { quitAndInstall() { /* not reached synchronously */ } };
    const res = u.install();
    assert.equal(res.installing, true);
    assert.equal(res.version, '1.2.3');
  });

  it('never enables silent install on the underlying updater', () => {
    // autoDownload / autoInstallOnAppQuit are the two settings that would let a
    // release land without the user asking. Both must stay off.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'updater.js'), 'utf8');
    assert.includes(src, 'autoUpdater.autoDownload = false');
    assert.includes(src, 'autoUpdater.autoInstallOnAppQuit = false');
    assert.notOk(/autoInstallOnAppQuit\s*=\s*true/.test(src));
  });

  it('reports the APP version, not the Electron version', () => {
    // app.getVersion() returns Electron's version when unpackaged, which would
    // both mislead the user and make any comparison against a release wrong.
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const u = new Updater({});
    assert.equal(u.getState().currentVersion, pkg.version);
  });

  it('emits a state that always carries settings', () => {
    // The renderer opens its dialog from the last pushed state. A push that
    // omitted `settings` crashed the dialog on open.
    let pushed = null;
    const u = new Updater({ onChange: () => { pushed = u.getState(); } });
    u.set({ state: STATE.AVAILABLE, version: '2.0.0' });
    assert.ok(pushed, 'onChange must fire');
    assert.ok(pushed.settings, 'every emitted state must carry settings');
    assert.equal(typeof pushed.settings.checkOnLaunch, 'boolean');
    assert.equal(typeof pushed.busy, 'boolean');
  });

  it('exposes settings and busy state together', () => {
    const u = new Updater({ isBusy: () => true });
    const s = u.getState();
    assert.equal(s.busy, true);
    assert.equal(typeof s.settings.checkOnLaunch, 'boolean');
    assert.equal(typeof s.settings.autoDownload, 'boolean');
  });

  it('only accepts known settings keys', () => {
    const u = new Updater({});
    u.updateSettings({ checkOnLaunch: false, channel: 'beta', evil: 'yes', autoDownload: 'not-a-bool' });
    const s = settings.load().updates;
    assert.equal(s.checkOnLaunch, false);
    assert.equal(s.channel, 'beta');
    assert.equal(s.evil, undefined, 'unknown keys must not be persisted');
    // The rule is that the rubbish is rejected, so the value is still whatever
    // the default is. Asserting a literal here would fail the day the default
    // changes, which says nothing about the filter that is under test.
    assert.equal(s.autoDownload, settings.DEFAULTS.updates.autoDownload,
      'a non-boolean must not be written through');
    assert.equal(typeof s.autoDownload, 'boolean');
  });

  it('downloads on its own, so the only thing asked of anyone is Restart', () => {
    // The update arrives in the background; installing still never happens
    // without a click. Those are two different switches and only one of them
    // is on.
    assert.equal(settings.DEFAULTS.updates.autoDownload, true, 'the update should fetch itself');
  });


  it('rejects an unknown channel', () => {
    const u = new Updater({});
    u.updateSettings({ channel: 'nightly' });
    assert.notEqual(settings.load().updates.channel, 'nightly');
  });

  it('records a skipped version', () => {
    const u = new Updater({});
    u.skip('9.9.9');
    assert.equal(settings.load().updates.skippedVersion, '9.9.9');
  });
});

describe('updater: release notes and errors', () => {
  it('strips HTML from GitHub release notes', () => {
    const html = '<h2>Fixes</h2><ul><li>One thing</li><li>Another</li></ul><p>Done &amp; dusted</p>';
    const out = normalizeNotes(html);
    assert.notOk(out.includes('<'), 'no markup may reach the UI');
    assert.includes(out, 'One thing');
    assert.includes(out, 'Done & dusted');
  });

  it('handles the array form of release notes', () => {
    const out = normalizeNotes([{ version: '1.1.0', note: '<p>First</p>' }, { version: '1.2.0', note: '<p>Second</p>' }]);
    assert.includes(out, 'First');
    assert.includes(out, 'Second');
    assert.includes(out, '1.2.0');
  });

  it('returns null for missing notes rather than "undefined"', () => {
    assert.equal(normalizeNotes(null), null);
    assert.equal(normalizeNotes(undefined), null);
  });

  it('caps very long notes', () => {
    const out = normalizeNotes('<p>' + 'x'.repeat(20000) + '</p>');
    assert.atMost(out.length, 4000);
  });

  it('turns network failures into something a person can act on', () => {
    assert.includes(friendlyError(new Error('getaddrinfo ENOTFOUND github.com')), 'Check your connection');
    assert.includes(friendlyError(new Error('HttpError: 404 Not Found')), 'No published releases');
    assert.includes(friendlyError(new Error('code signature verification failed')), 'signature check');
  });

  it('does not leak an unbounded raw error into the UI', () => {
    assert.atMost(friendlyError(new Error('z'.repeat(5000))).length, 300);
  });

  it('escapes nothing but removes tags, so notes stay readable', () => {
    assert.equal(stripHtml('<p>a</p><p>b</p>').replace(/\n+/g, '|'), 'a|b');
  });
});

describe('updater: packaging config', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

  it('publishes to GitHub Releases', () => {
    const p = pkg.build.publish[0];
    assert.equal(p.provider, 'github');
    assert.ok(p.owner && p.repo, `${p.owner}/${p.repo}`);
  });

  it('ships the app source but not the tests', () => {
    assert.ok(pkg.build.files.includes('src/**/*'));
    assert.ok(pkg.build.files.some((f) => f === '!test/**'));
  });

  it('keeps user data on uninstall', () => {
    // Backups and the audit log live in appData. An uninstaller that deletes
    // them would destroy the very thing this app exists to protect.
    assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false);
  });

  it('does not use a one-click installer', () => {
    assert.equal(pkg.build.nsis.oneClick, false, 'the user should see and control the install');
  });

  it('declares electron-updater as a runtime dependency', () => {
    assert.ok(pkg.dependencies['electron-updater'], 'must be a dependency, not devDependency, to ship');
    assert.ok(pkg.devDependencies['electron-builder']);
  });
});
