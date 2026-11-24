import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { rotateQueuedJobs } from '../../common/utils/fork-queue-reorder.utils';

describe('relative queue ordering', () => {
  it.each([
    [5, 1, 'before', [5, 90, 1, 2, 3, 4, 6]],
    [1, 5, 'after', [2, 90, 3, 4, 5, 1, 6]],
    [5, 1, 'after', [1, 90, 5, 2, 3, 4, 6]],
    [1, 5, 'before', [2, 90, 3, 4, 1, 5, 6]],
    [2, 1, 'after', [1, 90, 2, 3, 4, 5, 6]],
  ] as const)('places %s relative to %s (%s) and preserves the other lane', (id, targetId, place, expected) => {
    using db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE jobs (id integer PRIMARY KEY, queue_order bigint, user_id integer, status text);
      INSERT INTO jobs VALUES (1, -50, 7, 'queued'), (90, -5, 8, 'queued'), (2, 15, 7, 'queued'),
        (3, 30, 7, 'queued'), (4, 45, 7, 'queued'), (6, 75, 7, 'queued'), (5, 60, 7, 'queued'),
        (91, 31, 7, 'running');
    `);
    db.function('least', (left, right) => Math.min(Number(left), Number(right)));
    db.function('greatest', (left, right) => Math.max(Number(left), Number(right)));
    const query = new PgDialect().sqlToQuery(rotateQueuedJobs(sql`jobs`, id, targetId, place, sql`q.user_id = ${7}`));
    expect(query.sql).toContain('FOR UPDATE OF q');
    const bindings = Object.fromEntries(query.params.map((value, index) => [`$${index + 1}`, typeof value === 'boolean' ? Number(value) : value]));
    db.prepare(query.sql.replace('FOR UPDATE OF q', '').replace('RETURNING q.id', 'RETURNING id')).all(bindings as Record<string, SQLInputValue>);

    const rows = db.prepare("SELECT id, queue_order FROM jobs WHERE status = 'queued' ORDER BY queue_order").all();
    expect(rows.map((row) => row.id)).toEqual(expected);
    expect(rows.find((row) => row.id === 90)?.queue_order).toBe(-5);
    expect(db.prepare('SELECT queue_order FROM jobs WHERE id = 91').get()?.queue_order).toBe(31);
  });
});
