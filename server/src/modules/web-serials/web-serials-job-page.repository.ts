import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { JobCounts, JobView, WebSerialJobCurrentUnit, WebSerialJobStatus } from '@bookorbit/types';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import { users } from '../../db/schema';
import { afterPosition, keysetOrder, microseconds, type JobKey, type JobPosition, type KeysetColumns } from '../jobs/job-keyset';
import { webSerialJobs, type WebSerialJobRow } from './schema/web-serials.schema';

type Db = NodePgDatabase<typeof schema>;

const RUNNING: WebSerialJobStatus[] = ['running', 'importing'];
const IN_QUEUE: WebSerialJobStatus[] = [...RUNNING, 'queued', 'paused'];
/** The statuses `web_serial_jobs_jobs_area_idx` covers: the Queue and the Failed view. */
const COUNTED: WebSerialJobStatus[] = [...IN_QUEUE, 'failed'];
/** Matches the expression in `web_serial_jobs_finish_idx` and `web_serial_jobs_user_finish_idx`. */
const FINISH = sql`coalesce(${webSerialJobs.finishedAt}, ${webSerialJobs.updatedAt})`;
const UNPLACED = 2_147_483_647;

const PAGE_COLUMNS = {
  id: webSerialJobs.id,
  userId: webSerialJobs.userId,
  kind: webSerialJobs.kind,
  seriesKey: webSerialJobs.seriesKey,
  title: webSerialJobs.title,
  author: webSerialJobs.author,
  status: webSerialJobs.status,
  unitsTotal: webSerialJobs.unitsTotal,
  unitsDone: webSerialJobs.unitsDone,
  unitsFailed: webSerialJobs.unitsFailed,
  unitsSkipped: webSerialJobs.unitsSkipped,
  currentUnit: webSerialJobs.currentUnit,
  createdAt: webSerialJobs.createdAt,
  startedAt: webSerialJobs.startedAt,
  finishedAt: webSerialJobs.finishedAt,
  updatedAt: webSerialJobs.updatedAt,
  hasCover: sql<boolean>`coalesce((${webSerialJobs.engineState}->>'hasCover')::boolean, false)`,
  ownerName: users.name,
};

export type WebSerialJobPageRow = Pick<
  WebSerialJobRow,
  | 'id'
  | 'userId'
  | 'kind'
  | 'seriesKey'
  | 'title'
  | 'author'
  | 'status'
  | 'unitsTotal'
  | 'unitsDone'
  | 'unitsFailed'
  | 'unitsSkipped'
  | 'createdAt'
  | 'startedAt'
  | 'finishedAt'
  | 'updatedAt'
> & {
  currentUnit: WebSerialJobCurrentUnit | null;
  hasCover: boolean;
  ownerName: string | null;
  /** 1-based place among every queued job, in claim order; 0 unless queued. */
  rank: number;
  /** 1-based place among the owner's own queued jobs; 0 unless queued. */
  ownRank: number;
  laneSize: number;
  ownLaneSize: number;
  key: JobKey;
};

export type WebSerialJobActionRow = Pick<WebSerialJobRow, 'id' | 'userId' | 'status'>;

/** Null reads every account's jobs. A web serial job always has an owner. */
export type WebSerialJobOwnerFilter = { id: number } | null;

export interface WebSerialJobPageQuery {
  view: JobView;
  owner: WebSerialJobOwnerFilter;
  cutoffAt: Date;
  after: JobPosition | null;
  typeIndex: number;
  limit: number;
}

