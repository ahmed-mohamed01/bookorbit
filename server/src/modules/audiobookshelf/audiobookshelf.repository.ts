import { Inject, Injectable } from '@nestjs/common';
import type { AudiobookshelfBookStateBucket, ContentFilterRules } from '@bookorbit/types';
import { Permission } from '@bookorbit/types';
import { and, asc, desc, eq, gt, ilike, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import { buildContentFilterClauses } from '../../common/utils/content-filter-sql.utils';
import {
  aggregateReadingSessionDailyStats,
  getDayRangeForDateKeys,
  getReadingSessionDayKeys,
  type ReadingDailyStatsSegment,
} from '../../common/utils/reading-daily-stats.utils';
import type { AbsMappedSession } from './audiobookshelf-sessions.util';
import { AUDIOBOOKSHELF_DAILY_STATS_RECOMPUTE_SPAN_DAYS } from './audiobookshelf.constants';
import {
  audiobookshelfBookState,
  audiobookshelfUserSettings,
  type AudiobookshelfBookState,
  type AudiobookshelfUserSetting,
  type NewAudiobookshelfBookState,
  type NewAudiobookshelfUserSetting,
} from './schema/audiobookshelf.schema';

type Db = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type AudiobookshelfSettingsMutation = Partial<Omit<AudiobookshelfUserSetting, 'id' | 'userId' | 'createdAt' | 'updatedAt'>>;

export interface AbsIngestSessionsResult {
  insertedSessionIds: string[];
  updated: number;
}

const ISBN_ASIN_LOOKUP_CHUNK = 1000;
const BOOK_STATE_UPSERT_CHUNK = 500;
const normalizedAudibleId = sql<string>`upper(trim(${schema.bookMetadata.audibleId}))`;
const normalizedIsbn10 = sql<string>`upper(trim(${schema.bookMetadata.isbn10}))`;

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
  lastSeenInInventoryAt: Date;
}

export interface AbsBookAccessScope {
  libraryIds: number[];
  contentFilters?: ContentFilterRules;
}

export interface AbsEnabledUser {
  userId: number;
  lastDeepSessionScanAt: Date | null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function daySpanDays(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty!, tm! - 1, td!) - Date.UTC(fy!, fm! - 1, fd!)) / 86_400_000);
}

/**
 * Groups YYYY-MM-DD keys into windows no wider than `maxSpanDays`. Nearby days share one bounded
 * window (one recompute query), while far-apart days split into separate windows, so a recompute
 * never spans a multi-year range even when a single batch touches distant days. Input is sorted here
 * (callers pass Set-derived, unordered day keys), which the zero-padded keys make chronological.
 */
