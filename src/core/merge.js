'use strict';
/**
 * Divergence detection and conflict resolution.
 *
 * Two copies of "the same" session are related in exactly one of five ways.
 * Naming them precisely is what lets the UI offer a safe default instead of
 * asking the user to eyeball two transcripts:
 *
 *   identical  - same content hash. Nothing to do; import is a no-op.
 *   prefix     - one is a strict prefix of the other. The longer one simply
 *                continued the conversation, so taking it loses nothing.
 *   diverged   - a common prefix, then different content on both sides. This
 *                is a real conflict: each side has messages the other lacks.
 *   unrelated  - no common prefix at all despite a matching id. Almost always
 *                an id collision between two different conversations.
 *   empty      - one or both sides have no messages.
 */
const uss = require('./uss');

const RELATION = {
  IDENTICAL: 'identical',
  PREFIX: 'prefix',
  DIVERGED: 'diverged',
  UNRELATED: 'unrelated',
  EMPTY: 'empty',
};

/**
 * Compare two USS sessions.
 *
 * `divergeIndex` is the first message index at which the two differ. When one
 * is a prefix of the other it equals the shorter length. When they are
 * identical it is null.
 */
function compareSessions(a, b) {
  const aMsgs = a?.messages ?? [];
  const bMsgs = b?.messages ?? [];

  if (!aMsgs.length || !bMsgs.length) {
    return {
      relation: RELATION.EMPTY,
      divergeIndex: 0,
      commonPrefixLength: 0,
      aLength: aMsgs.length,
      bLength: bMsgs.length,
      aOnly: aMsgs.length,
      bOnly: bMsgs.length,
      sameHash: a?.contentHash && a.contentHash === b?.contentHash,
    };
  }

  const aHashes = uss.messageHashes(aMsgs);
  const bHashes = uss.messageHashes(bMsgs);

  let common = 0;
  const max = Math.min(aHashes.length, bHashes.length);
  while (common < max && aHashes[common] === bHashes[common]) common++;

  const sameHash = a.contentHash && a.contentHash === b.contentHash;

  let relation;
  if (sameHash || (common === aHashes.length && common === bHashes.length)) {
    relation = RELATION.IDENTICAL;
  } else if (common === aHashes.length || common === bHashes.length) {
    relation = RELATION.PREFIX;
  } else if (common === 0) {
    relation = RELATION.UNRELATED;
  } else {
    relation = RELATION.DIVERGED;
  }

  return {
    relation,
    commonPrefixLength: common,
    divergeIndex: relation === RELATION.IDENTICAL ? null : common,
    aLength: aHashes.length,
    bLength: bHashes.length,
    aOnly: aHashes.length - common,
    bOnly: bHashes.length - common,
    sameHash: !!sameHash,
    longer: aHashes.length === bHashes.length ? null : (aHashes.length > bHashes.length ? 'a' : 'b'),
    newer: pickNewer(a, b),
  };
}

function pickNewer(a, b) {
  const at = Date.parse(a?.updatedAt ?? '') || 0;
  const bt = Date.parse(b?.updatedAt ?? '') || 0;
  if (!at && !bt) return null;
  if (at === bt) return null;
  return at > bt ? 'a' : 'b';
}

/**
 * A human-readable diff summary for the conflict screen. Returns the last
 * shared message and the first differing message on each side, which is what
 * a person actually needs in order to choose.
 */
function diffPreview(a, b, comparison, contextLines = 3) {
  const idx = comparison.divergeIndex ?? 0;
  const clip = (m) => m ? {
    index: null,
    role: m.role, type: m.type,
    toolName: m.toolName ?? null,
    text: typeof m.text === 'string' ? m.text.slice(0, 400) : null,
    timestamp: m.timestamp ?? null,
  } : null;

  const shared = [];
  for (let i = Math.max(0, idx - contextLines); i < idx; i++) {
    const m = clip(a.messages[i]); if (m) { m.index = i; shared.push(m); }
  }
  const aSide = [];
  const bSide = [];
  for (let i = idx; i < Math.min(idx + contextLines, a.messages.length); i++) {
    const m = clip(a.messages[i]); if (m) { m.index = i; aSide.push(m); }
  }
  for (let i = idx; i < Math.min(idx + contextLines, b.messages.length); i++) {
    const m = clip(b.messages[i]); if (m) { m.index = i; bSide.push(m); }
  }

  return {
    divergeIndex: comparison.divergeIndex,
    sharedContext: shared,
    aNext: aSide,
    bNext: bSide,
    aSummary: uss.summarize(a),
    bSummary: uss.summarize(b),
    aUpdatedAt: a.updatedAt ?? null,
    bUpdatedAt: b.updatedAt ?? null,
  };
}

