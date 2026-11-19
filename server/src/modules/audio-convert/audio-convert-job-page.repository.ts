import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { AudioConvertJobStatus, JobCounts, JobView } from '@bookorbit/types';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import { users } from '../../db/schema';
import { afterPosition, keysetOrder, microseconds, type JobKey, type JobPosition, type KeysetColumns } from '../jobs/job-keyset';
import { audioConvertJobs, type AudioConvertJobRow } from './schema/audio-convert.schema';

type Db = NodePgDatabase<typeof schema>;

const IN_QUEUE: AudioConvertJobStatus[] = ['running', 'queued', 'waiting'];
/** The statuses `audio_convert_jobs_jobs_area_idx` covers: the Queue and the Failed view. */
const COUNTED: AudioConvertJobStatus[] = [...IN_QUEUE, 'failed'];
/**
 * Matches the expression in the finish indexes. Created, not updated, as the fallback: housekeeping
 * touches `updated_at` when it deletes a backup, and a key must not shift while it is paged.
 */
const FINISH = sql`coalesce(${audioConvertJobs.finishedAt}, ${audioConvertJobs.createdAt})`;
const UNPLACED = 2_147_483_647;

const PAGE_COLUMNS = {
  id: audioConvertJobs.id,
  bookId: audioConvertJobs.bookId,
  libraryId: audioConvertJobs.libraryId,
  userId: audioConvertJobs.userId,
  trigger: audioConvertJobs.trigger,
  status: audioConvertJobs.status,
  stage: audioConvertJobs.stage,
  progress: audioConvertJobs.progress,
  errorCode: audioConvertJobs.errorCode,
  createdAt: audioConvertJobs.createdAt,
  startedAt: audioConvertJobs.startedAt,
  finishedAt: audioConvertJobs.finishedAt,
  ownerName: users.name,
};

export type AudioConvertJobPageRow = Pick<
  AudioConvertJobRow,
  'id' | 'bookId' | 'libraryId' | 'userId' | 'trigger' | 'status' | 'stage' | 'progress' | 'errorCode' | 'createdAt' | 'startedAt' | 'finishedAt'
> & {
  ownerName: string | null;
  /** 1-based place among queued jobs in claim order; 0 unless queued. */
  rank: number;
  key: JobKey;
};

export type AudioConvertJobActionRow = Pick<AudioConvertJobRow, 'id' | 'bookId' | 'libraryId' | 'userId' | 'status' | 'stage'>;

/**
 * Automatic jobs are stored under the admin who last saved the settings, but nobody started them, so
 * they read as ownerless: never counted as that admin's own.
 */
const SYSTEM = or(isNull(audioConvertJobs.userId), eq(audioConvertJobs.trigger, 'auto'))!;

/**
 * Whose jobs a read covers. `ownerless` adds the jobs no account started. `libraryIds` keeps it to the
 * libraries the viewer may edit, as the tool's own routes do; null for every library.
 */
export interface AudioConvertJobScope {
  owner: { id: number; ownerless: boolean } | null;
  libraryIds: readonly number[] | null;
}

export interface AudioConvertJobPageQuery extends AudioConvertJobScope {
  view: JobView;
  cutoffAt: Date;
  after: JobPosition | null;
  typeIndex: number;
  limit: number;
}

