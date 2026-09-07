'use strict';
/**
 * Portable bundle export and import.
 *
 * Bundle layout:
 *   manifest.json                       schema version, timestamp, one entry per session
 *   raw/<tool>/<original-relative-path>  untouched copies of the original files
 *   normalized/<sessionId>.json          the Universal Session Schema version
 *
 * The two copies serve different jobs and both are needed. `raw/` is what goes
 * back into the tool it came from -- byte-for-byte, so a round trip is lossless
 * by construction rather than by the correctness of an exporter. `normalized/`
 * is what cross-tool conversion reads, where some loss is unavoidable.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { ZipWriter, readCentralDirectory, readEntryBuffer, extractEntryToFile } = require('./zipstream');
const discovery = require('./discovery');
const uss = require('./uss');
const merge = require('./merge');
const safety = require('./safety');
const audit = require('./audit');
const { readJsonl } = require('./jsonl');

const BUNDLE_SCHEMA_VERSION = 1;
const MANIFEST_NAME = 'manifest.json';

/**
 * Above this size a session is exported in streaming mode: messages are hashed
 * and written straight to disk as they are parsed, never accumulated into an
 * array. Real transcripts reach 1-2GB, where holding the
 * parsed message objects in memory would exhaust the heap.
 */
const LARGE_SESSION_BYTES = 64 * 1024 * 1024;

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('error', reject);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve('sha256:' + h.digest('hex')));
  });
}

/** Keep archive member names portable and free of traversal. */
function safeArchiveName(...parts) {
  return parts
    .join('/')
    .replace(/\\/g, '/')
    .replace(/^[A-Za-z]:/, '')
    .split('/')
    .filter((p) => p && p !== '.' && p !== '..')
    .join('/');
}

/* ----------------------------------------------------------------- Export */

/**
 * Export selected sessions to a bundle.
 *
 * Each session is fully parsed (streamed) so the manifest can carry a real
 * content hash and message count rather than an estimate. Damaged sessions are
 * recorded in the manifest with their integrity report and are NOT silently
 * included as if healthy.
 */
