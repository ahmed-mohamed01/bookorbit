import { hasAbsMetadata, mapAbsMetadata } from './abs-metadata.mapper';
import type { AbsBookMetadata } from './abs-metadata.types';

const firefightSample: AbsBookMetadata = {
  title: 'Firefight',
  subtitle: 'The Reckoners, Book 2',
  authors: ['Brandon Sanderson'],
  narrators: ['MacLeod Andrews'],
  series: ['Reckoners #2'],
  genres: ['Science Fiction', 'Young Adult'],
  tags: ['dystopia', 'superheroes'],
  publishedYear: '2015',
  publishedDate: '2015-01-06',
  publisher: 'Listening Library',
  description: 'Newcago is free.',
  isbn: '978-0-385-74358-6',
  asin: 'B00OYX5G5W',
  language: 'English',
  explicit: false,
  abridged: false,
  chapters: [
    { id: 0, start: 0, end: 60.5, title: 'Opening Credits' },
    { id: 2, start: 120.25, end: 240, title: 'Chapter 2' },
    { id: 1, start: 60.5, end: 120.25, title: 'Chapter 1' },
  ],
};

describe('mapAbsMetadata - Firefight sample', () => {
  const result = mapAbsMetadata(firefightSample);

  it('parses the series name and numeric index', () => {
    expect(result.seriesName).toBe('Reckoners');
    expect(result.seriesIndex).toBe(2);
  });

  it('maps asin to audibleId', () => {
    expect(result.audibleId).toBe('B00OYX5G5W');
  });

  it('routes a 13-digit isbn to isbn13', () => {
    expect(result.isbn13).toBe('9780385743586');
    expect(result.isbn10).toBeNull();
  });

  it('converts chapter seconds to milliseconds sorted by start', () => {
    expect(result.chapters).toEqual([
      { title: 'Opening Credits', startMs: 0 },
      { title: 'Chapter 1', startMs: 60500 },
      { title: 'Chapter 2', startMs: 120250 },
    ]);
  });

  it('maps tags, genres, narrators, and abridged', () => {
    expect(result.tags).toEqual(['dystopia', 'superheroes']);
    expect(result.genres).toEqual(['Science Fiction', 'Young Adult']);
    expect(result.narrators).toEqual(['MacLeod Andrews']);
    expect(result.abridged).toBe(false);
  });

  it('maps authors to name/sortName pairs', () => {
    expect(result.authors).toEqual([{ name: 'Brandon Sanderson', sortName: null }]);
  });

  it('parses publishedYear as an integer and passes publishedDate through', () => {
    expect(result.publishedYear).toBe(2015);
    expect(result.publishedDate).toBe('2015-01-06');
  });

  it('returns a null cover', () => {
    expect(result.cover).toBeNull();
  });
});

describe('mapAbsMetadata - legacy nested wrapper', () => {
  it('hoists keys from a nested metadata object', () => {
    const raw: AbsBookMetadata = {
      metadata: {
        title: 'Nested Title',
        authors: ['Nested Author'],
        asin: 'B01LEGACY01',
      },
    };
    const result = mapAbsMetadata(raw);
    expect(result.title).toBe('Nested Title');
    expect(result.authors).toEqual([{ name: 'Nested Author', sortName: null }]);
    expect(result.audibleId).toBe('B01LEGACY01');
  });

  it('lets nested keys win over top-level keys', () => {
    const raw = {
      title: 'Top Level',
      metadata: { title: 'Nested Wins' },
    } as AbsBookMetadata;
    expect(mapAbsMetadata(raw).title).toBe('Nested Wins');
  });
});

describe('mapAbsMetadata - series parsing', () => {
  it.each(['Name #1a', 'Name #1..5', 'Name #+', 'Name #-', 'Name #1 2'])(
    'keeps the whole string and null index for non-numeric sequence %s',
    (series) => {
      const result = mapAbsMetadata({ series: [series] });
      expect(result.seriesName).toBe(series);
      expect(result.seriesIndex).toBeNull();
    },
  );

  it.each([
    ['Saga #-1', -1],
    ['Saga #+1.5', 1.5],
    ['Saga #1.', 1],
    ['Saga #-.5', -0.5],
    ['Saga #+1.', 1],
  ])('parses full numeric sequence %s', (series, expectedIndex) => {
    const result = mapAbsMetadata({ series: [series as string] });
    expect(result.seriesName).toBe('Saga');
    expect(result.seriesIndex).toBe(expectedIndex);
  });

  it('rejects a captured sequence containing whitespace', () => {
    const result = mapAbsMetadata({ series: ['Name #1\t2'] });
    expect(result.seriesName).toBe('Name #1\t2');
    expect(result.seriesIndex).toBeNull();
  });

  it('parses fractional sequences', () => {
    const result = mapAbsMetadata({ series: ['Reckoners #1.5'] });
    expect(result.seriesName).toBe('Reckoners');
    expect(result.seriesIndex).toBe(1.5);
  });

  it('treats a series without a sequence as name only', () => {
    const result = mapAbsMetadata({ series: ['Standalone'] });
    expect(result.seriesName).toBe('Standalone');
    expect(result.seriesIndex).toBeNull();
  });

  it('imports only the first series entry', () => {
    const result = mapAbsMetadata({ series: ['First #1', 'Second #2'] });
    expect(result.seriesName).toBe('First');
    expect(result.seriesIndex).toBe(1);
  });

  it('parses a leading-dot fractional sequence', () => {
    const result = mapAbsMetadata({ series: ['Saga #.5'] });
    expect(result.seriesName).toBe('Saga');
    expect(result.seriesIndex).toBe(0.5);
  });
});

