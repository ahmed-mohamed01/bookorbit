import { Inject, Injectable } from '@nestjs/common';
import type { AudiobookshelfBookStateBucket, ContentFilterRules } from '@bookorbit/types';
import { Permission } from '@bookorbit/types';
import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import type { AudiobookshelfBookState, AudiobookshelfUserSetting, NewAudiobookshelfBookState, NewAudiobookshelfUserSetting } from '../../db/schema';
import { buildContentFilterClauses } from '../../common/utils/content-filter-sql.utils';
import {
  aggregateReadingSessionDailyStats,
  getDayRangeForDateKeys,
  getReadingSessionDayKeys,
  type ReadingDailyStatsSegment,
} from '../../common/utils/reading-daily-stats.utils';
import type { AbsMappedSession } from './audiobookshelf-sessions.util';

type Db = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface AbsIngestSessionsResult {
  insertedSessionIds: string[];
  updated: number;
}

const ISBN_ASIN_LOOKUP_CHUNK = 1000;
const BOOK_STATE_UPSERT_CHUNK = 500;

export interface AbsExactMatchRow {
  key: string;
  bookId: number;
}

export interface AbsFuzzyCandidateSeries {
  name: string;
  seriesIndex: number | null;
}

export interface AbsFuzzyCandidate {
  bookId: number;
  title: string | null;
  authors: string[];
  series: AbsFuzzyCandidateSeries[];
}

export interface AbsBookStateView {
  absLibraryItemId: string;
  absTitle: string | null;
  absAuthorName: string | null;
  bookId: number | null;
  bookTitle: string | null;
  bookAuthorName: string | null;
  matchMethod: string | null;
  matchConfidence: number | null;
  needsReview: boolean;
  matchError: string | null;
  syncExcluded: boolean;
  syncError: string | null;
  lastSyncedAt: Date | null;
}

export interface AbsBookStateUpsert {
  absLibraryItemId: string;
  absTitle: string | null;
  absAuthorName: string | null;
  bookId: number | null;
  matchMethod: string | null;
  matchConfidence: number | null;
  needsReview: boolean;
  matchError: string | null;
  lastMatchAttemptAt: Date;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

@Injectable()
export class AudiobookshelfRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findSettings(userId: number): Promise<AudiobookshelfUserSetting | undefined> {
    return this.db.query.audiobookshelfUserSettings.findFirst({
      where: eq(schema.audiobookshelfUserSettings.userId, userId),
    });
  }

  /**
   * Keyset page of user ids that have Audiobookshelf sync enabled and a non-empty server URL + token.
   * Ordered by userId ascending; callers advance `afterUserId` to the last id of the prior page. Used
   * by the scheduler so it never loads all users unbounded.
   */
  async findEnabledConfiguredUserIds(afterUserId: number, limit: number): Promise<number[]> {
    const rows = await this.db
      .select({ userId: schema.audiobookshelfUserSettings.userId })
      .from(schema.audiobookshelfUserSettings)
      .where(
        and(
          eq(schema.audiobookshelfUserSettings.enabled, true),
          gt(schema.audiobookshelfUserSettings.userId, afterUserId),
          sql`length(trim(${schema.audiobookshelfUserSettings.serverUrl})) > 0`,
          sql`length(trim(${schema.audiobookshelfUserSettings.apiToken})) > 0`,
        ),
      )
      .orderBy(asc(schema.audiobookshelfUserSettings.userId))
      .limit(limit);
    return rows.map((row) => row.userId);
  }

  async upsertSettings(
    userId: number,
    data: Partial<Omit<AudiobookshelfUserSetting, 'id' | 'userId' | 'createdAt' | 'updatedAt'>>,
  ): Promise<AudiobookshelfUserSetting> {
    const [row] = await this.db
      .insert(schema.audiobookshelfUserSettings)
      .values({ userId, ...data } as NewAudiobookshelfUserSetting)
      .onConflictDoUpdate({
        target: schema.audiobookshelfUserSettings.userId,
        set: { ...data, updatedAt: new Date() },
      })
      .returning();
    return row!;
  }

  async deleteSettings(userId: number): Promise<void> {
    await this.db.delete(schema.audiobookshelfUserSettings).where(eq(schema.audiobookshelfUserSettings.userId, userId));
  }

