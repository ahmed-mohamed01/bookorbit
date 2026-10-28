import { describe, expect, it } from 'vitest';

import { classifyMatch, detectConflicts, isPrefixOnlyTitle, proposedActionFor, type ScoredCandidate } from './work-match.utils';

const candidate = (bookId: number, score: number, fields: Partial<ScoredCandidate> = {}): ScoredCandidate => ({
  bookId,
  score,
  titleScore: score,
  authorScore: 1,
  isbnMatch: false,
  prefixOnly: false,
  claimedBy: null,
  ...fields,
});

describe('classifyMatch', () => {
  it('buckets an unlinked source by its best score', () => {
    expect(classifyMatch(null, [candidate(2, 0.95)])?.bucket).toBe('strong');
    expect(classifyMatch(null, [candidate(2, 0.85)])?.bucket).toBe('weak');
    expect(classifyMatch(null, [candidate(2, 0.7)])).toBeNull();
    expect(classifyMatch(null, [])).toBeNull();
  });

  it('keeps a prefix-only title out of strong unless an identifier matches', () => {
    expect(classifyMatch(null, [candidate(2, 0.95, { prefixOnly: true })])?.bucket).toBe('weak');
    expect(classifyMatch(null, [candidate(2, 0.99, { prefixOnly: true, isbnMatch: true })])?.bucket).toBe('strong');
  });

  it('reads a target whose role is taken in its work as a conflict', () => {
    const match = classifyMatch(null, [candidate(2, 0.97, { claimedBy: 9 })]);

    expect(match).toMatchObject({ bucket: 'conflict', competingBookIds: [9], reason: 'also claimed by #9' });
  });

  it('checks a linked source against its link', () => {
    expect(classifyMatch(5, [candidate(5, 0.95), candidate(6, 0.9)])).toMatchObject({ bucket: 'linked_ok', targetBookId: 5 });
    expect(classifyMatch(5, [candidate(5, 0.85), candidate(6, 0.97)])).toMatchObject({
      bucket: 'linked_suspect',
      targetBookId: 6,
      reason: 'linked to #5 but #6 scores higher',
    });
    expect(classifyMatch(5, [])).toMatchObject({ bucket: 'linked_suspect', targetBookId: 5, score: 0 });
  });
});

describe('detectConflicts', () => {
  const claims = [
    { resultId: 1, sourceBookId: 10, targetBookId: 20 },
    { resultId: 2, sourceBookId: 11, targetBookId: 20 },
    { resultId: 3, sourceBookId: 12, targetBookId: 30 },
  ];

  it('flags a target claimed by two different books', () => {
    const sources = new Map([
      [10, { title: 'Dune', authorNames: ['Frank Herbert'] }],
      [11, { title: 'Children of Dune Companion', authorNames: ['Someone Else'] }],
      [12, { title: 'Emma', authorNames: ['Jane Austen'] }],
    ]);

    expect(detectConflicts(claims, sources, true)).toEqual(
      new Map([
        [1, [11]],
        [2, [10]],
      ]),
    );
  });

  it('lets strong duplicates share a target when duplicates may join one work', () => {
    const sources = new Map([
      [10, { title: 'Dune', authorNames: ['Frank Herbert'] }],
      [11, { title: 'Dune', authorNames: ['Frank Herbert'] }],
    ]);

    expect(detectConflicts(claims.slice(0, 2), sources, true).size).toBe(0);
    expect(detectConflicts(claims.slice(0, 2), sources, false).size).toBe(2);
  });
});

describe('proposedActionFor', () => {
  it('maps buckets to actions', () => {
    expect(proposedActionFor('strong', false)).toBe('link');
    expect(proposedActionFor('linked_suspect', false)).toBe('relink');
    expect(proposedActionFor('linked_suspect', true)).toBe('review');
    expect(proposedActionFor('weak', false)).toBe('review');
    expect(proposedActionFor('conflict', false)).toBe('review');
    expect(proposedActionFor('linked_ok', true)).toBe('none');
  });
});

describe('isPrefixOnlyTitle', () => {
  it('spots a title that only starts the other', () => {
    expect(isPrefixOnlyTitle('Dune', 'Dune Messiah')).toBe(true);
    expect(isPrefixOnlyTitle('Dune', 'Dune: A Novel')).toBe(false);
    expect(isPrefixOnlyTitle('Dune', 'Emma')).toBe(false);
  });
});
