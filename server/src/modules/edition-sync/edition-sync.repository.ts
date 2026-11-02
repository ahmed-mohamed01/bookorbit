import type { EditionSyncProvenance } from '@bookorbit/types';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  AUDIO_FORMAT_LIST,
  EDITION_SYNC_BOOK_LIST_PAGE_SIZE,
  type EditionSyncBookListFilter,
  EDITION_SYNC_DEFAULT_CRON,
  EDITION_SYNC_DEFAULT_RUN_HOURS,
  Permission,
  READ_ALOUD_MAX_AUDIO_FILES,
  type EditionSyncFilesChangedMode,
  type EditionSyncBookSyncMode,
  type EditionSyncInvalidatedReason,
  type EditionSyncOverride,
  type EditionSyncRunStopReason,
  type EditionSyncRunTrigger,
} from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { escapeLikePattern } from '../../common/utils/accent-insensitive-search.utils';
import { buildContentFilterClauses } from '../../common/utils/content-filter-sql.utils';
import { applySchemaStatements, findMissingTables } from '../../common/utils/schema-bootstrap.utils';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import {
  editionSyncBookIndex,
  editionSyncBookOverrides,
  editionSyncRuns,
  editionSyncSettings,
  editionSyncUserSettings,
  type EditionSyncBookIndexRow,
  type EditionSyncRunRow,
  type EditionSyncSettingsRow,
  type EditionSyncUserSettingsRow,
  type NewEditionSyncBookIndexRow,
} from './schema/edition-sync.schema';
import type {
  EditionSyncBookFileRef,
  EditionSyncBookListRow,
  EditionSyncBookListSettings,
  EditionSyncEligibility,
  EditionSyncIndexSource,
  EditionSyncResolverInputs,
} from './edition-sync.types';

import { EDITION_SYNC_FILE_CHANGE_REASONS, EDITION_SYNC_FILES_SETTLE_MS } from './edition-sync.constants';

type Db = NodePgDatabase<typeof schema>;

const RECENT_THROUGHPUT_RUNS = 10;
/** The server switch is read on every tick, run step and resolver lookup; admin updates drop the cache. */
const SERVER_ENABLED_CACHE_MS = 5_000;
const AUDIO_FORMATS_SQL = sql.join(
  AUDIO_FORMAT_LIST.map((format) => sql`${format}`),
  sql`, `,
);

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}

/**
 * Users whose edition sync is effectively on: active, permitted (or superuser), enabled. The server
 * switch is deliberately not part of it: it pauses indexing but does not make indexes unused.
 */
const WANTING_USERS_CTE = sql`wanting AS (
  SELECT u.id, u.is_superuser, COALESCE(s.book_sync_mode, 'all_eligible') AS book_sync_mode
  FROM users u
  LEFT JOIN edition_sync_user_settings s ON s.user_id = u.id
  WHERE COALESCE(s.enabled, true)
    AND u.active
    AND (u.is_superuser OR EXISTS (
      SELECT 1 FROM user_permissions p WHERE p.user_id = u.id AND p.permission_name = ${Permission.EditionSync}
    ))
)`;

/** Some wanting user with access to the book's library has it in effective scope. `b` is the book alias. */
const WANTED_SQL = sql`EXISTS (
  SELECT 1 FROM wanting w
  LEFT JOIN edition_sync_book_overrides o ON o.user_id = w.id AND o.book_id = b.id
  WHERE (w.is_superuser OR EXISTS (SELECT 1 FROM user_library_access a WHERE a.user_id = w.id AND a.library_id = b.library_id))
    AND (o.sync_override = 'included' OR (o.sync_override IS NULL AND w.book_sync_mode = 'all_eligible'))
)`;

const BOOK_PLACEMENT_SQL = sql`b.status = 'present'
  AND l.organization_mode <> 'book_per_file'
  AND (jsonb_array_length(l.allowed_formats) = 0
    OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(l.allowed_formats) af WHERE lower(trim(af)) = 'epub'))`;

/**
 * One book record with a plain EPUB and an audiobook that upstream's read-aloud could process, and no
 * read-along EPUB edition yet. `b` is the book alias, `l` its library. Per-book form, for single
 * books and the small pinned set.
 */
const ELIGIBLE_SQL = sql`${BOOK_PLACEMENT_SQL}
  AND EXISTS (SELECT 1 FROM book_files f WHERE f.book_id = b.id AND f.role = 'content' AND f.format = 'epub' AND NOT f.media_overlay_available)
  AND NOT EXISTS (SELECT 1 FROM book_files f WHERE f.book_id = b.id AND f.role = 'content' AND f.format = 'epub' AND f.media_overlay_available)
  AND EXISTS (SELECT 1 FROM book_files f WHERE f.book_id = b.id AND f.role = 'content' AND f.format IN (${AUDIO_FORMATS_SQL}))
  AND NOT EXISTS (
    SELECT 1 FROM book_files f WHERE f.book_id = b.id AND f.role = 'content' AND f.format IN (${AUDIO_FORMATS_SQL})
    OFFSET ${READ_ALOUD_MAX_AUDIO_FILES} LIMIT 1
  )`;

/**
 * Set form of the file half of ELIGIBLE_SQL for whole-queue queries: one grouped pass over content
 * files. The per-book NOT EXISTS otherwise plans as a nested anti join that grows with the library.
 */
const ELIGIBLE_FILES_CTE = sql`eligible_files AS (
  SELECT f.book_id
  FROM book_files f
  WHERE f.role = 'content' AND (f.format = 'epub' OR f.format IN (${AUDIO_FORMATS_SQL}))
  GROUP BY f.book_id
  HAVING bool_or(f.format = 'epub' AND NOT f.media_overlay_available)
    AND NOT bool_or(f.format = 'epub' AND f.media_overlay_available)
    AND count(*) FILTER (WHERE f.format IN (${AUDIO_FORMATS_SQL})) BETWEEN 1 AND ${READ_ALOUD_MAX_AUDIO_FILES}
)`;

