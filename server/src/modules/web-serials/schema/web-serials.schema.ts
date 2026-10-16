import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from 'drizzle-orm/pg-core';

import type {
  WebSerialEngineHealth,
  WebSerialFileIndexFormat,
  WebSerialFileIndexKeyMap,
  WebSerialJobCurrentUnit,
  WebSerialJobItemStatus,
  WebSerialJobStatus,
  WebSerialKind,
  WebSerialLookupHealth,
  WebSerialMetadataOverride,
  WebSerialPackaging,
  WebSerialNovelEngine,
  WebSerialNovelIndexFillState,
  WebSerialSelection,
  WebSerialSeriesMatch,
  WebSerialSeriesStatus,
} from '@bookorbit/types';
import { users } from '../../../db/schema/auth';
import { books } from '../../../db/schema/books';
import { libraries, libraryFolders } from '../../../db/schema/libraries';

/** Fits the longest series key the API accepts (`nl:` + 100 + `:` + 500), with room to spare. */
export const WEB_SERIAL_SERIES_KEY_MAX_LENGTH = 1024;

// Single-row table (id is always 1): one connection per engine serves every BookOrbit user.
export const webSerialSettings = pgTable(
  'web_serial_settings',
  {
    id: integer('id').primaryKey().default(1),
    mangaUrl: varchar('manga_url', { length: 2048 }),
    mangaUsername: varchar('manga_username', { length: 255 }),
    mangaPasswordEnc: text('manga_password_enc'),
    mangaLanguages: jsonb('manga_languages').$type<string[]>().notNull().default(['en']),
    mangaSourceIds: jsonb('manga_source_ids').$type<string[] | null>(),
    mangaTargetLibraryId: integer('manga_target_library_id').references(() => libraries.id, { onDelete: 'set null' }),
    mangaTargetFolderId: integer('manga_target_folder_id').references(() => libraryFolders.id, { onDelete: 'set null' }),
    mangaLastCheck: jsonb('manga_last_check').$type<WebSerialEngineHealth>(),
    novelUrl: varchar('novel_url', { length: 2048 }),
    novelUsername: varchar('novel_username', { length: 255 }),
    novelPasswordEnc: text('novel_password_enc'),
    novelSearchDomains: jsonb('novel_search_domains').$type<string[]>().notNull().default([]),
    novelEngine: varchar('novel_engine', { length: 10 }).$type<WebSerialNovelEngine>().notNull().default('lnreader'),
    novelSourcesUrl: varchar('novel_sources_url', { length: 2048 }),
    novelSourcesTokenEnc: text('novel_sources_token_enc'),
    novelSourceIds: jsonb('novel_source_ids').$type<string[]>().notNull().default([]),
    novelTargetLibraryId: integer('novel_target_library_id').references(() => libraries.id, { onDelete: 'set null' }),
    novelTargetFolderId: integer('novel_target_folder_id').references(() => libraryFolders.id, { onDelete: 'set null' }),
    novelDefaultPackaging: varchar('novel_default_packaging', { length: 10 }).$type<'volume' | 'series'>().notNull().default('volume'),
    novelLastCheck: jsonb('novel_last_check').$type<WebSerialEngineHealth>(),
    novelIndexDailyBudget: integer('novel_index_daily_budget').notNull().default(1500),
    lookupEnabled: boolean('lookup_enabled').notNull().default(true),
    lookupLastCheck: jsonb('lookup_last_check').$type<WebSerialLookupHealth>(),
    maxConcurrentJobs: integer('max_concurrent_jobs').notNull().default(2),
    queuePaused: boolean('queue_paused').notNull().default(false),
    illustratorBackfillDoneAt: timestamp('illustrator_backfill_done_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    check('web_serial_settings_singleton_chk', sql`${t.id} = 1`),
    check('web_serial_settings_packaging_chk', sql`${t.novelDefaultPackaging} in ('volume', 'series')`),
    check('web_serial_settings_novel_engine_chk', sql`${t.novelEngine} in ('lnreader', 'lncrawl')`),
    check('web_serial_settings_concurrency_chk', sql`${t.maxConcurrentJobs} between 1 and 6`),
  ],
);

export const webSerialJobs = pgTable(
  'web_serial_jobs',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 10 }).$type<WebSerialKind>().notNull(),
    seriesKey: varchar('series_key', { length: WEB_SERIAL_SERIES_KEY_MAX_LENGTH }).notNull(),
    seriesUrl: varchar('series_url', { length: 2048 }),
    title: varchar('title', { length: 1000 }).notNull(),
    author: varchar('author', { length: 1000 }),
    sourceName: varchar('source_name', { length: 255 }).notNull(),
    packaging: varchar('packaging', { length: 10 }).$type<WebSerialPackaging>().notNull(),
    selection: jsonb('selection').$type<WebSerialSelection>().notNull(),
    skipImported: boolean('skip_imported').notNull().default(true),
    targetLibraryId: integer('target_library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    targetFolderId: integer('target_folder_id').references(() => libraryFolders.id, { onDelete: 'set null' }),
    status: varchar('status', { length: 24 }).$type<WebSerialJobStatus>().notNull().default('queued'),
    unitsTotal: integer('units_total').notNull().default(0),
    unitsDone: integer('units_done').notNull().default(0),
    unitsFailed: integer('units_failed').notNull().default(0),
    unitsSkipped: integer('units_skipped').notNull().default(0),
    message: text('message'),
    currentUnit: jsonb('current_unit').$type<WebSerialJobCurrentUnit | null>(),
    engineState: jsonb('engine_state').$type<Record<string, unknown>>().notNull().default({}),
    metadata: jsonb('metadata').$type<{ override?: WebSerialMetadataOverride; match?: WebSerialSeriesMatch | null }>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    queueOrder: bigint('queue_order', { mode: 'number' })
      .notNull()
      .default(sql`((extract(epoch from now()) * 1000)::bigint)`),
  },
  (t) => [
    index('web_serial_jobs_user_created_idx').on(t.userId, t.createdAt.desc()),
    index('web_serial_jobs_active_idx')
      .on(t.status)
      .where(sql`${t.status} in ('queued', 'running', 'importing')`),
    index('web_serial_jobs_queue_idx')
      .on(t.queueOrder, t.id)
      .where(sql`${t.status} = 'queued'`),
    index('web_serial_jobs_finished_idx')
      .on(t.finishedAt)
      .where(sql`${t.finishedAt} is not null`),
    index('web_serial_jobs_series_idx').on(t.userId, t.seriesKey),
    check('web_serial_jobs_kind_chk', sql`${t.kind} in ('manga', 'novel')`),
    check('web_serial_jobs_packaging_chk', sql`${t.packaging} in ('chapter', 'volume', 'series')`),
    check(
      'web_serial_jobs_status_chk',
      sql`${t.status} in ('queued', 'paused', 'running', 'importing', 'completed', 'completed_with_gaps', 'failed', 'cancelled')`,
    ),
  ],
);

