'use strict';
/**
 * Copying session-index entries between Claude Desktop accounts.
 *
 * A transcript on disk is only half of what makes a session appear in Claude
 * Desktop's sidebar. The other half is a `local_<id>.json` record inside
 * `claude-code-sessions/<account>/<organization>/`. Copying transcripts alone
 * leaves the session invisible to the account that is supposed to have it, so
 * this module copies the index records.
 *
 * What makes that safe here, verified against a real two-account install:
 *
 *   - A session shared by two accounts usually uses the SAME `local_<id>.json`
 *     filename in both, so a copy is normally verbatim.
 *   - But a record id is NOT unique across accounts. Continue a conversation
 *     on a second account -- which is what people do when the first one hits
 *     a limit -- and Claude Desktop writes a NEW transcript under the SAME
 *     record id. Two accounts then hold one record id pointing at two
 *     different conversations. Seen on the reference install: 2 of 137.
 *     So the transcript id is the identity of a session here, and the record
 *     id is only a filename, which a copy re-mints when the target has
 *     already spent it on something else.
 *   - The records embed no account or organization id, so nothing has to be
 *     rewritten on the way across.
 *   - What DOES differ between two accounts' copies of one session is that
 *     account's own activity state (`lastFocusedAt`, `lastActivityAt`,
 *     `completedTurns`). Overwriting an existing record would throw that away,
 *     which is why a record already present is skipped and never replaced.
 *
 * Nothing is ever deleted, and nothing is ever overwritten. The only write is
 * creating a record the target account does not have.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const claudeDesktop = require('./parsers/claude-desktop');
const discovery = require('./discovery');
const safety = require('./safety');
const audit = require('./audit');

/**
 * The two id shapes Claude Desktop uses for one session.
 *
 * A record is `local_<uuid>.json` and carries `sessionId: "local_<uuid>"`,
 * but its tombstone is `deleted_<uuid>` -- the same uuid without the prefix.
 * Comparing the two forms directly never matches, which would quietly let a
 * session the target had deleted be copied back in.
 */
function bareId(id) {
  return String(id || '').replace(/^local_/, '');
}

const ACTION = {
  COPY: 'copy',
  ALREADY_PRESENT: 'already-present',
  TOMBSTONED: 'tombstoned',
  BLOCKED: 'blocked',
  REMOVE: 'remove',
  NOT_PRESENT: 'not-present',
};

/**
 * Read every index record, keyed by account, for the accounts we can write to.
 *
 * An account whose history folder could not be identified is carried through
 * as unusable rather than dropped -- a target we cannot resolve has to be
 * refused out loud, not silently skipped.
 */
function readAccountIndexes(accounts) {
  const byAccount = new Map();
  for (const a of accounts) {
    const record = {
      account: a,
      usable: !a.ambiguous && !!a.historyDir,
      entries: new Map(),      // desktopSessionId -> entry
      byCliSession: new Map(), // cliSessionId    -> entry
      tombstones: new Set(),   // desktopSessionId
    };
    if (record.usable) {
      const { entries } = claudeDesktop.readIndex(a.root);
      for (const e of entries) {
        if (e.accountUuid !== a.accountUuid || e.organizationUuid !== a.historyOrgUuid) continue;
        if (e.kind === 'deleted') { record.tombstones.add(bareId(e.desktopSessionId)); continue; }
        record.entries.set(e.desktopSessionId, e);
        if (e.cliSessionId) record.byCliSession.set(e.cliSessionId, e);
      }
    }
    byAccount.set(a.accountUuid, record);
  }
  return byAccount;
}

/** One planned write, or one reason there will not be one. */
function action(kind, entry, source, target, extra = {}) {
  return {
    kind,
    cliSessionId: entry?.cliSessionId ?? null,
    desktopSessionId: entry?.desktopSessionId ?? null,
    title: entry?.title ?? null,
    projectPath: entry?.projectPath ?? null,
    lastActivityAt: entry?.lastActivityAt ?? null,
    sourceAccount: source ? { accountUuid: source.accountUuid, label: source.label } : null,
    targetAccount: target ? { accountUuid: target.accountUuid, label: target.label } : null,
    sourcePath: entry?.indexPath ?? null,
    destPath: target && entry
      ? path.join(target.historyDir, path.basename(entry.indexPath))
      : null,
    ...extra,
  };
}

