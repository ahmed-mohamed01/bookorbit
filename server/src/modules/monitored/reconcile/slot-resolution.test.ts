import { describe, expect, it } from 'vitest';

import type { MergedWork, Observation } from './observation.types';
import { resolveSlots } from './slot-resolution';

const today = '2026-09-07';

function observation(id: string, popularity: number, raw: Record<string, unknown>): Observation {
  return {
    source: 'hardcover',
    id: `hc:${id}`,
    canonicalId: null,
    title: typeof raw.title === 'string' ? raw.title : id,
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
    popularity,
    popularityKind: 'users',
    format: 'unknown',
    language: 'english',
    role: 'Author',
    isbn10: null,
    isbn13: null,
    asin: null,
    raw,
  };
}

/**
 * The new Hardcover fields ride on `Observation.raw`, so the builder takes the raw book record
 * separately and defaults it to a live, author-contributed row.
 */
function work(id: string, patch: Partial<MergedWork> = {}, raw: Record<string, unknown> = {}): MergedWork {
  const title = patch.title ?? id;
  const popularity = patch.popularity?.hardcover ?? 0;
  const book = { id: Number(id), title, book_status: { id: 1, name: 'Published' }, contributor_role_id: 1, ...raw };
  return {
    title,
    subtitle: null,
    coreTitle: title.toLowerCase(),
    ebookReleaseDate: '2020-05-01',
    ebookDatePrecision: 'day',
    ebookDateSource: 'hardcover',
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
    sources: ['hardcover'],
    providerWorkIds: { hardcover: id },
    popularity: { hardcover: popularity },
    unreleased: false,
    compilationFlag: false,
    allRolesNonAuthor: false,
    allForeign: false,
    observations: [observation(id, popularity, book)],
    ...patch,
  };
}

function seriesRaw(...entries: { id: number; name: string; position: number | string | null }[]): Record<string, unknown> {
  return { book_series: entries.map(({ id, name, position }) => ({ position, series: { id, name } })) };
}