export const webSerialJobItems = pgTable(
  'web_serial_job_items',
  {
    id: serial('id').primaryKey(),
    jobId: integer('job_id')
      .notNull()
      .references(() => webSerialJobs.id, { onDelete: 'cascade' }),
    unitKey: varchar('unit_key', { length: 255 }).notNull(),
    label: varchar('label', { length: 1000 }).notNull(),
    sequence: varchar('sequence', { length: 20 }).notNull(),
    status: varchar('status', { length: 16 }).$type<WebSerialJobItemStatus>().notNull().default('pending'),
    bookId: integer('book_id').references(() => books.id, { onDelete: 'set null' }),
    error: text('error'),
    remoteRef: jsonb('remote_ref').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    unique('web_serial_job_items_job_unit_unique').on(t.jobId, t.unitKey),
    index('web_serial_job_items_book_id_idx').on(t.bookId),
    check('web_serial_job_items_status_chk', sql`${t.status} in ('pending', 'fetching', 'importing', 'imported', 'skipped', 'failed')`),
  ],
);

export const webSerialImports = pgTable(
  'web_serial_imports',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    seriesKey: varchar('series_key', { length: WEB_SERIAL_SERIES_KEY_MAX_LENGTH }).notNull(),
    matchKey: varchar('match_key', { length: 64 }),
    kind: varchar('kind', { length: 10 }).$type<WebSerialKind>().notNull(),
    unitKey: varchar('unit_key', { length: 255 }).notNull(),
    sequence: varchar('sequence', { length: 20 }).notNull(),
    packaging: varchar('packaging', { length: 10 }).$type<WebSerialPackaging>().notNull(),
    bookId: integer('book_id').references(() => books.id, { onDelete: 'cascade' }),
    /** First and last chapter the book holds (manga chapter numbers, novel list positions); null on rows from before ranges. */
    chapterFrom: doublePrecision('chapter_from'),
    chapterTo: doublePrecision('chapter_to'),
    /** The job's series title, compacted the way a later search compacts it, for matching another source of the novel. */
    titleKey: varchar('title_key', { length: 1000 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('web_serial_imports_unique').on(t.userId, t.seriesKey, t.unitKey, t.packaging),
    index('web_serial_imports_series_idx').on(t.userId, t.seriesKey),
    index('web_serial_imports_match_idx').on(t.userId, t.matchKey),
    index('web_serial_imports_book_id_idx').on(t.bookId),
  ],
);

// The admin-enabled novel search domains this user switched off; storing the off list keeps newly enabled domains on by default.
export const webSerialNovelPrefs = pgTable('web_serial_novel_prefs', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  disabledDomains: jsonb('disabled_domains').$type<string[]>().notNull().default([]),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdateFn(() => new Date()),
});