/**
 * Decide what copying one record into one account would do.
 *
 * Split out so migrate and sync-all cannot drift apart: both must skip records
 * the target already has.
 *
 * `allowTombstoned` separates a bulk operation from a pointed one. Sweeping
 * every account must not quietly undo a deletion someone made, so by default a
 * tombstoned session is left out. But asking for one specific session to be
 * put everywhere is an instruction about that session, and refusing it would
 * be second-guessing the person who gave it -- so it is carried out, flagged,
 * and spelled out in the preview.
 */
function classify(entry, sourceAcct, targetRec, allowTombstoned = false) {
  const target = targetRec.account;
  if (!targetRec.usable) {
    return action(ACTION.BLOCKED, entry, sourceAcct, target, { reason: target.reason });
  }
  // The transcript is what identifies a session. Asking the record id first
  // was wrong: two accounts can hold one record id pointing at two different
  // conversations, and the check then reported a session as present when the
  // conversation was not in that account at all -- silently refusing to copy
  // the exact sessions someone opens this app to fix.
  if (entry.cliSessionId) {
    if (targetRec.byCliSession.has(entry.cliSessionId)) {
      return action(ACTION.ALREADY_PRESENT, entry, sourceAcct, target,
        { reason: 'This account already lists this session under its own record.' });
    }
  } else if (targetRec.entries.has(entry.desktopSessionId)) {
    // No transcript pointer to compare, so the record id is all there is.
    return action(ACTION.ALREADY_PRESENT, entry, sourceAcct, target,
      { reason: 'This account already lists it; its own activity state is left alone.' });
  }
  if (targetRec.tombstones.has(bareId(entry.desktopSessionId))) {
    if (!allowTombstoned) {
      return action(ACTION.TOMBSTONED, entry, sourceAcct, target,
        { reason: 'This account deleted this session. Copying it back would undo that, so it is left out.' });
    }
    // Restoring it means clearing the marker too: leave the tombstone behind
    // and Claude Desktop still treats the session as deleted.
    return action(ACTION.COPY, entry, sourceAcct, target, {
      wasTombstoned: true,
      tombstonePath: path.join(target.historyDir, 'deleted_' + bareId(entry.desktopSessionId)),
      reason: 'This account had deleted this session. Copying it back undoes that.',
    });
  }
  // The target may already spend this record id on a different conversation.
  // Copying the file under its own name would replace that record and lose
  // the other session, so the copy is given a record id of its own.
  if (targetRec.entries.has(entry.desktopSessionId)) {
    const newRecordId = 'local_' + crypto.randomUUID();
    return action(ACTION.COPY, entry, sourceAcct, target, {
      newRecordId,
      destPath: path.join(target.historyDir, newRecordId + '.json'),
      reason: 'This account uses that record id for a different conversation, so the copy is written under a new one.',
    });
  }

  return action(ACTION.COPY, entry, sourceAcct, target);
}

function summarize(actions, accounts) {
  return {
    copy: actions.filter((a) => a.kind === ACTION.COPY).length,
    remove: actions.filter((a) => a.kind === ACTION.REMOVE).length,
    notPresent: actions.filter((a) => a.kind === ACTION.NOT_PRESENT).length,
    alreadyPresent: actions.filter((a) => a.kind === ACTION.ALREADY_PRESENT).length,
    tombstoned: actions.filter((a) => a.kind === ACTION.TOMBSTONED).length,
    blocked: actions.filter((a) => a.kind === ACTION.BLOCKED).length,
    targets: new Set(actions.filter((a) => a.kind === ACTION.COPY).map((a) => a.targetAccount?.accountUuid)).size,
    accounts: accounts.length,
  };
}

/**
 * Plan copying specific sessions into ONE account.
 *
 * Sessions are named by `cliSessionId` -- the id the table shows and the join
 * key to the transcript on disk. A session no account has a record for cannot
 * be copied: there is nothing to copy. That is reported, not invented.
 */
