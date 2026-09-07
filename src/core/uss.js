'use strict';
/**
 * The Universal Session Schema (USS).
 *
 * Every native format is parsed INTO this shape and every exporter writes FROM
 * it, so the number of converters stays linear (one parser + one exporter per
 * tool) rather than quadratic.
 */
const crypto = require('crypto');

const SCHEMA_VERSION = 1;

const SOURCE_TOOLS = ['claude-code'];
const ROLES = ['user', 'assistant', 'system', 'tool'];
const MESSAGE_TYPES = ['text', 'thinking', 'tool_use', 'tool_result'];

function emptySession(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    sourceTool: null,
    sessionId: null,
    accountId: null,
    projectPath: null,
    model: null,
    createdAt: null,
    updatedAt: null,
    contentHash: null,
    messages: [],
    meta: {},
    ...overrides,
  };
}

function makeMessage(overrides = {}) {
  return {
    id: null,
    parentId: null,
    role: 'user',
    type: 'text',
    text: null,
    toolName: null,
    toolInput: null,
    toolOutput: null,
    timestamp: null,
    ...overrides,
  };
}

/**
 * Deterministic JSON: object keys sorted recursively so that two structurally
 * identical values always serialize to the same string. Required for hashing
 * and for the split-turn dedupe key, where key order out of JSON.parse is
 * stable per-file but must not be relied on across files.
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/**
 * Normalized content hash.
 *
 * Deliberately excludes: message ids, parent ids, timestamps, absolute paths,
 * account ids and every `meta` field. Those legitimately differ between two
 * copies of the same conversation (different machine, different account,
 * re-imported file), and if they fed the hash then dedupe and "already have
 * this" detection would never fire.
 *
 * Included: the ordered sequence of who said what, of which kind, with which
 * tool inputs and outputs. Two sessions with the same content hash are the
 * same conversation.
 */
function computeContentHash(messages) {
  const h = crypto.createHash('sha256');
  h.update('uss-v' + SCHEMA_VERSION + '\n');
  for (const m of messages || []) {
    h.update(
      stableStringify({
        role: m.role ?? null,
        type: m.type ?? null,
        text: normalizeText(m.text),
        toolName: m.toolName ?? null,
        toolInput: m.toolInput ?? null,
        toolOutput: m.toolOutput ?? null,
      })
    );
    h.update('\n');
  }
  return 'sha256:' + h.digest('hex');
}

/**
 * Incremental version of computeContentHash.
 *
 * A 1-2GB transcript cannot be parsed into an in-memory message array just to
 * compute a hash, so large sessions are hashed as they stream: each message is
 * folded in and then discarded. The digest is identical to what
 * computeContentHash would produce for the same sequence, which is what lets a
 * streamed export and a fully-parsed one compare equal.
 */
function createContentHasher() {
  const h = crypto.createHash('sha256');
  h.update('uss-v' + SCHEMA_VERSION + '\n');
  let count = 0;
  return {
    update(m) {
      h.update(
        stableStringify({
          role: m.role ?? null,
          type: m.type ?? null,
          text: normalizeText(m.text),
          toolName: m.toolName ?? null,
          toolInput: m.toolInput ?? null,
          toolOutput: m.toolOutput ?? null,
        })
      );
      h.update('\n');
      count++;
    },
    get count() { return count; },
    digest() { return 'sha256:' + h.digest('hex'); },
  };
}

/**
 * Line endings and trailing whitespace differ between a file written on
 * Windows and the same conversation written on macOS; that must not make two
 * copies look like different conversations.
 */
function normalizeText(text) {
  if (text === null || text === undefined) return null;
  const s = typeof text === 'string' ? text : String(text);
  return s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

/**
 * Per-message hashes, used by the merge engine to find the exact point at
 * which two versions of a session diverge.
 */
function messageHashes(messages) {
  return (messages || []).map((m) =>
    crypto
      .createHash('sha256')
      .update(
        stableStringify({
          role: m.role ?? null,
          type: m.type ?? null,
          text: normalizeText(m.text),
          toolName: m.toolName ?? null,
          toolInput: m.toolInput ?? null,
          toolOutput: m.toolOutput ?? null,
        })
      )
      .digest('hex')
      .slice(0, 16)
  );
}

/** Recompute and attach the content hash. Always call before persisting. */
function finalize(session) {
  session.schemaVersion = SCHEMA_VERSION;
  session.contentHash = computeContentHash(session.messages);
  if (!session.createdAt || !session.updatedAt) {
    const stamps = session.messages.map((m) => m.timestamp).filter(Boolean).sort();
    if (!session.createdAt && stamps.length) session.createdAt = stamps[0];
    if (!session.updatedAt && stamps.length) session.updatedAt = stamps[stamps.length - 1];
  }
  return session;
}

/**
 * Structural validation. Returns a list of problems; an empty list means the
 * object is a well-formed USS session. This runs on every import before
 * anything is written, so a malformed bundle cannot reach the filesystem.
 */
function validate(session) {
  const problems = [];
  const err = (path, message) => problems.push({ path, message });

  if (!session || typeof session !== 'object') {
    err('$', 'session is not an object');
    return problems;
  }
  if (session.schemaVersion !== SCHEMA_VERSION) {
    err('schemaVersion', `expected ${SCHEMA_VERSION}, got ${JSON.stringify(session.schemaVersion)}`);
  }
  if (!SOURCE_TOOLS.includes(session.sourceTool)) {
    err('sourceTool', `unknown source tool ${JSON.stringify(session.sourceTool)}`);
  }
  if (typeof session.sessionId !== 'string' || !session.sessionId) {
    err('sessionId', 'missing or non-string sessionId');
  }
  if (!Array.isArray(session.messages)) {
    err('messages', 'messages must be an array');
    return problems;
  }
  session.messages.forEach((m, i) => {
    if (!m || typeof m !== 'object') { err(`messages[${i}]`, 'not an object'); return; }
    if (!ROLES.includes(m.role)) err(`messages[${i}].role`, `invalid role ${JSON.stringify(m.role)}`);
    if (!MESSAGE_TYPES.includes(m.type)) err(`messages[${i}].type`, `invalid type ${JSON.stringify(m.type)}`);
  });

  if (session.contentHash) {
    const recomputed = computeContentHash(session.messages);
    if (recomputed !== session.contentHash) {
      err('contentHash', `stored hash does not match content (stored ${session.contentHash}, computed ${recomputed})`);
    }
  }
  return problems;
}

/** Short human summary used across the UI and in export manifests. */
function summarize(session) {
  const counts = { user: 0, assistant: 0, system: 0, tool: 0 };
  let chars = 0;
  for (const m of session.messages || []) {
    if (counts[m.role] !== undefined) counts[m.role]++;
    if (typeof m.text === 'string') chars += m.text.length;
  }
  return {
    messageCount: (session.messages || []).length,
    roleCounts: counts,
    textChars: chars,
    firstUserText: (session.messages || []).find((m) => m.role === 'user' && m.text)?.text?.slice(0, 200) ?? null,
  };
}

module.exports = {
  SCHEMA_VERSION, SOURCE_TOOLS, ROLES, MESSAGE_TYPES,
  emptySession, makeMessage, stableStringify, computeContentHash, createContentHasher,
  messageHashes, normalizeText, finalize, validate, summarize,
};
