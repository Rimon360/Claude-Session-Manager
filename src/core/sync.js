'use strict';
/**
 * Same-machine multi-account sync ("Sync All") and cross-device migration.
 *
 * Sync All unions every session across every detected account of one tool by
 * content hash, then writes the combined superset back to each account so all
 * of them end up holding the full history.
 *
 * The union is by CONTENT, not by session id. Two accounts that hold the same
 * conversation under different ids should not produce two copies, and two
 * genuinely different conversations that happen to share an id must not be
 * collapsed into one. Anything that diverges is never resolved automatically:
 * it is surfaced for the merge screen.
 */
const fs = require('fs');
const path = require('path');
const discovery = require('./discovery');
const merge = require('./merge');
const safety = require('./safety');
const audit = require('./audit');
const bundle = require('./bundle');

/**
 * Plan a sync across all accounts of one tool.
 *
 * Every session in every account is parsed so the union can be computed on
 * real content hashes. For a large installation this is the expensive path --
 * it is a deliberate trade, because a union computed from file sizes or ids
 * would be wrong in exactly the cases that matter.
 */
async function planSync(toolName, options = {}) {
  const { onProgress, includeDamaged = false, accountRoots = null } = options;
  const scan = await discovery.scanAll();
  const available = scan.tools.filter((t) => t.tool === toolName && t.hasSessions);

  // `accountRoots` restricts the sync to a chosen subset, so you can combine
  // A and B while leaving C completely alone. Omit it and every detected
  // account takes part.
  let accounts = available;
  const unmatched = [];
  if (Array.isArray(accountRoots) && accountRoots.length) {
    const want = new Map(accountRoots.map((r) => [path.resolve(String(r)).toLowerCase(), String(r)]));
    accounts = available.filter((a) => want.delete(path.resolve(a.root).toLowerCase()));
    // A requested account we cannot see is reported, never quietly dropped --
    // silently syncing fewer accounts than asked for is how you end up
    // believing a machine is up to date when it is not.
    for (const original of want.values()) unmatched.push(original);
  }

  const excluded = available
    .filter((a) => !accounts.includes(a))
    .map((a) => ({ id: a.accountId?.id, label: a.accountId?.label, root: a.root }));

  const describe = (a) => ({ id: a.accountId?.id, label: a.accountId?.label, root: a.root, sessionCount: a.sessionCount });

  if (unmatched.length) {
    return {
      kind: 'sync',
      tool: toolName,
      accounts: accounts.map(describe),
      excluded,
      unmatched,
      actions: [],
      conflicts: [],
      summary: { copy: 0, conflict: 0, blocked: 0, alreadyEverywhere: 0 },
      note:
        `These account folders were requested but not found: ${unmatched.join(', ')}. ` +
        'Nothing was planned — check the paths and try again.',
      createdAt: new Date().toISOString(),
    };
  }

  if (accounts.length < 2) {
    const scoped = Array.isArray(accountRoots) && accountRoots.length;
    return {
      kind: 'sync',
      tool: toolName,
      accounts: accounts.map(describe),
      excluded,
      unmatched,
      actions: [],
      conflicts: [],
      summary: { copy: 0, conflict: 0, blocked: 0, alreadyEverywhere: 0 },
      note: accounts.length === 0
        ? (scoped
          ? 'No accounts were selected. Choose at least two to combine.'
          : `No ${toolName} installation with sessions was found.`)
        : (scoped
          ? `Only one account is selected (${accounts[0].root}). Choose at least two to have anything to combine.`
          : `Only one ${toolName} account/profile was found (${accounts[0].root}). Sync needs at least two to have anything to combine.`),
      createdAt: new Date().toISOString(),
    };
  }

  // Load every session in every account.
  const loaded = [];   // { account, entry, session }
  let total = accounts.reduce((a, t) => a + t.sessions.length, 0), done = 0;
  for (const acct of accounts) {
    for (const entry of acct.sessions) {
      if (!includeDamaged && (entry.integrity === 'damaged' || entry.integrity === 'unreadable')) {
        loaded.push({ account: acct, entry, session: null, blocked: `source is ${entry.integrity}` });
        if (onProgress) onProgress({ done: ++done, total });
        continue;
      }
      try {
        const { session } = await discovery.loadSession(entry, { includeRawRows: false });
        loaded.push({ account: acct, entry, session });
      } catch (err) {
        loaded.push({ account: acct, entry, session: null, blocked: err.message });
      }
      if (onProgress) onProgress({ done: ++done, total });
    }
  }

  // Union by content hash.
  const byHash = new Map();
  for (const item of loaded) {
    if (!item.session) continue;
    const h = item.session.contentHash;
    if (!byHash.has(h)) byHash.set(h, []);
    byHash.get(h).push(item);
  }

  const actions = [];
  const conflicts = [];

  for (const [hash, holders] of byHash) {
    const holderAccounts = new Set(holders.map((h) => h.account.root));
    const missing = accounts.filter((a) => !holderAccounts.has(a.root));
    const source = holders[0];

    if (!missing.length) {
      actions.push({
        kind: 'already-everywhere',
        contentHash: hash,
        sessionId: source.entry.sessionId,
        title: source.entry.title ?? null,
        presentIn: [...holderAccounts],
      });
      continue;
    }

    for (const dest of missing) {
      // Does the destination already hold a session with this id but different content?
      const collision = loaded.find(
        (l) => l.account.root === dest.root && l.entry.sessionId === source.entry.sessionId && l.session && l.session.contentHash !== hash
      );

      if (collision) {
        const cmp = merge.compareSessions(collision.session, source.session);
        const conflict = {
          kind: 'conflict',
          contentHash: hash,
          sessionId: source.entry.sessionId,
          title: source.entry.title ?? null,
          sourceAccount: { root: source.account.root, label: source.account.accountId?.label },
          destAccount: { root: dest.root, label: dest.accountId?.label },
          sourcePath: source.entry.filePath,
          destPath: collision.entry.filePath,
          comparison: cmp,
          recommendation: merge.recommend(cmp),
          diff: merge.diffPreview(collision.session, source.session, cmp),
        };
        conflicts.push(conflict);
        actions.push(conflict);
      } else {
        const rel = path.relative(source.account.root, source.entry.filePath);
        actions.push({
          kind: 'copy',
          contentHash: hash,
          sessionId: source.entry.sessionId,
          title: source.entry.title ?? null,
          messageCount: source.session.messages.length,
          sizeBytes: source.entry.sizeBytes,
          sourceAccount: { root: source.account.root, label: source.account.accountId?.label },
          destAccount: { root: dest.root, label: dest.accountId?.label },
          sourcePath: source.entry.filePath,
          destPath: path.join(dest.root, rel),
          subAgentFiles: source.entry.subAgentFiles ?? [],
          sidecars: source.entry.sidecars ?? [],
          sourceRoot: source.account.root,
        });
      }
    }
  }

  for (const item of loaded) {
    if (item.blocked) {
      actions.push({
        kind: 'blocked',
        sessionId: item.entry.sessionId,
        account: item.account.root,
        reason: item.blocked,
        sourcePath: item.entry.filePath,
      });
    }
  }

  const plan = {
    kind: 'sync',
    tool: toolName,
    accounts: accounts.map((a) => ({ id: a.accountId?.id, label: a.accountId?.label, root: a.root, sessionCount: a.sessionCount })),
    // Accounts deliberately left out of this sync. Surfaced so the preview can
    // say plainly which ones will not be touched.
    excluded,
    unmatched,
    actions,
    conflicts,
    summary: {
      copy: actions.filter((a) => a.kind === 'copy').length,
      conflict: conflicts.length,
      blocked: actions.filter((a) => a.kind === 'blocked').length,
      alreadyEverywhere: actions.filter((a) => a.kind === 'already-everywhere').length,
      uniqueSessions: byHash.size,
    },
    createdAt: new Date().toISOString(),
  };
  plan.token = safety.registerPlan(plan);
  return plan;
}