/** Resolution choices offered per conflict. */
const RESOLUTION = {
  KEEP_EXISTING: 'keep-existing',   // leave the destination untouched
  KEEP_INCOMING: 'keep-incoming',   // overwrite destination (always backs up first)
  KEEP_NEWER: 'keep-newer',         // whichever has the later updatedAt
  KEEP_BOTH: 'keep-both',           // write incoming under a suffixed id
  SKIP: 'skip',
};

/**
 * Recommend a resolution. Deliberately conservative: the only case that
 * recommends replacing existing data is a strict prefix, where the incoming
 * copy provably contains everything the existing one has. Anything genuinely
 * diverged defaults to keeping both, because that is the only choice which
 * cannot lose a message.
 */
function recommend(comparison) {
  switch (comparison.relation) {
    case RELATION.IDENTICAL:
      return { resolution: RESOLUTION.SKIP, reason: 'Identical content already present. Nothing to write.' };
    case RELATION.PREFIX:
      if (comparison.longer === 'b') {
        return { resolution: RESOLUTION.KEEP_INCOMING, reason: `Incoming copy continues the existing one (${comparison.bOnly} additional message(s)); nothing in the existing copy is lost.` };
      }
      return { resolution: RESOLUTION.KEEP_EXISTING, reason: `Existing copy already contains everything in the incoming one, plus ${comparison.aOnly} more message(s).` };
    case RELATION.DIVERGED:
      return { resolution: RESOLUTION.KEEP_BOTH, reason: `Both copies have content the other lacks (${comparison.aOnly} vs ${comparison.bOnly} message(s) after message ${comparison.divergeIndex}). Keeping both is the only option that loses nothing.` };
    case RELATION.UNRELATED:
      return { resolution: RESOLUTION.KEEP_BOTH, reason: 'Same session id but no shared history — most likely an id collision between two different conversations.' };
    case RELATION.EMPTY:
      return { resolution: RESOLUTION.KEEP_BOTH, reason: 'One side has no messages; keeping both so nothing is discarded.' };
    default:
      return { resolution: RESOLUTION.KEEP_BOTH, reason: 'Unclassified relationship; defaulting to the non-destructive option.' };
  }
}

/**
 * Build a merged USS session for a "keep both / union" style resolution where
 * the two share a prefix. Only used when the user explicitly asks to combine,
 * because concatenating diverged branches produces a conversation that never
 * happened -- we mark it clearly in meta.
 */
function unionSessions(a, b, comparison) {
  if (comparison.relation === RELATION.PREFIX) {
    const longer = comparison.longer === 'b' ? b : a;
    return { ...longer, meta: { ...longer.meta, mergedFrom: [a.contentHash, b.contentHash], mergeKind: 'prefix-extend' } };
  }
  const merged = {
    ...a,
    messages: [...a.messages, ...b.messages.slice(comparison.commonPrefixLength)],
    meta: {
      ...a.meta,
      mergedFrom: [a.contentHash, b.contentHash],
      mergeKind: 'concatenated-branches',
      mergeWarning:
        'This session was assembled from two diverged branches. The result is a sequence that did not occur as a single conversation; ' +
        'the original branches are preserved in the backup directory and in the export bundle.',
      divergeIndex: comparison.divergeIndex,
    },
  };
  return uss.finalize(merged);
}

/**
 * Group a set of sessions by content hash to find exact duplicates across
 * accounts. This is what "Sync All" unions on.
 */
function groupByContentHash(sessions) {
  const map = new Map();
  for (const s of sessions) {
    const key = s.contentHash;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(s);
  }
  return map;
}

module.exports = {
  RELATION, RESOLUTION, compareSessions, diffPreview, recommend, unionSessions, groupByContentHash, pickNewer,
};