async function planMigrate(options = {}) {
  const { cliSessionIds = [], targetAccountUuid, sessions = [] } = options;
  if (!targetAccountUuid) throw new safety.SafetyError('a target account is required', 'NO_TARGET');

  const accounts = await discovery.listDesktopAccounts(sessions);
  const indexes = readAccountIndexes(accounts);
  const targetRec = indexes.get(targetAccountUuid);
  if (!targetRec) throw new safety.SafetyError('that account has no Claude Desktop folder', 'NO_TARGET');
  if (!targetRec.usable) {
    throw new safety.SafetyError(
      `Cannot tell which folder holds this account's history, so nothing will be written. ${targetRec.account.reason}`,
      'HISTORY_ORG_UNRESOLVED');
  }

  const actions = [];
  for (const cliSessionId of cliSessionIds) {
    // Any account that already has a record for it can act as the source.
    let entry = null, sourceAcct = null;
    for (const [uuid, rec] of indexes) {
      if (uuid === targetAccountUuid || !rec.usable) continue;
      const hit = rec.byCliSession.get(cliSessionId);
      if (hit) { entry = hit; sourceAcct = rec.account; break; }
    }
    if (!entry) {
      const own = targetRec.byCliSession.get(cliSessionId);
      if (own) {
        actions.push(action(ACTION.ALREADY_PRESENT, own, targetRec.account, targetRec.account,
          { reason: 'This account already lists it.' }));
      } else {
        actions.push({
          kind: ACTION.BLOCKED, cliSessionId, desktopSessionId: null, title: null,
          projectPath: null, lastActivityAt: null,
          sourceAccount: null, targetAccount: { accountUuid: targetAccountUuid, label: targetRec.account.label },
          sourcePath: null, destPath: null,
          reason: 'No account has a Claude Desktop record for this session, so there is nothing to copy.',
        });
      }
      continue;
    }
    actions.push(classify(entry, sourceAcct, targetRec));
  }

  const plan = {
    kind: 'index-sync',
    mode: 'migrate',
    target: targetRec.account,
    accounts: accounts.map(brief),
    actions,
    summary: summarize(actions, accounts),
    createdAt: new Date().toISOString(),
  };
  plan.token = safety.registerPlan(plan);
  return plan;
}

/**
 * Plan giving every account the union of every account's records.
 *
 * Additive only: an account keeps everything it already has, and gains only
 * what it is missing.
 */
async function planSyncAll(options = {}) {
  const { sessions = [], accountUuids = null, cliSessionIds = null, allowTombstoned = false } = options;
  // Restricting to specific sessions is how one row of the comparison gets
  // synced on its own; the logic is otherwise identical, so it stays here
  // rather than becoming a second code path that could drift.
  const only = Array.isArray(cliSessionIds) && cliSessionIds.length
    ? new Set(cliSessionIds)
    : null;
  const all = await discovery.listDesktopAccounts(sessions);
  const accounts = Array.isArray(accountUuids) && accountUuids.length
    ? all.filter((a) => accountUuids.includes(a.accountUuid))
    : all;

  const indexes = readAccountIndexes(accounts);
  const usable = [...indexes.values()].filter((r) => r.usable);
  const actions = [];

  if (usable.length >= 2) {
    // One record per session, preferring the most recently active copy, so a
    // target that is missing it gets the best version anyone has.
    const best = new Map();
    for (const rec of usable) {
      for (const entry of rec.entries.values()) {
        if (only && !(entry.cliSessionId && only.has(entry.cliSessionId))) continue;
        const key = entry.cliSessionId || 'record:' + entry.desktopSessionId;
        const prev = best.get(key);
        const at = Date.parse(entry.lastActivityAt || '') || 0;
        if (!prev || at > prev.at) best.set(key, { entry, account: rec.account, at });
      }
    }
    for (const { entry, account } of best.values()) {
      for (const targetRec of usable) {
        if (targetRec.account.accountUuid === account.accountUuid) continue;
        actions.push(classify(entry, account, targetRec, allowTombstoned));
      }
    }
  }

  for (const rec of indexes.values()) {
    if (rec.usable) continue;
    actions.push({
      kind: ACTION.BLOCKED, cliSessionId: null, desktopSessionId: null, title: null,
      projectPath: null, lastActivityAt: null,
      sourceAccount: null,
      targetAccount: { accountUuid: rec.account.accountUuid, label: rec.account.label },
      sourcePath: null, destPath: null,
      reason: rec.account.reason,
    });
  }

  const plan = {
    kind: 'index-sync',
    mode: 'sync-all',
    target: null,
    accounts: accounts.map(brief),
    actions,
    summary: summarize(actions, accounts),
    scopedTo: only ? [...only] : null,
    allowTombstoned,
    note: usable.length < 2
      ? 'At least two accounts with an identified history folder are needed to have anything to combine.'
      : null,
    createdAt: new Date().toISOString(),
  };
  plan.token = safety.registerPlan(plan);
  return plan;
}

