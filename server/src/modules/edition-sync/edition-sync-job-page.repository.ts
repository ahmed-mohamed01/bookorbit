import { Inject, Injectable } from '@nestjs/common';
import { and, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { ContentFilterRules, JobView } from '@bookorbit/types';

import { buildContentFilterClauses } from '../../common/utils/content-filter-sql.utils';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { afterPosition, keysetOrder, type JobKey, type JobPosition, type KeysetColumns } from '../jobs/job-keyset';
import {
  ELIGIBLE_SQL,
  QUEUE_ORDER_SQL,
  QUEUEABLE_ROW_SQL,
  SETTLED_PIN_SQL,
  WANTED_SQL,
  WANTING_USERS_CTE,
  libraryFilterSql,
  queueQuery,
} from './edition-sync.repository';

type Db = NodePgDatabase<typeof schema>;

/** The stored states a Jobs row stands for: a pinned waiting book reads as `queued`. */
export type EditionSyncJobRowStatus = 'running' | 'queued' | 'failed' | 'ready';

export interface EditionSyncJobPageRow {
  bookId: number;
  status: EditionSyncJobRowStatus;
  stage: string | null;
  progress: number | null;
  errorCode: string | null;
  createdAt: Date;
  lastAttemptAt: Date | null;
  pinnedAt: Date | null;
  failedAt: Date | null;
  indexedAt: Date | null;
  /** 1-based place among visible waiting books in claim order; 0 unless queued. */
  rank: number;
  pinnedCount: number;
  key: JobKey;
}

export type EditionSyncJobActionRow = {
  bookId: number;
  status: 'running' | 'ready' | 'failed' | 'stale' | 'queued';
  retryRequested: boolean;
  pinned: boolean;
};

/**
 * Which books a read covers: the viewer's visible libraries (null for every library) and their
 * content filter, as the module's own books list applies them. `runningOnly` keeps the Queue to the
 * book being built and the unpinned backlog for someone who only manages the server.
 */
export interface EditionSyncJobScope {
  libraryIds: readonly number[] | null;
  contentFilters: ContentFilterRules | null;
  runningOnly: boolean;
}

export interface EditionSyncJobPageQuery extends EditionSyncJobScope {
  view: JobView;
  includeBacklog?: boolean;
  cutoffAt: Date;
  after: JobPosition | null;
  typeIndex: number;
  limit: number;
}

export type EditionSyncJobCounts = {
  running: number;
  pinned: number;
  failed: number;
};

/** Matches the expression in `edition_sync_book_index_jobs_finish_idx`. */
const FINISH = sql`coalesce(CASE WHEN i.status = 'ready' THEN i.indexed_at ELSE i.failed_at END, i.created_at)`;
const FAILED_ROW = sql`i.status = 'failed' AND NOT i.retry_requested`;

const PAGE_COLUMNS = sql`i.book_id AS "bookId", i.stage, i.progress, i.error_code AS "errorCode", i.created_at AS "createdAt",
  i.last_attempt_at AS "lastAttemptAt", i.pinned_at AS "pinnedAt", i.failed_at AS "failedAt", i.indexed_at AS "indexedAt"`;

type RawPageRow = {
  bookId: number;
  status: EditionSyncJobRowStatus;
  stage: string | null;
  progress: number | null;
  errorCode: string | null;
  createdAt: Date | string;
  lastAttemptAt: Date | string | null;
  pinnedAt: Date | string | null;
  failedAt: Date | string | null;
  indexedAt: Date | string | null;
  grp: number;
  rank: number;
  pinnedCount: number;
  at: number | string;
};

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}

function date(value: Date | string): Date;
function date(value: Date | string | null): Date | null;
function date(value: Date | string | null): Date | null {
  return value === null ? null : new Date(value);
}

