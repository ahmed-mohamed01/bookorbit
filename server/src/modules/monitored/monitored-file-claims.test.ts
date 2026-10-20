import { describe, expect, it } from 'vitest';
import type { MonitoredFormat } from '@bookorbit/types';

import { titleMatchKeys } from './monitored-catalog.service';
import {
  assignExclusiveClaims,
  bookShapeConflict,
  fileFormatConflict,
  fileLanguage,
  namedAfter,
  preferLanguageFit,
  scoreClaim,
  splitPartOf,
  type AssignableWork,
  type ClaimCandidate,
  type ClaimWork,
  type ScoredClaimInput,
} from './monitored-file-claims';

function candidate(patch: Partial<ClaimCandidate> = {}): ClaimCandidate {
  return {
    bookId: 1,
    title: 'Steelheart',
    titleKey: 'steelheart',
    seriesName: null,
    seriesIndex: null,
    publishedYear: null,
    formats: new Set(['epub']),
    ...patch,
  };
}

function claimWork(patch: Partial<ClaimWork> = {}): ClaimWork {
  return { title: 'Steelheart', seriesName: null, seriesIndex: null, releaseYear: null, flags: [], ...patch };
}

describe('splitPartOf', () => {
  it.each([
    ['Words of Radiance Part One', '1'],
    ['Words of Radiance, Part 2', '2'],
    ['Words of Radiance: Part II (The Stormlight Archive)', '2'],
    ['The Way of Kings (3 of 5) [Dramatized Adaptation]', '3'],
    ['The Way of Kings Pt. 2 of 2', '2'],
    ['Words of Radiance (Part 1)', '1'],
    ['Words of Radiance (Part 1 of 2)', '1'],
    ['Words of Radiance [Part Two]', '2'],
  ])('reads the part of %s', (title, part) => {
    expect(splitPartOf(title)).toBe(part);
  });

  it.each(['Words of Radiance', 'Part-Time Hero', 'The Part', 'Legion: Lies of the Beholder'])('reads %s as a whole book', (title) => {
    expect(splitPartOf(title)).toBeNull();
  });
});

describe('namedAfter', () => {
  it('reads a collection file as named after its own work, from either side of the colon', () => {
    expect(namedAfter('Arcanum Unbounded', 'Arcanum Unbounded: The Cosmere Collection', titleMatchKeys)).toBe(true);
    expect(namedAfter('Arcanum Unbounded: The Cosmere Collection', 'Arcanum Unbounded', titleMatchKeys)).toBe(true);
  });

  it('does not read a book inside a bundle as the bundle', () => {
    const bundle = 'The Stormlight Archive Bundle: Words of Radiance Part One, Words of Radiance Part Two, The Way of Kings Part Two';
    expect(namedAfter(bundle, 'Words of Radiance', titleMatchKeys)).toBe(false);
    expect(
      namedAfter('Mistborn: The Final Empire', 'The Mistborn Trilogy: The Final Empire, The Well of Ascension, The Hero of Ages', titleMatchKeys),
    ).toBe(false);
  });
});

describe('bookShapeConflict', () => {
  it('keeps a bundle off one of its parts and a single book off a collection file', () => {
    const bundle = claimWork({ title: 'The Stormlight Archive Bundle: Words of Radiance Part One', kind: 'collection' });
    expect(bookShapeConflict(bundle, candidate({ title: 'Words of Radiance' }), titleMatchKeys)).toBe('collection_part');
    expect(bookShapeConflict(claimWork({ title: 'The Final Empire' }), candidate({ title: 'The Mistborn Trilogy' }), titleMatchKeys)).toBe(
      'collection_file',
    );
  });

  it('does not read one numbered book of a series as a collection file', () => {
    expect(
      bookShapeConflict(claimWork({ title: 'Shadow and Bone' }), candidate({ title: 'Shadow and Bone - The Grisha Trilogy Book 1' }), titleMatchKeys),
    ).toBeNull();
    expect(bookShapeConflict(claimWork({ title: 'Mistborn' }), candidate({ title: 'Mistborn Trilogy Books 1-3' }), titleMatchKeys)).toBe(
      'collection_file',
    );
  });

  it('keeps a plain work off a dramatized production', () => {
    expect(bookShapeConflict(claimWork({ title: 'Mistborn' }), candidate({ title: 'Mistborn [Dramatized Adaptation]' }), titleMatchKeys)).toBe(
      'dramatized_file',
    );
    expect(
      bookShapeConflict(
        claimWork({ title: 'Mistborn [Dramatized Adaptation]', kind: 'dramatization' }),
        candidate({ title: 'Mistborn [Dramatized Adaptation]' }),
        titleMatchKeys,
      ),
    ).toBeNull();
  });

  it('lets an anthology match its own file', () => {
    const unfettered = claimWork({ title: 'Unfettered', kind: 'anthology' });
    expect(bookShapeConflict(unfettered, candidate({ title: 'Unfettered: Tales by Masters of Fantasy' }), titleMatchKeys)).toBeNull();
  });

  it('honours the owner marking a work a plain book', () => {
    const marked = claimWork({ title: 'Arcanum Unbounded', kind: 'collection', userKind: 'book' });
    expect(bookShapeConflict(marked, candidate({ title: 'Arcanum Unbounded' }), titleMatchKeys)).toBeNull();
  });

  it('keeps a split part off the whole book and off another part', () => {
    expect(bookShapeConflict(claimWork({ title: 'Words of Radiance Part One' }), candidate({ title: 'Words of Radiance' }), titleMatchKeys)).toBe(
      'split_part',
    );
    expect(
      bookShapeConflict(claimWork({ title: 'Words of Radiance Part One' }), candidate({ title: 'Words of Radiance Part Two' }), titleMatchKeys),
    ).toBe('split_part');
    expect(bookShapeConflict(claimWork({ title: 'Words of Radiance' }), candidate({ title: 'Words of Radiance, Part 1' }), titleMatchKeys)).toBe(
      'split_part',
    );
    expect(
      bookShapeConflict(claimWork({ title: 'Words of Radiance Part One' }), candidate({ title: 'Words of Radiance, Part 1' }), titleMatchKeys),
    ).toBeNull();
  });

  it('keeps a translation off a file tagged English, and leaves an untagged file to the score', () => {
    const translation = claimWork({ flags: ['foreign_language'] });
    expect(bookShapeConflict(translation, candidate({ language: 'en-GB' }), titleMatchKeys)).toBe('language');
    expect(bookShapeConflict(translation, candidate({ language: 'spa' }), titleMatchKeys)).toBeNull();
    expect(bookShapeConflict(translation, candidate(), titleMatchKeys)).toBeNull();
  });
});