function groupDaysByBoundedSpan(days: string[], maxSpanDays: number): string[][] {
  const sortedDays = [...days].sort();
  const groups: string[][] = [];
  let current: string[] = [];
  for (const day of sortedDays) {
    if (current.length === 0 || daySpanDays(current[0]!, day) < maxSpanDays) {
      current.push(day);
    } else {
      groups.push(current);
      current = [day];
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

@Injectable()
export class AudiobookshelfRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  // Applies the Audiobookshelf schema bootstrap statements. DB access lives here rather than in the
  // bootstrap service so services never inject the Drizzle instance directly.
  async applySchemaStatements(statements: readonly string[]): Promise<void> {
    for (const statement of statements) {
      await this.db.execute(sql.raw(statement));
    }
  }

  async findSettings(userId: number): Promise<AudiobookshelfUserSetting | undefined> {
    const [row] = await this.db.select().from(audiobookshelfUserSettings).where(eq(audiobookshelfUserSettings.userId, userId)).limit(1);
    return row;
  }

  /**
   * Keyset page of users that have Audiobookshelf sync enabled and a non-empty server URL + token,
   * with each user's persisted deep-scan watermark. Ordered by userId ascending; callers advance
   * `afterUserId` to the last id of the prior page. Used by the scheduler so it never loads all users
   * unbounded and can decide deep-vs-incremental per user.
   */
  async findEnabledConfiguredUsers(afterUserId: number, limit: number): Promise<AbsEnabledUser[]> {
    return this.db
      .select({
        userId: audiobookshelfUserSettings.userId,
        lastDeepSessionScanAt: audiobookshelfUserSettings.lastDeepSessionScanAt,
      })
      .from(audiobookshelfUserSettings)
      .where(
        and(
          eq(audiobookshelfUserSettings.enabled, true),
          gt(audiobookshelfUserSettings.userId, afterUserId),
          sql`length(trim(${audiobookshelfUserSettings.serverUrl})) > 0`,
          sql`length(trim(${audiobookshelfUserSettings.apiToken})) > 0`,
        ),
      )
      .orderBy(asc(audiobookshelfUserSettings.userId))
      .limit(limit);
  }

  async upsertSettings(userId: number, data: AudiobookshelfSettingsMutation): Promise<AudiobookshelfUserSetting> {
    const [row] = await this.db
      .insert(audiobookshelfUserSettings)
      .values({ userId, ...data } as NewAudiobookshelfUserSetting)
      .onConflictDoUpdate({
        target: audiobookshelfUserSettings.userId,
        set: { ...data, updatedAt: new Date() },
      })
      .returning();
    return row!;
  }

  async updateSettings(userId: number, data: AudiobookshelfSettingsMutation): Promise<AudiobookshelfUserSetting | undefined> {
    const [row] = await this.db
      .update(audiobookshelfUserSettings)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(audiobookshelfUserSettings.userId, userId))
      .returning();
    return row;
  }

  async deleteSettings(userId: number): Promise<void> {
    await this.db.delete(audiobookshelfUserSettings).where(eq(audiobookshelfUserSettings.userId, userId));
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
        changedAt: sql<Date | string | null>`greatest(max(${schema.books.updatedAt}), max(${schema.bookMetadata.updatedAt}))`,
      })
      .from(schema.books)
      .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.books.id))
      .where(inArray(schema.books.libraryId, libraryIds));
    if (!row?.changedAt) return null;
    return row.changedAt instanceof Date ? row.changedAt : new Date(row.changedAt);
  }

  async findBookIdsByAudibleIds(libraryIds: number[], contentFilters: ContentFilterRules | undefined, asins: string[]): Promise<AbsExactMatchRow[]> {
    if (libraryIds.length === 0 || asins.length === 0) return [];
    const filters = contentFilters ? buildContentFilterClauses(contentFilters, this.db) : [];
    const results: AbsExactMatchRow[] = [];
    for (const group of chunk(asins, ISBN_ASIN_LOOKUP_CHUNK)) {
      const rows = await this.db
        .select({ key: normalizedAudibleId, bookId: schema.books.id })
        .from(schema.books)
        .innerJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.books.id))
        .where(and(inArray(schema.books.libraryId, libraryIds), eq(schema.books.status, 'present'), inArray(normalizedAudibleId, group), ...filters));
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
        .select({ key: normalizedIsbn10, bookId: schema.books.id })
        .from(schema.books)
        .innerJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.books.id))
        .where(and(inArray(schema.books.libraryId, libraryIds), eq(schema.books.status, 'present'), inArray(normalizedIsbn10, group), ...filters));
      for (const row of rows) if (row.key) results.push({ key: row.key, bookId: row.bookId });
    }
    return results;
  }

  /**
   * Bounded, batched fuzzy candidate load for a whole reconcile page. The trigram ranking is
   * per-title (the `%` / `similarity` operators rank against one query string), but author and
   * series enrichment is loaded once across the union of candidate books - not 3 queries per residual
   * item. Titles are deduplicated so repeated ABS titles query only once. Never a full-library scan:
   * only residual items that failed the exact tiers reach here, and each title is capped at `limitPerTitle`.
   */
  async findFuzzyCandidatesForTitles(
    libraryIds: number[],
    contentFilters: ContentFilterRules | undefined,
    titles: string[],
    limitPerTitle: number,
  ): Promise<Map<string, AbsFuzzyCandidate[]>> {
    const byTitle = new Map<string, AbsFuzzyCandidate[]>();
    if (libraryIds.length === 0) return byTitle;
    const uniqueTitles = [...new Set(titles.map((title) => title.trim()).filter((title) => title.length > 0))];
    if (uniqueTitles.length === 0) return byTitle;

    const filters = contentFilters ? buildContentFilterClauses(contentFilters, this.db) : [];
    const candidateRowsByTitle = new Map<string, { bookId: number; title: string | null }[]>();
    const bookIds = new Set<number>();

    for (const title of uniqueTitles) {
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
        .limit(limitPerTitle);
      candidateRowsByTitle.set(title, rows);
      for (const row of rows) bookIds.add(row.bookId);
    }

    if (bookIds.size === 0) return byTitle;
    const authorsByBook = await this.loadAuthorsByBook([...bookIds]);
    const seriesByBook = await this.loadSeriesByBook([...bookIds]);

    for (const [title, rows] of candidateRowsByTitle) {
      byTitle.set(
        title,
        rows.map((row) => ({
          bookId: row.bookId,
          title: row.title,
          authors: authorsByBook.get(row.bookId) ?? [],
          series: seriesByBook.get(row.bookId) ?? [],
        })),
      );
    }
    return byTitle;
  }

  private async loadAuthorsByBook(bookIds: number[]): Promise<Map<number, string[]>> {
    const authorsByBook = new Map<number, string[]>();
    for (const group of chunk(bookIds, ISBN_ASIN_LOOKUP_CHUNK)) {
      const rows = await this.db
        .select({ bookId: schema.bookAuthors.bookId, name: schema.authors.name })
        .from(schema.bookAuthors)
        .innerJoin(schema.authors, eq(schema.authors.id, schema.bookAuthors.authorId))
        .where(inArray(schema.bookAuthors.bookId, group))
        .orderBy(asc(schema.bookAuthors.bookId), asc(schema.bookAuthors.displayOrder), asc(schema.bookAuthors.authorId));
      for (const row of rows) {
        const list = authorsByBook.get(row.bookId) ?? [];
        list.push(row.name);
        authorsByBook.set(row.bookId, list);
      }
    }
    return authorsByBook;
  }

  private async loadSeriesByBook(bookIds: number[]): Promise<Map<number, AbsFuzzyCandidateSeries[]>> {
    const seriesByBook = new Map<number, AbsFuzzyCandidateSeries[]>();
    for (const group of chunk(bookIds, ISBN_ASIN_LOOKUP_CHUNK)) {
      const rows = await this.db
        .select({ bookId: schema.bookSeriesMemberships.bookId, name: schema.bookSeries.name, seriesIndex: schema.bookSeriesMemberships.seriesIndex })
        .from(schema.bookSeriesMemberships)
        .innerJoin(schema.bookSeries, eq(schema.bookSeries.id, schema.bookSeriesMemberships.seriesId))
        .where(inArray(schema.bookSeriesMemberships.bookId, group))
        .orderBy(asc(schema.bookSeriesMemberships.bookId), asc(schema.bookSeriesMemberships.displayOrder));
      for (const row of rows) {
        const list = seriesByBook.get(row.bookId) ?? [];
        list.push({ name: row.name, seriesIndex: row.seriesIndex });
        seriesByBook.set(row.bookId, list);
      }
    }
    return seriesByBook;
  }

  async findBookStatesByAbsItemIds(userId: number, absLibraryItemIds: string[]): Promise<AudiobookshelfBookState[]> {
    if (absLibraryItemIds.length === 0) return [];
    const results: AudiobookshelfBookState[] = [];
    for (const group of chunk(absLibraryItemIds, ISBN_ASIN_LOOKUP_CHUNK)) {
      const rows = await this.db
        .select()
        .from(audiobookshelfBookState)
        .where(and(eq(audiobookshelfBookState.userId, userId), inArray(audiobookshelfBookState.absLibraryItemId, group)));
      results.push(...rows);
    }
    return results;
  }

  /**
   * Staged-prune step 1: stamp `lastSeenInInventoryAt` on every row whose item was observed in the
   * current reconcile pass. Bounded by chunking so a huge page never builds one oversized statement.
   */
  async markBookStatesSeenInInventory(userId: number, absLibraryItemIds: string[], seenAt: Date): Promise<void> {
    if (absLibraryItemIds.length === 0) return;
    for (const group of chunk(absLibraryItemIds, ISBN_ASIN_LOOKUP_CHUNK)) {
      await this.db
        .update(audiobookshelfBookState)
        .set({ lastSeenInInventoryAt: seenAt })
        .where(and(eq(audiobookshelfBookState.userId, userId), inArray(audiobookshelfBookState.absLibraryItemId, group)));
    }
  }

  /**
   * Staged-prune step 2: delete rows not stamped during the current reconcile pass (marker predates
   * the run start or is null). Replaces passing the full inventory id array into the delete. Callers
   * must skip this when the inventory was empty, to avoid wiping links on a transient empty response.
   */
  async pruneBookStatesNotSeenSince(userId: number, runStartedAt: Date): Promise<number> {
    const result = await this.db
      .delete(audiobookshelfBookState)
      .where(
        and(
          eq(audiobookshelfBookState.userId, userId),
          or(isNull(audiobookshelfBookState.lastSeenInInventoryAt), lt(audiobookshelfBookState.lastSeenInInventoryAt, runStartedAt)),
        ),
      );
    return result.rowCount ?? 0;
  }

  async bulkUpsertBookStates(userId: number, rows: AbsBookStateUpsert[]): Promise<void> {
    if (rows.length === 0) return;
    for (const group of chunk(rows, BOOK_STATE_UPSERT_CHUNK)) {
      await this.db
        .insert(audiobookshelfBookState)
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
            lastSeenInInventoryAt: row.lastSeenInInventoryAt,
            manualUnlinked: false,
          })),
        )
        .onConflictDoUpdate({
          target: [audiobookshelfBookState.userId, audiobookshelfBookState.absLibraryItemId],
          set: {
            absTitle: sql`excluded.abs_title`,
            absAuthorName: sql`excluded.abs_author_name`,
            bookId: sql`excluded.book_id`,
            matchMethod: sql`excluded.match_method`,
            matchConfidence: sql`excluded.match_confidence`,
            needsReview: sql`excluded.needs_review`,
            matchError: sql`excluded.match_error`,
            lastMatchAttemptAt: sql`excluded.last_match_attempt_at`,
            lastSeenInInventoryAt: sql`excluded.last_seen_in_inventory_at`,
            manualUnlinked: false,
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
      where ${schema.bookAuthors.bookId} = ${audiobookshelfBookState.bookId}
      order by ${schema.bookAuthors.displayOrder} asc, ${schema.bookAuthors.authorId} asc
      limit 1
    )`;
  }

  private bucketClause(bucket: AudiobookshelfBookStateBucket): SQL | undefined {
    switch (bucket) {
      case 'linked':
        return and(
          sql`${audiobookshelfBookState.bookId} is not null`,
          eq(audiobookshelfBookState.needsReview, false),
          isNull(audiobookshelfBookState.matchError),
        );
      case 'needs-review':
        return eq(audiobookshelfBookState.needsReview, true);
      case 'unmatched':
        return isNull(audiobookshelfBookState.bookId);
    }
  }

  private scopedBookClauses(scope: AbsBookAccessScope): SQL[] {
    if (scope.libraryIds.length === 0) return [sql`false`];
    const filters = scope.contentFilters ? buildContentFilterClauses(scope.contentFilters, this.db) : [];
    return [inArray(schema.books.libraryId, scope.libraryIds), eq(schema.books.status, 'present'), ...filters];
  }

  private linkedStateScopeClause(scope: AbsBookAccessScope): SQL {
    return and(isNotNull(audiobookshelfBookState.bookId), ...this.scopedBookClauses(scope))!;
  }

  async listBookStates(
    userId: number,
    scope: AbsBookAccessScope,
    bucket: AudiobookshelfBookStateBucket,
    page: number,
    pageSize: number,
    q: string | undefined,
  ): Promise<{ items: AbsBookStateView[]; total: number }> {
    const clauses: SQL[] = [eq(audiobookshelfBookState.userId, userId)];
    const bucketClause = this.bucketClause(bucket);
    if (bucketClause) clauses.push(bucketClause);
    if (bucket === 'linked' || bucket === 'needs-review') {
      clauses.push(this.linkedStateScopeClause(scope));
    }
    if (q && q.trim()) {
      const pattern = `%${q.trim()}%`;
      clauses.push(or(ilike(audiobookshelfBookState.absTitle, pattern), ilike(schema.bookMetadata.title, pattern))!);
    }
    const where = and(...clauses);

    const [{ total }] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(audiobookshelfBookState)
      .leftJoin(schema.books, eq(schema.books.id, audiobookshelfBookState.bookId))
      .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, audiobookshelfBookState.bookId))
      .where(where);

    const items = await this.db
      .select({
        absLibraryItemId: audiobookshelfBookState.absLibraryItemId,
        absTitle: audiobookshelfBookState.absTitle,
        absAuthorName: audiobookshelfBookState.absAuthorName,
        bookId: audiobookshelfBookState.bookId,
        bookTitle: schema.bookMetadata.title,
        bookAuthorName: this.bookAuthorNameSql(),
        matchMethod: audiobookshelfBookState.matchMethod,
        matchConfidence: audiobookshelfBookState.matchConfidence,
        needsReview: audiobookshelfBookState.needsReview,
        matchError: audiobookshelfBookState.matchError,
        syncExcluded: audiobookshelfBookState.syncExcluded,
        syncError: audiobookshelfBookState.syncError,
        lastSyncedAt: audiobookshelfBookState.lastSyncedAt,
      })
      .from(audiobookshelfBookState)
      .leftJoin(schema.books, eq(schema.books.id, audiobookshelfBookState.bookId))
      .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, audiobookshelfBookState.bookId))
      .where(where)
      .orderBy(desc(audiobookshelfBookState.updatedAt), asc(audiobookshelfBookState.absLibraryItemId))
      .limit(pageSize)
      .offset(page * pageSize);

    return { items, total: total ?? 0 };
  }

  async findBookStateView(userId: number, absLibraryItemId: string, scope?: AbsBookAccessScope): Promise<AbsBookStateView | null> {
    const clauses: SQL[] = [eq(audiobookshelfBookState.userId, userId), eq(audiobookshelfBookState.absLibraryItemId, absLibraryItemId)];
    if (scope) {
      clauses.push(or(isNull(audiobookshelfBookState.bookId), this.linkedStateScopeClause(scope))!);
    }

    const [row] = await this.db
      .select({
        absLibraryItemId: audiobookshelfBookState.absLibraryItemId,
        absTitle: audiobookshelfBookState.absTitle,
        absAuthorName: audiobookshelfBookState.absAuthorName,
        bookId: audiobookshelfBookState.bookId,
        bookTitle: schema.bookMetadata.title,
        bookAuthorName: this.bookAuthorNameSql(),
        matchMethod: audiobookshelfBookState.matchMethod,
        matchConfidence: audiobookshelfBookState.matchConfidence,
        needsReview: audiobookshelfBookState.needsReview,
        matchError: audiobookshelfBookState.matchError,
        syncExcluded: audiobookshelfBookState.syncExcluded,
        syncError: audiobookshelfBookState.syncError,
        lastSyncedAt: audiobookshelfBookState.lastSyncedAt,
      })
      .from(audiobookshelfBookState)
      .leftJoin(schema.books, eq(schema.books.id, audiobookshelfBookState.bookId))
      .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, audiobookshelfBookState.bookId))
      .where(and(...clauses))
      .limit(1);
    return row ?? null;
  }

  async findBookStateRow(userId: number, absLibraryItemId: string): Promise<AudiobookshelfBookState | undefined> {
    const [row] = await this.db
      .select()
      .from(audiobookshelfBookState)
      .where(and(eq(audiobookshelfBookState.userId, userId), eq(audiobookshelfBookState.absLibraryItemId, absLibraryItemId)))
      .limit(1);
    return row;
  }

  async updateBookState(
    userId: number,
    absLibraryItemId: string,
    patch: Partial<Omit<AudiobookshelfBookState, 'id' | 'userId' | 'absLibraryItemId' | 'createdAt' | 'updatedAt'>>,
  ): Promise<void> {
    await this.db
      .update(audiobookshelfBookState)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(audiobookshelfBookState.userId, userId), eq(audiobookshelfBookState.absLibraryItemId, absLibraryItemId)));
  }

  async findSyncableBookStatesByAbsItemIds(
    userId: number,
    scope: AbsBookAccessScope,
    absLibraryItemIds: string[],
  ): Promise<AudiobookshelfBookState[]> {
    if (absLibraryItemIds.length === 0) return [];
    const results: AudiobookshelfBookState[] = [];
    for (const group of chunk(absLibraryItemIds, ISBN_ASIN_LOOKUP_CHUNK)) {
      const rows = await this.db
        .select()
        .from(audiobookshelfBookState)
        .innerJoin(schema.books, eq(schema.books.id, audiobookshelfBookState.bookId))
        .where(
          and(
            eq(audiobookshelfBookState.userId, userId),
            inArray(audiobookshelfBookState.absLibraryItemId, group),
            eq(audiobookshelfBookState.needsReview, false),
            eq(audiobookshelfBookState.syncExcluded, false),
            isNull(audiobookshelfBookState.matchError),
            this.linkedStateScopeClause(scope),
          ),
        );
      results.push(...rows.map((row) => row.audiobookshelf_book_state));
    }
    return results;
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

  async findSidecarCoverCandidatesByBookIds(
    bookIds: number[],
  ): Promise<{ bookId: number; absolutePath: string; format: string | null; metadataPrecedence: string[]; organizationMode: string }[]> {
    if (bookIds.length === 0) return [];
    const results: { bookId: number; absolutePath: string; format: string | null; metadataPrecedence: string[]; organizationMode: string }[] = [];
    for (const group of chunk(bookIds, ISBN_ASIN_LOOKUP_CHUNK)) {
      const rows = await this.db
        .select({
          bookId: schema.bookFiles.bookId,
          absolutePath: schema.bookFiles.absolutePath,
          format: schema.bookFiles.format,
          metadataPrecedence: schema.libraries.metadataPrecedence,
          organizationMode: schema.libraries.organizationMode,
        })
        .from(schema.bookFiles)
        .innerJoin(schema.books, eq(schema.books.id, schema.bookFiles.bookId))
        .innerJoin(schema.libraries, eq(schema.libraries.id, schema.books.libraryId))
        .where(and(inArray(schema.bookFiles.bookId, group), eq(schema.bookFiles.role, 'cover')));
      results.push(...rows);
    }
    return results;
  }

  async findAudioFilesInPlayOrder(bookId: number): Promise<{ id: number; format: string | null; durationSeconds: number | null }[]> {
    return this.db
      .select({ id: schema.bookFiles.id, format: schema.bookFiles.format, durationSeconds: schema.bookFiles.durationSeconds })
      .from(schema.bookFiles)
      .where(and(eq(schema.bookFiles.bookId, bookId), eq(schema.bookFiles.role, 'content')))
      .orderBy(asc(schema.bookFiles.sortOrder), asc(schema.bookFiles.id));
  }

  async findAudioFilesInPlayOrderForBooks(
    bookIds: number[],
  ): Promise<Map<number, { id: number; format: string | null; durationSeconds: number | null }[]>> {
    const byBook = new Map<number, { id: number; format: string | null; durationSeconds: number | null }[]>();
    if (bookIds.length === 0) return byBook;
    const rows = await this.db
      .select({
        bookId: schema.bookFiles.bookId,
        id: schema.bookFiles.id,
        format: schema.bookFiles.format,
        durationSeconds: schema.bookFiles.durationSeconds,
      })
      .from(schema.bookFiles)
      .where(and(inArray(schema.bookFiles.bookId, [...new Set(bookIds)]), eq(schema.bookFiles.role, 'content')))
      .orderBy(asc(schema.bookFiles.bookId), asc(schema.bookFiles.sortOrder), asc(schema.bookFiles.id));
    for (const row of rows) {
      const list = byBook.get(row.bookId) ?? [];
      list.push({ id: row.id, format: row.format, durationSeconds: row.durationSeconds });
      byBook.set(row.bookId, list);
    }
    return byBook;
  }

  async findAudioProgress(userId: number, bookId: number) {
    const [row] = await this.db
      .select()
      .from(schema.audiobookProgress)
      .where(and(eq(schema.audiobookProgress.userId, userId), eq(schema.audiobookProgress.bookId, bookId)))
      .limit(1);
    return row ?? null;
  }

  async upsertAudioProgress(userId: number, bookId: number, currentFileId: number, positionSeconds: number, percentage: number) {
    const now = new Date();
    const [row] = await this.db
      .insert(schema.audiobookProgress)
      .values({ userId, bookId, currentFileId, positionSeconds, percentage, updatedAt: now })
      .onConflictDoUpdate({
        target: [schema.audiobookProgress.userId, schema.audiobookProgress.bookId],
        set: { currentFileId, positionSeconds, percentage, updatedAt: now },
      })
      .returning();
    return row;
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

      const affected = await tx
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
          // Change guard: a re-fetched overlap row that is byte-for-byte identical is left untouched, so
          // unchanged history is never rewritten and its days are not recomputed. `is distinct from`
          // treats nulls correctly. A grown open session (extended endedAt/duration) still updates.
          setWhere: sql`
            ${schema.readingSessions.bookFileId} is distinct from excluded.book_file_id
            or ${schema.readingSessions.endedAt} is distinct from excluded.ended_at
            or ${schema.readingSessions.durationSeconds} is distinct from excluded.duration_seconds
            or ${schema.readingSessions.progressDelta} is distinct from excluded.progress_delta
            or ${schema.readingSessions.endProgress} is distinct from excluded.end_progress
          `,
        })
        .returning({ sessionId: schema.readingSessions.sessionId });

      // RETURNING yields only rows that were inserted or actually updated; rows skipped by the change
      // guard are absent. Recompute daily stats for just those days, not every submitted overlap day.
      const affectedIds = new Set(affected.map((row) => row.sessionId));

      const daysByLibrary = new Map<number, Set<string>>();
      for (const session of sessions) {
        if (!affectedIds.has(session.sessionId)) continue;
        const days = daysByLibrary.get(session.libraryId) ?? new Set<string>();
        for (const day of getReadingSessionDayKeys(session, timeZone)) days.add(day);
        daysByLibrary.set(session.libraryId, days);
      }
      for (const [libraryId, days] of daysByLibrary) {
        await this.recomputeDailyStats(tx, userId, libraryId, [...days], timeZone);
      }

      const insertedSessionIds = sessionIds.filter((id) => !existingIds.has(id));
      const updated = [...affectedIds].filter((id) => existingIds.has(id)).length;
      return { insertedSessionIds, updated };
    });
  }

  private async recomputeDailyStats(tx: Tx, userId: number, libraryId: number, days: string[], timeZone: string): Promise<void> {
    const affectedDays = [...new Set(days)].sort();
    if (affectedDays.length === 0) return;

    await tx.execute(sql`select pg_advisory_xact_lock(${userId}::int, ${libraryId}::int)`);

    // Far-apart affected days (common during a multi-year backfill) are split into bounded windows so
    // each recompute query loads at most a month of session history into memory, never the full range.
    for (const group of groupDaysByBoundedSpan(affectedDays, AUDIOBOOKSHELF_DAILY_STATS_RECOMPUTE_SPAN_DAYS)) {
      await this.recomputeDailyStatsForDays(tx, userId, libraryId, group, timeZone);
    }
  }

  private async recomputeDailyStatsForDays(tx: Tx, userId: number, libraryId: number, days: string[], timeZone: string): Promise<void> {
    if (days.length === 0) return;

    await tx
      .delete(schema.userReadingDailyStats)
      .where(
        and(
          eq(schema.userReadingDailyStats.userId, userId),
          eq(schema.userReadingDailyStats.libraryId, libraryId),
          inArray(schema.userReadingDailyStats.day, days),
        ),
      );

    const range = getDayRangeForDateKeys(days, timeZone);
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
      new Set(days),
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
