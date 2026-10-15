import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { webSerialJobs } from './schema/web-serials.schema';
import { webSerialMangaVolumeOwned, webSerialRangesCover } from '@bookorbit/types';
import { WebSerialsRepository } from './web-serials.repository';

const dialect = new PgDialect();
const render = (value: unknown) => dialect.sqlToQuery(value as SQL);

function queryBuilder<T>(result: T) {
  const builder: Record<string, ReturnType<typeof vi.fn>> & { then?: Promise<T>['then'] } = {};
  for (const method of [
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'values',
    'returning',
    'set',
    'leftJoin',
    'innerJoin',
    'groupBy',
    'onConflictDoUpdate',
    'onConflictDoNothing',
  ]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return builder;
}

function mockDb(
  options: { select?: unknown[]; selectDistinct?: unknown[]; insert?: unknown[]; update?: unknown[]; delete?: unknown[]; execute?: unknown[] } = {},
) {
  const queues = {
    select: [...(options.select ?? [])],
    selectDistinct: [...(options.selectDistinct ?? [])],
    insert: [...(options.insert ?? [])],
    update: [...(options.update ?? [])],
    delete: [...(options.delete ?? [])],
    execute: [...(options.execute ?? [])],
  };
  const db = {
    select: vi.fn<(table?: unknown) => unknown>(() => queryBuilder(queues.select.shift() ?? [])),
    selectDistinct: vi.fn<(table?: unknown) => unknown>(() => queryBuilder(queues.selectDistinct.shift() ?? [])),
    insert: vi.fn<(table?: unknown) => unknown>(() => queryBuilder(queues.insert.shift() ?? [])),
    update: vi.fn<(table?: unknown) => unknown>(() => queryBuilder(queues.update.shift() ?? [])),
    delete: vi.fn<(table?: unknown) => unknown>(() => queryBuilder(queues.delete.shift() ?? [])),
    execute: vi.fn<(query: unknown) => Promise<{ rows: unknown[]; rowCount?: number }>>(() =>
      Promise.resolve((queues.execute.shift() as { rows: unknown[]; rowCount?: number } | undefined) ?? { rows: [], rowCount: 0 }),
    ),
    transaction: vi.fn(),
  };
  db.transaction.mockImplementation((fn: (tx: typeof db) => unknown) => Promise.resolve(fn(db)));
  return db;
}

const builderAt = (method: ReturnType<typeof vi.fn>, index = 0) => method.mock.results[index]!.value as ReturnType<typeof queryBuilder>;
const whereSql = (builder: ReturnType<typeof queryBuilder>) => render(builder.where!.mock.calls[0]![0]);

describe('WebSerialsRepository settings', () => {
  it('reads the singleton row', async () => {
    const row = { id: 1, mangaUrl: 'http://m' };
    const db = mockDb({ select: [[row]] });

    await expect(new WebSerialsRepository(db as never).getSettings()).resolves.toEqual(row);
    expect(whereSql(builderAt(db.select))).toMatchObject({ params: [1] });
  });

  it('upserts on the singleton id', async () => {
    const db = mockDb({ insert: [[{ id: 1 }]] });

    await new WebSerialsRepository(db as never).upsertSettings({ maxConcurrentJobs: 3 });

    const builder = builderAt(db.insert);
    expect(builder.values).toHaveBeenCalledWith({ id: 1, maxConcurrentJobs: 3 });
    expect(builder.onConflictDoUpdate!.mock.calls[0]![0].set).toMatchObject({ maxConcurrentJobs: 3 });
  });

  it('records a check only while the tested url is still the saved one', async () => {
    const db = mockDb();
    const health = { ok: true, checkedAt: 'now', version: '1', searchableSources: 3, error: null };

    await new WebSerialsRepository(db as never).recordCheck('novel', health, 'http://lncrawl');

    const conflict = builderAt(db.insert).onConflictDoUpdate!.mock.calls[0]![0];
    expect(conflict.set).toMatchObject({ novelLastCheck: health });
    expect(conflict.set).not.toHaveProperty('mangaLastCheck');
    const rendered = render(conflict.setWhere);
    expect(rendered.sql).toContain('"novel_url"');
    expect(rendered.params).toEqual(['http://lncrawl']);
  });

  it('records a check against an unset url with an is-null guard', async () => {
    const db = mockDb();

    await new WebSerialsRepository(db as never).recordCheck('manga', { ok: false } as never, null);

    expect(render(builderAt(db.insert).onConflictDoUpdate!.mock.calls[0]![0].setWhere).sql).toContain('"manga_url" is null');
  });

  it('records lookup health on the singleton row', async () => {
    const db = mockDb();
    const health = { ok: false, checkedAt: 'now', error: 'down', pausedUntil: null };

    await new WebSerialsRepository(db as never).recordLookupCheck(health);

    const builder = builderAt(db.insert);
    expect(builder.values).toHaveBeenCalledWith({ id: 1, lookupLastCheck: health });
    expect(builder.onConflictDoUpdate!.mock.calls[0]![0].set).toMatchObject({ lookupLastCheck: health });
  });
});

describe('WebSerialsRepository jobs', () => {
  it('lists only the given user with a clamped page, ranked active then queue then paused then finished', async () => {
    const db = mockDb({ select: [[{ job: { id: 7 }, libraryName: 'Manga', ownerName: 'Ann', queuePosition: 2 }]] });

    const rows = await new WebSerialsRepository(db as never).listJobs(42, 5000, -3);

    expect(rows).toEqual([{ id: 7, libraryName: 'Manga', ownerName: 'Ann', queuePosition: 2 }]);
    const builder = builderAt(db.select);
    const where = whereSql(builder);
    expect(where.sql).toContain('"web_serial_jobs"."user_id" = $1');
    expect(where.params).toEqual([42]);
    expect(builder.limit).toHaveBeenCalledWith(100);
    expect(builder.offset).toHaveBeenCalledWith(0);
    expect(builder.leftJoin).toHaveBeenCalledTimes(2);
    const order = builder.orderBy!.mock.calls[0]!.map((part) => render(part).sql).join(' | ');
    expect(order).toContain("'running', 'importing'");
    expect(order).toContain('"queue_order"');
  });

  it('lists every user when no user filter is given', async () => {
    const db = mockDb({ select: [[]] });

    await new WebSerialsRepository(db as never).listJobs(null, 10, 0);

    expect(builderAt(db.select).where).toHaveBeenCalledWith(undefined);
  });

  it('ranks a queued job by counting the queued jobs ahead of it in one correlated subquery', async () => {
    const db = mockDb({ select: [[]] });

    await new WebSerialsRepository(db as never).findJobById(5);

    const selected = (db.select.mock.calls[0] as unknown[])[0] as { queuePosition: SQL };
    const rendered = render(selected.queuePosition).sql;
    expect(rendered).toContain('count(*)');
    expect(rendered).toContain('"queue_order"');
    expect(rendered).toContain('"queue_ahead"');
  });

  it('counts paused jobs towards the per-user cap, so pausing never makes room for more', async () => {
    const db = mockDb({ select: [[{ value: 3 }]] });

    await expect(new WebSerialsRepository(db as never).countCappedJobsForUser(9)).resolves.toBe(3);
    const where = whereSql(builderAt(db.select));
    expect(where.params).toEqual([9, 'queued', 'running', 'importing', 'paused']);
  });

  it('counts the imported items that were filed with missing chapters', async () => {
    const db = mockDb({ select: [[{ value: 2 }]] });

    await expect(new WebSerialsRepository(db as never).countGappedImports(4)).resolves.toBe(2);
    expect(whereSql(builderAt(db.select)).params).toEqual([4, 'imported', 'Imported with gaps:%']);
  });

  it('counts active jobs across the instance for the admin scope', async () => {
    const db = mockDb({ select: [[{ value: 8 }]] });

    await expect(new WebSerialsRepository(db as never).countActiveJobs(null)).resolves.toBe(8);
    expect(whereSql(builderAt(db.select)).params).toEqual(['queued', 'running', 'importing']);
  });

  it('claims queued jobs in queue order', async () => {
    const db = mockDb({ select: [[{ id: 1 }]] });

    await new WebSerialsRepository(db as never).findQueuedJobs(2);

    expect(Object.keys((db.select.mock.calls[0] as unknown[])[0] as object)).toEqual(['id']);

    const order = builderAt(db.select).orderBy!.mock.calls[0]!.map((part) => render(part).sql);
    expect(order).toEqual(['"web_serial_jobs"."queue_order" asc', '"web_serial_jobs"."id" asc']);
  });

  it('reads and writes the instance-wide queue pause on the singleton row', async () => {
    const db = mockDb({ select: [[{ paused: true }]], insert: [[{ id: 1 }]] });
    const repo = new WebSerialsRepository(db as never);

    await expect(repo.getQueuePaused()).resolves.toBe(true);
    await repo.setQueuePaused(false);
    expect(builderAt(db.insert).values).toHaveBeenCalledWith({ id: 1, queuePaused: false });
  });

  it('claims a job only while it is still queued', async () => {
    const db = mockDb({ update: [[{ id: 3, status: 'running' }]] });

    await expect(new WebSerialsRepository(db as never).claimQueuedJob(3)).resolves.toEqual({ id: 3, status: 'running' });
    const builder = builderAt(db.update);
    expect(builder.set!.mock.calls[0]![0]).toMatchObject({ status: 'running' });
    const where = whereSql(builder);
    expect(where.params).toEqual([3, 'queued']);
  });

  it('returns undefined when the claim lost the race', async () => {
    const db = mockDb({ update: [[]] });

    await expect(new WebSerialsRepository(db as never).claimQueuedJob(3)).resolves.toBeUndefined();
  });

  it('cancels an active or paused job and settles its in-flight items in the same transaction', async () => {
    const db = mockDb({ update: [[{ id: 3 }], [{ id: 9 }]] });

    await expect(new WebSerialsRepository(db as never).cancelJob(3)).resolves.toEqual({ id: 3 });

    const builder = builderAt(db.update);
    expect(builder.set!.mock.calls[0]![0]).toMatchObject({ status: 'cancelled', message: null, currentUnit: null });
    expect(whereSql(builder).params).toEqual([3, 'queued', 'running', 'importing', 'paused']);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    const items = builderAt(db.update, 1);
    expect(items.set!.mock.calls[0]![0]).toMatchObject({ status: 'pending' });
    expect(whereSql(items).params).toEqual([3, 'fetching', 'importing']);
  });

  it('leaves the items alone when the job was not cancellable', async () => {
    const db = mockDb({ update: [[]] });

    await expect(new WebSerialsRepository(db as never).cancelJob(3)).resolves.toBeUndefined();

    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('hands one in-flight item back to pending without its engine handle', async () => {
    const db = mockDb({ update: [[]] });

    await new WebSerialsRepository(db as never).releaseItem(8);

    const builder = builderAt(db.update);
    const set = builder.set!.mock.calls[0]![0];
    expect(set).toMatchObject({ status: 'pending' });
    expect(render(set.remoteRef).sql).toContain('"handle": null');
    expect(render(set.remoteRef).sql).toContain('"member": null');
    expect(whereSql(builder).params).toEqual([8, 'fetching', 'importing']);
  });

  it('restores a paused job to the queue position it had', async () => {
    const db = mockDb({ update: [[{ id: 3 }]] });

    await new WebSerialsRepository(db as never).restoreAfterMove(3, 1234);

    const builder = builderAt(db.update);
    expect(builder.set!.mock.calls[0]![0]).toMatchObject({ status: 'queued', queueOrder: 1234, heartbeatAt: null });
    expect(whereSql(builder).params).toEqual([3, 'paused']);
  });

  it('pauses a queued or running job and drops its progress and any retry wait message', async () => {
    const db = mockDb({ update: [[{ id: 3 }]] });

    await new WebSerialsRepository(db as never).pauseJob(3);

    const builder = builderAt(db.update);
    expect(builder.set!.mock.calls[0]![0]).toMatchObject({ status: 'paused', message: null, currentUnit: null });
    expect(whereSql(builder).params).toEqual([3, 'queued', 'running', 'importing']);
  });

  it('resumes only a paused job, to the end of the queue', async () => {
    const db = mockDb({ update: [[{ id: 3 }]] });

    await new WebSerialsRepository(db as never).resumeJob(3);

    const builder = builderAt(db.update);
    const set = builder.set!.mock.calls[0]![0];
    expect(set).toMatchObject({ status: 'queued', heartbeatAt: null });
    expect(render(set.queueOrder).sql).toContain('extract(epoch from now())');
    expect(whereSql(builder).params).toEqual([3, 'paused']);
  });

  it('moves a queued job below the lowest queued position', async () => {
    const db = mockDb({ update: [[{ id: 3 }]] });

    await new WebSerialsRepository(db as never).moveJobToTop(3);

    const builder = builderAt(db.update);
    const rendered = render(builder.set!.mock.calls[0]![0].queueOrder);
    expect(rendered.sql).toContain('min("web_serial_jobs"."queue_order")');
    expect(rendered.sql).toContain('- 1');
    expect(whereSql(builder).params).toEqual([3, 'queued']);
  });

  it('removes only a finished job', async () => {
    const db = mockDb({ delete: [[{ id: 3 }], []] });
    const repo = new WebSerialsRepository(db as never);

    await expect(repo.deleteFinishedJob(3)).resolves.toBe(true);
    expect(whereSql(builderAt(db.delete, 0)).params).toEqual([3, 'completed', 'completed_with_gaps', 'failed', 'cancelled']);
    await expect(repo.deleteFinishedJob(4)).resolves.toBe(false);
  });

  it('clears finished jobs for one user or for everyone', async () => {
    const db = mockDb({ delete: [[{ id: 1 }, { id: 2 }], [{ id: 5 }]] });
    const repo = new WebSerialsRepository(db as never);

    await expect(repo.clearFinishedJobs(42)).resolves.toEqual([1, 2]);
    expect(whereSql(builderAt(db.delete, 0)).params).toEqual(['completed', 'completed_with_gaps', 'failed', 'cancelled', 42]);
    await expect(repo.clearFinishedJobs(null)).resolves.toEqual([5]);
    expect(whereSql(builderAt(db.delete, 1)).params).toEqual(['completed', 'completed_with_gaps', 'failed', 'cancelled']);
  });

  it('releases in-flight items back to pending without their engine handle', async () => {
    const db = mockDb({ update: [[{ id: 1 }, { id: 2 }]] });

    await expect(new WebSerialsRepository(db as never).releaseInFlightItems(6)).resolves.toBe(2);

    const builder = builderAt(db.update);
    const set = builder.set!.mock.calls[0]![0];
    expect(set).toMatchObject({ status: 'pending' });
    expect(render(set.remoteRef).sql).toContain('"handle": null');
    expect(whereSql(builder).params).toEqual([6, 'fetching', 'importing']);
  });

  it('deletes finished jobs by their finish time', async () => {
    const db = mockDb({ delete: [[{ id: 1 }]] });
    const cutoff = new Date('2026-01-01T00:00:00Z');

    await expect(new WebSerialsRepository(db as never).deleteFinishedJobsBefore(cutoff)).resolves.toBe(1);

    const where = whereSql(builderAt(db.delete));
    expect(where.sql).toContain('coalesce("web_serial_jobs"."finished_at"');
    expect(where.params).toEqual(['completed', 'completed_with_gaps', 'failed', 'cancelled', cutoff]);
  });

  it('stores the current unit only on an active job', async () => {
    const db = mockDb({ update: [[]] });
    const current = { label: 'Vol 1', stage: 'fetching' as const, chaptersDone: 3, chaptersTotal: 9, progress: 0.3 };

    await new WebSerialsRepository(db as never).setCurrentUnit(3, current);

    const builder = builderAt(db.update);
    expect(builder.set!.mock.calls[0]![0]).toEqual({ currentUnit: current });
    expect(whereSql(builder).params).toEqual([3, 'queued', 'running', 'importing']);
  });

  it('retries only failed or gapped jobs and, at the end of the queue, re-arms just the failed items', async () => {
    const db = mockDb({ update: [[{ id: 3 }], [], []] });

    await expect(new WebSerialsRepository(db as never).requeueForRetry(3)).resolves.toBe(true);

    expect(whereSql(builderAt(db.update, 0)).params).toEqual([3, 'failed', 'completed_with_gaps']);
    expect(render(builderAt(db.update, 0).set!.mock.calls[0]![0].queueOrder).sql).toContain('extract(epoch from now())');
    expect(builderAt(db.update, 1).set!.mock.calls[0]![0]).toMatchObject({ status: 'pending', error: null });
    expect(render(builderAt(db.update, 1).set!.mock.calls[0]![0].remoteRef).sql).toContain(
      "- 'attempts' - 'retryAt' - 'retryReason' - 'failureReason'",
    );
    expect(whereSql(builderAt(db.update, 1)).params).toEqual([3, 'failed']);
    expect(db.update).toHaveBeenCalledTimes(3);
  });

  it('does not touch items when the job is not retryable', async () => {
    const db = mockDb({ update: [[]] });

    await expect(new WebSerialsRepository(db as never).requeueForRetry(3)).resolves.toBe(false);
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('re-queues interrupted jobs and resets their in-flight items', async () => {
    const db = mockDb({ update: [[{ id: 1 }, { id: 2 }], []] });

    await expect(new WebSerialsRepository(db as never).requeueInterruptedJobs()).resolves.toEqual({ requeued: [1, 2] });

    expect(whereSql(builderAt(db.update, 0)).params).toEqual(['running', 'importing']);
    expect(builderAt(db.update, 1).set!.mock.calls[0]![0]).toMatchObject({ status: 'pending' });
    expect(whereSql(builderAt(db.update, 1)).params).toEqual([1, 2, 'fetching', 'importing']);
  });

  it('leaves paused jobs paused and clears the in-flight items they were stopped with', async () => {
    const db = mockDb({ select: [[{ id: 9 }]], update: [[], []] });

    await expect(new WebSerialsRepository(db as never).requeueInterruptedJobs()).resolves.toEqual({ requeued: [] });

    expect(whereSql(builderAt(db.update, 0)).params).toEqual([9, 'fetching', 'importing']);
    expect(whereSql(builderAt(db.update, 1)).params).toEqual(['running', 'importing']);
  });

  it('re-arms one failed item and queues a finished job again', async () => {
    const db = mockDb({ update: [[{ id: 12 }], [], []] });

    await expect(new WebSerialsRepository(db as never).retryItem(3, 12)).resolves.toBe(true);

    expect(builderAt(db.update, 0).set!.mock.calls[0]![0]).toMatchObject({ status: 'pending', error: null });
    expect(whereSql(builderAt(db.update, 0)).params).toEqual([12, 3, 'failed', 3]);
    const reset = render(builderAt(db.update, 0).set!.mock.calls[0]![0].remoteRef).sql;
    expect(reset).toContain("- 'attempts' - 'retryAt' - 'retryReason' - 'failureReason'");
    expect(whereSql(builderAt(db.update, 0)).sql).toContain("<> 'cancelled'");
    expect(builderAt(db.update, 1).set!.mock.calls[0]![0]).toMatchObject({ status: 'queued', finishedAt: null });
    expect(whereSql(builderAt(db.update, 1)).params).toEqual([3, 'completed', 'completed_with_gaps', 'failed']);
    expect(db.update).toHaveBeenCalledTimes(3);
  });

  it('does not touch the job when the item is not a failed item of it', async () => {
    const db = mockDb({ update: [[]] });

    await expect(new WebSerialsRepository(db as never).retryItem(3, 12)).resolves.toBe(false);
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('skips the item update when no job was interrupted', async () => {
    const db = mockDb({ update: [[]] });

    await expect(new WebSerialsRepository(db as never).requeueInterruptedJobs()).resolves.toEqual({ requeued: [] });
    expect(db.update).toHaveBeenCalledTimes(1);
  });
});

describe('WebSerialsRepository items', () => {
  it('inserts items idempotently and reports how many were new', async () => {
    const db = mockDb({ insert: [[{ id: 1 }, { id: 2 }]] });
    const repo = new WebSerialsRepository(db as never);

    await expect(repo.insertItems([{ jobId: 1, unitKey: 'a', label: 'A', sequence: '1' }])).resolves.toBe(2);
    expect(builderAt(db.insert).onConflictDoNothing).toHaveBeenCalled();
    await expect(repo.insertItems([])).resolves.toBe(0);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it('selects only the detail columns and sorts sequences numerically', async () => {
    const db = mockDb({ select: [[{ id: 1 }]] });

    await new WebSerialsRepository(db as never).findItemsForDetail(8);

    const selected = (db.select.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(Object.keys(selected).sort()).toEqual(['bookId', 'error', 'id', 'label', 'sequence', 'status', 'updatedAt']);
    expect(render(builderAt(db.select).orderBy!.mock.calls[0]![0]).sql).toContain('::numeric');
  });

  it('selects only movable items with a bounded numeric ordering', async () => {
    const db = mockDb({ select: [[{ id: 1, sequence: '2', status: 'failed' }]] });

    await expect(new WebSerialsRepository(db as never).findMoveItems(8, 5001)).resolves.toHaveLength(1);

    const builder = builderAt(db.select);
    expect(whereSql(builder).params).toEqual([8, 'pending', 'fetching', 'failed']);
    expect(render(builder.orderBy!.mock.calls[0]![0]).sql).toContain('::numeric');
    expect(builder.limit).toHaveBeenCalledWith(5001);
  });

  it('detects whether an item is still in flight', async () => {
    const db = mockDb({ select: [[{ id: 1 }], []] });
    const repo = new WebSerialsRepository(db as never);

    await expect(repo.hasInFlightItems(8)).resolves.toBe(true);
    await expect(repo.hasInFlightItems(8)).resolves.toBe(false);
    expect(whereSql(builderAt(db.select, 0)).params).toEqual([8, 'fetching', 'importing']);
  });

  it('finds the next item among unfinished statuses, skipping units whose retry is not due', async () => {
    const db = mockDb({ select: [[{ id: 5 }]] });
    const now = new Date('2026-10-14T10:00:00.000Z');

    await expect(new WebSerialsRepository(db as never).findNextItem(8, now)).resolves.toEqual({ id: 5 });
    const rendered = whereSql(builderAt(db.select));
    expect(rendered.params).toEqual([8, 'pending', 'fetching', 'importing', now.toISOString()]);
    expect(rendered.sql).toContain("->>'retryAt')::timestamptz is null or");
    expect(rendered.sql).toContain('<=');
  });

  it('finds the waiting retries with their count and the one due first', async () => {
    const item = { id: 5, label: 'Chapter 5' };
    const db = mockDb({ select: [[{ item, total: 3 }], []] });
    const repo = new WebSerialsRepository(db as never);

    await expect(repo.findWaitingRetries(8)).resolves.toEqual({ count: 3, next: item });
    const rendered = whereSql(builderAt(db.select, 0));
    expect(rendered.params).toEqual([8, 'pending']);
    expect(rendered.sql).toContain("->>'retryAt')::timestamptz is not null");
    await expect(repo.findWaitingRetries(8)).resolves.toBeUndefined();
  });

  const chapterUnits = [
    { key: 'a1', sequence: '1', packaging: 'chapter' as const },
    { key: 'a2', sequence: '2', packaging: 'chapter' as const },
    { key: 'a3', sequence: '3.5', packaging: 'chapter' as const },
  ];

  it('finds the grouped books imported for a series without listing every chapter', async () => {
    const db = mockDb({ selectDistinct: [[{ unitKey: 'vol:2' }, { unitKey: 'sel:a-b' }]] });

    await expect(new WebSerialsRepository(db as never).findImportedGroupKeys(42, 'm:7')).resolves.toEqual(['vol:2', 'sel:a-b']);
    const rendered = whereSql(builderAt(db.selectDistinct));
    expect(rendered.params).toEqual([42, 'm:7', 'series']);
    expect(rendered.sql).toContain("like 'vol:%'");
    expect(builderAt(db.selectDistinct).limit).toHaveBeenCalledWith(5000);
  });

  it('finds imported units by series key, requiring an existing book', async () => {
    const db = mockDb({ selectDistinct: [[{ unitKey: 'a1' }, { unitKey: 'gone-from-list' }]] });

    await expect(new WebSerialsRepository(db as never).findImportedUnitKeys(42, 'm:7', chapterUnits)).resolves.toEqual(['a1']);
    const rendered = whereSql(builderAt(db.selectDistinct));
    expect(rendered.params).toEqual([42, 'm:7']);
    expect(rendered.sql).toContain('"web_serial_imports"."series_key"');
    expect(builderAt(db.selectDistinct).innerJoin).toHaveBeenCalledTimes(1);
    expect(db.selectDistinct).toHaveBeenCalledTimes(1);
  });

  it('treats a grown last novel volume as new and a shorter copy of an owned range as owned', async () => {
    const db = mockDb({ selectDistinct: [[{ unitKey: 'volume-3:201-250', sequence: '3:201-250', packaging: 'volume' }]] });
    const units = [
      { key: 'volume-3:201-250', sequence: '3', packaging: 'volume' as const },
      { key: 'volume-3:201-240', sequence: '3', packaging: 'volume' as const },
      { key: 'volume-3:201-280', sequence: '3', packaging: 'volume' as const },
      { key: 'volume-3', sequence: '3', packaging: 'volume' as const },
    ];

    await expect(new WebSerialsRepository(db as never).findImportedUnitKeys(42, 'nl:alpha:eA', units)).resolves.toEqual([
      'volume-3:201-250',
      'volume-3:201-240',
    ]);
  });

  it('owns a novel volume under the same key only while its recorded range covers the range it holds now', async () => {
    const lncrawl = mockDb({ selectDistinct: [[{ unitKey: 'v2', sequence: '2', packaging: 'volume', chapterFrom: 101, chapterTo: 150 }], []] });
    const lncrawlUnits = [
      { key: 'v2', sequence: '2', packaging: 'volume' as const, range: { from: 101, to: 180 } },
      { key: 'v2:101-150', sequence: '2', packaging: 'volume' as const, range: { from: 101, to: 150 } },
    ];
    await expect(new WebSerialsRepository(lncrawl as never).findImportedUnitKeys(1, 'n:abc', lncrawlUnits, null, ['Saga'])).resolves.toEqual([
      'v2:101-150',
    ]);

    const lnreader = mockDb({
      selectDistinct: [[{ unitKey: 'volume-3', sequence: '3', packaging: 'volume', chapterFrom: 201, chapterTo: 251 }], []],
    });
    const lnreaderUnits = [
      { key: 'volume-3', sequence: '3', packaging: 'volume' as const, range: { from: 201, to: 252 } },
      { key: 'volume-3:201-251', sequence: '3', packaging: 'volume' as const, range: { from: 201, to: 251 } },
    ];
    await expect(new WebSerialsRepository(lnreader as never).findImportedUnitKeys(1, 'nl:src:p', lnreaderUnits, null, ['Saga'])).resolves.toEqual([
      'volume-3:201-251',
    ]);
  });

  it('keeps a lightnovel-crawler volume filed before ranges were stored owned under its ranged key', async () => {
    const db = mockDb({ selectDistinct: [[{ unitKey: 'v2', sequence: '2', packaging: 'volume', chapterFrom: null, chapterTo: null }], []] });
    const units = [{ key: 'v2:101-150', sequence: '2', packaging: 'volume' as const, range: { from: 101, to: 150 } }];

    await expect(new WebSerialsRepository(db as never).findImportedUnitKeys(1, 'n:abc', units, null, ['Saga'])).resolves.toEqual(['v2:101-150']);
  });

  it('recognizes a chapter re-uploaded under a new unit key by its number within the same series, without a match key', async () => {
    const db = mockDb({
      selectDistinct: [
        [
          { unitKey: 'old-upload-1', sequence: '1', packaging: 'chapter' },
          { unitKey: 'vol:1', sequence: '2', packaging: 'volume' },
        ],
      ],
    });

    await expect(new WebSerialsRepository(db as never).findImportedUnitKeys(42, 'm:7', chapterUnits)).resolves.toEqual(['a1']);
    expect(db.selectDistinct).toHaveBeenCalledTimes(1);
  });

  it('matches manga chapters from another source by match key and numeric sequence', async () => {
    const db = mockDb({ selectDistinct: [[{ unitKey: 'a1' }], [{ sequence: '2.0' }, { sequence: '3.5' }, { sequence: '1-12' }]] });

    await expect(new WebSerialsRepository(db as never).findImportedUnitKeys(42, 'm:7', chapterUnits, 'mb:9')).resolves.toEqual(['a1', 'a2', 'a3']);
    const rendered = whereSql(builderAt(db.selectDistinct, 1));
    expect(rendered.params).toEqual([42, 'mb:9', 'manga']);
    expect(rendered.sql).toContain('"web_serial_imports"."match_key"');
  });

  it('never matches a volume unit by sequence', async () => {
    const db = mockDb({ selectDistinct: [[], [{ sequence: '1' }]] });
    const volumes = [{ key: 'vol:1', sequence: '1', packaging: 'volume' as const }];

    await expect(new WebSerialsRepository(db as never).findImportedUnitKeys(42, 'm:7', volumes, 'mb:9')).resolves.toEqual([]);
    expect(db.selectDistinct).toHaveBeenCalledTimes(1);
  });

  it('does not cross-match novels by sequence, only by series key', async () => {
    const db = mockDb({ selectDistinct: [[{ unitKey: 'v1' }]] });
    const volumes = [
      { key: 'v1', sequence: '1', packaging: 'chapter' as const },
      { key: 'v2', sequence: '2', packaging: 'chapter' as const },
    ];

    await expect(new WebSerialsRepository(db as never).findImportedUnitKeys(42, 'n:abc', volumes, 'mb:9')).resolves.toEqual(['v1']);
    expect(db.selectDistinct).toHaveBeenCalledTimes(1);
  });

  it('records imports as an upsert that refreshes the book', async () => {
    const db = mockDb({ insert: [[]] });
    const repo = new WebSerialsRepository(db as never);
    const row = { userId: 1, seriesKey: 'm:7', kind: 'manga' as const, unitKey: 'a1', sequence: '1', packaging: 'chapter' as const, bookId: 5 };

    await repo.recordImports([]);
    expect(db.insert).not.toHaveBeenCalled();
    await repo.recordImports([row]);

    const builder = builderAt(db.insert);
    expect(builder.values).toHaveBeenCalledWith([row]);
    const conflict = builder.onConflictDoUpdate!.mock.calls[0]![0];
    expect(conflict.target).toHaveLength(4);
    expect(render(conflict.set.bookId).sql).toContain('excluded.book_id');
  });

  it('never touches the import ledger when jobs are deleted', async () => {
    const db = mockDb({ delete: [[{ id: 1 }], [{ id: 2 }]] });
    const repo = new WebSerialsRepository(db as never);

    await repo.clearFinishedJobs(42);
    await repo.deleteFinishedJobsBefore(new Date());

    expect(db.delete).toHaveBeenCalledTimes(2);
    for (const [table] of db.delete.mock.calls) expect(table).toBe(webSerialJobs);
  });

  it('skips only pending items of the job for the given keys', async () => {
    const db = mockDb({ update: [[{ id: 1 }]] });
    const repo = new WebSerialsRepository(db as never);

    await expect(repo.skipItems(4, ['c1'])).resolves.toBe(1);
    expect(whereSql(builderAt(db.update)).params).toEqual([4, 'pending', 'c1']);
    await expect(repo.skipItems(4, [])).resolves.toBe(0);
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('recomputes counters from the items', async () => {
    const db = mockDb({ update: [[]] });

    await new WebSerialsRepository(db as never).refreshCounters(4);

    const set = builderAt(db.update).set!.mock.calls[0]![0];
    const rendered = render(set.unitsDone);
    expect(rendered.sql).toContain('from "web_serial_job_items"');
    expect(rendered.params).toEqual([4, 'imported']);
    expect(render(set.unitsFailed).params).toEqual([4, 'failed']);
    expect(render(set.unitsSkipped).params).toEqual([4, 'skipped']);
    expect(render(set.unitsTotal).params).toEqual([4]);
  });

  it('groups item counts by status', async () => {
    const db = mockDb({
      select: [
        [
          { status: 'imported', value: 3 },
          { status: 'failed', value: 1 },
        ],
      ],
    });

    await expect(new WebSerialsRepository(db as never).countItemsByStatus(2)).resolves.toEqual({ imported: 3, failed: 1 });
  });
});

describe('WebSerialsRepository transitionJob', () => {
  it('only updates a job that is still in one of the expected statuses', async () => {
    const db = mockDb({ update: [[{ id: 5, status: 'completed' }]] });

    const row = await new WebSerialsRepository(db as never).transitionJob(5, ['running', 'importing'], { status: 'completed' });

    expect(row).toMatchObject({ id: 5 });
    const where = whereSql(builderAt(db.update));
    expect(where.sql).toContain('"web_serial_jobs"."status" in');
    expect(where.params).toEqual([5, 'running', 'importing']);
  });

  it('returns undefined when a cancel won the race', async () => {
    const db = mockDb({ update: [[]] });

    await expect(new WebSerialsRepository(db as never).transitionJob(5, ['running'], { status: 'completed' })).resolves.toBeUndefined();
  });
});

describe('WebSerialsRepository returned rows', () => {
  it('returns only the id from a transition and from an item update', async () => {
    const db = mockDb({ update: [[{ id: 5 }], [{ id: 8 }]] });
    const repo = new WebSerialsRepository(db as never);

    await repo.transitionJob(5, ['running'], { status: 'completed' });
    await repo.updateItem(8, { status: 'imported' });

    expect(builderAt(db.update, 0).returning).toHaveBeenCalledWith({ id: expect.anything() });
    expect(builderAt(db.update, 1).returning).toHaveBeenCalledWith({ id: expect.anything() });
  });
});

describe('WebSerialsRepository moveJob', () => {
  it('finishes the source, marks moved and missing items, refreshes counters and creates the target atomically', async () => {
    const target = { id: 22, seriesKey: 'm:2' };
    const db = mockDb({ update: [[{ id: 11 }], [], [], []], insert: [[target]] });
    const repo = new WebSerialsRepository(db as never);

    await expect(
      repo.moveJob({
        sourceJobId: 11,
        sourceExpectedStatus: 'paused',
        movedItemIds: [1, 2],
        missingItemIds: [3],
        sourceMessage: 'Remaining chapters moved to AllManga.',
        movedError: 'Moved to AllManga.',
        missingError: 'Not available on AllManga.',
        targetJob: { userId: 7, kind: 'manga', seriesKey: 'm:2' } as never,
      }),
    ).resolves.toEqual(target);

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(builderAt(db.update, 0).set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed', message: 'Remaining chapters moved to AllManga.', currentUnit: null }),
    );
    expect(whereSql(builderAt(db.update, 0)).params).toEqual([11, 'paused']);
    expect(builderAt(db.update, 1).set).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped', error: 'Moved to AllManga.' }));
    expect(whereSql(builderAt(db.update, 1)).params).toEqual([11, 1, 2, 'pending', 'fetching', 'failed']);
    expect(builderAt(db.update, 2).set).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', error: 'Not available on AllManga.' }));
    expect(whereSql(builderAt(db.update, 2)).params).toEqual([11, 3, 'pending', 'fetching', 'failed']);
    expect(builderAt(db.insert).values).toHaveBeenCalledWith(expect.objectContaining({ seriesKey: 'm:2' }));
  });

  it('does not touch items or create a target when the source is not settled', async () => {
    const db = mockDb({ update: [[]] });

    await expect(
      new WebSerialsRepository(db as never).moveJob({
        sourceJobId: 11,
        sourceExpectedStatus: 'paused',
        movedItemIds: [1],
        missingItemIds: [],
        sourceMessage: 'moved',
        movedError: 'moved',
        missingError: 'missing',
        targetJob: { userId: 7, kind: 'manga', seriesKey: 'm:2' } as never,
      }),
    ).resolves.toBeUndefined();
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe('WebSerialsRepository review fixes', () => {
  it('reads jobs without their stored units or selection list', async () => {
    const db = mockDb({ select: [[]] });

    await new WebSerialsRepository(db as never).listJobs(1, 10, 0);

    const selected = ((db.select.mock.calls[0] as unknown[])[0] as { job: Record<string, SQL> }).job;
    expect(render(selected.engineState).sql).toBe(`jsonb_build_object('hasCover', "web_serial_jobs"."engine_state"->'hasCover')`);
    expect(render(selected.selection).sql).toContain(`jsonb_build_object('mode', 'list', 'sequences', '[]'::jsonb)`);
    expect(Object.keys(selected)).toContain('status');
    expect(Object.keys(selected)).toContain('metadata');
  });

  it('reads the stored units of one job on demand', async () => {
    const db = mockDb({ select: [[{ units: [{ unitKey: 'c1' }] }], [{ units: null }]] });
    const repo = new WebSerialsRepository(db as never);

    await expect(repo.findJobUnits(4)).resolves.toEqual([{ unitKey: 'c1' }]);
    await expect(repo.findJobUnits(4)).resolves.toEqual([]);
    expect(render(((db.select.mock.calls[0] as unknown[])[0] as { units: SQL }).units).sql).toContain("->'units'");
  });

  it('does not re-arm an item of a cancelled job', async () => {
    const db = mockDb({ update: [[]] });

    await expect(new WebSerialsRepository(db as never).retryItem(3, 12)).resolves.toBe(false);

    expect(whereSql(builderAt(db.update, 0)).sql).toMatch(
      /exists \(select 1 from "web_serial_jobs" where "web_serial_jobs"."id" = \$\d+ and "web_serial_jobs"."status" <> 'cancelled'\)/,
    );
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('clears the stale message and current unit of an interrupted job when it is requeued', async () => {
    const db = mockDb({ update: [[{ id: 1 }], []] });

    await new WebSerialsRepository(db as never).requeueInterruptedJobs();

    expect(builderAt(db.update, 0).set!.mock.calls[0]![0]).toMatchObject({ status: 'queued', message: null, currentUnit: null });
  });

  it('only finishes a job while no item is pending or in flight when asked to', async () => {
    const db = mockDb({ update: [[{ id: 1 }]] });

    await new WebSerialsRepository(db as never).transitionJob(1, ['running'], { status: 'completed' }, { requireSettledItems: true });

    const where = whereSql(builderAt(db.update));
    expect(where.params).toEqual([1, 'running', 1]);
    expect(where.sql).toContain(
      'not exists (select 1 from "web_serial_job_items" where "web_serial_job_items"."job_id" = $3 and "web_serial_job_items"."status" in (\'pending\', \'fetching\', \'importing\'))',
    );
  });

  it('reads one item and writes only its member marker', async () => {
    const db = mockDb({ select: [[{ id: 5 }]], update: [[]] });
    const repo = new WebSerialsRepository(db as never);

    await expect(repo.findItem(5)).resolves.toEqual({ id: 5 });
    await repo.setItemMember(5, { index: 2, handle: { a: 1 } });

    const set = builderAt(db.update).set!.mock.calls[0]![0] as { remoteRef: SQL };
    const rendered = render(set.remoteRef);
    expect(rendered.sql).toContain('jsonb_set("web_serial_job_items"."remote_ref", \'{member}\'');
    expect(rendered.params).toEqual([JSON.stringify({ index: 2, handle: { a: 1 } })]);
  });

  it('counts failed items by their stored reason, unknown when none was stored', async () => {
    const db = mockDb({
      select: [
        [
          { reason: 'not_found', value: 2 },
          { reason: 'unknown', value: 1 },
        ],
      ],
    });

    const counts = await new WebSerialsRepository(db as never).countFailureReasons(3);

    expect([...counts]).toEqual([
      ['not_found', 2],
      ['unknown', 1],
    ]);
    expect(whereSql(builderAt(db.select)).params).toEqual([3, 'failed']);
  });

  it('returns the given jobs whose work folder must stay: unfinished, failed or gapped', async () => {
    const db = mockDb({ select: [[{ id: 2 }]] });
    const repo = new WebSerialsRepository(db as never);

    await expect(repo.findJobIdsKeepingWorkDirs([1, 2])).resolves.toEqual([2]);
    await expect(repo.findJobIdsKeepingWorkDirs([])).resolves.toEqual([]);
    expect(whereSql(builderAt(db.select)).params).toEqual([1, 2, 'completed', 'cancelled']);
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});

describe('WebSerialsRepository totals and move items', () => {
  it('counts the jobs in scope and how many are finished', async () => {
    const db = mockDb({ select: [[{ total: 7, finishedCount: 3 }]] });
    await expect(new WebSerialsRepository(db as never).countJobs(4)).resolves.toEqual({ total: 7, finishedCount: 3 });
    expect(whereSql(builderAt(db.select)).params).toEqual([4]);
  });

  it('selects the unit key and stored description of movable items', async () => {
    const db = mockDb({ select: [[]] });
    await new WebSerialsRepository(db as never).findMoveItems(3, 10);
    expect(Object.keys((db.select.mock.calls[0] as unknown[])[0] as object)).toEqual(['id', 'sequence', 'status', 'unitKey', 'remoteRef']);
  });
});

describe('WebSerialsRepository novel provider preferences', () => {
  it('reads the disabled domains of one user, empty when none are saved', async () => {
    const db = mockDb({ select: [[{ disabled: ['a.com'] }], []] });
    const repo = new WebSerialsRepository(db as never);

    await expect(repo.getDisabledNovelDomains(7)).resolves.toEqual(['a.com']);
    expect(whereSql(builderAt(db.select, 0))).toMatchObject({ params: [7] });
    await expect(repo.getDisabledNovelDomains(8)).resolves.toEqual([]);
  });

  it('upserts the list on the user id', async () => {
    const db = mockDb();

    await new WebSerialsRepository(db as never).setDisabledNovelDomains(7, ['a.com']);

    const builder = builderAt(db.insert);
    expect(builder.values).toHaveBeenCalledWith({ userId: 7, disabledDomains: ['a.com'] });
    expect(builder.onConflictDoUpdate!.mock.calls[0]![0].set).toMatchObject({ disabledDomains: ['a.com'] });
  });
});

describe('WebSerialsRepository volume requests', () => {
  it('upserts one row per user, kind, series and volume, replacing the request id', async () => {
    const db = mockDb();

    await new WebSerialsRepository(db as never).upsertVolumeRequest(7, 'novel', '12', '2', 9);

    const builder = builderAt(db.insert);
    expect(builder.values).toHaveBeenCalledWith({ userId: 7, kind: 'novel', matchId: '12', volume: '2', bookRequestId: 9 });
    const conflict = builder.onConflictDoUpdate!.mock.calls[0]![0];
    expect(conflict.target).toHaveLength(4);
    expect(conflict.set).toEqual({ bookRequestId: 9 });
  });

  it('lists only the calling user rows for the series, bounded', async () => {
    const db = mockDb({ select: [[{ volume: '2', bookRequestId: 9 }]] });

    await expect(new WebSerialsRepository(db as never).listVolumeRequests(7, 'novel', '12')).resolves.toEqual([{ volume: '2', bookRequestId: 9 }]);

    const where = whereSql(builderAt(db.select));
    expect(where.sql).toContain('"user_id" =');
    expect(where.sql).toContain('"kind" =');
    expect(where.sql).toContain('"match_id" =');
    expect(where.params).toEqual([7, 'novel', '12']);
    expect(builderAt(db.select).limit).toHaveBeenCalledWith(200);
  });
});

describe('WebSerialsRepository findImportedMatchKeys', () => {
  it('returns the match keys the user has a book for, scoped to the user', async () => {
    const db = mockDb({ selectDistinct: [[{ matchKey: 'mb:1995' }, { matchKey: null }]] });

    const keys = await new WebSerialsRepository(db as never).findImportedMatchKeys(42, ['mb:1995', 'mb:77']);

    expect(keys).toEqual(new Set(['mb:1995']));
    const where = whereSql(builderAt(db.selectDistinct));
    expect(where.sql).toContain('"user_id" =');
    expect(where.sql).toContain('"match_key" in');
    expect(where.params).toEqual(expect.arrayContaining([42, 'mb:1995', 'mb:77']));
  });

  it('does not query for an empty list', async () => {
    const db = mockDb();

    await expect(new WebSerialsRepository(db as never).findImportedMatchKeys(42, [])).resolves.toEqual(new Set());
    expect(db.selectDistinct).not.toHaveBeenCalled();
  });
});

describe('WebSerialsRepository novel ownership across engines', () => {
  const volumes = [
    { key: 'volume-1', sequence: '1', packaging: 'volume' as const },
    { key: 'volume-2', sequence: '2', packaging: 'volume' as const },
  ];

  const elsewhere = (overrides: Record<string, unknown>) => ({
    seriesKey: 'nl:other:x',
    matchKey: null,
    titleKey: null,
    seriesName: null,
    sequence: '1',
    chapterFrom: 1,
    chapterTo: 100,
    ...overrides,
  });

  it('counts a volume from another source of the same engine only when an owned range holds every chapter of it', async () => {
    const db = mockDb({
      selectDistinct: [
        [],
        [
          elsewhere({ matchKey: 'mb:9' }),
          elsewhere({ titleKey: 'saga', sequence: '2', chapterFrom: 101, chapterTo: 150 }),
          elsewhere({ matchKey: 'mb:9', sequence: '2', chapterFrom: null, chapterTo: null }),
        ],
      ],
    });

    await expect(new WebSerialsRepository(db as never).findImportedUnitKeys(42, 'nl:src:abc', volumes, 'mb:9', ['Saga'])).resolves.toEqual([
      'volume-1',
    ]);
    const builder = builderAt(db.selectDistinct, 1);
    const rendered = whereSql(builder);
    expect(rendered.params).toEqual(expect.arrayContaining([42, 'novel', 'volume', 'nl:src:abc', 'nl:%', 'mb:9', 'saga']));
    expect(rendered.sql).toContain('"web_serial_imports"."title_key"');
    expect(builder.leftJoin).toHaveBeenCalledTimes(1);
  });

  it('never takes a volume number alone from another source, and reads a filed series name the way search normalizes it', async () => {
    const db = mockDb({
      selectDistinct: [
        [],
        [
          elsewhere({ seriesName: 'Lord of the Mysteries (Web Novel)', sequence: '1', chapterFrom: null, chapterTo: null }),
          elsewhere({ seriesName: 'Lord of the Mysteries (Web Novel)', sequence: '2', chapterFrom: 101, chapterTo: 200 }),
          elsewhere({ seriesName: 'Lord of the Mysteries 2', sequence: '1', chapterFrom: 1, chapterTo: 100 }),
        ],
      ],
    });

    await expect(
      new WebSerialsRepository(db as never).findImportedUnitKeys(42, 'nl:src:abc', volumes, null, ['Lord of the Mysteries']),
    ).resolves.toEqual(['volume-2']);
  });

  it('skips the query with neither a match nor a title', async () => {
    const db = mockDb({ selectDistinct: [[]] });

    await expect(new WebSerialsRepository(db as never).findImportedUnitKeys(42, 'n:abc', volumes, null, [])).resolves.toEqual([]);
    expect(db.selectDistinct).toHaveBeenCalledTimes(1);
  });

  it('owns a volume of this series by its range, and by its key only for rows from before ranges', async () => {
    const db = mockDb({
      selectDistinct: [
        [
          { unitKey: 'vol:11', sequence: '90-99', packaging: 'volume', chapterFrom: null, chapterTo: null },
          { unitKey: 'vol:12:100-103', sequence: '100-103', packaging: 'volume', chapterFrom: 100, chapterTo: 103 },
        ],
      ],
    });
    const units = [
      { key: 'vol:11', sequence: '11', packaging: 'volume' as const, range: { from: 90, to: 99 } },
      { key: 'vol:12:100-103', sequence: '12', packaging: 'volume' as const, range: { from: 100, to: 103 } },
      { key: 'vol:12', sequence: '12', packaging: 'volume' as const, range: { from: 100, to: 108 } },
    ];

    await expect(new WebSerialsRepository(db as never).findImportedUnitKeys(42, 'm:7', units)).resolves.toEqual(['vol:11', 'vol:12:100-103']);
  });

  it('never lets an owned manga volume own another volume whose chapters restart at 1', async () => {
    const db = mockDb({
      selectDistinct: [[{ unitKey: 'vol:1', sequence: '1', packaging: 'volume', chapterFrom: 1, chapterTo: 10 }]],
    });
    const units = [
      { key: 'vol:1', sequence: '1', packaging: 'volume' as const, range: { from: 1, to: 10 } },
      { key: 'vol:2', sequence: '2', packaging: 'volume' as const, range: { from: 1, to: 10 } },
    ];

    await expect(new WebSerialsRepository(db as never).findImportedUnitKeys(42, 'm:7', units)).resolves.toEqual(['vol:1']);
  });

  it('lets a legacy unranged manga volume own the ranged key of the same volume', async () => {
    const db = mockDb({
      selectDistinct: [[{ unitKey: 'vol:12', sequence: '12', packaging: 'volume', chapterFrom: null, chapterTo: null }]],
    });
    const units = [
      { key: 'vol:12:100-103', sequence: '12', packaging: 'volume' as const, range: { from: 100, to: 103 } },
      { key: 'vol:13:104-106', sequence: '13', packaging: 'volume' as const, range: { from: 104, to: 106 } },
    ];

    await expect(new WebSerialsRepository(db as never).findImportedUnitKeys(42, 'm:7', units)).resolves.toEqual(['vol:12:100-103']);
  });

  it('keeps matching a pre-range LNReader block by its key and joins it with ranged blocks', async () => {
    const db = mockDb({
      selectDistinct: [
        [
          { unitKey: 'volume-1', sequence: '1', packaging: 'volume', chapterFrom: null, chapterTo: null },
          { unitKey: 'volume-2', sequence: '2', packaging: 'volume', chapterFrom: 101, chapterTo: 200 },
        ],
        [],
      ],
    });
    const units = [
      { key: 'volume-1', sequence: '1', packaging: 'volume' as const, range: { from: 1, to: 100 } },
      { key: 'volume-2', sequence: '2', packaging: 'volume' as const, range: { from: 101, to: 200 } },
      { key: 'volume-3:201-230', sequence: '3', packaging: 'volume' as const, range: { from: 201, to: 230 } },
    ];

    await expect(new WebSerialsRepository(db as never).findImportedUnitKeys(42, 'nl:src:abc', units, null, ['Saga'])).resolves.toEqual([
      'volume-1',
      'volume-2',
    ]);
  });

  it('never matches an extra by the number its position gave it', async () => {
    const db = mockDb({ selectDistinct: [[{ unitKey: 'real', sequence: '10.001', packaging: 'chapter' }]] });
    const units = [
      { key: 'omake', sequence: '10.001', packaging: 'chapter' as const, positional: true },
      { key: 'other', sequence: '10.001', packaging: 'chapter' as const },
    ];

    await expect(new WebSerialsRepository(db as never).findImportedUnitKeys(42, 'm:7', units)).resolves.toEqual(['other']);
  });

  it('never cross-matches manga volumes this way', async () => {
    const db = mockDb({ selectDistinct: [[]] });

    await new WebSerialsRepository(db as never).findImportedUnitKeys(42, 'm:7', volumes, null, ['Saga']);
    expect(db.selectDistinct).toHaveBeenCalledTimes(1);
  });
});

describe('webSerialRangesCover', () => {
  it('joins owned volumes that meet, so a block shifted across their boundary is still owned', () => {
    const owned = [
      { from: 1, to: 100 },
      { from: 101, to: 200 },
    ];
    expect(webSerialRangesCover(owned, { from: 100, to: 199 })).toBe(true);
    expect(webSerialRangesCover(owned, { from: 0, to: 99 })).toBe(false);
    expect(webSerialRangesCover(owned, { from: 150, to: 201 })).toBe(false);
  });

  it('keeps owned ranges with a whole chapter missing between them apart', () => {
    expect(
      webSerialRangesCover(
        [
          { from: 1, to: 100 },
          { from: 102, to: 200 },
        ],
        { from: 90, to: 110 },
      ),
    ).toBe(false);
  });

  it('never joins across a whole chapter after a fractional end, but joins up to the next whole chapter', () => {
    const wanted = { from: 1, to: 20 };
    expect(
      webSerialRangesCover(
        [
          { from: 1, to: 10.5 },
          { from: 11.5, to: 20 },
        ],
        wanted,
      ),
    ).toBe(false);
    expect(
      webSerialRangesCover(
        [
          { from: 1, to: 10.5 },
          { from: 11, to: 20 },
        ],
        wanted,
      ),
    ).toBe(true);
    expect(
      webSerialRangesCover(
        [
          { from: 1, to: 10 },
          { from: 10.5, to: 20 },
        ],
        wanted,
      ),
    ).toBe(true);
    expect(
      webSerialRangesCover(
        [
          { from: 1, to: 5 },
          { from: 10, to: 20 },
        ],
        { from: 10, to: 15 },
      ),
    ).toBe(true);
  });
});

describe('webSerialMangaVolumeOwned', () => {
  it('never lets a volume own another volume that restarts its numbering', () => {
    expect(webSerialMangaVolumeOwned(['vol:1:1-10'], '2', { from: 1, to: 10 })).toBe(false);
    expect(webSerialMangaVolumeOwned(['vol:1:1-10'], '1', { from: 1, to: 10 })).toBe(true);
  });

  it('lets a plain volume key own any copy of that volume, and joins ranged copies of the same volume only', () => {
    expect(webSerialMangaVolumeOwned(['vol:12'], '12', { from: 100, to: 103 })).toBe(true);
    expect(webSerialMangaVolumeOwned(['vol:12:100-103', 'vol:12:104-108'], '12', { from: 100, to: 108 })).toBe(true);
    expect(webSerialMangaVolumeOwned(['vol:12:100-103', 'vol:13:104-108'], '12', { from: 100, to: 108 })).toBe(false);
    expect(webSerialMangaVolumeOwned(['vol:12:100-103'], '12', null)).toBe(false);
  });
});
