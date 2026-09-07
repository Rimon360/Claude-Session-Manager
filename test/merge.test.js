'use strict';
/**
 * Divergence detection and resolution recommendations.
 *
 * The brief calls out three divergence positions explicitly -- at the first
 * message, mid-conversation, and at the last message -- because each one
 * exercises a different boundary in the common-prefix walk.
 */
const uss = require('../src/core/uss');
const merge = require('../src/core/merge');

function sess(texts, options = {}) {
  const s = uss.emptySession({
    sourceTool: options.sourceTool || 'claude-code',
    sessionId: options.sessionId || 'sess-1',
    updatedAt: options.updatedAt || null,
  });
  s.messages = texts.map((t, i) =>
    uss.makeMessage({
      id: 'm' + i,
      role: i % 2 === 0 ? 'user' : 'assistant',
      type: 'text',
      text: t,
      timestamp: new Date(Date.parse('2026-01-01T00:00:00Z') + i * 1000).toISOString(),
    })
  );
  return uss.finalize(s);
}

describe('merge: divergence detection', () => {
  it('calls two byte-identical sessions identical', () => {
    const a = sess(['a', 'b', 'c']);
    const b = sess(['a', 'b', 'c']);
    const c = merge.compareSessions(a, b);
    assert.equal(c.relation, merge.RELATION.IDENTICAL);
    assert.equal(c.divergeIndex, null);
    assert.ok(c.sameHash);
    assert.equal(merge.recommend(c).resolution, merge.RESOLUTION.SKIP);
  });

  it('ignores timestamps and ids when deciding identity', () => {
    const a = sess(['a', 'b']);
    const b = sess(['a', 'b']);
    b.messages.forEach((m, i) => { m.id = 'different-' + i; m.timestamp = '2030-01-01T00:00:00.000Z'; });
    uss.finalize(b);
    assert.equal(a.contentHash, b.contentHash, 'the same conversation copied to another machine must hash the same');
    assert.equal(merge.compareSessions(a, b).relation, merge.RELATION.IDENTICAL);
  });

  it('treats line-ending and trailing-whitespace differences as identical', () => {
    const a = sess(['hello\nworld', 'ok']);
    const b = sess(['hello\r\nworld  ', 'ok']);
    assert.equal(a.contentHash, b.contentHash);
  });

  it('detects a prefix relationship and recommends taking the longer side', () => {
    const a = sess(['a', 'b', 'c']);
    const b = sess(['a', 'b', 'c', 'd', 'e']);
    const c = merge.compareSessions(a, b);
    assert.equal(c.relation, merge.RELATION.PREFIX);
    assert.equal(c.commonPrefixLength, 3);
    assert.equal(c.divergeIndex, 3);
    assert.equal(c.longer, 'b');
    assert.equal(c.bOnly, 2);
    const rec = merge.recommend(c);
    assert.equal(rec.resolution, merge.RESOLUTION.KEEP_INCOMING);
    assert.includes(rec.reason, 'nothing in the existing copy is lost');
  });

  it('keeps the existing side when it is the longer one', () => {
    const a = sess(['a', 'b', 'c', 'd']);
    const b = sess(['a', 'b']);
    const c = merge.compareSessions(a, b);
    assert.equal(c.relation, merge.RELATION.PREFIX);
    assert.equal(merge.recommend(c).resolution, merge.RESOLUTION.KEEP_EXISTING);
  });

  it('detects divergence at the FIRST message', () => {
    const a = sess(['alpha', 'b', 'c']);
    const b = sess(['beta', 'b', 'c']);
    const c = merge.compareSessions(a, b);
    assert.equal(c.relation, merge.RELATION.UNRELATED, 'no shared prefix at all');
    assert.equal(c.commonPrefixLength, 0);
    assert.equal(c.divergeIndex, 0);
    assert.equal(merge.recommend(c).resolution, merge.RESOLUTION.KEEP_BOTH);
  });

  it('detects divergence MID-conversation', () => {
    const a = sess(['a', 'b', 'c-local', 'd-local']);
    const b = sess(['a', 'b', 'c-remote', 'd-remote', 'e-remote']);
    const c = merge.compareSessions(a, b);
    assert.equal(c.relation, merge.RELATION.DIVERGED);
    assert.equal(c.divergeIndex, 2);
    assert.equal(c.aOnly, 2);
    assert.equal(c.bOnly, 3);
    const rec = merge.recommend(c);
    assert.equal(rec.resolution, merge.RESOLUTION.KEEP_BOTH,
      'when each side has unique content, only keep-both loses nothing');
    assert.includes(rec.reason, 'only option that loses nothing');
  });

  it('detects divergence at the LAST message', () => {
    const a = sess(['a', 'b', 'c', 'd-local']);
    const b = sess(['a', 'b', 'c', 'd-remote']);
    const c = merge.compareSessions(a, b);
    assert.equal(c.relation, merge.RELATION.DIVERGED);
    assert.equal(c.divergeIndex, 3);
    assert.equal(c.aOnly, 1);
    assert.equal(c.bOnly, 1);
    assert.equal(merge.recommend(c).resolution, merge.RESOLUTION.KEEP_BOTH);
  });

  it('handles an empty session on either side without crashing', () => {
    const a = sess([]);
    const b = sess(['a']);
    const c = merge.compareSessions(a, b);
    assert.equal(c.relation, merge.RELATION.EMPTY);
    assert.equal(merge.recommend(c).resolution, merge.RESOLUTION.KEEP_BOTH);
  });

  it('identifies which side is newer from updatedAt', () => {
    const a = sess(['a', 'x'], { updatedAt: '2026-01-01T00:00:00Z' });
    const b = sess(['a', 'y'], { updatedAt: '2026-06-01T00:00:00Z' });
    assert.equal(merge.compareSessions(a, b).newer, 'b');
    assert.equal(merge.compareSessions(b, a).newer, 'a');
  });

  it('reports no newer side when timestamps are equal or absent', () => {
    const a = sess(['a', 'x']);
    const b = sess(['a', 'y']);
    assert.equal(merge.compareSessions(a, b).newer, null);
  });
});

