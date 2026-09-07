'use strict';
/**
 * Claude Desktop's per-account session index.
 *
 * Layout (verified against a real Store install):
 *   <root>/claude-code-sessions/<accountUuid>/<organizationUuid>/
 *     local_<sessionId>.json   session metadata
 *     deleted_<sessionId>      tombstone: a single epoch-ms timestamp
 *
 * This matters because it is the ONLY place that says, for every session,
 * which account it belongs to. A `~/.claude` folder holds transcripts from
 * every account that has ever signed in, mixed together, and only the handful
 * that were bridged record an owner inside the file itself. On the reference
 * machine this index attributes 255 sessions across two accounts, where
 * reading the transcripts alone attributed 12.
 *
 * The entries are METADATA, not transcripts. `cliSessionId` is the join key to
 * `~/.claude/projects/<project>/<cliSessionId>.jsonl`.
 *
 * It is an index, so the project's usual rule applies: it is read for account
 * attribution and titles, never as the authority on what exists on disk -- it
 * lists sessions whose transcripts are gone, and misses transcripts that are
 * present.
 */
const fs = require('fs');
const path = require('path');

const SESSIONS_DIR = 'claude-code-sessions';
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Directory timestamps are only granular to a few ms across filesystems. */
const BIRTH_TOLERANCE_MS = 2000;

/**
 * Every <accountUuid>/<organizationUuid> folder under one root, INCLUDING the
 * empty ones.
 *
 * Empty folders matter. A brand-new account has no `local_*.json` at all, and
 * a folder can exist for an organization belonging to a different account --
 * on the reference machine one account carries an empty folder for the other
 * account's org. Both cases have to be visible to `resolveHistoryOrg`, which
 * is what decides where an index entry may be written.
 */
function listOrgFolders(root) {
  const base = path.join(root, SESSIONS_DIR);
  const out = [];
  let accounts;
  try { accounts = fs.readdirSync(base, { withFileTypes: true }); } catch { return out; }

  for (const a of accounts) {
    if (!a.isDirectory() || !UUID_RE.test(a.name)) continue;
    const accountDir = path.join(base, a.name);
    const accountCreatedMs = birthtimeMs(accountDir);
    let orgs;
    try { orgs = fs.readdirSync(accountDir, { withFileTypes: true }); } catch { continue; }
    for (const o of orgs) {
      if (!o.isDirectory() || !UUID_RE.test(o.name)) continue;
      const dir = path.join(accountDir, o.name);
      let files;
      try { files = fs.readdirSync(dir); } catch { continue; }
      const sessions = files.filter((f) => f.startsWith('local_') && f.endsWith('.json'));
      const deleted = files.filter((f) => f.startsWith('deleted_'));
      out.push({
        accountUuid: a.name,
        organizationUuid: o.name,
        dir,
        accountDir,
        sessionCount: sessions.length,
        deletedCount: deleted.length,
        // Set together with the account folder when the account is first
        // activated; a folder for someone else's org appears later.
        createdMs: birthtimeMs(dir),
        accountCreatedMs,
      });
    }
  }
  return out;
}

/**
 * Birth time, or null where the filesystem does not record one.
 *
 * ext4 frequently reports 0 and some kernels fall back to ctime, so callers
 * must treat this as a hint that may be absent -- never as proof.
 */
function birthtimeMs(dir) {
  try {
    const b = fs.statSync(dir).birthtimeMs;
    return Number.isFinite(b) && b > 0 ? b : null;
  } catch { return null; }
}

/** Accounts and organizations that actually hold index entries. */
function listAccounts(root) {
  return listOrgFolders(root)
    .filter((f) => f.sessionCount > 0 || f.deletedCount > 0)
    .map(({ accountUuid, organizationUuid, dir, sessionCount, deletedCount }) =>
      ({ accountUuid, organizationUuid, dir, sessionCount, deletedCount }));
}

