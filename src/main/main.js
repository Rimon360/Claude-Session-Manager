'use strict';
/**
 * Electron main process.
 *
 * All filesystem and crypto work happens here. The renderer is UI only:
 * contextIsolation on, nodeIntegration off, and every capability reaches it
 * through the narrow, explicitly enumerated IPC surface in preload.js.
 */
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

const discovery = require('../core/discovery');
const accounts = require('../core/accounts');
const indexSync = require('../core/index-sync');
const repair = require('../core/repair');
const claudeDesktop = require('../core/parsers/claude-desktop');
const bundle = require('../core/bundle');
const sync = require('../core/sync');
const merge = require('../core/merge');
const audit = require('../core/audit');
const paths = require('../core/paths');
const pkg = require('../../package.json');
const safety = require('../core/safety');
const uss = require('../core/uss');

const { Updater } = require('./updater');
const settings = require('../core/settings');

let mainWindow = null;
/** Last scan, kept so the renderer can send back light-weight uids. */
let lastScan = null;

/**
 * Operations currently writing to disk.
 *
 * The updater consults this before quitting to install: individual writes are
 * atomic, but a restart part-way through a multi-session import would leave
 * some sessions applied and some not, with no chance to read the result.
 */
const inFlight = new Set();
let opSeq = 0;

async function tracked(label, fn) {
  const id = ++opSeq;
  inFlight.add(label + '#' + id);
  try {
    return await fn();
  } finally {
    inFlight.delete(label + '#' + id);
    if (updater) updater.set({}); // re-emit so the UI can re-enable Restart
  }
}

