'use strict';
/**
 * Claude Code transcript parser.
 *
 * Layout on disk (verified against a real installation):
 *   <root>/projects/<url-encoded-project-path>/<session-uuid>.jsonl   main transcript
 *   <root>/projects/<...>/<session-uuid>/subagents/workflows/<wf-id>/agent-<id>.jsonl
 *   <root>/projects/<...>/<session-uuid>/subagents/workflows/<wf-id>/journal.jsonl
 *   <root>/todos/<sessionId>-agent-<agentId>.json
 *   <root>/file-history/<sessionId>/
 *
 * Two things in this format will silently lose data if handled naively:
 *
 * 1. SPLIT TURNS. Claude Code 2.1+ may spread one assistant turn over several
 *    JSONL rows that all share the same `message.id`. Deduping by message id
 *    alone therefore discards real content. On the reference installation this
 *    is not an edge case: 2,309 rows across 25 sampled files share an id with
 *    an earlier row. We dedupe on (message id + normalized content block), so
 *    genuinely repeated blocks collapse and distinct blocks all survive.
 *
 * 2. UNKNOWN ROW TYPES. The observed vocabulary is far wider than the four
 *    types usually documented -- ai-title, mode, attachment, last-prompt,
 *    bridge-session, atis-latch, permission-mode, cost-state and others all
 *    appear. Anything we do not model is preserved verbatim in meta.rawRows so
 *    a round trip back into Claude Code loses nothing.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJsonl, readJsonlHead, readJsonlTail, INTEGRITY } = require('../jsonl');
const uss = require('../uss');

const MESSAGE_ROW_TYPES = new Set(['user', 'assistant']);

/**
 * Rows that record WHICH ACCOUNT a session belongs to.
 *
 * This is the only place account ownership appears. Several accounts can share
 * one `~/.claude` folder -- switching login does not move or partition the
 * transcripts -- so the config file's single `oauthAccount` says who is logged
 * in NOW, not who owns the history already on disk. Ownership has to be read
 * from the transcripts themselves.
 *
 * Only sessions that were bridged to Claude Desktop / claude.ai carry these
 * rows, so attribution is partial by nature: a session without one is not
 * "unowned", it simply never recorded an owner.
 */
const ACCOUNT_ROW_TYPES = new Set(['bridge-session', 'artifact-autoreact-ledger']);

/**
 * How many recent message ids the split-turn deduper remembers.
 *
 * The set has to be bounded. Retaining a key per content block for the whole
 * file costs memory proportional to the transcript, which is exactly what
 * breaks on the multi-gigabyte sessions this tool exists to protect. Split
 * turns are written as a run of adjacent rows sharing one message id, so a
 * short window covers them with room to spare; anything older simply is not
 * collapsed, which errs toward keeping data rather than dropping it.
 */
const DEDUPE_WINDOW_IDS = 64;

/** Short digest of a content block, so the dedupe set stores ~30 bytes not ~2KB. */
function blockFingerprint(block) {
  return crypto.createHash('sha1').update(uss.stableStringify(block)).digest('base64').slice(0, 16);
}

/** Rows that carry conversation-adjacent state we keep but do not treat as messages. */
const PRESERVED_ROW_TYPES = new Set([
  'custom-title', 'ai-title', 'mode', 'queue-operation', 'attachment', 'last-prompt',
  'bridge-session', 'atis-latch', 'system', 'file-history-snapshot', 'permission-mode',
  'cost-state', 'summary',
]);

