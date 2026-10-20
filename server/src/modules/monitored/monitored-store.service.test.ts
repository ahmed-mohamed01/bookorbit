import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';

import { MONITORED_STATUS_FILTER_BY_FORMAT_STATUS, monitoredFormatStatus } from '@bookorbit/types';
import type { MonitoredWork } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { MonitoredStoreService, releaseEventKey, releaseRangeOverlapsSql, type MonitoredDueRelease } from './monitored-store.service';
import { visibleWorkCondition } from './monitored-work-conditions';
import * as schema from './schema/monitored.schema';
import { authorCatalogWorks, type AuthorCatalogWorkRow, type MonitoredAuthorWorkRow } from './schema/monitored.schema';

function probe(status: 'dated' | 'unlisted' | 'expected', releaseDate: string | null) {
  return { status, releaseDate, precision: releaseDate ? ('day' as const) : null };
}

type OverlayRow = typeof schema.monitoredAuthorWorks.$inferSelect;

function rendered(statement: SQL): string {
  return new PgDialect().sqlToQuery(statement).sql;
}

function overlayRow(patch: Partial<OverlayRow> & { workId: string }): OverlayRow {
  return {
    monitorAuthorId: 'monitor-1',
    monitorState: 'monitoring',
    monitorEbook: null,
    monitorAudiobook: null,
    userVisibility: null,
    userKind: null,
    ebookRequestId: null,
    audiobookRequestId: null,
    ...patch,
  } as OverlayRow;
}

/** A db whose selects answer from a queue, in the order the code under test issues them. */
function queuedSelectDb(results: unknown[][]) {
  const queue = [...results];
  const select = vi.fn(() => {
    const rows = queue.shift() ?? [];
    const builder: Record<string, unknown> = {};
    builder.from = vi.fn(() => builder);
    builder.where = vi.fn(() => Promise.resolve(rows));
    builder.limit = vi.fn(() => Promise.resolve(rows));
    return builder;
  });
  return { select };
}

async function composeWorks(store: MonitoredStoreService, rows: AuthorCatalogWorkRow[], viewer?: RequestUser) {
  return (await Reflect.apply(
    (store as unknown as { composeWorks: (...args: unknown[]) => Promise<Array<{ monitorAuthorId: string; work: Record<string, unknown> }>> })
      .composeWorks,
    store,
    [rows, viewer],
  )) as Array<{ monitorAuthorId: string; work: Record<string, unknown> }>;
}

function workRow(patch: Partial<AuthorCatalogWorkRow> = {}): AuthorCatalogWorkRow {
  return {
    id: 'monitor-1:hardcover:1',
    monitorAuthorId: 'monitor-1',
    title: 'Test Work',
    subtitle: null,
    seriesName: null,
    seriesIndex: null,
    seriesMemberships: [],
    releaseYear: 2026,
    ebookReleaseDate: '2026-10-01',
    ebookDatePrecision: 'day',
    audioReleaseDate: '2026-11-01',
    audioDatePrecision: 'day',
    coverUrl: null,
    description: null,
    kind: null,
    verdict: 'verified',
    flags: [],
    sources: ['hardcover'],
    matchedBookId: 10,
    matchedEbookBookId: 10,
    matchedAudioBookId: 20,
    ownedFormats: ['ebook', 'audiobook'],
    possibleEbookBookId: null,
    possibleAudioBookId: null,
    linkedFormats: [],
    answeredFormats: [],
    ...patch,
  };
}

type ReleaseRow = typeof schema.authorCatalogWorkReleases.$inferSelect;

function releaseRow(patch: Partial<ReleaseRow> = {}) {
  return {
    workId: 'monitor-1:hardcover:1',
    monitorAuthorId: 'monitor-1',
    ownerUserId: 1,
    format: 'ebook' as const,
    status: 'dated' as const,
    releaseDate: '2026-10-01',
    datePrecision: 'day' as const,
    lastReleaseDate: '2026-10-01',
    lastDatePrecision: 'day' as const,
    lastDateSource: 'apple' as const,
    previousReleaseDate: '2026-10-06',
    previousDatePrecision: 'day' as const,
    dateChangedAt: new Date('2026-09-20T01:02:03.000Z'),
    autoReleaseDate: null as ReleaseRow['autoReleaseDate'],
    autoDatePrecision: null as ReleaseRow['autoDatePrecision'],
    autoSource: null as ReleaseRow['autoSource'],
    autoChangedAt: null as ReleaseRow['autoChangedAt'],
    source: 'apple' as const,
    asin: null,
    checkedAt: new Date('2026-09-18T01:02:03.000Z'),
    nextCheckAt: new Date('2026-09-25T00:00:00.000Z'),
    attempts: 0,
    lastErrorClass: null,
    ...patch,
  };
}

describe('MonitoredStoreService ratings', () => {
  const store = new MonitoredStoreService({} as never, {} as never);
  const sourceRow = (source: string, ratingAverage: number | null, ratingCount: number | null) => ({
    workId: 'work-1',
    source,
    providerWorkId: `${source}-id`,
    ratingAverage,
    ratingCount,
  });
  const compose = (sources: unknown[]) =>
    Reflect.apply((store as unknown as { composeWork: (...args: unknown[]) => unknown }).composeWork, store, [
      workRow(),
      sources,
      undefined,
      null,
      true,
    ]) as { ratings?: unknown };

  it('maps rated source rows onto the work and skips unrated ones', () => {
    const work = compose([sourceRow('goodreads', 4.5, 1200), sourceRow('audible', 4.1, null), sourceRow('hardcover', null, null)]);

    expect(work.ratings).toEqual([
      { source: 'goodreads', average: 4.5, count: 1200 },
      { source: 'audible', average: 4.1, count: null },
    ]);
  });

  it('leaves ratings off a work with no rated source', () => {
    expect(compose([sourceRow('hardcover', null, null)])).not.toHaveProperty('ratings');
  });

  it('writes each source rating beside its provider id', () => {
    const values = Reflect.apply((store as unknown as { sourceValues: (...args: unknown[]) => unknown }).sourceValues, store, [
      {
        id: 'work-1',
        providerWorkIds: { goodreads: 'g1', hardcover: 'h1' },
        ratings: [{ source: 'goodreads', average: 4.2, count: 90 }],
      },
    ]);

    expect(values).toEqual([
      { workId: 'work-1', source: 'goodreads', providerWorkId: 'g1', ratingAverage: 4.2, ratingCount: 90 },
      { workId: 'work-1', source: 'hardcover', providerWorkId: 'h1', ratingAverage: null, ratingCount: null },
    ]);
  });
});

describe('MonitoredStoreService work composition', () => {
  const store = new MonitoredStoreService({} as never, {} as never);
  const composed = (releases: Array<ReturnType<typeof releaseRow>>) =>
    Reflect.apply((store as unknown as { composeWork: (...args: unknown[]) => unknown }).composeWork, store, [
      workRow(),
      [],
      undefined,
      null,
      true,
      new Map(),
      releases,
    ]) as Record<string, unknown>;

  describe('possible matches and links', () => {
    const possibleBook = { bookId: 31, title: 'Inhibitor Phase', seriesName: 'Revelation Space', seriesIndex: '5' };
    const unmatched = (patch: Partial<AuthorCatalogWorkRow> = {}) =>
      workRow({ matchedBookId: null, matchedEbookBookId: null, matchedAudioBookId: null, ownedFormats: [], possibleEbookBookId: 31, ...patch });
    const compose = (row: AuthorCatalogWorkRow, isOwner = true, accessible: Set<number> | null = null) =>
      Reflect.apply((store as unknown as { composeWork: (...args: unknown[]) => unknown }).composeWork, store, [
        row,
        [],
        undefined,
        accessible,
        isOwner,
        new Map(),
        [],
        new Map([[31, possibleBook]]),
      ]) as Record<string, unknown>;

    it('shows the owner the library book behind a possible match', () => {
      expect(compose(unmatched()).possibleMatches).toEqual({ ebook: possibleBook });
    });

    it('drops the question once the format is in the library', () => {
      expect(compose(unmatched({ matchedBookId: 10, matchedEbookBookId: 10, ownedFormats: ['ebook'] }))).not.toHaveProperty('possibleMatches');
    });

    it('withholds possible matches and links from anyone but the owner, and books the viewer cannot open', () => {
      expect(compose(unmatched({ linkedFormats: ['audiobook'] }), false)).not.toHaveProperty('possibleMatches');
      expect(compose(unmatched({ linkedFormats: ['audiobook'] }), false)).not.toHaveProperty('linkedFormats');
      expect(compose(unmatched(), true, new Set())).not.toHaveProperty('possibleMatches');
    });

    it('lets an answered format keep its stored match over the book a request filed', () => {
      const overlay = { workId: 'monitor-1:hardcover:1', ebookRequestId: 7 } as MonitoredAuthorWorkRow;
      const requests = new Map([[7, { id: 7, status: 'available', matchedBookId: 99 }]]);
      const composeWith = (row: AuthorCatalogWorkRow) =>
        Reflect.apply((store as unknown as { composeWork: (...args: unknown[]) => unknown }).composeWork, store, [
          row,
          [],
          overlay,
          null,
          true,
          requests,
          [],
          new Map(),
        ]) as { matchedBookIds: Record<string, number>; ownedFormats: string[] };
      const base: Partial<AuthorCatalogWorkRow> = { matchedBookId: null, matchedEbookBookId: null, matchedAudioBookId: null, ownedFormats: [] };

      expect(composeWith(workRow({ ...base })).matchedBookIds).toEqual({ ebook: 99 });
      const answered = composeWith(workRow({ ...base, answeredFormats: ['ebook'] }));
      expect(answered.matchedBookIds).toEqual({});
      expect(answered.ownedFormats).toEqual([]);
    });

    it('tells the owner which formats they linked by hand', () => {
      expect(compose(workRow({ linkedFormats: ['ebook'] })).linkedFormats).toEqual(['ebook']);
      expect(compose(workRow())).not.toHaveProperty('linkedFormats');
    });
  });

  it('supplies default user state when no overlay exists', () => {
    const result = Reflect.apply((store as unknown as { composeWork: (...args: unknown[]) => unknown }).composeWork, store, [
      workRow(),
      [{ workId: 'monitor-1:hardcover:1', source: 'hardcover', providerWorkId: '1' }],
      undefined,
      null,
    ]);

    expect(result).toMatchObject({
      monitorState: 'monitoring',
      monitorFormats: {},
      requestIds: {},
      providerWorkIds: { hardcover: '1' },
    });
    expect(result).not.toHaveProperty('formatReleases');
  });

  it('attaches release probe rows by format', () => {
    const result = Reflect.apply((store as unknown as { composeWork: (...args: unknown[]) => unknown }).composeWork, store, [
      workRow(),
      [],
      undefined,
      null,
      true,
      new Map(),
      [releaseRow()],
    ]) as Record<string, unknown>;

    expect(result.formatReleases).toEqual({
      ebook: {
        status: 'dated',
        releaseDate: '2026-10-01',
        precision: 'day',
        source: 'apple',
        checkedAt: '2026-09-18T01:02:03.000Z',
        dateChangedAt: '2026-09-20T01:02:03.000Z',
        previousReleaseDate: '2026-10-06',
        previousPrecision: 'day',
        suggested: null,
      },
    });
  });

  it('hides release date history while the current date is null', () => {
    const result = Reflect.apply((store as unknown as { composeWork: (...args: unknown[]) => unknown }).composeWork, store, [
      workRow(),
      [],
      undefined,
      null,
      true,
      new Map(),
      [releaseRow({ releaseDate: null, datePrecision: null, status: 'unlisted' })],
    ]) as Record<string, unknown>;

    expect(result.formatReleases).toMatchObject({
      ebook: { dateChangedAt: null, previousReleaseDate: null, previousPrecision: null },
    });
  });

  it('hides release date history for an owner-authored date', () => {
    const result = Reflect.apply((store as unknown as { composeWork: (...args: unknown[]) => unknown }).composeWork, store, [
      workRow(),
      [],
      undefined,
      null,
      true,
      new Map(),
      [releaseRow({ source: 'user' })],
    ]) as Record<string, unknown>;

    expect(result.formatReleases).toMatchObject({
      ebook: { dateChangedAt: null, previousReleaseDate: null, previousPrecision: null },
    });
  });

  it('shows the first-seen timestamp without a previous date', () => {
    const result = Reflect.apply((store as unknown as { composeWork: (...args: unknown[]) => unknown }).composeWork, store, [
      workRow(),
      [],
      undefined,
      null,
      true,
      new Map(),
      [releaseRow({ previousReleaseDate: null, previousDatePrecision: null })],
    ]) as Record<string, unknown>;

    expect(result.formatReleases).toMatchObject({
      ebook: {
        dateChangedAt: '2026-09-20T01:02:03.000Z',
        previousReleaseDate: null,
        previousPrecision: null,
      },
    });
  });

  it('surfaces an automatic date that disagrees with the one the owner chose', () => {
    const result = composed([
      releaseRow({
        source: 'user',
        releaseDate: '2026-10-01',
        autoReleaseDate: '2026-11-12',
        autoDatePrecision: 'day',
        autoSource: 'amazon',
        autoChangedAt: new Date('2026-09-21T04:05:06.000Z'),
      }),
    ]);

    expect(result.formatReleases).toMatchObject({
      ebook: { suggested: { releaseDate: '2026-11-12', precision: 'day', source: 'amazon', changedAt: '2026-09-21T04:05:06.000Z' } },
    });
  });

  it('withholds every suggestion the owner has no open question about', () => {
    const acknowledged = releaseRow({
      source: 'user',
      releaseDate: '2026-10-01',
      autoReleaseDate: '2026-11-12',
      autoDatePrecision: 'day',
      autoSource: 'amazon',
      autoChangedAt: null,
    });
    const agreeing = releaseRow({ ...acknowledged, autoReleaseDate: '2026-10-01', autoChangedAt: new Date('2026-09-21T04:05:06.000Z') });
    const unseen = releaseRow({ ...agreeing, autoReleaseDate: null, autoDatePrecision: null, autoSource: null });
    const probeOwned = releaseRow({ ...agreeing, source: 'apple', autoReleaseDate: '2026-11-12' });

    for (const row of [acknowledged, agreeing, unseen, probeOwned]) {
      expect(composed([row]).formatReleases).toMatchObject({ ebook: { suggested: null } });
    }
  });

  it('masks inaccessible per-format matches and owned formats', () => {
    const result = Reflect.apply((store as unknown as { composeWork: (...args: unknown[]) => unknown }).composeWork, store, [
      workRow(),
      [],
      undefined,
      new Set([10]),
    ]);

    expect(result).toMatchObject({
      matchedBookId: 10,
      matchedBookIds: { ebook: 10 },
      ownedFormats: ['ebook'],
    });
  });

  it('withholds a filed request match the viewer cannot reach in any of their libraries', () => {
    const result = Reflect.apply((store as unknown as { composeWork: (...args: unknown[]) => unknown }).composeWork, store, [
      workRow({ matchedBookId: null, matchedEbookBookId: null, matchedAudioBookId: null, ownedFormats: [] }),
      [],
      overlayRow({ workId: 'monitor-1:hardcover:1', ebookRequestId: 17 }),
      new Set([10]),
      true,
      new Map([[17, { id: 17, status: 'available', matchedBookId: 30 }]]),
    ]);

    expect(result).toMatchObject({
      matchedBookId: null,
      matchedBookIds: {},
      ownedFormats: [],
      requestStatuses: { ebook: 'available' },
    });
  });

  it('keeps the ebook as the primary match when only the audiobook request has filed', () => {
    const result = Reflect.apply((store as unknown as { composeWork: (...args: unknown[]) => unknown }).composeWork, store, [
      workRow({ matchedBookId: 10, matchedEbookBookId: 10, matchedAudioBookId: null, ownedFormats: ['ebook'] }),
      [],
      overlayRow({ workId: 'monitor-1:hardcover:1', audiobookRequestId: 22 }),
      null,
      true,
      new Map([[22, { id: 22, status: 'available', matchedBookId: 30 }]]),
    ]);

    expect(result).toMatchObject({
      matchedBookId: 10,
      matchedBookIds: { ebook: 10, audiobook: 30 },
      ownedFormats: ['ebook', 'audiobook'],
    });
  });

  it('builds precision-aware SQL overlap conditions for summary release counts', () => {
    const query = new PgDialect().sqlToQuery(
      releaseRangeOverlapsSql(authorCatalogWorks.ebookReleaseDate, authorCatalogWorks.ebookDatePrecision, '2026-06-07', '2027-09-05'),
    );
    // A stored NULL precision is inferred from the value's shape, exactly as release-window.ts does,
    // so a null-precision '2026' row spans the whole year in SQL instead of collapsing to 2026-01-01.
    const effective = `case when "author_catalog_works"."ebook_date_precision" is not null then "author_catalog_works"."ebook_date_precision" when length("author_catalog_works"."ebook_release_date") = 4 then 'year' when length("author_catalog_works"."ebook_release_date") = 7 then 'month' else 'day' end`;

    expect(query.sql).toContain(
      `case ${effective} when 'year' then "author_catalog_works"."ebook_release_date" || '-01-01' when 'month' then "author_catalog_works"."ebook_release_date" || '-01' else "author_catalog_works"."ebook_release_date" end <= $1`,
    );
    expect(query.sql).toContain(
      `case ${effective} when 'year' then "author_catalog_works"."ebook_release_date" || '-12-31' when 'month' then "author_catalog_works"."ebook_release_date" || '-31' else "author_catalog_works"."ebook_release_date" end >= $2`,
    );
    expect(query.params).toEqual(['2027-09-05', '2026-06-07']);
  });

  it('maps only requested monitored author fields for targeted updates', () => {
    const values = Reflect.apply((store as unknown as { authorFieldUpdateValues: (...args: unknown[]) => unknown }).authorFieldUpdateValues, store, [
      { paused: true, lastRefreshedAt: '2026-09-02T00:00:00.000Z' },
    ]);

    expect(values).toEqual({ paused: true, lastRefreshedAt: new Date('2026-09-02T00:00:00.000Z') });
  });

  it('counts only monitored books with an owned author and matching catalog work', () => {
    const queryStore = new MonitoredStoreService(drizzle.mock({ schema }) as never, {} as never);
    const query = Reflect.apply(
      (queryStore as unknown as { bookSummaryQuery: (...args: unknown[]) => { toSQL: () => { sql: string } } }).bookSummaryQuery,
      queryStore,
      [{ id: 1, isSuperuser: false }],
    );

    expect(query.toSQL().sql).toContain(
      'inner join "monitored_authors" on "monitored_authors"."id" = "monitored_books"."monitor_author_id" inner join "author_catalog_works" on ("author_catalog_works"."id" = "monitored_books"."work_id" and "author_catalog_works"."monitor_author_id" = "monitored_books"."monitor_author_id")',
    );
    expect(query.toSQL().sql).toContain('where ("monitored_books"."owner_user_id" = $1 and "monitored_authors"."owner_user_id" = $2)');
  });
});

