import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import type {
  MonitoredDatePrecision,
  MonitoredFormat,
  MonitoredSeriesMembership,
  MonitoredWorkFlag,
  MonitoredWorkState,
  MonitoredWorkVerdict,
  MonitorMode,
} from '@bookorbit/types';

import { authors } from './metadata';
import { users } from './auth';
import { bookRequests } from './book-requests';
import { books } from './books';
import { libraries, libraryFolders } from './libraries';

// These literal CHECK lists are mirrored against @bookorbit/types in monitored.schema.test.ts.
export const monitoredAuthors = pgTable(
  'monitored_authors',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    ownerUserId: integer('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    isShared: boolean('is_shared').notNull().default(false),
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
  },
  (t) => [
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
    sources: jsonb('sources').$type<string[]>().notNull().default([]),
    matchedBookId: integer('matched_book_id').references(() => books.id, { onDelete: 'set null' }),
    matchedEbookBookId: integer('matched_ebook_book_id').references(() => books.id, { onDelete: 'set null' }),
    matchedAudioBookId: integer('matched_audio_book_id').references(() => books.id, { onDelete: 'set null' }),
    ownedFormats: jsonb('owned_formats').$type<MonitoredFormat[]>().notNull().default([]),
  },
  (t) => [
    index('author_catalog_works_monitor_author_id_idx').on(t.monitorAuthorId),
    index('author_catalog_works_monitor_author_verdict_idx').on(t.monitorAuthorId, t.verdict),
    index('author_catalog_works_matched_book_id_idx').on(t.matchedBookId),
    index('author_catalog_works_matched_ebook_book_id_idx').on(t.matchedEbookBookId),
    index('author_catalog_works_matched_audio_book_id_idx').on(t.matchedAudioBookId),
    // The books and releases lists search this column with the same unaccented ILIKE, over a table
    // that holds every work of every monitor - tens of thousands of rows on a real library.
    index('author_catalog_works_title_unaccent_trgm_idx').using('gin', sql`public.bookorbit_unaccent(${t.title}) gin_trgm_ops`),
    check('author_catalog_works_verdict_chk', sql`${t.verdict} in ('verified', 'probable', 'suspect')`),
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
  },
  (t) => [primaryKey({ columns: [t.workId, t.source] }), index('author_catalog_source_works_provider_work_id_idx').on(t.providerWorkId)],
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
    userVisibility: varchar('user_visibility', { length: 10 }).$type<'hidden' | 'visible'>(),
    ebookRequestId: integer('ebook_request_id').references(() => bookRequests.id, { onDelete: 'set null' }),
    audiobookRequestId: integer('audiobook_request_id').references(() => bookRequests.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('monitored_author_works_monitor_author_id_idx').on(t.monitorAuthorId),
    check('monitored_author_works_monitor_state_chk', sql`${t.monitorState} in ('monitoring', 'paused', 'stopped')`),
    check('monitored_author_works_user_visibility_chk', sql`${t.userVisibility} is null or ${t.userVisibility} in ('hidden', 'visible')`),
  ],
);

export const monitoredBooks = pgTable(
  'monitored_books',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    ownerUserId: integer('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    isShared: boolean('is_shared').notNull().default(false),
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
export type NewMonitoredAuthorRow = typeof monitoredAuthors.$inferInsert;
export type AuthorCatalogWorkRow = typeof authorCatalogWorks.$inferSelect;
export type NewAuthorCatalogWorkRow = typeof authorCatalogWorks.$inferInsert;
export type MonitoredAuthorWorkRow = typeof monitoredAuthorWorks.$inferSelect;
export type MonitoredBookRow = typeof monitoredBooks.$inferSelect;
export type NewMonitoredBookRow = typeof monitoredBooks.$inferInsert;
