'use strict';
/**
 * Relinking Claude Desktop records that lost their transcript id.
 *
 * A `local_<id>.json` can end up without a `cliSessionId` (and, in principle,
 * without a `cwd`). Claude Desktop still lists it, but has nothing to open, so
 * the session appears in the sidebar and shows nothing when clicked. The
 * transcript may be sitting on disk perfectly intact -- only the pointer is
 * gone.
 *
 * What survives on a broken record is its title, and the title is the search.
 * Every transcript under `~/.claude/projects` is read for its own title and
 * compared -- all folders, not just the one the record names, because a folder
 * holds many transcripts and cannot identify one on its own.
 *
 * The order is:
 *
 *   1. the title    `customTitle` first -- the one a person typed -- then
 *                   `aiTitle`. Exact, then ignoring case and punctuation.
 *                   Nothing matches the title, nothing is proposed.
 *   2. the folder   among the transcripts that matched, the ones sitting in
 *                   the folder `originCwd` (or `cwd`) encodes to are preferred.
 *                   This narrows, it never excludes: for a worktree session
 *                   `originCwd` names the project root while the transcript
 *                   lives under `.claude\worktrees\...`, and 24 of 195 linked
 *                   records on a real installation are exactly that.
 *   3. last used    the most recently edited file.
 *   4. size         then the largest -- the fullest record of that
 *                   conversation.
 *
 * Titles are read by sampling each end of a transcript rather than the whole
 * file, which can be gigabytes. Measured across 121 real transcripts that
 * found the title every time: they carry roughly 244 title rows each, so one
 * is always near an end.
 *
 * Within ONE account a transcript is claimed by at most one record, so a
 * transcript another record in that account already points at is never
 * proposed again. Across accounts it is the opposite: two accounts routinely
 * list the same session and point at the same transcript -- 97 of 124 on the
 * reference machine -- so a sibling account's claim must not hide it. Treating
 * the claim as global made exactly the obvious manual test fail: delete one
 * account's cliSessionId and the repair could not find the file sitting right
 * there. Nothing is written without a dry run.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');
const jsonl = require('./jsonl');
const claudeDesktop = require('./parsers/claude-desktop');
const safety = require('./safety');
const audit = require('./audit');

/** Rows sampled from each end of a transcript when looking for its title. */
const SAMPLE_ROWS = 250;

const CONFIDENCE = { STRONG: 'strong', LIKELY: 'likely', NONE: 'none' };

/**
 * Claude Code's project directory encoding.
 *
 * Every character that is not a letter or a digit becomes a dash, and runs are
 * NOT collapsed: `F:\0. Mobile apps` -> `F--0--Mobile-apps`. Verified against
 * the folders on a real installation.
 */
function encodeProjectDir(projectPath) {
  return String(projectPath || '').replace(/[^A-Za-z0-9]/g, '-');
}

/** Every index record, including the ones that are missing their pointer. */
function readAllRecords(root) {
  const base = path.join(root, claudeDesktop.SESSIONS_DIR);
  const out = [];
  let accounts;
  try { accounts = fs.readdirSync(base, { withFileTypes: true }); } catch { return out; }

  for (const a of accounts) {
    if (!a.isDirectory()) continue;
    let orgs;
    try { orgs = fs.readdirSync(path.join(base, a.name), { withFileTypes: true }); } catch { continue; }
    for (const o of orgs) {
      if (!o.isDirectory()) continue;
      const dir = path.join(base, a.name, o.name);
      let files;
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const f of files) {
        if (!f.startsWith('local_') || !f.endsWith('.json')) continue;
        const indexPath = path.join(dir, f);
        let json;
        try { json = JSON.parse(fs.readFileSync(indexPath, 'utf8')); }
        catch (err) {
          out.push({ indexPath, accountUuid: a.name, organizationUuid: o.name, unreadable: err.message });
          continue;
        }
        out.push({
          indexPath, accountUuid: a.name, organizationUuid: o.name, json,
          cliSessionId: json.cliSessionId ?? null,
          cwd: json.cwd ?? null,
          originCwd: json.originCwd ?? null,
          title: json.title ?? null,
          createdAt: json.createdAt ?? null,
          lastActivityAt: json.lastActivityAt ?? null,
        });
      }
    }
  }
  return out;
}