const updater = new Updater({
  isBusy: () => inFlight.size > 0,
  // Push the FULL state, not the raw internal one. The renderer opens its
  // dialog from whatever it last received, and the raw state carries no
  // `settings`, so anything reading a preference off it would crash.
  onChange: () => progress('update:state', updater.getState()),
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 640,
    backgroundColor: '#0f1115',
    title: 'AI Session Manager',
    // Frameless: the title bar is drawn by the renderer so the chrome matches
    // the app rather than the OS. Resizing and snapping still work -- Electron
    // keeps the hit-test border on a frameless resizable window.
    frame: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Show only once painted, so there is no flash of an unstyled title bar.
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Keep the renderer's maximize/restore glyph in sync with reality, including
  // changes made by double-click, Win+Up, or OS snapping.
  const sendWindowState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:state', {
        maximized: mainWindow.isMaximized(),
        fullScreen: mainWindow.isFullScreen(),
        focused: mainWindow.isFocused(),
      });
    }
  };
  for (const evt of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur']) {
    mainWindow.on(evt, sendWindowState);
  }
  mainWindow.webContents.on('did-finish-load', () => {
    sendWindowState();
    // Give the first scan the machine to itself, then check quietly.
    setTimeout(() => {
      if (settings.load().updates.checkOnLaunch) updater.check({ silent: true }).catch(() => {});
    }, 8000);
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // This app has no reason to navigate anywhere or open windows.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

/* --------------------------------------------------------------- helpers */

function progress(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

/** Resolve renderer-supplied uids back to full scan entries held in main. */
function entriesFromUids(uids) {
  if (!lastScan) throw new Error('No scan has been performed yet. Refresh the session list first.');
  const index = new Map();
  for (const t of lastScan.tools) for (const s of t.sessions) index.set(s.uid, s);
  const out = [];
  for (const uid of uids) {
    const e = index.get(uid);
    if (!e) throw new Error(`Session ${uid} is no longer in the current scan. Refresh and try again.`);
    out.push(e);
  }
  return out;
}

/** Wrap a handler so errors reach the renderer as data, never as a crash. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: { message: err.message, code: err.code ?? null, name: err.name ?? 'Error' } };
    }
  });
}

/* ------------------------------------------------------------ IPC surface */

handle('discovery:scan', async () => {
  // Remember whoever is signed in right now. This is the only way a second
  // account ever gets a name: sign into it once and it is known from then on,
  // without ever opening credential storage.
  try { accounts.learnSignedInAccount(); } catch { /* a label is not worth failing a scan */ }
  lastScan = await discovery.scanAll({
    onProgress: (p) => progress('progress:scan', p),
  });
  // The renderer never needs the heavy per-session sidecar arrays.
  return {
    scannedAt: lastScan.scannedAt,
    totals: lastScan.totals,
    appDataDir: paths.appDataDir(),
    // Accounts Claude Desktop knows, each resolved to the organization folder
    // that holds its sidebar history.
    accounts: lastScan.accounts ?? [],
    tools: lastScan.tools.map((t) => ({
      tool: t.tool,
      displayName: t.displayName,
      root: t.root,
      rootLabel: t.rootLabel,
      experimental: t.experimental,
      hasSessions: t.hasSessions,
      accountId: t.accountId,
      sessionCount: t.sessionCount,
      bytes: t.bytes,
      damaged: t.damaged,
      // Accounts read out of the transcripts. One config folder can hold
      // sessions from several accounts, so this is separate from accountId.
      ownerAccounts: t.ownerAccounts ?? [],
      unattributedSessions: t.unattributedSessions ?? 0,
      // Sessions listed under more than one account.
      sharedAcrossAccounts: t.sharedAcrossAccounts ?? 0,
      ownerScan: t.ownerScan ?? 'shallow',
      sessions: t.sessions.map((s) => ({
        uid: s.uid,
        sessionId: s.sessionId,
        sourceTool: s.sourceTool,
        accountId: s.accountId,
        filePath: s.filePath,
        projectPath: s.projectPath ?? s.projectPathDecoded ?? null,
        projectDir: s.projectDir ?? null,
        model: s.model,
        title: s.title,
        version: s.version ?? null,
        gitBranch: s.gitBranch ?? null,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        sizeBytes: s.sizeBytes,
        integrity: s.integrity,
        integrityScan: s.integrityScan ?? 'shallow',
        subAgentCount: s.subAgentCount ?? 0,
        ownerAccountUuid: s.ownerAccountUuid ?? null,
        ownerOrganizationUuid: s.ownerOrganizationUuid ?? null,
        // Claude Desktop's record(s) for this session, one per account that
        // lists it, so the detail panel can open either file.
        indexRecords: s.indexRecords ?? [],
        experimental: !!s.experimental,
        warnings: s.warnings ?? [],
      })),
    })),
  };
});

handle('accounts:list', async () => {
  // Remember whoever is signed in right now, so this account can still be
  // named after the user switches away from it.
  accounts.learnSignedInAccount();
  const sessions = lastScan ? lastScan.tools.flatMap((t) => t.sessions) : [];
  return discovery.listDesktopAccounts(sessions);
});

/**
 * One account's session history as Claude Desktop records it.
 *
 * These are index entries, not transcripts -- the same rows the Desktop
 * sidebar shows. Refused rather than guessed when the history folder could not
 * be identified, because a list built from the wrong folder would look
 * perfectly plausible and be entirely wrong.
 */
handle('accounts:history', async (accountUuid) => {
  if (!accountUuid) throw new Error('an account uuid is required');
  const sessions = lastScan ? lastScan.tools.flatMap((t) => t.sessions) : [];
  const list = await discovery.listDesktopAccounts(sessions);
  const account = list.find((a) => a.accountUuid === accountUuid);
  if (!account) throw new Error('No Claude Desktop folder exists for that account.');
  if (account.ambiguous || !account.historyDir) {
    const err = new Error(account.reason);
    err.code = 'HISTORY_ORG_UNRESOLVED';
    throw err;
  }
  const { entries, problems } = claudeDesktop.readIndex(account.root);
  return {
    account,
    problems,
    entries: entries.filter(
      (e) => e.kind === 'session'
        && e.accountUuid === accountUuid
        && e.organizationUuid === account.historyOrgUuid
    ),
  };
});

/**
 * Copying Claude Desktop history records between accounts.
 *
 * Both entry points are dry runs: they return a plan and a single-use token,
 * and write nothing. `indexsync:execute` is the only thing that writes, and it
 * refuses a token it was not given by one of these.
 */
/**
 * Index records that lost their transcript id, and what they probably point
 * at. Read-only; `repair:plan` and `repair:execute` are the write path.
 */
handle('repair:scan', async (accountUuid) =>
  repair.scanBroken({
    accountUuid: accountUuid ?? null,
    onProgress: (p) => progress('progress:scan', { tool: 'repair', ...p }),
  }));

handle('repair:plan', async (indexPaths, accountUuid) =>
  repair.planRepair({ indexPaths: indexPaths ?? null, accountUuid: accountUuid ?? null }));

handle('repair:execute', async (token) =>
  repair.executeRepair(token, { onProgress: (p) => progress('progress:sync', p) }));

handle('indexsync:planMigrate', async (cliSessionIds, targetAccountUuid) =>
  indexSync.planMigrate({
    cliSessionIds: cliSessionIds ?? [],
    targetAccountUuid,
    sessions: lastScan ? lastScan.tools.flatMap((t) => t.sessions) : [],
  }));

handle('indexsync:planSyncAll', async (accountUuids, cliSessionIds, allowTombstoned) =>
  indexSync.planSyncAll({
    accountUuids: accountUuids ?? null,
    cliSessionIds: cliSessionIds ?? null,
    // Only ever set for a pointed, one-session request from the comparison.
    allowTombstoned: allowTombstoned === true,
    sessions: lastScan ? lastScan.tools.flatMap((t) => t.sessions) : [],
  }));

handle('indexsync:planUnlink', async (cliSessionIds, accountUuid) =>
  indexSync.planUnlink({
    cliSessionIds: cliSessionIds ?? [],
    accountUuid,
    sessions: lastScan ? lastScan.tools.flatMap((t) => t.sessions) : [],
  }));

handle('indexsync:execute', async (token) =>
  indexSync.execute(token, { onProgress: (p) => progress('progress:sync', p) }));

handle('accounts:setLabel', async (accountUuid, label) =>
  ({ label: accounts.setAccountLabel(accountUuid, label) }));

handle('accounts:attribute', async (tool) => {
  const entry = discovery.detectTools().find((t) => t.tool === tool);
  if (!entry) throw new Error(`No ${tool} installation found.`);
  return discovery.attributeAccounts(entry, {
    onProgress: (p) => progress('progress:scan', { tool, ...p }),
  });
});

handle('session:verify', async (uid) => {
  const [entry] = entriesFromUids([uid]);
  return discovery.verifySession(entry);
});

handle('session:load', async (uid, options = {}) => {
  const [entry] = entriesFromUids([uid]);
  const { session } = await discovery.loadSession(entry, { includeRawRows: false });
  const limit = options.messageLimit ?? 400;
  return {
    sessionId: session.sessionId,
    sourceTool: session.sourceTool,
    projectPath: session.projectPath,
    model: session.model,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    contentHash: session.contentHash,
    summary: uss.summarize(session),
    meta: { ...session.meta, rawRows: undefined },
    totalMessages: session.messages.length,
    messages: session.messages.slice(0, limit).map((m) => ({
      role: m.role, type: m.type, toolName: m.toolName,
      text: typeof m.text === 'string' ? m.text.slice(0, 4000) : null,
      timestamp: m.timestamp,
    })),
    truncated: session.messages.length > limit,
  };
});

handle('export:run', async (uids, options = {}) => {
  const entries = entriesFromUids(uids);
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export session bundle',
    defaultPath: `ai-sessions-${new Date().toISOString().slice(0, 10)}.aism.zip`,
    filters: [{ name: 'AI Session Manager bundle', extensions: ['zip'] }],
  });
  if (canceled || !filePath) return { canceled: true };

  const result = await tracked('export', () => bundle.exportBundle(entries, filePath, {
    ...options,
    onProgress: (p) => progress('progress:export', p),
  }));
  return {
    canceled: false,
    path: filePath,
    bytes: result.bytes,
    entries: result.entries,
    sessionCount: result.manifest.sessions.length,
    warnings: result.manifest.warnings,
    sessions: result.manifest.sessions.map((s) => ({
      sessionId: s.sessionId, sourceTool: s.sourceTool, messageCount: s.messageCount,
      integrity: s.integrity, contentHash: s.contentHash, rawEntries: s.rawEntries.length,
    })),
  };
});

handle('import:pick', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Open session bundle',
    properties: ['openFile'],
    filters: [{ name: 'AI Session Manager bundle', extensions: ['zip'] }],
  });
  if (canceled || !filePaths?.length) return { canceled: true };
  return { canceled: false, path: filePaths[0] };
});

