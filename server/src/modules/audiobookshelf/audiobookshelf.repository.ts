import { Inject, Injectable } from '@nestjs/common';
import type { AudiobookshelfBookStateBucket, ContentFilterRules } from '@bookorbit/types';
import { Permission } from '@bookorbit/types';
import { and, asc, desc, eq, gt, ilike, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import { buildContentFilterClauses } from '../../common/utils/content-filter-sql.utils';
import { AUDIO_FORMATS } from '../scanner/lib/classify';
import {
  aggregateReadingSessionDailyStats,
  getDayRangeForDateKeys,
  getReadingSessionDayKeys,
  type ReadingDailyStatsSegment,
} from '../../common/utils/reading-daily-stats.utils';
import { chunk } from '../../common/utils/batch.utils';
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
  // Session ids inserted OR actually updated this batch (the RETURNING rows). A no-op re-ingest that
  // touches nothing returns an empty array. Callers map these back to books to emit change events.
  affectedSessionIds: string[];
  // Deltas for the rows whose `progress_delta` this batch actually changed, keyed by `sessionId`.
  // Only covers changed rows, so a no-op re-ingest returns an empty map.
  progressDeltaBySessionId: Map<string, number | null>;
}

type AbsProgressDeltaRow = {
  sessionId: string;
  libraryId: number;
  startedAt: Date;
  endedAt: Date;
  durationSeconds: number;
  progressDelta: number | null;
};

// Raw shape of the same row: drizzle installs identity type parsers for timestamps, so a raw
// `execute` hands back strings where a query-builder select would hand back `Date`.
type AbsProgressDeltaSqlRow = {
  sessionId: string;
  libraryId: number;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  progressDelta: number | null;
};

const ISBN_ASIN_LOOKUP_CHUNK = 1000;
// Paths are up to 4096 chars, so the IN-list is chunked tighter than the ISBN/ASIN one.
const PATH_LOOKUP_CHUNK = 500;
const BOOK_STATE_UPSERT_CHUNK = 500;
const BOOK_STATE_DELETE_CHUNK = 500;
const FUZZY_TITLE_LOOKUP_CHUNK = 100;
const BOOK_ID_LOOKUP_CHUNK = 500;
// Folder roots are a UI hint list, so the read stays bounded even for a user with many libraries.
const LIBRARY_FOLDER_PATH_LIMIT = 500;
const normalizedAudibleId = sql<string>`upper(trim(${schema.bookMetadata.audibleId}))`;
const normalizedIsbn10 = sql<string>`upper(trim(${schema.bookMetadata.isbn10}))`;

export interface AbsExactMatchRow {
  key: string;
  bookId: number;
}

export interface AbsFuzzyCandidateSeries {
  name: string;
  seriesIndex: string | null;
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
  absSeriesName: string | null;
  absLibraryName: string | null;
  absPath: string | null;
  bookId: number | null;
  bookTitle: string | null;
  bookAuthorName: string | null;
  bookSeriesName: string | null;
  bookLibraryName: string | null;
  bookFolderPath: string | null;
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
  absSeriesName: string | null;
  absLibraryName: string | null;
  absPath: string | null;
  bookId: number | null;
  matchMethod: string | null;
  matchConfidence: number | null;
  needsReview: boolean;
  matchError: string | null;
  lastMatchAttemptAt: Date;
}

/** Minimal columns the stale-entry cleanup needs to classify a row without loading the whole state. */
export interface AbsBookStateCleanupCandidate {
  id: number;
  absLibraryItemId: string;
  bookId: number | null;
  syncExcluded: boolean;
  manualUnlinked: boolean;
}

export interface AbsBookAccessScope {
  libraryIds: number[];
  contentFilters?: ContentFilterRules;
}

