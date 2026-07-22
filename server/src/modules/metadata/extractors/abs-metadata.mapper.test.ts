import { describe, it, expect } from 'vitest';

import { hasAbsMetadata, mapAbsMetadata } from './abs-metadata.mapper';
import type { AbsBookMetadata } from './abs-metadata.types';

describe('mapAbsMetadata', () => {
  it('maps a full realistic ABS metadata.json to ParsedBookData', () => {
    const raw: AbsBookMetadata = {
      title: 'The Way of Kings',
      subtitle: 'Book One of the Stormlight Archive',
      authors: ['Brandon Sanderson'],
      narrators: ['Kate Reading', 'Michael Kramer'],
      series: ['The Stormlight Archive #1'],
      genres: ['Fantasy', 'Epic'],
      tags: ['owned', 'favorite'],
      publishedYear: '2010',
      publishedDate: '2010-08-31',
      publisher: 'Tor Books',
      description: 'The first volume.',
      isbn: '9780306406157',
      asin: 'b0041jknna',
      language: 'English',
      abridged: false,
      chapters: [
        { title: 'Chapter 2', start: 120.5 },
        { title: 'Chapter 1', start: 0 },
      ],
    };

    const result = mapAbsMetadata(raw);

    expect(result.title).toBe('The Way of Kings');
    expect(result.subtitle).toBe('Book One of the Stormlight Archive');
    expect(result.description).toBe('The first volume.');
    expect(result.authors).toEqual([{ name: 'Brandon Sanderson', sortName: null }]);
    expect(result.narrators).toEqual(['Kate Reading', 'Michael Kramer']);
    expect(result.genres).toEqual(['Fantasy', 'Epic']);
    expect(result.tags).toEqual(['owned', 'favorite']);
    expect(result.seriesName).toBe('The Stormlight Archive');
    expect(result.seriesIndex).toBe(1);
    expect(result.seriesMemberships).toEqual([{ seriesName: 'The Stormlight Archive', seriesIndex: 1 }]);
    // asin -> audibleId (normalized/uppercased)
    expect(result.audibleId).toBe('B0041JKNNA');
    expect(result.isbn13).toBe('9780306406157');
    expect(result.isbn10).toBeNull();
    expect(result.publisher).toBe('Tor Books');
    expect(result.publishedDate).toBe('2010-08-31');
    expect(result.publishedYear).toBe(2010);
    expect(result.language).toBe('English');
    expect(result.abridged).toBe(false);
    // chapters are sorted by startMs and seconds are converted to ms
    expect(result.chapters).toEqual([
      { title: 'Chapter 1', startMs: 0 },
      { title: 'Chapter 2', startMs: 120500 },
    ]);
    expect(result.cover).toBeNull();
  });

  describe('legacy { metadata, tags, chapters } wrapper', () => {
    it('hoists nested metadata and merges non-colliding top-level tags/chapters', () => {
      const raw = {
        metadata: {
          title: 'Nested Title',
          authors: ['Nested Author'],
          asin: 'b00nested1',
        },
        tags: ['top-tag'],
        chapters: [{ title: 'Intro', start: 1 }],
      } as unknown as AbsBookMetadata;

      const result = mapAbsMetadata(raw);

      expect(result.title).toBe('Nested Title');
      expect(result.authors).toEqual([{ name: 'Nested Author', sortName: null }]);
      expect(result.audibleId).toBe('B00NESTED1');
      // top-level tags/chapters survive the hoist (no collision with nested keys)
      expect(result.tags).toEqual(['top-tag']);
      expect(result.chapters).toEqual([{ title: 'Intro', startMs: 1000 }]);
    });

    it('ignores a non-object metadata property and reads top-level fields', () => {
      const raw = {
        metadata: 'not-an-object',
        title: 'Top Title',
      } as unknown as AbsBookMetadata;

      const result = mapAbsMetadata(raw);

      expect(result.title).toBe('Top Title');
    });
  });

  describe('series parsing', () => {
    it('parses "Name #1.5" into name and fractional index', () => {
      const result = mapAbsMetadata({ series: ['Wax and Wayne #1.5'] } as AbsBookMetadata);
      expect(result.seriesMemberships).toEqual([{ seriesName: 'Wax and Wayne', seriesIndex: 1.5 }]);
    });

    it('preserves a zero index rather than dropping it', () => {
      const result = mapAbsMetadata({ series: ['Prequels #0'] } as AbsBookMetadata);
      expect(result.seriesMemberships).toEqual([{ seriesName: 'Prequels', seriesIndex: 0 }]);
      expect(result.seriesIndex).toBe(0);
    });

    it('keeps the whole string as the name when the suffix is non-numeric', () => {
      const result = mapAbsMetadata({ series: ['Series #book-two'] } as AbsBookMetadata);
      expect(result.seriesMemberships).toEqual([{ seriesName: 'Series #book-two', seriesIndex: null }]);
    });

    it('dedupes memberships by lowercased name', () => {
      const result = mapAbsMetadata({ series: ['Foundation #1', 'foundation #2'] } as AbsBookMetadata);
      expect(result.seriesMemberships).toEqual([{ seriesName: 'Foundation', seriesIndex: 1 }]);
    });
  });

  describe('isbn detection', () => {
    it('accepts a checksum-valid isbn13', () => {
      const result = mapAbsMetadata({ isbn: '9780306406157' } as AbsBookMetadata);
      expect(result.isbn13).toBe('9780306406157');
      expect(result.isbn10).toBeNull();
    });

    it('rejects a checksum-invalid 13-digit string (both null)', () => {
      const result = mapAbsMetadata({ isbn: '9780306406158' } as AbsBookMetadata);
      expect(result.isbn13).toBeNull();
      expect(result.isbn10).toBeNull();
    });

    it('accepts a valid isbn10 with a trailing lowercase x, uppercased', () => {
      const result = mapAbsMetadata({ isbn: '080442957x' } as AbsBookMetadata);
      expect(result.isbn10).toBe('080442957X');
      expect(result.isbn13).toBeNull();
    });
  });

  describe('coercion of malformed values', () => {
    it('yields null/[] for arrays-where-scalar, null, and missing without throwing', () => {
      const raw = {
        title: ['array', 'not', 'scalar'],
        description: null,
        // publisher missing entirely
        authors: null,
        genres: 42,
        series: { not: 'an-array' },
        chapters: 'nope',
      } as unknown as AbsBookMetadata;

      const result = mapAbsMetadata(raw);

      expect(result.title).toBeNull();
      expect(result.description).toBeNull();
      expect(result.publisher).toBeNull();
      expect(result.authors).toEqual([]);
      expect(result.genres).toEqual([]);
      expect(result.seriesMemberships).toEqual([]);
      expect(result.seriesName).toBeNull();
      expect(result.seriesIndex).toBeNull();
      expect(result.chapters).toEqual([]);
    });

    it('coerces a finite number into a string for scalar string fields', () => {
      // NOTE: coerceString accepts finite numbers, so a numeric title becomes its string form.
      const result = mapAbsMetadata({ title: 123 } as unknown as AbsBookMetadata);
      expect(result.title).toBe('123');
    });

    it('parses publishedYear via parseInt and yields null for non-numeric text', () => {
      expect(mapAbsMetadata({ publishedYear: '2021-05' } as AbsBookMetadata).publishedYear).toBe(2021);
      expect(mapAbsMetadata({ publishedYear: 'unknown' } as AbsBookMetadata).publishedYear).toBeNull();
      expect(mapAbsMetadata({ publishedYear: 1998 } as AbsBookMetadata).publishedYear).toBe(1998);
    });

    it('keeps only string entries for authors (object-form authors -> [])', () => {
      const raw = { authors: [{ name: 'Object Author' }, 'String Author'] } as unknown as AbsBookMetadata;
      const result = mapAbsMetadata(raw);
      expect(result.authors).toEqual([{ name: 'String Author', sortName: null }]);
    });
  });
});

describe('hasAbsMetadata', () => {
  it('is true when any field is present', () => {
    expect(hasAbsMetadata(mapAbsMetadata({ title: 'Something' } as AbsBookMetadata))).toBe(true);
    expect(hasAbsMetadata(mapAbsMetadata({ tags: ['a'] } as AbsBookMetadata))).toBe(true);
    expect(hasAbsMetadata(mapAbsMetadata({ series: ['S #0'] } as AbsBookMetadata))).toBe(true);
  });

  it('is false for an all-null/empty metadata object (so an empty metadata.json yields null downstream)', () => {
    expect(hasAbsMetadata(mapAbsMetadata({} as AbsBookMetadata))).toBe(false);
  });
});