handle('import:plan', async (zipPath, options = {}) => bundle.planImport(zipPath, options));

handle('import:execute', async (token, resolutions) =>
  tracked('import', () => bundle.executeImport(token, resolutions)));

handle('sync:plan', async (tool, options = {}) =>
  sync.planSync(tool, { ...options, onProgress: (p) => progress('progress:sync', p) })
);

handle('sync:execute', async (token, resolutions) =>
  tracked('sync', () => sync.executeSync(token, resolutions)));

handle('migration:export', async (uids, options = {}) => {
  const entries = entriesFromUids(uids);
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Create migration bundle',
    defaultPath: `ai-sessions-migration-${new Date().toISOString().slice(0, 10)}.aism.zip`,
    filters: [{ name: 'AI Session Manager bundle', extensions: ['zip'] }],
  });
  if (canceled || !filePath) return { canceled: true };
  const res = await sync.planMigration(entries, filePath, options);
  return { canceled: false, ...res };
});

handle('migration:planImport', async (zipPath, options = {}) => sync.planMigrationImport(zipPath, options));

handle('audit:read', async (limit = 200) => audit.read(limit));

handle('app:paths', async () => ({
  appDataDir: paths.appDataDir(),
  backupsDir: paths.backupsDir(),
  auditLog: paths.auditLogPath(),
  home: paths.home(),
}));