describe('mapAbsMetadata - lenient coercion', () => {
  it('accepts a number where a string is expected', () => {
    const result = mapAbsMetadata({ title: 2015 as unknown as string, language: 42 as unknown as string });
    expect(result.title).toBe('2015');
    expect(result.language).toBe('42');
  });

  it('preserves scalar string whitespace and explicit empty strings', () => {
    const result = mapAbsMetadata({ title: '  Firefight  ', subtitle: '' });
    expect(result.title).toBe('  Firefight  ');
    expect(result.subtitle).toBe('');
  });

  it('keeps field-specific ISBN and year normalization after scalar preservation', () => {
    const result = mapAbsMetadata({ isbn: ' 978-0-385-74358-6 ', publishedYear: ' 2015 ' });
    expect(result.isbn13).toBe('9780385743586');
    expect(result.publishedYear).toBe(2015);
  });

  it('accepts "true"/"false" strings for abridged', () => {
    expect(mapAbsMetadata({ abridged: 'true' as unknown as boolean }).abridged).toBe(true);
    expect(mapAbsMetadata({ abridged: 'false' as unknown as boolean }).abridged).toBe(false);
  });

  it('retains only trimmed, non-empty, unique strings in ABS string arrays', () => {
    const invalidItems = [123, { name: 'Obj' }, null];
    const result = mapAbsMetadata({
      authors: [...invalidItems, '  Author  ', '', 'Author'] as unknown as string[],
      narrators: [...invalidItems, '  Narrator  ', 'Narrator'] as unknown as string[],
      genres: [...invalidItems, '  Fantasy  ', 'Fantasy'] as unknown as string[],
      tags: [...invalidItems, '  favorite  ', 'favorite'] as unknown as string[],
      series: [...invalidItems, '  Saga #2  ', 'Saga #2'] as unknown as string[],
    });

    expect(result.authors).toEqual([{ name: 'Author', sortName: null }]);
    expect(result.narrators).toEqual(['Narrator']);
    expect(result.genres).toEqual(['Fantasy']);
    expect(result.tags).toEqual(['favorite']);
    expect(result.seriesName).toBe('Saga');
    expect(result.seriesIndex).toBe(2);
  });

  it('routes an ISBN-10 with a final decimal check digit', () => {
    expect(mapAbsMetadata({ isbn: '0-385-74358-1' }).isbn10).toBe('0385743581');
  });

  it('routes an ISBN-10 with a final X or x check character', () => {
    expect(mapAbsMetadata({ isbn: '0-8044-2957-X' }).isbn10).toBe('080442957X');
    expect(mapAbsMetadata({ isbn: '0-8044-2957-x' }).isbn10).toBe('080442957x');
  });

  it('ignores an isbn with an unexpected digit length', () => {
    const result = mapAbsMetadata({ isbn: '12345' });
    expect(result.isbn10).toBeNull();
    expect(result.isbn13).toBeNull();
  });

  it('rejects a 12-digit value with a trailing X for isbn13', () => {
    const result = mapAbsMetadata({ isbn: '978123456789X' });
    expect(result.isbn13).toBeNull();
    expect(result.isbn10).toBeNull();
  });

  it('rejects X outside the final ISBN-10 check character position', () => {
    const result = mapAbsMetadata({ isbn: '0-8044-X957-1' });
    expect(result.isbn13).toBeNull();
    expect(result.isbn10).toBeNull();
  });
});

describe('mapAbsMetadata - chapters', () => {
  it('guards mixed chapter entries and skips empty titles', () => {
    const result = mapAbsMetadata({
      chapters: [
        null,
        'not an object',
        { start: 'abc', title: 'Bad Start' },
        { start: 10 },
        { start: 8, title: { text: 'Bad Title' } },
        { start: 7, title: '   ' },
        { start: 6, title: '' },
        { start: 5, title: '  Good  ' },
      ],
    });
    expect(result.chapters).toEqual([{ title: '  Good  ', startMs: 5000 }]);
  });
});

describe('mapAbsMetadata - missing fields', () => {
  it('returns nulls and empty arrays for an empty object', () => {
    const result = mapAbsMetadata({});
    expect(result.title).toBeNull();
    expect(result.audibleId).toBeNull();
    expect(result.seriesName).toBeNull();
    expect(result.seriesIndex).toBeNull();
    expect(result.authors).toEqual([]);
    expect(result.genres).toEqual([]);
    expect(result.tags).toEqual([]);
    expect(result.narrators).toEqual([]);
    expect(result.chapters).toEqual([]);
    expect(result.abridged).toBeNull();
    expect(result.cover).toBeNull();
  });
});

describe('hasAbsMetadata', () => {
  it('is false for an empty object', () => {
    expect(hasAbsMetadata(mapAbsMetadata({}))).toBe(false);
  });

  it('is true when any recognizable field is present', () => {
    expect(hasAbsMetadata(mapAbsMetadata({ title: 'Something' }))).toBe(true);
    expect(hasAbsMetadata(mapAbsMetadata({ title: '' }))).toBe(true);
    expect(hasAbsMetadata(mapAbsMetadata({ authors: ['Someone'] }))).toBe(true);
  });
});