describe('MonitoredStoreService viewer-aware composition', () => {
  const shown = workRow({ id: 'w-shown', matchedBookId: null, matchedEbookBookId: null, matchedAudioBookId: null, ownedFormats: [] });
  const hidden = workRow({ id: 'w-hidden', matchedBookId: null, matchedEbookBookId: null, matchedAudioBookId: null, ownedFormats: [] });
  const overlays = [overlayRow({ workId: 'w-shown', ebookRequestId: 17 }), overlayRow({ workId: 'w-hidden', userVisibility: 'hidden' })];
  const requests = [{ id: 17, status: 'downloading', matchedBookId: null }];
  const libraries = { findAccessibleLibraryIds: vi.fn().mockResolvedValue([]) };

  it('withholds the owner overlay and the owner-hidden work from a non-owner', async () => {
    const db = queuedSelectDb([[], overlays, [], requests, []]);
    const store = new MonitoredStoreService(db as never, libraries as never);

    const composed = await composeWorks(store, [shown, hidden], { id: 2, isSuperuser: false } as RequestUser);

    expect(composed.map((item) => item.work.id)).toEqual(['w-shown']);
    expect(composed[0].work.requestIds).toEqual({});
    expect(composed[0].work.requestStatuses).toEqual({});
    expect(composed[0].work).not.toHaveProperty('userVisibility');
  });

  it('keeps the whole overlay for the monitor owner', async () => {
    const db = queuedSelectDb([[], overlays, [], requests, [{ id: 'monitor-1' }]]);
    const store = new MonitoredStoreService(db as never, libraries as never);

    const composed = await composeWorks(store, [shown, hidden], { id: 1, isSuperuser: false } as RequestUser);

    expect(composed.map((item) => item.work.id)).toEqual(['w-shown', 'w-hidden']);
    expect(composed[0].work.requestIds).toEqual({ ebook: 17 });
    expect(composed[0].work.requestStatuses).toEqual({ ebook: 'downloading' });
    expect(composed[1].work.userVisibility).toBe('hidden');
  });

  it.each([
    ['book', undefined],
    ['collection', 'collection'],
    ['split_part', 'split_part'],
  ] as const)('uses the owner %s mark as the effective kind', async (userKind, effectiveKind) => {
    const marked = workRow({ id: 'w-marked', kind: 'duplicate' });
    const db = queuedSelectDb([[], [overlayRow({ workId: 'w-marked', userKind })], [], [{ id: 'monitor-1' }]]);
    const store = new MonitoredStoreService(db as never, libraries as never);

    const [composed] = await composeWorks(store, [marked], { id: 1, isSuperuser: false } as RequestUser);

    expect(composed.work.userKind).toBe(userKind);
    expect(composed.work.kind).toBe(effectiveKind);
  });

  it('withholds the owner mark and keeps the catalog kind for a non-owner', async () => {
    const marked = workRow({ id: 'w-marked', kind: 'duplicate' });
    const db = queuedSelectDb([[], [overlayRow({ workId: 'w-marked', userKind: 'collection' })], [], []]);
    const store = new MonitoredStoreService(db as never, libraries as never);

    const [composed] = await composeWorks(store, [marked], { id: 2, isSuperuser: false } as RequestUser);

    expect(composed.work).not.toHaveProperty('userKind');
    expect(composed.work.kind).toBe('duplicate');
  });

  it('keeps the whole overlay for an internal caller that passes no viewer', async () => {
    const db = queuedSelectDb([[], overlays, [], requests]);
    const store = new MonitoredStoreService(db as never, libraries as never);

    const composed = await composeWorks(store, [shown, hidden]);

    expect(composed.map((item) => item.work.id)).toEqual(['w-shown', 'w-hidden']);
    expect(composed[0].work.requestIds).toEqual({ ebook: 17 });
    expect(composed[0].work.requestStatuses).toEqual({ ebook: 'downloading' });
  });

  it('projects an available request match into the library-owned work state', async () => {
    const db = queuedSelectDb([[], overlays, [], [{ id: 17, status: 'available', matchedBookId: 30 }]]);
    const store = new MonitoredStoreService(db as never, libraries as never);

    const composed = await composeWorks(store, [shown, hidden]);

    expect(composed[0].work).toMatchObject({
      matchedBookId: 30,
      matchedBookIds: { ebook: 30 },
      ownedFormats: ['ebook'],
      requestStatuses: { ebook: 'available' },
    });
  });
});

describe('MonitoredStoreService catalog overlay', () => {
  function catalogDb() {
    const operations: string[] = [];
    const tx = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })) })),
      delete: vi.fn(() => ({
        where: vi.fn().mockImplementation(() => {
          operations.push('delete');
          return Promise.resolve({ rowCount: 0 });
        }),
      })),
      insert: vi.fn(() => {
        const builder: Record<string, ReturnType<typeof vi.fn>> = {};
        builder.values = vi.fn(() => {
          operations.push('insert');
          return builder;
        });
        builder.onConflictDoUpdate = vi.fn().mockResolvedValue({ rowCount: 1 });
        return builder;
      }),
      execute: vi.fn().mockImplementation(() => {
        operations.push('overlay');
        return Promise.resolve({ rowCount: 0 });
      }),
    };
    return { db: { transaction: vi.fn((callback: (value: typeof tx) => unknown) => callback(tx)) }, tx, operations };
  }

  it('reapplies the release overlay after the source-work rewrite', async () => {
    const tracked = catalogDb();
    const store = new MonitoredStoreService(tracked.db as never, {} as never);
    const row = workRow({ matchedBookId: null, matchedEbookBookId: null, matchedAudioBookId: null, ownedFormats: [] });

    await store.saveCatalog('monitor-1', {
      fetchedAt: '2026-09-18T00:00:00.000Z',
      works: [
        {
          ...row,
          kind: row.kind ?? undefined,
          providerWorkIds: { hardcover: 'the-work' },
          monitorState: 'monitoring',
          matchedBookIds: {},
          monitorFormats: {},
          requestIds: {},
        },
      ],
    });

    expect(tracked.tx.execute).toHaveBeenCalledTimes(13);
    expect(tracked.operations.slice(-10)).toEqual(Array(10).fill('overlay'));
    expect(tracked.operations.indexOf('insert')).toBeLessThan(tracked.operations.lastIndexOf('overlay'));
  });

  it('records request ids before pruning works and restores them after the source-work rewrite', async () => {
    const tracked = catalogDb();
    const store = new MonitoredStoreService(tracked.db as never, {} as never);
    const row = workRow({ matchedBookId: null, matchedEbookBookId: null, matchedAudioBookId: null, ownedFormats: [] });

    await store.saveCatalog('monitor-1', {
      fetchedAt: '2026-09-18T00:00:00.000Z',
      works: [
        {
          ...row,
          kind: row.kind ?? undefined,
          providerWorkIds: { hardcover: 'the-work' },
          monitorState: 'monitoring',
          matchedBookIds: {},
          monitorFormats: {},
          requestIds: {},
        },
      ],
    });

    const statements = tracked.tx.execute.mock.calls.map(([statement]) => rendered(statement as SQL));
    expect(tracked.operations.slice(0, 4)).toEqual(['overlay', 'overlay', 'overlay', 'insert']);
    expect(statements[0]).toContain('insert into "monitored_request_ledger"');
    expect(statements[1]).toContain('insert into "monitored_choice_ledger"');
    expect(statements[2]).toContain('delete from "monitored_choice_ledger"');
    expect(statements[3]).toContain('insert into "monitored_author_works" (work_id, monitor_author_id, "ebook_request_id")');
    expect(statements[4]).toContain('insert into "monitored_author_works" (work_id, monitor_author_id, "audiobook_request_id")');
    expect(statements[5]).toContain('insert into "monitored_author_works" (work_id, monitor_author_id, monitor_state');
    expect(tracked.operations.indexOf('overlay', 3)).toBeGreaterThan(tracked.operations.lastIndexOf('insert'));
  });

  it('enrols release probes after reapplying the overlay in the catalog transaction', async () => {
    const tracked = catalogDb();
    const store = new MonitoredStoreService(tracked.db as never, {} as never);
    const row = workRow({ matchedBookId: null, matchedEbookBookId: null, matchedAudioBookId: null, ownedFormats: [] });

    await store.saveCatalog(
      'monitor-1',
      {
        fetchedAt: '2026-09-18T00:00:00.000Z',
        works: [
          {
            ...row,
            kind: row.kind ?? undefined,
            providerWorkIds: { hardcover: 'the-work' },
            monitorState: 'monitoring',
            matchedBookIds: {},
            monitorFormats: {},
            requestIds: {},
          },
        ],
      },
      { enrolReleaseProbes: true },
    );

    expect(tracked.tx.execute).toHaveBeenCalledTimes(17);
    const statements = tracked.tx.execute.mock.calls.map(([statement]) => rendered(statement as SQL));
    expect(statements[11]).toContain('set auto_release_date = work.audio_release_date');
    expect(statements[12]).toContain("probe.status = 'dated'");
    expect(statements[13]).toContain('insert into "author_catalog_work_releases"');
    expect(statements[14]).toContain('insert into "author_catalog_work_releases"');
    expect(statements[15]).toContain('set ebook_release_date = null');
    expect(statements[16]).toContain('set audio_release_date = null');
  });

  it('only records request ids and choices when clearing a null catalog', async () => {
    const tracked = catalogDb();
    const store = new MonitoredStoreService(tracked.db as never, {} as never);

    await store.saveCatalog('monitor-1', null);

    expect(tracked.tx.execute).toHaveBeenCalledTimes(3);
    expect(rendered(tracked.tx.execute.mock.calls[0][0] as SQL)).toContain('insert into "monitored_request_ledger"');
    expect(rendered(tracked.tx.execute.mock.calls[1][0] as SQL)).toContain('insert into "monitored_choice_ledger"');
  });
});