describe('merge: diff preview', () => {
  it('shows the shared context and the first differing message on each side', () => {
    const a = sess(['a', 'b', 'c', 'local-1', 'local-2']);
    const b = sess(['a', 'b', 'c', 'remote-1']);
    const c = merge.compareSessions(a, b);
    const d = merge.diffPreview(a, b, c, 2);

    assert.equal(d.divergeIndex, 3);
    assert.equal(d.sharedContext.length, 2);
    assert.equal(d.sharedContext[d.sharedContext.length - 1].text, 'c');
    assert.equal(d.aNext[0].text, 'local-1');
    assert.equal(d.bNext[0].text, 'remote-1');
    assert.equal(d.aNext[0].index, 3, 'indices must be absolute so the UI can point at a message');
  });

  it('handles divergence at index 0 with no shared context', () => {
    const a = sess(['x']);
    const b = sess(['y']);
    const d = merge.diffPreview(a, b, merge.compareSessions(a, b), 3);
    assert.equal(d.sharedContext.length, 0);
    assert.equal(d.aNext[0].text, 'x');
    assert.equal(d.bNext[0].text, 'y');
  });

  it('shows an empty continuation when one side simply ends', () => {
    const a = sess(['a', 'b']);
    const b = sess(['a', 'b', 'c']);
    const d = merge.diffPreview(a, b, merge.compareSessions(a, b), 2);
    assert.equal(d.aNext.length, 0, 'the shorter side has nothing after the divergence point');
    assert.equal(d.bNext.length, 1);
  });
});

describe('merge: union', () => {
  it('extends to the longer side for a prefix relationship', () => {
    const a = sess(['a', 'b']);
    const b = sess(['a', 'b', 'c']);
    const c = merge.compareSessions(a, b);
    const u = merge.unionSessions(a, b, c);
    assert.equal(u.messages.length, 3);
    assert.equal(u.meta.mergeKind, 'prefix-extend');
  });

  it('marks a concatenation of diverged branches as not a real conversation', () => {
    const a = sess(['a', 'local']);
    const b = sess(['a', 'remote']);
    const c = merge.compareSessions(a, b);
    const u = merge.unionSessions(a, b, c);
    assert.equal(u.messages.length, 3);
    assert.equal(u.meta.mergeKind, 'concatenated-branches');
    assert.includes(u.meta.mergeWarning, 'did not occur as a single conversation');
    assert.equal(u.contentHash, uss.computeContentHash(u.messages), 'the merged result must carry a fresh hash');
  });
});

describe('merge: grouping by content', () => {
  it('groups copies of the same conversation regardless of id', () => {
    const a = sess(['a', 'b'], { sessionId: 'id-one' });
    const b = sess(['a', 'b'], { sessionId: 'id-two' });
    const c = sess(['x', 'y'], { sessionId: 'id-three' });
    const groups = merge.groupByContentHash([a, b, c]);
    assert.equal(groups.size, 2);
    assert.equal(groups.get(a.contentHash).length, 2);
  });
});
