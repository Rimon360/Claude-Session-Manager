'use strict';
/**
 * Tool, account and session discovery.
 *
 * Sessions are found by walking the filesystem, never by reading an app's own
 * session index. Claude Desktop's index is read for account attribution and
 * titles only -- never to decide what exists on disk.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');
const claudeCode = require('./parsers/claude-code');
const claudeDesktop = require('./parsers/claude-desktop');
const accounts = require('./accounts');
const settings = require('./settings');

/**
 * Stable per-file identity for the UI.
 *
 * It must key off the FILE, not the session id. Session ids are not unique --
 * a resumed session can appear in several files -- and keying on the id
 * collapsed those into one entry, so selecting any of them selected all, and
 * exporting any of them exported the same file repeatedly.
 */
function makeUid(tool, accountId, filePath) {
  const h = crypto.createHash('sha1').update(String(filePath)).digest('hex').slice(0, 12);
  return `${tool}|${accountId}|${h}`;
}

/**
 * A transcript this small almost certainly lost its content: a real session
 * carries at least a metadata row and one exchange.
 */
const STUB_SIZE_BYTES = 2 * 1024;
/** Above this we avoid any whole-file operation on the UI path. */
const HUGE_SIZE_BYTES = 256 * 1024 * 1024;

function detectTools() {
  const tools = [];

  for (const { root, label } of paths.claudeCodeRoots()) {
    if (!paths.isDir(root)) continue;
    const projects = path.join(root, 'projects');
    tools.push({
      tool: 'claude-code',
      displayName: 'Claude Code',
      root,
      rootLabel: label,
      installed: true,
      hasSessions: paths.isDir(projects),
      accountId: readClaudeAccount(root),
      experimental: false,
    });
  }

  return tools;
}

/**
 * Claude Code identity lives in <root>/.claude.json (or ~/.claude.json for the
 * default root) under `oauthAccount`. We read only identity fields -- never
 * credentials, never tokens.
 */
function readClaudeAccount(root) {
  const candidates = [
    path.join(root, '.claude.json'),
    path.join(path.dirname(root), '.claude.json'),
  ];

  // Both files can exist and only one carries the signed-in identity:
  // `<root>/.claude.json` is machine-level state (machineID, userID, migration
  // flags) while `~/.claude.json` holds `oauthAccount`. Returning on the first
  // file that had *any* id meant reporting a machine id as the account.
  let fallback = null;
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { continue; } // an unreadable config only costs us a label

    const acct = j.oauthAccount;
    if (acct && (acct.accountUuid || acct.organizationUuid)) {
      const id = acct.accountUuid || acct.organizationUuid;
      return {
        id: 'claude:' + id,
        accountUuid: acct.accountUuid ?? null,
        organizationUuid: acct.organizationUuid ?? null,
        email: acct.emailAddress ?? null,
        label: acct.emailAddress || acct.organizationName || String(id).slice(0, 12),
        source: file,
      };
    }
    if (!fallback && j.userID) {
      fallback = {
        id: 'claude:' + j.userID,
        accountUuid: null,
        organizationUuid: null,
        email: null,
        label: 'machine profile',
        source: file,
      };
    }
  }
  if (fallback) return fallback;
  return { id: 'claude:' + path.basename(root), label: 'local profile (' + path.basename(root) + ')', email: null };
}