describe('MonitoredStoreService author aggregate counting', () => {
  // The list badge and the detail page must bucket every work identically. The overlay is LEFT
  // JOINed, so an unreviewed work has a NULL user_visibility: without coalesce the visibility
  // expression is NULL, `not NULL` is NULL, and the row lands in neither total nor hidden. That is
  // not something a store mock can catch, so this asserts the SQL the aggregate actually issues.
  async function aggregateFields(viewer: RequestUser, libraryIds: number[] = [1]): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {};
    for (const method of ['from', 'innerJoin', 'leftJoin', 'where']) builder[method] = vi.fn(() => builder);
    builder.groupBy = vi.fn(() => Promise.resolve([]));
    const db = {
      select: vi.fn((fields: Record<string, unknown>) => {
        captured = fields;
        return builder;
      }),
    };
    const store = new MonitoredStoreService(db as never, { findAccessibleLibraryIds: vi.fn().mockResolvedValue(libraryIds) } as never);
    await store.getAuthorAggregates(['monitor-1'], viewer, '2026-09-05');
    return captured;
  }

  /** One line, and blind to where the binds fall, so an assertion reads as the predicate it checks. */
  function countSql(field: unknown): string {
    return new PgDialect()
      .sqlToQuery(field as SQL)
      .sql.replace(/\s+/g, ' ')
      .replace(/\$\d+/g, '$?');
  }

  it('buckets a work with no overlay row into exactly one of total and hidden', async () => {
    const dialect = new PgDialect();
    const fields = await aggregateFields({ id: 1, isSuperuser: false } as RequestUser);
    const total = dialect.sqlToQuery(fields.total as SQL).sql;
    const hidden = dialect.sqlToQuery(fields.hidden as SQL).sql;

    expect(total).toContain('coalesce(');
    expect(hidden).toContain('not coalesce(');
    expect(total).toContain('"monitored_author_works"."user_visibility"');
    expect(hidden).toContain('"monitored_author_works"."user_visibility"');
    expect(total).toContain('"monitored_author_works"."user_kind"');
    expect(hidden).toContain('"monitored_author_works"."user_kind"');
    // Same predicate on both sides, so no row can satisfy both or neither.
    expect(hidden.replace('not coalesce(', 'coalesce(')).toContain(total.slice(total.indexOf('coalesce('), total.lastIndexOf(')::int')));
  });

  it('matches the shared visibility precedence for hidden, marked, kept and automatic works', () => {
    const condition = rendered(visibleWorkCondition()).replace(/\s+/g, ' ');

    expect(condition).toContain(`when "monitored_author_works"."user_visibility" = 'hidden' then false`);
    expect(condition).toContain('when "monitored_author_works"."user_kind" is not null then "monitored_author_works"."user_kind" =');
    expect(condition).toContain(`when "monitored_author_works"."user_visibility" = 'visible' then true`);
    expect(condition).toContain('else ("author_catalog_works"."verdict" =');
    expect(condition).toMatch(/^coalesce\(case .* end, false\)$/);
  });

  it("uses the scoped owner's curation directly when evaluating aggregate visibility", async () => {
    const dialect = new PgDialect();
    const viewerFields = await aggregateFields({ id: 2, isSuperuser: false } as RequestUser);
    const superuserFields = await aggregateFields({ id: 3, isSuperuser: true } as RequestUser);
    const viewerTotal = dialect.sqlToQuery(viewerFields.total as SQL).sql;
    const superuserTotal = dialect.sqlToQuery(superuserFields.total as SQL).sql;

    expect(viewerTotal).toContain('"monitored_author_works"."user_visibility"');
    expect(viewerTotal).not.toContain('case when "monitored_authors"."owner_user_id" =');
    expect(dialect.sqlToQuery(viewerFields.hidden as SQL).sql).not.toContain('is distinct from');
    expect(superuserTotal).toBe(viewerTotal);
  });

  it('counts an available request match as owned, reading only this work request and the viewer libraries', async () => {
    const fields = await aggregateFields({ id: 1, isSuperuser: false } as RequestUser, [7, 9]);

    // Correlated to the overlay column, so the count can only ever see the request this work filed,
    // and joined through books, so a filed book outside the viewer's libraries counts for nobody.
    expect(countSql(fields.ebookOwned)).toContain(
      'exists ( select 1 from "book_requests" inner join "books" on "books"."id" = "book_requests"."matched_book_id" ' +
        'where "book_requests"."id" = "monitored_author_works"."ebook_request_id" and "book_requests"."status" = \'available\' ' +
        'and "books"."library_id" in ($?, $?) )',
    );
    expect(countSql(fields.audioOwned)).toContain('"book_requests"."id" = "monitored_author_works"."audiobook_request_id"');
    // Both branches, the stored match and the filed request, bind the same accessible libraries.
    expect(new PgDialect().sqlToQuery(fields.ebookOwned as SQL).params.slice(-4)).toEqual([7, 9, 7, 9]);
  });

  it('counts nothing owned for a viewer with no accessible library', async () => {
    const fields = await aggregateFields({ id: 1, isSuperuser: false } as RequestUser, []);

    expect(countSql(fields.ebookOwned)).toContain(' and false)::int');
    expect(countSql(fields.audioOwned)).toContain(' and false)::int');
  });
});