describe('resolveSlots', () => {
  it('hides a book credited to a crowd of authors as a multi-author anthology', () => {
    const contributors = Array.from({ length: 6 }, (_, i) => ({ author: { id: 100 + i, name: `Author ${i}` }, contribution: null }));
    const result = resolveSlots(
      [work('1', { title: 'Unfettered III', popularity: { hardcover: 100 } }, { cached_contributors: contributors })],
      today,
    );

    expect([...result.hidden]).toEqual([0]);
    expect(result.reasons.get(0)).toBe('multi_author_anthology');
  });

  it('counts author credits on one representative row, never unioned across the cluster', () => {
    // Each translation names its own translator as an author, so unioning buries real novels.
    const english = observation('1', 5000, {
      title: 'The Alloy of Law',
      book_status: { id: 1, name: 'OK' },
      contributor_role_id: 1,
      users_count: 5000,
      cached_contributors: [{ author: { id: 1, name: 'Brandon Sanderson' }, contribution: null }],
    });
    const translations = Array.from({ length: 5 }, (_, i) =>
      observation(`t${i}`, 2, {
        title: `Aleación de ley ${i}`,
        book_status: { id: 1, name: 'OK' },
        contributor_role_id: 1,
        users_count: 2,
        cached_contributors: [
          { author: { id: 1, name: 'Brandon Sanderson' }, contribution: null },
          { author: { id: 200 + i, name: `Translator ${i}` }, contribution: null },
        ],
      }),
    );
    const merged = work('1', { title: 'The Alloy of Law', popularity: { hardcover: 5000 } });
    merged.observations = [english, ...translations];

    const result = resolveSlots([merged], today);

    expect([...result.hidden]).toEqual([]);
  });

  it('strips genre boilerplate off a title so the duplicate matches', () => {
    const result = resolveSlots(
      [
        work('1', { title: 'The Antventure Begins', popularity: { hardcover: 207 }, seriesMemberships: [{ name: 'Chrysalis', index: '1' }] }),
        work('2', { title: 'The Antventure Begins A LitRPG Adventure', popularity: { hardcover: 6 } }),
      ],
      today,
    );

    expect([...result.rejected]).toEqual([1]);
    expect(result.reasons.get(1)).toBe('series_less_duplicate');
  });

  it("strips series boilerplate read from the author's own vocabulary", () => {
    const result = resolveSlots(
      [
        work('1', { title: 'The Lost Metal', popularity: { hardcover: 3000 }, seriesMemberships: [{ name: 'Mistborn', index: '7' }] }),
        work('2', { title: 'The Lost Metal - A Mistborn Novel', popularity: { hardcover: 2 } }),
      ],
      today,
    );

    expect([...result.rejected]).toEqual([1]);
    expect(result.reasons.get(1)).toBe('series_less_duplicate');
  });

  it('leaves a bare article and form word alone, because that is usually the real title', () => {
    const result = resolveSlots(
      [
        work('1', { title: "It'll Be", popularity: { hardcover: 500 }, seriesMemberships: [{ name: 'Shadowlands', index: '1' }] }),
        work('2', { title: "It'll Be An Adventure", popularity: { hardcover: 40 } }),
      ],
      today,
    );

    expect([...result.rejected]).toEqual([]);
  });

  it('rejects a series-prefixed duplicate once the series name is stripped off the title', () => {
    const result = resolveSlots(
      [
        work('1', { title: 'The Antventure Begins', popularity: { hardcover: 207 }, seriesMemberships: [{ name: 'Chrysalis', index: '1' }] }),
        work('2', { title: 'Upping the Ante', popularity: { hardcover: 119 }, seriesMemberships: [{ name: 'Chrysalis', index: '2' }] }),
        work('3', { title: 'Chrysalis The Antventure Begins A LitRPG Adventure', popularity: { hardcover: 6 } }),
      ],
      today,
    );

    expect([...result.rejected]).toEqual([2]);
    expect(result.reasons.get(2)).toBe('series_prefixed_duplicate');
  });

  it('never strips the series name off a series that names its books after itself', () => {
    const result = resolveSlots(
      [
        work('1', { title: 'The Primal Hunter', popularity: { hardcover: 674 }, seriesMemberships: [{ name: 'The Primal Hunter', index: '1' }] }),
        work('2', { title: 'The Primal Hunter 2', popularity: { hardcover: 413 }, seriesMemberships: [{ name: 'The Primal Hunter', index: '2' }] }),
        work('3', { title: 'The Primal Hunter 3 A LitRPG Adventure', popularity: { hardcover: 5 } }),
      ],
      today,
    );

    expect([...result.rejected]).toEqual([]);
  });

  it('treats an em dash as a subtitle separator, like a colon', () => {
    const result = resolveSlots(
      [
        work('1', { title: 'Enemy A(n)t the Gates', popularity: { hardcover: 94 }, seriesMemberships: [{ name: 'Chrysalis', index: '5' }] }),
        work('2', { title: 'Enemy A(n)t the Gates \u2014 Chrysalis 5', popularity: { hardcover: 5 } }),
      ],
      today,
    );

    expect([...result.rejected]).toEqual([1]);
    expect(result.reasons.get(1)).toBe('series_less_duplicate');
  });

  it('hides a light novel that Hardcover mistagged as a plain book, by its title label', () => {
    const result = resolveSlots(
      [work('1', { title: 'The Primal Hunter (Light Novel), Vol. 2', popularity: { hardcover: 1 } }, { book_category_id: 1 })],
      today,
    );

    expect([...result.hidden]).toEqual([0]);
    expect(result.reasons.get(0)).toBe('format_variant');
  });

  it('keeps a graphic novel that no prose work competes with', () => {
    const result = resolveSlots(
      [
        work(
          '1',
          { title: 'White Sand, Vol. 1', popularity: { hardcover: 887 }, seriesMemberships: [{ name: 'White Sand', index: '1' }] },
          { book_category_id: 4 },
        ),
        work(
          '2',
          { title: 'White Sand, Vol. 2', popularity: { hardcover: 608 }, seriesMemberships: [{ name: 'White Sand', index: '2' }] },
          { book_category_id: 4 },
        ),
      ],
      today,
    );

    expect([...result.rejected]).toEqual([]);
    expect([...result.hidden]).toEqual([]);
  });

  it('keeps the original cause when a graphic novel was already hidden by another rule', () => {
    const contributors = Array.from({ length: 6 }, (_, i) => ({ author: { id: 700 + i, name: `Author ${i}` }, contribution: null }));
    const result = resolveSlots(
      [work('1', { title: 'A Comic Anthology', popularity: { hardcover: 40 } }, { book_category_id: 4, cached_contributors: contributors })],
      today,
    );

    expect([...result.hidden]).toEqual([0]);
    expect(result.reasons.get(0)).toMatch(/^graphic_novel:/);
  });

  it('hides a graphic novel that shares a slot with a surviving prose work, as an adaptation', () => {
    const result = resolveSlots(
      [
        work('1', { title: 'Leviathan Wakes', popularity: { hardcover: 5000 }, seriesMemberships: [{ name: 'The Expanse', index: '1' }] }),
        work(
          '2',
          { title: 'The Expanse #1', popularity: { hardcover: 40 }, seriesMemberships: [{ name: 'The Expanse', index: '1' }] },
          { book_category_id: 4 },
        ),
      ],
      today,
    );

    expect([...result.rejected]).toEqual([]);
    expect([...result.hidden]).toEqual([1]);
    expect(result.reasons.get(1)).toBe('graphic_novel:slot_loser');
  });

  it('leaves position 0 uncontested, because it parks works merely related to a series', () => {
    const result = resolveSlots(
      [
        work('1', { title: 'Unfettered', popularity: { hardcover: 130 }, seriesMemberships: [{ name: 'Annwn Cycle', index: '0' }] }),
        work('2', { title: 'Unfettered II', popularity: { hardcover: 59 }, seriesMemberships: [{ name: 'Annwn Cycle', index: '0' }] }),
        work('3', { title: 'Unfettered III', popularity: { hardcover: 100 }, seriesMemberships: [{ name: 'Annwn Cycle', index: '0' }] }),
      ],
      today,
    );

    expect([...result.rejected]).toEqual([]);
  });

  it('still contests position 1', () => {
    const result = resolveSlots(
      [
        work('1', { title: 'Skyward', popularity: { hardcover: 3000 }, seriesMemberships: [{ name: 'Skyward', index: '1' }] }),
        work('2', { title: 'Cielo', popularity: { hardcover: 4 }, seriesMemberships: [{ name: 'Skyward', index: '1' }] }),
      ],
      today,
    );

    expect([...result.rejected]).toEqual([1]);
    expect(result.reasons.get(1)).toBe('slot_loser');
  });

  it('refuses to absorb into a pre-colon title that several works share, since that is a series name', () => {
    const result = resolveSlots(
      [
        work('1', {
          title: 'Mistborn: The Final Empire',
          popularity: { hardcover: 12113 },
          seriesMemberships: [{ name: 'Mistborn Saga', index: '1' }],
        }),
        work('2', { title: 'Mistborn: Secret History', popularity: { hardcover: 2319 }, seriesMemberships: [{ name: 'Mistborn Saga', index: '4' }] }),
        work('3', { title: 'Mistborn: Collected Tales', popularity: { hardcover: 15 } }),
      ],
      today,
    );

    expect([...result.rejected]).toEqual([]);
  });

  it('still absorbs a marketing subtitle into a pre-colon title only one work claims', () => {
    const result = resolveSlots(
      [
        work('1', { title: 'Elantris', popularity: { hardcover: 4840 }, seriesMemberships: [{ name: 'Elantris', index: '1' }] }),
        work('2', { title: 'Elantris: A Cosmere Standalone', popularity: { hardcover: 1 } }),
      ],
      today,
    );

    expect([...result.rejected]).toEqual([1]);
    expect(result.reasons.get(1)).toBe('series_less_duplicate');
  });

  it('treats a compilation named after its own long series as a collection, so the real book keeps the slot', () => {
    const result = resolveSlots(
      [
        work('1', {
          title: 'Worth the Candle',
          popularity: { hardcover: 65 },
          compilationFlag: true,
          seriesMemberships: [{ name: 'Worth the Candle', index: '1' }],
        }),
        work('2', { title: 'Through Adversity', popularity: { hardcover: 9 }, seriesMemberships: [{ name: 'Worth the Candle', index: '1' }] }),
        work('3', { title: 'Trust and Consequences', popularity: { hardcover: 8 }, seriesMemberships: [{ name: 'Worth the Candle', index: '2' }] }),
        work('4', { title: 'Building Strongholds', popularity: { hardcover: 7 }, seriesMemberships: [{ name: 'Worth the Candle', index: '3' }] }),
      ],
      today,
    );

    expect([...result.rejected]).toEqual([0]);
    expect(result.reasons.get(0)).toBe('collection_slot_loser');
  });

  it('does not read self-naming as a collection when the series is too short to compile', () => {
    const result = resolveSlots(
      [
        work('1', {
          title: 'The Living Dead',
          popularity: { hardcover: 68 },
          compilationFlag: true,
          seriesMemberships: [{ name: 'The Living Dead', index: '1' }],
        }),
        work('2', { title: 'Zombies', popularity: { hardcover: 13 }, seriesMemberships: [{ name: 'The Living Dead', index: '1' }] }),
      ],
      today,
    );

    expect([...result.rejected]).toEqual([1]);
    expect(result.reasons.get(1)).toBe('slot_loser');
  });

  it('keeps a self-named work that Hardcover never flagged as a compilation', () => {
    const result = resolveSlots(
      [
        work('1', { title: 'Skyward', popularity: { hardcover: 3077 }, seriesMemberships: [{ name: 'Skyward', index: '1' }] }),
        work('2', { title: 'Starsight', popularity: { hardcover: 2000 }, seriesMemberships: [{ name: 'Skyward', index: '2' }] }),
        work('3', { title: 'Cytonic', popularity: { hardcover: 1500 }, seriesMemberships: [{ name: 'Skyward', index: '3' }] }),
        work('4', { title: 'Skyward 4-Book Boxed Set', popularity: { hardcover: 10 }, seriesMemberships: [{ name: 'Skyward', index: '1' }] }),
      ],
      today,
    );

    expect([...result.rejected]).toEqual([3]);
    expect(result.reasons.get(3)).toBe('collection_slot_loser');
  });

  it('rejects the weaker of two works claiming the same integer series slot', () => {
    const result = resolveSlots(
      [
        work('1', { title: 'Starsight', popularity: { hardcover: 5000 }, seriesMemberships: [{ name: 'Skyward', index: '2' }] }),
        work('2', { title: 'Estelar', popularity: { hardcover: 40 }, seriesMemberships: [{ name: 'Skyward', index: '2' }] }),
      ],
      today,
    );

    expect([...result.rejected]).toEqual([1]);
    expect(result.reasons.get(1)).toBe('slot_loser');
  });

  it('lets one work win every slot it holds as an independent contest', () => {
    const result = resolveSlots(
      [
        work('1', {
          title: 'Mistborn: The Final Empire',
          popularity: { hardcover: 12000 },
          seriesMemberships: [
            { name: 'Mistborn Saga', index: '1' },
            { name: 'Original Trilogy', index: '1' },
            { name: 'Cosmere', index: '2' },
          ],
        }),
        work('2', { title: 'Nacidos de la Bruma', popularity: { hardcover: 40 }, seriesMemberships: [{ name: 'Mistborn Saga', index: '1' }] }),
        work('3', { title: 'The First Empire', popularity: { hardcover: 30 }, seriesMemberships: [{ name: 'Original Trilogy', index: '1' }] }),
        work('4', { title: 'A Cosmere Fragment', popularity: { hardcover: 20 }, seriesMemberships: [{ name: 'Cosmere', index: '2' }] }),
      ],
      today,
    );

    expect([...result.rejected].sort()).toEqual([1, 2, 3]);
  });

  it('does not contest a fractional series slot', () => {
    // Fractional slots are where librarians park novellas and anthology pieces, so two rows at #1.5
    // are routinely two different contributions rather than duplicates of each other.
    const result = resolveSlots(
      [
        work('1', { title: 'Bound by Snow', popularity: { hardcover: 900 }, seriesMemberships: [{ name: 'Mountain Masters', index: '1.5' }] }),
        work('2', { title: 'Winter Vows', popularity: { hardcover: 4 }, seriesMemberships: [{ name: 'Mountain Masters', index: '1.5' }] }),
      ],
      today,
    );

    expect(result.rejected.size).toBe(0);
  });

  it('ranks a real series membership above a slot claim parsed from a title', () => {
    const result = resolveSlots(
      [
        work('1', { title: 'The Final Empire', popularity: { hardcover: 5 }, seriesMemberships: [{ name: 'Mistborn', index: '1' }] }),
        work('2', { title: 'Mistborn 1 - The Final Empire', popularity: { hardcover: 9000 } }),
      ],
      today,
    );

    expect([...result.rejected]).toEqual([1]);
  });

  it('resolves a bare series-name prefix claim to the series with the strongest holder at that position', () => {
    // Two real series share the canonical name "mistborn". The literal name match holds nothing at
    // position 1, so a claim resolved by name alone would sail through uncontested.
    const result = resolveSlots(
      [
        work(
          '1',
          { title: 'The Well of Ascension', popularity: { hardcover: 8000 }, seriesMemberships: [{ name: 'Mistborn', index: '2' }] },
          seriesRaw({ id: 10, name: 'Mistborn', position: 2 }),
        ),
        work(
          '2',
          { title: 'The Final Empire', popularity: { hardcover: 12000 }, seriesMemberships: [{ name: 'The Mistborn Saga', index: '1' }] },
          seriesRaw({ id: 20, name: 'The Mistborn Saga', position: 1 }),
        ),
        work('3', { title: 'Mistborn 1 - The Final Empire', popularity: { hardcover: 30 } }),
      ],
      today,
    );

    expect([...result.rejected]).toEqual([2]);
    expect(result.reasons.get(2)).toBe('slot_loser');
  });

  it('does not offer a colon-qualified sub-series as a candidate for a bare series-name guess', () => {
    const result = resolveSlots(
      [
        work(
          '1',
          { title: 'The Eleventh Metal', popularity: { hardcover: 9000 }, seriesMemberships: [{ name: 'Mistborn: Ghostbloods', index: '1' }] },
          seriesRaw({ id: 30, name: 'Mistborn: Ghostbloods', position: 1 }),
        ),
        work('2', { title: 'Mistborn 1 - The Final Empire', popularity: { hardcover: 30 } }),
      ],
      today,
    );

    expect(result.rejected.size).toBe(0);
  });

  it('keys a slot on the Hardcover series id so two spellings of one series contest it together', () => {
    const result = resolveSlots(
      [
        work(
          '1',
          { title: 'The Alloy of Law', popularity: { hardcover: 5000 }, seriesMemberships: [{ name: 'Mistborn', index: '4' }] },
          seriesRaw({ id: 10, name: 'Mistborn', position: 4 }),
        ),
        work(
          '2',
          { title: 'Aleacion de ley', popularity: { hardcover: 30 }, seriesMemberships: [{ name: 'The Mistborn Saga', index: '4' }] },
          seriesRaw({ id: 10, name: 'The Mistborn Saga', position: 4 }),
        ),
      ],
      today,
    );

    expect([...result.rejected]).toEqual([1]);
  });

  it('rejects a series-less row whose pre-colon title equals that of a series slot holder', () => {
    const result = resolveSlots(
      [
        work('1', { title: 'The Blacktongue Thief', popularity: { hardcover: 1797 }, seriesMemberships: [{ name: 'Blacktongue', index: '1' }] }),
        work('2', { title: 'The Blacktongue Thief: Sneak Peek', popularity: { hardcover: 5 } }),
      ],
      today,
    );

    expect([...result.rejected]).toEqual([1]);
    expect(result.reasons.get(1)).toBe('series_less_duplicate');
  });

  it('does not reject a series-less row whose title merely contains a slot holder title', () => {
    // Containment absorbs "Trouble on Paradise" into "Paradise", which are different books.
    const result = resolveSlots(
      [
        work('1', { title: 'Paradise', popularity: { hardcover: 1000 }, seriesMemberships: [{ name: 'Paradise Cycle', index: '1' }] }),
        work('2', { title: 'Trouble on Paradise', popularity: { hardcover: 284 } }),
      ],
      today,
    );

    expect(result.rejected.size).toBe(0);
  });

  it('accepts a collection that is the sole holder of an integer slot', () => {
    const result = resolveSlots(
      [
        work(
          '1',
          {
            title: 'Arcanum Unbounded: The Cosmere Collection',
            popularity: { hardcover: 1840 },
            compilationFlag: true,
            seriesMemberships: [{ name: 'Cosmere', index: '18' }],
          },
          { book_category_id: 8, ...seriesRaw({ id: 50, name: 'Cosmere', position: 18 }) },
        ),
      ],
      today,
    );

    expect(result.rejected.size).toBe(0);
    expect(result.hidden.size).toBe(0);
  });

  it('rejects a collection that loses a slot to a non-collection work whatever its readership', () => {
    const result = resolveSlots(
      [
        work(
          '1',
          { title: 'White Sand Volume 1', popularity: { hardcover: 100 }, seriesMemberships: [{ name: 'White Sand', index: '1' }] },
          { book_category_id: 1 },
        ),
        work(
          '2',
          { title: 'White Sand Omnibus', popularity: { hardcover: 5000 }, seriesMemberships: [{ name: 'White Sand', index: '1' }] },
          { book_category_id: 8 },
        ),
      ],
      today,
    );

    expect([...result.rejected]).toEqual([1]);
    expect(result.reasons.get(1)).toBe('collection_slot_loser');
  });

  it('hides a collection with no slot and a repackaging title', () => {
    const result = resolveSlots([work('1', { title: 'The First Law Trilogy', popularity: { hardcover: 168 }, compilationFlag: true })], today);

    expect(result.rejected.size).toBe(0);
    expect(result.reasons.get(0)).toBe('collection_repackaging');
  });

  it('hides a collection with no slot and thin readership', () => {
    const result = resolveSlots([work('1', { title: 'An Assorted Anthology', popularity: { hardcover: 10 }, compilationFlag: true })], today);

    expect(result.rejected.size).toBe(0);
    expect(result.reasons.get(0)).toBe('collection_weak');
  });

  it('hides a graphic novel instead of rejecting it when it loses a slot', () => {
    // White Sand and Dark One were published as graphic novels and have no prose edition at all.
    const result = resolveSlots(
      [
        work('1', { title: 'Dark One Prose', popularity: { hardcover: 5000 }, seriesMemberships: [{ name: 'Dark One', index: '1' }] }),
        work(
          '2',
          { title: 'Dark One Vol. 1', popularity: { hardcover: 191 }, seriesMemberships: [{ name: 'Dark One', index: '1' }] },
          { book_category_id: 4 },
        ),
      ],
      today,
    );

    expect(result.rejected.size).toBe(0);
    expect([...result.hidden]).toEqual([1]);
    expect(result.reasons.get(1)).toBe('graphic_novel:slot_loser');
  });

  it('hides a light novel and propagates the format tag to an unlabelled series sibling', () => {
    const result = resolveSlots(
      [
        work(
          '1',
          { title: 'Mark of the Fool', popularity: { hardcover: 210 }, seriesMemberships: [{ name: 'Mark of the Fool', index: '1' }] },
          { book_category_id: 10, ...seriesRaw({ id: 80, name: 'Mark of the Fool', position: 1 }) },
        ),
        work('2', { title: 'Mark of the Fool 4 - The Ending', popularity: { hardcover: 150 } }, { book_category_id: 1 }),
      ],
      today,
    );

    expect(result.rejected.size).toBe(0);
    expect([...result.hidden].sort()).toEqual([0, 1]);
    expect(result.reasons.get(1)).toBe('format_variant');
  });

  it('lets a dated future work with no readership, cover or description through every gate', () => {
    const result = resolveSlots(
      [
        work('1', {
          title: 'The Path of Ascension 13',
          popularity: { hardcover: 0 },
          unreleased: true,
          ebookReleaseDate: '2027-03-01',
          releaseYear: 2027,
          compilationFlag: true,
        }),
      ],
      today,
    );

    expect(result.rejected.size).toBe(0);
    expect(result.hidden.size).toBe(0);
  });

  it('rejects a row whose Hardcover status is not live', () => {
    const result = resolveSlots([work('1', { title: 'A Deduped Row' }, { book_status: { id: 4, name: 'Deduped' } })], today);

    expect([...result.rejected]).toEqual([0]);
    expect(result.reasons.get(0)).toBe('status');
  });

  it('rejects a contribution whose role id is not author', () => {
    const result = resolveSlots([work('1', { title: 'A Foreword By Someone Else' }, { contributor_role_id: 3 })], today);

    expect([...result.rejected]).toEqual([0]);
    expect(result.reasons.get(0)).toBe('contributor_role');
  });

  it('does not reject a row whose status and role are absent from an older fixture', () => {
    const result = resolveSlots([work('1', { title: 'An Old Fixture Row' }, { book_status: undefined, contributor_role_id: undefined })], today);

    expect(result.rejected.size).toBe(0);
    expect(result.hidden.size).toBe(0);
  });

  it('rejects a localised bundle title that carries no English repackaging word', () => {
    const result = resolveSlots([work('1', { title: 'Trilogia Nacidos de la Bruma', popularity: { hardcover: 300 } })], today);

    expect([...result.rejected]).toEqual([0]);
    expect(result.reasons.get(0)).toBe('foreign_bundle');
  });

  it('rejects a split volume when its parent survives with more than twice the readership', () => {
    const works = [
      work('1', { title: 'The Way of Kings', popularity: { hardcover: 9677 } }),
      work('2', { title: 'The Way of Kings, Part 1', popularity: { hardcover: 468 } }),
    ];
    const { rejected, reasons } = resolveSlots(works, today);
    expect([...rejected]).toEqual([1]);
    expect(reasons.get(1)).toBe('split_edition');
  });

  it('keeps a split-shaped title when no parent work outreads it, so two comparably read books never collapse', () => {
    const works = [
      work('1', { title: 'Some Anthology', popularity: { hardcover: 40 } }),
      work('2', { title: 'Some Anthology, Part 1', popularity: { hardcover: 30 } }),
    ];
    const { rejected } = resolveSlots(works, today);
    expect(rejected.size).toBe(0);
  });

  // assignVerdict already flags a translation as `foreign_language`, which hides it while leaving the
  // owner able to promote it. Rejecting it here as well would take that choice away silently.
  it('does not reject a translation on language alone', () => {
    const works = [work('1', { title: 'El Imperio Final', allForeign: true, popularity: { hardcover: 12 } })];
    const { rejected, hidden } = resolveSlots(works, today);
    expect(rejected.size).toBe(0);
    expect(hidden.size).toBe(0);
  });

  it('decides a slot the same way whatever order the works arrive in', () => {
    const slot = [{ name: 'Contested', index: '1' }];
    const build = (): MergedWork[] => [
      work('1', { title: 'Alpha', popularity: { hardcover: 5 }, seriesMemberships: slot }),
      work('2', { title: 'Bravo', popularity: { hardcover: 5 }, seriesMemberships: slot }),
      work('3', { title: 'Charlie', popularity: { hardcover: 5 }, seriesMemberships: slot }),
    ];
    const survivors = (works: MergedWork[]): string[] => {
      const { rejected } = resolveSlots(works, today);
      return works.filter((_, index) => !rejected.has(index)).map((entry) => entry.title);
    };
    // Every claimant is equally read, so only the final tiebreak decides; it must not be array order.
    expect(survivors(build())).toEqual(['Alpha']);
    expect(survivors(build().reverse())).toEqual(['Alpha']);
  });

  it('keeps the series vocabulary of a row that is itself filtered out', () => {
    // Bundle-filtering the only member of a series erases that series name, and the title parser then
    // stops matching it, so the vocabulary is built from all status-OK rows before any filtering.
    const result = resolveSlots(
      [
        work(
          '1',
          { title: 'Mage Errant Sammlung 1-3', popularity: { hardcover: 20 }, seriesMemberships: [{ name: 'Mage Errant', index: '1' }] },
          seriesRaw({ id: 90, name: 'Mage Errant', position: 1 }),
        ),
        work('2', { title: 'Into the Labyrinth: Mage Errant Book 1', popularity: { hardcover: 500 } }),
        work('3', { title: 'The Lesser Path: Mage Errant Book 1', popularity: { hardcover: 5 } }),
      ],
      today,
    );

    expect([...result.rejected].sort()).toEqual([0, 2]);
    expect(result.reasons.get(0)).toBe('foreign_bundle');
    expect(result.reasons.get(2)).toBe('slot_loser');
  });
});