/**
 * Plan removing sessions from ONE account's history.
 *
 * This unlinks, it does not delete: the record that makes the session appear
 * in that account's sidebar is removed, and the transcript on disk is not
 * touched at all. Every removed record is copied to the backups folder first,
 * so the removal is recoverable.
 *
 * A tombstone is written alongside, which is how Claude Desktop itself marks a
 * session the user deleted. Without it the next Sync accounts would copy the
 * record straight back from the other account and the removal would not stick.
 */
async function planUnlink(options = {}) {
  const { cliSessionIds = [], accountUuid, sessions = [] } = options;
  if (!accountUuid) throw new safety.SafetyError('an account is required', 'NO_TARGET');

  const accounts = await discovery.listDesktopAccounts(sessions);
  const indexes = readAccountIndexes(accounts);
  const rec = indexes.get(accountUuid);
  if (!rec) throw new safety.SafetyError('that account has no Claude Desktop folder', 'NO_TARGET');
  if (!rec.usable) {
    throw new safety.SafetyError(
      `Cannot tell which folder holds this account's history, so nothing will be removed. ${rec.account.reason}`,
      'HISTORY_ORG_UNRESOLVED');
  }

  const actions = [];
  for (const cliSessionId of cliSessionIds) {
    const entry = rec.byCliSession.get(cliSessionId);
    if (!entry) {
      actions.push({
        kind: ACTION.NOT_PRESENT, cliSessionId, desktopSessionId: null, title: null,
        projectPath: null, lastActivityAt: null,
        sourceAccount: null,
        targetAccount: { accountUuid, label: rec.account.label },
        sourcePath: null, destPath: null,
        reason: 'This account does not list this session, so there is nothing to remove.',
      });
      continue;
    }
    // Which other accounts would still hold it afterwards -- the difference
    // between unlinking from one account and losing the record entirely.
    const alsoIn = [];
    for (const [uuid, other] of indexes) {
      if (uuid === accountUuid || !other.usable) continue;
      if (other.byCliSession.has(cliSessionId)) alsoIn.push(other.account.label);
    }
    actions.push({
      kind: ACTION.REMOVE,
      cliSessionId,
      desktopSessionId: entry.desktopSessionId,
      title: entry.title,
      projectPath: entry.projectPath,
      lastActivityAt: entry.lastActivityAt,
      sourceAccount: null,
      targetAccount: { accountUuid, label: rec.account.label },
      sourcePath: entry.indexPath,
      destPath: entry.indexPath,
      tombstonePath: path.join(rec.account.historyDir, 'deleted_' + bareId(entry.desktopSessionId)),
      alsoIn,
    });
  }

  const plan = {
    kind: 'index-sync',
    mode: 'unlink',
    target: rec.account,
    accounts: accounts.map(brief),
    actions,
    summary: summarize(actions, accounts),
    createdAt: new Date().toISOString(),
  };
  plan.token = safety.registerPlan(plan);
  return plan;
}

function brief(a) {
  return {
    accountUuid: a.accountUuid, label: a.label, isCurrent: a.isCurrent,
    historyOrgUuid: a.historyOrgUuid, historyDir: a.historyDir,
    sessionCount: a.sessionCount, ambiguous: a.ambiguous, reason: a.reason,
  };
}

/**
 * Carry out a previewed plan.
 *
 * Only `copy` actions write, and each one refuses to overwrite. Everything
 * else was a reason not to write and stays that way.
 */
