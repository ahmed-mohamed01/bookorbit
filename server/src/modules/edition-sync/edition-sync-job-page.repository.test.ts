import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { ContentFilterRules } from '@bookorbit/types';

import { EditionSyncJobPageRepository, type EditionSyncJobPageQuery } from './edition-sync-job-page.repository';

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
    expect(sql).toContain('row_number() OVER (ORDER BY i.pinned_at ASC, i.book_id DESC)');
    expect(sql).toContain(
      "WHERE (i.status = 'running' OR i.pinned_at IS NOT NULL) AND (i.status = 'running' OR lane.book_id IS NOT NULL) AND b.library_id IN ($",
    );
    expect(sql).toContain('ORDER BY q.grp asc, q.rank asc, q.at asc, q."bookId" asc');
    expect(sql).not.toContain('EXISTS (SELECT 1 FROM books WHERE books.id = b.id');
    expect(params).toEqual(expect.arrayContaining([5, 6, 51]));
  });

  it('ranks only pinned books in the viewer library and content scope before building the cursor key', async () => {
    const { repository, execute } = setup();
    await repository.pageForJobs(query({ contentFilters: FILTERS }));
    const { sql } = rendered(execute);
    const lane = sql.split('lane AS (')[1]!.split('), q AS (')[0]!;
    expect(lane).toContain('row_number() OVER (ORDER BY i.pinned_at ASC, i.book_id DESC)');
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
    execute.mockClear();
    expect(await repository.pageForJobs(query({ view: 'failed', runningOnly: true }))).toEqual([]);
    expect(await repository.pageForJobs(query({ view: 'history', runningOnly: true }))).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('reads nothing for a viewer with no libraries, or for Needs you', async () => {
    const { repository, execute } = setup();
    expect(await repository.pageForJobs(query({ libraryIds: [] }))).toEqual([]);
    expect(await repository.pageForJobs(query({ view: 'needs-you' }))).toEqual([]);
    expect(await repository.countForJobs({ libraryIds: [], contentFilters: null, runningOnly: false }, CUTOFF)).toEqual({
      running: 0,
      pinned: 0,
      failed: 0,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('pages after the cursor in the queue order', async () => {
    const { repository, execute } = setup();
    await repository.pageForJobs(query({ after: { prefix: [1, 3], suffix: [1700000000000000], id: 42, typeIndex: 13 } }));
    const { sql, params } = rendered(execute);
    expect(sql).toContain('q.grp > $');
    expect(sql).toContain('q."bookId" > $');
    expect(params).toEqual(expect.arrayContaining([1, 3, 1700000000000000, 42]));
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
    expect(await repository.countForJobs({ libraryIds: [5], contentFilters: null, runningOnly: false }, CUTOFF)).toEqual({
      running: 1,
      pinned: 2,
      failed: 3,
    });
    const { sql } = rendered(execute);
    expect(sql).toContain("WHERE (i.status IN ('running', 'failed') OR i.pinned_at IS NOT NULL) AND b.library_id IN ($");
    expect(sql).toContain('i.pinned_at IS NOT NULL AND (i.book_id IS NULL OR');
  });

  it('counts only the running build for a viewer who only manages the server', async () => {
    const { repository, execute } = setup([{ running: 1, pinned: 0, failed: 0 }]);
    await repository.countForJobs({ libraryIds: null, contentFilters: null, runningOnly: true }, CUTOFF);
    expect(rendered(execute).sql).toContain('count(*) FILTER (WHERE false)::int AS "pinned"');
  });

  it('counts the backlog as the queue without pinned books', async () => {
    const { repository, execute } = setup([{ count: 120 }]);
    expect(await repository.countBacklog({ libraryIds: [5], contentFilters: null })).toBe(120);
    const { sql } = rendered(execute);
    expect(sql).toContain('AND (i.book_id IS NULL OR i.pinned_at IS NULL) AND b.library_id IN ($');
  });

  it('reads action rows only in the viewer scope', async () => {
    const { repository, execute } = setup();
    await repository.findActionRows([3, 4], { libraryIds: [5], contentFilters: null });
    const { sql, params } = rendered(execute);
    expect(sql).toContain('WHERE i.book_id = ANY($1::integer[]) AND b.library_id IN ($');
    expect(params[0]).toEqual([3, 4]);
    execute.mockClear();
    expect(await repository.findActionRows([], { libraryIds: [5], contentFilters: null })).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
});
