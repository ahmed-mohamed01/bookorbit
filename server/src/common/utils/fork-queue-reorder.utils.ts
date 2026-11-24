import type { JobReorderRequest, JobReorderResult } from '@bookorbit/types';
import { sql, type SQL } from 'drizzle-orm';

export type QueueDirection = 'move-up' | 'move-down';
export type QueueMove = QueueDirection | 'move-to-top';

export function queueNeighbour(direction: QueueDirection): { compare: SQL; order: SQL } {
  return direction === 'move-up' ? { compare: sql`<`, order: sql`DESC` } : { compare: sql`>`, order: sql`ASC` };
}

export function swapQueuedJobs(table: SQL, id: string | number, scope: SQL, direction: QueueDirection, targetScope = scope): SQL {
  const { compare, order } = queueNeighbour(direction);
  return sql`
    WITH target AS MATERIALIZED (
      SELECT id, queue_order FROM ${table} q WHERE q.id = ${id} AND status = 'queued' AND ${targetScope}
    ), neighbour AS MATERIALIZED (
      SELECT q.id, q.queue_order FROM ${table} q, target t
      WHERE q.status = 'queued' AND ${scope}
        AND (q.queue_order, q.id) ${compare} (t.queue_order, t.id)
      ORDER BY q.queue_order ${order}, q.id ${order} LIMIT 1
    ), locked AS MATERIALIZED (
      SELECT q.id, q.queue_order FROM ${table} q
      JOIN (SELECT * FROM target UNION ALL SELECT * FROM neighbour) pair USING (id, queue_order)
      WHERE q.status = 'queued' AND ${scope} AND (q.id <> ${id} OR (${targetScope}))
      ORDER BY q.id FOR UPDATE OF q
    )
    UPDATE ${table} q SET queue_order = other.queue_order
    FROM locked own, locked other
    WHERE q.id = own.id AND other.id <> own.id
    RETURNING q.id`;
}

type QueueJobId = string | number;

export type QueueDropOutcome = Extract<JobReorderResult['outcome'], 'done' | 'refused' | 'skipped'>;

export function lockQueueDropJobs(table: SQL, id: QueueJobId, targetId: QueueJobId, scope: SQL): SQL {
  return sql`
    SELECT q.id, q.status = 'queued' AS queued, (${scope}) AS allowed
    FROM ${table} q WHERE q.id IN (${id}, ${targetId})
    ORDER BY q.id FOR UPDATE`;
}

/** Rotate the existing keys within the affected lane, including when other lanes occupy the gaps. */
export function rotateQueuedJobs(table: SQL, id: QueueJobId, targetId: QueueJobId, place: JobReorderRequest['place'], scope: SQL): SQL {
  return sql`
    WITH bounds AS (
      SELECT own.id AS own_id, target.id AS target_id, own.queue_order AS own_order, target.queue_order AS target_order,
        (own.queue_order, own.id) > (target.queue_order, target.id) AS up
      FROM ${table} own CROSS JOIN ${table} target
      WHERE own.id = ${id} AND target.id = ${targetId}
    ), locked AS MATERIALIZED (
      SELECT q.id, q.queue_order, b.up FROM ${table} q CROSS JOIN bounds b
      WHERE q.status = 'queued' AND ${scope}
        AND (q.queue_order, q.id) >= (least(b.own_order, b.target_order), CASE WHEN b.up THEN b.target_id ELSE b.own_id END)
        AND (q.queue_order, q.id) <= (greatest(b.own_order, b.target_order), CASE WHEN b.up THEN b.own_id ELSE b.target_id END)
        AND (q.id <> ${targetId} OR b.up = ${place === 'before'})
      ORDER BY q.id FOR UPDATE OF q
    ), rotated AS (
      SELECT id, queue_order,
        CASE WHEN up THEN
          CASE WHEN id = ${id} THEN min(queue_order) OVER () ELSE lead(queue_order) OVER lane END
        ELSE
          CASE WHEN id = ${id} THEN max(queue_order) OVER () ELSE lag(queue_order) OVER lane END
        END AS next_order
      FROM locked WINDOW lane AS (ORDER BY queue_order, id)
    )
    UPDATE ${table} AS q SET queue_order = rotated.next_order FROM rotated
    WHERE q.id = rotated.id AND rotated.queue_order <> rotated.next_order
    RETURNING q.id`;
}