/**
 * Execute a previewed sync. Copies are raw byte copies (lossless). Conflicts
 * are applied only where an explicit resolution was chosen.
 */
async function executeSync(planToken, resolutions = {}) {
  const plan = safety.consumePlan(planToken);
  if (plan.kind !== 'sync') throw new safety.SafetyError('plan token is not a sync plan', 'PLAN_MISMATCH');

  const results = [];
  for (const action of plan.actions) {
    const res = { sessionId: action.sessionId, kind: action.kind, applied: null, destPath: action.destPath ?? null, backupPath: null, error: null };
    try {
      if (action.kind === 'already-everywhere') {
        res.applied = 'no-op';
      } else if (action.kind === 'blocked') {
        res.applied = 'blocked';
        res.error = action.reason;
      } else if (action.kind === 'copy') {
        const out = await safety.copyFileAtomic(action.sourcePath, action.destPath, { allowOverwrite: false, reason: 'sync-all' });
        res.backupPath = out.backupPath;
        res.applied = 'copied';
        // Sub-agent transcripts and sidecars follow the session.
        for (const sub of (action.subAgentFiles || []).concat(action.sidecars || [])) {
          if (!sub.filePath || sub.isDirectory || !fs.existsSync(sub.filePath)) continue;
          const rel = path.relative(action.sourceRoot, sub.filePath);
          const dest = path.join(action.destAccount.root, rel);
          if (fs.existsSync(dest)) continue;
          await safety.copyFileAtomic(sub.filePath, dest, { allowOverwrite: false, reason: 'sync-all sidecar' });
        }
      } else if (action.kind === 'conflict') {
        const choice = resolutions[conflictKey(action)];
        if (!choice || choice === merge.RESOLUTION.SKIP) {
          res.applied = 'skipped-unresolved';
          res.error = choice ? null : 'No resolution chosen; both copies left untouched.';
        } else if (choice === merge.RESOLUTION.KEEP_EXISTING) {
          res.applied = 'kept-existing';
        } else if (choice === merge.RESOLUTION.KEEP_INCOMING) {
          const out = await safety.copyFileAtomic(action.sourcePath, action.destPath, { allowOverwrite: true, reason: 'sync-all keep-incoming' });
          res.backupPath = out.backupPath;
          res.applied = 'overwritten';
        } else if (choice === merge.RESOLUTION.KEEP_NEWER) {
          if (action.comparison?.newer === 'b') {
            const out = await safety.copyFileAtomic(action.sourcePath, action.destPath, { allowOverwrite: true, reason: 'sync-all keep-newer' });
            res.backupPath = out.backupPath;
            res.applied = 'overwritten-newer';
          } else {
            res.applied = 'kept-existing-newer';
          }
        } else if (choice === merge.RESOLUTION.KEEP_BOTH) {
          const dest = suffixPath(action.destPath, 'from-' + path.basename(action.sourceAccount.root));
          const out = await safety.copyFileAtomic(action.sourcePath, dest, { allowOverwrite: false, reason: 'sync-all keep-both' });
          res.destPath = dest;
          res.backupPath = out.backupPath;
          res.applied = 'written-alongside';
        }
      }
    } catch (err) {
      res.applied = 'failed';
      res.error = err.message;
    }

    audit.append({
      action: 'sync',
      tool: plan.tool,
      sessionId: action.sessionId,
      kind: action.kind,
      outcome: res.applied,
      sourcePath: action.sourcePath ?? null,
      destPath: res.destPath,
      backupPath: res.backupPath,
      resolution: action.kind === 'conflict' ? (resolutions[conflictKey(action)] ?? null) : null,
      error: res.error,
    });
    results.push(res);
  }
  return { results, plan };
}