/** Web serial downloads for the Jobs area. The queue is read in the runner's claim order (`queue_order, id`). */
@Injectable()
export class WebSerialsJobPageRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async pageForJobs(query: WebSerialJobPageQuery): Promise<WebSerialJobPageRow[]> {
    if (query.view === 'needs-you') return [];
    return query.view === 'queue' ? await this.queuePage(query) : await this.settledPage(query);
  }

  async countForJobs(owner: WebSerialJobOwnerFilter, cutoffAt: Date): Promise<JobCounts> {
    const [row] = await this.db
      .select({
        running: sql<number>`count(*) filter (where ${inArray(webSerialJobs.status, RUNNING)})`.mapWith(Number),
        queued: sql<number>`count(*) filter (where ${webSerialJobs.status} = 'queued')`.mapWith(Number),
        paused: sql<number>`count(*) filter (where ${webSerialJobs.status} = 'paused')`.mapWith(Number),
        failed: sql<number>`count(*) filter (where ${this.failedShown(cutoffAt)})`.mapWith(Number),
      })
      .from(webSerialJobs)
      .where(and(inArray(webSerialJobs.status, COUNTED), this.owned(owner)));
    const running = row?.running ?? 0;
    const queued = row?.queued ?? 0;
    const paused = row?.paused ?? 0;
    return { queue: running + queued + paused, needsYou: 0, failed: row?.failed ?? 0, running, queued, paused };
  }

  async findActionRows(ids: readonly number[]): Promise<WebSerialJobActionRow[]> {
    if (ids.length === 0) return [];
    return await this.db
      .select({ id: webSerialJobs.id, userId: webSerialJobs.userId, status: webSerialJobs.status })
      .from(webSerialJobs)
      .where(inArray(webSerialJobs.id, [...ids]));
  }

  /** Running first, then queued jobs in claim order, then paused ones. */
  private async queuePage(query: WebSerialJobPageQuery): Promise<WebSerialJobPageRow[]> {
    // Aliased: drizzle renders column references unqualified, which inside a subquery would bind to the wrong row.
    const lane = this.db.$with('web_serial_lane').as(
      this.db
        .select({
          laneId: sql<number>`lane.id`.as('lane_id'),
          place: sql<number>`lane.place`.as('place'),
          ownPlace: sql<number>`lane.own_place`.as('own_place'),
          laneSize: sql<number>`lane.lane_size`.as('lane_size'),
          ownLaneSize: sql<number>`lane.own_lane_size`.as('own_lane_size'),
        })
        .from(
          sql`(select q.id, row_number() over (order by q.queue_order, q.id) as place, row_number() over (partition by q.user_id order by q.queue_order, q.id) as own_place, count(*) over () as lane_size, count(*) over (partition by q.user_id) as own_lane_size from web_serial_jobs q where q.status = 'queued') lane`,
        ),
    );
    const status = webSerialJobs.status;
    const group = sql<number>`case when ${inArray(status, RUNNING)} then 0 when ${status} = 'queued' then 1 else 2 end`;
    const rank = sql<number>`case when ${status} = 'queued' then coalesce(${lane.place}, ${UNPLACED}) else 0 end`;
    // Started, not updated: progress moves `updated_at`, and a key must not shift while it is paged.
    const at = microseconds(
      sql`case when ${inArray(status, RUNNING)} then coalesce(${webSerialJobs.startedAt}, ${webSerialJobs.createdAt}) else ${webSerialJobs.createdAt} end`,
    );
    const columns: KeysetColumns = {
      prefix: [
        { kind: 'number', expr: group },
        { kind: 'number', expr: rank },
      ],
      suffix: [{ kind: 'number', expr: at }],
      id: { kind: 'number', expr: sql`${webSerialJobs.id}` },
    };
    const rows = await this.db
      .with(lane)
      .select({
        ...PAGE_COLUMNS,
        group: sql<number>`${group}`.mapWith(Number),
        rank: sql<number>`${rank}`.mapWith(Number),
        ownRank: sql<number>`coalesce(${lane.ownPlace}, 0)`.mapWith(Number),
        laneSize: sql<number>`coalesce(${lane.laneSize}, 0)`.mapWith(Number),
        ownLaneSize: sql<number>`coalesce(${lane.ownLaneSize}, 0)`.mapWith(Number),
        at,
      })
      .from(webSerialJobs)
      .leftJoin(lane, eq(lane.laneId, webSerialJobs.id))
      .leftJoin(users, eq(users.id, webSerialJobs.userId))
      .where(
        and(
          inArray(webSerialJobs.status, IN_QUEUE),
          this.owned(query.owner),
          query.after ? afterPosition(columns, 'queue', query.after, query.typeIndex) : undefined,
        ),
      )
      .orderBy(...keysetOrder(columns, 'queue'))
      .limit(query.limit);
    return rows.map(({ group: band, rank: place, at: since, ...row }) => ({
      ...row,
      rank: place,
      key: { prefix: [band, place], suffix: [since], id: row.id },
    }));
  }

  /** Failed and History by when the job finished, newest first. */
  private async settledPage(query: WebSerialJobPageQuery): Promise<WebSerialJobPageRow[]> {
    const columns: KeysetColumns = { prefix: [{ kind: 'time', expr: FINISH }], suffix: [], id: { kind: 'number', expr: sql`${webSerialJobs.id}` } };
    const rows = await this.db
      .select({ ...PAGE_COLUMNS, finish: microseconds(FINISH) })
      .from(webSerialJobs)
      .leftJoin(users, eq(users.id, webSerialJobs.userId))
      .where(
        and(
          query.view === 'failed' ? this.failedShown(query.cutoffAt) : this.historyShown(query.cutoffAt),
          this.owned(query.owner),
          query.after ? afterPosition(columns, query.view, query.after, query.typeIndex) : undefined,
        ),
      )
      .orderBy(...keysetOrder(columns, query.view))
      .limit(query.limit);
    return rows.map(({ finish, ...row }) => ({
      ...row,
      rank: 0,
      ownRank: 0,
      laneSize: 0,
      ownLaneSize: 0,
      key: { prefix: [finish], suffix: [], id: row.id },
    }));
  }

  private failedShown(cutoffAt: Date): SQL {
    return and(eq(webSerialJobs.status, 'failed'), sql`${FINISH} > ${cutoffAt}`)!;
  }

  private historyShown(cutoffAt: Date): SQL {
    return sql`(${inArray(webSerialJobs.status, ['completed', 'completed_with_gaps', 'cancelled'])} or (${webSerialJobs.status} = 'failed' and ${FINISH} <= ${cutoffAt}))`;
  }

  private owned(owner: WebSerialJobOwnerFilter): SQL | undefined {
    return owner === null ? undefined : eq(webSerialJobs.userId, owner.id);
  }
}
