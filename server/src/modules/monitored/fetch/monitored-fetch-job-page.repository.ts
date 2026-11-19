import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { JobCounts, JobView, MonitoredFetchState } from '@bookorbit/types';

import { DB } from '../../../db';
import * as dbSchema from '../../../db/schema';
import { afterPosition, keysetOrder, microseconds, type JobKey, type JobPosition, type KeysetColumns } from '../../jobs/job-keyset';
import { monitoredAuthors, type MonitoredAuthorRow } from '../schema/monitored.schema';

type Db = NodePgDatabase<typeof dbSchema>;

const t = monitoredAuthors;
const IN_QUEUE: MonitoredFetchState[] = ['fetching', 'queued'];
/**
 * When the author's latest fetch ended: a failure stamps `fetch_error_at`, a success
 * `last_refreshed_at`, and each clears the other's meaning. Matches `monitored_authors_fetch_finish_idx`.
 */
const FINISH = sql`coalesce(${t.fetchErrorAt}, ${t.lastRefreshedAt})`;
const QUEUED_AT = sql`coalesce(${t.fetchQueuedAt}, ${t.addedAt})`;

const PAGE_COLUMNS = {
  id: t.id,
  ownerUserId: t.ownerUserId,
  authorName: t.authorName,
  localAuthorId: t.localAuthorId,
  fetchState: t.fetchState,
  fetchErrorKind: t.fetchErrorKind,
  fetchErrorAt: t.fetchErrorAt,
  fetchRetryAt: t.fetchRetryAt,
  fetchQueuedAt: t.fetchQueuedAt,
  fetchStartedAt: t.fetchStartedAt,
  addedAt: t.addedAt,
  lastRefreshedAt: t.lastRefreshedAt,
};

export type MonitoredFetchJobPageRow = Pick<
  MonitoredAuthorRow,
  | 'id'
  | 'ownerUserId'
  | 'authorName'
  | 'localAuthorId'
  | 'fetchState'
  | 'fetchErrorKind'
  | 'fetchErrorAt'
  | 'fetchRetryAt'
  | 'fetchQueuedAt'
  | 'fetchStartedAt'
  | 'addedAt'
  | 'lastRefreshedAt'
> & { key: JobKey };

export type MonitoredFetchJobActionRow = Pick<MonitoredAuthorRow, 'id' | 'ownerUserId' | 'fetchState'>;

export interface MonitoredFetchJobPageQuery {
  view: JobView;
  ownerUserId: number;
  cutoffAt: Date;
  after: JobPosition | null;
  typeIndex: number;
  limit: number;
}

/**
 * Watchlist updates for the Jobs area: one row per monitored author, its latest fetch. Every read is
 * the owner's own, the way the Watchlist routes read. Failed and History share the finish index;
 * the Queue and the counts read the owner's non-idle rows through `monitored_authors_fetch_owner_idx`.
 */
@Injectable()
export class MonitoredFetchJobPageRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async pageForJobs(query: MonitoredFetchJobPageQuery): Promise<MonitoredFetchJobPageRow[]> {
    if (query.view === 'needs-you') return [];
    return query.view === 'queue' ? await this.queuePage(query) : await this.settledPage(query);
  }

  async countForJobs(ownerUserId: number, cutoffAt: Date): Promise<JobCounts> {
    const [row] = await this.db
      .select({
        running: sql<number>`count(*) filter (where ${t.fetchState} = 'fetching')`.mapWith(Number),
        queued: sql<number>`count(*) filter (where ${t.fetchState} = 'queued')`.mapWith(Number),
        failed: sql<number>`count(*) filter (where ${this.failedShown(cutoffAt)})`.mapWith(Number),
      })
      .from(t)
      .where(and(eq(t.ownerUserId, ownerUserId), inArray(t.fetchState, [...IN_QUEUE, 'failed'])));
    const running = row?.running ?? 0;
    const queued = row?.queued ?? 0;
    return { queue: running + queued, needsYou: 0, failed: row?.failed ?? 0, running, queued, paused: 0 };
  }

  async findActionRows(ids: readonly string[]): Promise<MonitoredFetchJobActionRow[]> {
    if (ids.length === 0) return [];
    return await this.db
      .select({ id: t.id, ownerUserId: t.ownerUserId, fetchState: t.fetchState })
      .from(t)
      .where(inArray(t.id, [...ids]));
  }

  /**
   * Running first by when the fetch began, then queued ones by when they were queued. Two fetches
   * run side by side and a refill reads the rest in its own order, so no queued row claims a place.
   */
  private async queuePage(query: MonitoredFetchJobPageQuery): Promise<MonitoredFetchJobPageRow[]> {
    const queued = sql`${t.fetchState} = 'queued'`;
    const group = sql<number>`case when ${queued} then 1 else 0 end`;
    const rank = sql<number>`case when ${queued} then 1 else 0 end`;
    const at = microseconds(sql`case when ${queued} then ${QUEUED_AT} else coalesce(${t.fetchStartedAt}, ${QUEUED_AT}) end`);
    const columns: KeysetColumns = {
      prefix: [
        { kind: 'number', expr: group },
        { kind: 'number', expr: rank },
      ],
      suffix: [{ kind: 'number', expr: at }],
      id: { kind: 'text', expr: sql`${t.id}` },
    };
    const rows = await this.db
      .select({ ...PAGE_COLUMNS, group: group.mapWith(Number), rank: rank.mapWith(Number), at })
      .from(t)
      .where(
        and(
          eq(t.ownerUserId, query.ownerUserId),
          inArray(t.fetchState, IN_QUEUE),
          query.after ? afterPosition(columns, 'queue', query.after, query.typeIndex) : undefined,
        ),
      )
      .orderBy(...keysetOrder(columns, 'queue'))
      .limit(query.limit);
    return rows.map(({ group: band, rank: place, at: since, ...row }) => ({ ...row, key: { prefix: [band, place], suffix: [since], id: row.id } }));
  }

  /** Failed and History by when the fetch ended, newest first. */
  private async settledPage(query: MonitoredFetchJobPageQuery): Promise<MonitoredFetchJobPageRow[]> {
    const columns: KeysetColumns = { prefix: [{ kind: 'time', expr: FINISH }], suffix: [], id: { kind: 'text', expr: sql`${t.id}` } };
    const rows = await this.db
      .select({ ...PAGE_COLUMNS, finish: microseconds(FINISH) })
      .from(t)
      .where(
        and(
          eq(t.ownerUserId, query.ownerUserId),
          query.view === 'failed' ? this.failedShown(query.cutoffAt) : this.historyShown(query.cutoffAt),
          query.after ? afterPosition(columns, query.view, query.after, query.typeIndex) : undefined,
        ),
      )
      .orderBy(...keysetOrder(columns, query.view))
      .limit(query.limit);
    return rows.map(({ finish, ...row }) => ({ ...row, key: { prefix: [finish], suffix: [], id: row.id } }));
  }

  private failedShown(cutoffAt: Date): SQL {
    return and(eq(t.fetchState, 'failed'), sql`${FINISH} > ${cutoffAt}`)!;
  }

  /** A finished fetch, or a failed one that aged out of Failed. An author never fetched has no row here. */
  private historyShown(cutoffAt: Date): SQL {
    return sql`((${t.fetchState} = 'idle' and ${isNotNull(t.lastRefreshedAt)}) or (${t.fetchState} = 'failed' and ${FINISH} <= ${cutoffAt}))`;
  }
}