async function exportBundle(entries, destZipPath, options = {}) {
  const { onProgress, includeRaw = true, includeSubAgents = true, note = null } = options;

  const writer = new ZipWriter(destZipPath);
  await writer.open();

  const manifest = {
    bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
    ussSchemaVersion: uss.SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    exportedBy: 'ai-session-manager',
    platform: process.platform,
    note,
    sessions: [],
    warnings: [],
  };

  let done = 0;
  for (const entry of entries) {
    const record = {
      sessionId: entry.sessionId,
      sourceTool: entry.sourceTool,
      accountId: entry.accountId ?? null,
      accountLabel: entry.accountLabel ?? null,
      projectPath: entry.projectPath ?? entry.projectPathDecoded ?? null,
      model: entry.model ?? null,
      title: entry.title ?? null,
      originalPath: entry.filePath,
      originalRelative: null,
      rawEntries: [],
      normalizedEntry: null,
      contentHash: null,
      messageCount: 0,
      sizeBytes: entry.sizeBytes ?? 0,
      createdAt: entry.createdAt ?? null,
      updatedAt: entry.updatedAt ?? null,
      integrity: 'unknown',
      integrityReport: null,
      sidecars: [],
    };

    try {
      const streaming = (entry.sizeBytes ?? 0) > LARGE_SESSION_BYTES;
      const normName = safeArchiveName('normalized', `${entry.sourceTool}__${entry.sessionId}.json`);

      if (streaming) {
        const streamed = await exportSessionStreaming(entry, writer, normName);
        Object.assign(record, streamed.record);
        record.streamed = true;
        if (streamed.warning) manifest.warnings.push(streamed.warning);
      } else {
        const { session, report } = await discovery.loadSession(entry, { includeRawRows: true });
        record.contentHash = session.contentHash;
        record.messageCount = session.messages.length;
        record.integrity = report.integrity;
        record.integrityReport = session.meta?.integrityReport ?? null;
        record.projectPath = record.projectPath ?? session.projectPath;
        record.model = record.model ?? session.model;
        record.createdAt = record.createdAt ?? session.createdAt;
        record.updatedAt = record.updatedAt ?? session.updatedAt;

        if (report.integrity === 'damaged' || report.integrity === 'unreadable') {
          manifest.warnings.push({
            sessionId: entry.sessionId,
            level: 'error',
            message:
              `Session ${entry.sessionId} is ${report.integrity} (${report.errorCount} unparseable line(s)). ` +
              'Its raw file is included so nothing is lost, but it is flagged and will not be offered as a conversion source.',
          });
        }

        await writer.addBuffer(normName, JSON.stringify(session, null, 1));
      }
      record.normalizedEntry = normName;

      if (includeRaw) {
        // raw/<tool>/<original file name>
        const rel = path.relative(entry.root || path.dirname(entry.filePath), entry.filePath);
        const name = safeArchiveName('raw', entry.sourceTool, rel);
        await writer.addFile(name, entry.filePath);
        record.rawEntries.push({ archiveName: name, originalPath: entry.filePath, sha256: await sha256File(entry.filePath), sizeBytes: fs.statSync(entry.filePath).size });
        record.originalRelative = rel.split(path.sep).join('/');

        // Claude Code sub-agent transcripts and sidecars travel with the session.
        if (entry.sourceTool === 'claude-code') {
          if (includeSubAgents) {
            for (const sub of entry.subAgentFiles || []) {
              if (!fs.existsSync(sub.filePath)) continue;
              const rel = path.relative(entry.root, sub.filePath);
              const name = safeArchiveName('raw', 'claude-code', rel);
              await writer.addFile(name, sub.filePath);
              record.rawEntries.push({ archiveName: name, originalPath: sub.filePath, kind: 'subagent', sizeBytes: fs.statSync(sub.filePath).size });
            }
          }
          for (const sc of entry.sidecars || []) {
            if (sc.isDirectory) {
              await addDirToZip(writer, sc.filePath, entry.root, record);
            } else if (fs.existsSync(sc.filePath)) {
              const rel = path.relative(entry.root, sc.filePath);
              const name = safeArchiveName('raw', 'claude-code', rel);
              await writer.addFile(name, sc.filePath);
              record.sidecars.push({ archiveName: name, kind: sc.kind, originalPath: sc.filePath });
            }
          }
        }
      }
    } catch (err) {
      record.integrity = 'unreadable';
      manifest.warnings.push({ sessionId: entry.sessionId, level: 'error', message: `Export failed for this session: ${err.message}` });
    }

    manifest.sessions.push(record);
    if (onProgress) onProgress({ done: ++done, total: entries.length, sessionId: entry.sessionId });
  }

  await writer.addBuffer(MANIFEST_NAME, JSON.stringify(manifest, null, 2));
  const result = await writer.close();

  audit.append({
    action: 'export',
    destination: destZipPath,
    sessionCount: manifest.sessions.length,
    bytes: result.bytes,
    warnings: manifest.warnings.length,
  });

  return { ...result, manifest };
}

/**
 * Export one very large session without ever holding its messages in memory.
 *
 * Messages are hashed incrementally and appended to a temporary NDJSON file as
 * they are parsed. The normalized JSON is then assembled by streaming that
 * temp file into place -- so peak memory is one message, not one transcript.
 */