/** No row, a stale row, or a failed row someone asked to retry. `i` is the (left-joined) index row. */
const QUEUEABLE_ROW_SQL = sql`(i.book_id IS NULL OR i.status = 'stale' OR (i.status = 'failed' AND i.retry_requested))`;

/** Pinned first (oldest pin first), then books a wanting user is reading, then newest added. */
const QUEUE_ORDER_SQL = sql`(i.pinned_at IS NOT NULL) DESC,
  i.pinned_at ASC NULLS LAST,
  EXISTS (
    SELECT 1 FROM user_book_status r JOIN wanting rw ON rw.id = r.user_id
    WHERE r.book_id = b.id AND r.status IN ('reading', 'rereading')
  ) DESC,
  b.added_at DESC,
  b.id DESC`;

/** CTEs and FROM clause of a whole-queue query; `b`, `l` and `i` are in scope for the WHERE. */
function queueQuery(select: SQL, extraWhere?: SQL): SQL {
  return sql`WITH ${WANTING_USERS_CTE}, ${ELIGIBLE_FILES_CTE}
    SELECT ${select}
    FROM eligible_files ef
    JOIN books b ON b.id = ef.book_id
    JOIN libraries l ON l.id = b.library_id
    LEFT JOIN edition_sync_book_index i ON i.book_id = b.id
    WHERE ${QUEUEABLE_ROW_SQL} AND ${BOOK_PLACEMENT_SQL} AND ${WANTED_SQL}${extraWhere ? sql` AND ${extraWhere}` : sql``}`;
}

const FILE_CHANGE_REASONS_SQL = sql.join(
  EDITION_SYNC_FILE_CHANGE_REASONS.map((reason) => sql`${reason}`),
  sql`, `,
);
const SETTLED_PIN_SQL = sql`(i.pinned_at IS NULL OR i.retry_requested OR i.invalidated_reason IS NULL OR i.invalidated_reason NOT IN (${FILE_CHANGE_REASONS_SQL}) OR i.files_changed_at IS NULL OR i.files_changed_at <= now() - (${EDITION_SYNC_FILES_SETTLE_MS} * interval '1 millisecond'))`;

/** Index statuses behind each books-list filter; `all` has none. Drives both the page filter and the counts. */
const LIST_FILTER_STATUSES: Record<Exclude<EditionSyncBookListFilter, 'all'>, readonly string[]> = {
  problems: ['failed'],
  queued: ['queued', 'stale', 'running'],
  synced: ['ready'],
  off: ['off'],
};

function statusIn(statuses: readonly string[]): SQL {
  return sql`status IN (${sql.join(
    statuses.map((status) => sql`${status}`),
    sql`, `,
  )})`;
}

function listFilterPredicate(filter: EditionSyncBookListFilter): SQL {
  return filter === 'all' ? sql`true` : statusIn(LIST_FILTER_STATUSES[filter]);
}

const LIST_FILTER_COUNTS_SQL = sql.join(
  [
    sql`count(*)::int AS "all"`,
    ...Object.entries(LIST_FILTER_STATUSES).map(
      ([filter, statuses]) => sql`count(*) FILTER (WHERE ${statusIn(statuses)})::int AS ${sql.identifier(filter)}`,
    ),
  ],
  sql`, `,
);

const FILE_REF_COLUMNS = {
  id: schema.bookFiles.id,
  bookId: schema.bookFiles.bookId,
  absolutePath: schema.bookFiles.absolutePath,
  format: schema.bookFiles.format,
  role: schema.bookFiles.role,
  sizeBytes: schema.bookFiles.sizeBytes,
  fileHash: schema.bookFiles.fileHash,
  mtime: schema.bookFiles.mtime,
  durationSeconds: schema.bookFiles.durationSeconds,
  mediaOverlayAvailable: schema.bookFiles.mediaOverlayAvailable,
};

/**
 * All SQL for the edition-sync fork tables, plus the read-only queries over upstream tables the
 * queue needs (eligibility, wanted, reading-first order) and a read-only peek at `read_aloud_jobs`.
 */
@Injectable()
export class EditionSyncRepository {
  private serverEnabledCache: { value: boolean; expiresAt: number } | null = null;

  constructor(@Inject(DB) private readonly db: Db) {}