describe('fileFormatConflict', () => {
  it('lets comics match comic formats, pdfs and fixed-layout epubs only', () => {
    const comic = claimWork({ kind: 'graphic_novel' });
    expect(fileFormatConflict(comic, candidate(), 'epub')).toBe('comic_format');
    expect(fileFormatConflict(comic, candidate({ fixedLayoutFormats: new Set(['epub']) }), 'epub')).toBeNull();
    expect(fileFormatConflict(comic, candidate(), 'cbz')).toBeNull();
    expect(fileFormatConflict(comic, candidate(), 'pdf')).toBeNull();
    expect(fileFormatConflict(claimWork({ title: 'Mistborn (Manga)' }), candidate(), 'epub')).toBe('comic_format');
  });

  it('honours a prose mark on a comic-sounding title, and leaves a comic its audiobook', () => {
    expect(fileFormatConflict(claimWork({ title: 'The Comic Sans Murders', userKind: 'book' }), candidate(), 'epub')).toBeNull();
    expect(fileFormatConflict(claimWork({ kind: 'graphic_novel' }), candidate(), 'm4b')).toBeNull();
  });

  it('keeps prose off comic archives and dramatizations off ebooks', () => {
    expect(fileFormatConflict(claimWork(), candidate(), 'cbr')).toBe('prose_format');
    expect(fileFormatConflict(claimWork({ kind: 'dramatization' }), candidate(), 'epub')).toBe('audio_only');
    expect(fileFormatConflict(claimWork({ kind: 'dramatization' }), candidate(), 'm4b')).toBeNull();
  });
});

describe('scoreClaim', () => {
  const context = { exactTitle: true, sameSeriesSlot: true };
  const weak = { exactTitle: false, sameSeriesSlot: false };

  it('ranks the book above a translation when the file says nothing of its language', () => {
    const book = scoreClaim(claimWork(), { candidate: candidate(), tier: 2 }, context);
    const translation = scoreClaim(claimWork({ flags: ['foreign_language'] }), { candidate: candidate(), tier: 0 }, weak);
    expect(book).toBe(50);
    expect(book - translation).toBeGreaterThanOrEqual(10);
  });

  it('lets a translation keep a file in its own language', () => {
    const spanishFile = candidate({ language: 'spa' });
    const translation = scoreClaim(claimWork({ flags: ['foreign_language'] }), { candidate: spanishFile, tier: 2 }, context);
    const english = scoreClaim(claimWork(), { candidate: spanishFile, tier: 2 }, context);
    expect(translation).toBe(50);
    expect(translation - english).toBeGreaterThanOrEqual(10);
  });

  it('does not mark down a collection or a dramatization on a file of its own shape', () => {
    expect(scoreClaim(claimWork({ kind: 'collection' }), { candidate: candidate(), tier: 2 }, context)).toBe(50);
    const drama = claimWork({ kind: 'dramatization' });
    expect(scoreClaim(drama, { candidate: candidate({ title: 'Mistborn [Dramatized Adaptation]' }), tier: 2 }, context)).toBe(50);
    expect(scoreClaim(drama, { candidate: candidate({ title: 'Mistborn' }), tier: 2 }, context)).toBe(20);
  });

  it('marks down a file in another language for an English work', () => {
    expect(scoreClaim(claimWork(), { candidate: candidate({ language: 'es' }), tier: 2 }, context)).toBe(25);
    expect(scoreClaim(claimWork(), { candidate: candidate({ language: 'und' }), tier: 2 }, context)).toBe(50);
  });
});

