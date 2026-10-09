import { describe, expect, it } from 'vitest';

import { ebookActivityTime, isProjectedEbookProgress } from './reading-alignment-freshness.util';

const T0 = new Date('2026-03-01T10:00:00.000Z');
const T1 = new Date('2026-03-01T11:00:00.000Z');

describe('isProjectedEbookProgress', () => {
  it('counts a fresh projected insert, where every timestamp is equal, as projected', () => {
    expect(isProjectedEbookProgress({ updatedAt: T0, lastReadAt: T0, alignmentProjectedAt: T0 })).toBe(true);
  });

  it('stops counting a row as projected once a later real read bumps lastReadAt', () => {
    expect(isProjectedEbookProgress({ updatedAt: T1, lastReadAt: T1, alignmentProjectedAt: T0 })).toBe(false);
  });

  it('never counts a row without the column as projected', () => {
    expect(isProjectedEbookProgress({ updatedAt: T0, lastReadAt: T0, alignmentProjectedAt: null })).toBe(false);
    expect(isProjectedEbookProgress({ updatedAt: T0, lastReadAt: T0 })).toBe(false);
  });
});

describe('ebookActivityTime', () => {
  it('reports no activity for a missing row or a projection', () => {
    expect(ebookActivityTime(undefined)).toBeUndefined();
    expect(ebookActivityTime({ updatedAt: T0, lastReadAt: T0, alignmentProjectedAt: T1 })).toBeUndefined();
  });

  it('prefers lastReadAt for a real read', () => {
    expect(ebookActivityTime({ updatedAt: T0, lastReadAt: T1, alignmentProjectedAt: null })).toBe(T1);
  });

  it('falls back to updatedAt when lastReadAt is missing', () => {
    expect(ebookActivityTime({ updatedAt: T0 })).toBe(T0);
  });
});
