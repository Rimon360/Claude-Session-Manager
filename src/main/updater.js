'use strict';
/**
 * Auto-update against GitHub Releases.
 *
 * Rules, which follow from what this app is:
 *
 *  - Nothing installs itself. A release is downloaded only when asked (or when
 *    the user has opted into auto-download), and installing always needs an
 *    explicit click. This app's whole promise is that it does not do surprising
 *    things to a machine holding the user's only copy of their history.
 *  - An update never interrupts work. Quitting to install is refused while an
 *    export, import, sync or conversion is in flight. Individual writes are
 *    atomic, so a hard kill could not corrupt a file, but it could leave a
 *    multi-session import half applied with no chance to see the result.
 *  - Update checking is the app's only network call and can be switched off.
 *  - In development (unpackaged) every operation is a no-op with a clear
 *    reason, because electron-updater cannot work without an installed app.
 */
const { app } = require('electron');
const path = require('path');
const settings = require('../core/settings');
const audit = require('../core/audit');

const STATE = {
  IDLE: 'idle',
  CHECKING: 'checking',
  AVAILABLE: 'available',
  DOWNLOADING: 'downloading',
  DOWNLOADED: 'downloaded',
  UP_TO_DATE: 'up-to-date',
  DISABLED: 'disabled',
  ERROR: 'error',
};

class Updater {
  /**
   * @param {object} opts
   * @param {() => boolean} opts.isBusy      true while a write operation is running
   * @param {(state) => void} opts.onChange  called whenever the state changes
   */
  constructor(opts = {}) {
    this.isBusy = opts.isBusy || (() => false);
    this.onChange = opts.onChange || (() => {});
    this.state = {
      state: STATE.IDLE,
      currentVersion: appVersion(),
      version: null,
      releaseNotes: null,
      releaseName: null,
      releaseDate: null,
      percent: 0,
      bytesPerSecond: 0,
      transferred: 0,
      total: 0,
      error: null,
      supported: false,
      reason: null,
      lastCheckedAt: settings.load().updates.lastCheckedAt,
    };
    this.autoUpdater = null;
    this._wired = false;
  }

  /** electron-updater only works from an installed build. */
  isSupported() {
    if (process.env.AISM_FORCE_UPDATER === '1') return true;
    return !!(app && app.isPackaged);
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
    return this.state;
  }

  /** Lazily require electron-updater so an unpackaged run never loads it. */
  _updater() {
    if (this.autoUpdater) return this.autoUpdater;
    // eslint-disable-next-line global-require
    const { autoUpdater } = require('electron-updater');
    this.autoUpdater = autoUpdater;

    autoUpdater.autoDownload = false;          // we decide, explicitly
    autoUpdater.autoInstallOnAppQuit = false;  // never swap the binary behind the user
    autoUpdater.allowDowngrade = false;
    const cfg = settings.load().updates;
    autoUpdater.channel = cfg.channel === 'beta' ? 'beta' : 'latest';
    autoUpdater.allowPrerelease = cfg.channel === 'beta';

    // Running from source, electron-updater refuses to check at all unless it
    // is told to and given a feed. Used only by the update test harness.
    if (process.env.AISM_FORCE_UPDATER === '1' && !(app && app.isPackaged)) {
      autoUpdater.forceDevUpdateConfig = true;
      const publish = readPublishConfig();
      if (publish) autoUpdater.setFeedURL(publish);
    }

    if (!this._wired) {
      this._wired = true;
      autoUpdater.on('checking-for-update', () => this.set({ state: STATE.CHECKING, error: null }));

      autoUpdater.on('update-available', (info) => {
        this.set({
          state: STATE.AVAILABLE,
          version: info.version,
          releaseName: info.releaseName ?? null,
          releaseNotes: normalizeNotes(info.releaseNotes),
          releaseDate: info.releaseDate ?? null,
          error: null,
        });
        audit.append({ action: 'update-available', version: info.version, from: this.state.currentVersion });
        if (settings.load().updates.autoDownload) this.download().catch(() => {});
      });

      autoUpdater.on('update-not-available', () => this.set({ state: STATE.UP_TO_DATE, version: null, error: null }));

      autoUpdater.on('download-progress', (p) => this.set({
        state: STATE.DOWNLOADING,
        percent: Math.round(p.percent || 0),
        bytesPerSecond: p.bytesPerSecond || 0,
        transferred: p.transferred || 0,
        total: p.total || 0,
      }));

      autoUpdater.on('update-downloaded', (info) => {
        this.set({ state: STATE.DOWNLOADED, version: info.version, percent: 100 });
        audit.append({ action: 'update-downloaded', version: info.version });
      });

      autoUpdater.on('error', (err) => {
        this.set({ state: STATE.ERROR, error: friendlyError(err) });
        audit.append({ action: 'update-error', error: String(err && err.message).slice(0, 300) });
      });
    }
    return autoUpdater;
  }