function conflictKey(action) {
  return `${action.sessionId}@${action.destAccount?.root ?? ''}`;
}

function suffixPath(p, suffix) {
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const base = path.basename(p, ext);
  const clean = String(suffix).replace(/[^A-Za-z0-9_-]/g, '-');
  return path.join(dir, `${base}--${clean}${ext}`);
}

/* -------------------------------------------------- Cross-device migration */

/**
 * Migration is export + import with account-id remapping in between. No
 * network is involved: the user moves the bundle themselves.
 *
 * The remap strips identifiers that are specific to the source account so they
 * cannot collide with the destination account's own numbering. We rewrite only
 * the normalized copy's accountId; the raw files stay untouched, because
 * rewriting bytes inside a raw transcript is precisely the kind of "helpful"
 * edit that loses data.
 */
async function planMigration(entries, destZipPath, options = {}) {
  const result = await bundle.exportBundle(entries, destZipPath, {
    ...options,
    note: options.note || 'cross-device migration bundle',
  });
  audit.append({ action: 'migration-export', destination: destZipPath, sessionCount: entries.length });
  return {
    kind: 'migration-export',
    zipPath: destZipPath,
    bytes: result.bytes,
    sessionCount: result.manifest.sessions.length,
    warnings: result.manifest.warnings,
    nextStep:
      'Move this file to the target machine by whatever means you prefer (USB, cloud drive, email), then use Import there. ' +
      'Nothing was sent anywhere by this app.',
  };
}

/**
 * Import side of a migration: same as a normal import, but source account ids
 * in the normalized copies are replaced with the destination account's id so
 * two machines' numbering cannot collide.
 */
async function planMigrationImport(zipPath, options = {}) {
  const scan = await discovery.detectTools();
  const plan = await bundle.planImport(zipPath, options);
  plan.kind = 'import';
  plan.migration = true;
  plan.accountRemap = scan.map((t) => ({ tool: t.tool, destAccountId: t.accountId?.id ?? null, destAccountLabel: t.accountId?.label ?? null, root: t.root }));
  return plan;
}

module.exports = { planSync, executeSync, planMigration, planMigrationImport, conflictKey };
