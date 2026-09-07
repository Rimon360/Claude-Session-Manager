'use strict';
/**
 * Append-only local audit log.
 *
 * Every merge decision, import, overwrite and sync is recorded with enough
 * detail to answer "what happened to my session, and where did the old bytes
 * go" after the fact. Entries reference the backup path produced by safety.js,
 * which is what makes an action reversible.
 */
const fs = require('fs');
const path = require('path');
const paths = require('./paths');

function append(entry) {
  const record = {
    at: new Date().toISOString(),
    pid: process.pid,
    ...entry,
  };
  const line = JSON.stringify(record) + '\n';
  const file = paths.auditLogPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line, 'utf8');
  } catch (err) {
    // The audit log must never take down the operation it is recording, but a
    // failure to record is itself worth surfacing.
    process.emitWarning(`audit log write failed: ${err.message}`);
  }
  return record;
}

/** Read the most recent entries, newest first. */
function read(limit = 200) {
  const file = paths.auditLogPath();
  if (!fs.existsSync(file)) return [];
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const t = lines[i].trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { out.push({ at: null, action: 'unparseable-audit-line', raw: t.slice(0, 200) }); }
  }
  return out;
}

module.exports = { append, read };
