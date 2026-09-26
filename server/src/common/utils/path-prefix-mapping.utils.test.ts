import { describe, expect, it } from 'vitest';

import { isMappablePathPrefix, normalizeMatchPath } from './path-prefix-mapping.utils';

describe('normalizeMatchPath', () => {
  it('collapses duplicate separators and drops a trailing one', () => {
    expect(normalizeMatchPath('/books//Author/Title/')).toBe('/books/Author/Title');
    expect(normalizeMatchPath('  /books/Title.epub  ')).toBe('/books/Title.epub');
  });

  it('keeps the root separator and rejects empty input', () => {
    expect(normalizeMatchPath('/')).toBe('/');
    expect(normalizeMatchPath('   ')).toBeNull();
    expect(normalizeMatchPath(null)).toBeNull();
  });

  it('stays case sensitive', () => {
    expect(normalizeMatchPath('/Books/Title')).toBe('/Books/Title');
  });

  it('resolves traversal segments so a containment check cannot be walked out of', () => {
    expect(normalizeMatchPath('/mnt/ra/../../elsewhere/x.epub')).toBe('/elsewhere/x.epub');
    expect(normalizeMatchPath('/books/./Author/Title.epub')).toBe('/books/Author/Title.epub');
    expect(normalizeMatchPath('/books/Author/../Other/Title.epub')).toBe('/books/Other/Title.epub');
  });

  it('clamps traversal above the root instead of escaping it', () => {
    expect(normalizeMatchPath('/../..')).toBe('/');
    expect(normalizeMatchPath('/..//../books')).toBe('/books');
  });

  it('keeps a dot that is part of a segment name', () => {
    expect(normalizeMatchPath('/books/..hidden/Title.epub')).toBe('/books/..hidden/Title.epub');
    expect(normalizeMatchPath('/books/Vol. 1/Title.epub')).toBe('/books/Vol. 1/Title.epub');
  });

  it('keeps leading traversal on a relative path rather than inventing a root', () => {
    expect(normalizeMatchPath('../books/Title.epub')).toBe('../books/Title.epub');
    expect(normalizeMatchPath('books/./Title.epub')).toBe('books/Title.epub');
  });
});

describe('isMappablePathPrefix', () => {
  it('requires at least one folder segment', () => {
    expect(isMappablePathPrefix('/books')).toBe(true);
    expect(isMappablePathPrefix('/books/')).toBe(true);
    expect(isMappablePathPrefix('/')).toBe(false);
    expect(isMappablePathPrefix('')).toBe(false);
  });

  it('rejects a prefix that only traverses back to the root', () => {
    expect(isMappablePathPrefix('/books/..')).toBe(false);
  });
});
