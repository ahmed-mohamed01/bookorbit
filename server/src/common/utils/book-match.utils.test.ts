import { describe, expect, it } from 'vitest';

import { normalizeAsin, normalizeIsbn } from './book-match.utils';

describe('normalizeAsin', () => {
  it('trims and upper-cases so casing is symmetric across write and query boundaries', () => {
    expect(normalizeAsin('  b00oyx5g5w  ')).toBe('B00OYX5G5W');
    expect(normalizeAsin('B00OYX5G5W')).toBe('B00OYX5G5W');
  });

  it('returns null for empty or whitespace-only input', () => {
    expect(normalizeAsin(null)).toBeNull();
    expect(normalizeAsin(undefined)).toBeNull();
    expect(normalizeAsin('   ')).toBeNull();
  });
});

describe('normalizeIsbn', () => {
  it('strips separators and upper-cases the ISBN-10 check character', () => {
    expect(normalizeIsbn('0-8044-2957-x')).toBe('080442957X');
    expect(normalizeIsbn('0-8044-2957-X')).toBe('080442957X');
  });

  it('normalizes a 13-digit ISBN', () => {
    expect(normalizeIsbn('978-0-385-74358-6')).toBe('9780385743586');
  });

  it('returns null when nothing usable remains', () => {
    expect(normalizeIsbn(null)).toBeNull();
    expect(normalizeIsbn('---')).toBeNull();
  });
});