describe('MonitoredStoreService paged lists', () => {
  function pagedSelectDb(results: unknown[][]) {
    const builders: Array<Record<string, ReturnType<typeof vi.fn>>> = [];
    const queue = [...results];
    const select = vi.fn(() => {
      const rows = queue.shift() ?? [];
      const builder = {} as Record<string, ReturnType<typeof vi.fn>>;
      for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'groupBy', 'orderBy', 'limit', 'offset']) {
        builder[method] = vi.fn(() => builder);
      }
      builder.then = vi.fn((resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve));
      builders.push(builder);
      return builder;
    });
    // Both statements of a page run inside one snapshot transaction, so the fake has to hand the
    // callback an executor; handing back the same tracked db keeps the builder assertions meaningful.
    const transaction = vi.fn((run: (tx: unknown) => Promise<unknown>) => run({ select }));
    return { db: { select, transaction }, builders, transaction };
  }

  it('scopes a superuser monitored author read to the superuser owner id', () => {
    const store = new MonitoredStoreService({} as never, {} as never);
    const predicate = Reflect.apply((store as unknown as { readScope: (...args: unknown[]) => SQL }).readScope, store, [
      { id: 9, isSuperuser: true } as RequestUser,
      schema.monitoredAuthors.ownerUserId,
    ]);
    const query = new PgDialect().sqlToQuery(predicate);

    expect(query.sql).toBe('"monitored_authors"."owner_user_id" = $1');
    expect(query.sql).not.toContain('"monitored_authors"."is_shared"');
    expect(query.params).toEqual([9]);
  });

  it('scopes name lookups to the caller for regular and superuser viewers', async () => {
    const tracked = pagedSelectDb([[], []]);
    const store = new MonitoredStoreService(tracked.db as never, {} as never);

    await store.findMonitoredIdsByNames(['Target Author'], { id: 2, isSuperuser: false } as RequestUser);
    await store.findMonitoredIdsByNames(['Target Author'], { id: 9, isSuperuser: true } as RequestUser);

    for (const [index, userId] of [2, 9].entries()) {
      const predicate = tracked.builders[index]?.where.mock.calls[0]?.[0] as SQL;
      const query = new PgDialect().sqlToQuery(predicate);
      expect(query.sql).toContain('"monitored_authors"."owner_user_id" = $1');
      expect(query.sql).not.toContain('"monitored_authors"."is_shared"');
      expect(query.params[0]).toBe(userId);
    }
  });

  it('maps library authors to the viewer own monitors, preferring a link by id over a name match', async () => {
    const tracked = pagedSelectDb([
      [
        { id: 'by-name', authorName: 'Zogarth', localAuthorId: null },
        { id: 'by-link', authorName: 'Zogarth (Author)', localAuthorId: 5 },
        { id: 'other-name', authorName: 'Shirtaloon', localAuthorId: null },
      ],
    ]);
    const store = new MonitoredStoreService(tracked.db as never, {} as never);

    const result = await store.findMonitoredIdsByLocalAuthors(
      [
        { id: 5, name: 'Zogarth' },
        { id: 6, name: 'shirtaloon' },
        { id: 7, name: 'Nobody' },
      ],
      { id: 2, isSuperuser: true } as RequestUser,
    );

    expect(result).toEqual(
      new Map([
        [5, 'by-link'],
        [6, 'other-name'],
      ]),
    );
    const query = new PgDialect().sqlToQuery(tracked.builders[0]?.where.mock.calls[0]?.[0] as SQL);
    expect(query.sql).toContain('"monitored_authors"."owner_user_id" = $1');
    expect(query.params[0]).toBe(2);
  });

  it('never matches a namesake by name to a monitor linked to another author', async () => {
    const tracked = pagedSelectDb([[{ id: 'linked-elsewhere', authorName: 'John Smith', localAuthorId: 8 }]]);
    const store = new MonitoredStoreService(tracked.db as never, {} as never);

    const result = await store.findMonitoredIdsByLocalAuthors(
      [
        { id: 8, name: 'John Smith' },
        { id: 9, name: 'John Smith' },
      ],
      { id: 2, isSuperuser: false } as RequestUser,
    );

    expect(result).toEqual(new Map([[8, 'linked-elsewhere']]));
  });

  it('skips the query when no library authors are asked about', async () => {
    const tracked = pagedSelectDb([]);
    const store = new MonitoredStoreService(tracked.db as never, {} as never);

    expect(await store.findMonitoredIdsByLocalAuthors([], { id: 2, isSuperuser: false } as RequestUser)).toEqual(new Map());
    expect(tracked.builders).toHaveLength(0);
  });

  it("returns only a superuser viewer's own monitored author ids", async () => {
    const tracked = pagedSelectDb([[{ id: 'mine-1' }], [{ total: 1 }]]);
    const store = new MonitoredStoreService(tracked.db as never, {} as never);

    const result = await store.findOwnedAuthorIdsPage({ id: 9, isSuperuser: true } as RequestUser, 0, 200);

    expect(result).toEqual({ items: ['mine-1'], total: 1, page: 0, size: 200 });
    for (const builder of tracked.builders) {
      const predicate = builder.where.mock.calls[0]?.[0] as SQL;
      const query = new PgDialect().sqlToQuery(predicate);
      expect(query.sql).toBe('"monitored_authors"."owner_user_id" = $1');
      expect(query.params).toEqual([9]);
    }
  });

  it('refuses a superuser write to another user monitored author', async () => {
    const tracked = pagedSelectDb([[{ ownerUserId: 1 }]]);
    const store = new MonitoredStoreService(tracked.db as never, {} as never);

    await expect(
      Reflect.apply((store as unknown as { assertAuthorWritable: (...args: unknown[]) => Promise<void> }).assertAuthorWritable, store, [
        'monitor-1',
        { id: 9, isSuperuser: true } as RequestUser,
      ]),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a superuser write to another user monitored book', async () => {
    const tracked = pagedSelectDb([[{ ownerUserId: 1 }]]);
    const store = new MonitoredStoreService(tracked.db as never, {} as never);

    await expect(
      Reflect.apply((store as unknown as { assertBookWritable: (...args: unknown[]) => Promise<void> }).assertBookWritable, store, [
        'book-1',
        { id: 9, isSuperuser: true } as RequestUser,
      ]),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a superuser write to a work on another user monitored author', async () => {
    const tracked = pagedSelectDb([[{ ownerUserId: 1 }]]);
    const store = new MonitoredStoreService(tracked.db as never, {} as never);

    await expect(
      Reflect.apply((store as unknown as { assertWorkWritable: (...args: unknown[]) => Promise<void> }).assertWorkWritable, store, [
        'work-1',
        { id: 9, isSuperuser: true } as RequestUser,
      ]),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('applies LIMIT/OFFSET to the author data query and gets total from a separate count query', async () => {
    const tracked = pagedSelectDb([[], [{ total: 123 }]]);
    const store = new MonitoredStoreService(tracked.db as never, { findAccessibleLibraryIds: vi.fn().mockResolvedValue([]) } as never);

    const result = await store.findAuthorPage({
      viewer: { id: 1, isSuperuser: false } as RequestUser,
      page: 2,
      size: 17,
      sort: 'progress',
      order: 'desc',
      today: '2026-09-05',
    });

    expect(tracked.builders[0]?.limit).toHaveBeenCalledWith(17);
    expect(tracked.builders[0]?.offset).toHaveBeenCalledWith(34);
    expect(tracked.builders[1]?.limit).not.toHaveBeenCalled();
    expect(result).toEqual({ items: [], total: 123, page: 2, size: 17 });
    // A total read outside the rows' snapshot can contradict them; both statements share one.
    expect(tracked.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'repeatable read', accessMode: 'read only' });
  });

  it('applies LIMIT/OFFSET before composing monitored book page rows', async () => {
    const tracked = pagedSelectDb([[], [{ total: 78 }]]);
    const store = new MonitoredStoreService(tracked.db as never, {} as never);

    const result = await store.findBookPage({
      viewer: { id: 1, isSuperuser: false } as RequestUser,
      q: 'orbit',
      page: 3,
      size: 20,
      sort: 'author',
      order: 'asc',
    });

    expect(tracked.builders[0]?.limit).toHaveBeenCalledWith(20);
    expect(tracked.builders[0]?.offset).toHaveBeenCalledWith(60);
    expect(tracked.builders[1]?.limit).not.toHaveBeenCalled();
    expect(result).toEqual({ items: [], total: 78, page: 3, size: 20 });
  });

  it('puts release LIMIT/OFFSET in SQL while the total query remains unpaged', async () => {
    const dialect = new PgDialect();
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const execute = vi.fn((statement: SQL) => {
      const compiled = dialect.sqlToQuery(statement);
      statements.push(compiled);
      return Promise.resolve(compiled.sql.includes('count(*)::int') ? { rows: [{ total: 456, byStatus: 300, byWork: 240 }] } : { rows: [] });
    });
    const store = new MonitoredStoreService({ execute } as never, {} as never);

    const result = await store.findReleasePage({
      viewer: { id: 1, isSuperuser: false } as RequestUser,
      q: 'orbit',
      page: 4,
      size: 25,
      sort: 'date',
      order: 'desc',
      filter: 'soon',
      earliest: '2026-06-07',
      latest: '2027-09-05',
      today: '2026-09-05',
      soonLatest: '2026-10-05',
      currentYear: '2026',
    });

    const data = statements.find((statement) => statement.sql.includes('limit'));
    const total = statements.find((statement) => statement.sql.includes('count(*)::int'));
    expect(data?.sql).toContain('limit');
    expect(data?.sql).toContain('offset');
    expect(data?.params).toEqual(expect.arrayContaining([25, 100]));
    expect(total?.sql).not.toContain('limit');
    expect(total?.sql).not.toContain('offset');
    expect(total?.sql).toContain('count(distinct "workId")');
    expect(total?.params).toEqual(expect.arrayContaining(['2026-09-05']));
    expect(result).toEqual({ items: [], total: 456, cards: { byStatus: 300, byWork: 240 }, page: 4, size: 25 });
  });

  function releaseStatusStatements(status: Parameters<MonitoredStoreService['findReleasePage']>[0]['status']) {
    const dialect = new PgDialect();
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const execute = vi.fn((statement: SQL) => {
      const compiled = dialect.sqlToQuery(statement);
      statements.push(compiled);
      return Promise.resolve(compiled.sql.includes('count(*)::int') ? { rows: [{ total: 0, byStatus: 0, byWork: 0 }] } : { rows: [] });
    });
    const findAccessibleLibraryIds = vi.fn().mockResolvedValue([3]);
    const store = new MonitoredStoreService({ execute } as never, { findAccessibleLibraryIds } as never);
    const run = store.findReleasePage({
      viewer: { id: 1, isSuperuser: false } as RequestUser,
      page: 0,
      size: 25,
      sort: 'date',
      order: 'asc',
      filter: 'all',
      status,
      earliest: '2026-06-07',
      latest: '2027-09-05',
      today: '2026-09-05',
      soonLatest: '2026-10-05',
      currentYear: '2026',
    });
    return { run, statements, findAccessibleLibraryIds };
  }

  it('passes selected kinds and review flags into release SQL', () => {
    const store = new MonitoredStoreService({} as never, {} as never);
    const statement = store['releaseRowsSql']({
      viewer: { id: 1, isSuperuser: false } as RequestUser,
      kinds: ['graphic_novel', 'collection'],
      more: ['unconfirmed', 'hidden', 'placeholders'],
      filter: 'all',
      earliest: '2026-06-07',
      latest: '2027-09-05',
      today: '2026-09-05',
      soonLatest: '2026-10-05',
      currentYear: '2026',
    });
    const compiled = new PgDialect().sqlToQuery(statement);
    expect(compiled.params).toEqual(expect.arrayContaining(['graphic_novel', 'collection']));
    expect(compiled.sql).toContain('is null');
    expect(compiled.sql).toContain('["placeholder"]');
  });

  it('reads review-class dates through the probe rows, not the catalog columns alone', () => {
    const store = new MonitoredStoreService({} as never, {} as never);
    const statement = store['releaseRowsSql']({
      viewer: { id: 1, isSuperuser: false } as RequestUser,
      kinds: ['comic'],
      more: [],
      filter: 'recent',
      earliest: '2026-06-07',
      latest: '2027-09-05',
      today: '2026-09-05',
      soonLatest: '2026-10-05',
      currentYear: '2026',
    });
    const compiled = new PgDialect().sqlToQuery(statement);
    expect(compiled.sql).toContain('left join "author_catalog_work_releases" as "ebook_probe"');
    expect(compiled.sql).toContain('left join "author_catalog_work_releases" as "audiobook_probe"');
    expect(compiled.sql).toContain(`nullif("ebook_probe"."release_date", '')`);
    expect(compiled.sql).toContain(`nullif("audiobook_probe"."release_date", '')`);
    expect(compiled.sql).toMatch(/as "releaseDate"/);
    expect(compiled.sql).not.toMatch(/"author_catalog_works"\."ebook_release_date" as "releaseDate"/);
    expect(compiled.sql).not.toMatch(/"author_catalog_works"\."audio_release_date" as "releaseDate"/);
  });

  it('preserves the default release row SQL baseline', () => {
    const store = new MonitoredStoreService({} as never, {} as never);
    const statement = store['releaseRowsSql']({
      viewer: { id: 1, isSuperuser: false } as RequestUser,
      filter: 'all',
      earliest: '2026-06-07',
      latest: '2027-09-05',
      today: '2026-09-05',
      soonLatest: '2026-10-05',
      currentYear: '2026',
    });
    expect(new PgDialect().sqlToQuery(statement)).toMatchSnapshot();
    const explicit = store['releaseRowsSql']({
      viewer: { id: 1, isSuperuser: false } as RequestUser,
      kinds: ['book'],
      more: [],
      filter: 'all',
      earliest: '2026-06-07',
      latest: '2027-09-05',
      today: '2026-09-05',
      soonLatest: '2026-10-05',
      currentYear: '2026',
    });
    expect(new PgDialect().sqlToQuery(explicit)).toEqual(new PgDialect().sqlToQuery(statement));
  });

  it('keeps the old visible-and-watched release list when no status filter is sent', async () => {
    const { run, statements, findAccessibleLibraryIds } = releaseStatusStatements(undefined);
    await run;

    const data = statements.find((statement) => statement.sql.includes('limit'));
    expect(data?.sql).toContain('"monitored_author_works"."monitor_ebook" <> $');
    expect(data?.sql).not.toContain("then 'in_library'");
    expect(findAccessibleLibraryIds).not.toHaveBeenCalled();
  });

  it('filters release rows by format status in SQL rather than over a loaded page', async () => {
    const { run, statements, findAccessibleLibraryIds } = releaseStatusStatements(['missing', 'needs_attention']);
    await run;

    for (const statement of statements) {
      expect(statement.sql).toContain("then 'in_library'");
      expect(statement.sql).toContain("then 'not_watched'");
      // The switched-off format is classified, not dropped, so it can never fall through to missing.
      expect(statement.sql).not.toContain('"monitored_author_works"."monitor_ebook" <> $');
      expect(statement.params).toEqual(expect.arrayContaining(['missing', 'needs_attention', 'needs_review', 'failed']));
      expect(statement.params).not.toContain('in_library');
    }
    expect(findAccessibleLibraryIds).toHaveBeenCalledTimes(1);
  });

  it('buckets a release by the same date the client reads, probe row first', async () => {
    const { run, statements } = releaseStatusStatements(['missing', 'upcoming']);
    await run;

    for (const [index, statement] of statements.entries()) {
      const format = index % 2 === 0 ? 'ebook' : 'audiobook';
      expect(statement.sql).toContain(`left join "author_catalog_work_releases" as "ebook_probe"`);
      expect(statement.sql).toContain(`left join "author_catalog_work_releases" as "audiobook_probe"`);
      // An unlisted probe voids the catalog date; a probe date wins over it and brings its own precision.
      expect(statement.sql).toContain(`"${format}_probe"."status" = 'unlisted'`);
      expect(statement.sql).toContain(`nullif("${format}_probe"."release_date", '')`);
      expect(statement.sql).toContain(`"${format}_probe"."date_precision"`);
      // The same shape guard monitoredReleaseStarted applies, bound as a parameter like every other value.
      expect(statement.sql).toContain('length(btrim(');
      expect(statement.params).toContain('^[0-9]{4}(-[0-9]{2}(-[0-9]{2})?)?$');
    }
  });

  it.each([
    ['probe later than the catalog', { ebookReleaseDate: '2020-01-01', formatReleases: { ebook: probe('dated', '2099-06-01') } }, 'upcoming'],
    ['probe earlier than the catalog', { ebookReleaseDate: '2099-01-01', formatReleases: { ebook: probe('dated', '2020-06-01') } }, 'missing'],
    ['probe that lists no edition', { ebookReleaseDate: '2020-01-01', formatReleases: { ebook: probe('unlisted', null) } }, 'upcoming'],
    ['probe with no date of its own', { ebookReleaseDate: '2020-01-01', formatReleases: { ebook: probe('expected', null) } }, 'missing'],
    ['day value shorter than its precision', { ebookReleaseDate: '2020-01', ebookDatePrecision: 'day' as const }, 'upcoming'],
  ])('the client puts a %s in the %s bucket the SQL cases above encode', (_name, patch, bucket) => {
    const defaults = {
      ownedFormats: [],
      matchedBookIds: {},
      ebookReleaseDate: null,
      ebookDatePrecision: null,
      audioReleaseDate: null,
      audioDatePrecision: null,
    };
    const work = { ...defaults, ...patch };
    const status = monitoredFormatStatus(work as never, 'ebook', '2026-10-15');
    expect(MONITORED_STATUS_FILTER_BY_FORMAT_STATUS[status]).toBe(bucket);
  });

  it('clears the visibility override on back to automatic, and the mark too unless the work was hidden', async () => {
    const values = vi.fn();
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const limit = vi.fn().mockResolvedValue([workRow()]);
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })) })),
      insert: vi.fn(() => ({ values: values.mockReturnValue({ onConflictDoUpdate }) })),
    };
    const store = new MonitoredStoreService(db as never, {} as never);
    const internals = store as unknown as { assertWorkWritable: () => Promise<void>; composeWorks: () => Promise<unknown[]> };
    vi.spyOn(internals, 'assertWorkWritable').mockResolvedValue(undefined);
    vi.spyOn(internals, 'composeWorks').mockResolvedValue([{ monitorAuthorId: 'monitor-1', work: { id: 'monitor-1:hardcover:1' } }]);

    await store.updateWorkUserState('monitor-1:hardcover:1', { automaticVisibility: true }, { id: 1, isSuperuser: false } as RequestUser);

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ userVisibility: null, userKind: null }));
    const set = onConflictDoUpdate.mock.calls[0]?.[0]?.set as { userVisibility: SQL; userKind: SQL };
    expect(rendered(set.userVisibility)).toBe('excluded.user_visibility');
    expect(rendered(set.userKind)).toBe(
      'case when "monitored_author_works"."user_visibility" = \'hidden\' then "monitored_author_works"."user_kind" else null end',
    );
  });

  it('stores a review mark and clears only a visible override', async () => {
    const values = vi.fn();
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const limit = vi.fn().mockResolvedValue([workRow()]);
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })) })),
      insert: vi.fn(() => ({ values: values.mockReturnValue({ onConflictDoUpdate }) })),
    };
    const store = new MonitoredStoreService(db as never, {} as never);
    const internals = store as unknown as { assertWorkWritable: () => Promise<void>; composeWorks: () => Promise<unknown[]> };
    vi.spyOn(internals, 'assertWorkWritable').mockResolvedValue(undefined);
    vi.spyOn(internals, 'composeWorks').mockResolvedValue([{ monitorAuthorId: 'monitor-1', work: { id: 'monitor-1:hardcover:1' } }]);

    await store.updateWorkUserState('monitor-1:hardcover:1', { kind: 'collection' }, { id: 1, isSuperuser: false } as RequestUser);

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ userKind: 'collection', userVisibility: null }));
    const set = onConflictDoUpdate.mock.calls[0]?.[0]?.set;
    expect(rendered(set.userVisibility)).toContain('case when "monitored_author_works"."user_visibility" = \'visible\' then null else');
  });

  it('keeps visibility unchanged when marking a work as a book', async () => {
    const values = vi.fn();
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const limit = vi.fn().mockResolvedValue([workRow()]);
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })) })),
      insert: vi.fn(() => ({ values: values.mockReturnValue({ onConflictDoUpdate }) })),
    };
    const store = new MonitoredStoreService(db as never, {} as never);
    const internals = store as unknown as { assertWorkWritable: () => Promise<void>; composeWorks: () => Promise<unknown[]> };
    vi.spyOn(internals, 'assertWorkWritable').mockResolvedValue(undefined);
    vi.spyOn(internals, 'composeWorks').mockResolvedValue([{ monitorAuthorId: 'monitor-1', work: { id: 'monitor-1:hardcover:1' } }]);

    await store.updateWorkUserState('monitor-1:hardcover:1', { kind: 'book' }, { id: 1, isSuperuser: false } as RequestUser);

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ userKind: 'book' }));
    expect(values.mock.calls[0]?.[0]).not.toHaveProperty('userVisibility');
    expect(onConflictDoUpdate.mock.calls[0]?.[0]?.set).not.toHaveProperty('userVisibility');
  });

  it('keeps a book mark but clears any non-book mark when keeping a work', async () => {
    const values = vi.fn();
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const limit = vi.fn().mockResolvedValue([workRow()]);
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })) })),
      insert: vi.fn(() => ({ values: values.mockReturnValue({ onConflictDoUpdate }) })),
    };
    const store = new MonitoredStoreService(db as never, {} as never);
    const internals = store as unknown as { assertWorkWritable: () => Promise<void>; composeWorks: () => Promise<unknown[]> };
    vi.spyOn(internals, 'assertWorkWritable').mockResolvedValue(undefined);
    vi.spyOn(internals, 'composeWorks').mockResolvedValue([{ monitorAuthorId: 'monitor-1', work: { id: 'monitor-1:hardcover:1' } }]);

    await store.updateWorkUserState('monitor-1:hardcover:1', { hidden: false }, { id: 1, isSuperuser: false } as RequestUser);

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ userVisibility: 'visible', userKind: null }));
    const set = onConflictDoUpdate.mock.calls[0]?.[0]?.set;
    expect(rendered(set.userKind)).toContain('case when "monitored_author_works"."user_kind" = \'book\'');
  });

  it('loads works and their distinct monitors in one joined read before composing the batch', async () => {
    const first = workRow({ id: 'work-1' });
    const second = workRow({ id: 'work-2' });
    const monitorRow = {
      id: 'monitor-1',
      ownerUserId: 1,
      authorName: 'Test Author',
    };
    const rows = [
      { work: first, monitor: monitorRow },
      { work: second, monitor: monitorRow },
    ];
    const builder: Record<string, unknown> = {};
    builder.from = vi.fn(() => builder);
    builder.innerJoin = vi.fn(() => builder);
    builder.where = vi.fn().mockResolvedValue(rows);
    const db = { select: vi.fn(() => builder) };
    const store = new MonitoredStoreService(db as never, {} as never);
    const composedMonitor = { id: 'monitor-1', ownerUserId: 1 };
    const composedWorks = [
      { monitorAuthorId: 'monitor-1', work: { id: 'work-1' } },
      { monitorAuthorId: 'monitor-1', work: { id: 'work-2' } },
    ];
    const internals = store as unknown as {
      composeAuthors: (rows: unknown[]) => Promise<unknown[]>;
      composeWorks: (rows: unknown[], viewer: RequestUser, retainHidden: boolean) => Promise<unknown[]>;
    };
    vi.spyOn(internals, 'composeAuthors').mockResolvedValue([composedMonitor]);
    const composeWorksSpy = vi.spyOn(internals, 'composeWorks').mockResolvedValue(composedWorks);
    const actor = { id: 1, isSuperuser: false } as RequestUser;

    const result = await store.getWorksWithMonitors(['work-1', 'work-2'], actor);

    expect(db.select).toHaveBeenCalledOnce();
    expect(internals.composeAuthors).toHaveBeenCalledWith([monitorRow]);
    expect(composeWorksSpy).toHaveBeenCalledWith([first, second], actor, true);
    expect(result.get('work-2')).toEqual({ monitor: composedMonitor, work: { id: 'work-2' } });
  });

  it('bulk upserts only patch columns once and composes all updated works once', async () => {
    const rows = [workRow({ id: 'work-1' }), workRow({ id: 'work-2' })];
    const where = vi.fn().mockResolvedValue(rows);
    const select = vi.fn(() => ({ from: vi.fn(() => ({ where })) }));
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values }));
    const transaction = vi.fn((run: (tx: unknown) => Promise<unknown>) => run({ select, insert }));
    const store = new MonitoredStoreService({ transaction } as never, {} as never);
    const internals = store as unknown as { composeWorks: (...args: unknown[]) => Promise<Array<{ work: MonitoredWork }>> };
    const composed = rows.map((row) => ({ monitorAuthorId: row.monitorAuthorId, work: { id: row.id } as MonitoredWork }));
    const composeWorksSpy = vi.spyOn(internals, 'composeWorks').mockResolvedValue(composed);
    const actor = { id: 1, isSuperuser: false } as RequestUser;

    await store.updateWorksUserState(['work-1', 'work-2'], { monitorEbook: false, hidden: true }, actor);

    expect(transaction).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledWith([
      { workId: 'work-1', monitorAuthorId: 'monitor-1', monitorEbook: false, userVisibility: 'hidden' },
      { workId: 'work-2', monitorAuthorId: 'monitor-1', monitorEbook: false, userVisibility: 'hidden' },
    ]);
    const set = onConflictDoUpdate.mock.calls[0]?.[0]?.set;
    expect(Object.keys(set).sort()).toEqual(['monitorEbook', 'userVisibility']);
    expect(set).not.toHaveProperty('ebookRequestId');
    expect(set).not.toHaveProperty('monitorState');
    expect(composeWorksSpy).toHaveBeenCalledOnce();
    expect(composeWorksSpy).toHaveBeenCalledWith(rows, actor);
  });

  it.each([
    [{ hidden: false }, { userVisibility: 'visible', userKind: null }],
    [{ automaticVisibility: true as const }, { userVisibility: null, userKind: null }],
  ])('bulk %o also drops the owner mark that would keep the work in review', async (patch, expected) => {
    const rows = [workRow({ id: 'work-1' })];
    const where = vi.fn().mockResolvedValue(rows);
    const select = vi.fn(() => ({ from: vi.fn(() => ({ where })) }));
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values }));
    const transaction = vi.fn((run: (tx: unknown) => Promise<unknown>) => run({ select, insert }));
    const store = new MonitoredStoreService({ transaction } as never, {} as never);
    const internals = store as unknown as { composeWorks: (...args: unknown[]) => Promise<Array<{ work: MonitoredWork }>> };
    vi.spyOn(internals, 'composeWorks').mockResolvedValue([]);

    await store.updateWorksUserState(['work-1'], patch, { id: 1, isSuperuser: false } as RequestUser);

    expect(values).toHaveBeenCalledWith([{ workId: 'work-1', monitorAuthorId: 'monitor-1', ...expected }]);
    const set = onConflictDoUpdate.mock.calls[0]?.[0]?.set as { userKind: SQL };
    expect(rendered(set.userKind)).toBe(
      'hidden' in patch
        ? 'case when "monitored_author_works"."user_kind" = \'book\' then "monitored_author_works"."user_kind" else null end'
        : 'case when "monitored_author_works"."user_visibility" = \'hidden\' then "monitored_author_works"."user_kind" else null end',
    );
  });

  it('bulk marks a kind and drops a kept choice so the works go to review', async () => {
    const rows = [workRow({ id: 'work-1' })];
    const where = vi.fn().mockResolvedValue(rows);
    const select = vi.fn(() => ({ from: vi.fn(() => ({ where })) }));
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values }));
    const transaction = vi.fn((run: (tx: unknown) => Promise<unknown>) => run({ select, insert }));
    const store = new MonitoredStoreService({ transaction } as never, {} as never);
    const internals = store as unknown as { composeWorks: (...args: unknown[]) => Promise<Array<{ work: MonitoredWork }>> };
    vi.spyOn(internals, 'composeWorks').mockResolvedValue([]);

    await store.updateWorksUserState(['work-1'], { kind: 'split_part' }, { id: 1, isSuperuser: false } as RequestUser);

    expect(values).toHaveBeenCalledWith([{ workId: 'work-1', monitorAuthorId: 'monitor-1', userKind: 'split_part', userVisibility: null }]);
    expect(Object.keys(onConflictDoUpdate.mock.calls[0]?.[0]?.set).sort()).toEqual(['userKind', 'userVisibility']);
  });

  it('orders undated rows last and counts them in a separate card bucket', async () => {
    const { run, statements } = releaseStatusStatements(undefined);
    await run;
    expect(statements[0]?.sql).toContain('order by "releaseDate" asc nulls last, "workId" asc, format asc');
    expect(statements[1]?.sql).toContain(`when "releaseDate" is null then ':undated'`);
  });

  it('ignores hidden in release status selections', async () => {
    const without = releaseStatusStatements(['upcoming']);
    await without.run;
    const withHidden = releaseStatusStatements(['upcoming', 'hidden']);
    await withHidden.run;

    const plain = without.statements.find((statement) => statement.sql.includes('limit'))?.sql ?? '';
    const widened = withHidden.statements.find((statement) => statement.sql.includes('limit'))?.sql ?? '';
    expect(widened).toBe(plain);
  });
});

