import { sql } from 'drizzle-orm';
import {
  boolean,
  smallint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import type {
  MonitoredDatePrecision,
  MonitoredFetchState,
  MonitoredFetchErrorKind,
  MonitoredFormat,
  MonitoredMarkKind,
  MonitoredMatchDecision,
  MonitoredReleaseDateSource,
  MonitoredReleaseProbeStatus,
  MonitoredSeriesMembership,
  MonitoredWorkFlag,
  MonitoredWorkKind,
  MonitoredWorkState,
  MonitoredWorkVerdict,
  MonitorMode,
} from '@bookorbit/types';

import { authors } from '../../../db/schema/metadata';
import { users } from '../../../db/schema/auth';
import { bookRequests } from '../../../db/schema/book-requests';
import { books } from '../../../db/schema/books';
import { libraries, libraryFolders } from '../../../db/schema/libraries';

export const monitoredSettings = pgTable(
  'monitored_settings',
  {
    id: integer('id').primaryKey().default(1),
    refreshCooldownMinutes: integer('refresh_cooldown_minutes').notNull().default(10),
    syncEnabled: boolean('sync_enabled').notNull().default(true),
    syncIntervalHours: integer('sync_interval_hours').notNull().default(12),
    releaseProbeEnabled: boolean('release_probe_enabled').notNull().default(true),
  },
  (t) => [check('monitored_settings_single_row_chk', sql`${t.id} = 1`)],
);

// These literal CHECK lists are mirrored against @bookorbit/types in monitored.schema.test.ts.
export const monitoredAuthors = pgTable(
  'monitored_authors',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    ownerUserId: integer('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    authorName: varchar('author_name', { length: 500 }).notNull(),
    localAuthorId: integer('local_author_id').references(() => authors.id, { onDelete: 'set null' }),
    paused: boolean('paused').notNull().default(false),
    ebookMode: varchar('ebook_mode', { length: 20 }).$type<MonitorMode>().notNull(),
    ebookLibraryId: integer('ebook_library_id').references(() => libraries.id, { onDelete: 'set null' }),
    ebookFolderId: integer('ebook_folder_id').references(() => libraryFolders.id, { onDelete: 'set null' }),
    audiobookMode: varchar('audiobook_mode', { length: 20 }).$type<MonitorMode>().notNull(),
    audiobookLibraryId: integer('audiobook_library_id').references(() => libraries.id, { onDelete: 'set null' }),
    audiobookFolderId: integer('audiobook_folder_id').references(() => libraryFolders.id, { onDelete: 'set null' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull(),
    lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }),
    fetchState: varchar('fetch_state', { length: 12 }).$type<MonitoredFetchState>().notNull().default('idle'),
    fetchErrorKind: varchar('fetch_error_kind', { length: 20 }).$type<MonitoredFetchErrorKind>(),
    fetchErrorAt: timestamp('fetch_error_at', { withTimezone: true }),
    fetchRetryAt: timestamp('fetch_retry_at', { withTimezone: true }),
    fetchAttempts: smallint('fetch_attempts').notNull().default(0),
    lastSyncAttemptedAt: timestamp('last_sync_attempted_at', { withTimezone: true }),
    // Null means the release watcher has never looked at this monitor. The first pass seeds the
    // ledger silently instead of announcing every book that came out since the monitor was added.
    lastReleaseCheckAt: timestamp('last_release_check_at', { withTimezone: true }),
  },
  (t) => [
    index('monitored_authors_fetch_pending_idx')
      .on(t.fetchState, t.addedAt, t.id)
      .where(sql`${t.fetchState} <> 'idle'`),
    check('monitored_authors_fetch_state_chk', sql`${t.fetchState} in ('idle', 'queued', 'fetching', 'failed')`),
    check(
      'monitored_authors_fetch_error_kind_chk',
      sql`${t.fetchErrorKind} in ('timeout', 'rate_limited', 'unavailable', 'auth_failed', 'author_gone', 'not_configured')`,
    ),
    index('monitored_authors_owner_user_id_idx').on(t.ownerUserId),
    // Author search is an accent-insensitive ILIKE over bookorbit_unaccent(author_name), the same
    // predicate authors/series/book_metadata already index this way (migration 0047). Without it the
    // list scans every readable monitor per keystroke.
    index('monitored_authors_name_unaccent_trgm_idx').using('gin', sql`public.bookorbit_unaccent(${t.authorName}) gin_trgm_ops`),
    // The service pre-checks for a duplicate name, but that read-then-write loses a concurrent race.
    uniqueIndex('monitored_authors_owner_lower_name_uidx').on(t.ownerUserId, sql`lower(${t.authorName})`),
    check('monitored_authors_ebook_mode_chk', sql`${t.ebookMode} in ('notify', 'auto-upcoming', 'auto-all', 'off')`),
    check('monitored_authors_audiobook_mode_chk', sql`${t.audiobookMode} in ('notify', 'auto-upcoming', 'auto-all', 'off')`),
  ],
);

export const authorProviderIdentities = pgTable(
  'author_provider_identities',
  {
    monitorAuthorId: varchar('monitor_author_id', { length: 36 })
      .notNull()
      .references(() => monitoredAuthors.id, { onDelete: 'cascade' }),
    source: varchar('source', { length: 20 }).notNull(),
    providerId: varchar('provider_id', { length: 255 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.monitorAuthorId, t.source] })],
);