async function execute(planToken, options = {}) {
  const { onProgress } = options;
  const plan = safety.consumePlan(planToken);
  if (plan.kind !== 'index-sync') {
    throw new safety.SafetyError('plan token is not an account-history plan', 'PLAN_MISMATCH');
  }

  const writes = plan.actions.filter((a) => a.kind === ACTION.COPY || a.kind === ACTION.REMOVE);
  const results = [];
  let done = 0;

  for (const a of plan.actions) {
    const res = {
      kind: a.kind, cliSessionId: a.cliSessionId, desktopSessionId: a.desktopSessionId,
      title: a.title, targetAccount: a.targetAccount, destPath: a.destPath,
      applied: null, error: null, backupPath: null,
    };
    if (a.kind === ACTION.REMOVE) {
      try {
        // Copy it out before it goes, so an unlink is always recoverable.
        res.backupPath = await safety.backupFile(a.sourcePath, 'account-history unlink');
        if (fs.existsSync(a.sourcePath)) fs.unlinkSync(a.sourcePath);
        // Claude Desktop's own marker for a session the user removed. Without
        // it the next sync would copy the record back from another account.
        if (a.tombstonePath && !fs.existsSync(a.tombstonePath)) {
          fs.writeFileSync(a.tombstonePath, String(Date.now()), 'utf8');
        }
        res.applied = 'removed';
      } catch (err) {
        res.applied = 'failed';
        res.error = err.message;
      }
      audit.append({
        action: 'account-history-unlink',
        sessionId: a.cliSessionId,
        desktopSessionId: a.desktopSessionId,
        targetAccount: a.targetAccount?.accountUuid ?? null,
        sourcePath: a.sourcePath,
        destPath: null,
        backupPath: res.backupPath ?? null,
        outcome: res.applied,
        error: res.error,
      });
      results.push(res);
      if (onProgress) onProgress({ done: ++done, total: writes.length });
      continue;
    }

    if (a.kind !== ACTION.COPY) {
      res.applied = a.kind === ACTION.BLOCKED ? 'blocked' : 'skipped';
      res.error = a.reason ?? null;
      results.push(res);
      continue;
    }

    try {
      // The record must still be absent: the plan was made a moment ago and
      // Claude Desktop may have written it in the meantime.
      if (fs.existsSync(a.destPath)) {
        res.applied = 'skipped';
        res.error = 'The account gained this record after the preview was taken; it was left alone.';
      } else if (a.newRecordId) {
        // Re-minted: the record must carry the id it is filed under, or
        // Desktop has two files disagreeing about which record this is.
        const body = JSON.parse(fs.readFileSync(a.sourcePath, 'utf8'));
        body.sessionId = a.newRecordId;
        await safety.writeFileAtomic(a.destPath, JSON.stringify(body), {
          allowOverwrite: false,
          reason: 'account-history ' + plan.mode + ' (new record id)',
        });
        res.newRecordId = a.newRecordId;
        res.applied = 'written';
      } else {
        await safety.copyFileAtomic(a.sourcePath, a.destPath, {
          allowOverwrite: false,
          reason: 'account-history ' + plan.mode,
        });
        // Restoring a session the account had deleted: the marker has to go
        // too, or Desktop keeps treating it as deleted and the next plan
        // would call it tombstoned all over again. Backed up first.
        if (a.wasTombstoned && a.tombstonePath && fs.existsSync(a.tombstonePath)) {
          res.backupPath = await safety.backupFile(a.tombstonePath, 'account-history restore');
          fs.unlinkSync(a.tombstonePath);
          res.clearedTombstone = true;
        }
        res.applied = 'written';
      }
    } catch (err) {
      res.applied = 'failed';
      res.error = err.message;
    }

    audit.append({
      action: 'account-history-' + plan.mode,
      sessionId: a.cliSessionId,
      desktopSessionId: a.desktopSessionId,
      sourceAccount: a.sourceAccount?.accountUuid ?? null,
      targetAccount: a.targetAccount?.accountUuid ?? null,
      sourcePath: a.sourcePath,
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
      written: results.filter((r) => r.applied === 'written').length,
      removed: results.filter((r) => r.applied === 'removed').length,
      skipped: results.filter((r) => r.applied === 'skipped').length,
      blocked: results.filter((r) => r.applied === 'blocked').length,
      failed: results.filter((r) => r.applied === 'failed').length,
    },
  };
}

module.exports = { planMigrate, planSyncAll, planUnlink, execute, readAccountIndexes, ACTION };