describe('MonitoredStoreService release detection', () => {
  const monitor = {
    id: 'monitor-1',
    ownerUserId: 4,
    authorName: 'Test Author',
    localAuthorId: null,
    providerIds: {},
    formats: {
      ebook: { mode: 'notify' as const, libraryId: null, folderId: null },
      audiobook: { mode: 'notify' as const, libraryId: null, folderId: null },
    },
    paused: false,
    addedAt: '2026-03-15T10:00:00.000Z',
    lastRefreshedAt: null,
    fetch: { state: 'idle', errorKind: null, errorAt: null, retryAt: null },
  };

  const dueRelease: MonitoredDueRelease = {
    workId: 'work-1',
    title: 'Test Work',
    identityKeys: ['hardcover:the-work'],
    seriesName: null,
    seriesIndex: null,
    format: 'ebook',
    releaseDate: '2026-09-01',
    storedDate: '2026-09-01',
    claimed: false,
  };

  it('builds both precision-aware due legs with ownership and ledger dedupe', async () => {
    const dialect = new PgDialect();
    let captured: { sql: string; params: unknown[] } | undefined;
    const db = {
      execute: vi.fn((statement: SQL) => {
        captured = dialect.sqlToQuery(statement);
        return Promise.resolve({ rows: [] });
      }),
    };
    const store = new MonitoredStoreService(db as never, { findAccessibleLibraryIds: vi.fn().mockResolvedValue([7]) } as never);

    await store.findDueReleases({ owner: { id: 4, isSuperuser: false } as RequestUser, monitor, today: '2026-09-10', limit: 25 });

    const statement = captured!.sql.replace(/\s+/g, ' ');
    expect(statement).toContain(' union all ');
    expect(statement.match(/inner join "monitored_authors"/g)).toHaveLength(2);
    expect(statement).toMatch(/case when .* = 'day' then case .*'-01-01'.* <= \$\d+ else case .*'-12-31'.* < \$\d+ end/);
    expect(statement).toMatch(/'-31'.* >= \$\d+/);
    expect(statement).toContain('not (');
    expect(statement).toContain('left join "monitored_release_events"');
    expect(statement).toContain('"monitored_release_events"."notified_at" is null');
    expect(statement).toContain('not exists ( select 1 from "monitored_release_events" as prior_release');
    expect(statement).toMatch(/prior_release\.monitor_author_id = \$\d+/);
    expect(statement).toContain('prior_release.notified_at is not null');
    expect(statement).toContain('lower(public.bookorbit_unaccent(prior_release.title))');
    expect(statement).toContain('lower(public.bookorbit_unaccent("author_catalog_works"."title"))');
    expect(statement).toContain('or prior_release.identity_keys && array( select identity.source');
    expect(statement).toContain('as "identityKeys"');
  });

  it.each([
    [[] as Array<{ workId: string }>, false],
    [[{ workId: 'work-1' }], true],
  ])('leases only when the owner-scoped update returns a row', async (rows, expected) => {
    const dialect = new PgDialect();
    let captured: { sql: string; params: unknown[] } | undefined;
    const returning = vi.fn().mockResolvedValue(rows);
    const where = vi.fn((condition: SQL) => {
      captured = dialect.sqlToQuery(condition);
      return { returning };
    });
    const set = vi.fn(() => ({ where }));
    const store = new MonitoredStoreService({ update: vi.fn(() => ({ set })) } as never, {} as never);

    await expect(store.leaseReleaseEvent('work-1', 'ebook', 4)).resolves.toBe(expected);
    expect(captured?.sql).toContain('"monitored_release_events"."work_id" = $1');
    expect(captured?.sql).toContain('"monitored_release_events"."format" = $2');
    expect(captured?.sql).toContain('"monitored_release_events"."owner_user_id" = $3');
    expect(captured?.sql).toContain('"monitored_release_events"."notified_at" is null');
    expect(captured?.params).toEqual(['work-1', 'ebook', 4]);
  });

  it('orders sync candidates by the latest attempt or refresh timestamp', async () => {
    const dialect = new PgDialect();
    let whereSql = '';
    let orderSql = '';
    const builder: Record<string, unknown> = {};
    builder.from = vi.fn(() => builder);
    builder.where = vi.fn((condition: SQL) => {
      whereSql = dialect.sqlToQuery(condition).sql;
      return builder;
    });
    builder.orderBy = vi.fn((...conditions: SQL[]) => {
      orderSql = conditions.map((condition) => dialect.sqlToQuery(condition).sql).join(' ');
      return builder;
    });
    builder.limit = vi.fn(() => Promise.resolve([]));
    const store = new MonitoredStoreService({ select: vi.fn(() => builder) } as never, {} as never);

    await store.findMonitorsDueForSync(new Date('2026-09-01T00:00:00.000Z'), 10);

    expect(whereSql).toContain('greatest("monitored_authors"."last_sync_attempted_at", "monitored_authors"."last_refreshed_at")');
    expect(orderSql).toContain('greatest("monitored_authors"."last_sync_attempted_at", "monitored_authors"."last_refreshed_at") asc nulls first');
  });

  it('writes the release title into every claimed ledger row', async () => {
    let insertedValues: unknown;
    const builder: Record<string, unknown> = {};
    builder.values = vi.fn((values: unknown) => {
      insertedValues = values;
      return builder;
    });
    builder.onConflictDoNothing = vi.fn(() => builder);
    builder.returning = vi.fn().mockResolvedValue([{ workId: 'work-1', format: 'ebook' }]);
    const store = new MonitoredStoreService({ insert: vi.fn(() => builder) } as never, {} as never);

    await expect(store.claimReleaseEvents(monitor, [dueRelease], true)).resolves.toEqual(new Set([releaseEventKey('work-1', 'ebook')]));
    expect(insertedValues).toEqual([expect.objectContaining({ workId: 'work-1', title: 'Test Work' })]);
  });

  // Flipping this ternary would spam every seeded monitor on its next tick and stay green otherwise.
  it('inserts a seeded row already notified and an announce row still pending', async () => {
    const inserted: unknown[] = [];
    const builder: Record<string, unknown> = {};
    builder.values = vi.fn((values: unknown) => {
      inserted.push(values);
      return builder;
    });
    builder.onConflictDoNothing = vi.fn(() => builder);
    builder.returning = vi.fn().mockResolvedValue([{ workId: 'work-1', format: 'ebook' }]);
    const store = new MonitoredStoreService({ insert: vi.fn(() => builder) } as never, {} as never);

    await store.claimReleaseEvents(monitor, [dueRelease], false);
    await store.claimReleaseEvents(monitor, [dueRelease], true);

    const [seeded] = inserted[0] as Array<{ detectedAt: Date; notifiedAt: Date | null }>;
    const [pending] = inserted[1] as Array<{ notifiedAt: Date | null }>;
    expect(seeded.notifiedAt).toBeInstanceOf(Date);
    expect(seeded.notifiedAt).toEqual(seeded.detectedAt);
    expect(pending.notifiedAt).toBeNull();
  });

  // An earlier version set a fresh timestamp here instead of null, which made a failed dispatch
  // look delivered forever; nothing pinned it.
  it('releases a lease by clearing notified_at under the owner-scoped key', async () => {
    const dialect = new PgDialect();
    let setValues: Record<string, unknown> | undefined;
    let captured: { sql: string; params: unknown[] } | undefined;
    const where = vi.fn((condition: SQL) => {
      captured = dialect.sqlToQuery(condition);
      return Promise.resolve(undefined);
    });
    const set = vi.fn((values: Record<string, unknown>) => {
      setValues = values;
      return { where };
    });
    const store = new MonitoredStoreService({ update: vi.fn(() => ({ set })) } as never, {} as never);

    await store.releaseReleaseEventLease('work-1', 'ebook', 4);

    expect(setValues).toEqual({ notifiedAt: null });
    expect(captured?.sql).toContain('"monitored_release_events"."work_id" = $1');
    expect(captured?.sql).toContain('"monitored_release_events"."format" = $2');
    expect(captured?.sql).toContain('"monitored_release_events"."owner_user_id" = $3');
    expect(captured?.params).toEqual(['work-1', 'ebook', 4]);
  });
});

