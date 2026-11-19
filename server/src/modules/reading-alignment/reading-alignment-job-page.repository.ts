import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { ContentFilterRules, JobCounts, JobView } from '@bookorbit/types';

import { buildContentFilterClauses } from '../../common/utils/content-filter-sql.utils';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { books } from '../../db/schema';
import { afterPosition, keysetOrder, microseconds, type JobKey, type JobPosition, type KeysetColumns } from '../jobs/job-keyset';
import { audiobookAlignment, type AudiobookAlignment } from './schema/reading-alignment.schema';

type Db = NodePgDatabase<typeof schema>;

/** The statuses `audiobook_alignment_jobs_active_idx` covers. */
const IN_QUEUE = ['building', 'pending'];
const COUNTED = [...IN_QUEUE, 'failed'];
/** `unalignable` is a settled verdict on these files, so it goes to History rather than Failed, in pages and counts alike. */
const SETTLED = ['ready', 'unalignable'];
/** A row stops changing once it settles, so its last write is when it finished. */
const FINISH = sql`${audiobookAlignment.updatedAt}`;

const PAGE_COLUMNS = {
  id: audiobookAlignment.id,
  bookId: audiobookAlignment.textBookId,
  status: audiobookAlignment.status,
  samplesDone: audiobookAlignment.samplesDone,
  samplesTotal: audiobookAlignment.samplesTotal,
  error: audiobookAlignment.error,
  createdAt: audiobookAlignment.createdAt,
  updatedAt: audiobookAlignment.updatedAt,
};

export type WhisperAlignmentJobPageRow = Pick<
  AudiobookAlignment,
  'id' | 'status' | 'samplesDone' | 'samplesTotal' | 'error' | 'createdAt' | 'updatedAt'
> & {
  bookId: number;
  key: JobKey;
};

/** What a retry needs to tell whether rebuilding could end differently. */
export type WhisperAlignmentJobActionRow = Pick<
  AudiobookAlignment,
  'id' | 'status' | 'audioBookId' | 'audioContentHash' | 'epubContentHash' | 'whisperModel' | 'sampleIntervalSec' | 'clipSeconds'
> & { bookId: number };

/** Which books a read covers: the libraries the viewer may edit (null for every library) and their content filter. */
export interface WhisperAlignmentJobScope {
  libraryIds: readonly number[] | null;
  contentFilters: ContentFilterRules | null;
}

export interface WhisperAlignmentJobPageQuery extends WhisperAlignmentJobScope {
  view: JobView;
  cutoffAt: Date;
  after: JobPosition | null;
  typeIndex: number;
  limit: number;
}