/** Edition sync index builds for the Jobs area, one row per book, over `edition_sync_book_index`. */
@Injectable()
export class EditionSyncJobPageRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async pageForJobs(query: EditionSyncJobPageQuery): Promise<EditionSyncJobPageRow[]> {
    if (query.view === 'needs-you' || query.libraryIds?.length === 0 || query.limit <= 0) return [];
    if (query.view === 'queue') return await this.queuePage(query);
    if (query.runningOnly) return [];
    return await this.settledPage(query);
  }

  /** The running build, the pinned books waiting, and the failures still inside the failed window. */
  async countForJobs(scope: EditionSyncJobScope, cutoffAt: Date, serverEnabled: boolean): Promise<EditionSyncJobCounts> {
    if (scope.libraryIds?.length === 0) return { running: 0, pinned: 0, failed: 0 };
    const claimable = serverEnabled ? sql`AND ${SETTLED_PIN_SQL}` : sql``;
    const result = await this.db.execute<EditionSyncJobCounts>(sql`
      WITH ${WANTING_USERS_CTE}
      SELECT
        count(*) FILTER (WHERE i.status = 'running')::int AS "running",
        count(*) FILTER (WHERE ${scope.runningOnly ? sql`false` : sql`i.status <> 'running' AND i.pinned_at IS NOT NULL AND ${QUEUEABLE_ROW_SQL} AND ${ELIGIBLE_SQL} AND ${WANTED_SQL} ${claimable}`})::int AS "pinned",
        count(*) FILTER (WHERE ${scope.runningOnly ? sql`false` : sql`${FAILED_ROW} AND ${FINISH} > ${cutoffAt}`})::int AS "failed"
      FROM edition_sync_book_index i
      JOIN books b ON b.id = i.book_id
      JOIN libraries l ON l.id = b.library_id
      WHERE (i.status IN ('running', 'failed') OR i.pinned_at IS NOT NULL) ${this.scoped(scope)}
    `);
    const row = rowsOf<EditionSyncJobCounts>(result)[0];
    return { running: row?.running ?? 0, pinned: row?.pinned ?? 0, failed: row?.failed ?? 0 };
  }

  /** Eligible, wanted books no run has pinned, which wait for the next scheduled or manual run. */
  async countBacklog(scope: EditionSyncJobScope): Promise<number> {
    if (scope.libraryIds?.length === 0) return 0;
    const result = await this.db.execute<{ count: number }>(
      queueQuery(sql`count(*)::int AS "count"`, sql`(i.book_id IS NULL OR i.pinned_at IS NULL) ${this.scoped(scope)}`),
    );
    return rowsOf<{ count: number }>(result)[0]?.count ?? 0;
  }

  async findActionRows(bookIds: readonly number[], scope: EditionSyncJobScope): Promise<EditionSyncJobActionRow[]> {
    if (bookIds.length === 0 || scope.libraryIds?.length === 0) return [];
    const queued = sql`${QUEUEABLE_ROW_SQL} AND ${ELIGIBLE_SQL} AND ${WANTED_SQL}`;
    const result = await this.db.execute<Omit<EditionSyncJobActionRow, 'status'> & { status: EditionSyncJobActionRow['status'] | null }>(sql`
      WITH ${WANTING_USERS_CTE}
      SELECT b.id AS "bookId",
        CASE WHEN ${queued} THEN 'queued' ELSE i.status END AS status,
        coalesce(i.retry_requested, false) AS "retryRequested", i.pinned_at IS NOT NULL AS pinned
      FROM books b
      JOIN libraries l ON l.id = b.library_id
      LEFT JOIN edition_sync_book_index i ON i.book_id = b.id
      WHERE b.id = ANY(${sql.param([...bookIds])}::integer[]) ${this.scoped(scope)}
        ${scope.runningOnly ? sql`AND (i.status = 'running' OR (i.pinned_at IS NULL AND ${queued}))` : sql``}
    `);
    return result.rows.filter((row): row is EditionSyncJobActionRow => row.status !== null);
  }

  private async queuePage(query: EditionSyncJobPageQuery): Promise<EditionSyncJobPageRow[]> {
    const columns: KeysetColumns = {
      prefix: [
        { kind: 'number', expr: sql`q.grp` },
        { kind: 'number', expr: sql`q.rank` },
      ],
      suffix: [{ kind: 'number', expr: sql`q.at` }],
      id: { kind: 'number', expr: sql`q."bookId"` },
    };
    const scoped = this.scoped(query);
    const pinned = sql`i.pinned_at IS NOT NULL`;
    const laneColumns = sql`b.id AS "bookId", i.stage, i.progress, i.error_code AS "errorCode",
      coalesce(i.created_at, b.added_at) AS "createdAt", i.last_attempt_at AS "lastAttemptAt", i.pinned_at AS "pinnedAt",
      i.failed_at AS "failedAt", i.indexed_at AS "indexedAt", 'queued' AS status, 1 AS grp,
      row_number() OVER (ORDER BY ${QUEUE_ORDER_SQL})::int AS rank,
      (count(*) FILTER (WHERE i.pinned_at IS NOT NULL) OVER ())::int AS "pinnedCount",
      (extract(epoch FROM coalesce(i.pinned_at, b.added_at)) * 1000000)::bigint AS at`;
    const waiting = query.includeBacklog
      ? queueQuery(laneColumns, sql`${SETTLED_PIN_SQL} ${scoped}`)
      : sql`WITH ${WANTING_USERS_CTE}
          SELECT ${laneColumns}
          FROM edition_sync_book_index i
          JOIN books b ON b.id = i.book_id
          JOIN libraries l ON l.id = b.library_id
          WHERE ${pinned} AND ${QUEUEABLE_ROW_SQL} AND ${ELIGIBLE_SQL} AND ${WANTED_SQL} ${scoped}`;
    const result = await this.db.execute<RawPageRow>(sql`
      WITH q AS (
        SELECT ${PAGE_COLUMNS}, 'running' AS status, 0 AS grp, 0 AS rank, 0 AS "pinnedCount",
          (extract(epoch FROM coalesce(i.last_attempt_at, i.created_at)) * 1000000)::bigint AS at
        FROM edition_sync_book_index i
        JOIN books b ON b.id = i.book_id
        WHERE i.status = 'running' ${scoped}
        ${query.runningOnly && !query.includeBacklog ? sql`` : sql`UNION ALL (${waiting})`}
      )
      SELECT * FROM q
      WHERE ${query.runningOnly ? sql`(q."pinnedAt" IS NULL OR q.grp = 0)` : sql`true`}
        ${query.after ? sql`AND ${afterPosition(columns, 'queue', query.after, query.typeIndex)}` : sql``}
      ORDER BY ${sql.join(keysetOrder(columns, 'queue'), sql`, `)}
      LIMIT ${query.limit}
    `);
    return rowsOf<RawPageRow>(result).map((row) => this.toPageRow(row, [Number(row.grp), Number(row.rank)], [Number(row.at)]));
  }

  /** Failed and History by when the build ended, newest first. */
  private async settledPage(query: EditionSyncJobPageQuery): Promise<EditionSyncJobPageRow[]> {
    const columns: KeysetColumns = { prefix: [{ kind: 'time', expr: FINISH }], suffix: [], id: { kind: 'number', expr: sql`i.book_id` } };
    const shown =
      query.view === 'failed'
        ? sql`${FAILED_ROW} AND ${FINISH} > ${query.cutoffAt}`
        : sql`(i.status = 'ready' OR (${FAILED_ROW} AND ${FINISH} <= ${query.cutoffAt}))`;
    const result = await this.db.execute<RawPageRow>(sql`
      SELECT ${PAGE_COLUMNS}, i.status, 0 AS grp, 0 AS rank, 0 AS "pinnedCount", (extract(epoch FROM ${FINISH}) * 1000000)::bigint AS at
      FROM edition_sync_book_index i
      JOIN books b ON b.id = i.book_id
      WHERE ${shown} ${this.scoped(query)}
        ${query.after ? sql`AND ${afterPosition(columns, query.view, query.after, query.typeIndex)}` : sql``}
      ORDER BY ${sql.join(keysetOrder(columns, query.view), sql`, `)}
      LIMIT ${query.limit}
    `);
    return rowsOf<RawPageRow>(result).map((row) => this.toPageRow(row, [Number(row.at)], []));
  }

  private toPageRow(row: RawPageRow, prefix: number[], suffix: number[]): EditionSyncJobPageRow {
    return {
      bookId: row.bookId,
      status: row.status,
      stage: row.stage,
      progress: row.progress,
      errorCode: row.errorCode,
      createdAt: date(row.createdAt),
      lastAttemptAt: date(row.lastAttemptAt),
      pinnedAt: date(row.pinnedAt),
      failedAt: date(row.failedAt),
      indexedAt: date(row.indexedAt),
      pinnedCount: Number(row.pinnedCount ?? 0),
      rank: row.status === 'queued' ? Number(row.rank) : 0,
      key: { prefix, suffix, id: row.bookId },
    };
  }

  /** Library and content filter on the book alias `b`, as `EditionSyncRepository.listScope` applies them. */
  scoped(scope: Pick<EditionSyncJobScope, 'libraryIds' | 'contentFilters'>): SQL {
    const clauses = scope.contentFilters ? buildContentFilterClauses(scope.contentFilters, this.db) : [];
    // The content filter clauses reference the unaliased "books" table, so they run in their own scope.
    const content = clauses.length > 0 ? sql`AND EXISTS (SELECT 1 FROM books WHERE books.id = b.id AND ${and(...clauses)})` : sql``;
    return sql`${libraryFilterSql(scope.libraryIds)} ${content}`;
  }
}
