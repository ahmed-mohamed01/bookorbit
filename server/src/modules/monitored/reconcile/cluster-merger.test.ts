import { describe, expect, it } from 'vitest';

import { mergeCluster } from './cluster-merger';
import type { Observation, WorkCluster } from './observation.types';

function observation(source: Observation['source'], patch: Partial<Observation> = {}): Observation {
  return {
    source,
    id: `${source}:1`,
    canonicalId: null,
    title: 'Test Book',
    subtitle: null,
    hasDesc: false,
    description: null,
    cover: null,
    releaseDate: null,
    releaseYear: null,
    precision: null,
    seriesName: null,
    seriesIndex: null,
    seriesMemberships: [],
    popularity: 0,
    popularityKind: source === 'hardcover' ? 'users' : 'ratings',
    format: source === 'audible' ? 'audiobook' : 'unknown',
    language: source === 'audible' ? 'english' : null,
    role: null,
    isbn10: null,
    isbn13: null,
    asin: source === 'audible' ? 'ASIN1' : null,
    raw: source === 'hardcover' ? { id: 1, slug: 'test-book' } : source === 'goodreads' ? { bookId: '1' } : { asin: 'ASIN1' },
    ...patch,
  };
}

function cluster(...observations: Observation[]): WorkCluster {
  return { observations };
}

describe('mergeCluster', () => {
  it('keeps an unreleased Audible date as the audio date', () => {
    const work = mergeCluster(cluster(observation('audible', { releaseDate: '2027-04-12', releaseYear: 2027, precision: 'day' })), '2026-09-03');

    expect(work.audioReleaseDate).toBe('2027-04-12');
    expect(work.audioDateSource).toBe('audible');
  });

  it('keeps a released Hardcover date as the ebook date', () => {
    const work = mergeCluster(cluster(observation('hardcover', { releaseDate: '2024-05-12', releaseYear: 2024, precision: 'day' })), '2026-09-03');

    expect(work.ebookReleaseDate).toBe('2024-05-12');
    expect(work.ebookDateSource).toBe('hardcover');
  });

  it('does not let a Goodreads year override a Hardcover full date', () => {
    const work = mergeCluster(
      cluster(
        observation('hardcover', { releaseDate: '2024-05-12', releaseYear: 2024, precision: 'day' }),
        observation('goodreads', { id: 'gr:1', releaseYear: 2025, precision: 'year' }),
      ),
      '2026-09-03',
    );

    expect(work.ebookReleaseDate).toBe('2024-05-12');
    expect(work.ebookDatePrecision).toBe('day');
  });

  it('rejects a January 1 placeholder date and falls back to year precision', () => {
    const work = mergeCluster(
      cluster(
        observation('hardcover', { releaseDate: '2025-01-01', releaseYear: 2025, precision: 'day' }),
        observation('goodreads', { id: 'gr:1', releaseYear: 2025, precision: 'year' }),
      ),
      '2026-09-03',
    );

    expect(work.ebookReleaseDate).toBe('2025');
    expect(work.ebookDatePrecision).toBe('year');
  });

  it('does not re-admit a rejected outlier year through the fallback', () => {
    const work = mergeCluster(
      cluster(
        observation('hardcover', { id: 'hc:outlier', releaseDate: '2099-07-04', releaseYear: 2099, precision: 'day', popularity: 200 }),
        observation('hardcover', { id: 'hc:real', releaseYear: 2024, precision: 'year', popularity: 100 }),
        observation('goodreads', { id: 'gr:1', releaseYear: 2024, precision: 'year' }),
      ),
      '2026-09-03',
    );

    expect(work.ebookReleaseDate).toBe('2024');
    expect(work.ebookDatePrecision).toBe('year');
  });

  it('judges an audiobook date against the audio timeline, not the text consensus', () => {
    const work = mergeCluster(
      cluster(
        observation('hardcover', { releaseDate: '2019-04-04', releaseYear: 2019, precision: 'day' }),
        observation('goodreads', { id: 'gr:1', releaseDate: '2019-04-04', releaseYear: 2019, precision: 'day' }),
        observation('audible', { releaseDate: '2026-06-04', releaseYear: 2026, precision: 'day' }),
      ),
      '2026-09-03',
    );

    expect(work.ebookReleaseDate).toBe('2019-04-04');
    expect(work.audioReleaseDate).toBe('2026-06-04');
    expect(work.audioDatePrecision).toBe('day');
  });

  it('does not mark a long-released work unreleased over one far-future placeholder edition', () => {
    const work = mergeCluster(
      cluster(
        observation('hardcover', { id: 'hc:dominant', releaseDate: '2015-03-10', releaseYear: 2015, precision: 'day', popularity: 100 }),
        observation('hardcover', { id: 'hc:placeholder', releaseDate: '2099-01-02', releaseYear: 2099, precision: 'day', popularity: 1 }),
        observation('goodreads', { id: 'gr:1', releaseYear: 2015, precision: 'year' }),
      ),
      '2026-09-03',
    );

    expect(work.ebookReleaseDate).toBe('2015-03-10');
    expect(work.unreleased).toBe(false);
  });

  it('still marks a genuinely upcoming work unreleased', () => {
    const work = mergeCluster(cluster(observation('audible', { releaseDate: '2027-04-12', releaseYear: 2027, precision: 'day' })), '2026-09-03');

    expect(work.unreleased).toBe(true);
  });

  it('takes series memberships from Hardcover only', () => {
    const work = mergeCluster(
      cluster(
        observation('goodreads', {
          seriesMemberships: [
            { name: 'Secret Projects', index: '2' },
            { name: 'The Cosmere', index: '28' },
          ],
        }),
        observation('audible', {
          seriesMemberships: [
            { name: 'secret projects', index: '3' },
            { name: "Hoid's Travails", index: '1' },
          ],
        }),
        observation('hardcover', {
          seriesMemberships: [
            { name: 'Secret Projects', index: '1' },
            { name: 'The Cosmere', index: '29' },
          ],
        }),
      ),
      '2026-09-03',
    );

    expect(work.seriesMemberships).toEqual([
      { name: 'Secret Projects', index: '1' },
      { name: 'The Cosmere', index: '29' },
    ]);
  });

  it('produces identical output for every observation order', () => {
    const observations = [
      observation('hardcover', { id: 'hc:b', title: 'Less Popular', popularity: 10, releaseDate: '2024-06-01', releaseYear: 2024 }),
      observation('hardcover', { id: 'hc:a', title: 'Dominant', popularity: 20, releaseDate: '2024-05-01', releaseYear: 2024 }),
      observation('audible', { id: 'aud:b', title: 'Audio B', popularity: 5, releaseDate: '2024-07-01', releaseYear: 2024 }),
      observation('audible', { id: 'aud:a', title: 'Audio A', popularity: 5, releaseDate: '2024-08-01', releaseYear: 2024 }),
    ];
    const expected = mergeCluster(cluster(...observations), '2026-09-03');
    const permutations = [
      [...observations].reverse(),
      [observations[2], observations[0], observations[3], observations[1]],
      [observations[1], observations[3], observations[0], observations[2]],
    ];

    for (const permuted of permutations) expect(mergeCluster(cluster(...permuted), '2026-09-03')).toEqual(expected);
  });
});