async function exportSessionStreaming(entry, writer, normName) {
  const tmpBase = path.join(require('os').tmpdir(), 'aism-stream-' + process.pid + '-' + Date.now());
  const msgsPath = tmpBase + '.ndjson';
  const normPath = tmpBase + '.json';

  const hasher = uss.createContentHasher();

  // Synchronous buffered writes rather than a stream.
  //
  // The sink is called from inside the JSONL read loop, which is synchronous.
  // Chaining a promise per message there builds a chain as long as the
  // transcript -- hundreds of thousands of retained closures on a large file,
  // which is its own memory leak. Buffering into a fixed-size array and
  // flushing with writeSync keeps peak memory at one flush buffer.
  const FLUSH_BYTES = 4 * 1024 * 1024;
  const fd = fs.openSync(msgsPath, 'w');
  let buf = [];
  let bufBytes = 0;
  let count = 0;

  const flush = () => {
    if (!buf.length) return;
    fs.writeSync(fd, buf.join(''));
    buf = [];
    bufBytes = 0;
  };

  const sink = (m) => {
    hasher.update(m);
    const line = (count++ ? ',\n' : '') + JSON.stringify(m);
    buf.push(line);
    bufBytes += line.length;
    if (bufBytes >= FLUSH_BYTES) flush();
  };

  try {
    const { session, report } = await discovery.loadSession(entry, { includeRawRows: false, messageSink: sink });
    flush();
    fs.closeSync(fd);

    const contentHash = hasher.digest();
    const header = {
      schemaVersion: uss.SCHEMA_VERSION,
      sourceTool: session.sourceTool,
      sessionId: session.sessionId,
      accountId: session.accountId ?? null,
      projectPath: session.projectPath ?? null,
      model: session.model ?? null,
      createdAt: session.createdAt ?? null,
      updatedAt: session.updatedAt ?? null,
      contentHash,
      meta: { ...session.meta, rawRows: undefined, streamedExport: true },
    };

    // Assemble the normalized file: header fields, then the messages array
    // piped in from the temp file, then the closing brace.
    const out = fs.createWriteStream(normPath);
    const headerJson = JSON.stringify(header);
    out.write(headerJson.slice(0, -1) + ',"messages":[\n');
    await new Promise((res, rej) => {
      const rs = fs.createReadStream(msgsPath);
      rs.on('error', rej);
      rs.on('end', res);
      rs.pipe(out, { end: false });
    });
    await new Promise((res, rej) => out.end('\n]}\n', (err) => (err ? rej(err) : res())));

    await writer.addFile(normName, normPath);

    const warning =
      report.integrity === 'damaged' || report.integrity === 'unreadable'
        ? {
            sessionId: entry.sessionId,
            level: 'error',
            message:
              `Session ${entry.sessionId} is ${report.integrity} (${report.errorCount} unparseable line(s)). ` +
              'Its raw file is included so nothing is lost, but it is flagged and will not be offered as a conversion source.',
          }
        : null;

    return {
      warning,
      record: {
        contentHash,
        messageCount: count,
        integrity: report.integrity,
        integrityReport: session.meta?.integrityReport ?? null,
        projectPath: session.projectPath ?? null,
        model: session.model ?? null,
        createdAt: session.createdAt ?? null,
        updatedAt: session.updatedAt ?? null,
      },
    };
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed on the success path */ }
    for (const p of [msgsPath, normPath]) {
      try { if (fs.existsSync(p)) await fsp.unlink(p); } catch { /* temp cleanup is best effort */ }
    }
  }
}

async function addDirToZip(writer, dir, root, record) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await addDirToZip(writer, full, root, record);
    else if (e.isFile()) {
      const rel = path.relative(root, full);
      const name = safeArchiveName('raw', 'claude-code', rel);
      await writer.addFile(name, full);
      record.sidecars.push({ archiveName: name, kind: 'file-history', originalPath: full });
    }
  }
}

/* ----------------------------------------------------------------- Import */

