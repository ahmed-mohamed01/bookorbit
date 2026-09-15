import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { RequestUser } from '../../common/types/request-user';
import { MonitoredStoreService, releaseEventKey, releaseRangeOverlapsSql, type MonitoredDueRelease } from './monitored-store.service';
import * as schema from './schema/monitored.schema';
import { authorCatalogWorks, type AuthorCatalogWorkRow } from './schema/monitored.schema';

type OverlayRow = typeof schema.monitoredAuthorWorks.$inferSelect;

function overlayRow(patch: Partial<OverlayRow> & { workId: string }): OverlayRow {
  return {
    monitorAuthorId: 'monitor-1',
    monitorState: 'monitoring',
    monitorEbook: null,
    monitorAudiobook: null,
    userVisibility: null,
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
    verdict: 'verified',
    flags: [],
    sources: ['hardcover'],
    matchedBookId: 10,
    matchedEbookBookId: 10,
    matchedAudioBookId: 20,
    ownedFormats: ['ebook', 'audiobook'],
    ...patch,
  };
}

describe('MonitoredStoreService work composition', () => {
  const store = new MonitoredStoreService({} as never, {} as never);

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
    const db = queuedSelectDb([[], overlays, requests, []]);
    const store = new MonitoredStoreService(db as never, libraries as never);

    const composed = await composeWorks(store, [shown, hidden], { id: 2, isSuperuser: false } as RequestUser);

    expect(composed.map((item) => item.work.id)).toEqual(['w-shown']);
    expect(composed[0].work.requestIds).toEqual({});
    expect(composed[0].work.requestStatuses).toEqual({});
    expect(composed[0].work).not.toHaveProperty('userVisibility');
  });

  it('keeps the whole overlay for the monitor owner', async () => {
    const db = queuedSelectDb([[], overlays, requests, [{ id: 'monitor-1' }]]);
    const store = new MonitoredStoreService(db as never, libraries as never);

    const composed = await composeWorks(store, [shown, hidden], { id: 1, isSuperuser: false } as RequestUser);

    expect(composed.map((item) => item.work.id)).toEqual(['w-shown', 'w-hidden']);
    expect(composed[0].work.requestIds).toEqual({ ebook: 17 });
    expect(composed[0].work.requestStatuses).toEqual({ ebook: 'downloading' });
    expect(composed[1].work.userVisibility).toBe('hidden');
  });

  it('keeps the whole overlay for an internal caller that passes no viewer', async () => {
    const db = queuedSelectDb([[], overlays, requests]);
    const store = new MonitoredStoreService(db as never, libraries as never);

    const composed = await composeWorks(store, [shown, hidden]);

    expect(composed.map((item) => item.work.id)).toEqual(['w-shown', 'w-hidden']);
    expect(composed[0].work.requestIds).toEqual({ ebook: 17 });
    expect(composed[0].work.requestStatuses).toEqual({ ebook: 'downloading' });
  });

  it('projects an available request match into the library-owned work state', async () => {
    const db = queuedSelectDb([[], overlays, [{ id: 17, status: 'available', matchedBookId: 30 }]]);
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
    // Same predicate on both sides, so no row can satisfy both or neither.
    expect(hidden.replace('not coalesce(', 'coalesce(')).toContain(total.slice(total.indexOf('coalesce('), total.lastIndexOf(')::int')));
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
      return Promise.resolve(compiled.sql.includes('count(*)::int') ? { rows: [{ total: 456 }] } : { rows: [] });
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
    expect(result).toEqual({ items: [], total: 456, page: 4, size: 25 });
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
  };

  const dueRelease: MonitoredDueRelease = {
    workId: 'work-1',
    title: 'Test Work',
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