describe('fileLanguage', () => {
  it.each([
    ['en', 'english'],
    ['en-US', 'english'],
    ['English', 'english'],
    ['spa', 'other'],
    ['es, fr', 'other'],
    ['English; Spanish', 'unknown'],
    ['en,es', 'unknown'],
    ['und', 'unknown'],
    ['', 'unknown'],
  ])('reads %s as %s', (tag, expected) => {
    expect(fileLanguage(tag)).toBe(expected);
  });
});

describe('preferLanguageFit', () => {
  it('keeps the copies in the work language when there are any', () => {
    const spanish = { candidate: candidate({ bookId: 1, language: 'spa' }), tier: 2 };
    const english = { candidate: candidate({ bookId: 2, language: 'eng' }), tier: 2 };
    expect(preferLanguageFit(claimWork(), [spanish, english])).toEqual([english]);
    expect(preferLanguageFit(claimWork({ flags: ['foreign_language'] }), [spanish, english])).toEqual([spanish]);
    expect(preferLanguageFit(claimWork(), [spanish])).toEqual([spanish]);
  });
});

describe('assignExclusiveClaims', () => {
  interface TestWork {
    id: string;
    score: Record<number, number>;
  }
  const kindOf = (format: string): MonitoredFormat => (format === 'm4b' ? 'audiobook' : 'ebook');
  const pickBest = (work: TestWork, claims: ScoredClaimInput[]) =>
    claims.reduce<ScoredClaimInput | null>(
      (best, claim) => (!best || work.score[claim.candidate.bookId] > work.score[best.candidate.bookId] ? claim : best),
      null,
    );
  const entry = (work: TestWork, bookIds: number[], skip: MonitoredFormat[] = []): AssignableWork<TestWork, ScoredClaimInput> => ({
    work,
    formatKind: kindOf,
    claimsByFormat: new Map([['epub', bookIds.map((bookId) => ({ candidate: candidate({ bookId }), tier: 2 }))]]),
    skipKinds: new Set(skip),
  });

  it('gives a shared book to the clear winner and lets the loser fall through', () => {
    const real = { id: 'real', score: { 1: 50 } };
    const bundle = { id: 'bundle', score: { 1: 30, 2: 20 } };

    const { origins } = assignExclusiveClaims(
      [entry(real, [1]), entry(bundle, [1, 2])],
      pickBest,
      (work, claim) => work.score[claim.candidate.bookId],
    );

    expect(origins.get(real)).toEqual(new Map([['epub', 1]]));
    expect(origins.get(bundle)).toEqual(new Map([['epub', 2]]));
  });

  it('gives a book two works claim within the margin to neither', () => {
    const left = { id: 'left', score: { 1: 35 } };
    const right = { id: 'right', score: { 1: 30 } };

    const { origins, contested } = assignExclusiveClaims(
      [entry(left, [1]), entry(right, [1])],
      pickBest,
      (work, claim) => work.score[claim.candidate.bookId],
    );

    expect(origins.get(left)?.size).toBe(0);
    expect(origins.get(right)?.size).toBe(0);
    expect(contested.get(left)?.[0].candidate.bookId).toBe(1);
    expect(contested.get(right)?.[0].candidate.bookId).toBe(1);
  });

  it('keeps a work to one book per format kind', () => {
    const work = { id: 'w', score: { 1: 50, 2: 40 } };
    const twoFormats: AssignableWork<TestWork, ScoredClaimInput> = {
      work,
      formatKind: kindOf,
      claimsByFormat: new Map([
        ['epub', [1, 2].map((bookId) => ({ candidate: candidate({ bookId }), tier: 2 }))],
        ['mobi', [{ candidate: candidate({ bookId: 2 }), tier: 2 }]],
      ]),
      skipKinds: new Set(),
    };

    const { origins } = assignExclusiveClaims([twoFormats], pickBest, (w, claim) => w.score[claim.candidate.bookId]);

    expect(origins.get(work)).toEqual(new Map([['epub', 1]]));
  });

  it('leaves books held outside the pass, and formats the owner linked, alone', () => {
    const only = { id: 'only', score: { 1: 50 } };
    const held = assignExclusiveClaims([entry(only, [1])], pickBest, () => 50, new Set(['1|ebook']));
    expect(held.origins.get(only)?.size).toBe(0);

    const linked = assignExclusiveClaims([entry(only, [1], ['ebook'])], pickBest, () => 50);
    expect(linked.origins.get(only)?.size).toBe(0);
  });
});