export const authorCatalogState = pgTable('author_catalog_state', {
  monitorAuthorId: varchar('monitor_author_id', { length: 36 })
    .primaryKey()
    .references(() => monitoredAuthors.id, { onDelete: 'cascade' }),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
});

export const authorCatalogWorks = pgTable(
  'author_catalog_works',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    monitorAuthorId: varchar('monitor_author_id', { length: 36 })
      .notNull()
      .references(() => monitoredAuthors.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 1000 }).notNull(),
    subtitle: varchar('subtitle', { length: 1000 }),
    seriesName: varchar('series_name', { length: 500 }),
    seriesIndex: varchar('series_index', { length: 50 }),
    seriesMemberships: jsonb('series_memberships').$type<MonitoredSeriesMembership[]>().notNull().default([]),
    releaseYear: integer('release_year'),
    ebookReleaseDate: varchar('ebook_release_date', { length: 10 }),
    ebookDatePrecision: varchar('ebook_date_precision', { length: 5 }).$type<MonitoredDatePrecision>(),
    audioReleaseDate: varchar('audio_release_date', { length: 10 }),
    audioDatePrecision: varchar('audio_date_precision', { length: 5 }).$type<MonitoredDatePrecision>(),
    coverUrl: text('cover_url'),
    description: text('description'),
    verdict: varchar('verdict', { length: 10 }).$type<MonitoredWorkVerdict>().notNull(),
    flags: jsonb('flags').$type<MonitoredWorkFlag[]>().notNull().default([]),
    kind: varchar('kind', { length: 20 }).$type<MonitoredWorkKind>(),
    sources: jsonb('sources').$type<string[]>().notNull().default([]),
    matchedBookId: integer('matched_book_id').references(() => books.id, { onDelete: 'set null' }),
    matchedEbookBookId: integer('matched_ebook_book_id').references(() => books.id, { onDelete: 'set null' }),
    matchedAudioBookId: integer('matched_audio_book_id').references(() => books.id, { onDelete: 'set null' }),
    ownedFormats: jsonb('owned_formats').$type<MonitoredFormat[]>().notNull().default([]),
    possibleEbookBookId: integer('possible_ebook_book_id').references(() => books.id, { onDelete: 'set null' }),
    possibleAudioBookId: integer('possible_audio_book_id').references(() => books.id, { onDelete: 'set null' }),
    linkedFormats: jsonb('linked_formats').$type<MonitoredFormat[]>().notNull().default([]),
    answeredFormats: jsonb('answered_formats').$type<MonitoredFormat[]>().notNull().default([]),
  },
  (t) => [
    index('author_catalog_works_monitor_author_id_idx').on(t.monitorAuthorId),
    index('author_catalog_works_monitor_author_verdict_idx').on(t.monitorAuthorId, t.verdict),
    index('author_catalog_works_matched_book_id_idx').on(t.matchedBookId),
    index('author_catalog_works_matched_ebook_book_id_idx').on(t.matchedEbookBookId),
    index('author_catalog_works_matched_audio_book_id_idx').on(t.matchedAudioBookId),
    index('author_catalog_works_possible_ebook_book_id_idx').on(t.possibleEbookBookId),
    index('author_catalog_works_possible_audio_book_id_idx').on(t.possibleAudioBookId),
    // The books and releases lists search this column with the same unaccented ILIKE, over a table
    // that holds every work of every monitor - tens of thousands of rows on a real library.
    index('author_catalog_works_title_unaccent_trgm_idx').using('gin', sql`public.bookorbit_unaccent(${t.title}) gin_trgm_ops`),
    check('author_catalog_works_verdict_chk', sql`${t.verdict} in ('verified', 'probable', 'suspect')`),
    check(
      'author_catalog_works_kind_chk',
      sql`${t.kind} is null or ${t.kind} in ('collection', 'anthology', 'graphic_novel', 'supplemental', 'format_variant', 'duplicate', 'dramatization', 'split_part')`,
    ),
  ],
);