  async listBooks(user: RequestUser, settings: EditionSyncBookListSettings, filter: EditionSyncBookListFilter, q: string | undefined, page: number) {
    const contentFilterClauses = !user.isSuperuser && user.contentFilters ? buildContentFilterClauses(user.contentFilters, this.db) : [];
    // The content filter clauses reference the unaliased "books" table, so they run in their own scope.
    const contentFilterSql =
      contentFilterClauses.length > 0 ? sql`AND EXISTS (SELECT 1 FROM books WHERE books.id = b.id AND ${and(...contentFilterClauses)})` : sql``;
    const title = sql`COALESCE(m.title, b.folder_path)`;
    const base = sql`WITH ${ELIGIBLE_FILES_CTE}, scoped AS (
      SELECT b.id, ${title} AS title, o.sync_override,
        (${settings.effectiveEnabled} AND (o.sync_override = 'included' OR (o.sync_override IS NULL AND ${settings.bookSyncMode} = 'all_eligible'))) IS TRUE AS enabled,
        i.status AS stored_status, i.retry_requested, i.indexed_at
      FROM eligible_files ef JOIN books b ON b.id = ef.book_id
      JOIN libraries l ON l.id = b.library_id
      LEFT JOIN book_metadata m ON m.book_id = b.id
      LEFT JOIN edition_sync_book_overrides o ON o.book_id = b.id AND o.user_id = ${user.id}
      LEFT JOIN edition_sync_book_index i ON i.book_id = b.id
      WHERE ${BOOK_PLACEMENT_SQL}
        AND (${user.isSuperuser} OR EXISTS (SELECT 1 FROM user_library_access a WHERE a.user_id = ${user.id} AND a.library_id = b.library_id))
        ${q ? sql`AND ${title} ILIKE ${`%${escapeLikePattern(q)}%`} ESCAPE '\\'` : sql``}
        ${contentFilterSql}
    ), states AS (
      SELECT *, CASE WHEN NOT enabled THEN 'off'
        WHEN stored_status IS NULL THEN 'queued'
        WHEN stored_status = 'failed' AND retry_requested THEN 'queued'
        WHEN stored_status = 'stale' AND indexed_at IS NULL THEN 'queued'
        ELSE stored_status END AS status FROM scoped
    )`;
    const [items, counts] = await Promise.all([
      this.db.execute<EditionSyncBookListRow>(sql`${base}, page AS (
        SELECT s.* FROM states s WHERE ${listFilterPredicate(filter)} ORDER BY lower(s.title), s.id
        LIMIT ${EDITION_SYNC_BOOK_LIST_PAGE_SIZE} OFFSET ${(page - 1) * EDITION_SYNC_BOOK_LIST_PAGE_SIZE}
      ) SELECT s.id AS "bookId", s.title, s.enabled AS "syncEnabled", s.sync_override AS "syncOverride", s.status,
        CASE WHEN s.status = 'running' THEN i.stage END AS stage,
        CASE WHEN s.status = 'running' THEN COALESCE(i.progress, 0) END AS progress,
        i.indexed_at AS "indexedAt", i.last_error AS error,
        (s.status = 'failed' AND COALESCE(r.mode, 'auto') <> 'disabled' AND EXISTS (
          SELECT 1 FROM audiobook_alignment a WHERE a.text_book_id = s.id AND a.audio_book_id = s.id AND a.status = 'ready'
        )) AS "whisperFallback",
        ARRAY(SELECT f.format FROM book_files f WHERE f.book_id = s.id AND f.role = 'content'
          GROUP BY f.format ORDER BY bool_or(f.id = b.primary_file_id) DESC,
          min(CASE WHEN f.format IN (${AUDIO_FORMATS_SQL}) THEN 0 WHEN f.format = 'epub' THEN 1 ELSE 2 END), f.format) AS formats
      FROM page s JOIN books b ON b.id = s.id
      LEFT JOIN edition_sync_book_index i ON i.book_id = s.id
      LEFT JOIN user_book_read_aloud_sync_settings r ON r.book_id = s.id AND r.user_id = ${user.id}
      ORDER BY lower(s.title), s.id`),
      this.db.execute<Record<EditionSyncBookListFilter, number>>(sql`${base} SELECT ${LIST_FILTER_COUNTS_SQL} FROM states`),
    ]);
    return {
      items: rowsOf<EditionSyncBookListRow>(items),
      counts: rowsOf<Record<EditionSyncBookListFilter, number>>(counts)[0],
    };
  }

  // Schema bootstrap

  async findMissingTables(tableNames: readonly string[]): Promise<string[]> {
    return findMissingTables(this.db, tableNames);
  }

  async applySchemaStatements(statements: readonly string[]): Promise<void> {
    return applySchemaStatements(this.db, statements);
  }

  // Permission (read-only over upstream tables, for callers that only know a user id)

  async userHasEditionSyncPermission(userId: number): Promise<boolean> {
    const [row] = await this.db
      .select({ isSuperuser: schema.users.isSuperuser, permissionName: schema.userPermissions.permissionName })
      .from(schema.users)
      .leftJoin(
        schema.userPermissions,
        and(eq(schema.userPermissions.userId, schema.users.id), eq(schema.userPermissions.permissionName, Permission.EditionSync)),
      )
      .where(and(eq(schema.users.id, userId), eq(schema.users.active, true)))
      .limit(1);
    return row?.isSuperuser === true || row?.permissionName === Permission.EditionSync;
  }

  // Per-user settings and overrides

  async findUserSettings(userId: number): Promise<EditionSyncUserSettingsRow | null> {
    const [row] = await this.db.select().from(editionSyncUserSettings).where(eq(editionSyncUserSettings.userId, userId)).limit(1);
    return row ?? null;
  }

