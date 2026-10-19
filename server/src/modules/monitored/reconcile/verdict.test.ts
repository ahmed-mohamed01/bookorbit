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

  it('flags a listing whose title names its translation', () => {
    const result = assignVerdict(work('goodreads', { title: 'Primal Hunter 5 (German Edition)' }), { today, floor: {} });

    expect(result.flags).toContain('foreign_language');
  });

  it('flags a listing filed only under translated series', () => {
    const polish = work('goodreads', {
      title: 'Expeditionary Force. Tom 16. Konsekwencje',
      seriesName: 'Expeditionary Force (Polish Edition)',
      seriesIndex: '16',
    });

    expect(assignVerdict(polish, { today, floor: {} }).flags).toContain('foreign_language');
  });

  it('does not flag an English book that also carries one translated series', () => {
    const steelheart = work('hardcover', {
      title: 'Steelheart',
      seriesName: 'The Reckoners',
      seriesIndex: '1',
      seriesMemberships: [{ name: 'Reckoners (Spanish Edition)', index: '1' }],
    });

    expect(assignVerdict(steelheart, { today, floor: {} }).flags).not.toContain('foreign_language');
  });

  it('sets no flag for a dramatized or split title', () => {
    for (const title of ['Red Rising (1 of 2) [Dramatized Adaptation]', 'The Way of Kings, Part 1']) {
      const result = assignVerdict(work('hardcover', { title, sources: ['hardcover', 'goodreads'], cover: 'c' }), { today, floor: {} });

      expect(result.flags).toEqual([]);
    }
  });

  it("does not flag Hardcover's compilation boolean or a bundle title", () => {
    for (const title of ['Axiom', 'Mistborn Trilogy Boxed Set']) {
      const result = assignVerdict(work('hardcover', { title, compilationFlag: true, sources: ['hardcover', 'goodreads'], cover: 'c' }), {
        today,
        floor: {},
      });

      expect(result.flags).toEqual([]);
    }
  });

  it('reads the foreword credit off the best-read row', () => {
    const row = (id: string, role: string, popularity: number) =>
      ({ source: 'hardcover', id, role, popularity, raw: {} }) as unknown as MergedWork['observations'][number];
    const result = assignVerdict(
      work('hardcover', {
        title: 'The Shining Ones',
        sources: ['hardcover', 'goodreads'],
        cover: 'c',
        observations: [row('hc:1', 'Foreword', 9), row('hc:2', 'Author', 0)],
      }),
      { today, floor: {} },
    );

    expect(result.flags).toContain('wrong_contributor');
  });

  it('flags a book the author only wrote the foreword for', () => {
    const observation = {
      source: 'hardcover',
      id: 'hc:1',
      role: 'Foreword',
      popularity: 26,
      raw: {},
    } as unknown as MergedWork['observations'][number];
    const result = assignVerdict(
      work('hardcover', { title: "King's League", sources: ['hardcover', 'goodreads'], cover: 'c', observations: [observation] }),
      { today, floor: {} },
    );

    expect(result.flags).toContain('wrong_contributor');
  });

  describe('foreign editions', () => {
    const corroborated = { sources: ['hardcover', 'goodreads'] as MergedWork['sources'], cover: 'c' };
    const hardcoverRow = (patch: Record<string, unknown>) =>
      ({
        source: 'hardcover',
        id: 'hc:1',
        role: 'Author',
        popularity: 0,
        language: null,
        raw: {},
        ...patch,
      }) as unknown as MergedWork['observations'][number];
    const translator = { cached_contributors: [{ contribution: null }, { contribution: 'Translator' }] };

    it('flags a title with non-English letters', () => {
      for (const title of ['Černé léto', 'Oceánem hvězd']) {
        expect(assignVerdict(work('hardcover', { title, ...corroborated }), { today, floor: {} }).flags).toContain('foreign_language');
      }
    });

    it('flags a translation known only by its series name', () => {
      const result = assignVerdict(work('hardcover', { title: 'Carl', seriesMemberships: [{ name: 'Hrobkař Carl', index: '1' }], ...corroborated }), {
        today,
        floor: {},
      });

      expect(result.flags).toContain('foreign_language');
    });

    it('flags a translator-credited listing', () => {
      const result = assignVerdict(work('hardcover', { title: 'La rebelión', ...corroborated, observations: [hardcoverRow({ raw: translator })] }), {
        today,
        floor: {},
      });

      expect(result.flags).toContain('foreign_language');
    });

    it('flags an accented title that has no English edition', () => {
      const result = assignVerdict(work('hardcover', { title: 'La rebelión', ...corroborated, observations: [hardcoverRow({ language: null })] }), {
        today,
        floor: {},
      });

      expect(result.flags).toContain('foreign_language');
    });

    it('keeps an accented English title', () => {
      const result = assignVerdict(
        work('hardcover', { title: 'Café Endless: Spring Rain', ...corroborated, observations: [hardcoverRow({ language: 'english' })] }),
        { today, floor: {} },
      );

      expect(result.flags).not.toContain('foreign_language');
    });

    it('keeps a well-read accented English title with no language data', () => {
      const result = assignVerdict(
        work('hardcover', {
          title: 'Déjà Dead',
          ...corroborated,
          popularity: { hardcover: 5000 },
          observations: [hardcoverRow({ popularity: 5000 })],
        }),
        { today, floor: {} },
      );

      expect(result.flags).not.toContain('foreign_language');
    });

    it('keeps a well-read translator-credited book with no language data', () => {
      const result = assignVerdict(
        work('hardcover', {
          title: 'The Three-Body Problem',
          ...corroborated,
          popularity: { hardcover: 5000 },
          observations: [hardcoverRow({ popularity: 5000, raw: translator })],
        }),
        { today, floor: {} },
      );

      expect(result.flags).not.toContain('foreign_language');
    });

    it('keeps an English translation of a translated author', () => {
      const result = assignVerdict(
        work('hardcover', {
          title: 'The Three-Body Problem',
          ...corroborated,
          popularity: { hardcover: 5000 },
          observations: [hardcoverRow({ language: 'english', popularity: 5000, raw: translator })],
        }),
        { today, floor: {} },
      );

      expect(result.flags).not.toContain('foreign_language');
    });

    it('leaves a plain English book alone', () => {
      const result = assignVerdict(
        work('hardcover', { title: 'Children of Time', ...corroborated, observations: [hardcoverRow({ language: 'english' })] }),
        { today, floor: {} },
      );

      expect(result.flags).toEqual([]);
    });
  });
});