describe('MonitoredStoreService work by library book', () => {
  function lookupDb(rows: unknown[]) {
    const builder = {} as Record<string, ReturnType<typeof vi.fn>>;
    for (const method of ['from', 'innerJoin', 'where', 'orderBy']) builder[method] = vi.fn(() => builder);
    builder.limit = vi.fn(() => Promise.resolve(rows));
    return { db: { select: vi.fn(() => builder) }, builder };
  }

  it('looks the book up through the three indexed match columns, scoped to the viewer and bounded to one row', async () => {
    const { db, builder } = lookupDb([{ id: 'monitor-1:hardcover:1' }]);
    const store = new MonitoredStoreService(db as never, {} as never);

    await expect(store.findWorkIdByMatchedBook(42, { id: 5, isSuperuser: true } as RequestUser)).resolves.toBe('monitor-1:hardcover:1');

    const query = new PgDialect().sqlToQuery(builder.where.mock.calls[0]?.[0] as SQL);
    expect(query.sql).toContain('"monitored_authors"."owner_user_id" = $1');
    expect(query.sql).toContain('"author_catalog_works"."matched_book_id" = $2');
    expect(query.sql).toContain('"author_catalog_works"."matched_ebook_book_id" = $3');
    expect(query.sql).toContain('"author_catalog_works"."matched_audio_book_id" = $4');
    expect(query.params).toEqual([5, 42, 42, 42]);
    expect(builder.limit).toHaveBeenCalledWith(1);
  });

  it('returns null when nothing of the viewer matches the book', async () => {
    const { db } = lookupDb([]);
    const store = new MonitoredStoreService(db as never, {} as never);

    await expect(store.findWorkIdByMatchedBook(42, { id: 5, isSuperuser: false } as RequestUser)).resolves.toBeNull();
  });
});

describe('MonitoredStoreService catalog search', () => {
  function searchSelectDb(results: unknown[][]) {
    const builders: Array<Record<string, ReturnType<typeof vi.fn>>> = [];
    const queue = [...results];
    const select = vi.fn(() => {
      const rows = queue.shift() ?? [];
      const builder = {} as Record<string, ReturnType<typeof vi.fn>>;
      for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'offset']) {
        builder[method] = vi.fn(() => builder);
      }
      builder.then = vi.fn((resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve));
      builder.getSQL = vi.fn(() => sql`(select author subquery)`);
      builders.push(builder);
      return builder;
    });
    return { db: { select }, builders };
  }

  // The first select is the matching-author subquery, which is embedded in the work search condition and never awaited.
  const owner = { id: 5, isSuperuser: false } as RequestUser;
  const libraries = { findAccessibleLibraryIds: vi.fn().mockResolvedValue([2, 3]) };

  it('scopes the search to the caller and reuses the shared active-work visibility, limiting in SQL', async () => {
    const { db, builders } = searchSelectDb([[], []]);
    const store = new MonitoredStoreService(db as never, libraries as never);

    await expect(store.searchCatalogWorks(owner, 'mist', 3)).resolves.toEqual([]);

    const query = new PgDialect().sqlToQuery(builders[1]?.where.mock.calls[0]?.[0] as SQL);
    expect(query.sql).toContain('"monitored_authors"."owner_user_id" = $1');
    expect(query.sql).toContain(`"monitored_author_works"."user_visibility" = 'hidden'`);
    expect(query.sql).toContain('"monitored_author_works"."user_kind"');
    expect(query.sql).toContain('"author_catalog_works"."verdict"');
    expect(query.sql).toContain('"monitored_author_works"."monitor_state"');
    expect(query.sql).toContain('"monitored_authors"."paused" <>');
    expect(query.sql).not.toContain('"monitored_author_works"."user_visibility" is null');
    expect(builders[1]?.limit).toHaveBeenCalledWith(3);
  });

  it('reads ownership through the viewer-derived condition, so a work held only in an inaccessible library is not owned', async () => {
    const { db, builders } = searchSelectDb([[], []]);
    const store = new MonitoredStoreService(db as never, libraries as never);

    await store.searchCatalogWorks(owner, 'mist', 3);

    expect(libraries.findAccessibleLibraryIds).toHaveBeenCalledWith(owner);
    const query = new PgDialect().sqlToQuery(builders[1]?.where.mock.calls[0]?.[0] as SQL);
    expect(query.sql).not.toContain('"author_catalog_works"."owned_formats" = \'[]\'::jsonb');
    // The same per-format, per-library ownership arms the watchlist page reads, negated per format and OR-joined.
    expect(query.sql).toContain('not (');
    expect(query.sql).toContain('"author_catalog_works"."owned_formats" @>');
    expect(query.sql).toContain('"books"."library_id" in (');
    expect(query.sql).toContain('"book_requests"."status" = \'available\'');
    expect(query.params).toContain(2);
    expect(query.params).toContain(3);
  });

  it('puts title or series prefix matches first, then each series in reading order', async () => {
    const { db, builders } = searchSelectDb([[], []]);
    const store = new MonitoredStoreService(db as never, libraries as never);

    await store.searchCatalogWorks(owner, 'mist', 3);

    const [prefixTier, series, index, title, id] = (builders[1]?.orderBy.mock.calls[0] as SQL[]).map((part) => new PgDialect().sqlToQuery(part).sql);
    expect(prefixTier).toContain('case when');
    expect(prefixTier).toContain('"author_catalog_works"."title"');
    expect(prefixTier).toContain('"author_catalog_works"."series_name"');
    expect(prefixTier).toContain("'^(the|an|a)[[:space:]]+'");
    expect(series).toMatch(/coalesce\(.*"series_name".*"title"/);
    expect(index).toContain('"author_catalog_works"."series_index"::numeric');
    expect(title).toContain('"author_catalog_works"."title"');
    expect(id).toContain('"author_catalog_works"."id"');
  });

  it('composes found rows through the shared work mapper and returns search hits with author modes', async () => {
    const work = workRow({
      id: 'monitor-1:hardcover:7',
      title: 'Mistborn',
      matchedBookId: null,
      matchedEbookBookId: null,
      matchedAudioBookId: null,
      ownedFormats: [],
    });
    const { db } = searchSelectDb([[], [{ work, authorName: 'Brandon Sanderson', ebookMode: 'auto-all', audiobookMode: 'off' }], [], [], []]);
    const store = new MonitoredStoreService(db as never, {} as never);

    const hits = await store.searchCatalogWorks({ id: 5, isSuperuser: true } as RequestUser, 'mist', 3);

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      monitorAuthorId: 'monitor-1',
      authorName: 'Brandon Sanderson',
      authorModes: { ebook: 'auto-all', audiobook: 'off' },
      work: { id: 'monitor-1:hardcover:7', title: 'Mistborn', ownedFormats: [], matchedBookId: null, requestIds: {} },
    });
  });

  it('matches followed authors through a scoped subquery on the works table, never by the joined author name or a capped id list', async () => {
    const { db, builders } = searchSelectDb([[], []]);
    const store = new MonitoredStoreService(db as never, libraries as never);

    await store.searchCatalogWorks(owner, 'sanderson', 3);

    expect(db.select).toHaveBeenCalledTimes(2);
    const authorLookup = new PgDialect().sqlToQuery(builders[0]?.where.mock.calls[0]?.[0] as SQL);
    expect(authorLookup.sql).toContain('"monitored_authors"."owner_user_id" = $1');
    expect(authorLookup.sql).toContain('"monitored_authors"."author_name"');
    expect(builders[0]?.limit).not.toHaveBeenCalled();
    const search = new PgDialect().sqlToQuery(builders[1]?.where.mock.calls[0]?.[0] as SQL);
    expect(search.sql).toContain('"author_catalog_works"."monitor_author_id" = any(array(((select author subquery))))');
    expect(search.sql).not.toContain('"monitored_authors"."author_name"');
  });

  it('returns nothing for a blank query', async () => {
    const { db } = searchSelectDb([[]]);
    const store = new MonitoredStoreService(db as never, libraries as never);

    await expect(store.searchCatalogWorks(owner, '   ', 3)).resolves.toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  describe('searchWorks', () => {
    it('returns an empty page without querying for a blank term', async () => {
      const { db } = searchSelectDb([]);
      const store = new MonitoredStoreService(db as never, libraries as never);

      await expect(store.searchWorks({ viewer: owner, q: '   ', page: 2, size: 10 })).resolves.toEqual({ items: [], total: 0, page: 2, size: 10 });
      expect(db.select).not.toHaveBeenCalled();
    });

    it('does not exclude owned works, keeps the shared visibility, and matches authors without a cap', async () => {
      const { db, builders } = searchSelectDb([[], [], [{ total: 0 }]]);
      const store = new MonitoredStoreService(db as never, libraries as never);

      await store.searchWorks({ viewer: owner, q: 'sanderson', page: 0, size: 50 });

      expect(builders[0]?.limit).not.toHaveBeenCalled();
      const query = new PgDialect().sqlToQuery(builders[1]?.where.mock.calls[0]?.[0] as SQL);
      expect(query.sql).toContain('"monitored_authors"."owner_user_id" = $1');
      expect(query.sql).toContain('"author_catalog_works"."monitor_author_id" = any(array(');
      expect(query.sql).toContain('"monitored_author_works"."user_visibility" = \'hidden\'');
      expect(query.sql).not.toContain('not (');
      expect(query.sql).not.toContain('"author_catalog_works"."owned_formats" @>');
      expect(libraries.findAccessibleLibraryIds).not.toHaveBeenCalledWith(owner);
    });

    it('pages in SQL with a stable series-aware order and counts with the same condition', async () => {
      const { db, builders } = searchSelectDb([[], [], [{ total: 120 }]]);
      const store = new MonitoredStoreService(db as never, libraries as never);

      const page = await store.searchWorks({ viewer: owner, q: 'mist', page: 2, size: 25 });

      expect(page).toEqual({ items: [], total: 120, page: 2, size: 25 });
      expect(builders[1]?.limit).toHaveBeenCalledWith(25);
      expect(builders[1]?.offset).toHaveBeenCalledWith(50);
      const order = (builders[1]?.orderBy.mock.calls[0] as SQL[]).map((part) => new PgDialect().sqlToQuery(part).sql);
      expect(order).toHaveLength(5);
      expect(order[2]).toContain('"author_catalog_works"."series_index"::numeric');
      expect(order[4]).toContain('"author_catalog_works"."id"');
      expect(builders[2]?.where.mock.calls[0]?.[0]).toBe(builders[1]?.where.mock.calls[0]?.[0]);
    });

    it('returns owned works with their owner and refresh time for the service to map', async () => {
      const work = workRow({
        id: 'monitor-1:hardcover:7',
        title: 'Mistborn',
        matchedBookId: 11,
        matchedEbookBookId: 11,
        matchedAudioBookId: null,
        ownedFormats: ['ebook'],
      });
      const refreshed = new Date('2026-09-01T10:00:00.000Z');
      const { db } = searchSelectDb([
        [],
        [{ work, authorName: 'Brandon Sanderson', ownerUserId: 5, lastRefreshedAt: refreshed, ebookMode: 'auto-all', audiobookMode: 'off' }],
        [{ total: 1 }],
        [],
        [],
        [],
      ]);
      const store = new MonitoredStoreService(db as never, libraries as never);

      const page = await store.searchWorks({ viewer: owner, q: 'mist', page: 0, size: 50 });

      expect(page.total).toBe(1);
      expect(page.items[0]).toMatchObject({
        monitorAuthorId: 'monitor-1',
        authorName: 'Brandon Sanderson',
        authorModes: { ebook: 'auto-all', audiobook: 'off' },
        ownerUserId: 5,
        authorLastRefreshedAt: '2026-09-01T10:00:00.000Z',
        work: { id: 'monitor-1:hardcover:7' },
      });
    });
  });
});

