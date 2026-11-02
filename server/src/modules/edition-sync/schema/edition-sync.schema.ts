import type {
  EditionSyncBookSyncMode,
  EditionSyncFilesChangedMode,
  EditionSyncProvenance,
  EditionSyncRunStopReason,
  EditionSyncRunTrigger,
  EditionSyncStoredIndexStatus,
  ReadAloudJobReport,
} from '@bookorbit/types';
import {
  bigint,
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  smallint,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

// Module-local table declarations for the fork tables created by EDITION_SYNC_SCHEMA_SQL. They are
// not in the db/schema barrel, so drizzle-kit never sees them; query them with db.select(), not
// db.query.<table>. Constraints and indexes live in the bootstrap SQL only.

export const editionSyncUserSettings = pgTable('edition_sync_user_settings', {
  userId: integer('user_id').primaryKey(),
  enabled: boolean('enabled').notNull().default(true),
  bookSyncMode: varchar('book_sync_mode', { length: 20 }).$type<EditionSyncBookSyncMode>().notNull().default('all_eligible'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const editionSyncBookOverrides = pgTable(
  'edition_sync_book_overrides',
  {
    userId: integer('user_id').notNull(),
    bookId: integer('book_id').notNull(),
    syncOverride: varchar('sync_override', { length: 10 }).$type<'included' | 'excluded'>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'edition_sync_book_overrides_pk', columns: [t.userId, t.bookId] })],
);

export const editionSyncBookIndex = pgTable('edition_sync_book_index', {
  bookId: integer('book_id').primaryKey(),
  status: varchar('status', { length: 10 }).$type<EditionSyncStoredIndexStatus>().notNull(),
  workerJobId: uuid('worker_job_id'),
  stage: varchar('stage', { length: 30 }),
  progress: smallint('progress'),
  indexFileId: integer('index_file_id'),
  indexPath: text('index_path'),
  indexBytes: bigint('index_bytes', { mode: 'number' }),
  provenance: jsonb('provenance').$type<EditionSyncProvenance>(),
  report: jsonb('report').$type<ReadAloudJobReport>(),
  workerVersion: varchar('worker_version', { length: 100 }),
  indexedAt: timestamp('indexed_at', { withTimezone: true }),
  filesChangedAt: timestamp('files_changed_at', { withTimezone: true }),
  invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
  invalidatedReason: varchar('invalidated_reason', { length: 50 }),
  errorCode: varchar('error_code', { length: 50 }),
  lastError: varchar('last_error', { length: 2000 }),
  failedAt: timestamp('failed_at', { withTimezone: true }),
  attemptCount: integer('attempt_count').notNull().default(0),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  retryRequested: boolean('retry_requested').notNull().default(false),
  pinnedAt: timestamp('pinned_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdateFn(() => new Date()),
});

export const editionSyncSettings = pgTable('edition_sync_settings', {
  id: smallint('id').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  cronExpression: varchar('cron_expression', { length: 100 }),
  onFilesChanged: varchar('on_files_changed', { length: 10 }).$type<EditionSyncFilesChangedMode>().notNull().default('next_run'),
  runHours: smallint('run_hours').notNull().default(8),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedByUserId: integer('updated_by_user_id'),
});

export const editionSyncRuns = pgTable('edition_sync_runs', {
  id: serial('id').primaryKey(),
  trigger: varchar('trigger', { length: 10 }).$type<EditionSyncRunTrigger>().notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  windowUntil: timestamp('window_until', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  booksIndexed: integer('books_indexed').notNull().default(0),
  booksFailed: integer('books_failed').notNull().default(0),
  secondsIndexed: doublePrecision('seconds_indexed').notNull().default(0),
  stopReason: varchar('stop_reason', { length: 30 }).$type<EditionSyncRunStopReason>(),
});

export type EditionSyncUserSettingsRow = typeof editionSyncUserSettings.$inferSelect;
export type EditionSyncBookOverrideRow = typeof editionSyncBookOverrides.$inferSelect;
export type EditionSyncBookIndexRow = typeof editionSyncBookIndex.$inferSelect;
export type NewEditionSyncBookIndexRow = typeof editionSyncBookIndex.$inferInsert;
export type EditionSyncSettingsRow = typeof editionSyncSettings.$inferSelect;
export type EditionSyncRunRow = typeof editionSyncRuns.$inferSelect;