function classifySize(sizeBytes, integrity) {
  const warnings = [];
  if (integrity === 'damaged') warnings.push({ level: 'error', code: 'damaged', message: 'Unparseable lines detected. This session will not be used as a copy source until reviewed.' });
  if (integrity === 'unreadable') warnings.push({ level: 'error', code: 'unreadable', message: 'File could not be read.' });
  if (integrity === 'truncated') warnings.push({ level: 'warn', code: 'truncated', message: 'Final line is incomplete — the file may have been written while the tool was still running.' });
  if (integrity === 'empty') warnings.push({ level: 'error', code: 'empty', message: 'File is empty. Expected transcript content.' });
  if (sizeBytes > 0 && sizeBytes < STUB_SIZE_BYTES && integrity !== 'empty') {
    warnings.push({ level: 'warn', code: 'stub', message: `Only ${sizeBytes} bytes — unusually small for a real session; content may have been lost.` });
  }
  if (sizeBytes > HUGE_SIZE_BYTES) {
    warnings.push({ level: 'info', code: 'huge', message: `Very large (${formatBytes(sizeBytes)}). Full parsing is streamed and may take a while.` });
  }
  return warnings;
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return (n / 1024 ** 3).toFixed(2) + ' GB';
}

/**
 * List every session for one detected tool. Metadata only -- head/tail scans
 * rather than full parses, so a directory of 80MB transcripts still lists
 * quickly.
 */
/**
 * Claude Desktop's index, keyed by the CLI session id it points at.
 *
 * This is the best available source for which accounts know about a session. A
 * `~/.claude` folder mixes together the transcripts of every account that has
 * signed in, and only bridged sessions record an owner inside the file, so
 * without this index most sessions cannot be attributed at all.
 *
 * It does NOT prove exclusive ownership. The per-account folders overlap
 * heavily -- on the reference machine 94 of 97 indexed sessions are listed
 * under both accounts, byte-identical -- so a session is treated as claimed by
 * a SET of accounts, and a single owner is recorded only when exactly one
 * account claims it.
 *
 * Read for attribution and titles only -- never as the authority on what
 * exists: it can name sessions whose transcripts are gone, and miss
 * transcripts that are present.
 */
function loadDesktopIndex() {
  const byCliSession = new Map();
  const accounts = new Map();
  const entries = [];

  for (const { root } of paths.claudeDesktopRoots()) {
    const { entries: found } = claudeDesktop.readIndex(root);
    for (const e of found) {
      entries.push(e);
      if (e.kind !== 'session' || !e.cliSessionId) continue;

      // A session can be listed under MORE THAN ONE account. On the reference
      // machine 132 of 136 entries are byte-identical across two account
      // folders, so "first one wins" would attribute almost everything to
      // whichever directory happened to be read first. Record every account
      // that claims it and let the caller decide what to show.
      if (!byCliSession.has(e.cliSessionId)) {
        byCliSession.set(e.cliSessionId, {
          entry: e, accountUuids: new Set(), organizationUuids: new Set(), records: [],
        });
      }
      const slot = byCliSession.get(e.cliSessionId);
      slot.accountUuids.add(e.accountUuid);
      slot.organizationUuids.add(e.organizationUuid);
      // Where each account's record for this session actually lives. A session
      // listed by two accounts has two files, and both are worth being able to
      // open.
      slot.records.push({
        accountUuid: e.accountUuid,
        organizationUuid: e.organizationUuid,
        indexPath: e.indexPath,
      });
      // Prefer the most recently active copy for display fields.
      const prevAt = Date.parse(slot.entry.lastActivityAt ?? '') || 0;
      const thisAt = Date.parse(e.lastActivityAt ?? '') || 0;
      if (thisAt > prevAt) slot.entry = e;
    }
    for (const a of claudeDesktop.summarize(found)) {
      const prev = accounts.get(a.accountUuid);
      accounts.set(a.accountUuid, prev
        ? { ...prev, sessionCount: prev.sessionCount + a.sessionCount, deletedCount: prev.deletedCount + a.deletedCount }
        : a);
    }
  }
  return { byCliSession, accounts: [...accounts.values()], entries };
}