/** Read and validate a bundle's manifest without writing anything. */
async function readManifest(zipPath) {
  const entries = await readCentralDirectory(zipPath);
  const manEntry = entries.find((e) => e.name === MANIFEST_NAME);
  if (!manEntry) throw new Error(`${path.basename(zipPath)} has no ${MANIFEST_NAME}; it is not an AI Session Manager bundle.`);
  const buf = await readEntryBuffer(zipPath, manEntry);
  let manifest;
  try { manifest = JSON.parse(buf.toString('utf8')); } catch (err) { throw new Error(`manifest.json is not valid JSON: ${err.message}`); }
  if (manifest.bundleSchemaVersion > BUNDLE_SCHEMA_VERSION) {
    throw new Error(`This bundle uses format version ${manifest.bundleSchemaVersion}; this app understands up to ${BUNDLE_SCHEMA_VERSION}. Update the app before importing.`);
  }
  return { manifest, entries };
}

/**
 * Build an import plan. This is a pure dry run: it reads the bundle, compares
 * every session against what is already on disk, and returns the exact set of
 * actions with no filesystem mutation. Executing requires handing back the
 * plan token this returns.
 */
async function planImport(zipPath, options = {}) {
  const { targetTool = null, accountRemap = null } = options;
  const { manifest, entries } = await readManifest(zipPath);

  const scan = await discovery.scanAll();

  // Session ids are NOT unique. One session id can appear in several
  // rollout files when a session is resumed or forked, so an id maps to a
  // LIST of candidates. Treating it as a single value made a re-import of an
  // untouched session look like a divergence against a sibling rollout.
  const existingById = new Map();
  const existingBySize = new Map();
  for (const t of scan.tools) {
    for (const s of t.sessions) {
      const idKey = `${s.sourceTool}|${s.sessionId}`;
      if (!existingById.has(idKey)) existingById.set(idKey, []);
      existingById.get(idKey).push(s);

      const sizeKey = `${s.sourceTool}|${s.sizeBytes}`;
      if (!existingBySize.has(sizeKey)) existingBySize.set(sizeKey, []);
      existingBySize.get(sizeKey).push(s);
    }
  }

  const actions = [];
  for (let recIndex = 0; recIndex < manifest.sessions.length; recIndex++) {
    const rec = manifest.sessions[recIndex];
    const destTool = targetTool || rec.sourceTool;
    const action = {
      // Position in manifest.sessions. This is the ONLY safe way to get back
      // to the right record: session ids are not unique (one id can span
      // id across rollout files), so keying a lookup by id would hand one
      // session another session's bytes.
      manifestIndex: recIndex,
      sessionId: rec.sessionId,
      sourceTool: rec.sourceTool,
      destTool,
      title: rec.title,
      projectPath: rec.projectPath,
      messageCount: rec.messageCount,
      contentHash: rec.contentHash,
      sizeBytes: rec.rawEntries?.reduce((a, r) => a + (r.sizeBytes || 0), 0) ?? rec.sizeBytes,
      integrity: rec.integrity,
      kind: null,           // write | skip-identical | conflict | blocked
      reason: null,
      destPath: null,
      existing: null,
      comparison: null,
      recommendation: null,
      lossy: [],
      isConversion: destTool !== rec.sourceTool,
    };

    if (rec.integrity === 'damaged' || rec.integrity === 'unreadable') {
      action.kind = 'blocked';
      action.reason = `Source session is ${rec.integrity}; importing it could write partial content. Review it before importing.`;
      actions.push(action);
      continue;
    }

    const target = resolveDestination(rec, destTool, scan, accountRemap);
    action.destPath = target.destPath;
    action.destRoot = target.root;
    if (!target.root) {
      action.kind = 'blocked';
      action.reason = `No ${destTool} installation found to import into.`;
      actions.push(action);
      continue;
    }

    // Fastest exact test: the destination file is byte-for-byte what the
    // bundle holds. No parsing needed, and it cannot produce a false match.
    const rawSha = rec.rawEntries?.[0]?.sha256 ?? null;
    if (rawSha && fs.existsSync(target.destPath)) {
      const destSha = await sha256File(target.destPath);
      if (destSha === rawSha) {
        action.kind = 'skip-identical';
        action.reason = 'The file already on disk is byte-for-byte identical to the one in the bundle. Nothing to write.';
        action.existing = { filePath: target.destPath, sizeBytes: fs.statSync(target.destPath).size };
        actions.push(action);
        continue;
      }
    }

    // Candidates: everything sharing this session id, plus anything of the
    // same tool with an identical byte size (catches a session that was
    // renamed or re-filed but whose content is unchanged).
    const candidates = [];
    const seenPaths = new Set();
    for (const c of existingById.get(`${destTool}|${rec.sessionId}`) ?? []) {
      if (!seenPaths.has(c.filePath)) { seenPaths.add(c.filePath); candidates.push(c); }
    }
    const bundleRawSize = rec.rawEntries?.[0]?.sizeBytes ?? null;
    if (bundleRawSize) {
      for (const c of existingBySize.get(`${destTool}|${bundleRawSize}`) ?? []) {
        if (!seenPaths.has(c.filePath)) { seenPaths.add(c.filePath); candidates.push(c); }
      }
    }

    if (!candidates.length && !fs.existsSync(target.destPath)) {
      action.kind = 'write';
      action.reason = 'Not present at the destination.';
      actions.push(action);
      continue;
    }

    // Parse candidates and look for a content-hash match before ever calling
    // this a conflict. A match anywhere means we already hold this
    // conversation, whatever file it happens to live in.
    let matched = null;
    const parsed = [];
    for (const c of candidates) {
      try {
        const { session } = await discovery.loadSession(c, { includeRawRows: false });
        parsed.push({ entry: c, session });
        if (session.contentHash === rec.contentHash) { matched = { entry: c, session }; break; }
      } catch { /* an unparseable candidate simply cannot match */ }
    }

    if (matched) {
      action.kind = 'skip-identical';
      action.reason = matched.entry.filePath === target.destPath
        ? 'Identical content already present (same content hash). Nothing to write.'
        : `Identical content already present under ${path.basename(matched.entry.filePath)} (same content hash). Nothing to write.`;
      action.existing = { filePath: matched.entry.filePath, sizeBytes: matched.entry.sizeBytes, updatedAt: matched.entry.updatedAt, integrity: matched.entry.integrity };
      actions.push(action);
      continue;
    }

    // Genuinely different. Compare against the candidate that shares the
    // destination path if there is one, else the closest by id.
    const best =
      parsed.find((p) => p.entry.filePath === target.destPath) ??
      parsed.find((p) => p.entry.sessionId === rec.sessionId) ??
      parsed[0] ?? null;

    action.existing = best
      ? { filePath: best.entry.filePath, sizeBytes: best.entry.sizeBytes, updatedAt: best.entry.updatedAt, integrity: best.entry.integrity }
      : { filePath: target.destPath, sizeBytes: fs.existsSync(target.destPath) ? fs.statSync(target.destPath).size : 0 };

    if (best) {
      let incoming = null;
      try {
        incoming = await loadNormalizedFromBundle(zipPath, entries, rec);
      } catch (err) {
        if (err.code !== 'NORMALIZED_TOO_LARGE') throw err;
        // Too large to diff message-by-message. We already know the content
        // hashes differ, so this is a real conflict -- we just cannot show
        // where it diverges. Say that instead of guessing.
        action.kind = 'conflict';
        action.reason =
          `Differs from ${path.basename(best.entry.filePath)} (content hashes do not match), but the session is too large ` +
          'to diff message by message. Choose keep-both to avoid discarding either copy.';
        action.diffUnavailable = err.message;
        action.recommendation = {
          resolution: merge.RESOLUTION.KEEP_BOTH,
          reason: 'No message-level diff is available at this size, so the only choice that provably loses nothing is to keep both.',
        };
        actions.push(action);
        continue;
      }

      const cmp = merge.compareSessions(best.session, incoming);
      action.comparison = cmp;
      action.recommendation = merge.recommend(cmp);
      action.diff = merge.diffPreview(best.session, incoming, cmp);
      action.kind = cmp.relation === merge.RELATION.IDENTICAL ? 'skip-identical' : 'conflict';
      action.reason =
        cmp.relation === merge.RELATION.IDENTICAL
          ? 'Identical content already present.'
          : `Diverges from ${path.basename(best.entry.filePath)} at message ${cmp.divergeIndex} (${cmp.aOnly} local vs ${cmp.bOnly} incoming message(s) after that point).`;
    } else if (fs.existsSync(target.destPath)) {
      action.kind = 'conflict';
      action.reason = 'A file already exists at the destination path but could not be parsed for comparison. It will not be overwritten without an explicit choice.';
      action.recommendation = { resolution: merge.RESOLUTION.KEEP_BOTH, reason: 'Existing file is unreadable; keeping both avoids destroying data we cannot inspect.' };
    } else {
      action.kind = 'write';
      action.reason = 'Not present at the destination.';
    }
    actions.push(action);
  }

  const plan = {
    kind: 'import',
    zipPath,
    manifest: { ...manifest, sessions: undefined },
    sessionCount: manifest.sessions.length,
    actions,
    summary: {
      write: actions.filter((a) => a.kind === 'write').length,
      skipIdentical: actions.filter((a) => a.kind === 'skip-identical').length,
      conflict: actions.filter((a) => a.kind === 'conflict').length,
      blocked: actions.filter((a) => a.kind === 'blocked').length,
    },
    createdAt: new Date().toISOString(),
  };
  plan.token = safety.registerPlan(plan);
  return plan;
}