/**
 * Put a path on the clipboard.
 *
 * The escape hatch for when revealing cannot work -- the folder was moved, the
 * shell refuses, the file sits somewhere this app will not open. Text only: no
 * filesystem access and nothing leaves the machine.
 */
/**
 * Where to send someone who wants to support the project.
 *
 * Derived from package.json so the links cannot drift from the repository the
 * updater already publishes to, with a settings override for a fork or a
 * different funding platform.
 */
function supportLinks() {
  const saved = settings.load().support ?? {};
  const owner = pkg.build?.publish?.[0]?.owner ?? pkg.author ?? null;
  const repoUrl = String(pkg.repository?.url ?? '')
    .replace(/^git\+/, '')
    .replace(/\.git$/, '') || null;
  // package.json `funding` is the standard place for this and travels with the
  // repository; settings only ever override it.
  const funding = pkg.funding?.url || null;
  const sponsorUrl = saved.sponsorUrl || funding
    || (owner ? `https://github.com/sponsors/${owner}` : null);
  let sponsorLabel = saved.sponsorLabel;
  if (!sponsorLabel) {
    let host = '';
    try { host = new URL(sponsorUrl).hostname.replace(/^www\./, ''); } catch { /* no label */ }
    sponsorLabel = host === 'ko-fi.com' ? 'Support me on Ko-fi'
      : host === 'github.com' ? 'Sponsor on GitHub'
        : 'Sponsor';
  }
  return {
    sponsorUrl,
    sponsorLabel,
    repoUrl: saved.repoUrl || repoUrl,
    issuesUrl: repoUrl ? repoUrl + '/issues' : null,
    // package.json, not app.getVersion(): the latter reports Electron's own
    // version when the app is not packaged, which reads as a wildly wrong
    // release number in a dialog people are asked to trust.
    version: pkg.version,
    license: pkg.license ?? null,
  };
}

