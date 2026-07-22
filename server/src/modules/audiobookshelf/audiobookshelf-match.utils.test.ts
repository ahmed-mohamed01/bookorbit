import { describe, it, expect } from 'vitest';

import { normalizeAsin } from './audiobookshelf-match.utils';

describe('normalizeAsin', () => {
  it('trims surrounding whitespace and uppercases', () => {
    expect(normalizeAsin('  b0041jknna  ')).toBe('B0041JKNNA');
  });

  it('leaves an already-canonical asin unchanged', () => {
    expect(normalizeAsin('B0041JKNNA')).toBe('B0041JKNNA');
  });

  it('returns null for null and undefined', () => {
    expect(normalizeAsin(null)).toBeNull();
    expect(normalizeAsin(undefined)).toBeNull();
  });

  it('returns null for an empty or whitespace-only string', () => {
    expect(normalizeAsin('')).toBeNull();
    expect(normalizeAsin('   ')).toBeNull();
  });
});