/** Where a session should land at the destination. */
function resolveDestination(rec, destTool, scan, accountRemap) {
  const tool = scan.tools.find((t) => t.tool === destTool && t.hasSessions) || scan.tools.find((t) => t.tool === destTool);
  if (!tool) return { root: null, destPath: null };
  const root = accountRemap?.root || tool.root;

  if (destTool === rec.sourceTool && rec.originalRelative) {
    return { root, destPath: path.join(root, rec.originalRelative) };
  }
  if (destTool === 'claude-code') {
    const ex = require('./exporters/claude-code');
    return { root, destPath: path.join(root, ex.encodeProjectDir(rec.projectPath) ? path.join('projects', ex.encodeProjectDir(rec.projectPath), rec.sessionId + '.jsonl') : path.join('projects', 'imported', rec.sessionId + '.jsonl')) };
  }
  return { root, destPath: null };
}

/**
 * Largest normalized copy we will parse into memory.
 *
 * V8 caps a single string at ~512MB, so a normalized JSON document beyond that
 * cannot be JSON.parse'd at all. We stop well short of the cliff and say so
 * plainly, rather than letting callers hit an opaque engine error. Sessions
 * this large can still be exported, restored to their own tool byte-for-byte,
 * and compared by content hash -- only the message-level diff and cross-tool
 * conversion need the parsed form.
 */