describe('MonitoredStoreService hardcover dedupe lookups', () => {
  const setDb = (rows: unknown[]) => {
    const builder = {} as Record<string, ReturnType<typeof vi.fn>>;
    for (const method of ['from', 'innerJoin', 'leftJoin', 'where']) builder[method] = vi.fn(() => builder);
    builder.then = vi.fn((resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve));
    return { db: { select: vi.fn(() => builder) }, builder };
  };

  const libraries = { findAccessibleLibraryIds: vi.fn().mockResolvedValue([2, 3]) };

  it('resolves the accessible library ids for a viewer, null for a superuser who reaches every library', async () => {
    const store = new MonitoredStoreService({} as never, libraries as never);

    await expect(store.accessibleLibraryIds({ id: 5, isSuperuser: false } as RequestUser)).resolves.toEqual([2, 3]);
    await expect(store.accessibleLibraryIds({ id: 9, isSuperuser: true } as RequestUser)).resolves.toBeNull();

    expect(libraries.findAccessibleLibraryIds).toHaveBeenCalledWith({ id: 5, isSuperuser: false });
  });

  it('reads library slugs through the accessible-library scope', async () => {
    const { db, builder } = setDb([{ hardcoverId: 'owned-slug' }]);
    const store = new MonitoredStoreService(db as never, libraries as never);

    await expect(store.findLibraryHardcoverIds([2, 3], ['owned-slug', 'fresh-slug'])).resolves.toEqual(new Set(['owned-slug']));

    const query = new PgDialect().sqlToQuery(builder.where.mock.calls[0]?.[0] as SQL);
    expect(query.sql).toContain('"book_metadata"."hardcover_id" in ($1, $2)');
    expect(query.sql).toContain('"books"."library_id" in ($3, $4)');
    expect(query.params.slice(0, 4)).toEqual(['owned-slug', 'fresh-slug', 2, 3]);
  });

  it('skips the library slug read for a superuser, who can reach every library', async () => {
    const { db, builder } = setDb([{ hardcoverId: 'owned-slug' }]);
    const store = new MonitoredStoreService(db as never, libraries as never);

    await store.findLibraryHardcoverIds(null, ['owned-slug']);

    const query = new PgDialect().sqlToQuery(builder.where.mock.calls[0]?.[0] as SQL);
    expect(query.sql).not.toContain('"books"."library_id"');
  });

  it('answers every library lookup without a query when the viewer can reach no library', async () => {
    const db = { select: vi.fn(), selectDistinct: vi.fn() };
    const store = new MonitoredStoreService(db as never, libraries as never);

    await expect(store.findLibraryHardcoverIds([], ['owned-slug'])).resolves.toEqual(new Set());
    await expect(store.findLibraryTitleAuthorKeys([], ['thefinalempire'])).resolves.toEqual(new Set());
    await expect(store.findLocalAuthorNameKeys([], ['Brandon Sanderson'])).resolves.toEqual(new Set());

    expect(db.select).not.toHaveBeenCalled();
    expect(db.selectDistinct).not.toHaveBeenCalled();
  });

  it('reads catalog slugs from the caller scoped hardcover source works', async () => {
    const { db, builder } = setDb([{ providerWorkId: 'watched-slug' }]);
    const store = new MonitoredStoreService(db as never, {} as never);

    await expect(store.findCatalogHardcoverIds({ id: 5, isSuperuser: false } as RequestUser, ['watched-slug'])).resolves.toEqual(
      new Set(['watched-slug']),
    );

    const query = new PgDialect().sqlToQuery(builder.where.mock.calls[0]?.[0] as SQL);
    expect(query.sql).toContain('"author_catalog_source_works"."source" = $');
    expect(query.sql).toContain('"monitored_authors"."owner_user_id" = $');
    // The same active-work visibility the watchlist itself reads, so the two never disagree.
    expect(builder.leftJoin).toHaveBeenCalled();
    expect(query.sql).toContain('"monitored_author_works"."user_visibility"');
    expect(query.sql).toContain('"monitored_author_works"."user_kind"');
    expect(query.sql).toContain('"monitored_author_works"."monitor_state"');
  });

  it('answers a punctuation-only title list with an empty set and runs no query', async () => {
    const db = { select: vi.fn(), selectDistinct: vi.fn() };
    const store = new MonitoredStoreService(db as never, libraries as never);
    const viewer = { id: 5, isSuperuser: false } as RequestUser;

    await expect(store.findLibraryTitleAuthorKeys([2, 3], ['?', '   '])).resolves.toEqual(new Set());
    await expect(store.findCatalogTitleAuthorKeys(viewer, ['…', '!!!'])).resolves.toEqual(new Set());
    await expect(store.findLocalAuthorNameKeys([2, 3], ['?'])).resolves.toEqual(new Set());

    expect(db.select).not.toHaveBeenCalled();
    expect(db.selectDistinct).not.toHaveBeenCalled();
  });

  it('prefilters each title by its longest run wrapped in % wildcards', async () => {
    const { db, builder } = setDb([]);
    const store = new MonitoredStoreService(db as never, libraries as never);
    const viewer = { id: 5, isSuperuser: false } as RequestUser;

    await store.findLibraryTitleAuthorKeys([2, 3], ["Ender's Game", 'Spider-Man']);
    await store.findCatalogTitleAuthorKeys(viewer, ["Ender's Game"]);

    const libraryQuery = new PgDialect().sqlToQuery(builder.where.mock.calls[0]?.[0] as SQL);
    expect(libraryQuery.sql).toContain('ILIKE');
    expect(libraryQuery.params).toContain('%ender%');
    expect(libraryQuery.params).toContain('%spider%');
    const catalogQuery = new PgDialect().sqlToQuery(builder.where.mock.calls[1]?.[0] as SQL);
    expect(catalogQuery.sql).toContain('ILIKE');
    expect(catalogQuery.params).toContain('%ender%');
  });

  it('folds library title keys against every listed author of each book', async () => {
    const rows = [
      { bookId: 1, title: 'Good Omens', authorName: 'Neil Gaiman', displayOrder: 1, authorId: 11 },
      { bookId: 1, title: 'Good Omens', authorName: 'Terry Pratchett', displayOrder: 0, authorId: 12 },
    ];
    const { db } = setDb(rows);
    const store = new MonitoredStoreService(db as never, libraries as never);

    const keys = await store.findLibraryTitleAuthorKeys([2, 3], ['goodomens']);

    expect(keys).toEqual(new Set(['goodomens|neilgaiman', 'goodomens|terrypratchett']));
  });

  it('folds catalog title keys against the monitor author name, scoped to the caller', async () => {
    const { db, builder } = setDb([{ title: 'The Final Empire', authorName: 'Brandon Sanderson' }]);
    const store = new MonitoredStoreService(db as never, {} as never);

    const keys = await store.findCatalogTitleAuthorKeys({ id: 5, isSuperuser: false } as RequestUser, ['thefinalempire']);

    expect(keys).toEqual(new Set(['thefinalempire|brandonsanderson']));
    const query = new PgDialect().sqlToQuery(builder.where.mock.calls[0]?.[0] as SQL);
    expect(query.sql).toContain('"monitored_authors"."owner_user_id" = $');
    expect(builder.leftJoin).toHaveBeenCalled();
    expect(query.sql).toContain('"monitored_author_works"."user_visibility"');
    expect(query.sql).toContain('"monitored_author_works"."monitor_state"');
  });

  it('reads monitored hardcover provider ids scoped to the caller', async () => {
    const { db, builder } = setDb([{ providerId: '12345' }]);
    const store = new MonitoredStoreService(db as never, {} as never);

    await expect(store.findMonitoredHardcoverProviderIds({ id: 5, isSuperuser: false } as RequestUser, ['12345'])).resolves.toEqual(
      new Set(['12345']),
    );

    const query = new PgDialect().sqlToQuery(builder.where.mock.calls[0]?.[0] as SQL);
    expect(query.sql).toContain('"author_provider_identities"."source" = $');
    expect(query.sql).toContain('"monitored_authors"."owner_user_id" = $');
  });

  describe('local author name keys', () => {
    const distinctDb = (rows: unknown[]) => {
      const builder = {} as Record<string, ReturnType<typeof vi.fn>>;
      for (const method of ['from', 'innerJoin', 'where']) builder[method] = vi.fn(() => builder);
      builder.then = vi.fn((resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve));
      return { db: { selectDistinct: vi.fn(() => builder) }, builder };
    };

    it('reads the whole candidate list through the accessible-library scope in one query', async () => {
      const { db, builder } = distinctDb([{ name: 'Brandon Sanderson' }]);
      const store = new MonitoredStoreService(db as never, libraries as never);

      await expect(store.findLocalAuthorNameKeys([2, 3], ['Brandon Sanderson', 'Sandé Brandt'])).resolves.toEqual(new Set(['brandonsanderson']));

      const query = new PgDialect().sqlToQuery(builder.where.mock.calls[0]?.[0] as SQL);
      expect(query.sql).toContain('ILIKE');
      expect(query.sql).toContain('"books"."library_id" in ($');
      expect(db.selectDistinct).toHaveBeenCalledTimes(1);
    });

    it('skips the library scope for a superuser, who can reach every library', async () => {
      const { db, builder } = distinctDb([{ name: 'Brandon Sanderson' }]);
      const store = new MonitoredStoreService(db as never, libraries as never);

      await store.findLocalAuthorNameKeys(null, ['Brandon Sanderson']);

      const query = new PgDialect().sqlToQuery(builder.where.mock.calls[0]?.[0] as SQL);
      expect(query.sql).not.toContain('"books"."library_id"');
    });

    it('keeps only the requested keys even when the prefilter widens the scan', async () => {
      const { db } = distinctDb([{ name: 'Other Author' }, { name: 'BRANDON SANDERSON' }]);
      const store = new MonitoredStoreService(db as never, libraries as never);

      await expect(store.findLocalAuthorNameKeys([2, 3], ['Brandon Sanderson'])).resolves.toEqual(new Set(['brandonsanderson']));
    });

    it('never matches a name that folds to an empty key', async () => {
      const { db } = distinctDb([]);
      const store = new MonitoredStoreService(db as never, libraries as never);

      await expect(store.findLocalAuthorNameKeys([2, 3], ['...'])).resolves.toEqual(new Set());
      expect(db.selectDistinct).not.toHaveBeenCalled();
    });
  });
});