function mapContentBlock(block, row) {
  const ts = row.timestamp ?? null;
  const base = {
    id: row.uuid ?? null,
    parentId: row.parentUuid ?? null,
    timestamp: ts,
  };

  switch (block.type) {
    case 'text':
      return uss.makeMessage({ ...base, role: row.message?.role === 'assistant' ? 'assistant' : 'user', type: 'text', text: block.text ?? null });
    case 'thinking':
      return uss.makeMessage({ ...base, role: 'assistant', type: 'thinking', text: block.thinking ?? block.text ?? null });
    case 'tool_use':
      return uss.makeMessage({
        ...base, role: 'assistant', type: 'tool_use',
        toolName: block.name ?? null,
        toolInput: block.input ?? null,
        text: null,
      });
    case 'tool_result': {
      // Tool results arrive on `user` rows; in USS they are their own role.
      const content = block.content;
      let text = null;
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content)) {
        text = content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n') || null;
      }
      return uss.makeMessage({
        ...base, role: 'tool', type: 'tool_result',
        toolName: block.name ?? null,
        toolOutput: content ?? null,
        text,
        toolInput: block.tool_use_id ? { tool_use_id: block.tool_use_id } : null,
      });
    }
    case 'image':
      return uss.makeMessage({
        ...base, role: row.message?.role === 'assistant' ? 'assistant' : 'user', type: 'text',
        text: '[image]',
        toolOutput: { imageSource: block.source?.type ?? 'unknown', mediaType: block.source?.media_type ?? null },
      });
    default:
      // Unmodelled block kind: keep it rather than drop it.
      return uss.makeMessage({
        ...base,
        role: row.message?.role === 'assistant' ? 'assistant' : 'user',
        type: 'text',
        text: null,
        toolName: block.type ?? 'unknown',
        toolOutput: block,
      });
  }
}

/**
 * Parse one Claude Code transcript into a USS session.
 *
 * options.includeRawRows - keep every non-message row for lossless round trip
 *                          (default true; discovery passes turn it off)
 */
async function parseSession(filePath, options = {}) {
  const { accountId = null, includeRawRows = true, signal, messageSink = null } = options;

  const session = uss.emptySession({ sourceTool: 'claude-code', accountId });
  const rawRows = [];
  // Bounded split-turn deduper: messageId -> set of block fingerprints,
  // holding only the most recent DEDUPE_WINDOW_IDS message ids.
  const seenByMessage = new Map();
  const rowTypeCounts = {};
  const models = new Map();
  let sawSidechain = false;
  let duplicateBlocksCollapsed = 0;
  let ownerAccountUuid = null;
  let ownerOrganizationUuid = null;

  const report = await readJsonl(filePath, (row) => {
    const type = row.type || 'unknown';
    rowTypeCounts[type] = (rowTypeCounts[type] || 0) + 1;

    if (!session.sessionId && row.sessionId) session.sessionId = row.sessionId;
    if (!session.projectPath && row.cwd) session.projectPath = row.cwd;
    if (row.isSidechain) sawSidechain = true;
    if (ACCOUNT_ROW_TYPES.has(type) || row.ownerAccountUuid) {
      if (row.ownerAccountUuid) ownerAccountUuid = row.ownerAccountUuid;
      if (row.ownerOrganizationUuid) ownerOrganizationUuid = row.ownerOrganizationUuid;
    }

    if (!MESSAGE_ROW_TYPES.has(type)) {
      if (includeRawRows && (PRESERVED_ROW_TYPES.has(type) || !MESSAGE_ROW_TYPES.has(type))) {
        rawRows.push(row);
      }
      return;
    }

    const message = row.message;
    if (!message) { rawRows.push(row); return; }
    if (message.model) models.set(message.model, (models.get(message.model) || 0) + 1);

    const messageId = message.id || row.uuid || `row-${rowTypeCounts[type]}`;
    let blocks;
    if (typeof message.content === 'string') {
      blocks = [{ type: 'text', text: message.content }];
    } else if (Array.isArray(message.content)) {
      blocks = message.content;
    } else if (message.content && typeof message.content === 'object') {
      blocks = [message.content];
    } else {
      blocks = [];
    }

    let seen = seenByMessage.get(messageId);
    if (!seen) {
      seen = new Set();
      seenByMessage.set(messageId, seen);
      // Evict the oldest id once the window is full (Map keeps insertion order).
      if (seenByMessage.size > DEDUPE_WINDOW_IDS) {
        seenByMessage.delete(seenByMessage.keys().next().value);
      }
    }

    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      // The dedupe key is the message id PLUS the block content. Keying on
      // the id alone would collapse a split turn down to its first fragment.
      const fp = blockFingerprint(block);
      if (seen.has(fp)) { duplicateBlocksCollapsed++; continue; }
      seen.add(fp);
      const mapped = mapContentBlock(block, row);
      // When a sink is supplied the message is handed off and dropped, so a
      // multi-gigabyte transcript never materializes as an array.
      if (messageSink) messageSink(mapped); else session.messages.push(mapped);
    }

    // `toolUseResult` carries structured tool output alongside the user row.
    if (row.toolUseResult !== undefined && includeRawRows && !messageSink) {
      const last = session.messages[session.messages.length - 1];
      if (last && last.type === 'tool_result' && last.toolOutput === null) {
        last.toolOutput = row.toolUseResult;
      }
    }
  }, { signal });

  // Pick the model that produced most of the turns.
  let topModel = null, topCount = -1;
  for (const [m, c] of models) {
    if (m === '<synthetic>') continue;
    if (c > topCount) { topModel = m; topCount = c; }
  }
  session.model = topModel;
  session.sessionId = session.sessionId || path.basename(filePath, '.jsonl');

  session.meta = {
    nativeFormat: 'claude-code-jsonl',
    sourceFile: filePath,
    ownerAccountUuid,
    ownerOrganizationUuid,
    rowTypeCounts,
    modelsSeen: Object.fromEntries(models),
    hasSidechain: sawSidechain,
    duplicateBlocksCollapsed,
    integrity: report.integrity,
    integrityReport: {
      integrity: report.integrity,
      totalLines: report.totalLines,
      parsedRows: report.parsedRows,
      errorCount: report.errorCount,
      errors: report.errors,
      sizeBytes: report.sizeBytes,
    },
    rawRows: includeRawRows ? rawRows : undefined,
  };

  uss.finalize(session);
  return { session, report };
}