const MAX_NORMALIZED_PARSE_BYTES = 256 * 1024 * 1024;

class NormalizedTooLargeError extends Error {
  constructor(rec, size) {
    super(
      `Session ${rec.sessionId} has a normalized copy of ${(size / 1048576).toFixed(0)}MB, ` +
      'which is too large to load into memory for a message-level comparison. ' +
      'It can still be restored to its original tool byte-for-byte, and compared by content hash.'
    );
    this.name = 'NormalizedTooLargeError';
    this.code = 'NORMALIZED_TOO_LARGE';
  }
}

async function loadNormalizedFromBundle(zipPath, entries, rec) {
  const e = entries.find((x) => x.name === rec.normalizedEntry);
  if (!e) throw new Error(`bundle is missing normalized entry ${rec.normalizedEntry}`);
  if (e.usize > MAX_NORMALIZED_PARSE_BYTES) throw new NormalizedTooLargeError(rec, e.usize);
  const buf = await readEntryBuffer(zipPath, e, { maxBytes: MAX_NORMALIZED_PARSE_BYTES });
  const session = JSON.parse(buf.toString('utf8'));
  const problems = uss.validate(session);
  if (problems.length) {
    throw new Error(`normalized session ${rec.sessionId} failed validation: ${problems.slice(0, 3).map((p) => p.path + ' ' + p.message).join('; ')}`);
  }
  return session;
}