describe('MonitoredStoreService.countWorkClasses', () => {
  function countDb(rows: unknown[]) {
    const builder = {} as Record<string, ReturnType<typeof vi.fn>>;
    for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'groupBy']) builder[method] = vi.fn(() => builder);
    builder.then = vi.fn((resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve));
    return { db: { select: vi.fn(() => builder) }, builder };
  }

  it('folds grouped rows into the display class counts', async () => {
    const { db } = countDb([
      { classKey: 'hidden', unconfirmed: false, total: 2 },
      { classKey: 'placeholder', unconfirmed: false, total: 3 },
      { classKey: 'book', unconfirmed: false, total: 10 },
      { classKey: 'collection', unconfirmed: true, total: 4 },
      { classKey: 'unconfirmed', unconfirmed: true, total: 5 },
    ]);
    const store = new MonitoredStoreService(db as never, {} as never);

    const counts = await store.countWorkClasses({ id: 1, isSuperuser: false } as RequestUser);

    expect(counts).toMatchObject({ hidden: 2, placeholder: 3, unconfirmed: 9 });
    expect(counts.kinds.book).toBe(10);
    expect(counts.kinds.collection).toBe(4);
    expect(counts.kinds.anthology).toBe(0);
    expect(Object.values(counts.kinds).reduce((sum, value) => sum + value, 0)).toBe(14);
  });

  it('scopes to the viewer owner id and groups in one statement', async () => {
    const { db, builder } = countDb([]);
    const store = new MonitoredStoreService(db as never, {} as never);

    await store.countWorkClasses({ id: 42, isSuperuser: true } as RequestUser);

    expect(db.select).toHaveBeenCalledTimes(1);
    expect(builder.groupBy).toHaveBeenCalledTimes(1);
    const query = new PgDialect().sqlToQuery(builder.where.mock.calls[0]?.[0] as SQL);
    expect(query.sql).toContain('"monitored_authors"."owner_user_id" = $1');
    expect(query.params[0]).toBe(42);
  });
});

describe('MonitoredStoreService fetch transitions', () => {
  function fetchDb(rows: unknown[]) {
    const builder = {} as Record<string, ReturnType<typeof vi.fn>>;
    for (const method of ['set', 'where', 'values', 'onConflictDoUpdate', 'orderBy', 'from']) builder[method] = vi.fn(() => builder);
    builder.returning = vi.fn().mockResolvedValue(rows);
    builder.limit = vi.fn().mockResolvedValue(rows);
    builder.then = vi.fn((resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve));
    const db = { update: vi.fn(() => builder), insert: vi.fn(() => builder), select: vi.fn(() => builder), transaction: vi.fn() };
    db.transaction.mockImplementation((run) => run(db));
    return { db, builder, store: new MonitoredStoreService(db as never, {} as never) };
  }

  it.each([
    [[{ id: 'm' }], true],
    [[], false],
  ] as const)('conditionally queues and claims with affected rows %j', async (rows, expected) => {
    const { store, builder } = fetchDb([...rows]);
    await expect(store.markFetchQueued('m')).resolves.toBe(expected);
    const queued = new PgDialect().sqlToQuery(builder.where.mock.calls[0][0]);
    expect(queued.sql).toContain('"monitored_authors"."fetch_state" in');
    expect(queued.params).toEqual(['m', 'idle', 'failed']);
    expect(builder.set.mock.calls[0][0]).toEqual({ fetchState: 'queued', fetchErrorKind: null, fetchErrorAt: null, fetchRetryAt: null });
    await expect(store.claimFetch('m')).resolves.toBe(expected);
    expect(new PgDialect().sqlToQuery(builder.where.mock.calls[1][0]).params).toEqual(['m', 'queued']);
  });

  it.each([[{ id: 'm' }], []])('releases only a fetching row without changing other fields: %j', async (...rows) => {
    const { store, builder } = fetchDb(rows);
    await expect(store.releaseFetch('m')).resolves.toBe(rows.length > 0);
    expect(builder.set.mock.calls[0][0]).toEqual({ fetchState: 'idle' });
    expect(new PgDialect().sqlToQuery(builder.where.mock.calls[0][0]).params).toEqual(['m', 'fetching']);
  });

  it('fails only a fetching row without changing the success stamp and saturates attempts', async () => {
    const { store, builder } = fetchDb([]);
    await expect(store.finishFetchFailed('m', { kind: 'timeout', at: '2026-10-20T00:00:00Z', retryAt: null, attempts: 9 })).resolves.toBe(false);
    expect(builder.set.mock.calls[0][0]).toMatchObject({ fetchState: 'failed', fetchAttempts: 3 });
    expect(builder.set.mock.calls[0][0]).not.toHaveProperty('lastRefreshedAt');
    expect(new PgDialect().sqlToQuery(builder.where.mock.calls[0][0]).params).toEqual(['m', 'fetching']);
  });

  it('finishes successfully in one transaction and clears failure fields', async () => {
    const { store, db, builder } = fetchDb([{ id: 'm' }]);
    const lastRefreshedAt = '2026-10-20T00:00:00Z';
    await expect(store.finishFetchSucceeded('m', { lastRefreshedAt, hardcoverAuthorId: '42', localAuthorId: 7 })).resolves.toBe(true);
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(builder.set.mock.calls[0][0]).toMatchObject({
      fetchState: 'idle',
      fetchErrorKind: null,
      fetchErrorAt: null,
      fetchRetryAt: null,
      fetchAttempts: 0,
      lastRefreshedAt: new Date(lastRefreshedAt),
      localAuthorId: 7,
    });
    expect(builder.values).toHaveBeenCalledWith({ monitorAuthorId: 'm', source: 'hardcover', providerId: '42' });
  });

  it('keeps the stored local author link when success resolves none', async () => {
    const { store, builder } = fetchDb([{ id: 'm' }]);
    await store.finishFetchSucceeded('m', { lastRefreshedAt: '2026-10-20T00:00:00Z', hardcoverAuthorId: null, localAuthorId: null });
    expect(builder.set.mock.calls[0][0]).not.toHaveProperty('localAuthorId');
  });

  it('does not write an identity when success loses the conditional update', async () => {
    const { store, db } = fetchDb([]);
    await expect(
      store.finishFetchSucceeded('m', { lastRefreshedAt: '2026-10-20T00:00:00Z', hardcoverAuthorId: '42', localAuthorId: null }),
    ).resolves.toBe(false);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('resets interrupted rows and pages queued rows by added time and id', async () => {
    const { store, builder } = fetchDb([{ id: 'm', addedAt: new Date('2026-10-20T00:00:00Z') }]);
    await expect(store.resetInterruptedFetches()).resolves.toBe(1);
    await expect(store.findQueuedFetches({ addedAt: '2026-10-19T00:00:00Z', id: 'a' }, 100)).resolves.toEqual([
      { id: 'm', addedAt: '2026-10-20T00:00:00.000Z' },
    ]);
    const query = new PgDialect().sqlToQuery(builder.where.mock.calls[1][0]);
    expect(query.sql).toContain('("monitored_authors"."added_at", "monitored_authors"."id") >');
    expect(builder.limit).toHaveBeenCalledWith(100);
  });

  it('selects only failed rows with pending retry timestamps', async () => {
    const { store, builder } = fetchDb([{ id: 'm', retryAt: new Date('2026-10-20T00:00:00Z') }]);
    await expect(store.findPendingRetries()).resolves.toEqual([{ id: 'm', retryAt: '2026-10-20T00:00:00.000Z' }]);
    expect(rendered(builder.where.mock.calls[0][0])).toContain('"monitored_authors"."fetch_retry_at" is not null');
  });
});

describe('MonitoredStoreService fetch composition', () => {
  const input = {
    ownerUserId: 1,
    authorName: 'Author',
    localAuthorId: null,
    providerIds: {},
    formats: {
      ebook: { mode: 'notify' as const, libraryId: null, folderId: null },
      audiobook: { mode: 'off' as const, libraryId: null, folderId: null },
    },
    paused: false,
    addedAt: '2026-10-20T00:00:00Z',
    lastRefreshedAt: null,
  };

  it('returns the inserted fetch state from upsertAuthor', async () => {
    const tx = { insert: vi.fn(), delete: vi.fn() };
    tx.insert.mockReturnValue({ values: vi.fn(() => ({ onConflictDoUpdate: vi.fn() })) });
    tx.delete.mockReturnValue({ where: vi.fn() });
    const db = { transaction: vi.fn((run) => run(tx)) };
    const store = new MonitoredStoreService(db as never, {} as never);
    await expect(store.upsertAuthor({ ...input, fetchState: 'queued' })).resolves.toMatchObject({
      fetch: { state: 'queued', errorKind: null, errorAt: null, retryAt: null },
    });
    await expect(store.upsertAuthor(input)).resolves.toMatchObject({ fetch: { state: 'idle' } });
  });

  it('composes fetch status and keeps attempts internal to getMonitorForFetch', async () => {
    const at = new Date('2026-10-20T00:00:00Z');
    const row = {
      ...input,
      id: 'm',
      addedAt: at,
      ebookMode: 'notify',
      audiobookMode: 'off',
      fetchState: 'failed',
      fetchErrorKind: 'timeout',
      fetchErrorAt: at,
      fetchRetryAt: at,
      fetchAttempts: 2,
    };
    const queue = [[row], [], [row], []];
    const db = {
      select: vi.fn(() => {
        const rows = queue.shift()!;
        const builder = {
          from: vi.fn(),
          where: vi.fn(),
          limit: vi.fn().mockResolvedValue(rows),
          then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
        };
        builder.from.mockReturnValue(builder);
        builder.where.mockReturnValue(builder);
        return builder;
      }),
    };
    const store = new MonitoredStoreService(db as never, {} as never);
    await expect(store.getAuthor('m')).resolves.toMatchObject({
      fetch: { state: 'failed', errorKind: 'timeout', errorAt: at.toISOString(), retryAt: at.toISOString() },
    });
    await expect(store.getMonitorForFetch('m')).resolves.toMatchObject({ fetchAttempts: 2, ownerUserId: 1 });
  });
});

describe('MonitoredStoreService automatic fetch eligibility SQL', () => {
  it('uses the same retry and interval predicate for selection and count', async () => {
    const conditions: SQL[] = [];
    const builder = {
      from: vi.fn(),
      where: vi.fn((condition: SQL) => {
        conditions.push(condition);
        return builder;
      }),
      orderBy: vi.fn(),
      limit: vi.fn().mockResolvedValue([]),
      then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([{ total: 0 }]).then(resolve),
    };
    builder.from.mockReturnValue(builder);
    builder.orderBy.mockReturnValue(builder);
    const store = new MonitoredStoreService({ select: vi.fn(() => builder) } as never, {} as never);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
      const stale = new Date('2026-10-20T11:00:00Z');
      await store.findMonitorsDueForSync(stale, 100);
      await store.countMonitorsDueForSync(stale);
      const queries = conditions.map((condition) => new PgDialect().sqlToQuery(condition));
      expect(queries[0]).toEqual(queries[1]);
      const { sql, params } = queries[0];
      expect(sql).toContain('"monitored_authors"."paused"');
      expect(sql).toContain('"monitored_authors"."ebook_mode"');
      expect(sql).toContain('"monitored_authors"."audiobook_mode"');
      expect(sql).toContain('"monitored_authors"."fetch_state"');
      expect(sql).toContain('"monitored_authors"."fetch_error_kind" is null');
      expect(sql).toContain('"monitored_authors"."fetch_error_kind" not in');
      expect(sql).toContain('"monitored_authors"."fetch_retry_at" <=');
      expect(sql).toContain('"monitored_authors"."fetch_retry_at" is null');
      expect(sql).toContain('greatest(');
      expect(params).toContain('idle');
      expect(params).toContain('failed');
      expect(params).not.toContain('queued');
      expect(params).not.toContain('fetching');
      for (const kind of ['auth_failed', 'author_gone', 'not_configured']) expect(params).toContain(kind);
      expect(params).toContain('2026-10-20T12:00:00.000Z');
      expect(params).toContainEqual(stale);
    } finally {
      vi.useRealTimers();
    }
  });
});
