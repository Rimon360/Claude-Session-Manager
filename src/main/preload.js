'use strict';
/**
 * The only bridge between the renderer and Node.
 *
 * Every capability is enumerated explicitly. The renderer gets no filesystem
 * access, no module loader and no way to reach ipcRenderer directly -- it can
 * call exactly the operations listed here and nothing else.
 */
const { contextBridge, ipcRenderer } = require('electron');

/**
 * Unwrap the { ok, data, error } envelope from main into a promise.
 *
 * contextBridge serializes thrown Errors across worlds and keeps only
 * `message` and `stack` -- a custom `err.code` set here arrives in the
 * renderer as undefined, so branching on it would silently never match. The
 * code therefore travels inside the message as a `[CODE] ` prefix, which the
 * renderer parses off with `apiError()` before displaying anything.
 */
async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res) throw new Error(`No response from ${channel}`);
  if (!res.ok) {
    const code = res.error?.code;
    const message = res.error?.message || 'Unknown error';
    throw new Error(code ? `[${code}] ${message}` : message);
  }
  return res.data;
}

const PROGRESS_CHANNELS = ['progress:scan', 'progress:export', 'progress:sync', 'progress:import', 'update:state'];

contextBridge.exposeInMainWorld('api', {
  scan: () => call('discovery:scan'),
  verifySession: (uid) => call('session:verify', uid),
  attributeAccounts: (tool) => call('accounts:attribute', tool),
  listAccounts: () => call('accounts:list'),
  accountHistory: (accountUuid) => call('accounts:history', accountUuid),
  setAccountLabel: (accountUuid, label) => call('accounts:setLabel', accountUuid, label),
  planAccountMigrate: (cliSessionIds, targetAccountUuid) => call('indexsync:planMigrate', cliSessionIds, targetAccountUuid),
  planAccountSyncAll: (accountUuids, cliSessionIds, allowTombstoned) =>
    call('indexsync:planSyncAll', accountUuids, cliSessionIds, allowTombstoned),
  scanBrokenRecords: (accountUuid) => call('repair:scan', accountUuid),
  planRecordRepair: (indexPaths, accountUuid) => call('repair:plan', indexPaths, accountUuid),
  executeRecordRepair: (token) => call('repair:execute', token),
  planAccountUnlink: (cliSessionIds, accountUuid) => call('indexsync:planUnlink', cliSessionIds, accountUuid),
  executeAccountSync: (token) => call('indexsync:execute', token),
  loadSession: (uid, options) => call('session:load', uid, options),

  exportBundle: (uids, options) => call('export:run', uids, options),
  pickBundle: () => call('import:pick'),
  planImport: (zipPath, options) => call('import:plan', zipPath, options),
  executeImport: (token, resolutions) => call('import:execute', token, resolutions),

  planSync: (tool, options) => call('sync:plan', tool, options),
  executeSync: (token, resolutions) => call('sync:execute', token, resolutions),


  exportMigration: (uids, options) => call('migration:export', uids, options),
  planMigrationImport: (zipPath, options) => call('migration:planImport', zipPath, options),

  /* Persisted preferences (pane and column sizing). */
  getSettings: () => call('settings:get'),
  patchSettings: (patch) => call('settings:patch', patch),

  /* Updates (GitHub Releases). The only network call this app makes. */
  updateState: () => call('update:state'),
  updateCheck: () => call('update:check'),
  updateDownload: () => call('update:download'),
  updateInstall: () => call('update:install'),
  updateSkip: (version) => call('update:skip', version),
  updateSettings: (patch) => call('update:settings', patch),

  /* Custom title bar. */
  windowAction: (action) => call('window:action', action),
  windowQuery: () => call('window:query'),
  onWindowState: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('window:state', listener);
    return () => ipcRenderer.removeListener('window:state', listener);
  },

  compare: (uidA, uidB) => call('merge:compare', uidA, uidB),
  readAudit: (limit) => call('audit:read', limit),
  appPaths: () => call('app:paths'),
  reveal: (target) => call('app:reveal', target),
  copyText: (text) => call('app:copyText', text),
  support: () => call('app:support'),
  openExternal: (url) => call('app:openExternal', url),

  /** Subscribe to progress events. Returns an unsubscribe function. */
  onProgress: (channel, handler) => {
    if (!PROGRESS_CHANNELS.includes(channel)) throw new Error(`unknown progress channel: ${channel}`);
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
