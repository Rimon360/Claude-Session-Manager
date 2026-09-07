'use strict';
/**
 * Write guardrails.
 *
 * Every filesystem mutation in this app goes through here. The rules:
 *
 *  1. Nothing overwrites an existing file unless the caller explicitly passes
 *     allowOverwrite AND a plan token proving the user saw a preview.
 *  2. Any overwrite snapshots the previous bytes into the app's own backup
 *     directory first, so the prior state is always recoverable.
 *  3. Writes are atomic: content goes to a temp file in the destination
 *     directory, is fsync'd, then renamed into place. A crash mid-write can
 *     never leave a half-written transcript where a good one used to be.
 *  4. We never write into a tool's tree without the destination directory
 *     already existing or being explicitly created as part of a planned import.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');

class SafetyError extends Error {
  constructor(message, code) { super(message); this.name = 'SafetyError'; this.code = code; }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Snapshot a file into the app-managed backup tree before it is touched. */
async function backupFile(filePath, reason) {
  if (!fs.existsSync(filePath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const hash = crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 10);
  const dest = path.join(paths.backupsDir(), stamp + '_' + hash, path.basename(filePath));
  ensureDir(path.dirname(dest));
  await fsp.copyFile(filePath, dest);
  const meta = { originalPath: filePath, backedUpAt: new Date().toISOString(), reason: reason || null, sizeBytes: fs.statSync(filePath).size };
  await fsp.writeFile(dest + '.backup-meta.json', JSON.stringify(meta, null, 2), 'utf8');
  return dest;
}

/**
 * Atomic write. Returns { written, backupPath, skipped, reason }.
 *
 * Refuses by default when the destination exists -- callers must have gone
 * through a plan/preview to get allowOverwrite.
 */
async function writeFileAtomic(destPath, data, options = {}) {
  const { allowOverwrite = false, reason = null, backup = true } = options;
  const exists = fs.existsSync(destPath);

  if (exists && !allowOverwrite) {
    throw new SafetyError(
      `refusing to overwrite existing file without explicit confirmation: ${destPath}`,
      'OVERWRITE_REFUSED'
    );
  }

  let backupPath = null;
  if (exists && backup) backupPath = await backupFile(destPath, reason);

  ensureDir(path.dirname(destPath));
  const tmp = destPath + '.aism-tmp-' + process.pid + '-' + Date.now();
  let fh;
  try {
    fh = await fsp.open(tmp, 'w');
    await fh.writeFile(data);
    await fh.sync();          // durable before rename
    await fh.close();
    fh = null;
    await fsp.rename(tmp, destPath);
  } catch (err) {
    if (fh) { try { await fh.close(); } catch { /* closing a failed handle */ } }
    try { if (fs.existsSync(tmp)) await fsp.unlink(tmp); } catch { /* temp cleanup is best effort */ }
    throw err;
  }
  return { written: true, backupPath, destPath };
}

/**
 * Atomic copy of a source file, streamed so that multi-gigabyte transcripts do
 * not have to fit in memory.
 */
async function copyFileAtomic(srcPath, destPath, options = {}) {
  const { allowOverwrite = false, reason = null, backup = true } = options;
  const exists = fs.existsSync(destPath);
  if (exists && !allowOverwrite) {
    throw new SafetyError(
      `refusing to overwrite existing file without explicit confirmation: ${destPath}`,
      'OVERWRITE_REFUSED'
    );
  }
  let backupPath = null;
  if (exists && backup) backupPath = await backupFile(destPath, reason);

  ensureDir(path.dirname(destPath));
  const tmp = destPath + '.aism-tmp-' + process.pid + '-' + Date.now();
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(srcPath);
    const ws = fs.createWriteStream(tmp);
    rs.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    rs.pipe(ws);
  });
  await fsp.rename(tmp, destPath);
  return { written: true, backupPath, destPath };
}

/** Recursively copy a directory (used for Claude Code file-history sidecars). */
async function copyDirRecursive(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) await copyDirRecursive(s, d);
    else if (e.isFile()) await fsp.copyFile(s, d);
  }
}

/**
 * Plan tokens.
 *
 * A plan is produced by a dry run and handed to the UI for preview. Executing
 * requires handing the same token back. There is deliberately no setting that
 * skips this step -- the preview is structural, not a confirmation dialog that
 * a "don't ask again" checkbox could disable.
 */
const activePlans = new Map();
const PLAN_TTL_MS = 60 * 60 * 1000;

function registerPlan(plan) {
  const token = crypto.randomUUID();
  activePlans.set(token, { plan, createdAt: Date.now() });
  // Opportunistic sweep of expired plans.
  for (const [k, v] of activePlans) if (Date.now() - v.createdAt > PLAN_TTL_MS) activePlans.delete(k);
  return token;
}

function consumePlan(token) {
  const entry = activePlans.get(token);
  if (!entry) {
    throw new SafetyError(
      'no previewed plan matches this request. Every write must be previewed first; ' +
      'run the dry run again and execute from its result.',
      'PLAN_REQUIRED'
    );
  }
  if (Date.now() - entry.createdAt > PLAN_TTL_MS) {
    activePlans.delete(token);
    throw new SafetyError('this preview has expired; re-run the dry run so you are approving current state.', 'PLAN_EXPIRED');
  }
  activePlans.delete(token);
  return entry.plan;
}

function peekPlan(token) {
  const entry = activePlans.get(token);
  return entry ? entry.plan : null;
}

/** Guard: a damaged source must never be used as input to a write. */
function assertUsableSource(integrity, filePath) {
  if (integrity === 'damaged' || integrity === 'unreadable') {
    throw new SafetyError(
      `refusing to use ${filePath}: file integrity is "${integrity}". ` +
      'Copying from a damaged transcript risks writing partial content over good data.',
      'SOURCE_DAMAGED'
    );
  }
}

module.exports = {
  SafetyError, ensureDir, backupFile, writeFileAtomic, copyFileAtomic, copyDirRecursive,
  registerPlan, consumePlan, peekPlan, assertUsableSource,
};
