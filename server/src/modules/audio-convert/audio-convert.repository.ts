import {
  AUDIO_FORMAT_LIST,
  type AudioConvertErrorCode,
  type AudioConvertJob,
  type AudioConvertJobStatus,
  type AudioConvertPlanStatus,
  type AudioConvertPreviewItem,
  type AudiobookChapter,
  type AudiobookChapterSource,
  type ContentFilterRules,
} from '@bookorbit/types';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { escapeLikePattern } from '../../common/utils/accent-insensitive-search.utils';
import { buildContentFilterClauses } from '../../common/utils/content-filter-sql.utils';
import { isUniqueViolation } from '../../common/utils/db-error.utils';
import { applySchemaStatements, findMissingTables } from '../../common/utils/schema-bootstrap.utils';
import { DB } from '../../db';
import { deleteBookFilesWithHashInvalidation, recordBookFileHashHistory } from '../../db/book-file-hash-history';
import * as schema from '../../db/schema';
import { remapAbsoluteSeconds, spreadBookmarkPositions } from './audio-convert.utils';
import {
  audioConvertJobs,
  audioConvertSettings,
  audioConvertWatch,
  type AudioConvertJobRow,
  type AudioConvertSettingsRow,
  type AudioConvertWorkPaths,
} from './schema/audio-convert.schema';

type Db = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const ACTIVE = sql`('waiting', 'queued', 'running')`;
const AUDIO_FORMATS_SQL = sql.join(
  AUDIO_FORMAT_LIST.map((format) => sql`${format}`),
  sql`, `,
);
const MP4_FORMATS_SQL = sql`('m4b', 'm4a')`;
/** Recently finished jobs stay in the status response this long, so the run bar can show how a run ended. */
const RECENT_FINISHED_MS = 60 * 60_000;

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}

export interface ConvertBookContext {
  bookId: number;
  libraryId: number;
  status: string;
  folderPath: string;
  title: string | null;
  primaryFileId: number | null;
  chapters: AudiobookChapter[] | null;
  chaptersSource: AudiobookChapterSource | null;
  audibleId: string | null;
  lastMetadataFetchAt: Date | null;
}

export interface ConvertFileRow {
  id: number;
  absolutePath: string;
  relPath: string | null;
  format: string | null;
  sizeBytes: number | null;
  durationSeconds: number | null;
  sortOrder: number | null;
  libraryFolderId: number;
  ino: bigint;
}

export interface SwapInput {
  jobId: string;
  bookId: number;
  keptFileId: number;
  mergedFileIds: number[];
  /**
   * Ordered file ids with each file's start on the stored timeline (plain sum of whole-second lengths,
   * where bookmarks live) and its exact start in the new file.
   */
  orderedFileIds: number[];
  oldStartsSeconds: number[];
  newStartsSeconds: number[];
  totalSeconds: number;
  file: { absolutePath: string; relPath: string | null; ino: bigint; sizeBytes: number; mtime: Date; fileHash: string; durationSeconds: number };
  previousHash: string | null;
  /** Rebased chapters to store, or null to leave the stored list alone. */
  chapters: AudiobookChapter[] | null;
  chaptersSource: AudiobookChapterSource | null;
  /** Written on the job in the same transaction, so a restart knows the book already points at the new file. */
  workPaths: AudioConvertWorkPaths;
  backupPath: string | null;
}

export interface ConvertibleScope {
  search?: string;
  /** The requesting user's content filters; undefined for a superuser. */
  contentFilters?: ContentFilterRules;
}