async function listSessions(toolEntry, options = {}) {
  const { onProgress, desktopIndex = null } = options;
  const accountId = toolEntry.accountId?.id ?? null;
  const sessions = [];

  if (toolEntry.tool === 'claude-code') {
    const found = claudeCode.listSessionFiles(toolEntry.root);
    // Sub-agent transcripts are attached to their parent rather than listed as
    // top-level sessions; there are thousands of them and they are not
    // independently resumable.
    const subByParent = new Map();
    for (const s of found.subagents) {
      if (!subByParent.has(s.parentSessionId)) subByParent.set(s.parentSessionId, []);
      subByParent.get(s.parentSessionId).push(s);
    }
    // Each session costs two small reads and a few stats, and they are
    // independent. Done one at a time that was the whole of the startup wait;
    // a bounded number at once keeps the disk busy without opening a hundred
    // handles at.
    let i = 0;
    const scanOne = async (f) => {
      try {
        const meta = await claudeCode.scanSessionMeta(f.filePath, accountId);
        meta.projectPathDecoded = paths.decodeClaudeProjectDir(f.projectDir);
        meta.projectDir = f.projectDir;
        meta.subAgentFiles = subByParent.get(meta.sessionId) || [];
        meta.subAgentCount = meta.subAgentFiles.length;
        meta.sidecars = claudeCode.findSidecars(toolEntry.root, meta.sessionId);
        meta.integrityScan = 'shallow';
        meta.warnings = classifySize(meta.sizeBytes, meta.integrity);
        meta.root = toolEntry.root;
        // The account that owns this session, where the transcript records it.
        // This is separate from `accountId`, which is only the config root.
        meta.ownerAccountUuid = meta.ownerAccountUuid ?? null;

        // Claude Desktop's index knows the owning account for far more
        // sessions than the transcripts do; prefer it, and take its title too.
        const slot = desktopIndex?.byCliSession.get(meta.sessionId) ?? null;
        if (slot) {
          const e = slot.entry;
          // Every account whose index lists this session. Usually one; on this
          // installation most sessions are listed under both.
          meta.indexedAccountUuids = [...slot.accountUuids];
          meta.indexedOrganizationUuids = [...slot.organizationUuids];
          meta.indexRecords = slot.records;
          // Only claim a single owner when exactly one account claims it.
          if (slot.accountUuids.size === 1) {
            meta.ownerAccountUuid = meta.indexedAccountUuids[0];
            meta.ownerOrganizationUuid = meta.indexedOrganizationUuids[0];
            meta.ownerSource = 'desktop-index';
          } else if (!meta.ownerAccountUuid) {
            meta.ownerSource = 'shared';
          }
          meta.title = meta.title || e.title;
          meta.branch = e.branch ?? null;
          meta.desktopSessionId = e.desktopSessionId;
          meta.isArchived = e.isArchived;
          if (!meta.projectPath && e.projectPath) meta.projectPath = e.projectPath;
        } else {
          meta.indexedAccountUuids = [];
          meta.indexRecords = [];
          if (meta.ownerAccountUuid) meta.ownerSource = 'transcript';
        }
        meta.uid = makeUid('claude-code', accountId, meta.filePath);
        sessions.push(meta);
      } catch (err) {
        sessions.push(errorEntry('claude-code', accountId, f.filePath, err, toolEntry.root));
      }
      // Every few files, not every file: the renderer only needs to see the
      // number move.
      if (onProgress && ++i % 5 === 0) {
        onProgress({ tool: 'claude-code', done: i, total: found.main.length });
      }
    };

    await mapLimited(found.main, SCAN_CONCURRENCY, scanOne);
    if (onProgress) onProgress({ tool: 'claude-code', done: found.main.length, total: found.main.length });
  }

  sessions.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return sessions;
}

function errorEntry(tool, accountId, filePath, err, root) {
  return {
    sourceTool: tool, accountId, sessionId: path.basename(String(filePath)), filePath, root,
    projectPath: null, model: null, title: null, createdAt: null, updatedAt: null,
    sizeBytes: 0, integrity: 'unreadable',
    uid: makeUid(tool, accountId, filePath),
    warnings: [{ level: 'error', code: 'scan-failed', message: `Could not scan: ${err.message}` }],
  };
}

