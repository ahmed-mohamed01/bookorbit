import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { ContentFilterRules } from '@bookorbit/types';

import { EditionSyncJobPageRepository, type EditionSyncJobPageQuery } from './edition-sync-job-page.repository';
import { SETTLED_PIN_SQL } from './edition-sync.repository';

const CUTOFF = new Date('2026-11-12T00:00:00.000Z');
const FILTERS: ContentFilterRules = {
  includeTagIds: [],
  includeGenreIds: [],
  excludeTagIds: [4],
  excludeGenreIds: [],
} as unknown as ContentFilterRules;

function setup(rows: unknown[] = []) {
  const execute = vi.fn<(query: SQL) => Promise<{ rows: unknown[] }>>(() => Promise.resolve({ rows }));
  const db = Object.assign(drizzle({} as never), { execute });
  return { repository: new EditionSyncJobPageRepository(db as never), execute };
}

function rendered(execute: ReturnType<typeof setup>['execute']) {
  return new PgDialect().sqlToQuery(execute.mock.calls[0]![0]);
}

function query(change: Partial<EditionSyncJobPageQuery> = {}): EditionSyncJobPageQuery {
  return {
    view: 'queue',
    libraryIds: [5, 6],
    contentFilters: null,
    runningOnly: false,
    cutoffAt: CUTOFF,
    after: null,
    typeIndex: 13,
    limit: 51,
    ...change,
  };
}