  async upsertUserSettings(
    userId: number,
    patch: { enabled?: boolean; bookSyncMode?: EditionSyncBookSyncMode },
  ): Promise<EditionSyncUserSettingsRow> {
    const set: Partial<typeof editionSyncUserSettings.$inferInsert> = { updatedAt: new Date() };
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.bookSyncMode !== undefined) set.bookSyncMode = patch.bookSyncMode;
    const [row] = await this.db
      .insert(editionSyncUserSettings)
      .values({ userId, ...set })
      .onConflictDoUpdate({ target: editionSyncUserSettings.userId, set })
      .returning();
    return row;
  }

  async findOverride(userId: number, bookId: number): Promise<EditionSyncOverride> {
    const [row] = await this.db
      .select({ syncOverride: editionSyncBookOverrides.syncOverride })
      .from(editionSyncBookOverrides)
      .where(and(eq(editionSyncBookOverrides.userId, userId), eq(editionSyncBookOverrides.bookId, bookId)))
      .limit(1);
    return row?.syncOverride ?? null;
  }

  /** null removes the override. */
  async setOverride(userId: number, bookId: number, override: EditionSyncOverride): Promise<void> {
    if (override === null) {
      await this.db
        .delete(editionSyncBookOverrides)
        .where(and(eq(editionSyncBookOverrides.userId, userId), eq(editionSyncBookOverrides.bookId, bookId)));
      return;
    }
    await this.db
      .insert(editionSyncBookOverrides)
      .values({ userId, bookId, syncOverride: override })
      .onConflictDoUpdate({
        target: [editionSyncBookOverrides.userId, editionSyncBookOverrides.bookId],
        set: { syncOverride: override, updatedAt: new Date() },
      });
  }

  /** Settings, override and index row for one user and book, for the overlay resolver. */
  async findResolverInputs(userId: number, bookId: number): Promise<EditionSyncResolverInputs> {
    const [settings, override, index] = await Promise.all([
      this.findUserSettings(userId),
      this.findOverride(userId, bookId),
      this.db
        .select({
          status: editionSyncBookIndex.status,
          indexFileId: editionSyncBookIndex.indexFileId,
          indexPath: editionSyncBookIndex.indexPath,
          provenance: editionSyncBookIndex.provenance,
          invalidatedAt: editionSyncBookIndex.invalidatedAt,
        })
        .from(editionSyncBookIndex)
        .where(eq(editionSyncBookIndex.bookId, bookId))
        .limit(1),
    ]);
    return { settings, override, index: index[0] ?? null };
  }

  // Admin settings (singleton row id = 1, seeded by the bootstrap)

  async findAdminSettings(): Promise<EditionSyncSettingsRow> {
    const [row] = await this.db.select().from(editionSyncSettings).where(eq(editionSyncSettings.id, 1)).limit(1);
    return (
      row ?? {
        id: 1,
        enabled: false,
        cronExpression: EDITION_SYNC_DEFAULT_CRON,
        onFilesChanged: 'next_run',
        runHours: EDITION_SYNC_DEFAULT_RUN_HOURS,
        updatedAt: new Date(0),
        updatedByUserId: null,
      }
    );
  }

  /** The one gate for the server switch, cached briefly. */
  async isServerEnabled(): Promise<boolean> {
    const now = Date.now();
    if (this.serverEnabledCache && this.serverEnabledCache.expiresAt > now) return this.serverEnabledCache.value;
    const { enabled } = await this.findAdminSettings();
    this.serverEnabledCache = { value: enabled, expiresAt: now + SERVER_ENABLED_CACHE_MS };
    return enabled;
  }

  async updateAdminSettings(
    patch: { enabled?: boolean; cronExpression?: string | null; runHours?: number; onFilesChanged?: EditionSyncFilesChangedMode },
    userId: number,
  ): Promise<EditionSyncSettingsRow> {
    const set: Partial<typeof editionSyncSettings.$inferInsert> = { updatedAt: new Date(), updatedByUserId: userId };
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.cronExpression !== undefined) set.cronExpression = patch.cronExpression;
    if (patch.onFilesChanged != null) set.onFilesChanged = patch.onFilesChanged;
    if (patch.runHours !== undefined) set.runHours = patch.runHours;
    const [row] = await this.db
      .insert(editionSyncSettings)
      .values({ id: 1, cronExpression: EDITION_SYNC_DEFAULT_CRON, runHours: EDITION_SYNC_DEFAULT_RUN_HOURS, ...set })
      .onConflictDoUpdate({ target: editionSyncSettings.id, set })
      .returning();
    this.serverEnabledCache = null;
    return row;
  }

  // Book facts (read-only over upstream tables)

  async findEligibility(bookId: number): Promise<EditionSyncEligibility | null> {
    const result = await this.db.execute<{
      bookId: number;
      libraryId: number;
      eligible: boolean;
      hasPlainEpub: boolean;
      hasAudio: boolean;
      hasReadAlong: boolean;
    }>(sql`
      SELECT b.id AS "bookId", b.library_id AS "libraryId",
        (${ELIGIBLE_SQL}) AS "eligible",
        EXISTS (SELECT 1 FROM book_files f WHERE f.book_id = b.id AND f.role = 'content' AND f.format = 'epub' AND NOT f.media_overlay_available) AS "hasPlainEpub",
        EXISTS (SELECT 1 FROM book_files f WHERE f.book_id = b.id AND f.role = 'content' AND f.format IN (${AUDIO_FORMATS_SQL})) AS "hasAudio",
        EXISTS (SELECT 1 FROM book_files f WHERE f.book_id = b.id AND f.role = 'content' AND f.format = 'epub' AND f.media_overlay_available) AS "hasReadAlong"
      FROM books b
      JOIN libraries l ON l.id = b.library_id
      WHERE b.id = ${bookId}
    `);
    const row = rowsOf<{ bookId: number; libraryId: number; eligible: boolean; hasPlainEpub: boolean; hasAudio: boolean; hasReadAlong: boolean }>(
      result,
    )[0];
    if (!row) return null;
    return {
      bookId: row.bookId,
      libraryId: row.libraryId,
      eligible: row.eligible,
      hasReadAlong: row.hasReadAlong,
      hasAudio: row.hasAudio,
      editionCount: Number(row.hasPlainEpub) + Number(row.hasAudio) + Number(row.hasReadAlong),
    };
  }

  async findIndexSource(bookId: number): Promise<EditionSyncIndexSource | null> {
    const [book] = await this.db
      .select({
        bookId: schema.books.id,
        libraryId: schema.books.libraryId,
        primaryFileId: schema.books.primaryFileId,
        title: schema.bookMetadata.title,
        language: schema.bookMetadata.language,
        folderPath: schema.books.folderPath,
      })
      .from(schema.books)
      .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.books.id))
      .where(eq(schema.books.id, bookId))
      .limit(1);
    if (!book) return null;

    const files = await this.db
      .select(FILE_REF_COLUMNS)
      .from(schema.bookFiles)
      .where(
        and(
          eq(schema.bookFiles.bookId, bookId),
          eq(schema.bookFiles.role, 'content'),
          inArray(schema.bookFiles.format, ['epub', ...AUDIO_FORMAT_LIST]),
        ),
      )
      .orderBy(asc(schema.bookFiles.sortOrder), asc(schema.bookFiles.id));

    const plainEpubs = files.filter((file) => file.format === 'epub' && !file.mediaOverlayAvailable);
    const epub = plainEpubs.find((file) => file.id === book.primaryFileId) ?? plainEpubs[0];
    const audio = files.filter((file) => file.format !== 'epub');
    if (!epub || audio.length === 0) return null;
    return { bookId, title: book.title ?? book.folderPath, language: book.language, libraryId: book.libraryId, epub, audio };
  }

  async findBookTitle(bookId: number): Promise<string | null> {
    const [row] = await this.db
      .select({ title: schema.bookMetadata.title, folderPath: schema.books.folderPath })
      .from(schema.books)
      .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.books.id))
      .where(eq(schema.books.id, bookId))
      .limit(1);
    return row ? (row.title ?? row.folderPath) : null;
  }

  async findBookFilesByIds(bookFileIds: readonly number[]): Promise<EditionSyncBookFileRef[]> {
    if (bookFileIds.length === 0) return [];
    return this.db
      .select(FILE_REF_COLUMNS)
      .from(schema.bookFiles)
      .where(inArray(schema.bookFiles.id, [...bookFileIds]));
  }

  async findBookFileIdByPath(bookId: number, absolutePath: string): Promise<number | null> {
    const [row] = await this.db
      .select({ id: schema.bookFiles.id })
      .from(schema.bookFiles)
      .where(and(eq(schema.bookFiles.bookId, bookId), eq(schema.bookFiles.absolutePath, absolutePath)))
      .limit(1);
    return row?.id ?? null;
  }

  // Index rows

  async findIndexRow(bookId: number): Promise<EditionSyncBookIndexRow | null> {
    const [row] = await this.db.select().from(editionSyncBookIndex).where(eq(editionSyncBookIndex.bookId, bookId)).limit(1);
    return row ?? null;
  }

  async findIndexRowByWorkerJobId(workerJobId: string): Promise<EditionSyncBookIndexRow | null> {
    const [row] = await this.db.select().from(editionSyncBookIndex).where(eq(editionSyncBookIndex.workerJobId, workerJobId)).limit(1);
    return row ?? null;
  }

  async upsertIndexRow(bookId: number, values: Omit<NewEditionSyncBookIndexRow, 'bookId'>, changedSince?: Date): Promise<EditionSyncBookIndexRow> {
    const set = { ...values, updatedAt: new Date() };
    const conflictSet = changedSince
      ? {
          ...set,
          invalidatedAt: sql`CASE WHEN ${editionSyncBookIndex.filesChangedAt} > ${changedSince} THEN now() ELSE NULL END`,
          invalidatedReason: null,
        }
      : set;
    const [row] = await this.db
      .insert(editionSyncBookIndex)
      .values({ bookId, ...set })
      .onConflictDoUpdate({ target: editionSyncBookIndex.bookId, set: conflictSet })
      .returning();
    return row;
  }

  async updateIndexRow(
    bookId: number,
    patch: Partial<Omit<NewEditionSyncBookIndexRow, 'bookId'>>,
    changedSince?: Date,
  ): Promise<EditionSyncBookIndexRow | null> {
    const [row] = await this.db
      .update(editionSyncBookIndex)
      .set({
        ...patch,
        updatedAt: new Date(),
        ...(changedSince
          ? {
              invalidatedAt: sql`CASE WHEN ${editionSyncBookIndex.filesChangedAt} > ${changedSince} THEN now() ELSE NULL END`,
              invalidatedReason: null,
            }
          : {}),
      })
      .where(eq(editionSyncBookIndex.bookId, bookId))
      .returning();
    return row ?? null;
  }

  async deleteUnusedIndexRow(bookId: number, expected: { status: EditionSyncBookIndexRow['status']; indexPath: string | null }): Promise<boolean> {
    const rows = await this.db
      .delete(editionSyncBookIndex)
      .where(
        and(
          eq(editionSyncBookIndex.bookId, bookId),
          eq(editionSyncBookIndex.status, expected.status),
          inArray(editionSyncBookIndex.status, ['ready', 'failed', 'stale']),
          isNull(editionSyncBookIndex.pinnedAt),
          sql`EXISTS (WITH ${WANTING_USERS_CTE} SELECT 1 FROM books b WHERE b.id = ${bookId} AND NOT ${WANTED_SQL})`,
          sql`${editionSyncBookIndex.indexPath} IS NOT DISTINCT FROM ${expected.indexPath}`,
        ),
      )
      .returning({ bookId: editionSyncBookIndex.bookId });
    return rows.length > 0;
  }

  async markStale(bookId: number, reason: EditionSyncInvalidatedReason, expectedProvenance?: EditionSyncProvenance): Promise<boolean> {
    const rows = await this.db
      .update(editionSyncBookIndex)
      .set({ status: 'stale', invalidatedAt: new Date(), invalidatedReason: reason, stage: null, progress: null, updatedAt: new Date() })
      .where(
        and(
          eq(editionSyncBookIndex.bookId, bookId),
          sql`${editionSyncBookIndex.status} <> 'running'`,
          expectedProvenance === undefined ? undefined : sql`${editionSyncBookIndex.provenance} = ${JSON.stringify(expectedProvenance)}::jsonb`,
        ),
      )
      .returning({ bookId: editionSyncBookIndex.bookId });
    return rows.length > 0;
  }

  async markRunningStale(bookId: number, reason: EditionSyncInvalidatedReason): Promise<void> {
    await this.db
      .update(editionSyncBookIndex)
      .set({ status: 'stale', invalidatedAt: new Date(), invalidatedReason: reason, stage: null, progress: null, updatedAt: new Date() })
      .where(and(eq(editionSyncBookIndex.bookId, bookId), eq(editionSyncBookIndex.status, 'running')));
  }

  /**
   * Marks the book `running` under `workerJobId` unless another claim already did. A book with no
   * row gets one. Returns null when the row is no longer queueable.
   */
  async claimIndexRow(
    bookId: number,
    workerJobId: string,
    at: Date,
    expectedFilesChangedAt: Date | null = null,
  ): Promise<EditionSyncBookIndexRow | null> {
    const set = {
      status: 'running' as const,
      workerJobId,
      stage: null,
      progress: 0,
      lastAttemptAt: at,
      retryRequested: false,
      invalidatedAt: null,
      invalidatedReason: null,
      errorCode: null,
      lastError: null,
      failedAt: null,
      updatedAt: at,
    };
    const [row] = await this.db
      .insert(editionSyncBookIndex)
      .values({ bookId, ...set })
      .onConflictDoUpdate({
        target: editionSyncBookIndex.bookId,
        set,
        setWhere: sql`(${editionSyncBookIndex.status} = 'stale' OR (${editionSyncBookIndex.status} = 'failed' AND ${editionSyncBookIndex.retryRequested})) AND date_trunc('milliseconds', ${editionSyncBookIndex.filesChangedAt}) IS NOT DISTINCT FROM ${expectedFilesChangedAt}::timestamptz`,
      })
      .returning();
    return row ?? null;
  }

  /**
   * Runs the book first and outside the window (toggle on with no index, run now, retry). A book with
   * no row gets a `stale` one that never held an index, which reads as queued. Never touches a
   * running or ready row.
   */
  async pinBook(bookId: number, at: Date, retry: boolean): Promise<void> {
    await this.db
      .insert(editionSyncBookIndex)
      .values({ bookId, status: 'stale', pinnedAt: at, retryRequested: retry })
      .onConflictDoUpdate({
        target: editionSyncBookIndex.bookId,
        set: {
          pinnedAt: retry ? at : sql`COALESCE(${editionSyncBookIndex.pinnedAt}, ${at})`,
          attemptCount: sql`CASE WHEN ${retry} THEN 0 ELSE ${editionSyncBookIndex.attemptCount} END`,
          retryRequested: sql`${editionSyncBookIndex.retryRequested} OR ${retry}`,
          updatedAt: at,
        },
        setWhere: sql`${editionSyncBookIndex.status} IN ('stale', 'failed')`,
      });
  }

  /** Rows a server restart left `running`; they resume from their kept work folder on the next claim. */
  async markInterruptedRows(): Promise<number> {
    const rows = await this.db
      .update(editionSyncBookIndex)
      .set({ status: 'stale', invalidatedAt: new Date(), invalidatedReason: 'interrupted', stage: null, progress: null, updatedAt: new Date() })
      .where(eq(editionSyncBookIndex.status, 'running'))
      .returning({ bookId: editionSyncBookIndex.bookId });
    return rows.length;
  }

  async pinFilesChangedBooks(settledBefore: Date, limit: number): Promise<number> {
    const result = await this.db.execute(sql`
      WITH ${WANTING_USERS_CTE}, candidates AS (
        SELECT i.book_id FROM edition_sync_book_index i JOIN books b ON b.id = i.book_id
        JOIN libraries l ON l.id = b.library_id
        WHERE i.status = 'stale'
          AND i.invalidated_reason IN (${FILE_CHANGE_REASONS_SQL})
          AND i.pinned_at IS NULL
          AND (i.files_changed_at IS NULL OR i.files_changed_at <= ${settledBefore})
          AND ${WANTED_SQL} AND ${ELIGIBLE_SQL}
        ORDER BY i.book_id LIMIT ${limit}
        FOR UPDATE OF i SKIP LOCKED
      )
      UPDATE edition_sync_book_index i SET pinned_at = now(), updated_at = now()
      FROM candidates c WHERE i.book_id = c.book_id
      RETURNING i.book_id
    `);
    return rowsOf(result).length;
  }

  async findBooksNeedingRecheck(limit: number): Promise<number[]> {
    const rows = await this.db
      .select({ bookId: editionSyncBookIndex.bookId })
      .from(editionSyncBookIndex)
      .where(
        and(
          eq(editionSyncBookIndex.status, 'ready'),
          sql`${editionSyncBookIndex.invalidatedAt} IS NOT NULL`,
          isNull(editionSyncBookIndex.invalidatedReason),
        ),
      )
      .orderBy(asc(editionSyncBookIndex.invalidatedAt))
      .limit(limit);
    return rows.map((row) => row.bookId);
  }

  async refreshProvenance(bookId: number, previous: EditionSyncProvenance, provenance: EditionSyncProvenance, started: Date): Promise<boolean> {
    const rows = await this.db
      .update(editionSyncBookIndex)
      .set({ provenance, invalidatedAt: null, invalidatedReason: null, updatedAt: new Date() })
      .where(
        and(
          eq(editionSyncBookIndex.bookId, bookId),
          eq(editionSyncBookIndex.status, 'ready'),
          sql`${editionSyncBookIndex.provenance} = ${JSON.stringify(previous)}::jsonb`,
          sql`(${editionSyncBookIndex.filesChangedAt} IS NULL OR ${editionSyncBookIndex.filesChangedAt} <= ${started})`,
        ),
      )
      .returning({ bookId: editionSyncBookIndex.bookId });
    return rows.length > 0;
  }

  async flagRecheck(bookId: number, retry = false): Promise<void> {
    await this.db
      .update(editionSyncBookIndex)
      .set({ invalidatedAt: retry ? sql`now()` : sql`coalesce(${editionSyncBookIndex.invalidatedAt}, now())` })
      .where(and(eq(editionSyncBookIndex.bookId, bookId), eq(editionSyncBookIndex.status, 'ready')));
  }

  async clearRecheck(bookId: number): Promise<void> {
    await this.db
      .update(editionSyncBookIndex)
      .set({ invalidatedAt: null, updatedAt: new Date() })
      .where(and(eq(editionSyncBookIndex.bookId, bookId), eq(editionSyncBookIndex.status, 'ready'), isNull(editionSyncBookIndex.invalidatedReason)));
  }

  /** Worker job ids whose folders must survive upstream's orphan sweep. */
  async findWorkerJobIdsKeepingWork(failedSince: Date): Promise<string[]> {
    const rows = await this.db
      .select({ workerJobId: editionSyncBookIndex.workerJobId })
      .from(editionSyncBookIndex)
      .where(
        sql`${editionSyncBookIndex.workerJobId} IS NOT NULL AND (
          ${editionSyncBookIndex.status} = 'running'
          OR (${editionSyncBookIndex.status} = 'stale' AND ${editionSyncBookIndex.invalidatedReason} IN ('yielded', 'interrupted') AND ${editionSyncBookIndex.lastAttemptAt} >= ${failedSince})
          OR (${editionSyncBookIndex.status} = 'failed' AND ${editionSyncBookIndex.lastAttemptAt} >= ${failedSince})
        )`,
      );
    return rows.flatMap((row) => (row.workerJobId ? [row.workerJobId] : []));
  }

  /** Failed rows whose retry window ended; their folders are removed by the fork sweep. */
  async findExpiredWorkerJobIds(failedBefore: Date, limit: number): Promise<string[]> {
    const rows = await this.db
      .select({ workerJobId: editionSyncBookIndex.workerJobId })
      .from(editionSyncBookIndex)
      .where(
        sql`(${editionSyncBookIndex.status} = 'failed' OR (${editionSyncBookIndex.status} = 'stale' AND ${editionSyncBookIndex.invalidatedReason} IN ('yielded', 'interrupted'))) AND ${editionSyncBookIndex.workerJobId} IS NOT NULL AND ${editionSyncBookIndex.lastAttemptAt} < ${failedBefore}`,
      )
      .orderBy(asc(editionSyncBookIndex.lastAttemptAt))
      .limit(limit);
    return rows.flatMap((row) => (row.workerJobId ? [row.workerJobId] : []));
  }

  /** Forgets work folders the sweep removed, so a later retry starts a fresh worker job. */
  async clearWorkerJobIds(workerJobIds: readonly string[]): Promise<void> {
    if (workerJobIds.length === 0) return;
    await this.db
      .update(editionSyncBookIndex)
      .set({ workerJobId: null, updatedAt: new Date() })
      .where(and(inArray(editionSyncBookIndex.workerJobId, [...workerJobIds]), inArray(editionSyncBookIndex.status, ['failed', 'stale'])));
  }

  // Queue (eligible + wanted; pinned first, then reading, then newest added)

  /** Some permitted, enabled user with library access has the book in scope. Eligibility is not part of it. */
  async isWanted(bookId: number): Promise<boolean> {
    const result = await this.db.execute<{ wanted: boolean }>(sql`
      WITH ${WANTING_USERS_CTE}
      SELECT ${WANTED_SQL} AS "wanted" FROM books b WHERE b.id = ${bookId}
    `);
    return rowsOf<{ wanted: boolean }>(result)[0]?.wanted === true;
  }

  async findNextQueuedBook(options: {
    pinnedOnly: boolean;
    excludeBookIds?: readonly number[];
  }): Promise<{ bookId: number; pinned: boolean } | null> {
    const exclude =
      options.excludeBookIds && options.excludeBookIds.length > 0
        ? sql`b.id <> ALL(${sql.param([...options.excludeBookIds])}::integer[])`
        : undefined;
    // Pinned books are a handful of rows, so that path is driven from the pinned index rows instead.
    const query = options.pinnedOnly
      ? sql`WITH ${WANTING_USERS_CTE}
          SELECT b.id AS "bookId", true AS "pinned"
          FROM edition_sync_book_index i
          JOIN books b ON b.id = i.book_id
          JOIN libraries l ON l.id = b.library_id
          WHERE i.pinned_at IS NOT NULL AND ${SETTLED_PIN_SQL} AND ${QUEUEABLE_ROW_SQL} AND ${ELIGIBLE_SQL} AND ${WANTED_SQL}${exclude ? sql` AND ${exclude}` : sql``}
          ORDER BY i.pinned_at ASC, b.id DESC
          LIMIT 1`
      : sql`${queueQuery(sql`b.id AS "bookId", (i.pinned_at IS NOT NULL) AS "pinned"`, sql`${SETTLED_PIN_SQL}${exclude ? sql` AND ${exclude}` : sql``}`)}
          ORDER BY ${QUEUE_ORDER_SQL}
          LIMIT 1`;
    const result = await this.db.execute<{ bookId: number; pinned: boolean }>(query);
    return rowsOf<{ bookId: number; pinned: boolean }>(result)[0] ?? null;
  }

  /** 1-based position of a queued book, or null when it is not queued. */
  async findQueuePosition(bookId: number): Promise<number | null> {
    const result = await this.db.execute<{ position: number }>(sql`
      SELECT position FROM (${queueQuery(sql`b.id, row_number() OVER (ORDER BY ${QUEUE_ORDER_SQL})::int AS position`)}) queue
      WHERE id = ${bookId}
    `);
    return rowsOf<{ position: number }>(result)[0]?.position ?? null;
  }

  async countIndexStates(): Promise<{ indexed: number; queued: number; failed: number; stale: number }> {
    const [states, queued] = await Promise.all([
      this.db.execute<{ indexed: number; failed: number; stale: number }>(sql`
        SELECT
          count(*) FILTER (WHERE status = 'ready')::int AS "indexed",
          count(*) FILTER (WHERE status = 'failed' AND NOT retry_requested)::int AS "failed",
          count(*) FILTER (WHERE status = 'stale' AND indexed_at IS NOT NULL)::int AS "stale"
        FROM edition_sync_book_index
      `),
      this.db.execute<{ queued: number }>(queueQuery(sql`count(*)::int AS "queued"`)),
    ]);
    const counts = rowsOf<{ indexed: number; failed: number; stale: number }>(states)[0];
    return {
      indexed: counts?.indexed ?? 0,
      failed: counts?.failed ?? 0,
      stale: counts?.stale ?? 0,
      queued: rowsOf<{ queued: number }>(queued)[0]?.queued ?? 0,
    };
  }

  async countUnused(): Promise<{ count: number; bytes: number }> {
    const result = await this.db.execute<{ count: number; bytes: string | number | null }>(sql`
      WITH ${WANTING_USERS_CTE}
      SELECT count(*)::int AS "count", coalesce(sum(i.index_bytes), 0)::bigint AS "bytes"
      FROM edition_sync_book_index i
      JOIN books b ON b.id = i.book_id
      WHERE i.status IN ('ready', 'failed', 'stale') AND NOT ${WANTED_SQL}
    `);
    const row = rowsOf<{ count: number; bytes: string | number | null }>(result)[0];
    return { count: row?.count ?? 0, bytes: Number(row?.bytes ?? 0) };
  }

  /** Unused rows after `afterBookId`, in book id order, so a batch loop always advances. */
  async findUnused(
    limit: number,
    afterBookId = 0,
  ): Promise<Array<Pick<EditionSyncBookIndexRow, 'bookId' | 'status' | 'indexPath' | 'indexBytes' | 'workerJobId'>>> {
    const result = await this.db.execute<Pick<EditionSyncBookIndexRow, 'bookId' | 'status' | 'indexPath' | 'indexBytes' | 'workerJobId'>>(sql`
      WITH ${WANTING_USERS_CTE}
      SELECT i.book_id AS "bookId", i.status, i.index_path AS "indexPath", i.index_bytes::float8 AS "indexBytes", i.worker_job_id AS "workerJobId"
      FROM edition_sync_book_index i
      JOIN books b ON b.id = i.book_id
      WHERE i.book_id > ${afterBookId} AND i.status IN ('ready', 'failed', 'stale') AND NOT ${WANTED_SQL}
      ORDER BY i.book_id
      LIMIT ${limit}
    `);
    return rowsOf<Pick<EditionSyncBookIndexRow, 'bookId' | 'status' | 'indexPath' | 'indexBytes' | 'workerJobId'>>(result);
  }

  /** Read-only peek: does upstream have a queued or processing read-aloud job? */
  async hasUpstreamActiveJobs(): Promise<boolean> {
    const [row] = await this.db
      .select({ id: schema.readAloudJobs.id })
      .from(schema.readAloudJobs)
      .where(inArray(schema.readAloudJobs.status, ['queued', 'processing']))
      .limit(1);
    return row !== undefined;
  }

  // Runs

  async clearPin(bookId: number): Promise<void> {
    await this.updateIndexRow(bookId, { pinnedAt: null });
  }

  async findReadAloudMode(userId: number, bookId: number): Promise<'auto' | 'disabled'> {
    const [row] = await this.db
      .select({ mode: schema.userBookReadAloudSyncSettings.mode })
      .from(schema.userBookReadAloudSyncSettings)
      .where(and(eq(schema.userBookReadAloudSyncSettings.userId, userId), eq(schema.userBookReadAloudSyncSettings.bookId, bookId)))
      .limit(1);
    return row?.mode ?? 'auto';
  }

  async widenRun(runId: number, windowUntil: Date | null): Promise<void> {
    await this.db
      .update(editionSyncRuns)
      .set({ trigger: 'scheduled', windowUntil })
      .where(and(eq(editionSyncRuns.id, runId), isNull(editionSyncRuns.endedAt)));
  }

  async createRun(trigger: EditionSyncRunTrigger, windowUntil: Date | null): Promise<EditionSyncRunRow> {
    const [row] = await this.db.insert(editionSyncRuns).values({ trigger, windowUntil }).returning();
    return row;
  }

  async finishRun(
    runId: number,
    values: { stopReason: EditionSyncRunStopReason; booksIndexed: number; booksFailed: number; secondsIndexed: number },
  ): Promise<void> {
    await this.db
      .update(editionSyncRuns)
      .set({ ...values, endedAt: new Date() })
      .where(eq(editionSyncRuns.id, runId));
  }

  async findActiveRun(): Promise<EditionSyncRunRow | null> {
    const [row] = await this.db
      .select()
      .from(editionSyncRuns)
      .where(isNull(editionSyncRuns.endedAt))
      .orderBy(desc(editionSyncRuns.startedAt))
      .limit(1);
    return row ?? null;
  }

  /** Closes runs a server restart left open; returns how many. */
  async endInterruptedRuns(): Promise<number> {
    const rows = await this.db
      .update(editionSyncRuns)
      .set({ endedAt: new Date(), stopReason: 'error' })
      .where(isNull(editionSyncRuns.endedAt))
      .returning({ id: editionSyncRuns.id });
    return rows.length;
  }

  /** Books indexed and wall-clock seconds spent over the last finished runs, or null without any. */
  async findRecentThroughput(): Promise<{ books: number; seconds: number } | null> {
    const result = await this.db.execute<{ books: number; seconds: number }>(sql`
      SELECT coalesce(sum(books_indexed), 0)::int AS "books",
        coalesce(sum(extract(epoch FROM (ended_at - started_at))), 0)::float8 AS "seconds"
      FROM (
        SELECT books_indexed, started_at, ended_at FROM edition_sync_runs
        WHERE ended_at IS NOT NULL AND books_indexed > 0
        ORDER BY started_at DESC
        LIMIT ${RECENT_THROUGHPUT_RUNS}
      ) recent
    `);
    const row = rowsOf<{ books: number; seconds: number }>(result)[0];
    return row && row.books > 0 ? { books: row.books, seconds: row.seconds } : null;
  }
}