/**
 * Fast metadata-only scan for the session list. Reads the head and the tail of
 * each file instead of the whole thing, so listing a project directory full of
 * 80MB transcripts stays responsive.
 */
async function scanSessionMeta(filePath, accountId) {
  const stat = fs.statSync(filePath);
  // 40 rather than 30: the bridge-session row that names the owning account
  // usually lands around line 12-15, and a slightly deeper head catches it
  // without turning the listing into a full read.
  const { rows: headRows, report } = await readJsonlHead(filePath, 40);
  const { rows: tailRows } = await readJsonlTail(filePath, 8);

  let sessionId = null, cwd = null, model = null, createdAt = null, updatedAt = null, version = null, gitBranch = null;

  // Titles live on their own rows under `customTitle` / `aiTitle`. A session
  // accumulates several as it is renamed, so the LAST one wins, and a title
  // the user set outranks one the model generated.
  let customTitle = null, aiTitle = null;
  let ownerAccountUuid = null, ownerOrganizationUuid = null;
  const takeOwner = (r) => {
    if (r.ownerAccountUuid) ownerAccountUuid = r.ownerAccountUuid;
    if (r.ownerOrganizationUuid) ownerOrganizationUuid = r.ownerOrganizationUuid;
  };
  const takeTitle = (r) => {
    if (r.type === 'custom-title' && r.customTitle) customTitle = r.customTitle;
    else if (r.type === 'ai-title' && r.aiTitle) aiTitle = r.aiTitle;
  };

  for (const r of headRows) {
    if (!sessionId && r.sessionId) sessionId = r.sessionId;
    if (!cwd && r.cwd) cwd = r.cwd;
    if (!createdAt && r.timestamp) createdAt = r.timestamp;
    if (!version && r.version) version = r.version;
    if (!gitBranch && r.gitBranch) gitBranch = r.gitBranch;
    if (!model && r.message?.model && r.message.model !== '<synthetic>') model = r.message.model;
    takeTitle(r);
    takeOwner(r);
  }
  for (const r of tailRows) {
    if (r.timestamp) updatedAt = r.timestamp;
    if (r.message?.model && r.message.model !== '<synthetic>') model = r.message.model;
    takeTitle(r);
    takeOwner(r);
  }
  const title = customTitle || aiTitle || null;

  return {
    sourceTool: 'claude-code',
    accountId,
    sessionId: sessionId || path.basename(filePath, '.jsonl'),
    filePath,
    projectPath: cwd,
    projectDir: path.basename(path.dirname(filePath)),
    model,
    title,
    version,
    gitBranch,
    createdAt,
    updatedAt: updatedAt || stat.mtime.toISOString(),
    sizeBytes: stat.size,
    mtime: stat.mtime.toISOString(),
    integrity: report.integrity,
    ownerAccountUuid,
    ownerOrganizationUuid,
    // Ownership is recorded on a row that is usually near the top but not
    // always -- on the reference machine two of twelve sat at line 731 and
    // 8326. A head scan therefore finds most, not all, and says so.
    ownerScan: 'shallow',
    // A head-only scan cannot count the whole file; this is an estimate the UI
    // labels as such, never presented as an exact count.
    approxRows: null,
  };
}