/**
 * Decide which organization folder under an account holds the history Claude
 * Desktop shows in its sidebar.
 *
 * This is the question that gates writing anything into the index: put an
 * entry in the wrong org folder and the session simply never appears. Signals
 * are tried strongest first and the chain ends in "ambiguous", never a guess.
 *
 *   1. signed-in     `~/.claude.json` pairs accountUuid with organizationUuid.
 *   2. transcript    bridge-session rows carry both ids, so this works for an
 *                    account that is not currently signed in.
 *   3. populated     exactly one folder under the account holds entries.
 *   4. only-folder   a new account with one folder and nothing in it.
 *   5. born-together the account's own org folder is created in the same
 *                    operation as the account folder, while a foreign org's
 *                    folder appears later. Filesystem-dependent, so it is
 *                    consulted only when everything better has stayed silent.
 */
function resolveHistoryOrg(root, accountUuid, hints = {}) {
  const candidates = listOrgFolders(root).filter((f) => f.accountUuid === accountUuid);
  return pickHistoryOrg(accountUuid, candidates, hints);
}

/**
 * The decision itself, over a candidate list rather than a directory.
 *
 * Split out from `resolveHistoryOrg` so every branch -- including the ones
 * that depend on filesystem timestamps, which a test cannot fabricate on
 * Windows -- can be exercised directly.
 */
function pickHistoryOrg(accountUuid, candidates, hints = {}) {
  const {
    signedIn = null,
    transcriptPairs = null,
    // account -> organization, as stated by a config Claude Desktop wrote
    // for that account. Names an account that is not the signed-in one.
    declaredOrgs = null,
  } = hints;

  const answer = (folder, confidence, reason) => ({
    accountUuid,
    organizationUuid: folder.organizationUuid,
    dir: folder.dir ?? null,
    confidence,
    reason,
    ambiguous: false,
    candidates,
  });
  const refuse = (reason) => ({
    accountUuid,
    organizationUuid: null,
    dir: null,
    confidence: 'none',
    reason,
    ambiguous: true,
    candidates,
  });

  if (!candidates.length) {
    return refuse('No organization folder exists for this account yet. Sign in to it once so Claude Desktop creates one -- the organization id cannot be invented.');
  }

  const byOrg = (uuid) => candidates.find((c) => c.organizationUuid === uuid) || null;

  // 1. The signed-in account states its own pairing.
  if (signedIn && signedIn.accountUuid === accountUuid && signedIn.organizationUuid) {
    const hit = byOrg(signedIn.organizationUuid);
    if (hit) return answer(hit, 'signed-in', 'Paired with this organization in the signed-in account config.');
  }

  // 1b. Claude Desktop's own config for this account says the same thing,
  //     and says it for accounts that are not the one signed in.
  const declared = declaredOrgs && typeof declaredOrgs.get === 'function'
    ? declaredOrgs.get(accountUuid)
    : null;
  if (declared) {
    const hit = byOrg(declared);
    if (hit) return answer(hit, 'account-config', 'Paired with this organization in a config Claude Desktop wrote for this account.');
  }

  // 2. Transcripts written by this account record the organization too.
  const fromTranscript = transcriptPairs && typeof transcriptPairs.get === 'function'
    ? transcriptPairs.get(accountUuid)
    : null;
  if (fromTranscript) {
    const hit = byOrg(fromTranscript);
    if (hit) return answer(hit, 'transcript', 'This account and organization appear together in session transcripts on disk.');
  }

  // 3. Exactly one folder holds anything.
  const populated = candidates.filter((c) => c.sessionCount > 0 || c.deletedCount > 0);
  if (populated.length === 1) {
    return answer(populated[0], 'populated', 'The only organization folder under this account holding session entries.');
  }
  if (populated.length > 1) {
    return refuse(`${populated.length} organization folders under this account hold session entries and nothing identifies which one Claude Desktop reads. Sign in to the account once to settle it.`);
  }

  // 4. A new account with a single empty folder.
  if (candidates.length === 1) {
    return answer(candidates[0], 'only-folder', 'The only organization folder under this account.');
  }

  // 5. The account's own folder was created with the account folder itself.
  const bornTogether = candidates.filter(
    (c) => c.createdMs != null && c.accountCreatedMs != null
      && Math.abs(c.createdMs - c.accountCreatedMs) <= BIRTH_TOLERANCE_MS
  );
  if (bornTogether.length === 1) {
    return answer(bornTogether[0], 'born-together', 'Created in the same operation as the account folder itself; the others appeared later.');
  }

  return refuse(`${candidates.length} empty organization folders under this account and no signal separates them. Sign in to the account once so its organization is recorded.`);
}

