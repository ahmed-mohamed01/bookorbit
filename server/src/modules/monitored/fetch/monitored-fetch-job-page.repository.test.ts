import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { JobView } from '@bookorbit/types';

import type { JobPosition } from '../../jobs/job-keyset';
import { MonitoredFetchJobPageRepository } from './monitored-fetch-job-page.repository';

const CUTOFF = new Date('2026-11-08T12:00:00.000Z');
const dialect = new PgDialect();

function setup(rows: unknown[] = []) {
  const builder = {
    from: vi.fn(() => builder),
    where: vi.fn<(condition: unknown) => unknown>(() => builder),
    orderBy: vi.fn<(...parts: unknown[]) => unknown>(() => builder),
    limit: vi.fn(() => Promise.resolve(rows)),
    then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
  };
  const db = { select: vi.fn(() => builder) };
  return { repository: new MonitoredFetchJobPageRepository(db as never), builder, db };
}

/** Unqualified, as the single-table read renders it. */
function rendered(condition: unknown) {
  const query = dialect.sqlToQuery(condition as SQL);
  return { ...query, sql: query.sql.replaceAll('"monitored_authors".', '') };
}

function ordered(builder: ReturnType<typeof setup>['builder']) {
  const parts = builder.orderBy.mock.calls[0]!.map((part) => rendered(part).sql);
  return parts.join(', ');
}

async function paged(view: JobView, after: JobPosition | null = null, rows: unknown[] = []) {
  const harness = setup(rows);
  const result = await harness.repository.pageForJobs({ view, ownerUserId: 7, cutoffAt: CUTOFF, after, typeIndex: 14, limit: 51 });
  return { ...harness, result };
}

describe('MonitoredFetchJobPageRepository', () => {
  it('reads nothing for Needs you', async () => {
    const { result, db } = await paged('needs-you');
    expect(result).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("keeps the Queue to the owner's queued and running fetches, running first, in the keyset order", async () => {
    const { builder } = await paged('queue');
    const where = rendered(builder.where.mock.calls[0]![0]);
    expect(where.sql).toContain('"owner_user_id" = $');
    expect(where.sql).toContain('"fetch_state" in (');
    expect(where.params).toEqual(expect.arrayContaining([7, 'fetching', 'queued']));
    expect(where.params).not.toContain('failed');
    const order = ordered(builder);
    expect(order).toMatch(/^case when "fetch_state" = 'queued' then 1 else 0 end asc, case when "fetch_state" = 'queued' then 1 else 0 end asc, /);
    expect(order).toContain('coalesce("fetch_started_at", coalesce("fetch_queued_at", "added_at"))');
    expect(order).toMatch(/"id" collate "C" asc$/);
    expect(builder.limit).toHaveBeenCalledWith(51);
  });

  it('builds a queue key from the row and continues after a cursor', async () => {
    const row = { id: 'm-1', fetchState: 'queued', group: 1, rank: 1, at: 1_700_000_000_000_000 };
    const { result, builder } = await paged('queue', { prefix: [1, 1], suffix: [1_700_000_000_000_000], id: 'm-0', typeIndex: 14 }, [row]);
    expect(result[0]).toMatchObject({ id: 'm-1', key: { prefix: [1, 1], suffix: [1_700_000_000_000_000], id: 'm-1' } });
    expect(result[0]).not.toHaveProperty('group');
    const where = rendered(builder.where.mock.calls[0]![0]);
    expect(where.params).toContain('m-0');
  });

  it('reads Failed as failed fetches that ended after the cutoff, newest first by the finish index expression', async () => {
    const { builder } = await paged('failed');
    const where = rendered(builder.where.mock.calls[0]![0]);
    expect(where.sql).toContain('"owner_user_id" = $');
    expect(where.sql).toContain('"fetch_state" = $');
    expect(where.sql).toContain('coalesce("fetch_error_at", "last_refreshed_at") > $');
    expect(where.params).toEqual(expect.arrayContaining([7, 'failed']));
    expect(ordered(builder)).toBe('coalesce("fetch_error_at", "last_refreshed_at") desc, "id" collate "C" desc');
  });

  it('reads History as finished fetches plus failures aged out, never an author that was never fetched', async () => {
    const { builder } = await paged('history');
    const where = rendered(builder.where.mock.calls[0]![0]);
    expect(where.sql).toContain(`"fetch_state" = 'idle' and "last_refreshed_at" is not null`);
    expect(where.sql).toContain(`"fetch_state" = 'failed' and coalesce("fetch_error_at", "last_refreshed_at") <= $`);
    expect(where.params).toContain(7);
    expect(ordered(builder)).toBe('coalesce("fetch_error_at", "last_refreshed_at") desc, "id" collate "C" desc');
  });

  it('counts the same rows the Queue and Failed views list, for the owner only', async () => {
    const harness = setup([{ running: 2, queued: 3000, failed: 4 }]);
    await expect(harness.repository.countForJobs(7, CUTOFF)).resolves.toEqual({
      queue: 3002,
      needsYou: 0,
      failed: 4,
      running: 2,
      queued: 3000,
      paused: 0,
    });
    const where = rendered(harness.builder.where.mock.calls[0]![0]);
    expect(where.sql).toContain('"owner_user_id" = $');
    expect(where.params).toEqual(expect.arrayContaining([7, 'fetching', 'queued', 'failed']));
  });

  it('finds action rows by id without reading when none were asked for', async () => {
    const harness = setup([{ id: 'm-1', ownerUserId: 7, fetchState: 'failed' }]);
    await expect(harness.repository.findActionRows([])).resolves.toEqual([]);
    expect(harness.db.select).not.toHaveBeenCalled();
    await expect(harness.repository.findActionRows(['m-1'])).resolves.toEqual([{ id: 'm-1', ownerUserId: 7, fetchState: 'failed' }]);
  });
});