@Injectable()
export class AudioConvertRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  findMissingTables(tableNames: readonly string[]): Promise<string[]> {
    return findMissingTables(this.db, tableNames);
  }

  applySchemaStatements(statements: readonly string[]): Promise<void> {
    return applySchemaStatements(this.db, statements);
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  async getSettings(): Promise<AudioConvertSettingsRow> {
    const [row] = await this.db.select().from(audioConvertSettings).where(eq(audioConvertSettings.id, 1)).limit(1);
    if (row) return row;
    const [created] = await this.db.insert(audioConvertSettings).values({ id: 1 }).onConflictDoNothing().returning();
    return created ?? (await this.getSettings());
  }

  async updateSettings(patch: Partial<Omit<AudioConvertSettingsRow, 'id'>>): Promise<AudioConvertSettingsRow> {
    const [row] = await this.db.update(audioConvertSettings).set(patch).where(eq(audioConvertSettings.id, 1)).returning();
    return row!;
  }

  // ── Books and files ───────────────────────────────────────────────────────

  async findBook(bookId: number): Promise<ConvertBookContext | null> {
    const [row] = await this.db
      .select({
        bookId: schema.books.id,
        libraryId: schema.books.libraryId,
        status: schema.books.status,
        folderPath: schema.books.folderPath,
        primaryFileId: schema.books.primaryFileId,
        title: schema.bookMetadata.title,
        chapters: schema.bookMetadata.chapters,
        chaptersSource: schema.bookMetadata.chaptersSource,
        audibleId: schema.bookMetadata.audibleId,
        lastMetadataFetchAt: schema.bookMetadata.lastMetadataFetchAt,
      })
      .from(schema.books)
      .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.books.id))
      .where(eq(schema.books.id, bookId))
      .limit(1);
    if (!row) return null;
    return {
      ...row,
      title: row.title ?? null,
      chapters: Array.isArray(row.chapters) ? (row.chapters as AudiobookChapter[]) : null,
      chaptersSource: row.chaptersSource ?? null,
      audibleId: row.audibleId ?? null,
      lastMetadataFetchAt: row.lastMetadataFetchAt ?? null,
    };
  }

  findContentAudioFiles(bookId: number): Promise<ConvertFileRow[]> {
    return this.db
      .select({
        id: schema.bookFiles.id,
        absolutePath: schema.bookFiles.absolutePath,
        relPath: schema.bookFiles.relPath,
        format: schema.bookFiles.format,
        sizeBytes: schema.bookFiles.sizeBytes,
        durationSeconds: schema.bookFiles.durationSeconds,
        sortOrder: schema.bookFiles.sortOrder,
        libraryFolderId: schema.bookFiles.libraryFolderId,
        ino: schema.bookFiles.ino,
      })
      .from(schema.bookFiles)
      .where(
        and(
          eq(schema.bookFiles.bookId, bookId),
          eq(schema.bookFiles.role, 'content'),
          sql`lower(${schema.bookFiles.format}) in (${AUDIO_FORMATS_SQL})`,
        ),
      );
  }

  async countListeners(bookId: number): Promise<{ listeners: number; bookmarks: number }> {
    const [row] = rowsOf<{ listeners: number; bookmarks: number }>(
      await this.db.execute(sql`
        SELECT
          (SELECT count(*)::int FROM audiobook_progress WHERE book_id = ${bookId}) AS listeners,
          (SELECT count(*)::int FROM bookmarks WHERE book_id = ${bookId} AND position_seconds IS NOT NULL) AS bookmarks
      `),
    );
    return row ?? { listeners: 0, bookmarks: 0 };
  }

  async hasReadAlong(bookId: number): Promise<boolean> {
    // The edition-sync table is optional to this module: it may not exist on a fork without that feature.
    try {
      const rows = rowsOf<{ ok: boolean }>(
        await this.db.execute(sql`SELECT EXISTS (SELECT 1 FROM edition_sync_book_index WHERE book_id = ${bookId} AND status = 'ready') AS ok`),
      );
      return rows[0]?.ok === true;
    } catch {
      return false;
    }
  }

  /** The most recent playback write for the book, so a conversion never swaps a file someone is listening to. */
  async lastPlayedAt(bookId: number): Promise<Date | null> {
    const [row] = await this.db
      .select({ at: sql<Date | null>`max(${schema.audiobookProgress.updatedAt})` })
      .from(schema.audiobookProgress)
      .where(eq(schema.audiobookProgress.bookId, bookId));
    return row?.at ? new Date(row.at) : null;
  }

  // ── Preview ───────────────────────────────────────────────────────────────

  async preview(
    libraryId: number,
    options: { page: number; pageSize: number; status?: AudioConvertPlanStatus } & ConvertibleScope,
  ): Promise<{ items: AudioConvertPreviewItem[]; total: number; totalByStatus: Record<AudioConvertPlanStatus, number> }> {
    const base = this.planCte(libraryId, options.contentFilters);
    const searchClause = this.searchClause(options.search);

    const counts = rowsOf<{ plan_status: AudioConvertPlanStatus; n: number }>(
      await this.db.execute(sql`${base}
        SELECT s.plan_status, count(*)::int AS n FROM s LEFT JOIN book_metadata m ON m.book_id = s.book_id
        WHERE true ${searchClause} GROUP BY s.plan_status`),
    );
    const totalByStatus: Record<AudioConvertPlanStatus, number> = { can_convert: 0, waiting: 0, converted: 0, cannot: 0 };
    for (const row of counts) totalByStatus[row.plan_status] = row.n;

    const statusClause = options.status ? sql`AND s.plan_status = ${options.status}` : sql``;
    const offset = Math.max(0, (options.page - 1) * options.pageSize);
    const rows = rowsOf<{
      book_id: number;
      title: string | null;
      authors: string[] | null;
      first_path: string;
      plan_status: AudioConvertPlanStatus;
      file_count: number;
      formats: string[];
      total_bytes: string | number;
      total_seconds: number | null;
    }>(
      await this.db.execute(sql`${base}
        SELECT s.*, coalesce(nullif(m.title, ''), regexp_replace(b.folder_path, '^.*/', '')) AS title,
          (SELECT array_agg(a.name ORDER BY ba.display_order) FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = s.book_id) AS authors
        FROM s
        JOIN books b ON b.id = s.book_id
        LEFT JOIN book_metadata m ON m.book_id = s.book_id
        WHERE true ${statusClause} ${searchClause}
        ORDER BY b.primary_author_sort_name NULLS LAST, m.title NULLS LAST, s.book_id
        LIMIT ${options.pageSize} OFFSET ${offset}`),
    );

    const jobs = await this.latestJobsFor(rows.map((row) => row.book_id));
    const items = rows.map<AudioConvertPreviewItem>((row) => {
      const firstPath = row.first_path ?? '';
      const slash = firstPath.lastIndexOf('/');
      return {
        bookId: row.book_id,
        title: row.title ?? firstPath.slice(slash + 1),
        authors: row.authors ?? [],
        relativeFolder: slash > 0 ? firstPath.slice(0, slash) : '',
        status: row.plan_status,
        reason: row.plan_status === 'cannot' ? 'mixed_formats_with_m4b' : null,
        fileCount: row.file_count,
        formats: row.formats ?? [],
        totalBytes: Number(row.total_bytes),
        totalDurationSeconds: row.total_seconds,
        job: jobs.get(row.book_id) ?? null,
      };
    });
    const total = options.status ? totalByStatus[options.status] : Object.values(totalByStatus).reduce((sum, n) => sum + n, 0);
    return { items, total, totalByStatus };
  }

  /**
   * Book ids a run covers: the books the preview lists as `can_convert` for the same search and the
   * same viewer, so a run never reaches a book the preview did not show.
   */
  async convertibleBookIds(libraryId: number, scope: ConvertibleScope = {}): Promise<number[]> {
    const rows = rowsOf<{ book_id: number }>(
      await this.db.execute(sql`${this.planCte(libraryId, scope.contentFilters)}
        SELECT s.book_id FROM s LEFT JOIN book_metadata m ON m.book_id = s.book_id
        WHERE s.plan_status = 'can_convert' ${this.searchClause(scope.search)}
        ORDER BY s.book_id`),
    );
    return rows.map((row) => row.book_id);
  }

  /** Content audio per present book of the library, with the plan status the preview shows (`f`, then `s`). */
  private planCte(libraryId: number, contentFilters: ContentFilterRules | undefined): SQL {
    const filterClauses = contentFilters ? buildContentFilterClauses(contentFilters, this.db) : [];
    // The clauses name "books"."id", so they run against an unaliased books row of the candidate book.
    const visible = filterClauses.length > 0 ? sql`AND EXISTS (SELECT 1 FROM books WHERE books.id = b.id AND ${and(...filterClauses)})` : sql``;
    return sql`
      WITH f AS (
        SELECT bf.book_id,
          count(*)::int AS file_count,
          array_agg(DISTINCT lower(bf.format) ORDER BY lower(bf.format)) AS formats,
          coalesce(sum(bf.size_bytes), 0)::bigint AS total_bytes,
          CASE WHEN bool_and(bf.duration_seconds IS NOT NULL) THEN sum(bf.duration_seconds)::int END AS total_seconds,
          bool_or(lower(bf.format) IN ${MP4_FORMATS_SQL}) AS has_mp4,
          bool_and(lower(bf.format) IN ${MP4_FORMATS_SQL}) AS all_mp4,
          min(coalesce(bf.rel_path, bf.absolute_path)) AS first_path
        FROM book_files bf
        JOIN books b ON b.id = bf.book_id
        WHERE b.library_id = ${libraryId} AND b.status = 'present' AND bf.role = 'content'
          AND lower(bf.format) IN (${AUDIO_FORMATS_SQL}) ${visible}
        GROUP BY bf.book_id
      ), s AS (
        SELECT f.*,
          CASE
            WHEN EXISTS (SELECT 1 FROM audio_convert_jobs j WHERE j.book_id = f.book_id AND j.status IN ${ACTIVE}) THEN 'waiting'
            WHEN f.file_count = 1 AND f.has_mp4 THEN 'converted'
            WHEN f.has_mp4 AND NOT f.all_mp4 THEN 'cannot'
            ELSE 'can_convert'
          END AS plan_status
        FROM f
      )`;
  }

  /** Title or author match; expects the plan CTE's `s` and `book_metadata m` in scope. */
  private searchClause(search: string | undefined): SQL {
    const term = search?.trim();
    if (!term) return sql``;
    const pattern = '%' + escapeLikePattern(term) + '%';
    return sql`AND (m.title ILIKE ${pattern} OR EXISTS (
        SELECT 1 FROM book_authors ba JOIN authors a ON a.id = ba.author_id
        WHERE ba.book_id = s.book_id AND a.name ILIKE ${pattern}))`;
  }

  // ── Jobs ──────────────────────────────────────────────────────────────────

  /** Inserts a job unless the book already has an active one; returns null in that case. */
  async createJob(values: typeof audioConvertJobs.$inferInsert): Promise<AudioConvertJobRow | null> {
    const [row] = await this.db
      .insert(audioConvertJobs)
      .values(values)
      .onConflictDoNothing({ target: audioConvertJobs.bookId, where: sql`status IN ${ACTIVE}` })
      .returning();
    return row ?? null;
  }

  async findJob(id: string): Promise<AudioConvertJobRow | null> {
    const [row] = await this.db.select().from(audioConvertJobs).where(eq(audioConvertJobs.id, id)).limit(1);
    return row ?? null;
  }

  async latestJob(bookId: number): Promise<AudioConvertJobRow | null> {
    const [row] = await this.db
      .select()
      .from(audioConvertJobs)
      .where(eq(audioConvertJobs.bookId, bookId))
      .orderBy(desc(audioConvertJobs.createdAt))
      .limit(1);
    return row ?? null;
  }

  async hasAnyJob(bookId: number): Promise<boolean> {
    const [row] = await this.db.select({ id: audioConvertJobs.id }).from(audioConvertJobs).where(eq(audioConvertJobs.bookId, bookId)).limit(1);
    return Boolean(row);
  }

  private async latestJobsFor(bookIds: number[]): Promise<Map<number, AudioConvertJob>> {
    if (bookIds.length === 0) return new Map();
    const rows = rowsOf<{ id: string }>(
      await this.db.execute(sql`
        SELECT DISTINCT ON (book_id) id FROM audio_convert_jobs
        WHERE book_id IN (${sql.join(
          bookIds.map((id) => sql`${id}`),
          sql`, `,
        )})
        ORDER BY book_id, created_at DESC`),
    );
    if (rows.length === 0) return new Map();
    const jobs = await this.jobsWithTitles(
      inArray(
        audioConvertJobs.id,
        rows.map((row) => row.id),
      ),
    );
    return new Map(jobs.map((job) => [job.bookId, job]));
  }

  /** Active jobs in the library, plus jobs that finished in the last hour. */
  async statusJobs(libraryId: number | null): Promise<AudioConvertJob[]> {
    const recent = new Date(Date.now() - RECENT_FINISHED_MS);
    const library = libraryId === null ? sql`true` : eq(audioConvertJobs.libraryId, libraryId);
    return this.jobsWithTitles(and(library, sql`(${audioConvertJobs.status} IN ${ACTIVE} OR ${audioConvertJobs.finishedAt} > ${recent})`)!);
  }

  async jobsWithTitles(where: SQL): Promise<AudioConvertJob[]> {
    const rows = await this.db
      .select({
        job: audioConvertJobs,
        title: sql<string | null>`coalesce(nullif(${schema.bookMetadata.title}, ''), regexp_replace(${schema.books.folderPath}, '^.*/', ''))`,
      })
      .from(audioConvertJobs)
      .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, audioConvertJobs.bookId))
      .leftJoin(schema.books, eq(schema.books.id, audioConvertJobs.bookId))
      .where(where)
      .orderBy(audioConvertJobs.createdAt);
    return rows.map(({ job, title }) => toJob(job, title));
  }

  async updateJob(id: string, patch: Partial<typeof audioConvertJobs.$inferInsert>): Promise<AudioConvertJobRow | null> {
    const [row] = await this.db.update(audioConvertJobs).set(patch).where(eq(audioConvertJobs.id, id)).returning();
    return row ?? null;
  }

  /** Moves a job between states only when it is still in `from`, so a cancel and a claim never both win. */
  async transition(
    id: string,
    from: AudioConvertJobStatus[],
    patch: Partial<typeof audioConvertJobs.$inferInsert>,
  ): Promise<AudioConvertJobRow | null> {
    const [row] = await this.db
      .update(audioConvertJobs)
      .set(patch)
      .where(and(eq(audioConvertJobs.id, id), inArray(audioConvertJobs.status, from)))
      .returning();
    return row ?? null;
  }

  /**
   * A library's Stop: cancels its `queued` jobs only. New books waiting in the automatic pipeline are
   * left alone, since a cancelled auto job is never retried. The count is what the update changed, so
   * a job the worker claimed a moment earlier is not counted.
   */
  async cancelQueuedInLibrary(libraryId: number): Promise<number> {
    const rows = await this.db
      .update(audioConvertJobs)
      .set({ status: 'cancelled', finishedAt: new Date(), stage: null, nextStepAt: null })
      .where(and(eq(audioConvertJobs.libraryId, libraryId), eq(audioConvertJobs.status, 'queued')))
      .returning({ id: audioConvertJobs.id });
    return rows.length;
  }

  /** Cancels one job that has not started, waiting or queued. */
  async cancelPendingJob(id: string): Promise<boolean> {
    const row = await this.transition(id, ['waiting', 'queued'], { status: 'cancelled', finishedAt: new Date(), stage: null, nextStepAt: null });
    return row !== null;
  }

  /**
   * Moves a waiting job straight to the queue. Refused while its chapter lookup is in flight
   * (`stage_started_at` set and its lease not run out), so a lookup never writes chapters while the
   * worker is already converting.
   */
  async convertNow(id: string): Promise<AudioConvertJobRow | null> {
    const [row] = await this.db
      .update(audioConvertJobs)
      .set({ status: 'queued', stage: 'ready', nextStepAt: null, stageStartedAt: null })
      .where(
        and(
          eq(audioConvertJobs.id, id),
          eq(audioConvertJobs.status, 'waiting'),
          sql`NOT (${audioConvertJobs.stage} = 'chapters' AND ${audioConvertJobs.stageStartedAt} IS NOT NULL AND ${audioConvertJobs.nextStepAt} > now())`,
        ),
      )
      .returning();
    return row ?? null;
  }

  /**
   * Marks a waiting job's chapter lookup as running until `leaseUntil`. Returns false when the job was
   * skipped, converted now, or another tick holds the lookup. A lease left by a crash runs out and the
   * next tick takes the lookup again.
   */
  async claimChapterLookup(id: string, leaseUntil: Date): Promise<boolean> {
    const rows = await this.db
      .update(audioConvertJobs)
      .set({ stageStartedAt: new Date(), nextStepAt: leaseUntil })
      .where(
        and(
          eq(audioConvertJobs.id, id),
          eq(audioConvertJobs.status, 'waiting'),
          eq(audioConvertJobs.stage, 'chapters'),
          sql`(${audioConvertJobs.stageStartedAt} IS NULL OR ${audioConvertJobs.nextStepAt} <= now())`,
        ),
      )
      .returning({ id: audioConvertJobs.id });
    return rows.length > 0;
  }

  /** Ends every job still waiting in the automatic pipeline, e.g. when "Convert new MP3 books" is turned off. */
  async skipWaitingJobs(errorCode: AudioConvertErrorCode): Promise<number> {
    const rows = await this.db
      .update(audioConvertJobs)
      .set({ status: 'skipped', stage: null, nextStepAt: null, stageStartedAt: null, errorCode, finishedAt: new Date() })
      .where(eq(audioConvertJobs.status, 'waiting'))
      .returning({ id: audioConvertJobs.id });
    return rows.length;
  }

  async jobWithTitle(id: string): Promise<AudioConvertJob | null> {
    const [job] = await this.jobsWithTitles(eq(audioConvertJobs.id, id));
    return job ?? null;
  }

  async claim(): Promise<AudioConvertJobRow | null> {
    const result = rowsOf<{ id: string }>(
      await this.db.execute(sql`UPDATE audio_convert_jobs SET status = 'running', stage = 'converting', progress = 0,
          started_at = now(), updated_at = now(), attempts = attempts + 1
        WHERE id = (
          SELECT id FROM audio_convert_jobs
          WHERE status = 'queued' AND (next_step_at IS NULL OR next_step_at <= now())
          ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id`),
    );
    return result[0] ? this.findJob(result[0].id) : null;
  }

  /** Puts a claimed job back in the queue for later, e.g. while the library is being scanned. */
  async defer(id: string, until: Date): Promise<void> {
    await this.db
      .update(audioConvertJobs)
      .set({ status: 'queued', stage: 'ready', progress: null, nextStepAt: until, attempts: sql`greatest(${audioConvertJobs.attempts} - 1, 0)` })
      .where(eq(audioConvertJobs.id, id));
  }

  /** Jobs interrupted by a restart, with the paths they left on disk. */
  async interruptedJobs(): Promise<AudioConvertJobRow[]> {
    return this.db.select().from(audioConvertJobs).where(eq(audioConvertJobs.status, 'running'));
  }

  async waitingJobsDue(limit: number): Promise<AudioConvertJobRow[]> {
    return this.db
      .select()
      .from(audioConvertJobs)
      .where(and(eq(audioConvertJobs.status, 'waiting'), sql`(${audioConvertJobs.nextStepAt} IS NULL OR ${audioConvertJobs.nextStepAt} <= now())`))
      .orderBy(audioConvertJobs.createdAt)
      .limit(limit);
  }

  async setWorkPaths(id: string, workPaths: AudioConvertWorkPaths): Promise<void> {
    await this.db.update(audioConvertJobs).set({ workPaths }).where(eq(audioConvertJobs.id, id));
  }

  async expiredBackups(backupDays: number): Promise<AudioConvertJobRow[]> {
    const before = new Date(Date.now() - backupDays * 86_400_000);
    return this.db
      .select()
      .from(audioConvertJobs)
      .where(
        and(
          eq(audioConvertJobs.status, 'success'),
          sql`${audioConvertJobs.backupPath} IS NOT NULL`,
          sql`${audioConvertJobs.backupDeletedAt} IS NULL`,
          sql`${audioConvertJobs.finishedAt} <= ${before}`,
        ),
      )
      .limit(50);
  }

  async pruneOldJobs(): Promise<void> {
    const before = new Date(Date.now() - 30 * 86_400_000);
    await this.db.execute(sql`DELETE FROM audio_convert_jobs
      WHERE status NOT IN ${ACTIVE} AND coalesce(finished_at, created_at) < ${before}
        AND (backup_path IS NULL OR backup_deleted_at IS NOT NULL)`);
  }

  // ── New-book watch ────────────────────────────────────────────────────────

  /** Books whose MP3 files stopped arriving `quietMs` ago and that have never been through the tool. */
  async quietWatchedBooks(quietMs: number, limit: number): Promise<{ bookId: number; libraryId: number }[]> {
    const before = new Date(Date.now() - quietMs);
    const rows = rowsOf<{ book_id: number; library_id: number }>(
      await this.db.execute(sql`
        SELECT w.book_id, b.library_id FROM audio_convert_watch w
        JOIN books b ON b.id = w.book_id
        WHERE w.last_seen_at <= ${before} AND b.status = 'present'
        ORDER BY w.last_seen_at LIMIT ${limit}`),
    );
    return rows.map((row) => ({ bookId: row.book_id, libraryId: row.library_id }));
  }

  async unwatch(bookId: number): Promise<void> {
    await this.db.delete(audioConvertWatch).where(eq(audioConvertWatch.bookId, bookId));
  }

  async clearWatch(): Promise<void> {
    await this.db.delete(audioConvertWatch);
  }

  // ── Metadata fetch queue (read and enqueue only, same semantics as upstream's upsertSchedule) ──

  /**
   * Cross-module write, kept deliberately small: the metadata module exports no service that queues a
   * fetch without running it inline, and the pipeline must not run a provider fetch itself. Inserting
   * the row upstream's own worker drains (`manual_trigger`, ON CONFLICT DO NOTHING so an import's
   * pending row wins) is the same thing `BookMetadataFetchQueueRepository.upsertSchedule` does.
   */
  async requestMetadataFetch(bookId: number): Promise<void> {
    await this.db
      .insert(schema.bookMetadataFetchQueue)
      .values({ bookId, status: 'queued', reason: 'manual_trigger', attemptCount: 0 })
      .onConflictDoNothing();
  }

  async metadataFetchState(bookId: number): Promise<'pending' | 'failed' | 'none'> {
    const [row] = await this.db
      .select({ status: schema.bookMetadataFetchQueue.status })
      .from(schema.bookMetadataFetchQueue)
      .where(eq(schema.bookMetadataFetchQueue.bookId, bookId))
      .limit(1);
    if (!row) return 'none';
    return row.status === 'failed' ? 'failed' : 'pending';
  }

  // ── Swap ──────────────────────────────────────────────────────────────────

  /**
   * Points the book at the converted file in one transaction: the first file's row becomes the M4B,
   * positions and bookmarks move onto its exact timeline, rows that referenced the merged files move
   * to the kept row, and the merged rows go. The job's `phase=committed` is written in the same
   * transaction, so a restart can tell a committed swap from one that never reached the database.
   */
  async commitSwap(input: SwapInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (input.previousHash && input.previousHash !== input.file.fileHash) {
        await recordBookFileHashHistory(tx, input.keptFileId, input.previousHash, 'file_write');
      }

      await this.moveProgress(tx, input);
      await this.moveBookmarks(tx, input);
      if (input.mergedFileIds.length > 0) {
        await this.mergeReadingProgress(tx, input);
        await this.repointReferences(tx, input.keptFileId, input.mergedFileIds);
      }

      if (input.chapters) {
        await tx
          .update(schema.bookMetadata)
          .set({ chapters: input.chapters, chaptersSource: input.chaptersSource, chaptersUpdatedAt: new Date() })
          .where(eq(schema.bookMetadata.bookId, input.bookId));
      }
      await tx
        .update(schema.books)
        .set({ primaryFileId: input.keptFileId })
        .where(
          and(
            eq(schema.books.id, input.bookId),
            sql`(${schema.books.primaryFileId} IS NULL OR ${schema.books.primaryFileId} IN (${sql.join(
              [input.keptFileId, ...input.mergedFileIds].map((id) => sql`${id}`),
              sql`, `,
            )}))`,
          ),
        );

      // Merged rows go before the kept row takes the new path: a later part may already be named
      // "<Folder>.m4b", and two rows may not hold one path.
      if (input.mergedFileIds.length > 0) {
        await deleteBookFilesWithHashInvalidation(tx, inArray(schema.bookFiles.id, input.mergedFileIds));
      }
      await tx
        .update(schema.bookFiles)
        .set({
          absolutePath: input.file.absolutePath,
          relPath: input.file.relPath,
          ino: input.file.ino,
          sizeBytes: input.file.sizeBytes,
          mtime: input.file.mtime,
          fileHash: input.file.fileHash,
          format: 'm4b',
          durationSeconds: input.file.durationSeconds,
          chapterWriteProvenance: null,
          sortOrder: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.bookFiles.id, input.keptFileId));

      await tx
        .update(audioConvertJobs)
        .set({ workPaths: { ...input.workPaths, phase: 'committed' }, backupPath: input.backupPath })
        .where(eq(audioConvertJobs.id, input.jobId));
    });
  }

  private async moveProgress(tx: Tx, input: SwapInput): Promise<void> {
    const rows = await tx.select().from(schema.audiobookProgress).where(eq(schema.audiobookProgress.bookId, input.bookId)).for('update');
    for (const row of rows) {
      const index = input.orderedFileIds.indexOf(row.currentFileId);
      const start = index >= 0 ? input.newStartsSeconds[index]! : 0;
      const nextStart = index >= 0 ? input.newStartsSeconds[index + 1] : undefined;
      const limit = nextStart === undefined ? input.totalSeconds - start : nextStart - start;
      const position = start + Math.max(0, Math.min(row.positionSeconds, limit));
      const percentage = input.totalSeconds > 0 ? Math.max(0, Math.min(100, (position / input.totalSeconds) * 100)) : row.percentage;
      await tx
        .update(schema.audiobookProgress)
        .set({
          currentFileId: input.keptFileId,
          positionSeconds: position,
          percentage: row.percentage >= 100 ? row.percentage : percentage,
          revision: sql`${schema.audiobookProgress.revision} + 1`,
          operationId: null,
          manifestRevision: null,
          updatedAt: new Date(),
        })
        .where(and(eq(schema.audiobookProgress.userId, row.userId), eq(schema.audiobookProgress.bookId, input.bookId)));
    }
  }

  /**
   * Bookmarks move in two steps so no intermediate state breaks `bookmarks_user_book_pos_uidx`: their
   * positions are cleared, then each gets its final one, spread apart where two land on the same second.
   */
  private async moveBookmarks(tx: Tx, input: SwapInput): Promise<void> {
    const rows = await tx
      .select({
        id: schema.bookmarks.id,
        userId: schema.bookmarks.userId,
        positionSeconds: schema.bookmarks.positionSeconds,
        bookFileId: schema.bookmarks.bookFileId,
        cfi: schema.bookmarks.cfi,
        deletedAt: schema.bookmarks.deletedAt,
      })
      .from(schema.bookmarks)
      .where(and(eq(schema.bookmarks.bookId, input.bookId), sql`${schema.bookmarks.positionSeconds} IS NOT NULL`))
      .for('update');
    if (rows.length === 0) return;
    const positions = spreadBookmarkPositions(
      rows.map((row) => ({
        userId: row.userId,
        positionSeconds: remapAbsoluteSeconds(row.positionSeconds!, input.oldStartsSeconds, input.newStartsSeconds),
        unique: row.cfi === null && row.deletedAt === null,
      })),
    );
    const fileIds = new Set([input.keptFileId, ...input.mergedFileIds]);
    await tx
      .update(schema.bookmarks)
      .set({ positionSeconds: null })
      .where(
        inArray(
          schema.bookmarks.id,
          rows.map((row) => row.id),
        ),
      );
    for (const [index, row] of rows.entries()) {
      await tx
        .update(schema.bookmarks)
        .set({
          positionSeconds: positions[index]!,
          bookFileId: row.bookFileId !== null && fileIds.has(row.bookFileId) ? input.keptFileId : row.bookFileId,
        })
        .where(eq(schema.bookmarks.id, row.id));
    }
  }

  /**
   * `reading_progress` is keyed by file and user, so each user keeps only their most recently read row
   * across the joined files; it moves to the kept file with its file-relative position shifted to where
   * that file now starts.
   */
  private async mergeReadingProgress(tx: Tx, input: SwapInput): Promise<void> {
    const fileIds = [input.keptFileId, ...input.mergedFileIds];
    const rows = await tx
      .select({
        bookFileId: schema.readingProgress.bookFileId,
        userId: schema.readingProgress.userId,
        positionSeconds: schema.readingProgress.positionSeconds,
        lastReadAt: schema.readingProgress.lastReadAt,
      })
      .from(schema.readingProgress)
      .where(inArray(schema.readingProgress.bookFileId, fileIds))
      .for('update');
    const newest = new Map<number, (typeof rows)[number]>();
    for (const row of rows) {
      const best = newest.get(row.userId);
      if (!best || row.lastReadAt.getTime() > best.lastReadAt.getTime()) newest.set(row.userId, row);
    }
    for (const row of rows) {
      if (newest.get(row.userId) === row) continue;
      await tx
        .delete(schema.readingProgress)
        .where(and(eq(schema.readingProgress.bookFileId, row.bookFileId), eq(schema.readingProgress.userId, row.userId)));
    }
    for (const row of newest.values()) {
      if (row.bookFileId === input.keptFileId) continue;
      const index = input.orderedFileIds.indexOf(row.bookFileId);
      const start = index >= 0 ? input.newStartsSeconds[index]! : 0;
      await tx
        .update(schema.readingProgress)
        .set({
          bookFileId: input.keptFileId,
          positionSeconds: row.positionSeconds === null ? null : start + row.positionSeconds,
          lastReadAt: row.lastReadAt,
        })
        .where(and(eq(schema.readingProgress.bookFileId, row.bookFileId), eq(schema.readingProgress.userId, row.userId)));
    }
  }

  /**
   * Every other column that references book_files.id is moved to the kept row. A move that would
   * break a unique key is undone inside a savepoint, and the row then goes with the merged file by its
   * own delete rule, as it would if the file had been deleted. Any other error fails the swap.
   */
  private async repointReferences(tx: Tx, keptFileId: number, mergedFileIds: number[]): Promise<void> {
    const references = rowsOf<{ table_name: string; column_name: string }>(
      await tx.execute(sql`
        SELECT cl.relname AS table_name, att.attname AS column_name
        FROM pg_constraint con
        JOIN pg_class cl ON cl.oid = con.conrelid
        JOIN pg_namespace ns ON ns.oid = cl.relnamespace
        JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
        WHERE con.contype = 'f' AND con.confrelid = 'public.book_files'::regclass
          AND array_length(con.conkey, 1) = 1 AND ns.nspname = 'public'
        ORDER BY 1, 2`),
    );
    const merged = sql.join(
      mergedFileIds.map((id) => sql`${id}`),
      sql`, `,
    );
    for (const reference of references) {
      if (REPOINTED_ELSEWHERE.has(reference.table_name)) continue;
      const table = sql.identifier(reference.table_name);
      const column = sql.identifier(reference.column_name);
      try {
        await tx.transaction(async (savepoint) => {
          await savepoint.execute(sql`UPDATE ${table} SET ${column} = ${keptFileId} WHERE ${column} IN (${merged})`);
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
  }
}

/** Tables the swap moves itself, with their own rules, before the generic re-point. */
const REPOINTED_ELSEWHERE = new Set(['audiobook_progress', 'bookmarks', 'books', 'reading_progress']);

export function toJob(row: AudioConvertJobRow, title: string | null): AudioConvertJob {
  return {
    id: row.id,
    bookId: row.bookId,
    libraryId: row.libraryId,
    title: title ?? `#${row.bookId}`,
    trigger: row.trigger,
    status: row.status,
    stage: row.stage ?? null,
    progress: row.progress ?? null,
    nextStepAt: row.status === 'waiting' && row.nextStepAt ? row.nextStepAt.toISOString() : null,
    codec: row.codecUsed ?? null,
    errorCode: row.errorCode ?? null,
    errorMessage: row.errorMessage ?? null,
    result: row.result ?? null,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}