handle('app:support', async () => supportLinks());

/**
 * Open a link in the user's browser.
 *
 * Restricted to https and to the handful of addresses this app itself
 * publishes -- never an arbitrary string from the renderer. Opening a browser
 * is the only thing here that leaves the machine, and it happens only when
 * someone clicks a link they can see.
 */
handle('app:openExternal', async (target) => {
  const links = supportLinks();
  const allowed = [links.sponsorUrl, links.repoUrl, links.issuesUrl].filter(Boolean);
  const url = String(target ?? '');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('That is not a link.'); }
  if (parsed.protocol !== 'https:') throw new Error('Only https links can be opened.');
  if (!allowed.includes(url)) throw new Error('Refusing to open a link this app does not publish.');
  await shell.openExternal(url);
  return { opened: url };
});

handle('app:copyText', async (text) => {
  const value = String(text ?? '');
  if (!value) throw new Error('Nothing to copy.');
  if (value.length > 4096) throw new Error('That is too long to copy.');
  clipboard.writeText(value);
  return { copied: value.length };
});

handle('app:reveal', async (target) => {
  // Only ever reveal paths inside directories this app itself manages or
  // scanned; never an arbitrary renderer-supplied path.
  const allowedRoots = [paths.appDataDir()];
  if (lastScan) for (const t of lastScan.tools) allowedRoots.push(t.root);
  // Claude Desktop's session index is read (and, on request, written) by this
  // app, so revealing a record inside it is as legitimate as a transcript.
  for (const { root } of paths.claudeDesktopRoots()) allowedRoots.push(root);
  const resolved = path.resolve(target);
  const permitted = allowedRoots.some((r) => resolved === path.resolve(r) || resolved.startsWith(path.resolve(r) + path.sep));
  if (!permitted) throw new Error('Refusing to reveal a path outside the scanned tool directories.');
  if (!fs.existsSync(resolved)) throw new Error('Path no longer exists.');
  shell.showItemInFolder(resolved);
  return { revealed: resolved };
});

/* ------------------------------------------------------------ settings */

handle('settings:get', async () => settings.load());
handle('settings:patch', async (patch) => settings.save(patch || {}));

/* ------------------------------------------------------------- updates */

handle('update:state', async () => updater.getState());
handle('update:check', async () => updater.check({ silent: false }));
handle('update:download', async () => updater.download());
handle('update:install', async () => updater.install());
handle('update:skip', async (version) => updater.skip(version));
handle('update:settings', async (patch) => updater.updateSettings(patch || {}));

/* Window controls for the custom title bar. */
handle('window:action', async (action) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
  switch (action) {
    case 'minimize': mainWindow.minimize(); break;
    case 'maximize': mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); break;
    case 'close': mainWindow.close(); break;
    default: throw new Error(`unknown window action: ${action}`);
  }
  return { maximized: mainWindow.isDestroyed() ? false : mainWindow.isMaximized() };
});

handle('window:query', async () => ({
  maximized: mainWindow ? mainWindow.isMaximized() : false,
  platform: process.platform,
}));

handle('merge:compare', async (uidA, uidB) => {
  const [a, b] = entriesFromUids([uidA, uidB]);
  const { session: sa } = await discovery.loadSession(a, { includeRawRows: false });
  const { session: sb } = await discovery.loadSession(b, { includeRawRows: false });
  const cmp = merge.compareSessions(sa, sb);
  return { comparison: cmp, recommendation: merge.recommend(cmp), diff: merge.diffPreview(sa, sb, cmp) };
});

module.exports = { createWindow };
