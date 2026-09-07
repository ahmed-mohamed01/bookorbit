import { describe, expect, it } from 'vitest';

import type { MergedWork, ObservationSource } from './observation.types';
import { assignVerdict } from './verdict';

const today = '2026-09-03';

function work(source: ObservationSource, patch: Partial<MergedWork> = {}): MergedWork {
  return {
    title: 'A Real Book',
    subtitle: null,
    coreTitle: 'a real book',
    ebookReleaseDate: '2020-05-01',
    ebookDatePrecision: 'day',
    ebookDateSource: source,
    audioReleaseDate: null,
    audioDatePrecision: null,
    audioDateSource: null,
    releaseYear: 2020,
    seriesName: null,
    seriesIndex: null,
    seriesMemberships: [],
    seriesSource: null,
    cover: null,
    coverSource: null,
    description: null,
    hasDesc: false,
    sources: [source],
    providerWorkIds: { [source]: '1' },
    popularity: { [source]: 0 },
    unreleased: false,
    compilationFlag: false,
    allRolesNonAuthor: false,
    allForeign: false,
    observations: [],
    ...patch,
  };
}

describe('assignVerdict', () => {
  it('verifies a work seen by two sources', () => {
    const result = assignVerdict(work('hardcover', { sources: ['hardcover', 'goodreads'] }), { today, floor: {} });

    expect(result.verdict).toBe('verified');
  });

  it('marks a low-popularity old single-source work suspect', () => {
    const result = assignVerdict(work('hardcover'), { today, floor: { hardcover: 2 } });

    expect(result.verdict).toBe('suspect');
  });

  it('verifies an upcoming Hardcover work regardless of readership', () => {
    const result = assignVerdict(work('hardcover', { ebookReleaseDate: '2027-01-20', releaseYear: 2027, unreleased: true }), {
      today,
      floor: { hardcover: 100 },
    });

    expect(result.verdict).toBe('verified');
  });

  it('verifies a well-read single-source Hardcover work', () => {
    const result = assignVerdict(work('hardcover', { popularity: { hardcover: 5000 } }), { today, floor: { hardcover: 2 } });

    expect(result.verdict).toBe('verified');
  });

  it('keeps a stray below the computed Hardcover floor unverified', () => {
    const result = assignVerdict(work('hardcover', { popularity: { hardcover: 8 } }), {
      today,
      floor: { hardcover: 10 },
    });

    expect(result.verdict).toBe('suspect');
  });

  it('does not verify a work with no Hardcover edition (Audible/Goodreads only)', () => {
    const result = assignVerdict(
      work('audible', {
        ebookReleaseDate: null,
        ebookDatePrecision: null,
        ebookDateSource: null,
        audioReleaseDate: '2027-01-20',
        audioDatePrecision: 'day',
        audioDateSource: 'audible',
        releaseYear: 2027,
        unreleased: true,
      }),
      { today, floor: { audible: 100 } },
    );

    expect(result.verdict).toBe('suspect');
  });

  it('does not verify a two-source work that carries no evidence of its own', () => {
    const result = assignVerdict(
      work('hardcover', {
        title: 'Mistborn: The Final Empire - Annotations',
        sources: ['goodreads', 'hardcover'],
        popularity: { hardcover: 2, goodreads: 1 },
        ebookReleaseDate: null,
        ebookDatePrecision: null,
        releaseYear: null,
      }),
      { today, floor: { hardcover: 6 } },
    );

    expect(result.verdict).toBe('suspect');
  });

  it('still verifies a two-source work once it has any evidence of its own', () => {
    const result = assignVerdict(
      work('hardcover', {
        title: 'A Quiet Cosmere Novella',
        sources: ['goodreads', 'hardcover'],
        popularity: { hardcover: 2, goodreads: 1 },
        cover: 'https://example.test/cover.jpg',
        ebookReleaseDate: null,
        ebookDatePrecision: null,
        releaseYear: null,
      }),
      { today, floor: { hardcover: 6 } },
    );

    expect(result.verdict).toBe('verified');
  });

  it('does not call an announced book a placeholder when it holds a numbered series slot', () => {
    const result = assignVerdict(
      work('hardcover', {
        title: 'Untitled Stormlight Archive #6',
        seriesMemberships: [{ name: 'The Stormlight Archive', index: '6' }],
        popularity: { hardcover: 240 },
        ebookReleaseDate: null,
        ebookDatePrecision: null,
        releaseYear: null,
      }),
      { today, floor: { hardcover: 6 } },
    );

    expect(result.flags).not.toContain('placeholder');
  });

  it('still flags an Untitled stub that holds no series slot', () => {
    const result = assignVerdict(
      work('hardcover', { title: 'Untitled', popularity: { hardcover: 2 }, ebookReleaseDate: null, ebookDatePrecision: null, releaseYear: null }),
      { today, floor: { hardcover: 6 } },
    );

    expect(result.flags).toContain('placeholder');
  });

  it('does not call a numbered sequel a placeholder before its cover exists', () => {
    const result = assignVerdict(
      work('hardcover', {
        title: 'New Life as a Max Level Archmage, Book 2',
        seriesName: 'New Life as a Max Level Archmage',
        seriesMemberships: [{ name: 'New Life as a Max Level Archmage', index: '2' }],
        sources: ['goodreads', 'hardcover'],
        popularity: { hardcover: 1, goodreads: 1 },
        cover: null,
        hasDesc: false,
        ebookReleaseDate: '2026-12-09',
        releaseYear: 2026,
        unreleased: true,
      }),
      { today, floor: { hardcover: 6 } },
    );

    expect(result.flags).not.toContain('placeholder');
    expect(result.verdict).toBe('verified');
  });

  it('does not treat a numeric title as a series stub when the series name is non-Latin', () => {
    const result = assignVerdict(
      work('hardcover', {
        title: '1984',
        seriesName: 'ミストボーン',
        seriesMemberships: [],
        popularity: { hardcover: 1 },
        cover: null,
        hasDesc: false,
        ebookReleaseDate: null,
        ebookDatePrecision: null,
        releaseYear: null,
      }),
      { today, floor: { hardcover: 6 } },
    );

    expect(result.flags).not.toContain('placeholder');
  });
});