/** Transcript files on disk, with the project folder each sits in. */
function listTranscripts(roots) {
  const out = [];
  for (const { root } of roots) {
    const projects = path.join(root, 'projects');
    let dirs;
    try { dirs = fs.readdirSync(projects, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(projects, d.name);
      let files;
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const filePath = path.join(dir, f);
        let st;
        try { st = fs.statSync(filePath); } catch { continue; }
        out.push({
          sessionId: f.replace(/\.jsonl$/, ''),
          filePath, folder: d.name, sizeBytes: st.size, mtimeMs: st.mtimeMs,
        });
      }
    }
  }
  return out;
}

/**
 * First and last message time, and the title, without reading whole files.
 *
 * A transcript can be gigabytes; only the two ends are needed. The title is
 * looked for in both, because an ai-title lands early and a rename lands late.
 */
async function describeTranscript(filePath) {
  const [head, tail] = await Promise.all([
    jsonl.readJsonlHead(filePath, SAMPLE_ROWS),
    jsonl.readJsonlTail(filePath, SAMPLE_ROWS),
  ]);
  const rows = [...(head.rows || []), ...(tail.rows || [])];

  let first = null, last = null, custom = null, ai = null, sessionId = null, cwd = null, model = null;
  // The two kinds are kept apart: a title a person typed outranks a generated
  // one when deciding which transcript a record refers to.
  //
  // Every title the file has ever carried is kept as well. Title rows repeat
  // throughout a transcript, so a rename leaves the older name in the earlier
  // rows -- and the index may still be holding exactly that older name.
  const seen = new Set();
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    if (!sessionId && r.sessionId) sessionId = r.sessionId;
    if (!cwd && r.cwd) cwd = r.cwd;
    // The model is on the assistant rows; the last one is what the session was
    // using when it stopped. `<synthetic>` is the placeholder Claude Code puts
    // on rows it generated itself, and is not a model anyone can resume with.
    if (r.message && r.message.model && !String(r.message.model).startsWith('<')) {
      model = r.message.model;
    }
    if (r.customTitle) { custom = r.customTitle; seen.add(r.customTitle); }
    if (r.aiTitle) { ai = r.aiTitle; seen.add(r.aiTitle); }
    const t = Date.parse(r.timestamp ?? '');
    if (!Number.isFinite(t)) continue;
    if (first === null || t < first) first = t;
    if (last === null || t > last) last = t;
  }
  return {
    first, last, sessionId, cwd, model,
    customTitle: custom, aiTitle: ai, title: custom || ai || null,
    everyTitle: [...seen],
    integrity: head.report?.integrity ?? null,
  };
}