/**
 * Execute a previously previewed import.
 *
 * `resolutions` maps sessionId -> merge.RESOLUTION for anything the plan
 * marked as a conflict. Any conflict without an explicit resolution is left
 * untouched -- silence is never taken as consent to overwrite.
 */
async function executeImport(planToken, resolutions = {}, options = {}) {
  const plan = safety.consumePlan(planToken);
  if (plan.kind !== 'import') throw new safety.SafetyError('plan token is not an import plan', 'PLAN_MISMATCH');

  const { manifest, entries } = await readManifest(plan.zipPath);
  const results = [];

  for (const action of plan.actions) {
    // Resolved by position, never by session id -- see the note in planImport.
    const rec = manifest.sessions[action.manifestIndex];
    if (!rec) {
      results.push({
        sessionId: action.sessionId, kind: action.kind, applied: 'failed', destPath: action.destPath,
        backupPath: null, lossy: [],
        error: 'The bundle no longer matches the previewed plan. Re-run the preview and try again.',
      });
      continue;
    }
    if (rec.sessionId !== action.sessionId) {
      results.push({
        sessionId: action.sessionId, kind: action.kind, applied: 'failed', destPath: action.destPath,
        backupPath: null, lossy: [],
        error: `Refusing to write: the plan expected session ${action.sessionId} at manifest position ` +
               `${action.manifestIndex} but found ${rec.sessionId}. The bundle changed since the preview.`,
      });
      continue;
    }
    const res = { sessionId: action.sessionId, kind: action.kind, applied: null, destPath: action.destPath, backupPath: null, error: null, lossy: [] };

    try {
      if (action.kind === 'blocked') {
        res.applied = 'blocked';
        res.error = action.reason;
      } else if (action.kind === 'skip-identical') {
        res.applied = 'skipped-identical';
      } else if (action.kind === 'write') {
        const out = await writeSession(plan, rec, action, entries, { allowOverwrite: false });
        Object.assign(res, out);
        res.applied = 'written';
      } else if (action.kind === 'conflict') {
        const choice = resolutions[action.sessionId];
        if (!choice || choice === merge.RESOLUTION.SKIP) {
          res.applied = 'skipped-unresolved';
          res.error = choice ? null : 'No resolution chosen; left untouched.';
        } else if (choice === merge.RESOLUTION.KEEP_EXISTING) {
          res.applied = 'kept-existing';
        } else if (choice === merge.RESOLUTION.KEEP_INCOMING) {
          const out = await writeSession(plan, rec, action, entries, { allowOverwrite: true, reason: 'import: keep-incoming' });
          Object.assign(res, out);
          res.applied = 'overwritten';
        } else if (choice === merge.RESOLUTION.KEEP_NEWER) {
          const incomingNewer = action.comparison?.newer === 'b';
          if (incomingNewer) {
            const out = await writeSession(plan, rec, action, entries, { allowOverwrite: true, reason: 'import: keep-newer (incoming)' });
            Object.assign(res, out);
            res.applied = 'overwritten-newer';
          } else {
            res.applied = 'kept-existing-newer';
          }
        } else if (choice === merge.RESOLUTION.KEEP_BOTH) {
          const suffixed = suffixPath(action.destPath, 'imported');
          const out = await writeSession(plan, rec, { ...action, destPath: suffixed }, entries, { allowOverwrite: false });
          Object.assign(res, out);
          res.destPath = suffixed;
          res.applied = 'written-alongside';
        } else {
          res.applied = 'skipped-unknown-resolution';
          res.error = `Unrecognized resolution "${choice}".`;
        }
      }
    } catch (err) {
      res.applied = 'failed';
      res.error = err.message;
    }

    audit.append({
      action: 'import-session',
      sessionId: action.sessionId,
      sourceTool: action.sourceTool,
      destTool: action.destTool,
      outcome: res.applied,
      destPath: res.destPath,
      backupPath: res.backupPath,
      resolution: resolutions[action.sessionId] ?? null,
      contentHash: action.contentHash,
      error: res.error,
      bundle: plan.zipPath,
    });
    results.push(res);
  }

  audit.append({ action: 'import-complete', bundle: plan.zipPath, results: results.map((r) => ({ id: r.sessionId, outcome: r.applied })) });
  return { results, plan };
}

