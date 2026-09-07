'use strict';
/**
 * Fixture builders.
 *
 * The corruption fixtures here are modelled on damage actually observed on a
 * real installation -- in particular the case where a record is broken across
 * physical lines by unescaped newlines inside a string value.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function tmpDir(name) {
  const dir = path.join(os.tmpdir(), 'aism-test', name + '-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/* -------------------------------------------------- Claude Code fixtures */

let uuidCounter = 0;
function seqUuid(seed) {
  uuidCounter++;
  const h = crypto.createHash('sha1').update(String(seed ?? '') + ':' + uuidCounter).digest('hex');
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join('-');
}

/**
 * Build a Claude Code transcript.
 *
 * `splitTurns` reproduces the 2.1+ behaviour where one assistant turn is
 * spread over several rows that share a message.id but carry different content
 * blocks -- the case where deduping by id alone silently drops content.
 */
function claudeTranscript(options = {}) {
  const {
    sessionId = seqUuid('cc'),
    cwd = 'F:\\projects\\demo',
    model = 'claude-opus-5',
    exchanges = 3,
    splitTurns = false,
    startTime = Date.parse('2026-01-01T10:00:00Z'),
  } = options;

  const rows = [];
  let parent = null;
  let t = startTime;
  const push = (row) => {
    const u = seqUuid(sessionId);
    rows.push({ parentUuid: parent, isSidechain: false, userType: 'external', cwd, sessionId, version: '2.1.0', uuid: u, timestamp: new Date(t).toISOString(), ...row });
    parent = u;
    t += 1000;
  };

  for (let i = 0; i < exchanges; i++) {
    push({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `question ${i}` }] } });

    const msgId = 'msg_' + crypto.createHash('md5').update(sessionId + i).digest('hex').slice(0, 20);
    if (splitTurns) {
      // Same message.id across three rows, each with distinct content.
      push({ type: 'assistant', message: { id: msgId, role: 'assistant', model, content: [{ type: 'thinking', thinking: `reasoning ${i}`, signature: 'sig' }] } });
      push({ type: 'assistant', message: { id: msgId, role: 'assistant', model, content: [{ type: 'text', text: `answer ${i}` }] } });
      push({ type: 'assistant', message: { id: msgId, role: 'assistant', model, content: [{ type: 'tool_use', id: `toolu_${i}`, name: 'Read', input: { file: `f${i}.txt` } }] } });
    } else {
      push({ type: 'assistant', message: { id: msgId, role: 'assistant', model, content: [
        { type: 'text', text: `answer ${i}` },
        { type: 'tool_use', id: `toolu_${i}`, name: 'Read', input: { file: `f${i}.txt` } },
      ] } });
    }
    push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, content: `contents of f${i}` }] } });
    // Non-message rows that must survive round trips without being parsed as content.
    push({ type: 'ai-title', title: `Session about ${i}` });
  }
  return rows;
}

function writeJsonl(filePath, rows, options = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let text = rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n');
  if (options.trailingNewline !== false) text += '\n';
  fs.writeFileSync(filePath, text, 'utf8');
  return filePath;
}

/* --------------------------------------------------- corruption helpers */

/** Cut the file mid-line, as if the writer died while appending. */
function truncateFile(filePath, fraction = 0.7) {
  const buf = fs.readFileSync(filePath);
  const cut = Math.max(1, Math.floor(buf.length * fraction));
  fs.writeFileSync(filePath, buf.subarray(0, cut));
  return filePath;
}

/** Replace an interior line with malformed JSON. */
function corruptLine(filePath, lineNo, replacement = '{"type":"assistant","message":{BROKEN') {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  if (lineNo < lines.length) lines[lineNo] = replacement;
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  return filePath;
}

/**
 * Reproduce a real observed failure: a record containing a raw newline inside a
 * string value, so one logical record spans two physical lines and neither half
 * is valid JSON on its own.
 */
function splitRecordAcrossLines(filePath, lineNo) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  if (lineNo >= lines.length) return filePath;
  const original = lines[lineNo];
  const mid = Math.floor(original.length / 2);
  lines[lineNo] = original.slice(0, mid) + '\n' + original.slice(mid);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  return filePath;
}

/** A file that exists but holds almost nothing -- the "lost content" stub. */
function stubFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{"type":"user","message":{"role":"user","content":[]}}\n', 'utf8');
  return filePath;
}

/* -------------------------------------------------------- tree builders */

/** A minimal Claude Code root that discovery can walk. */
function claudeRoot(base, options = {}) {
  const root = path.join(base, '.claude');
  const projectDir = options.projectDir || 'F--projects-demo';
  fs.mkdirSync(path.join(root, 'projects', projectDir), { recursive: true });
  fs.writeFileSync(path.join(base, '.claude.json'), JSON.stringify({
    userID: options.userId || 'test-user-1',
    oauthAccount: { accountUuid: options.accountUuid || 'acct-1111', emailAddress: options.email || 'test@example.com' },
  }), 'utf8');
  return { root, projectsDir: path.join(root, 'projects', projectDir) };
}

module.exports = {
  tmpDir, rmrf, seqUuid, writeJsonl,
  claudeTranscript,
  truncateFile, corruptLine, splitRecordAcrossLines, stubFile,
  claudeRoot,
};