describe('EditionSyncJobPageRepository', () => {
  it('lists the running build, then pinned books in claim order, kept to the viewer libraries', async () => {
    const { repository, execute } = setup();
    await repository.pageForJobs(query());
    const { sql, params } = rendered(execute);
    expect(sql).toContain('i.pinned_at ASC NULLS LAST');
    expect(sql).toContain('CASE WHEN i.pinned_at IS NOT NULL THEN b.id END DESC');
    expect(sql).toContain("WHERE i.status = 'running' AND b.library_id IN ($");
    expect(sql).toContain('WHERE i.pinned_at IS NOT NULL');
    expect(sql).toContain('ORDER BY q.grp asc, q.rank asc, q.at asc, q."bookId" asc');
    expect(sql).not.toContain('EXISTS (SELECT 1 FROM books WHERE books.id = b.id');
    expect(params).toEqual(expect.arrayContaining([5, 6, 51]));
  });

  it('ranks only pinned books in the viewer library and content scope before building the cursor key', async () => {
    const { repository, execute } = setup();
    await repository.pageForJobs(query({ contentFilters: FILTERS }));
    const { sql } = rendered(execute);
    const lane = sql.split('UNION ALL')[1]!;
    expect(lane).toContain('row_number() OVER (ORDER BY');
    expect(lane).toContain('AND b.library_id IN ($');
    expect(lane).toContain('AND EXISTS (SELECT 1 FROM books WHERE books.id = b.id AND');
  });

  it('puts no library filter on a viewer who sees every library, and applies their content filter', async () => {
    const { repository, execute } = setup();
    await repository.pageForJobs(query({ libraryIds: null, contentFilters: FILTERS }));
    const { sql } = rendered(execute);
    expect(sql).not.toContain('b.library_id IN');
    expect(sql).toContain('AND EXISTS (SELECT 1 FROM books WHERE books.id = b.id AND');
  });

  it('keeps the Queue to the running build for a viewer who only manages the server, and shows them nothing else', async () => {
    const { repository, execute } = setup();
    await repository.pageForJobs(query({ runningOnly: true }));
    expect(rendered(execute).sql).toContain("WHERE i.status = 'running' AND b.library_id IN ($");
    expect(rendered(execute).sql).not.toContain('UNION ALL');
    execute.mockClear();
    await repository.pageForJobs(
      query({ runningOnly: true, includeBacklog: true, after: { prefix: [1, 3], suffix: [1700000000000000], id: 42, typeIndex: 13 } }),
    );
    const { sql } = rendered(execute);
    expect(sql).toContain('row_number() OVER (ORDER BY (i.pinned_at IS NOT NULL) DESC');
    expect(sql).toContain('count(*) FILTER (WHERE i.pinned_at IS NOT NULL) OVER ()');
    expect(sql).toMatch(/SELECT \* FROM q\s+WHERE \(q\."pinnedAt" IS NULL OR q\.grp = 0\)\s+AND /);
    execute.mockClear();
    expect(await repository.pageForJobs(query({ view: 'failed', runningOnly: true }))).toEqual([]);
    expect(await repository.pageForJobs(query({ view: 'history', runningOnly: true }))).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('reads nothing for a viewer with no libraries, or for Needs you', async () => {
    const { repository, execute } = setup();
    expect(await repository.pageForJobs(query({ libraryIds: [] }))).toEqual([]);
    expect(await repository.pageForJobs(query({ view: 'needs-you' }))).toEqual([]);
    expect(await repository.countForJobs({ libraryIds: [], contentFilters: null, runningOnly: false }, CUTOFF, true)).toEqual({
      running: 0,
      pinned: 0,
      failed: 0,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('pages after the last pinned book into the backlog in worker order', async () => {
    const { repository, execute } = setup();
    await repository.pageForJobs(query({ includeBacklog: true, after: { prefix: [1, 3], suffix: [1700000000000000], id: 42, typeIndex: 13 } }));
    const { sql, params } = rendered(execute);
    expect(sql).toContain('FROM eligible_files ef');
    expect(sql).toContain("r.status IN ('reading', 'rereading')");
    expect(sql).toContain('b.added_at DESC');
    expect(sql).toContain('q.grp > $');
    expect(sql).toContain('q."bookId" > $');
    expect(params).toEqual(expect.arrayContaining([1, 3, 1700000000000000, 42]));
  });

  it('uses the worker settle predicate before assigning active queue ranks', async () => {
    const { repository, execute } = setup();
    await repository.pageForJobs(query({ includeBacklog: true }));
    const { sql, params } = rendered(execute);
    const settle = new PgDialect().sqlToQuery(SETTLED_PIN_SQL);
    expect(sql.replace(/\$\d+/g, '?')).toContain(`AND ${settle.sql.replace(/\$\d+/g, '?')}`);
    expect(params).toEqual(expect.arrayContaining(settle.params));
    execute.mockClear();
    await repository.pageForJobs(query({ includeBacklog: false }));
    expect(rendered(execute).sql).not.toContain('i.files_changed_at');
  });

  it('reads Failed by when the build failed, newest first, leaving out failures already queued to retry', async () => {
    const { repository, execute } = setup();
    await repository.pageForJobs(query({ view: 'failed' }));
    const { sql, params } = rendered(execute);
    expect(sql).toContain(
      "i.status = 'failed' AND NOT i.retry_requested AND coalesce(CASE WHEN i.status = 'ready' THEN i.indexed_at ELSE i.failed_at END, i.created_at) > $",
    );
    expect(sql).toContain(
      "ORDER BY coalesce(CASE WHEN i.status = 'ready' THEN i.indexed_at ELSE i.failed_at END, i.created_at) desc, i.book_id desc",
    );
    expect(params).toContain(CUTOFF);
  });

  it('reads History as finished indexes and failures past the window', async () => {
    const { repository, execute } = setup();
    await repository.pageForJobs(query({ view: 'history' }));
    expect(rendered(execute).sql).toContain("(i.status = 'ready' OR (i.status = 'failed' AND NOT i.retry_requested AND coalesce(");
  });

  it('turns rows into keys of exact numbers', async () => {
    const { repository } = setup([
      {
        bookId: 9,
        status: 'queued',
        stage: null,
        progress: null,
        errorCode: null,
        createdAt: '2026-11-15T10:00:00.000Z',
        lastAttemptAt: null,
        pinnedAt: '2026-11-15T11:00:00.000Z',
        failedAt: null,
        indexedAt: null,
        grp: 1,
        rank: 2,
        at: '1763204400000000',
      },
    ]);
    const [row] = await repository.pageForJobs(query());
    expect(row).toMatchObject({ bookId: 9, rank: 2, key: { prefix: [1, 2], suffix: [1763204400000000], id: 9 } });
    expect(row?.pinnedAt).toEqual(new Date('2026-11-15T11:00:00.000Z'));
  });

  it('counts the running build, pinned books and recent failures in one read, with the same scope', async () => {
    const { repository, execute } = setup([{ running: 1, pinned: 2, failed: 3 }]);
    const scope = { libraryIds: [5], contentFilters: null, runningOnly: false };
    expect(await repository.countForJobs(scope, CUTOFF, true)).toEqual({
      running: 1,
      pinned: 2,
      failed: 3,
    });
    const { sql } = rendered(execute);
    expect(sql).toContain("WHERE (i.status IN ('running', 'failed') OR i.pinned_at IS NOT NULL) AND b.library_id IN ($");
    expect(sql).toContain('i.pinned_at IS NOT NULL AND (i.book_id IS NULL OR');
    expect(sql).toContain('i.files_changed_at IS NULL OR i.files_changed_at <= now() -');
    execute.mockClear();
    await repository.countForJobs(scope, CUTOFF, false);
    expect(rendered(execute).sql).not.toContain('i.files_changed_at');
  });

  it('counts only the running build for a viewer who only manages the server', async () => {
    const { repository, execute } = setup([{ running: 1, pinned: 0, failed: 0 }]);
    await repository.countForJobs({ libraryIds: null, contentFilters: null, runningOnly: true }, CUTOFF, true);
    expect(rendered(execute).sql).toContain('count(*) FILTER (WHERE false)::int AS "pinned"');
  });

  it('counts the backlog as the queue without pinned books', async () => {
    const { repository, execute } = setup([{ count: 120 }]);
    expect(await repository.countBacklog({ libraryIds: [5], contentFilters: null, runningOnly: false })).toBe(120);
    const { sql } = rendered(execute);
    expect(sql).toContain('AND (i.book_id IS NULL OR i.pinned_at IS NULL) AND b.library_id IN ($');
  });

  it('reads action rows only in the viewer scope', async () => {
    const { repository, execute } = setup();
    await repository.findActionRows([3, 4], { libraryIds: [5], contentFilters: null, runningOnly: false });
    const { sql, params } = rendered(execute);
    expect(sql).toContain('WHERE b.id = ANY(');
    expect(params).toContainEqual([3, 4]);
    execute.mockClear();
    expect(await repository.findActionRows([], { libraryIds: [5], contentFilters: null, runningOnly: false })).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
});
