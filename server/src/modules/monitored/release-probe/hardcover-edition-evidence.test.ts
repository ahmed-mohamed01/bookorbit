import { describe, expect, it } from 'vitest';

import { buildHardcoverEvidence, mapHardcoverProbeBook } from './hardcover-edition-evidence';
import type { HardcoverProbeBook } from './release-probe.types';

const edition = (values: Partial<HardcoverProbeBook['editions'][number]>): HardcoverProbeBook['editions'][number] => ({
  readingFormatId: null,
  releaseDate: null,
  asin: null,
  isbn13: null,
  isbn10: null,
  usersCount: 0,
  languageCode: null,
  ...values,
});

const TODAY = '2026-09-18';

describe('buildHardcoverEvidence', () => {
  it('classifies The Infinite Extent evidence by format and strength', () => {
    const evidence = buildHardcoverEvidence(
      {
        slug: 'the-infinite-extent',
        releaseDate: '2026-09-10',
        editions: [
          edition({ readingFormatId: 2, releaseDate: '2026-09-10', asin: 'B0H8T5TBBS', usersCount: 164 }),
          edition({ readingFormatId: 2, releaseDate: '2026-09-10', asin: 'B0H8SY9QMX', usersCount: 1 }),
          edition({ readingFormatId: 4, releaseDate: '2027-01-10' }),
        ],
      },
      TODAY,
    );

    expect(evidence.ebook).toMatchObject({ count: 1, date: '2027-01-10', precision: 'day', strength: 'weak' });
    expect(evidence.audiobook).toEqual({
      count: 2,
      date: '2026-09-10',
      precision: 'day',
      strength: 'strong',
      seeds: ['B0H8T5TBBS', 'B0H8SY9QMX'],
    });
    expect(evidence.physical).toEqual({ count: 0, seeds: [] });
  });

  it('seeds the Amazon walk from a physical edition ISBN without dating it', () => {
    const evidence = buildHardcoverEvidence(
      {
        slug: 'the-lord-of-demons',
        releaseDate: '2026-10-06',
        editions: [edition({ readingFormatId: 1, releaseDate: '2026-01-01', isbn13: '9780356513010', usersCount: 138 })],
      },
      TODAY,
    );

    expect(evidence.physical).toEqual({ count: 1, seeds: ['0356513017'] });
    expect(evidence.ebook.count).toBe(0);
    expect(evidence.audiobook.count).toBe(0);
  });

  it('treats a new year eve date as a placeholder too', () => {
    const evidence = buildHardcoverEvidence(
      {
        slug: 'the-last-day',
        releaseDate: '2026-11-03',
        editions: [edition({ readingFormatId: 4, releaseDate: '2026-12-31', asin: 'B012345678', usersCount: 40 })],
      },
      TODAY,
    );

    expect(evidence.ebook).toMatchObject({ date: '2026-11-03', precision: 'day', strength: 'weak' });
  });

  it('keeps low-signal dated audio evidence weak', () => {
    const evidence = buildHardcoverEvidence(
      {
        slug: 'the-fires-of-december',
        releaseDate: '2026-09-15',
        editions: [edition({ readingFormatId: 2, releaseDate: '2026-09-15', usersCount: 4 })],
      },
      TODAY,
    );

    expect(evidence.audiobook.strength).toBe('weak');
  });

  it('does not label a partial edition date as day precision', () => {
    const evidence = buildHardcoverEvidence(
      {
        slug: 'partial-date',
        releaseDate: null,
        editions: [edition({ readingFormatId: 4, releaseDate: '2027-05', asin: 'B012345678' })],
      },
      TODAY,
    );

    expect(evidence.ebook).toMatchObject({ date: '2027', precision: 'year', strength: 'weak' });
  });

  it('counts an ISBN-10 towards strong evidence', () => {
    const evidence = buildHardcoverEvidence(
      {
        slug: 'the-tower',
        releaseDate: '2026-11-02',
        editions: [edition({ readingFormatId: 4, releaseDate: '2026-11-02', isbn10: '123456789X' })],
      },
      TODAY,
    );

    expect(evidence.ebook).toMatchObject({ date: '2026-11-02', strength: 'strong' });
  });

  it('keeps a far-future listing weak however it is identified', () => {
    const evidence = buildHardcoverEvidence(
      {
        slug: 'ghostbloods-1',
        releaseDate: '2028-12-01',
        editions: [edition({ readingFormatId: 4, releaseDate: '2028-12-01', asin: 'B0DEADASIN', usersCount: 90 })],
      },
      TODAY,
    );

    expect(evidence.ebook).toMatchObject({ date: '2028-12-01', strength: 'weak' });
  });

  it('prefers the earliest real edition over an earlier placeholder edition', () => {
    const evidence = buildHardcoverEvidence(
      {
        slug: 'masked',
        releaseDate: '2027-03-01',
        editions: [
          edition({ readingFormatId: 4, releaseDate: '2027-03-01' }),
          edition({ readingFormatId: 4, releaseDate: '2027-05-11', asin: 'B0H1DN5CP2', usersCount: 3 }),
          edition({ readingFormatId: 4, releaseDate: '2027-06-02', isbn13: '9781250880093' }),
        ],
      },
      TODAY,
    );

    expect(evidence.ebook).toMatchObject({ count: 3, date: '2027-05-11', precision: 'day', strength: 'strong' });
  });

  it('reports zero ebook editions when Blightfall has audio and physical only', () => {
    const evidence = buildHardcoverEvidence(
      {
        slug: 'blightfall',
        releaseDate: '2026-09-01',
        editions: [
          edition({ readingFormatId: 2, releaseDate: '2026-09-01', asin: 'B012345678' }),
          edition({ readingFormatId: 1, releaseDate: '2026-09-01', isbn10: '123456789X' }),
        ],
      },
      TODAY,
    );

    expect(evidence.ebook.count).toBe(0);
    expect(evidence.audiobook.count).toBe(1);
    expect(evidence.physical).toEqual({ count: 1, seeds: ['123456789X'] });
  });

  it('keeps the evidence of a work whose editions are all German', () => {
    const evidence = buildHardcoverEvidence(
      {
        slug: 'der-turm',
        releaseDate: '2026-11-02',
        editions: [
          edition({ readingFormatId: 4, releaseDate: '2026-11-02', asin: 'B012345678', usersCount: 30, languageCode: 'de' }),
          edition({ readingFormatId: 2, releaseDate: '2026-11-09', usersCount: 5, languageCode: 'de' }),
        ],
      },
      TODAY,
    );

    expect(evidence.ebook).toMatchObject({ count: 1, date: '2026-11-02', strength: 'strong' });
    expect(evidence.audiobook).toMatchObject({ count: 1, date: '2026-11-09' });
  });

  it('drops translations of an English work and keeps language-less editions', () => {
    const evidence = buildHardcoverEvidence(
      {
        slug: 'the-tower',
        releaseDate: '2026-11-02',
        editions: [
          edition({ readingFormatId: 4, releaseDate: '2026-11-02', usersCount: 400, languageCode: 'en' }),
          edition({ readingFormatId: 4, releaseDate: '2026-02-03', usersCount: 8, languageCode: 'fr' }),
          edition({ readingFormatId: 4, releaseDate: '2026-11-04', usersCount: 2 }),
        ],
      },
      TODAY,
    );

    expect(evidence.ebook).toMatchObject({ count: 2, date: '2026-11-02' });
  });

  it('maps the raw GraphQL shape and normalizes nullable counts and languages', () => {
    expect(
      mapHardcoverProbeBook({
        slug: 'book',
        release_date: '2027-01-02',
        editions: [
          {
            reading_format_id: 4,
            release_date: '2027-01-02',
            asin: null,
            isbn_13: null,
            isbn_10: null,
            users_count: null,
            language: null,
          },
        ],
      }),
    ).toEqual({
      slug: 'book',
      releaseDate: '2027-01-02',
      editions: [
        {
          readingFormatId: 4,
          releaseDate: '2027-01-02',
          asin: null,
          isbn13: null,
          isbn10: null,
          usersCount: 0,
          languageCode: null,
        },
      ],
    });
  });
});