  async check({ silent = false } = {}) {
    const cfg = settings.load().updates;
    if (!this.isSupported()) {
      return this.set({
        state: STATE.DISABLED,
        supported: false,
        reason: 'Updates apply to installed builds only. This is running from source.',
      });
    }
    if (silent && !cfg.checkOnLaunch) {
      return this.set({ state: STATE.DISABLED, supported: true, reason: 'Update checks are turned off.' });
    }
    this.set({ supported: true, reason: null, state: STATE.CHECKING, error: null });
    try {
      const res = await this._updater().checkForUpdates();
      settings.save({ updates: { lastCheckedAt: new Date().toISOString() } });
      this.set({ lastCheckedAt: settings.load().updates.lastCheckedAt });

      // checkForUpdates() can resolve without emitting any event -- notably
      // when electron-updater declines to run at all. Leaving the UI spinning
      // on "Checking…" forever is worse than saying nothing happened.
      if (this.state.state === STATE.CHECKING) {
        this.set(res && res.updateInfo
          ? { state: STATE.UP_TO_DATE }
          : { state: STATE.DISABLED, reason: 'The update service did not run. This usually means the app is not an installed build.' });
      }
    } catch (err) {
      this.set({ state: STATE.ERROR, error: friendlyError(err) });
    }
    return this.state;
  }

  async download() {
    if (!this.isSupported()) {
      return this.set({ state: STATE.DISABLED, reason: 'Updates apply to installed builds only.' });
    }
    if (this.state.state === STATE.DOWNLOADING) return this.state;
    try {
      this.set({ state: STATE.DOWNLOADING, percent: 0, error: null });
      await this._updater().downloadUpdate();
    } catch (err) {
      this.set({ state: STATE.ERROR, error: friendlyError(err) });
    }
    return this.state;
  }

  /**
   * Quit and install. Refused while work is in flight -- the user is told what
   * is running rather than having the window vanish underneath them.
   */
  install() {
    if (this.state.state !== STATE.DOWNLOADED) {
      const err = new Error('No downloaded update is ready to install.');
      err.code = 'UPDATE_NOT_READY';
      throw err;
    }
    if (this.isBusy()) {
      const err = new Error(
        'An operation is still running. Let it finish before restarting, so a partly applied ' +
        'import or sync is not left half done.'
      );
      err.code = 'UPDATE_BUSY';
      throw err;
    }
    audit.append({ action: 'update-install', version: this.state.version, from: this.state.currentVersion });
    // isSilent=false so the installer UI is visible; isForceRunAfter=true reopens the app.
    setImmediate(() => this._updater().quitAndInstall(false, true));
    return { installing: true, version: this.state.version };
  }

  skip(version) {
    settings.save({ updates: { skippedVersion: version } });
    return this.set({ state: STATE.IDLE, version: null });
  }

  getState() {
    const cfg = settings.load().updates;
    return {
      ...this.state,
      supported: this.isSupported(),
      settings: {
        checkOnLaunch: cfg.checkOnLaunch,
        autoDownload: cfg.autoDownload,
        channel: cfg.channel,
        skippedVersion: cfg.skippedVersion,
      },
      busy: this.isBusy(),
    };
  }

  updateSettings(patch) {
    const allowed = {};
    if (typeof patch.checkOnLaunch === 'boolean') allowed.checkOnLaunch = patch.checkOnLaunch;
    if (typeof patch.autoDownload === 'boolean') allowed.autoDownload = patch.autoDownload;
    if (patch.channel === 'latest' || patch.channel === 'beta') allowed.channel = patch.channel;
    settings.save({ updates: allowed });
    // Channel changes need the underlying updater reconfigured on next check.
    if (allowed.channel && this.autoUpdater) {
      this.autoUpdater.channel = allowed.channel === 'beta' ? 'beta' : 'latest';
      this.autoUpdater.allowPrerelease = allowed.channel === 'beta';
    }
    return this.getState();
  }
}

/** The GitHub publish target, read from package.json's electron-builder config. */
function readPublishConfig() {
  try {
    const pkg = require(path.join(__dirname, '..', '..', 'package.json'));
    const p = (pkg.build && pkg.build.publish && pkg.build.publish[0]) || null;
    if (p && p.provider === 'github' && p.owner && p.repo) {
      return { provider: 'github', owner: p.owner, repo: p.repo };
    }
  } catch { /* fall through */ }
  return null;
}

/**
 * The app's own version.
 *
 * `app.getVersion()` returns Electron's version when running unpackaged, which
 * would show the user "33.4.11" instead of the app version and make any
 * comparison against a release meaningless. Read package.json directly and
 * only trust app.getVersion() once packaged.
 */
function appVersion() {
  if (app && app.isPackaged && typeof app.getVersion === 'function') return app.getVersion();
  try {
    return require(path.join(__dirname, '..', '..', 'package.json')).version;
  } catch {
    return (app && typeof app.getVersion === 'function') ? app.getVersion() : '0.0.0';
  }
}

/** GitHub release notes arrive as HTML or as an array of releases. */
function normalizeNotes(notes) {
  if (!notes) return null;
  if (typeof notes === 'string') return stripHtml(notes).slice(0, 4000);
  if (Array.isArray(notes)) {
    return notes
      .map((n) => (n && n.note ? `${n.version ? n.version + '\n' : ''}${stripHtml(n.note)}` : ''))
      .filter(Boolean).join('\n\n').slice(0, 4000);
  }
  return null;
}

function stripHtml(s) {
  return String(s)
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function friendlyError(err) {
  const msg = String((err && err.message) || err || 'Unknown error');
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|network/i.test(msg)) {
    return 'Could not reach GitHub. Check your connection and try again.';
  }
  if (/404/.test(msg)) {
    return 'No published releases found for this repository yet.';
  }
  if (/signature|code sign/i.test(msg)) {
    return 'The downloaded update failed its signature check and was not installed.';
  }
  return msg.slice(0, 300);
}

module.exports = { Updater, STATE, normalizeNotes, stripHtml, friendlyError };
