'use strict';
/**
 * Persisted user preferences.
 *
 * Kept in the app's own data directory, never inside a tool's tree. Written
 * atomically so a crash mid-save cannot leave an unreadable settings file that
 * blocks the app on next launch -- and if one is unreadable anyway, we fall
 * back to defaults rather than refusing to start.
 */
const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const DEFAULTS = {
  /**
   * Update checking is a network call, and this app is otherwise entirely
   * offline. It is on by default because a data-safety tool with a known bug
   * is worse than one that phones GitHub for a version number -- but it is one
   * switch away from off, and nothing but the version check ever leaves the
   * machine.
   */
  updates: {
    checkOnLaunch: true,
    // The update arrives in the background so the only thing ever asked of
    // anyone is one click on Restart. Installing is still never automatic:
    // the binary is fetched, and it sits there until someone says so.
    autoDownload: true,
    channel: 'latest',     // 'latest' | 'beta'
    lastCheckedAt: null,
    skippedVersion: null,
  },

  /**
   * Pane and column sizing, so a layout survives a restart.
   * `columnWidths` is null until the user drags a column, at which point every
   * column is pinned in pixels (see the renderer for why).
   */
  layout: {
    sidebarWidth: 216,
    detailWidth: 320,
    columnWidths: null,
  },

  /**
   * Account identity. `known` is filled in from `oauthAccount` whenever an
   * account is seen signed in, so it can still be named after the user
   * switches away; `custom` is a name the user typed and always wins.
   * `desktopRoots` lets an unusual Claude Desktop install be pointed at when
   * none of the standard per-platform locations exist.
   */
  accounts: {
    known: {},
    custom: {},
    desktopRoots: [],
  },

  /**
   * Where the Support link points.
   *
   * Ko-fi's own widget is a remote script, which this app will not load: the
   * CSP forbids third-party scripts, and pulling one on every launch would
   * contact Ko-fi whether or not anyone clicked. The page it would render
   * links here anyway, so the link is all that is needed.
   *
   * Empty falls back to GitHub Sponsors for the owner in package.json, which
   * is what a fork gets until it sets its own.
   */
  support: {
    sponsorUrl: '',
    sponsorLabel: '',
    repoUrl: '',
  },
};

function deepMerge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function load() {
  const file = paths.settingsPath();
  if (!fs.existsSync(file)) return deepMerge(DEFAULTS, {});
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return deepMerge(DEFAULTS, parsed);
  } catch {
    // A corrupt settings file must not stop the app from opening.
    return deepMerge(DEFAULTS, {});
  }
}

function save(patch) {
  const merged = deepMerge(load(), patch);
  const file = paths.settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return merged;
}

module.exports = { load, save, DEFAULTS };