/**
 * The accounts Claude Desktop knows about, each resolved to the organization
 * folder that actually holds its sidebar history.
 *
 * That resolution is what gates ever writing an index entry, so the signals
 * are gathered honestly: the signed-in config first, then account/organization
 * pairs recorded inside transcripts. The cheap pass over already-scanned
 * metadata usually answers it; a deep read happens only for accounts still
 * unresolved and stops as soon as they are.
 */
async function listDesktopAccounts(sessions, options = {}) {
  const { signal } = options;
  const roots = paths.claudeDesktopRoots({ extraRoots: options.extraRoots });

  // Two different questions, and conflating them is what made the app go on
  // naming an account the user had already switched away from: `~/.claude.json`
  // is the Claude Code CLI's account, while Claude Desktop records its own.
  // The Desktop answer wins here, because Desktop history is what this list is.
  const signedIn = accounts.readSignedInAccount();
  const desktop = accounts.readDesktopAccount(roots);

  // Names for accounts that were never signed in to the CLI, taken from the
  // configs Claude Desktop writes per agent-mode session. Stored, so they
  // outlive the folder they came from.
  const identities = accounts.harvestDesktopIdentities(roots);
  try { accounts.learnIdentities(identities); } catch { /* a name is not worth failing the list */ }
  const declaredOrgs = new Map(
    [...identities].filter(([, v]) => v.organizationUuid).map(([k, v]) => [k, v.organizationUuid]),
  );
  const saved = settings.load();

  // Every account uuid that has a folder, even an empty one.
  const folders = [];
  for (const { root, kind } of roots) {
    for (const f of claudeDesktop.listOrgFolders(root)) folders.push({ ...f, root, rootKind: kind });
  }
  const uuids = [...new Set(folders.map((f) => f.accountUuid))];
  if (!uuids.length) return [];

  // Free pass first: owner ids the shallow scan already read.
  const pairs = accounts.collectOwnerPairs(sessions);
  const unresolved = uuids.filter((u) => !pairs.has(u)
    && !declaredOrgs.has(u)
    && !(signedIn && signedIn.accountUuid === u));
  if (unresolved.length) {
    const files = (sessions || []).map((s) => s.filePath).filter(Boolean);
    const deep = await accounts.deepFindOwnerPairs(files, unresolved, { signal });
    for (const [k, v] of deep) pairs.set(k, v);
  }

  const out = [];
  for (const uuid of uuids) {
    const mine = folders.filter((f) => f.accountUuid === uuid);
    const root = mine[0].root;
    const history = claudeDesktop.pickHistoryOrg(uuid, mine, {
      signedIn, transcriptPairs: pairs, declaredOrgs,
    });
    const who = accounts.describeAccount(uuid, {
      signedIn, saved, currentAccountUuid: desktop ? desktop.accountUuid : null,
    });
    out.push({
      ...who,
      root,
      rootKind: mine[0].rootKind,
      // Where its history lives, and how confident we are about that.
      historyOrgUuid: history.organizationUuid,
      historyDir: history.dir,
      confidence: history.confidence,
      reason: history.reason,
      ambiguous: history.ambiguous,
      organizations: mine.map((f) => ({
        organizationUuid: f.organizationUuid,
        dir: f.dir,
        sessionCount: f.sessionCount,
        deletedCount: f.deletedCount,
        isHistory: f.organizationUuid === history.organizationUuid,
      })),
      sessionCount: mine.reduce((n, f) => n + f.sessionCount, 0),
      deletedCount: mine.reduce((n, f) => n + f.deletedCount, 0),
    });
  }
  // Signed-in account first, then the ones with the most history.
  out.sort((a, b) => (b.isCurrent - a.isCurrent) || (b.sessionCount - a.sessionCount));
  return out;
}