/** Whisper alignment builds for the Jobs area. A row belongs to its book, not to an account. */
@Injectable()
export class ReadingAlignmentJobPageRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async pageForJobs(query: WhisperAlignmentJobPageQuery): Promise<WhisperAlignmentJobPageRow[]> {
    if (query.view === 'needs-you' || query.libraryIds?.length === 0) return [];
    return query.view === 'queue' ? await this.queuePage(query) : await this.settledPage(query);
  }

  async countForJobs(scope: WhisperAlignmentJobScope, cutoffAt: Date): Promise<JobCounts> {
    if (scope.libraryIds?.length === 0) return { queue: 0, needsYou: 0, failed: 0, running: 0, queued: 0, paused: 0 };
    const [row] = await this.db
      .select({
        running: sql<number>`count(*) filter (where ${audiobookAlignment.status} = 'building')`.mapWith(Number),
        queued: sql<number>`count(*) filter (where ${audiobookAlignment.status} = 'pending')`.mapWith(Number),
        failed: sql<number>`count(*) filter (where ${this.failedShown(cutoffAt)})`.mapWith(Number),
      })
      .from(audiobookAlignment)
      .innerJoin(books, eq(books.id, audiobookAlignment.textBookId))
      .where(and(inArray(audiobookAlignment.status, COUNTED), this.scoped(scope)));
    const running = row?.running ?? 0;
    const queued = row?.queued ?? 0;
    return { queue: running + queued, needsYou: 0, failed: row?.failed ?? 0, running, queued, paused: 0 };
  }

  async findActionRows(ids: readonly number[], scope: WhisperAlignmentJobScope): Promise<WhisperAlignmentJobActionRow[]> {
    if (ids.length === 0 || scope.libraryIds?.length === 0) return [];
    return await this.db
      .select({
        id: audiobookAlignment.id,
        bookId: audiobookAlignment.textBookId,
        status: audiobookAlignment.status,
        audioBookId: audiobookAlignment.audioBookId,
        audioContentHash: audiobookAlignment.audioContentHash,
        epubContentHash: audiobookAlignment.epubContentHash,
        whisperModel: audiobookAlignment.whisperModel,
        sampleIntervalSec: audiobookAlignment.sampleIntervalSec,
        clipSeconds: audiobookAlignment.clipSeconds,
      })
      .from(audiobookAlignment)
      .innerJoin(books, eq(books.id, audiobookAlignment.textBookId))
      .where(and(inArray(audiobookAlignment.id, [...ids]), this.scoped(scope)));
  }

  /** Builds running, then any not yet started, oldest first. */
  private async queuePage(query: WhisperAlignmentJobPageQuery): Promise<WhisperAlignmentJobPageRow[]> {
    const group = sql<number>`case when ${audiobookAlignment.status} = 'building' then 0 else 1 end`;
    const at = microseconds(sql`${audiobookAlignment.createdAt}`);
    const columns: KeysetColumns = {
      prefix: [
        { kind: 'number', expr: group },
        // PostgreSQL treats a bare integer in ORDER BY as a select-list position.
        { kind: 'number', expr: sql`0::integer` },
      ],
      suffix: [{ kind: 'number', expr: at }],
      id: { kind: 'number', expr: sql`${audiobookAlignment.id}` },
    };
    const rows = await this.db
      .select({ ...PAGE_COLUMNS, group: sql<number>`${group}`.mapWith(Number), at })
      .from(audiobookAlignment)
      .innerJoin(books, eq(books.id, audiobookAlignment.textBookId))
      .where(
        and(
          inArray(audiobookAlignment.status, IN_QUEUE),
          this.scoped(query),
          query.after ? afterPosition(columns, 'queue', query.after, query.typeIndex) : undefined,
        ),
      )
      .orderBy(...keysetOrder(columns, 'queue'))
      .limit(query.limit);
    return rows.map(({ group: band, at: since, ...row }) => ({ ...row, key: { prefix: [band, 0], suffix: [since], id: row.id } }));
  }

  /** Failed and History by the row's last write, newest first. */
  private async settledPage(query: WhisperAlignmentJobPageQuery): Promise<WhisperAlignmentJobPageRow[]> {
    const columns: KeysetColumns = {
      prefix: [{ kind: 'time', expr: FINISH }],
      suffix: [],
      id: { kind: 'number', expr: sql`${audiobookAlignment.id}` },
    };
    const rows = await this.db
      .select({ ...PAGE_COLUMNS, finish: microseconds(FINISH) })
      .from(audiobookAlignment)
      .innerJoin(books, eq(books.id, audiobookAlignment.textBookId))
      .where(
        and(
          query.view === 'failed' ? this.failedShown(query.cutoffAt) : this.historyShown(query.cutoffAt),
          this.scoped(query),
          query.after ? afterPosition(columns, query.view, query.after, query.typeIndex) : undefined,
        ),
      )
      .orderBy(...keysetOrder(columns, query.view))
      .limit(query.limit);
    return rows.map(({ finish, ...row }) => ({ ...row, key: { prefix: [finish], suffix: [], id: row.id } }));
  }

  private failedShown(cutoffAt: Date): SQL {
    return and(eq(audiobookAlignment.status, 'failed'), sql`${FINISH} > ${cutoffAt}`)!;
  }

  private historyShown(cutoffAt: Date): SQL {
    return sql`(${inArray(audiobookAlignment.status, SETTLED)} or (${audiobookAlignment.status} = 'failed' and ${FINISH} <= ${cutoffAt}))`;
  }

  /** The library and content filter on the joined text book, as the books list applies them. */
  private scoped(scope: WhisperAlignmentJobScope): SQL | undefined {
    const content = scope.contentFilters ? buildContentFilterClauses(scope.contentFilters, this.db) : [];
    return and(scope.libraryIds === null ? undefined : inArray(books.libraryId, [...scope.libraryIds]), ...content);
  }
}