/** Convert to M4B jobs for the Jobs area. One worker claims queued jobs oldest first. */
@Injectable()
export class AudioConvertJobPageRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async pageForJobs(query: AudioConvertJobPageQuery): Promise<AudioConvertJobPageRow[]> {
    if (query.view === 'needs-you' || query.libraryIds?.length === 0) return [];
    return query.view === 'queue' ? await this.queuePage(query) : await this.settledPage(query);
  }

  async countForJobs(scope: AudioConvertJobScope, cutoffAt: Date): Promise<JobCounts> {
    if (scope.libraryIds?.length === 0) return { queue: 0, needsYou: 0, failed: 0, running: 0, queued: 0, paused: 0 };
    const [row] = await this.db
      .select({
        running: sql<number>`count(*) filter (where ${audioConvertJobs.status} = 'running')`.mapWith(Number),
        queued: sql<number>`count(*) filter (where ${audioConvertJobs.status} = 'queued')`.mapWith(Number),
        paused: sql<number>`count(*) filter (where ${audioConvertJobs.status} = 'waiting')`.mapWith(Number),
        failed: sql<number>`count(*) filter (where ${this.failedShown(cutoffAt)})`.mapWith(Number),
      })
      .from(audioConvertJobs)
      .where(and(inArray(audioConvertJobs.status, COUNTED), this.scoped(scope)));
    const running = row?.running ?? 0;
    const queued = row?.queued ?? 0;
    const paused = row?.paused ?? 0;
    return { queue: running + queued + paused, needsYou: 0, failed: row?.failed ?? 0, running, queued, paused };
  }

  async findActionRows(ids: readonly string[], libraryIds: readonly number[] | null): Promise<AudioConvertJobActionRow[]> {
    if (ids.length === 0 || libraryIds?.length === 0) return [];
    return await this.db
      .select({
        id: audioConvertJobs.id,
        bookId: audioConvertJobs.bookId,
        libraryId: audioConvertJobs.libraryId,
        userId: audioConvertJobs.userId,
        status: audioConvertJobs.status,
        stage: audioConvertJobs.stage,
      })
      .from(audioConvertJobs)
      .where(and(inArray(audioConvertJobs.id, [...ids]), this.inLibraries(libraryIds)));
  }

  /** Running first, then queued jobs in claim order, then books still waiting in the automatic pipeline. */
  private async queuePage(query: AudioConvertJobPageQuery): Promise<AudioConvertJobPageRow[]> {
    // Aliased: drizzle renders column references unqualified, which inside a subquery would bind to the wrong row.
    const lane = this.db
      .$with('audio_convert_lane')
      .as(
        this.db
          .select({ laneId: sql<string>`lane.id`.as('lane_id'), place: sql<number>`lane.place`.as('place') })
          .from(
            sql`(select q.id, row_number() over (order by q.created_at, q.id) as place from audio_convert_jobs q where q.status = 'queued') lane`,
          ),
      );
    const status = audioConvertJobs.status;
    const group = sql<number>`case when ${status} = 'running' then 0 when ${status} = 'queued' then 1 else 2 end`;
    const rank = sql<number>`case when ${status} = 'queued' then coalesce(${lane.place}, ${UNPLACED}) else 0 end`;
    const at = microseconds(
      sql`case when ${status} = 'running' then coalesce(${audioConvertJobs.startedAt}, ${audioConvertJobs.createdAt}) else ${audioConvertJobs.createdAt} end`,
    );
    const columns: KeysetColumns = {
      prefix: [
        { kind: 'number', expr: group },
        { kind: 'number', expr: rank },
      ],
      suffix: [{ kind: 'number', expr: at }],
      id: { kind: 'uuid', expr: sql`${audioConvertJobs.id}` },
    };
    const rows = await this.db
      .with(lane)
      .select({
        ...PAGE_COLUMNS,
        group: sql<number>`${group}`.mapWith(Number),
        rank: sql<number>`${rank}`.mapWith(Number),
        at,
      })
      .from(audioConvertJobs)
      .leftJoin(lane, eq(lane.laneId, audioConvertJobs.id))
      .leftJoin(users, eq(users.id, audioConvertJobs.userId))
      .where(
        and(
          inArray(audioConvertJobs.status, IN_QUEUE),
          this.scoped(query),
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
  private async settledPage(query: AudioConvertJobPageQuery): Promise<AudioConvertJobPageRow[]> {
    const columns: KeysetColumns = { prefix: [{ kind: 'time', expr: FINISH }], suffix: [], id: { kind: 'uuid', expr: sql`${audioConvertJobs.id}` } };
    const rows = await this.db
      .select({ ...PAGE_COLUMNS, finish: microseconds(FINISH) })
      .from(audioConvertJobs)
      .leftJoin(users, eq(users.id, audioConvertJobs.userId))
      .where(
        and(
          query.view === 'failed' ? this.failedShown(query.cutoffAt) : this.historyShown(query.cutoffAt),
          this.scoped(query),
          query.after ? afterPosition(columns, query.view, query.after, query.typeIndex) : undefined,
        ),
      )
      .orderBy(...keysetOrder(columns, query.view))
      .limit(query.limit);
    return rows.map(({ finish, ...row }) => ({ ...row, rank: 0, key: { prefix: [finish], suffix: [], id: row.id } }));
  }

  private failedShown(cutoffAt: Date): SQL {
    return and(eq(audioConvertJobs.status, 'failed'), sql`${FINISH} > ${cutoffAt}`)!;
  }

  private historyShown(cutoffAt: Date): SQL {
    return sql`(${inArray(audioConvertJobs.status, ['success', 'skipped', 'cancelled'])} or (${audioConvertJobs.status} = 'failed' and ${FINISH} <= ${cutoffAt}))`;
  }

  private scoped(scope: AudioConvertJobScope): SQL | undefined {
    return and(this.owned(scope.owner), this.inLibraries(scope.libraryIds));
  }

  private owned(owner: AudioConvertJobScope['owner']): SQL | undefined {
    if (owner === null) return undefined;
    const started = and(eq(audioConvertJobs.userId, owner.id), ne(audioConvertJobs.trigger, 'auto'))!;
    return owner.ownerless ? or(started, SYSTEM) : started;
  }

  private inLibraries(libraryIds: readonly number[] | null): SQL | undefined {
    return libraryIds === null ? undefined : inArray(audioConvertJobs.libraryId, [...libraryIds]);
  }
}
