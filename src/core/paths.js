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
  return path.join(base, 'ai-session-manager');
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
  exists, isDir, decodeClaudeProjectDir, BACKSLASH,
};