export interface AbsEnabledUser {
  userId: number;
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
   * Keyset page of users that have Audiobookshelf sync enabled and a non-empty server URL + token.
   * Ordered by userId ascending; callers advance `afterUserId` to the last id of the prior page. Used
   * by the scheduler so it never loads all users unbounded.
   */
  async findEnabledConfiguredUsers(afterUserId: number, limit: number): Promise<AbsEnabledUser[]> {
    return this.db
      .select({
        userId: audiobookshelfUserSettings.userId,
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

  /**
   * Narrow single-column write for the stale-entry counter, kept apart from `updateSettings` so a
   * bookkeeping write never reads the credential row back.
   */
  async updateStaleCount(userId: number, staleCount: number): Promise<void> {
    await this.db.update(audiobookshelfUserSettings).set({ staleCount, updatedAt: new Date() }).where(eq(audiobookshelfUserSettings.userId, userId));
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
   * Distinct root folder paths of the given libraries, sorted, for the folder-mapping hints on the
   * connection card. Callers pass the user's accessible library ids, so the result never leaves that
   * scope, and the read is capped so a very large setup cannot return an unbounded list.
   */
  async findLibraryFolderPaths(libraryIds: number[]): Promise<string[]> {
    if (libraryIds.length === 0) return [];
    const rows = await this.db
      .selectDistinct({ path: schema.libraryFolders.path })
      .from(schema.libraryFolders)
      .where(inArray(schema.libraryFolders.libraryId, libraryIds))
      .orderBy(asc(schema.libraryFolders.path))
      .limit(LIBRARY_FOLDER_PATH_LIMIT);
    return rows.map((row) => row.path);
  }

  /**
   * One keyset page of the distinct book folder paths in the user's accessible scope, ascending, for
   * folder-mapping inference. Same scoping as the exact match tiers (accessible libraries, content
   * filters, status 'present'). Keyset on the path itself (not offset) so a library with tens of
   * thousands of books is walked in bounded pages; callers pass the last path of the prior page.
   */
  async findDistinctBookFolderPaths(
    libraryIds: number[],
    contentFilters: ContentFilterRules | undefined,
    afterPath: string | null,
    limit: number,
  ): Promise<string[]> {
    if (libraryIds.length === 0) return [];
    const filters = contentFilters ? buildContentFilterClauses(contentFilters, this.db) : [];
    const rows = await this.db
      .selectDistinct({ folderPath: schema.books.folderPath })
      .from(schema.books)
      .where(
        and(
          inArray(schema.books.libraryId, libraryIds),
          eq(schema.books.status, 'present'),
          ...(afterPath != null ? [gt(schema.books.folderPath, afterPath)] : []),
          ...filters,
        ),
      )
      .orderBy(asc(schema.books.folderPath))
      .limit(limit);
    return rows.map((row) => row.folderPath);
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

  /**
   * ABS links target the audiobook copy of a work; ebook-only rows are edition-link territory. Every
   * candidate query carries this so an ABS item can never match (exactly or fuzzily) a book that has
   * no audio content at all.
   */
  private audioContentExists(): SQL {
    return sql`exists (
      select 1 from ${schema.bookFiles}
      where ${schema.bookFiles.bookId} = ${schema.books.id}
        and ${schema.bookFiles.role} = 'content'
        and ${inArray(schema.bookFiles.format, [...AUDIO_FORMATS])}
    )`;
  }

  private async matchByKey(libraryIds: number[], filters: SQL[], keyExpr: SQL<string>, values: string[]): Promise<AbsExactMatchRow[]> {
    const results: AbsExactMatchRow[] = [];
    for (const group of chunk(values, ISBN_ASIN_LOOKUP_CHUNK)) {
      const rows = await this.db
        .select({ key: keyExpr, bookId: schema.books.id })
        .from(schema.books)
        .innerJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.books.id))
        .where(
          and(
            inArray(schema.books.libraryId, libraryIds),
            eq(schema.books.status, 'present'),
            inArray(keyExpr, group),
            this.audioContentExists(),
            ...filters,
          ),
        );
      for (const row of rows) if (row.key) results.push({ key: row.key, bookId: row.bookId });
    }
    return results;
  }

  async findBookIdsByAudibleIds(libraryIds: number[], contentFilters: ContentFilterRules | undefined, asins: string[]): Promise<AbsExactMatchRow[]> {
    if (libraryIds.length === 0 || asins.length === 0) return [];
    const filters = contentFilters ? buildContentFilterClauses(contentFilters, this.db) : [];
    return this.matchByKey(libraryIds, filters, normalizedAudibleId, asins);
  }

  async findBookIdsByIsbns(libraryIds: number[], contentFilters: ContentFilterRules | undefined, isbns: string[]): Promise<AbsExactMatchRow[]> {
    if (libraryIds.length === 0 || isbns.length === 0) return [];
    const filters = contentFilters ? buildContentFilterClauses(contentFilters, this.db) : [];
    const isbn13s = isbns.filter((isbn) => isbn.length === 13);
    const isbn10s = isbns.filter((isbn) => isbn.length === 10);
    return [
      ...(await this.matchByKey(libraryIds, filters, sql<string>`${schema.bookMetadata.isbn13}`, isbn13s)),
      ...(await this.matchByKey(libraryIds, filters, normalizedIsbn10, isbn10s)),
    ];
  }

  /**
   * Books whose on-disk location equals one of the given BookOrbit absolute paths, keyed by the path
   * that matched. An ABS library item path is the item FOLDER for a folder-per-book library and the
   * file itself for a single-file item, so both domains are probed: the book's folder path and its
   * content-role files. Same scoping as the ISBN/ASIN tiers (accessible libraries, content filters,
   * status 'present'), and the same chunked IN-lists, so it stays index-driven on a large library.
   */
  async findBookIdsByPaths(libraryIds: number[], contentFilters: ContentFilterRules | undefined, paths: string[]): Promise<AbsExactMatchRow[]> {
    if (libraryIds.length === 0 || paths.length === 0) return [];
    const filters = contentFilters ? buildContentFilterClauses(contentFilters, this.db) : [];
    const results: AbsExactMatchRow[] = [];

    for (const group of chunk(paths, PATH_LOOKUP_CHUNK)) {
      const fileRows = await this.db
        .select({ key: schema.bookFiles.absolutePath, bookId: schema.books.id })
        .from(schema.books)
        .innerJoin(schema.bookFiles, eq(schema.bookFiles.bookId, schema.books.id))
        .where(
          and(
            inArray(schema.books.libraryId, libraryIds),
            eq(schema.books.status, 'present'),
            eq(schema.bookFiles.role, 'content'),
            inArray(schema.bookFiles.absolutePath, group),
            this.audioContentExists(),
            ...filters,
          ),
        );
      for (const row of fileRows) if (row.key) results.push({ key: row.key, bookId: row.bookId });

      const folderRows = await this.db
        .select({ key: schema.books.folderPath, bookId: schema.books.id })
        .from(schema.books)
        .where(
          and(
            inArray(schema.books.libraryId, libraryIds),
            eq(schema.books.status, 'present'),
            inArray(schema.books.folderPath, group),
            this.audioContentExists(),
            ...filters,
          ),
        );
      for (const row of folderRows) if (row.key) results.push({ key: row.key, bookId: row.bookId });
    }

    return results;
  }

  /**
   * Bounded, batched fuzzy candidate load for a whole reconcile page. The trigram ranking is
   * per-title (the `%` / `similarity` operators rank against one query string), but author and
   * series enrichment is loaded once across the union of candidate books - not 3 queries per residual
   * item. Titles are deduplicated so repeated ABS titles query only once. Never a full-library scan:
   * only residual items that failed the exact tiers reach here, and each title is capped at `limitPerTitle`.
   *
   * Titles are looked up a batch at a time via a VALUES list joined with CROSS JOIN LATERAL, so a
   * 500-item reconcile page costs ceil(n/100) round trips rather than one per title. The lateral keeps
   * the ranking and `limitPerTitle` per-title, which a flat `IN (...)` query could not express.
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
    // `buildContentFilterClauses` emits EXISTS subqueries correlated on `"books"."id"`, so `books`
    // must stay unaliased and in scope where these are spliced or the correlation silently breaks.
    const filterSql = filters.length > 0 ? sql` and ${sql.join(filters, sql` and `)}` : sql``;
    const candidateRowsByTitle = new Map<string, { bookId: number; title: string | null }[]>();
    for (const title of uniqueTitles) candidateRowsByTitle.set(title, []);
    const bookIds = new Set<number>();

    for (const group of chunk(uniqueTitles, FUZZY_TITLE_LOOKUP_CHUNK)) {
      const titleValues = sql.join(
        group.map((title) => sql`(${title}::text)`),
        sql`, `,
      );
      // The trailing `offset 0` in the EXISTS is a planner fence, not a real offset. Postgres cannot
      // estimate the selectivity of `title % v.q` against a correlated VALUES column, so it assumes a
      // default 600 rows; without the fence it flattens the EXISTS into a semi-join and hash-joins a
      // full sequential scan of `books` once per title. The fence keeps it a correlated subplan, so
      // the trigram index drives the lateral and `books` is probed by primary key.
      const result = await this.db.execute<{ queryTitle: string; bookId: number; title: string | null }>(sql`
        select v.q as "queryTitle", c.book_id as "bookId", c.title as "title"
        from (values ${titleValues}) as v(q)
        cross join lateral (
          select ${schema.bookMetadata.bookId} as book_id, ${schema.bookMetadata.title} as title,
                 similarity(${schema.bookMetadata.title}, v.q) as sim
          from ${schema.bookMetadata}
          where ${schema.bookMetadata.title} % v.q
            and exists (
              select 1
              from ${schema.books}
              where ${schema.books.id} = ${schema.bookMetadata.bookId}
                and ${inArray(schema.books.libraryId, libraryIds)}
                and ${eq(schema.books.status, 'present')}
                and ${this.audioContentExists()}
                ${filterSql}
              offset 0
            )
          order by similarity(${schema.bookMetadata.title}, v.q) desc, ${schema.bookMetadata.bookId} asc
          limit ${limitPerTitle}
        ) c
        order by v.q, c.sim desc, c.book_id asc
      `);
      for (const row of result.rows) {
        candidateRowsByTitle.get(row.queryTitle)?.push({ bookId: row.bookId, title: row.title });
        bookIds.add(row.bookId);
      }
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
   * Writes a matched batch, yielding to any user decision taken while the batch was being computed.
   * A match run reads state rows, then spends seconds on candidate queries before writing, so a
   * Confirm / manual link / unlink / exclude landing in that window would otherwise be overwritten by
   * a write built from state the user has already moved on from.
   *
   * `readAt` is when the caller read the state it based these rows on. It rides along as the inserted
   * `updated_at`, so the conflict branch can compare it against the row's current `updated_at` and
   * skip any row touched since. A skipped row is simply re-evaluated by the next run from fresh
   * state, which is why abandoning the write is safe rather than something to retry here.
   */
  /**
   * Refreshes only the ABS-side context columns (library, series, path) shown on the review cards.
   * Settled rows never re-enter the match upsert, so this is their only write path; it deliberately
   * cannot touch match state or updated_at, and the IS DISTINCT FROM guard keeps the steady-state
   * reconcile at zero row writes.
   */
  async refreshAbsContext(
    userId: number,
    rows: { absLibraryItemId: string; absSeriesName: string | null; absLibraryName: string | null; absPath: string | null }[],
  ): Promise<void> {
    if (rows.length === 0) return;
    for (const group of chunk(rows, BOOK_STATE_UPSERT_CHUNK)) {
      const values = sql.join(
        group.map(
          (row) => sql`(${row.absLibraryItemId}::varchar, ${row.absSeriesName}::varchar, ${row.absLibraryName}::varchar, ${row.absPath}::text)`,
        ),
        sql`, `,
      );
      await this.db.execute(sql`
        update ${audiobookshelfBookState} as s
        set abs_series_name = v.abs_series_name, abs_library_name = v.abs_library_name, abs_path = v.abs_path
        from (values ${values}) as v(abs_library_item_id, abs_series_name, abs_library_name, abs_path)
        where s.user_id = ${userId}
          and s.abs_library_item_id = v.abs_library_item_id
          and (s.abs_series_name is distinct from v.abs_series_name
            or s.abs_library_name is distinct from v.abs_library_name
            or s.abs_path is distinct from v.abs_path)
      `);
    }
  }

  async bulkUpsertBookStates(userId: number, rows: AbsBookStateUpsert[], readAt: Date): Promise<void> {
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
            absSeriesName: row.absSeriesName,
            absLibraryName: row.absLibraryName,
            absPath: row.absPath,
            bookId: row.bookId,
            matchMethod: row.matchMethod,
            matchConfidence: row.matchConfidence,
            needsReview: row.needsReview,
            matchError: row.matchError,
            lastMatchAttemptAt: row.lastMatchAttemptAt,
            manualUnlinked: false,
            updatedAt: readAt,
          })),
        )
        .onConflictDoUpdate({
          target: [audiobookshelfBookState.userId, audiobookshelfBookState.absLibraryItemId],
          set: {
            absTitle: sql`excluded.abs_title`,
            absAuthorName: sql`excluded.abs_author_name`,
            absSeriesName: sql`excluded.abs_series_name`,
            absLibraryName: sql`excluded.abs_library_name`,
            absPath: sql`excluded.abs_path`,
            bookId: sql`excluded.book_id`,
            matchMethod: sql`excluded.match_method`,
            matchConfidence: sql`excluded.match_confidence`,
            needsReview: sql`excluded.needs_review`,
            matchError: sql`excluded.match_error`,
            lastMatchAttemptAt: sql`excluded.last_match_attempt_at`,
            manualUnlinked: false,
            updatedAt: new Date(),
          },
          setWhere: sql`${audiobookshelfBookState.updatedAt} <= excluded.updated_at`,
        });
    }
  }

  /**
   * Drops the negative-match memo for the user's still-unmatched rows in one scoped UPDATE, so the
   * next scheduled sync re-attempts them instead of short-circuiting on `lastMatchAttemptAt`. Linked
   * rows keep theirs. Rows that never recorded an attempt are excluded so the write stays as narrow
   * as the memo it clears.
   */
  async clearMatchMemoForUnmatched(userId: number): Promise<number> {
    const result = await this.db
      .update(audiobookshelfBookState)
      .set({ lastMatchAttemptAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(audiobookshelfBookState.userId, userId),
          isNull(audiobookshelfBookState.bookId),
          isNotNull(audiobookshelfBookState.lastMatchAttemptAt),
        ),
      );
    return (result as { rowCount?: number }).rowCount ?? 0;
  }

  /**
   * One keyset page of the user's book-state rows, ascending by id, for the stale-entry cleanup scan.
   * Keyset (not offset) so a large library is walked in bounded memory without re-reading rows.
   */
  async findBookStateCleanupCandidates(userId: number, afterId: number, limit: number): Promise<AbsBookStateCleanupCandidate[]> {
    return this.db
      .select({
        id: audiobookshelfBookState.id,
        absLibraryItemId: audiobookshelfBookState.absLibraryItemId,
        bookId: audiobookshelfBookState.bookId,
        syncExcluded: audiobookshelfBookState.syncExcluded,
        manualUnlinked: audiobookshelfBookState.manualUnlinked,
      })
      .from(audiobookshelfBookState)
      .where(and(eq(audiobookshelfBookState.userId, userId), gt(audiobookshelfBookState.id, afterId)))
      .orderBy(asc(audiobookshelfBookState.id))
      .limit(limit);
  }

  /**
   * Deletes only rows that are still pure unmatched at delete time. The caller classifies them in
   * paged reads seconds earlier, so a row that gained a link, an exclusion, or (unless opted in) a
   * manual unlink in between would otherwise be deleted on evidence that no longer holds. The
   * row-state predicates mirror the caller's classification exactly; a row that no longer qualifies
   * simply survives and is reported as still stale.
   */
  async deleteBookStatesByAbsItemIds(userId: number, absLibraryItemIds: string[], options: { includeManuallyUnlinked: boolean }): Promise<number> {
    if (absLibraryItemIds.length === 0) return 0;
    let removed = 0;
    for (const group of chunk(absLibraryItemIds, BOOK_STATE_DELETE_CHUNK)) {
      const rows = await this.db
        .delete(audiobookshelfBookState)
        .where(
          and(
            eq(audiobookshelfBookState.userId, userId),
            inArray(audiobookshelfBookState.absLibraryItemId, group),
            isNull(audiobookshelfBookState.bookId),
            eq(audiobookshelfBookState.syncExcluded, false),
            ...(options.includeManuallyUnlinked ? [] : [eq(audiobookshelfBookState.manualUnlinked, false)]),
          ),
        )
        .returning({ id: audiobookshelfBookState.id });
      removed += rows.length;
    }
    return removed;
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

  private bookStateViewColumns() {
    return {
      absLibraryItemId: audiobookshelfBookState.absLibraryItemId,
      absTitle: audiobookshelfBookState.absTitle,
      absAuthorName: audiobookshelfBookState.absAuthorName,
      absSeriesName: audiobookshelfBookState.absSeriesName,
      absLibraryName: audiobookshelfBookState.absLibraryName,
      absPath: audiobookshelfBookState.absPath,
      bookId: audiobookshelfBookState.bookId,
      bookTitle: schema.bookMetadata.title,
      bookAuthorName: this.bookAuthorNameSql(),
      bookSeriesName: schema.bookMetadata.seriesName,
      bookLibraryName: schema.libraries.name,
      bookFolderPath: schema.books.folderPath,
      matchMethod: audiobookshelfBookState.matchMethod,
      matchConfidence: audiobookshelfBookState.matchConfidence,
      needsReview: audiobookshelfBookState.needsReview,
      matchError: audiobookshelfBookState.matchError,
      syncExcluded: audiobookshelfBookState.syncExcluded,
      syncError: audiobookshelfBookState.syncError,
      lastSyncedAt: audiobookshelfBookState.lastSyncedAt,
    };
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
      .select(this.bookStateViewColumns())
      .from(audiobookshelfBookState)
      .leftJoin(schema.books, eq(schema.books.id, audiobookshelfBookState.bookId))
      .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, audiobookshelfBookState.bookId))
      .leftJoin(schema.libraries, eq(schema.libraries.id, schema.books.libraryId))
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
      .select(this.bookStateViewColumns())
      .from(audiobookshelfBookState)
      .leftJoin(schema.books, eq(schema.books.id, audiobookshelfBookState.bookId))
      .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, audiobookshelfBookState.bookId))
      .leftJoin(schema.libraries, eq(schema.libraries.id, schema.books.libraryId))
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

  // Cover-role files for a bounded set of books, for the scanner's bulk cover-refresh seam. The
  // scanner knows its candidate books before it asks, so this never scans a whole library.
  async findCoverFilesForBooks(libraryId: number, bookIds: number[]): Promise<{ bookId: number; absolutePath: string; format: string | null }[]> {
    if (bookIds.length === 0) return [];
    const results: { bookId: number; absolutePath: string; format: string | null }[] = [];
    for (const group of chunk([...new Set(bookIds)], BOOK_ID_LOOKUP_CHUNK)) {
      const rows = await this.db
        .select({ bookId: schema.books.id, absolutePath: schema.bookFiles.absolutePath, format: schema.bookFiles.format })
        .from(schema.books)
        .innerJoin(schema.bookFiles, eq(schema.bookFiles.bookId, schema.books.id))
        .where(
          and(
            eq(schema.books.libraryId, libraryId),
            inArray(schema.books.id, group),
            ne(schema.books.status, 'missing'),
            eq(schema.bookFiles.role, 'cover'),
          ),
        );
      results.push(...rows);
    }
    return results;
  }

  async findAudioFilesInPlayOrderForBooks(
    bookIds: number[],
  ): Promise<Map<number, { id: number; format: string | null; durationSeconds: number | null }[]>> {
    const byBook = new Map<number, { id: number; format: string | null; durationSeconds: number | null }[]>();
    if (bookIds.length === 0) return byBook;
    for (const group of chunk([...new Set(bookIds)], BOOK_ID_LOOKUP_CHUNK)) {
      const rows = await this.db
        .select({
          bookId: schema.bookFiles.bookId,
          id: schema.bookFiles.id,
          format: schema.bookFiles.format,
          durationSeconds: schema.bookFiles.durationSeconds,
        })
        .from(schema.bookFiles)
        .where(and(inArray(schema.bookFiles.bookId, group), eq(schema.bookFiles.role, 'content')))
        .orderBy(asc(schema.bookFiles.bookId), asc(schema.bookFiles.sortOrder), asc(schema.bookFiles.id));
      for (const row of rows) {
        const list = byBook.get(row.bookId) ?? [];
        list.push({ id: row.id, format: row.format, durationSeconds: row.durationSeconds });
        byBook.set(row.bookId, list);
      }
    }
    return byBook;
  }

  // Local audio position rows for a batch of books, keyed by bookId. Feeds the sync loop's
  // newest-wins guard, which needs the same (percentage, updatedAt) pair the single-book read returned.
  async findAudioProgressForBooks(userId: number, bookIds: number[]): Promise<Map<number, { percentage: number; updatedAt: Date }>> {
    const byBook = new Map<number, { percentage: number; updatedAt: Date }>();
    if (bookIds.length === 0) return byBook;
    for (const group of chunk([...new Set(bookIds)], BOOK_ID_LOOKUP_CHUNK)) {
      const rows = await this.db
        .select({
          bookId: schema.audiobookProgress.bookId,
          percentage: schema.audiobookProgress.percentage,
          updatedAt: schema.audiobookProgress.updatedAt,
        })
        .from(schema.audiobookProgress)
        .where(and(eq(schema.audiobookProgress.userId, userId), inArray(schema.audiobookProgress.bookId, group)));
      for (const row of rows) byBook.set(row.bookId, { percentage: row.percentage, updatedAt: row.updatedAt });
    }
    return byBook;
  }

  /**
   * Position write with a compare-and-swap on updatedAt: the batched pre-load's snapshot is the row
   * version this write is allowed to replace. A concurrent local write (web player, Kobo, KOReader)
   * between pre-load and apply changes updatedAt, the guard misses, and the write is dropped, so a
   * stale ABS position can never rewind live local playback. With no snapshot the insert yields to
   * any row that appeared since (local playback started mid-run, local wins).
   */
  async upsertAudioProgressGuarded(
    userId: number,
    bookId: number,
    currentFileId: number,
    positionSeconds: number,
    percentage: number,
    expectedUpdatedAt: Date | null,
  ) {
    const now = new Date();
    if (expectedUpdatedAt == null) {
      const [row] = await this.db
        .insert(schema.audiobookProgress)
        .values({ userId, bookId, currentFileId, positionSeconds, percentage, updatedAt: now })
        .onConflictDoNothing({ target: [schema.audiobookProgress.userId, schema.audiobookProgress.bookId] })
        .returning();
      return row;
    }
    const [row] = await this.db
      .update(schema.audiobookProgress)
      .set({ currentFileId, positionSeconds, percentage, updatedAt: now })
      .where(
        and(
          eq(schema.audiobookProgress.userId, userId),
          eq(schema.audiobookProgress.bookId, bookId),
          eq(schema.audiobookProgress.updatedAt, expectedUpdatedAt),
        ),
      )
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
    if (sessions.length === 0) return { insertedSessionIds: [], updated: 0, affectedSessionIds: [], progressDeltaBySessionId: new Map() };

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
            // The attempt whose date range CONTAINS this session. Historical backfill spans re-reads,
            // so neither "latest attempt" nor KOReader's "active attempt" is correct here - both file
            // a session from a first read onto the second attempt. Undated attempts (origin
            // 'migration') sort last so they only catch sessions no dated attempt brackets; a session
            // falling in a gap between attempts resolves to null rather than being misattributed.
            // Compared in the user's timezone to match how started_on/ended_on were derived.
            attemptId: sql<number | null>`(
              select id from reading_attempts
              where user_id = ${userId} and book_id = ${session.bookId} and deleted_at is null
                and (started_on is null or started_on <= (${session.startedAt} at time zone ${timeZone})::date)
                and (ended_on   is null or ended_on   >= (${session.startedAt} at time zone ${timeZone})::date)
              order by started_on desc nulls last
              limit 1
            )`,
            sessionId: session.sessionId,
            source: 'audiobookshelf' as const,
            startedAt: session.startedAt,
            endedAt: session.endedAt,
            durationSeconds: session.durationSeconds,
            // Owned by `recomputeProgressDeltas` below, never by the ABS payload: it is derived from
            // the stored per-book history, so it is deliberately absent from the on-conflict set and
            // from the change guard. Writing it here would clobber a computed value with null on every
            // re-fetch and make the guard fire forever.
            progressDelta: null,
            endProgress: session.endProgress,
          })),
        )
        .onConflictDoUpdate({
          target: [schema.readingSessions.userId, schema.readingSessions.sessionId],
          set: {
            bookFileId: sql`excluded.book_file_id`,
            endedAt: sql`excluded.ended_at`,
            durationSeconds: sql`excluded.duration_seconds`,
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
            or ${schema.readingSessions.endProgress} is distinct from excluded.end_progress
          `,
        })
        .returning({ sessionId: schema.readingSessions.sessionId });

      // RETURNING yields only rows that were inserted or actually updated; rows skipped by the change
      // guard are absent. Recompute daily stats for just those days, not every submitted overlap day.
      const affectedIds = new Set(affected.map((row) => row.sessionId));

      const deltaRows = await this.recomputeProgressDeltas(tx, userId, sessionIds);

      const daysByLibrary = new Map<number, Set<string>>();
      const addDays = (libraryId: number, keys: string[]) => {
        const days = daysByLibrary.get(libraryId) ?? new Set<string>();
        for (const day of keys) days.add(day);
        daysByLibrary.set(libraryId, days);
      };
      for (const session of sessions) {
        if (!affectedIds.has(session.sessionId)) continue;
        addDays(session.libraryId, getReadingSessionDayKeys({ ...session, progressDelta: null }, timeZone));
      }
      // A delta change also invalidates a day, and it can land on a row outside this batch (the
      // corrected successor of a late-arriving session), so those days are folded in here.
      for (const row of deltaRows) {
        addDays(row.libraryId, getReadingSessionDayKeys(row, timeZone));
      }
      for (const [libraryId, days] of daysByLibrary) {
        await this.recomputeDailyStats(tx, userId, libraryId, [...days], timeZone);
      }

      const insertedSessionIds = sessionIds.filter((id) => !existingIds.has(id));
      const updated = [...affectedIds].filter((id) => existingIds.has(id)).length;
      return {
        insertedSessionIds,
        updated,
        affectedSessionIds: [...affectedIds],
        progressDeltaBySessionId: new Map(deltaRows.map((row) => [row.sessionId, row.progressDelta])),
      };
    });
  }

  /**
   * Derives `progress_delta` for the rows this batch just upserted, in ONE statement.
   *
   * ABS reports absolute position only, so the delta is `end_progress` minus the `end_progress` of
   * the immediately preceding session for the same `(user, book)` - the same definition the manual
   * session path uses (`ReadingSessionRepository.findLatestEndProgressBefore`): scoped per book (not
   * per attempt), source-agnostic, units 0-100 percent, clamped to [-100, 100] so a re-read or a
   * rewind keeps its negative sign, rounded to 2dp. A session with no predecessor gets its full
   * `end_progress` (mirroring the manual path's `previous ?? 0`); a null `end_progress` on either
   * side yields null rather than a bogus number - a null predecessor is skipped over, and a null
   * current row stays null.
   *
   * Out-of-order arrival is CORRECTED, not tolerated: backfill pages arrive newest-first and offline
   * sessions can land behind the watermark, so an inserted row often becomes the predecessor of a row
   * already stored. Each batch row's earliest following session with a non-null `end_progress` is
   * therefore recomputed alongside it. That successor is the only row whose predecessor can have
   * changed, so there is no cascade beyond it.
   *
   * Idempotent: the result is a pure function of stored state, and the `is distinct from` guard means
   * a re-ingest of unchanged history updates nothing and returns nothing, so no day is recomputed.
   */
  private async recomputeProgressDeltas(tx: Tx, userId: number, sessionIds: string[]): Promise<AbsProgressDeltaRow[]> {
    if (sessionIds.length === 0) return [];

    const idList = sql.join(
      sessionIds.map((id) => sql`${id}`),
      sql`, `,
    );

    // Both lateral lookups are single-row index seeks on `rs_user_book_started_at_idx`, so the whole
    // statement is bounded at ~3x the batch size regardless of how long each book's history is.
    const result = await tx.execute<AbsProgressDeltaSqlRow>(sql`
      with batch as (
        select id, book_id, started_at, session_id
        from reading_sessions
        where user_id = ${userId} and session_id in (${idList})
      ),
      targets as (
        select id from batch
        union
        select succ.id
        from batch b
        cross join lateral (
          select rs.id
          from reading_sessions rs
          where rs.user_id = ${userId}
            and rs.book_id = b.book_id
            and rs.end_progress is not null
            and (rs.started_at, rs.session_id) > (b.started_at, b.session_id)
          order by rs.started_at asc, rs.session_id asc
          limit 1
        ) succ
      ),
      computed as (
        select
          cur.id,
          case
            when cur.end_progress is null then null
            else round(greatest(-100, least(100, cur.end_progress - coalesce(prev.end_progress, 0)))::numeric, 2)::real
          end as delta
        from targets t
        join reading_sessions cur on cur.id = t.id
        left join lateral (
          select rs.end_progress
          from reading_sessions rs
          where rs.user_id = ${userId}
            and rs.book_id = cur.book_id
            and rs.end_progress is not null
            and (rs.started_at, rs.session_id) < (cur.started_at, cur.session_id)
          order by rs.started_at desc, rs.session_id desc
          limit 1
        ) prev on true
      )
      update reading_sessions rs
      set progress_delta = c.delta
      from computed c, books bk
      where rs.id = c.id and bk.id = rs.book_id and rs.progress_delta is distinct from c.delta
      returning
        rs.session_id as "sessionId",
        bk.library_id as "libraryId",
        rs.started_at as "startedAt",
        rs.ended_at as "endedAt",
        rs.duration_seconds as "durationSeconds",
        rs.progress_delta as "progressDelta"
    `);

    return result.rows.map((row) => ({
      sessionId: row.sessionId,
      libraryId: Number(row.libraryId),
      startedAt: new Date(row.startedAt),
      endedAt: new Date(row.endedAt),
      durationSeconds: Number(row.durationSeconds),
      progressDelta: row.progressDelta == null ? null : Number(row.progressDelta),
    }));
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
