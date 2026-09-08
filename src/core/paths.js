'use strict';
/**
 * Platform-aware discovery of where each tool keeps its data.
 *
 * Everything here returns *candidate* locations only. Nothing in this module
 * asserts that a path is valid, populated, or trustworthy -- callers must stat
 * and parse for themselves. We deliberately never read a tool's own session
 * index to decide what exists on disk.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

function home() {
  return process.env.AISM_HOME_OVERRIDE || os.homedir();
}

/** App-managed storage: backups, audit log, settings. Never inside a tool's tree. */
function appDataDir() {
  if (process.env.AISM_DATA_OVERRIDE) return process.env.AISM_DATA_OVERRIDE;
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(home(), 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(home(), 'Library', 'Application Support')
        : process.env.XDG_DATA_HOME || path.join(home(), '.local', 'share');

  // The app was called AI Session Manager before it was called Claude
  // Session Manager. An install from then has its backups, audit log and
  // settings under the old name, and moving them is exactly the kind of
  // thing this app exists not to do to people -- so the old directory keeps
  // being used wherever one is already there. New installs get the new name.
  const current = path.join(base, 'claude-session-manager');
  const legacy = path.join(base, 'ai-session-manager');
  if (!exists(current) && exists(legacy)) return legacy;
  return current;
}

function backupsDir() { return path.join(appDataDir(), 'backups'); }
function auditLogPath() { return path.join(appDataDir(), 'audit.log.jsonl'); }
function settingsPath() { return path.join(appDataDir(), 'settings.json'); }

/**
 * Claude Code roots. CLAUDE_CONFIG_DIR may point elsewhere, and users
 * sometimes keep several profile dirs side by side; each distinct root is
 * surfaced as its own account rather than being merged.
 */
function claudeCodeRoots() {
  const roots = [];
  const seen = new Set();
  const add = (dir, label) => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    roots.push({ root: resolved, label });
  };

  if (process.env.CLAUDE_CONFIG_DIR) {
    const sep = process.platform === 'win32' ? ';' : ':';
    for (const part of process.env.CLAUDE_CONFIG_DIR.split(sep)) {
      if (part.trim()) add(part.trim(), 'CLAUDE_CONFIG_DIR');
    }
  }
  add(path.join(home(), '.claude'), 'default');
  return roots;
}

/**
 * Claude Desktop's per-account session index.
 *
 * Layout: <root>/claude-code-sessions/<accountUuid>/<organizationUuid>/
 *           local_<sessionId>.json   session metadata
 *           deleted_<sessionId>      tombstone holding a deletion timestamp
 *
 * This is the only place that names every account's sessions authoritatively.
 * The Store build is MSIX-packaged, which redirects Roaming AppData under
 * LocalCache, so `%APPDATA%\Claude` does not exist for it -- looking only
 * there finds nothing and makes it seem there is a single account.
 */
function claudeDesktopRoots(options = {}) {
  const roots = [];
  const seen = new Set();
  const add = (dir, kind) => {
    if (!dir) return;
    let resolved = path.resolve(dir);
    // MSIX redirection makes %APPDATA%\Claude and the package's
    // LocalCache\Roaming\Claude the SAME physical directory. Resolving to the
    // real path first stops the index being read -- and counted -- twice.
    try { resolved = fs.realpathSync.native(resolved); } catch { /* keep the literal path */ }
    const key = resolved.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (isDir(path.join(resolved, 'claude-code-sessions'))) roots.push({ root: resolved, kind });
  };

  // An explicit override always wins and is tried first, so an unusual install
  // -- a portable build, a relocated profile, a mounted backup -- can be
  // pointed at directly instead of being undiscoverable.
  for (const dir of explicitDesktopRoots(options.extraRoots)) add(dir, 'override');

  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home(), 'AppData', 'Local');
    const roaming = process.env.APPDATA || path.join(home(), 'AppData', 'Roaming');
    // MSIX / Microsoft Store build. The package name carries a publisher hash
    // that differs between channels, so it is matched by prefix rather than
    // hard-coded.
    for (const base of [path.join(local, 'Packages'), path.join(roaming, 'Packages')]) {
      let names;
      try { names = fs.readdirSync(base); } catch { continue; }
      for (const name of names) {
        if (!/^(Claude|Anthropic)/i.test(name)) continue;
        add(path.join(base, name, 'LocalCache', 'Roaming', 'Claude'), 'msix');
        add(path.join(base, name, 'LocalCache', 'Local', 'Claude'), 'msix');
      }
    }
    // Classic installer build.
    add(path.join(roaming, 'Claude'), 'installer');
    add(path.join(local, 'Claude'), 'installer');
  } else if (process.platform === 'darwin') {
    add(path.join(home(), 'Library', 'Application Support', 'Claude'), 'installer');
    // App Sandbox / Mac App Store build redirects Application Support into a
    // per-app container.
    for (const id of ['com.anthropic.claude', 'com.anthropic.claudefordesktop']) {
      add(path.join(home(), 'Library', 'Containers', id, 'Data', 'Library', 'Application Support', 'Claude'), 'container');
    }
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home(), '.config');
    add(path.join(xdg, 'Claude'), 'installer');
    // Flatpak and Snap both relocate the config directory.
    for (const id of ['com.anthropic.Claude', 'com.anthropic.claude']) {
      add(path.join(home(), '.var', 'app', id, 'config', 'Claude'), 'flatpak');
    }
    add(path.join(home(), 'snap', 'claude', 'current', '.config', 'Claude'), 'snap');
  }
  return roots;
}