/** Light novel index: one row per series page on one LNReader source, filled by browsing each source and by every search and opened novel. */
export const webSerialNovelIndex = pgTable(
  'web_serial_novel_index',
  {
    id: serial('id').primaryKey(),
    sourceId: varchar('source_id', { length: 100 }).notNull(),
    path: varchar('path', { length: 2048 }).notNull(),
    url: varchar('url', { length: 2048 }),
    title: varchar('title', { length: 1000 }).notNull(),
    titleKey: varchar('title_key', { length: 1000 }).notNull(),
    author: varchar('author', { length: 500 }),
    mtl: boolean('mtl').notNull().default(false),
    coverUrl: varchar('cover_url', { length: 2048 }),
    matchId: varchar('match_id', { length: 16 }),
    status: varchar('status', { length: 16 }).$type<WebSerialSeriesStatus>(),
    chapterCount: integer('chapter_count'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
    detailsAt: timestamp('details_at', { withTimezone: true }),
  },
  (t) => [
    unique('web_serial_novel_index_source_path_unique').on(t.sourceId, t.path),
    index('web_serial_novel_index_title_gist_idx').using('gist', sql`${t.titleKey} gist_trgm_ops`),
    index('web_serial_novel_index_title_filter_idx').using('gin', sql`lower(${t.titleKey}) gin_trgm_ops`),
    index('web_serial_novel_index_title_prefix_idx').on(sql`${t.titleKey} varchar_pattern_ops`),
    index('web_serial_novel_index_match_idx')
      .on(t.matchId)
      .where(sql`${t.matchId} is not null`),
  ],
);

export const webSerialNovelIndexSources = pgTable(
  'web_serial_novel_index_sources',
  {
    sourceId: varchar('source_id', { length: 100 }).primaryKey(),
    fillState: varchar('fill_state', { length: 10 }).$type<WebSerialNovelIndexFillState>().notNull().default('pending'),
    nextPage: integer('next_page').notNull().default(1),
    fillSort: text('fill_sort'),
    filledAt: timestamp('filled_at', { withTimezone: true }),
    lastTopupAt: timestamp('last_topup_at', { withTimezone: true }),
    entries: integer('entries').notNull().default(0),
    lastError: text('last_error'),
    requestsToday: integer('requests_today').notNull().default(0),
    requestsDay: varchar('requests_day', { length: 10 }),
    /** A page that came back empty once; the fill only ends when it is still empty on a later run. */
    emptyPage: integer('empty_page'),
    /** Failed first pages of the preferred sort in a row; a fallback sort is only tried after a repeat. */
    firstPageFailures: integer('first_page_failures').notNull().default(0),
    /** An unconfirmed empty page or a failed first page is retried no sooner than this. */
    recheckAt: timestamp('recheck_at', { withTimezone: true }),
  },
  (t) => [check('web_serial_novel_index_sources_state_chk', sql`${t.fillState} in ('pending', 'filling', 'done', 'paused')`)],
);

/** The Book Requests a user filed from the published-volumes section; the request itself lives in Book Requests. */
export const webSerialVolumeRequests = pgTable(
  'web_serial_volume_requests',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 10 }).$type<WebSerialKind>().notNull(),
    matchId: varchar('match_id', { length: 16 }).notNull(),
    volume: varchar('volume', { length: 16 }).notNull(),
    bookRequestId: integer('book_request_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check('web_serial_volume_requests_kind_chk', sql`${t.kind} in ('manga', 'novel')`),
    unique('web_serial_volume_requests_unique').on(t.userId, t.kind, t.matchId, t.volume),
  ],
);