/** Locate every transcript under a Claude Code root, including sub-agent files. */
function listSessionFiles(root) {
  const projectsDir = path.join(root, 'projects');
  const out = { main: [], subagents: [] };
  if (!fs.existsSync(projectsDir)) return out;

  let projectDirs;
  try { projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { return out; }

  for (const pd of projectDirs) {
    if (!pd.isDirectory()) continue;
    const projectPath = path.join(projectsDir, pd.name);
    let entries;
    try { entries = fs.readdirSync(projectPath, { withFileTypes: true }); } catch { continue; }

    for (const e of entries) {
      const full = path.join(projectPath, e.name);
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        out.main.push({ filePath: full, projectDir: pd.name });
      } else if (e.isDirectory()) {
        // <session-uuid>/subagents/workflows/<wf>/agent-*.jsonl
        const wfRoot = path.join(full, 'subagents', 'workflows');
        if (!fs.existsSync(wfRoot)) continue;
        let wfs;
        try { wfs = fs.readdirSync(wfRoot, { withFileTypes: true }); } catch { continue; }
        for (const wf of wfs) {
          if (!wf.isDirectory()) continue;
          const wfPath = path.join(wfRoot, wf.name);
          let files;
          try { files = fs.readdirSync(wfPath); } catch { continue; }
          for (const f of files) {
            if (!f.endsWith('.jsonl')) continue;
            out.subagents.push({
              filePath: path.join(wfPath, f),
              projectDir: pd.name,
              parentSessionId: e.name,
              workflowId: wf.name,
              kind: f === 'journal.jsonl' ? 'journal' : 'agent',
            });
          }
        }
      }
    }
  }
  return out;
}

/** Sidecar files that belong to a session and travel with it in a bundle. */
function findSidecars(root, sessionId) {
  const sidecars = [];
  const todosDir = path.join(root, 'todos');
  if (fs.existsSync(todosDir)) {
    try {
      for (const f of fs.readdirSync(todosDir)) {
        if (f.startsWith(sessionId)) sidecars.push({ kind: 'todo', filePath: path.join(todosDir, f) });
      }
    } catch { /* unreadable todos dir is not fatal */ }
  }
  const fh = path.join(root, 'file-history', sessionId);
  if (fs.existsSync(fh)) sidecars.push({ kind: 'file-history', filePath: fh, isDirectory: true });
  return sidecars;
}

module.exports = { parseSession, scanSessionMeta, listSessionFiles, findSidecars, MESSAGE_ROW_TYPES, PRESERVED_ROW_TYPES };
