import { describe, it, expect } from 'vitest';

import { isMappablePathPrefix, mapAbsItemPath, normalizeAsin, splitPathSuffixKey, toPlannerPathMappings } from './audiobookshelf-match.utils';

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

describe('isMappablePathPrefix', () => {
  it('accepts a prefix that names at least one folder', () => {
    expect(isMappablePathPrefix('/audiobooks')).toBe(true);
    expect(isMappablePathPrefix('/audiobooks/')).toBe(true);
    expect(isMappablePathPrefix('/media/abs/books')).toBe(true);
  });

  it('rejects the filesystem root, which matches everything and rewrites nothing', () => {
    expect(isMappablePathPrefix('/')).toBe(false);
    expect(isMappablePathPrefix('  /  ')).toBe(false);
    expect(isMappablePathPrefix('//')).toBe(false);
  });

  it('rejects an empty, blank, or absent prefix', () => {
    expect(isMappablePathPrefix('')).toBe(false);
    expect(isMappablePathPrefix('   ')).toBe(false);
    expect(isMappablePathPrefix(null)).toBe(false);
    expect(isMappablePathPrefix(undefined)).toBe(false);
  });
});

describe('splitPathSuffixKey', () => {
  it('splits an absolute path into its trailing two segments and the mount above them', () => {
    expect(splitPathSuffixKey('/books/Author/Title')).toEqual({ key: 'Author/Title', prefix: '/books' });
    expect(splitPathSuffixKey('/media/abs/books/Author/Title')).toEqual({ key: 'Author/Title', prefix: '/media/abs/books' });
  });

  it('canonicalizes duplicate and trailing separators before splitting', () => {
    expect(splitPathSuffixKey('/books//Author/Title/')).toEqual({ key: 'Author/Title', prefix: '/books' });
  });

  it('returns null for a relative path, which has no mount to name', () => {
    expect(splitPathSuffixKey('books/Author/Title')).toBeNull();
    expect(splitPathSuffixKey('Author/Title')).toBeNull();
    expect(splitPathSuffixKey('./books/Author/Title')).toBeNull();
  });

  it('returns null for a path with no room for a key', () => {
    expect(splitPathSuffixKey('/books')).toBeNull();
    expect(splitPathSuffixKey(null)).toBeNull();
    expect(splitPathSuffixKey('   ')).toBeNull();
  });
});

describe('toPlannerPathMappings', () => {
  it('canonicalizes both prefixes into the planner shape', () => {
    expect(toPlannerPathMappings([{ absPrefix: ' /audiobooks// ', localPrefix: '/books/' }])).toEqual([
      { sourcePrefix: '/audiobooks', targetPrefix: '/books' },
    ]);
  });

  it('drops a mapping whose either side is the filesystem root or empty', () => {
    expect(
      toPlannerPathMappings([
        { absPrefix: '/', localPrefix: '/books' },
        { absPrefix: '/audiobooks', localPrefix: '/' },
        { absPrefix: '   ', localPrefix: '/books' },
        { absPrefix: '/audiobooks', localPrefix: '' },
      ]),
    ).toEqual([]);
  });

  it('keeps the usable rows alongside the dropped ones', () => {
    expect(
      toPlannerPathMappings([
        { absPrefix: '/', localPrefix: '/books' },
        { absPrefix: '/audiobooks', localPrefix: '/books' },
      ]),
    ).toEqual([{ sourcePrefix: '/audiobooks', targetPrefix: '/books' }]);
  });

  it('returns an empty list for no mappings at all', () => {
    expect(toPlannerPathMappings(null)).toEqual([]);
    expect(toPlannerPathMappings(undefined)).toEqual([]);
    expect(toPlannerPathMappings([])).toEqual([]);
  });
});

describe('mapAbsItemPath', () => {
  const mappings = [{ sourcePrefix: '/audiobooks', targetPrefix: '/books' }];

  it('rewrites a covered path onto the local mount', () => {
    expect(mapAbsItemPath('/audiobooks/Author/Title', mappings)).toBe('/books/Author/Title');
    expect(mapAbsItemPath('/audiobooks//Author/Title/', mappings)).toBe('/books/Author/Title');
  });

  it('returns null when no mapping covers the path, so a raw ABS path never reaches the lookup', () => {
    expect(mapAbsItemPath('/podcasts/Author/Title', mappings)).toBeNull();
    expect(mapAbsItemPath('/audiobooks-archive/Author/Title', mappings)).toBeNull();
    expect(mapAbsItemPath('/audiobooks/Author/Title', [])).toBeNull();
    expect(mapAbsItemPath(null, mappings)).toBeNull();
  });

  it('never counts a root-prefixed mapping as covering, since it translates nothing', () => {
    expect(mapAbsItemPath('/audiobooks/Author/Title', [{ sourcePrefix: '/', targetPrefix: '/books' }])).toBeNull();
    expect(mapAbsItemPath('/audiobooks/Author/Title', [{ sourcePrefix: '/audiobooks', targetPrefix: '/' }])).toBeNull();
  });

  it('still maps through a usable mapping when an unusable one sits beside it', () => {
    expect(
      mapAbsItemPath('/audiobooks/Author/Title', [
        { sourcePrefix: '/', targetPrefix: '/elsewhere' },
        { sourcePrefix: '/audiobooks', targetPrefix: '/books' },
      ]),
    ).toBe('/books/Author/Title');
  });

  it('lets the longest matching source prefix win', () => {
    expect(
      mapAbsItemPath('/audiobooks/scifi/Author/Title', [
        { sourcePrefix: '/audiobooks', targetPrefix: '/books' },
        { sourcePrefix: '/audiobooks/scifi', targetPrefix: '/media/scifi' },
      ]),
    ).toBe('/media/scifi/Author/Title');
  });
});