/**
 * Read every index entry under one root.
 *
 * A malformed entry is reported rather than skipped silently -- the same rule
 * the transcript readers follow.
 */
function readIndex(root, options = {}) {
  const { includeDeleted = true } = options;
  const entries = [];
  const problems = [];

  for (const acct of listAccounts(root)) {
    let files;
    try { files = fs.readdirSync(acct.dir); } catch (err) {
      problems.push({ dir: acct.dir, message: err.message });
      continue;
    }

    for (const f of files) {
      const full = path.join(acct.dir, f);

      if (f.startsWith('deleted_')) {
        if (!includeDeleted) continue;
        let deletedAt = null;
        try {
          const raw = fs.readFileSync(full, 'utf8').trim();
          const ms = Number(raw);
          if (Number.isFinite(ms) && ms > 0) deletedAt = new Date(ms).toISOString();
        } catch { /* a tombstone we cannot read is still a tombstone */ }
        entries.push({
          kind: 'deleted',
          accountUuid: acct.accountUuid,
          organizationUuid: acct.organizationUuid,
          desktopSessionId: f.replace(/^deleted_/, ''),
          cliSessionId: null,
          deletedAt,
          indexPath: full,
        });
        continue;
      }

      if (!f.startsWith('local_') || !f.endsWith('.json')) continue;

      let j;
      try { j = JSON.parse(fs.readFileSync(full, 'utf8')); }
      catch (err) {
        problems.push({ file: full, message: 'unparseable index entry: ' + err.message.slice(0, 120) });
        continue;
      }

      entries.push({
        kind: 'session',
        accountUuid: acct.accountUuid,
        organizationUuid: acct.organizationUuid,
        desktopSessionId: j.sessionId ?? f.replace(/\.json$/, ''),
        // The join key to the Claude Code transcript on disk.
        cliSessionId: j.cliSessionId ?? null,
        title: j.title ?? null,
        projectPath: j.originCwd ?? j.cwd ?? null,
        worktreeCwd: j.cwd ?? null,
        branch: j.branch ?? null,
        sourceBranch: j.sourceBranch ?? null,
        model: j.model ?? null,
        effort: j.effort ?? null,
        isArchived: !!j.isArchived,
        completedTurns: typeof j.completedTurns === 'number' ? j.completedTurns : null,
        createdAt: toIso(j.createdAt),
        lastActivityAt: toIso(j.lastActivityAt),
        lastFocusedAt: toIso(j.lastFocusedAt),
        spawnedFromSessionId: j.spawnedFrom?.sessionId ?? null,
        indexPath: full,
      });
    }
  }
  return { entries, problems };
}

function toIso(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Group index entries into accounts, with per-account counts. */
function summarize(entries) {
  const accounts = new Map();
  for (const e of entries) {
    const key = e.accountUuid;
    if (!accounts.has(key)) {
      accounts.set(key, {
        accountUuid: key,
        organizations: new Set(),
        sessionCount: 0,
        deletedCount: 0,
        archivedCount: 0,
        withCliSession: 0,
      });
    }
    const a = accounts.get(key);
    a.organizations.add(e.organizationUuid);
    if (e.kind === 'deleted') { a.deletedCount++; continue; }
    a.sessionCount++;
    if (e.isArchived) a.archivedCount++;
    if (e.cliSessionId) a.withCliSession++;
  }
  return [...accounts.values()].map((a) => ({ ...a, organizations: [...a.organizations] }));
}

module.exports = {
  listAccounts, listOrgFolders, resolveHistoryOrg, pickHistoryOrg,
  readIndex, summarize, SESSIONS_DIR, BIRTH_TOLERANCE_MS,
};