  async userHasAudiobookshelfSyncPermission(userId: number): Promise<boolean> {
    const [row] = await this.db
      .select({
        isSuperuser: schema.users.isSuperuser,
        permissionName: schema.userPermissions.permissionName,
      })
      .from(schema.users)
      .leftJoin(
        schema.userPermissions,
        and(eq(schema.userPermissions.userId, schema.users.id), eq(schema.userPermissions.permissionName, Permission.AudiobookshelfSync)),
      )
      .where(and(eq(schema.users.id, userId), eq(schema.users.active, true)))
      .limit(1);

    return row?.isSuperuser === true || row?.permissionName === Permission.AudiobookshelfSync;
  }

  /**
   * A monotonic "library changed" signal for negative-match memoization: the newest change to any
   * accessible book or its metadata. Unmatched items only re-attempt when this advances past their
   * last attempt, so a stable library performs no candidate load on repeat runs.
   */
  async findLibraryChangedAt(libraryIds: number[]): Promise<Date | null> {
    if (libraryIds.length === 0) return null;
    const [row] = await this.db
      .select({
        changedAt: sql<Date | null>`greatest(max(${schema.books.updatedAt}), max(${schema.bookMetadata.updatedAt}))`,
      })
      .from(schema.books)
      .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.books.id))
      .where(inArray(schema.books.libraryId, libraryIds));
    return row?.changedAt ?? null;
  }

  async findBookIdsByAudibleIds(libraryIds: number[], contentFilters: ContentFilterRules | undefined, asins: string[]): Promise<AbsExactMatchRow[]> {
    if (libraryIds.length === 0 || asins.length === 0) return [];
    const filters = contentFilters ? buildContentFilterClauses(contentFilters, this.db) : [];
    const results: AbsExactMatchRow[] = [];
    for (const group of chunk(asins, ISBN_ASIN_LOOKUP_CHUNK)) {
      const rows = await this.db
        .select({ key: schema.bookMetadata.audibleId, bookId: schema.books.id })
        .from(schema.books)
        .innerJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.books.id))
        .where(
          and(
            inArray(schema.books.libraryId, libraryIds),
            eq(schema.books.status, 'present'),
            inArray(schema.bookMetadata.audibleId, group),
            ...filters,
          ),
        );
      for (const row of rows) if (row.key) results.push({ key: row.key, bookId: row.bookId });
    }
    return results;
  }

  async findBookIdsByIsbns(libraryIds: number[], contentFilters: ContentFilterRules | undefined, isbns: string[]): Promise<AbsExactMatchRow[]> {
    if (libraryIds.length === 0 || isbns.length === 0) return [];
    const filters = contentFilters ? buildContentFilterClauses(contentFilters, this.db) : [];
    const isbn13s = isbns.filter((isbn) => isbn.length === 13);
    const isbn10s = isbns.filter((isbn) => isbn.length === 10);
    const results: AbsExactMatchRow[] = [];

    for (const group of chunk(isbn13s, ISBN_ASIN_LOOKUP_CHUNK)) {
      const rows = await this.db
        .select({ key: schema.bookMetadata.isbn13, bookId: schema.books.id })
        .from(schema.books)
        .innerJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.books.id))
        .where(
          and(
            inArray(schema.books.libraryId, libraryIds),
            eq(schema.books.status, 'present'),
            inArray(schema.bookMetadata.isbn13, group),
            ...filters,
          ),
        );
      for (const row of rows) if (row.key) results.push({ key: row.key, bookId: row.bookId });
    }
    for (const group of chunk(isbn10s, ISBN_ASIN_LOOKUP_CHUNK)) {
      const rows = await this.db
        .select({ key: schema.bookMetadata.isbn10, bookId: schema.books.id })
        .from(schema.books)
        .innerJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.books.id))
        .where(
          and(
            inArray(schema.books.libraryId, libraryIds),
            eq(schema.books.status, 'present'),
            inArray(schema.bookMetadata.isbn10, group),
            ...filters,
          ),
        );
      for (const row of rows) if (row.key) results.push({ key: row.key, bookId: row.bookId });
    }
    return results;
  }

  /**
   * Bounded fuzzy candidate load: trigram-ranked local books for a single ABS title, capped at `limit`.
   * Never a full-library scan - only residual items that failed the exact tiers reach here.
   */
  async findFuzzyCandidates(
    libraryIds: number[],
    contentFilters: ContentFilterRules | undefined,
    title: string,
    limit: number,
  ): Promise<AbsFuzzyCandidate[]> {
    if (libraryIds.length === 0 || !title.trim()) return [];
    const filters = contentFilters ? buildContentFilterClauses(contentFilters, this.db) : [];
    const rows = await this.db
      .select({ bookId: schema.books.id, title: schema.bookMetadata.title })
      .from(schema.books)
      .innerJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.books.id))
      .where(
        and(
          inArray(schema.books.libraryId, libraryIds),
          eq(schema.books.status, 'present'),
          sql`${schema.bookMetadata.title} % ${title}`,
          ...filters,
        ),
      )
      .orderBy(sql`similarity(${schema.bookMetadata.title}, ${title}) desc`, asc(schema.books.id))
      .limit(limit);

    if (rows.length === 0) return [];
    const bookIds = rows.map((row) => row.bookId);

    const authorRows = await this.db
      .select({ bookId: schema.bookAuthors.bookId, name: schema.authors.name })
      .from(schema.bookAuthors)
      .innerJoin(schema.authors, eq(schema.authors.id, schema.bookAuthors.authorId))
      .where(inArray(schema.bookAuthors.bookId, bookIds))
      .orderBy(asc(schema.bookAuthors.bookId), asc(schema.bookAuthors.displayOrder), asc(schema.bookAuthors.authorId));

    const seriesRows = await this.db
      .select({ bookId: schema.bookSeriesMemberships.bookId, name: schema.bookSeries.name, seriesIndex: schema.bookSeriesMemberships.seriesIndex })
      .from(schema.bookSeriesMemberships)
      .innerJoin(schema.bookSeries, eq(schema.bookSeries.id, schema.bookSeriesMemberships.seriesId))
      .where(inArray(schema.bookSeriesMemberships.bookId, bookIds))
      .orderBy(asc(schema.bookSeriesMemberships.bookId), asc(schema.bookSeriesMemberships.displayOrder));

    const authorsByBook = new Map<number, string[]>();
    for (const row of authorRows) {
      const list = authorsByBook.get(row.bookId) ?? [];
      list.push(row.name);
      authorsByBook.set(row.bookId, list);
    }
    const seriesByBook = new Map<number, AbsFuzzyCandidateSeries[]>();
    for (const row of seriesRows) {
      const list = seriesByBook.get(row.bookId) ?? [];
      list.push({ name: row.name, seriesIndex: row.seriesIndex });
      seriesByBook.set(row.bookId, list);
    }

    return rows.map((row) => ({
      bookId: row.bookId,
      title: row.title,
      authors: authorsByBook.get(row.bookId) ?? [],
      series: seriesByBook.get(row.bookId) ?? [],
    }));
  }

  async findBookStatesByAbsItemIds(userId: number, absLibraryItemIds: string[]): Promise<AudiobookshelfBookState[]> {
    if (absLibraryItemIds.length === 0) return [];
    const results: AudiobookshelfBookState[] = [];
    for (const group of chunk(absLibraryItemIds, ISBN_ASIN_LOOKUP_CHUNK)) {
      const rows = await this.db
        .select()
        .from(schema.audiobookshelfBookState)
        .where(and(eq(schema.audiobookshelfBookState.userId, userId), inArray(schema.audiobookshelfBookState.absLibraryItemId, group)));
      results.push(...rows);
    }
    return results;
  }

  async bulkUpsertBookStates(userId: number, rows: AbsBookStateUpsert[]): Promise<void> {
    if (rows.length === 0) return;
    for (const group of chunk(rows, BOOK_STATE_UPSERT_CHUNK)) {
      await this.db
        .insert(schema.audiobookshelfBookState)
        .values(
          group.map((row): NewAudiobookshelfBookState => ({
            userId,
            absLibraryItemId: row.absLibraryItemId,
            absTitle: row.absTitle,
            absAuthorName: row.absAuthorName,
            bookId: row.bookId,
            matchMethod: row.matchMethod,
            matchConfidence: row.matchConfidence,
            needsReview: row.needsReview,
            matchError: row.matchError,
            lastMatchAttemptAt: row.lastMatchAttemptAt,
          })),
        )
        .onConflictDoUpdate({
          target: [schema.audiobookshelfBookState.userId, schema.audiobookshelfBookState.absLibraryItemId],
          set: {
            absTitle: sql`excluded.abs_title`,
            absAuthorName: sql`excluded.abs_author_name`,
            bookId: sql`excluded.book_id`,
            matchMethod: sql`excluded.match_method`,
            matchConfidence: sql`excluded.match_confidence`,
            needsReview: sql`excluded.needs_review`,
            matchError: sql`excluded.match_error`,
            lastMatchAttemptAt: sql`excluded.last_match_attempt_at`,
            updatedAt: new Date(),
          },
        });
    }
  }

  private bookAuthorNameSql(): SQL<string | null> {
    return sql<string | null>`(
      select ${schema.authors.name}
      from ${schema.bookAuthors}
      inner join ${schema.authors} on ${schema.authors.id} = ${schema.bookAuthors.authorId}
      where ${schema.bookAuthors.bookId} = ${schema.audiobookshelfBookState.bookId}
      order by ${schema.bookAuthors.displayOrder} asc, ${schema.bookAuthors.authorId} asc
      limit 1
    )`;
  }

  private bucketClause(bucket: AudiobookshelfBookStateBucket): SQL | undefined {
    switch (bucket) {
      case 'linked':
        return and(
          sql`${schema.audiobookshelfBookState.bookId} is not null`,
          eq(schema.audiobookshelfBookState.needsReview, false),
          isNull(schema.audiobookshelfBookState.matchError),
        );
      case 'needs-review':
        return eq(schema.audiobookshelfBookState.needsReview, true);
      case 'unmatched':
        return isNull(schema.audiobookshelfBookState.bookId);
    }
  }

  async listBookStates(
    userId: number,
    bucket: AudiobookshelfBookStateBucket,
    page: number,
    pageSize: number,
    q: string | undefined,
  ): Promise<{ items: AbsBookStateView[]; total: number }> {
    const clauses: SQL[] = [eq(schema.audiobookshelfBookState.userId, userId)];
    const bucketClause = this.bucketClause(bucket);
    if (bucketClause) clauses.push(bucketClause);
    if (q && q.trim()) {
      const pattern = `%${q.trim()}%`;
      clauses.push(or(ilike(schema.audiobookshelfBookState.absTitle, pattern), ilike(schema.bookMetadata.title, pattern))!);
    }
    const where = and(...clauses);

    const [{ total }] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.audiobookshelfBookState)
      .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.audiobookshelfBookState.bookId))
      .where(where);

    const items = await this.db
      .select({
        absLibraryItemId: schema.audiobookshelfBookState.absLibraryItemId,
        absTitle: schema.audiobookshelfBookState.absTitle,
        absAuthorName: schema.audiobookshelfBookState.absAuthorName,
        bookId: schema.audiobookshelfBookState.bookId,
        bookTitle: schema.bookMetadata.title,
        bookAuthorName: this.bookAuthorNameSql(),
        matchMethod: schema.audiobookshelfBookState.matchMethod,
        matchConfidence: schema.audiobookshelfBookState.matchConfidence,
        needsReview: schema.audiobookshelfBookState.needsReview,
        matchError: schema.audiobookshelfBookState.matchError,
        syncExcluded: schema.audiobookshelfBookState.syncExcluded,
        syncError: schema.audiobookshelfBookState.syncError,
        lastSyncedAt: schema.audiobookshelfBookState.lastSyncedAt,
      })
      .from(schema.audiobookshelfBookState)
      .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.audiobookshelfBookState.bookId))
      .where(where)
      .orderBy(desc(schema.audiobookshelfBookState.updatedAt), asc(schema.audiobookshelfBookState.absLibraryItemId))
      .limit(pageSize)
      .offset(page * pageSize);

    return { items, total: total ?? 0 };
  }

  async findBookStateView(userId: number, absLibraryItemId: string): Promise<AbsBookStateView | null> {
    const [row] = await this.db
      .select({
        absLibraryItemId: schema.audiobookshelfBookState.absLibraryItemId,
        absTitle: schema.audiobookshelfBookState.absTitle,
        absAuthorName: schema.audiobookshelfBookState.absAuthorName,
        bookId: schema.audiobookshelfBookState.bookId,
        bookTitle: schema.bookMetadata.title,
        bookAuthorName: this.bookAuthorNameSql(),
        matchMethod: schema.audiobookshelfBookState.matchMethod,
        matchConfidence: schema.audiobookshelfBookState.matchConfidence,
        needsReview: schema.audiobookshelfBookState.needsReview,
        matchError: schema.audiobookshelfBookState.matchError,
        syncExcluded: schema.audiobookshelfBookState.syncExcluded,
        syncError: schema.audiobookshelfBookState.syncError,
        lastSyncedAt: schema.audiobookshelfBookState.lastSyncedAt,
      })
      .from(schema.audiobookshelfBookState)
      .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.audiobookshelfBookState.bookId))
      .where(and(eq(schema.audiobookshelfBookState.userId, userId), eq(schema.audiobookshelfBookState.absLibraryItemId, absLibraryItemId)))
      .limit(1);
    return row ?? null;
  }

  async findBookStateRow(userId: number, absLibraryItemId: string): Promise<AudiobookshelfBookState | undefined> {
    return this.db.query.audiobookshelfBookState.findFirst({
      where: and(eq(schema.audiobookshelfBookState.userId, userId), eq(schema.audiobookshelfBookState.absLibraryItemId, absLibraryItemId)),
    });
  }

  async updateBookState(
    userId: number,
    absLibraryItemId: string,
    patch: Partial<Omit<AudiobookshelfBookState, 'id' | 'userId' | 'absLibraryItemId' | 'createdAt' | 'updatedAt'>>,
  ): Promise<void> {
    await this.db
      .update(schema.audiobookshelfBookState)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(schema.audiobookshelfBookState.userId, userId), eq(schema.audiobookshelfBookState.absLibraryItemId, absLibraryItemId)));
  }

  async findLibraryIdsByBookIds(bookIds: number[]): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    if (bookIds.length === 0) return map;
    for (const group of chunk([...new Set(bookIds)], ISBN_ASIN_LOOKUP_CHUNK)) {
      const rows = await this.db
        .select({ id: schema.books.id, libraryId: schema.books.libraryId })
        .from(schema.books)
        .where(inArray(schema.books.id, group));
      for (const row of rows) map.set(row.id, row.libraryId);
    }
    return map;
  }

  /**
   * Upserts a bounded batch of listening sessions and recomputes affected daily stats in one
   * transaction. Upsert is keyed on `(userId, sessionId)`: ABS mutates open sessions in place, so a
   * re-fetched session with grown `timeListening` updates the existing row (and its stats) rather
   * than duplicating. Daily stats are recomputed per affected `libraryId` (the recompute + advisory
   * lock are `(userId, libraryId)`-scoped), mirroring the KOReader ingest path.
   */
  async ingestSessions(userId: number, timeZone: string, sessions: AbsMappedSession[]): Promise<AbsIngestSessionsResult> {
    if (sessions.length === 0) return { insertedSessionIds: [], updated: 0 };

    return this.db.transaction(async (tx) => {
      const sessionIds = sessions.map((session) => session.sessionId);
      const existing = await tx
        .select({ sessionId: schema.readingSessions.sessionId })
        .from(schema.readingSessions)
        .where(and(eq(schema.readingSessions.userId, userId), inArray(schema.readingSessions.sessionId, sessionIds)));
      const existingIds = new Set(existing.map((row) => row.sessionId));

      await tx
        .insert(schema.readingSessions)
        .values(
          sessions.map((session) => ({
            userId,
            bookFileId: session.bookFileId,
            bookId: session.bookId,
            // Latest non-deleted attempt for the book. The pipeline imports the ABS attempt before
            // sessions, so a finished book links to its completed attempt and an in-progress book to
            // its active one.
            attemptId: sql<number | null>`(
              select id from reading_attempts
              where user_id = ${userId} and book_id = ${session.bookId} and deleted_at is null
              order by id desc limit 1
            )`,
            sessionId: session.sessionId,
            source: 'audiobookshelf' as const,
            startedAt: session.startedAt,
            endedAt: session.endedAt,
            durationSeconds: session.durationSeconds,
            progressDelta: session.progressDelta,
            endProgress: session.endProgress,
          })),
        )
        .onConflictDoUpdate({
          target: [schema.readingSessions.userId, schema.readingSessions.sessionId],
          set: {
            bookFileId: sql`excluded.book_file_id`,
            endedAt: sql`excluded.ended_at`,
            durationSeconds: sql`excluded.duration_seconds`,
            progressDelta: sql`excluded.progress_delta`,
            endProgress: sql`excluded.end_progress`,
            attemptId: sql`coalesce(excluded.attempt_id, ${schema.readingSessions.attemptId})`,
          },
        });

      const daysByLibrary = new Map<number, Set<string>>();
      for (const session of sessions) {
        const days = daysByLibrary.get(session.libraryId) ?? new Set<string>();
        for (const day of getReadingSessionDayKeys(session, timeZone)) days.add(day);
        daysByLibrary.set(session.libraryId, days);
      }
      for (const [libraryId, days] of daysByLibrary) {
        await this.recomputeDailyStats(tx, userId, libraryId, [...days], timeZone);
      }

      const insertedSessionIds = sessions.map((session) => session.sessionId).filter((id) => !existingIds.has(id));
      return { insertedSessionIds, updated: sessions.length - insertedSessionIds.length };
    });
  }

  private async recomputeDailyStats(tx: Tx, userId: number, libraryId: number, days: string[], timeZone: string): Promise<void> {
    const affectedDays = [...new Set(days)].sort();
    if (affectedDays.length === 0) return;

    await tx.execute(sql`select pg_advisory_xact_lock(${userId}::int, ${libraryId}::int)`);

    await tx
      .delete(schema.userReadingDailyStats)
      .where(
        and(
          eq(schema.userReadingDailyStats.userId, userId),
          eq(schema.userReadingDailyStats.libraryId, libraryId),
          inArray(schema.userReadingDailyStats.day, affectedDays),
        ),
      );

    const range = getDayRangeForDateKeys(affectedDays, timeZone);
    if (!range) return;

    const rows = await tx
      .select({
        startedAt: schema.readingSessions.startedAt,
        endedAt: schema.readingSessions.endedAt,
        durationSeconds: schema.readingSessions.durationSeconds,
        progressDelta: schema.readingSessions.progressDelta,
      })
      .from(schema.readingSessions)
      .innerJoin(schema.books, eq(schema.books.id, schema.readingSessions.bookId))
      .where(
        and(
          eq(schema.readingSessions.userId, userId),
          eq(schema.books.libraryId, libraryId),
          lt(schema.readingSessions.startedAt, range.end),
          gt(schema.readingSessions.endedAt, range.start),
        ),
      );

    const segments = aggregateReadingSessionDailyStats(
      rows.map((row) => ({
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        durationSeconds: row.durationSeconds,
        progressDelta: row.progressDelta ?? null,
      })),
      timeZone,
      new Set(affectedDays),
    );
    await this.insertDailyStatsSegments(tx, userId, libraryId, segments);
  }

  private async insertDailyStatsSegments(tx: Tx, userId: number, libraryId: number, segments: ReadingDailyStatsSegment[]): Promise<void> {
    if (segments.length === 0) return;

    const now = new Date();
    await tx
      .insert(schema.userReadingDailyStats)
      .values(
        segments.map((segment) => ({
          userId,
          libraryId,
          day: segment.day,
          readingSeconds: segment.readingSeconds,
          progressDelta: segment.progressDelta,
          sessionsCount: segment.sessionsCount,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [schema.userReadingDailyStats.userId, schema.userReadingDailyStats.libraryId, schema.userReadingDailyStats.day],
        set: {
          readingSeconds: sql`excluded.reading_seconds`,
          progressDelta: sql`excluded.progress_delta`,
          sessionsCount: sql`excluded.sessions_count`,
          updatedAt: now,
        },
      });
  }
}