/** Titles differ in punctuation and case more often than in substance. */
function normalizeTitle(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * How well this transcript's title answers to the record's, if at all.
 *
 * A custom title outranks a generated one, and an exact match outranks one
 * that only survives normalisation -- which is the difference between
 * "Guest/signup feedback popup" and "Guest signup feedback popup". Anything
 * looser than that starts matching neighbouring sessions.
 *
 * Lower rank is better; null means these are not the same session.
 */
const TITLE_TIERS = [
  { rank: 0, kind: 'custom', field: 'customTitle', exact: true },
  { rank: 1, kind: 'ai', field: 'aiTitle', exact: true },
  { rank: 2, kind: 'custom~', field: 'customTitle', exact: false },
  { rank: 3, kind: 'ai~', field: 'aiTitle', exact: false },
];

function titleMatch(record, info) {
  if (!record.title) return null;
  for (const tier of TITLE_TIERS) {
    const candidate = info[tier.field];
    if (!candidate) continue;
    const hit = tier.exact
      ? record.title.trim() === candidate.trim()
      : normalizeTitle(record.title) === normalizeTitle(candidate);
    if (hit) return { rank: tier.rank, kind: tier.kind };
  }
  return null;
}

/**
 * Find the records that lost their pointer, and what each one probably points
 * at. Read-only.
 */
async function scanBroken(options = {}) {
  const { onProgress, accountUuid = null } = options;
  const desktopRoots = paths.claudeDesktopRoots({ extraRoots: options.extraRoots });
  const transcripts = listTranscripts(paths.claudeCodeRoots().filter((r) => paths.isDir(r.root)));

  // Claims are per account: `<accountUuid>|<cliSessionId>`. Two accounts
  // listing one session is normal and must not make it unavailable to either.
  const claimed = new Set();
  const claimKey = (accountUuid, sessionId) => accountUuid + '|' + sessionId;
  const records = [];
  for (const { root } of desktopRoots) {
    for (const rec of readAllRecords(root)) {
      records.push({ ...rec, root });
      if (rec.cliSessionId) claimed.add(claimKey(rec.accountUuid, rec.cliSessionId));
    }
  }

  // Scoped to one account: the repair is offered from inside an account, and
  // showing another account's records there would be answering a different
  // question.
  const broken = records.filter((r) =>
    !r.unreadable && (!r.cliSessionId || !(r.cwd || r.originCwd))
    && (!accountUuid || r.accountUuid === accountUuid));
  const result = {
    scannedAt: new Date().toISOString(),
    recordsTotal: records.length,
    transcriptsTotal: transcripts.length,
    unreadable: records.filter((r) => r.unreadable).length,
    broken: [],
  };
  if (!broken.length) return result;

  // Reading a transcript's ends is the expensive part, so it is done once per
  // file and only for files that could plausibly belong to a broken record.
  const described = new Map();
  const describe = async (t) => {
    if (!described.has(t.sessionId)) described.set(t.sessionId, await describeTranscript(t.filePath));
    return described.get(t.sessionId);
  };

  let done = 0;
  for (const rec of broken) {
    // The folder the record names, used to narrow the title matches. Both
    // fields are accepted: `cwd` is the one that encodes to the transcript's
    // folder, `originCwd` is what a worktree session records instead.
    const folders = new Set([rec.cwd, rec.originCwd]
      .filter(Boolean).map((c) => encodeProjectDir(c)));

    // Everything still unspoken for, described once.
    const pool = [];
    for (const t of transcripts) {
      if (claimed.has(claimKey(rec.accountUuid, t.sessionId))) continue;
      let info;
      try { info = await describe(t); } catch { continue; }
      pool.push({ t, info });
    }

    const same = (a2, b2, exact) => (exact
      ? String(a2).trim() === String(b2).trim()
      : normalizeTitle(a2) === normalizeTitle(b2));

    const sameTitle = (c, field, exact) => {
      if (!rec.title) return false;
      // `everyTitle` is the list of names this transcript has carried, which
      // is how a session renamed after the index cached its old name is still
      // found. It ranks below the current names.
      if (field === 'everyTitle') {
        return (c.info.everyTitle || []).some((t) => same(rec.title, t, exact));
      }
      const other = c.info[field];
      return !!other && same(rec.title, other, exact);
    };

    // 1. The title is the search. A typed title before a generated one, and an
    //    exact match before one that only survives normalisation.
    const TIERS = [
      { kind: 'custom', field: 'customTitle', exact: true },
      { kind: 'custom~', field: 'customTitle', exact: false },
      { kind: 'ai', field: 'aiTitle', exact: true },
      { kind: 'ai~', field: 'aiTitle', exact: false },
      { kind: 'former', field: 'everyTitle', exact: true },
      { kind: 'former~', field: 'everyTitle', exact: false },
    ];

    let matches = [];
    let tier = null;
    for (const t of TIERS) {
      const hit = pool.filter((c) => sameTitle(c, t.field, t.exact));
      if (!hit.length) continue;
      tier = t;
      matches = hit.map((c) => ({
        sessionId: c.t.sessionId, filePath: c.t.filePath, folder: c.t.folder,
        sizeBytes: c.t.sizeBytes, mtimeMs: c.t.mtimeMs,
        transcriptTitle: c.info.customTitle || c.info.aiTitle || null,
        transcriptCwd: c.info.cwd,
        integrity: c.info.integrity,
        match: t.kind,
        // 2. Whether it sits in the folder the record names.
        folderRank: folders.has(c.t.folder) ? 0 : 1,
        // Shown next to a proposal, not used to choose it.
        firstMessageAt: c.info.first, lastMessageAt: c.info.last,
      }));
      break;
    }

    // 2. the recorded folder, 3. last used, 4. largest.
    matches.sort((a2, b2) =>
      a2.folderRank - b2.folderRank
      || b2.mtimeMs - a2.mtimeMs
      || b2.sizeBytes - a2.sizeBytes);

    const best = matches[0] ?? null;
    let confidence = CONFIDENCE.NONE;
    let reason;

    if (!best) {
      reason = rec.title
        ? 'No transcript under projects carries this title.'
        : 'This entry has no title to search by.';
    } else {
      const words = best.match.startsWith('custom') ? 'the title you set'
        : best.match.startsWith('former') ? 'a name this session used to have'
          : 'the generated title';
      const loose = best.match.endsWith('~') ? ' (punctuation differs)' : '';
      const where = best.folderRank === 0
        ? ', in the folder this entry names'
        : (folders.size ? ', though in a different project folder' : '');
      const others = matches.length - 1;
      confidence = (matches.length === 1
        || (best.folderRank === 0 && matches.filter((m) => m.folderRank === 0).length === 1))
        ? CONFIDENCE.STRONG : CONFIDENCE.LIKELY;
      reason = 'Matched on ' + words + loose + where
        + (others ? `; ${others} other${others === 1 ? '' : 's'} carried the same title, chose the most recently edited.` : '.');
    }

    // Claim it for this account, so a second broken record in the same account
    // cannot be offered the same transcript. A record in another account still
    // may -- that is a shared session, not a duplicate.
    if (best) claimed.add(claimKey(rec.accountUuid, best.sessionId));

    result.broken.push({
      indexPath: rec.indexPath,
      accountUuid: rec.accountUuid,
      organizationUuid: rec.organizationUuid,
      title: rec.title,
      cwd: rec.cwd,
      createdAt: rec.createdAt,
      lastActivityAt: rec.lastActivityAt,
      missing: [!rec.cliSessionId && 'cliSessionId', !(rec.cwd || rec.originCwd) && 'cwd'].filter(Boolean),
      searched: transcripts.length,
      candidates: matches.slice(0, 5),
      best,
      confidence,
      reason,
    });
    if (onProgress) onProgress({ done: ++done, total: broken.length });
  }

  result.fixable = result.broken.filter((b) => b.best).length;
  return result;
}

/**
 * Plan writing the recovered ids back.
 *
 * `indexPaths` selects which broken records to repair; omit it for every one
 * that has a confident match.
 */
async function planRepair(options = {}) {
  const scan = await scanBroken(options);
  const wanted = Array.isArray(options.indexPaths) && options.indexPaths.length
    ? new Set(options.indexPaths.map((p) => path.resolve(p)))
    : null;

  const actions = [];
  for (const b of scan.broken) {
    if (wanted && !wanted.has(path.resolve(b.indexPath))) continue;
    if (!b.best) {
      actions.push({ kind: 'blocked', ...summary(b), reason: b.reason });
      continue;
    }
    const fields = {};
    if (b.missing.includes('cliSessionId')) fields.cliSessionId = b.best.sessionId;
    if (b.missing.includes('cwd') && b.best.transcriptCwd) fields.cwd = b.best.transcriptCwd;
    actions.push({
      kind: 'repair',
      ...summary(b),
      fields,
      transcript: b.best.filePath,
      confidence: b.confidence,
      reason: b.reason,
    });
  }

  const plan = {
    kind: 'repair',
    scannedAt: scan.scannedAt,
    recordsTotal: scan.recordsTotal,
    transcriptsTotal: scan.transcriptsTotal,
    actions,
    summary: {
      repair: actions.filter((a) => a.kind === 'repair').length,
      blocked: actions.filter((a) => a.kind === 'blocked').length,
      strong: actions.filter((a) => a.confidence === CONFIDENCE.STRONG).length,
      likely: actions.filter((a) => a.confidence === CONFIDENCE.LIKELY).length,
    },
    createdAt: new Date().toISOString(),
  };
  plan.token = safety.registerPlan(plan);
  return plan;
}

function summary(b) {
  return {
    indexPath: b.indexPath,
    accountUuid: b.accountUuid,
    title: b.title,
    cwd: b.cwd,
    missing: b.missing,
  };
}

/**
 * Write the recovered ids into the records.
 *
 * Only the missing fields are added. Nothing that is already there is changed,
 * and the file is backed up before it is touched.
 */
async function executeRepair(planToken, options = {}) {
  const { onProgress } = options;
  const plan = safety.consumePlan(planToken);
  if (plan.kind !== 'repair') {
    throw new safety.SafetyError('plan token is not a repair plan', 'PLAN_MISMATCH');
  }

  const results = [];
  let done = 0;
  const repairs = plan.actions.filter((a) => a.kind === 'repair');

  for (const a of plan.actions) {
    const res = { indexPath: a.indexPath, title: a.title, applied: null, backupPath: null, error: null, fields: a.fields ?? null };
    if (a.kind !== 'repair') {
      res.applied = 'blocked';
      res.error = a.reason ?? null;
      results.push(res);
      continue;
    }

    try {
      const current = JSON.parse(fs.readFileSync(a.indexPath, 'utf8'));
      // The record may have been repaired by Claude Desktop since the preview.
      const stillMissing = Object.keys(a.fields).filter((k) => !current[k]);
      if (!stillMissing.length) {
        res.applied = 'skipped';
        res.error = 'This record was filled in after the preview was taken; it was left alone.';
      } else if (!fs.existsSync(a.transcript)) {
        res.applied = 'skipped';
        res.error = 'The transcript is no longer there.';
      } else {
        res.backupPath = await safety.backupFile(a.indexPath, 'index record repair');
        const next = { ...current };
        for (const k of stillMissing) next[k] = a.fields[k];
        await safety.writeFileAtomic(a.indexPath, JSON.stringify(next), { allowOverwrite: true, reason: 'index record repair' });
        res.applied = 'repaired';
        res.fields = Object.fromEntries(stillMissing.map((k) => [k, a.fields[k]]));
      }
    } catch (err) {
      res.applied = 'failed';
      res.error = err.message;
    }

    audit.append({
      action: 'index-record-repair',
      indexPath: a.indexPath,
      sessionId: a.fields?.cliSessionId ?? null,
      transcript: a.transcript ?? null,
      confidence: a.confidence ?? null,
      outcome: res.applied,
      backupPath: res.backupPath,
      error: res.error,
    });
    results.push(res);
    if (onProgress) onProgress({ done: ++done, total: repairs.length });
  }

  return {
    plan,
    results,
    summary: {
      repaired: results.filter((r) => r.applied === 'repaired').length,
      skipped: results.filter((r) => r.applied === 'skipped').length,
      blocked: results.filter((r) => r.applied === 'blocked').length,
      failed: results.filter((r) => r.applied === 'failed').length,
    },
  };
}

/**
 * A transcript with no history record at all.
 *
 * The mirror image of a broken record: the conversation is on disk, but no
 * account lists it, so Claude Desktop's sidebar has never heard of it. On the
 * reference machine that is 26 transcripts and 351 MB of work.
 *
 * A record can be built for it, because everything the record needs is in the
 * transcript: the session id, the working directory, the title, the model and
 * the first and last message times.
 */
async function scanOrphans(options = {}) {
  const { accountUuid = null, onProgress } = options;
  const desktopRoots = paths.claudeDesktopRoots({ extraRoots: options.extraRoots });
  const transcripts = listTranscripts(paths.claudeCodeRoots().filter((r) => paths.isDir(r.root)));

  // Which sessions each account already lists.
  const byAccount = new Map();
  for (const { root } of desktopRoots) {
    for (const rec of readAllRecords(root)) {
      if (rec.unreadable || !rec.cliSessionId) continue;
      if (!byAccount.has(rec.accountUuid)) byAccount.set(rec.accountUuid, new Set());
      byAccount.get(rec.accountUuid).add(rec.cliSessionId);
    }
  }
  const listedAnywhere = new Set([...byAccount.values()].flatMap((v) => [...v]));
  const listedHere = accountUuid ? (byAccount.get(accountUuid) ?? new Set()) : listedAnywhere;

  const out = { scannedAt: new Date().toISOString(), transcriptsTotal: transcripts.length, orphans: [] };
  let done = 0;
  for (const t of transcripts) {
    if (listedHere.has(t.sessionId)) continue;
    let info;
    try { info = await describeTranscript(t.filePath); } catch { info = null; }
    out.orphans.push({
      sessionId: t.sessionId,
      filePath: t.filePath,
      folder: t.folder,
      sizeBytes: t.sizeBytes,
      mtimeMs: t.mtimeMs,
      title: info ? (info.customTitle || info.aiTitle || null) : null,
      model: info ? info.model : null,
      titleSource: info && info.customTitle ? 'user' : 'auto',
      cwd: info ? info.cwd : null,
      firstMessageAt: info ? info.first : null,
      lastMessageAt: info ? info.last : null,
      integrity: info ? info.integrity : null,
      // Listed by a different account, just not this one.
      elsewhere: listedAnywhere.has(t.sessionId),
    });
    if (onProgress) onProgress({ done: ++done, total: transcripts.length });
  }
  return out;
}

/**
 * Build the record Claude Desktop would have written.
 *
 * The shape is taken from the 265 real records on the reference machine: the
 * fields every one of them carries, with the values that never vary.
 *
 * `permissionMode` is the exception. 249 of 265 say `bypassPermissions`, but
 * that is the setting that stops Claude Code asking before it acts, and it is
 * not something to invent on someone's behalf. A record written here says
 * `auto`; it can be changed in Claude Desktop.
 */
function buildRecord(orphan, options = {}) {
  const { model = null } = options;
  const id = crypto.randomUUID();
  const created = orphan.firstMessageAt ?? orphan.mtimeMs ?? Date.now();
  const active = orphan.lastMessageAt ?? orphan.mtimeMs ?? created;
  return {
    sessionId: 'local_' + id,
    cliSessionId: orphan.sessionId,
    cwd: orphan.cwd || null,
    originCwd: orphan.cwd || null,
    title: orphan.title || null,
    titleSource: orphan.titleSource || 'auto',
    createdAt: created,
    lastActivityAt: active,
    model: model || null,
    effort: 'high',
    isArchived: false,
    permissionMode: 'auto',
    chromePermissionMode: 'skip_all_permission_checks',
    alwaysAllowedReasons: [],
    sessionPermissionUpdates: [],
    classifierSummaryEnabled: true,
  };
}

/**
 * Plan writing records for orphaned transcripts into one account.
 *
 * Refuses anything it cannot describe: without a working directory the record
 * would name no project, and without a title the sidebar would show a blank
 * row. Better to leave it out than to add a row that says nothing.
 */
async function planCreateRecords(options = {}) {
  const { accountUuid, sessionIds = null } = options;
  if (!accountUuid) throw new safety.SafetyError('an account is required', 'NO_TARGET');

  const discovery = require('./discovery');
  const list = await discovery.listDesktopAccounts([], options);
  const account = list.find((a) => a.accountUuid === accountUuid);
  if (!account) throw new safety.SafetyError('that account has no Claude Desktop folder', 'NO_TARGET');
  if (account.ambiguous || !account.historyDir) {
    const err = new safety.SafetyError(
      `Cannot tell which folder holds this account's history. ${account.reason}`, 'HISTORY_ORG_UNRESOLVED');
    throw err;
  }

  const scan = await scanOrphans({ accountUuid });
  const wanted = Array.isArray(sessionIds) && sessionIds.length ? new Set(sessionIds) : null;

  const actions = [];
  for (const o of scan.orphans) {
    if (wanted && !wanted.has(o.sessionId)) continue;
    const why = !o.cwd ? 'The transcript does not record a working directory.'
      : !o.title ? 'The transcript has no title, so the entry would be blank.'
        : (o.integrity === 'damaged' || o.integrity === 'unreadable')
          ? `The transcript is ${o.integrity}.` : null;
    if (why) {
      actions.push({ kind: 'blocked', sessionId: o.sessionId, title: o.title, filePath: o.filePath, reason: why });
      continue;
    }
    const record = buildRecord(o, { model: o.model });
    actions.push({
      kind: 'create',
      sessionId: o.sessionId,
      title: o.title,
      filePath: o.filePath,
      sizeBytes: o.sizeBytes,
      elsewhere: o.elsewhere,
      destPath: path.join(account.historyDir, record.sessionId + '.json'),
      record,
    });
  }

  const plan = {
    kind: 'create-records',
    account: { accountUuid: account.accountUuid, label: account.label, historyDir: account.historyDir },
    actions,
    summary: {
      create: actions.filter((a) => a.kind === 'create').length,
      blocked: actions.filter((a) => a.kind === 'blocked').length,
    },
    createdAt: new Date().toISOString(),
  };
  plan.token = safety.registerPlan(plan);
  return plan;
}

/** Write the previewed records. Only ever creates; never touches an existing file. */
async function executeCreateRecords(planToken, options = {}) {
  const { onProgress } = options;
  const plan = safety.consumePlan(planToken);
  if (plan.kind !== 'create-records') {
    throw new safety.SafetyError('plan token is not a create-records plan', 'PLAN_MISMATCH');
  }

  const results = [];
  let done = 0;
  const writes = plan.actions.filter((a) => a.kind === 'create');

  for (const a of plan.actions) {
    const res = { sessionId: a.sessionId, title: a.title, destPath: a.destPath ?? null, applied: null, error: null };
    if (a.kind !== 'create') {
      res.applied = 'blocked';
      res.error = a.reason ?? null;
      results.push(res);
      continue;
    }
    try {
      if (!fs.existsSync(a.filePath)) {
        res.applied = 'skipped';
        res.error = 'The transcript is no longer there.';
      } else {
        await safety.writeFileAtomic(a.destPath, JSON.stringify(a.record), {
          allowOverwrite: false, reason: 'create history record',
        });
        res.applied = 'created';
      }
    } catch (err) {
      res.applied = 'failed';
      res.error = err.message;
    }
    audit.append({
      action: 'history-record-create',
      sessionId: a.sessionId,
      targetAccount: plan.account.accountUuid,
      sourcePath: a.filePath,
      destPath: a.destPath,
      outcome: res.applied,
      error: res.error,
    });
    results.push(res);
    if (onProgress) onProgress({ done: ++done, total: writes.length });
  }

  return {
    plan,
    results,
    summary: {
      created: results.filter((r) => r.applied === 'created').length,
      skipped: results.filter((r) => r.applied === 'skipped').length,
      blocked: results.filter((r) => r.applied === 'blocked').length,
      failed: results.filter((r) => r.applied === 'failed').length,
    },
  };
}

module.exports = {
  scanBroken, planRepair, executeRepair,
  scanOrphans, planCreateRecords, executeCreateRecords, buildRecord,
  encodeProjectDir, describeTranscript, normalizeTitle, titleMatch,
  CONFIDENCE,
};