export const authorCatalogSourceWorks = pgTable(
  'author_catalog_source_works',
  {
    workId: varchar('work_id', { length: 255 })
      .notNull()
      .references(() => authorCatalogWorks.id, { onDelete: 'cascade' }),
    source: varchar('source', { length: 20 }).notNull(),
    providerWorkId: varchar('provider_work_id', { length: 255 }).notNull(),
    ratingAverage: real('rating_average'),
    ratingCount: integer('rating_count'),
  },
  (t) => [primaryKey({ columns: [t.workId, t.source] }), index('author_catalog_source_works_provider_work_id_idx').on(t.providerWorkId)],
);

export const authorCatalogWorkReleases = pgTable(
  'author_catalog_work_releases',
  {
    workId: varchar('work_id', { length: 255 }).notNull(),
    monitorAuthorId: varchar('monitor_author_id', { length: 36 })
      .notNull()
      .references(() => monitoredAuthors.id, { onDelete: 'cascade' }),
    ownerUserId: integer('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    format: varchar('format', { length: 10 }).$type<MonitoredFormat>().notNull(),
    status: varchar('status', { length: 10 }).$type<MonitoredReleaseProbeStatus>().notNull(),
    releaseDate: varchar('release_date', { length: 10 }),
    datePrecision: varchar('date_precision', { length: 5 }).$type<MonitoredDatePrecision>(),
    lastReleaseDate: varchar('last_release_date', { length: 10 }),
    lastDatePrecision: varchar('last_date_precision', { length: 5 }).$type<MonitoredDatePrecision>(),
    lastDateSource: varchar('last_date_source', { length: 20 }).$type<MonitoredReleaseDateSource>(),
    previousReleaseDate: varchar('previous_release_date', { length: 10 }),
    previousDatePrecision: varchar('previous_date_precision', { length: 5 }).$type<MonitoredDatePrecision>(),
    dateChangedAt: timestamp('date_changed_at', { withTimezone: true }),
    autoReleaseDate: varchar('auto_release_date', { length: 10 }),
    autoDatePrecision: varchar('auto_date_precision', { length: 5 }).$type<MonitoredDatePrecision>(),
    autoSource: varchar('auto_source', { length: 20 }).$type<MonitoredReleaseDateSource>(),
    autoChangedAt: timestamp('auto_changed_at', { withTimezone: true }),
    source: varchar('source', { length: 20 }).$type<MonitoredReleaseDateSource>(),
    asin: varchar('asin', { length: 16 }),
    checkedAt: timestamp('checked_at', { withTimezone: true }),
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastErrorClass: varchar('last_error_class', { length: 100 }),
  },
  (t) => [
    primaryKey({ columns: [t.workId, t.format] }),
    index('author_catalog_work_releases_next_check_at_work_id_idx').on(t.nextCheckAt, t.workId),
    index('author_catalog_work_releases_monitor_author_id_idx').on(t.monitorAuthorId),
    index('author_catalog_work_releases_owner_user_id_idx').on(t.ownerUserId),
    check('author_catalog_work_releases_format_chk', sql`${t.format} in ('ebook', 'audiobook')`),
    check('author_catalog_work_releases_status_chk', sql`${t.status} in ('pending', 'expected', 'dated', 'unlisted')`),
    check(
      'author_catalog_work_releases_source_chk',
      sql`${t.source} is null or ${t.source} in ('hardcover_edition', 'apple', 'amazon', 'amazon_search', 'audible', 'user')`,
    ),
  ],
);

export const monitoredAuthorWorks = pgTable(
  'monitored_author_works',
  {
    workId: varchar('work_id', { length: 255 })
      .primaryKey()
      .references(() => authorCatalogWorks.id, { onDelete: 'cascade' }),
    monitorAuthorId: varchar('monitor_author_id', { length: 36 })
      .notNull()
      .references(() => monitoredAuthors.id, { onDelete: 'cascade' }),
    monitorState: varchar('monitor_state', { length: 12 }).$type<MonitoredWorkState>().notNull().default('monitoring'),
    monitorEbook: boolean('monitor_ebook'),
    monitorAudiobook: boolean('monitor_audiobook'),
    autoDownloadEbook: boolean('auto_download_ebook'),
    autoDownloadAudiobook: boolean('auto_download_audiobook'),
    userVisibility: varchar('user_visibility', { length: 10 }).$type<'hidden' | 'visible'>(),
    userKind: varchar('user_kind', { length: 16 }).$type<MonitoredMarkKind>(),
    ebookRequestId: integer('ebook_request_id').references(() => bookRequests.id, { onDelete: 'set null' }),
    audiobookRequestId: integer('audiobook_request_id').references(() => bookRequests.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('monitored_author_works_monitor_author_id_idx').on(t.monitorAuthorId),
    check('monitored_author_works_monitor_state_chk', sql`${t.monitorState} in ('monitoring', 'paused', 'stopped')`),
    check('monitored_author_works_user_visibility_chk', sql`${t.userVisibility} is null or ${t.userVisibility} in ('hidden', 'visible')`),
    check(
      'monitored_author_works_user_kind_chk',
      sql`${t.userKind} is null or ${t.userKind} in ('book', 'collection', 'split_part', 'dramatization', 'anthology', 'graphic_novel', 'supplemental', 'format_variant', 'duplicate')`,
    ),
  ],
);

/**
 * One row per work and format that has crossed its release date while somebody was monitoring it.
 *
 * A null `notifiedAt` is pending work. Setting it is the dispatch lease, so concurrent passes cannot
 * announce the same release, and a failed dispatch clears it for a later retry.
 */
export const monitoredReleaseEvents = pgTable(
  'monitored_release_events',
  {
    workId: varchar('work_id', { length: 255 }).notNull(),
    monitorAuthorId: varchar('monitor_author_id', { length: 36 })
      .notNull()
      .references(() => monitoredAuthors.id, { onDelete: 'cascade' }),
    ownerUserId: integer('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    format: varchar('format', { length: 10 }).$type<MonitoredFormat>().notNull(),
    title: varchar('title', { length: 1000 }),
    // The work's provider ids as `source:id`, so a later work id for the same book still finds this row.
    identityKeys: text('identity_keys')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    releaseDate: varchar('release_date', { length: 10 }).notNull(),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull(),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.workId, t.format] }),
    index('monitored_release_events_owner_user_id_idx').on(t.ownerUserId),
    index('monitored_release_events_monitor_author_id_idx').on(t.monitorAuthorId),
    check('monitored_release_events_format_chk', sql`${t.format} in ('ebook', 'audiobook')`),
  ],
);

