import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import { AudioConvertRepository } from './audio-convert.repository';

const JOB_ID = '3f2a7c1e-0b5d-4e8a-9c3f-1d2e3f4a5b6c';
const dialect = new PgDialect();

function setup(ids: string[]) {
  const execute = vi
    .fn<(query: SQL) => Promise<{ rows: { id: string }[] }>>()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: ids.map((id) => ({ id })) });
  const transaction = vi.fn((work: (tx: { execute: typeof execute }) => Promise<unknown>) => work({ execute }));
  return { repo: new AudioConvertRepository({ transaction } as never), execute };
}

describe('AudioConvertRepository queue order', () => {
  it('moves a queued conversion to the front under the queue lock', async () => {
    const { repo, execute } = setup([JOB_ID]);
    await expect(repo.reorderJob(JOB_ID, 5, [5, 8], 'move-to-top')).resolves.toBe(true);
    expect(dialect.sqlToQuery(execute.mock.calls[0]![0]).sql).toContain('pg_advisory_xact_lock');
    const { sql, params } = dialect.sqlToQuery(execute.mock.calls[1]![0]);
    expect(sql).toContain("SET queue_order = nextval('audio_convert_queue_front_seq')");
    expect(sql).toContain("q.status = 'queued'");
    expect(params).toContainEqual([5, 8]);
  });

  it.each([true, false])('changes both queued neighbours or skips, moved=%s', async (moved) => {
    const { repo, execute } = setup(moved ? [JOB_ID, 'neighbour'] : []);
    await expect(repo.reorderJob(JOB_ID, 5, [5, 8], 'move-down')).resolves.toBe(moved);
    expect(dialect.sqlToQuery(execute.mock.calls[0]![0]).sql).toContain('pg_advisory_xact_lock');
    const query = dialect.sqlToQuery(execute.mock.calls[1]![0]);
    expect(query.sql).toContain('(q.queue_order, q.id) > (t.queue_order, t.id)');
    expect(query.sql).toContain("q.status = 'queued'");
    expect(query.sql).toContain('FOR UPDATE OF q');
    expect(query.sql).toContain('SET queue_order = other.queue_order');
    expect(query.params).toContainEqual([5, 8]);
  });

  it.each([
    [{ id: 'other', allowed: true, queued: true }, 'done'],
    [{ id: 'other', allowed: false, queued: true }, 'refused'],
    [{ id: 'other', allowed: true, queued: false }, 'skipped'],
  ] as const)('respects the editable-library lane and queued state (%s)', async (target, outcome) => {
    const execute = vi
      .fn<(query: SQL) => Promise<{ rows: unknown[] }>>()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: JOB_ID, allowed: true, queued: true }, target] })
      .mockResolvedValueOnce({ rows: [{ id: JOB_ID }, { id: 'other' }] });
    const transaction = vi.fn((work: (tx: { execute: typeof execute }) => Promise<unknown>) => work({ execute }));
    const repo = new AudioConvertRepository({ transaction } as never);
    await expect(repo.reorderTo(JOB_ID, 'other', 'before', 5, [5, 8])).resolves.toBe(outcome);
    const scope = dialect.sqlToQuery(execute.mock.calls[1]![0]);
    expect(scope.sql).toContain('q.library_id = ANY');
    expect(scope.params).toContainEqual([5, 8]);
    expect(execute).toHaveBeenCalledTimes(outcome === 'done' ? 3 : 2);
  });

  it('uses the same queue order when claiming due jobs', async () => {
    const { repo, execute } = setup([]);
    await expect(repo.claim()).resolves.toBeNull();
    const { sql } = dialect.sqlToQuery(execute.mock.calls[1]![0]);
    expect(sql).toContain('ORDER BY queue_order, id LIMIT 1 FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('next_step_at <= now()');
  });
});