/** An admin-configured listing of downloadable books, refreshed on a schedule into the two tables below. */
export const webSerialFileIndexes = pgTable(
  'web_serial_file_indexes',
  {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 100 }).notNull(),
    listingUrl: varchar('listing_url', { length: 2048 }).notNull(),
    baseUrl: varchar('base_url', { length: 2048 }).notNull(),
    format: varchar('format', { length: 10 }).$type<WebSerialFileIndexFormat>().notNull(),
    keyMap: jsonb('key_map').$type<WebSerialFileIndexKeyMap>().notNull().default({}),
    username: varchar('username', { length: 255 }),
    passwordEnc: text('password_enc'),
    enabled: boolean('enabled').notNull().default(true),
    refreshHours: integer('refresh_hours').notNull().default(24),
    lastRefreshAt: timestamp('last_refresh_at', { withTimezone: true }),
    lastEtag: varchar('last_etag', { length: 512 }),
    lastModified: varchar('last_modified', { length: 100 }),
    seriesCount: integer('series_count').notNull().default(0),
    fileCount: integer('file_count').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    check('web_serial_file_indexes_format_chk', sql`${t.format} in ('json', 'html')`),
    check('web_serial_file_indexes_refresh_chk', sql`${t.refreshHours} between 1 and 720`),
  ],
);

/** One folder of book files in a file index; the folder name is the series title. */
export const webSerialFileIndexSeries = pgTable(
  'web_serial_file_index_series',
  {
    id: serial('id').primaryKey(),
    indexId: integer('index_id')
      .notNull()
      .references(() => webSerialFileIndexes.id, { onDelete: 'cascade' }),
    folderPath: varchar('folder_path', { length: 2048 }).notNull(),
    title: varchar('title', { length: 1000 }).notNull(),
    titleKey: varchar('title_key', { length: 1000 }).notNull(),
    volumeCount: integer('volume_count').notNull().default(0),
    /** An image named like a cover (`cover.jpg`, `folder.png`) in the series folder, as a listing path. */
    coverPath: varchar('cover_path', { length: 2048 }),
    matchId: varchar('match_id', { length: 16 }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('web_serial_file_index_series_path_unique').on(t.indexId, t.folderPath),
    index('web_serial_file_index_series_title_gist_idx').using('gist', sql`${t.titleKey} gist_trgm_ops`),
    index('web_serial_file_index_series_match_idx')
      .on(t.matchId)
      .where(sql`${t.matchId} is not null`),
  ],
);

export const webSerialFileIndexFiles = pgTable(
  'web_serial_file_index_files',
  {
    id: serial('id').primaryKey(),
    seriesId: integer('series_id')
      .notNull()
      .references(() => webSerialFileIndexSeries.id, { onDelete: 'cascade' }),
    path: varchar('path', { length: 2048 }).notNull(),
    name: varchar('name', { length: 1000 }).notNull(),
    size: bigint('size', { mode: 'number' }),
    volume: doublePrecision('volume'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique('web_serial_file_index_files_path_unique').on(t.seriesId, t.path)],
);

export type WebSerialSettingsRow = typeof webSerialSettings.$inferSelect;
export type NewWebSerialSettingsRow = typeof webSerialSettings.$inferInsert;
export type WebSerialJobRow = typeof webSerialJobs.$inferSelect;
export type NewWebSerialJobRow = typeof webSerialJobs.$inferInsert;
export type WebSerialJobItemRow = typeof webSerialJobItems.$inferSelect;
export type NewWebSerialJobItemRow = typeof webSerialJobItems.$inferInsert;
export type NewWebSerialImportRow = typeof webSerialImports.$inferInsert;
export type WebSerialNovelIndexRow = typeof webSerialNovelIndex.$inferSelect;
export type WebSerialNovelIndexSourceRow = typeof webSerialNovelIndexSources.$inferSelect;
export type NewWebSerialNovelIndexSourceRow = typeof webSerialNovelIndexSources.$inferInsert;
export type WebSerialFileIndexRow = typeof webSerialFileIndexes.$inferSelect;
export type NewWebSerialFileIndexRow = typeof webSerialFileIndexes.$inferInsert;
export type WebSerialFileIndexSeriesRow = typeof webSerialFileIndexSeries.$inferSelect;
export type WebSerialFileIndexFileRow = typeof webSerialFileIndexFiles.$inferSelect;