/** Write one session at the destination, raw when possible, converted when not. */
async function writeSession(plan, rec, action, entries, writeOptions) {
  const out = { backupPath: null, lossy: [], destPath: action.destPath };

  if (!action.isConversion && rec.rawEntries?.length) {
    // Same tool: restore the untouched original bytes. Lossless by construction.
    const main = rec.rawEntries[0];
    const zipEntry = entries.find((e) => e.name === main.archiveName);
    if (!zipEntry) throw new Error(`bundle is missing raw entry ${main.archiveName}`);

    if (fs.existsSync(action.destPath) && !writeOptions.allowOverwrite) {
      throw new safety.SafetyError(`destination already exists: ${action.destPath}`, 'OVERWRITE_REFUSED');
    }
    if (fs.existsSync(action.destPath) && writeOptions.allowOverwrite) {
      out.backupPath = await safety.backupFile(action.destPath, writeOptions.reason || 'import');
    }
    const tmpDest = action.destPath + '.aism-incoming';
    await extractEntryToFile(plan.zipPath, zipEntry, tmpDest);

    // Verify what we extracted before it replaces anything.
    const digest = await sha256File(tmpDest);
    if (main.sha256 && digest !== main.sha256) {
      await fsp.unlink(tmpDest).catch(() => {});
      throw new Error(`extracted file hash ${digest} does not match the manifest (${main.sha256}); refusing to write`);
    }
    const verify = await readJsonl(tmpDest, null);
    if (verify.integrity === 'damaged' || verify.integrity === 'unreadable') {
      await fsp.unlink(tmpDest).catch(() => {});
      throw new Error(`extracted file is ${verify.integrity}; refusing to write it over anything`);
    }
    await fsp.mkdir(path.dirname(action.destPath), { recursive: true });
    await fsp.rename(tmpDest, action.destPath);

    // Sub-agent transcripts and sidecars accompany the main file.
    for (const extra of rec.rawEntries.slice(1).concat(rec.sidecars || [])) {
      const ze = entries.find((e) => e.name === extra.archiveName);
      if (!ze) continue;
      const rel = extra.archiveName.replace(/^raw\/[^/]+\//, '');
      const dest = path.join(action.destRoot, rel);
      if (fs.existsSync(dest) && !writeOptions.allowOverwrite) continue;
      await extractEntryToFile(plan.zipPath, ze, dest);
    }
    return out;
  }

  // With a single supported tool there is no conversion path: a bundle can
  // only be restored into Claude Code, from its untouched raw bytes.
  throw new Error(
    `Cannot restore session ${rec.sessionId}: the bundle has no raw copy for it, ` +
    'and this build only writes Claude Code sessions.'
  );
}

function suffixPath(p, suffix) {
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const base = path.basename(p, ext);
  const stamp = new Date().toISOString().slice(0, 10);
  return path.join(dir, `${base}--${suffix}-${stamp}${ext}`);
}

module.exports = {
  BUNDLE_SCHEMA_VERSION, exportBundle, readManifest, planImport, executeImport, sha256File, safeArchiveName,
};