/**
 * The owner's choices on a monitor's works (watch state and toggles, hidden or kept, the Mark as kind),
 * keyed by what identifies the book rather than by the work id. A catalog refresh deletes the works it
 * no longer sees, and their overlay with them, so the choices are copied here first and handed back to
 * whichever work turns up with the same identity.
 */
export const monitoredChoiceLedger = pgTable(
  'monitored_choice_ledger',
  {
    monitorAuthorId: varchar('monitor_author_id', { length: 36 })
      .notNull()
      .references(() => monitoredAuthors.id, { onDelete: 'cascade' }),
    identityKey: varchar('identity_key', { length: 300 }).notNull(),
    /** The work the choice was recorded from, so it is only handed on once that work is gone. */
    workId: varchar('work_id', { length: 255 }),
    // Null where the work had the default, so a ledger row only carries what the owner chose.
    monitorState: varchar('monitor_state', { length: 12 }).$type<MonitoredWorkState>(),
    monitorEbook: boolean('monitor_ebook'),
    monitorAudiobook: boolean('monitor_audiobook'),
    autoDownloadEbook: boolean('auto_download_ebook'),
    autoDownloadAudiobook: boolean('auto_download_audiobook'),
    userVisibility: varchar('user_visibility', { length: 10 }).$type<'hidden' | 'visible'>(),
    userKind: varchar('user_kind', { length: 16 }).$type<MonitoredMarkKind>(),
  },
  (t) => [primaryKey({ columns: [t.monitorAuthorId, t.identityKey] })],
);

