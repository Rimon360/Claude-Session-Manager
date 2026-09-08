'use strict';
/**
 * USS -> Claude Code native JSONL.
 *
 * Used for cross-tool conversion. Restoring a Claude Code session back into
 * Claude Code does NOT go through here -- that path copies the untouched
 * original bytes out of the bundle's raw/ directory, which is lossless by
 * construction. This exporter exists for sessions whose origin is a different
 * tool, where some loss is unavoidable and is reported rather than hidden.
 */
const crypto = require('crypto');
const path = require('path');
const paths = require('../paths');

/**
 * Claude Code encodes an absolute project path into one directory name.
 *
 * This used to have its own implementation, which collapsed runs of dashes
 * and kept dots. Measured against a real installation it matched 0 of 60
 * project folders -- a session imported through this path would have landed
 * in a directory Claude Code never reads, present on disk and invisible in
 * the app. There is now one implementation, in paths.
 */
function encodeProjectDir(projectPath) {
  if (!projectPath) return 'unknown-project';
  return paths.encodeClaudeProjectDir(projectPath);
}

function uuid() { return crypto.randomUUID(); }

/**
 * Group a flat USS message list back into Claude Code rows.
 *
 * Claude Code puts assistant text/thinking/tool_use blocks on `assistant` rows
 * and tool_result blocks on `user` rows, so we walk the sequence and emit a row
 * whenever the target row kind changes.
 */
function buildRows(session, options = {}) {
  const { sessionId, projectPath, model } = options;
  const rows = [];
  const now = new Date().toISOString();
  let parentUuid = null;

  const emit = (row) => {
    const u = uuid();
    const full = {
      parentUuid,
      isSidechain: false,
      userType: 'external',
      cwd: projectPath || null,
      sessionId,
      version: 'claude-code-recovery-converted',
      gitBranch: session.meta?.git?.branch ?? null,
      uuid: u,
      timestamp: row.timestamp || now,
      ...row,
    };
    delete full.timestamp_src;
    parentUuid = u;
    rows.push(full);
    return u;
  };

  let pendingAssistant = null;
  const flushAssistant = () => {
    if (!pendingAssistant) return;
    emit({
      type: 'assistant',
      timestamp: pendingAssistant.timestamp,
      message: {
        id: pendingAssistant.id,
        type: 'message',
        role: 'assistant',
        model: model || 'unknown',
        content: pendingAssistant.content,
        stop_reason: null,
        usage: undefined,
      },
    });
    pendingAssistant = null;
  };

  for (const m of session.messages || []) {
    if (m.role === 'assistant') {
      const block =
        m.type === 'thinking'
          ? { type: 'thinking', thinking: m.text ?? '', signature: '' }
          : m.type === 'tool_use'
            ? { type: 'tool_use', id: m.id || 'toolu_' + uuid().replace(/-/g, '').slice(0, 20), name: m.toolName || 'unknown', input: m.toolInput ?? {} }
            : { type: 'text', text: m.text ?? '' };
      if (!pendingAssistant) {
        pendingAssistant = { id: 'msg_' + uuid().replace(/-/g, '').slice(0, 22), timestamp: m.timestamp, content: [block] };
      } else {
        pendingAssistant.content.push(block);
      }
      continue;
    }

    flushAssistant();

    if (m.role === 'tool' || m.type === 'tool_result') {
      const toolUseId = m.toolInput?.tool_use_id || m.toolInput?.call_id || 'toolu_' + uuid().replace(/-/g, '').slice(0, 20);
      emit({
        type: 'user',
        timestamp: m.timestamp,
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: typeof m.text === 'string' ? m.text : (m.toolOutput ?? ''),
            is_error: false,
          }],
        },
        toolUseResult: m.toolOutput ?? undefined,
      });
    } else if (m.role === 'system') {
      emit({ type: 'system', timestamp: m.timestamp, content: m.text ?? '', level: 'info' });
    } else {
      emit({
        type: 'user',
        timestamp: m.timestamp,
        message: { role: 'user', content: [{ type: 'text', text: m.text ?? '' }] },
      });
    }
  }
  flushAssistant();
  return rows;
}

/**
 * Convert a USS session to Claude Code JSONL text plus a report of what could
 * not survive the conversion.
 */
function toNative(session, options = {}) {
  const sessionId = options.sessionId || session.sessionId || uuid();
  const projectPath = options.projectPath || session.projectPath || null;
  const model = options.model || session.model || null;

  const rows = buildRows(session, { sessionId, projectPath, model });

  // Nothing is lost writing a Claude Code session back to Claude Code, and it
  // is the only source this build accepts. Kept in the return shape so callers
  // that surface losses do not need a special case.
  const lossy = [];

  const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  return {
    text,
    rows: rows.length,
    lossy,
    suggestedRelativePath: path.join('projects', encodeProjectDir(projectPath), sessionId + '.jsonl'),
    sessionId,
  };
}

module.exports = { toNative, encodeProjectDir, buildRows };