/** How many session files to read at once. Disk-bound, so more than a few
 *  cores' worth still helps, but an unbounded fan-out just thrashes. */
const SCAN_CONCURRENCY = 8;

/**
 * Run `fn` over every item, at most `limit` in flight.
 *
 * Order of completion is not order of input, which is fine here: the caller
 * sorts afterwards.
 */
async function mapLimited(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/** Full scan: every tool, every account, every session. */
async function scanAll(options = {}) {
  const tools = detectTools();
  const desktopIndex = loadDesktopIndex();
  const result = {
    scannedAt: new Date().toISOString(),
    tools: [],
    totals: { sessions: 0, bytes: 0, damaged: 0 },
  };
  for (const t of tools) {
    const sessions = t.hasSessions ? await listSessions(t, { ...options, desktopIndex }) : [];
    const bytes = sessions.reduce((a, s) => a + (s.sizeBytes || 0), 0);
    const damaged = sessions.filter((s) => s.integrity === 'damaged' || s.integrity === 'unreadable').length;

    // Accounts actually found inside the transcripts. One config folder can
    // hold sessions belonging to several accounts, so this is the real answer
    // to "how many accounts are here", not the single logged-in identity.
    // Count a session for every account that lists it, and separately track
    // how many are exclusive to one account -- that is the number that says
    // whether the accounts really hold different histories.
    const owners = new Map();
    for (const s of sessions) {
      const claiming = (s.indexedAccountUuids?.length ? s.indexedAccountUuids : (s.ownerAccountUuid ? [s.ownerAccountUuid] : []));
      for (const uuid of claiming) {
        if (!owners.has(uuid)) {
          owners.set(uuid, {
            accountUuid: uuid,
            sessionCount: 0,
            exclusiveCount: 0,
            bytes: 0,
            isCurrent: t.accountId?.accountUuid === uuid,
          });
        }
        const o = owners.get(uuid);
        o.sessionCount++;
        o.bytes += s.sizeBytes || 0;
        if (claiming.length === 1) o.exclusiveCount++;
      }
    }
    const ownerAccounts = [...owners.values()];
    const unattributed = sessions.filter(
      (s) => !s.ownerAccountUuid && !(s.indexedAccountUuids?.length)
    ).length;
    const sharedAcrossAccounts = sessions.filter((s) => (s.indexedAccountUuids?.length ?? 0) > 1).length;

    result.tools.push({
      ...t, sessionCount: sessions.length, bytes, damaged, sessions,
      ownerAccounts,
      unattributedSessions: unattributed,
      sharedAcrossAccounts,
      ownerScan: 'shallow',
      indexedAccounts: desktopIndex.accounts,
    });
    result.totals.sessions += sessions.length;
    result.totals.bytes += bytes;
    result.totals.damaged += damaged;
  }

  // Accounts are a property of the machine, not of one config folder, so they
  // sit on the scan rather than on a tool entry.
  const allSessions = result.tools.flatMap((t) => t.sessions);
  result.accounts = await listDesktopAccounts(allSessions, options);
  return result;
}

/**
 * Full-file integrity verification.
 *
 * The integrity flag carried by listSessions() comes from a head-only scan, so
 * it is fast but shallow: corruption at line 348 of a 3MB transcript will not
 * appear there. This streams the entire file and is the only integrity result
 * allowed to gate a destructive operation. The UI labels list-view integrity
 * as "not yet verified" until this has run.
 */
async function verifySession(entry) {
  const { readJsonl } = require('./jsonl');
  const file = entry.transcriptPath || entry.filePath;
  const report = await readJsonl(file, null);
  return {
    uid: entry.uid,
    filePath: file,
    integrity: report.integrity,
    integrityScan: 'deep',
    totalLines: report.totalLines,
    parsedRows: report.parsedRows,
    blankLines: report.blankLines,
    errorCount: report.errorCount,
    errors: report.errors,
    sizeBytes: report.sizeBytes,
    warnings: classifySize(report.sizeBytes ?? entry.sizeBytes ?? 0, report.integrity),
  };
}

/**
 * Find which account owns each Claude Code session, by reading the transcripts.
 *
 * Several accounts can share one `~/.claude` folder: switching login does not
 * move or partition the history, and the config file's single `oauthAccount`
 * only says who is logged in right now. Ownership lives on a `bridge-session`
 * row inside the transcript, so the only reliable way to find every account is
 * to look in the files.
 *
 * The listing pass reads just the head of each file, which finds most of them.
 * This streams every file and finds the rest. Lines are matched as raw text
 * first and only parsed when they contain the field, so this stays fast over
 * gigabytes.
 */
async function attributeAccounts(toolEntry, options = {}) {
  const { onProgress, signal } = options;
  const found = claudeCode.listSessionFiles(toolEntry.root);
  const sessions = [];
  const accounts = new Map();
  let done = 0;

  for (const f of found.main) {
    const owner = await scanFileForOwner(f.filePath, signal);
    if (owner.accountUuid) {
      if (!accounts.has(owner.accountUuid)) {
        accounts.set(owner.accountUuid, { accountUuid: owner.accountUuid, organizationUuid: owner.organizationUuid, sessionCount: 0, bytes: 0 });
      }
      const a = accounts.get(owner.accountUuid);
      a.sessionCount++;
      try { a.bytes += fs.statSync(f.filePath).size; } catch { /* size is cosmetic */ }
    }
    sessions.push({ filePath: f.filePath, ...owner });
    if (onProgress && ++done % 10 === 0) onProgress({ done, total: found.main.length });
  }

  return {
    supported: true,
    scannedFiles: found.main.length,
    attributed: sessions.filter((s) => s.accountUuid).length,
    unattributed: sessions.filter((s) => !s.accountUuid).length,
    accounts: [...accounts.values()],
    sessions,
  };
}

/** Stream one file looking only for the ownership row. */
function scanFileForOwner(filePath, signal) {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1 << 20 });
    let buffer = '';
    let result = { accountUuid: null, organizationUuid: null };
    const finish = () => { stream.destroy(); resolve(result); };

    stream.on('data', (chunk) => {
      buffer += chunk;
      // Cheap text test before any JSON work.
      if (buffer.indexOf('ownerAccountUuid') >= 0) {
        for (const line of buffer.split('\n')) {
          if (line.indexOf('ownerAccountUuid') < 0) continue;
          try {
            const o = JSON.parse(line);
            if (o.ownerAccountUuid) {
              result = { accountUuid: o.ownerAccountUuid, organizationUuid: o.ownerOrganizationUuid ?? null };
              finish();
              return;
            }
          } catch { /* a split line will be complete on the next chunk */ }
        }
      }
      // Keep only the tail, so memory stays bounded on huge files.
      const nl = buffer.lastIndexOf('\n');
      if (nl >= 0) buffer = buffer.slice(nl + 1);
      if (buffer.length > 4 * 1024 * 1024) buffer = '';
    });
    stream.on('error', () => resolve(result));
    stream.on('end', () => resolve(result));
    if (signal) signal.addEventListener('abort', finish, { once: true });
  });
}

/** Load one session fully into USS, dispatching on its source tool. */
async function loadSession(entry, options = {}) {
  if (entry.sourceTool === 'claude-code') return claudeCode.parseSession(entry.filePath, { accountId: entry.accountId, ...options });
  throw new Error(`unsupported source tool: ${entry.sourceTool}`);
}

module.exports = {
  listDesktopAccounts,
  detectTools, listSessions, scanAll, loadSession, verifySession, attributeAccounts, loadDesktopIndex, classifySize, formatBytes, makeUid,
  STUB_SIZE_BYTES, HUGE_SIZE_BYTES,
};