/**
 * Every request a monitor's works have filed, keyed by what identifies the book rather than by the
 * work id. A catalog refresh deletes the works it no longer sees, and their overlay with them, so the
 * request id is copied here first and handed back to whichever work turns up with the same identity.
 */
export const monitoredRequestLedger = pgTable(
  'monitored_request_ledger',
  {
    monitorAuthorId: varchar('monitor_author_id', { length: 36 })
      .notNull()
      .references(() => monitoredAuthors.id, { onDelete: 'cascade' }),
    format: varchar('format', { length: 10 }).$type<MonitoredFormat>().notNull(),
    identityKey: varchar('identity_key', { length: 300 }).notNull(),
    requestId: integer('request_id')
      .notNull()
      .references(() => bookRequests.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.monitorAuthorId, t.format, t.identityKey] }),
    index('monitored_request_ledger_request_id_idx').on(t.requestId),
    check('monitored_request_ledger_format_chk', sql`${t.format} in ('ebook', 'audiobook')`),
  ],
);

/**
 * The owner's answers about which library book is a work's book, per format, keyed by what identifies
 * the work rather than by its id so a refresh that files the book under a new work id keeps them. A
 * `link` makes the book the match whatever the matcher thinks; a `reject` keeps the book from ever
 * matching or being offered as a possible match again.
 */
export const monitoredMatchOverrides = pgTable(
  'monitored_match_overrides',
  {
    monitorAuthorId: varchar('monitor_author_id', { length: 36 })
      .notNull()
      .references(() => monitoredAuthors.id, { onDelete: 'cascade' }),
    format: varchar('format', { length: 10 }).$type<MonitoredFormat>().notNull(),
    identityKey: varchar('identity_key', { length: 300 }).notNull(),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    decision: varchar('decision', { length: 10 }).$type<Exclude<MonitoredMatchDecision, 'automatic'>>().notNull(),
    /** The work the answer was given on, for tracing; the identity key is what applies it. */
    workId: varchar('work_id', { length: 255 }),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.monitorAuthorId, t.format, t.identityKey, t.bookId] }),
    index('monitored_match_overrides_book_id_idx').on(t.bookId),
    check('monitored_match_overrides_format_chk', sql`${t.format} in ('ebook', 'audiobook')`),
    check('monitored_match_overrides_decision_chk', sql`${t.decision} in ('link', 'reject')`),
  ],
);

export const monitoredBooks = pgTable(
  'monitored_books',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    ownerUserId: integer('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    monitorAuthorId: varchar('monitor_author_id', { length: 36 })
      .notNull()
      .references(() => monitoredAuthors.id, { onDelete: 'cascade' }),
    workId: varchar('work_id', { length: 255 }).notNull(),
    formats: jsonb('formats').$type<MonitoredFormat[]>().notNull().default([]),
    paused: boolean('paused').notNull().default(false),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('monitored_books_work_id_idx').on(t.workId),
    index('monitored_books_owner_user_id_idx').on(t.ownerUserId),
    // The service pre-checks that this work is not already monitored, but that read-then-write loses a
    // concurrent race and would leave one owner with two rows for one work.
    uniqueIndex('monitored_books_owner_monitor_work_uidx').on(t.ownerUserId, t.monitorAuthorId, t.workId),
  ],
);

export type MonitoredAuthorRow = typeof monitoredAuthors.$inferSelect;
export type AuthorCatalogWorkRow = typeof authorCatalogWorks.$inferSelect;
export type MonitoredAuthorWorkRow = typeof monitoredAuthorWorks.$inferSelect;
export type MonitoredMatchOverrideRow = typeof monitoredMatchOverrides.$inferSelect;