/**
 * Override locations for the Desktop root.
 *
 * `AISM_CLAUDE_DESKTOP_ROOTS` accepts several paths separated by the platform
 * path delimiter. `extraRoots` is the same thing from saved settings, so the
 * app can offer a "choose folder" escape hatch without this module depending
 * on the settings module (which depends on this one).
 */
function explicitDesktopRoots(extraRoots) {
  const out = [];
  const env = process.env.AISM_CLAUDE_DESKTOP_ROOTS;
  if (env) for (const part of env.split(path.delimiter)) if (part.trim()) out.push(part.trim());
  if (Array.isArray(extraRoots)) for (const r of extraRoots) if (r && typeof r === 'string') out.push(r);
  return out;
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

const BACKSLASH = String.fromCharCode(92);

/**
 * Claude Code encodes the project working directory into a single directory
 * name. Decoding is inherently ambiguous -- the separator character is also a
 * legal path character -- so this is a best-effort reconstruction for display
 * only. The encoded original is always kept alongside it and is what we use
 * for any filesystem operation.
 */
/**
 * How long an encoded name may be before Claude Code shortens it.
 *
 * Nothing on the reference machine comes close -- its longest project folder
 * is 106 characters -- but a deep path passes it easily, and macOS paths start
 * from `/Users/<name>/` before the project even begins.
 */
const PROJECT_DIR_MAX = 200;

/**
 * Claude Code's project directory encoding.
 *
 * Every character that is not a letter or a digit becomes a dash, and runs are
 * NOT collapsed: `F:\\0. Mobile apps` -> `F--0--Mobile-apps`, and
 * `/Users/me/my-app` -> `-Users-me-my-app`. The rule is the same on every
 * platform, which is what lets a bundle from one machine land somewhere a scan
 * on another machine will still find it.
 *
 * Past 200 characters the name is cut to 200 and a hash of the ORIGINAL path
 * is appended -- the original, not the encoded form, which is easy to get
 * wrong. The hash is the classic `h * 31 + c` over UTF-16 units, kept in a
 * 32-bit signed int, then made positive and written in base 36.
 *
 * Two sources of truth, not memory: the short form matches 53 of the 60
 * working directories recorded on the reference machine (the other 7 point at
 * folders that no longer exist, so there is nothing to match), and the long
 * form is transcribed from the shipped `claude` binary, which carries it as
 *
 *   function k(e){return e.replace(/[^a-zA-Z0-9]/g,"-")}
 *   function rk(e){let n=k(e);if(n.length<=DL)return n;return`${n.slice(0,DL)}-${we(e)}`}
 *
 * The long form is therefore read, not observed: no directory on the reference
 * machine is long enough to have exercised it.
 */
function encodeClaudeProjectDir(projectPath) {
  const raw = String(projectPath || '');
  const encoded = raw.replace(/[^A-Za-z0-9]/g, '-');
  if (encoded.length <= PROJECT_DIR_MAX) return encoded;
  return encoded.slice(0, PROJECT_DIR_MAX) + '-' + claudePathHash(raw);
}

/** `h * 31 + c` in a 32-bit signed int, unsigned, base 36. */
function claudePathHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/**
 * A relative path from a bundle, made safe to join to a root.
 *
 * Two different jobs, both of which have to happen before the path is used.
 *
 * Portability: a bundle written on Windows can be opened on macOS and the
 * other way round, so separators are normalised rather than assumed. Left
 * alone, `projects\\foo\\bar.jsonl` on Linux is not a directory tree at all --
 * it is one file with backslashes in its name, dumped in the root.
 *
 * Safety: the value comes out of a file someone else may have written. A
 * `..` segment, a leading slash or a drive letter would put the write outside
 * the tool directory entirely. Those are refused rather than stripped, since
 * a bundle containing one is not a bundle this app produced.
 *
 * Returns null when nothing usable is left, and callers must treat that as
 * "no destination" rather than falling back to somewhere convenient.
 */
function safeRelativePath(rel) {
  if (typeof rel !== 'string' || !rel) return null;
  const parts = rel.replace(/\\/g, '/').split('/');
  const out = [];
  for (const raw of parts) {
    const p = raw.trim();
    if (!p || p === '.') continue;
    if (p === '..') return null;
    // A colon is never part of a Claude Code path segment, and on Windows it is
    // two separate problems: `C:` is a drive, and `file:stream` writes to an
    // alternate data stream that no directory listing shows.
    if (p.includes(':')) return null;
    out.push(p);
  }
  return out.length ? out.join(path.sep) : null;
}

function decodeClaudeProjectDir(name) {
  if (!name) return null;
  // Windows drive prefix: "F--1--Rimon-Labs" -> "F:\1. Rimon Labs"
  const winDrive = /^([A-Za-z])--(.*)$/.exec(name);
  if (winDrive) {
    const rest = winDrive[2].split('--').join(BACKSLASH).split('-').join(' ');
    return winDrive[1] + ':' + BACKSLASH + rest.trim();
  }
  if (name.startsWith('-')) return name.split('-').join('/');
  return name;
}

module.exports = {
  home, appDataDir, backupsDir, auditLogPath, settingsPath,
  claudeCodeRoots, claudeDesktopRoots, explicitDesktopRoots,
  exists, isDir, decodeClaudeProjectDir, encodeClaudeProjectDir, safeRelativePath, BACKSLASH,
};
