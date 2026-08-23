import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, pgTable, real, serial, text, timestamp, unique, varchar } from 'drizzle-orm/pg-core';

import { books } from '../../../db/schema/books';
import { users } from '../../../db/schema/auth';

export const audiobookshelfUserSettings = pgTable('audiobookshelf_user_settings', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' })
    .unique(),
  serverUrl: varchar('server_url', { length: 2048 }).notNull(),
  apiToken: varchar('api_token', { length: 2048 }).notNull(),
  enabled: boolean('enabled').notNull().default(true),
  syncStatus: boolean('sync_status').notNull().default(true),
  syncPosition: boolean('sync_position').notNull().default(true),
  syncSessions: boolean('sync_sessions').notNull().default(true),
  excludedLibraryIds: text('excluded_library_ids')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  lastSyncError: text('last_sync_error'),
  lastSessionWatermark: bigint('last_session_watermark', { mode: 'number' }),
  sessionBackfillCursorPage: integer('session_backfill_cursor_page'),
  sessionBackfillMaxUpdated: bigint('session_backfill_max_updated', { mode: 'number' }),
  initialReconcileCompletedAt: timestamp('initial_reconcile_completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdateFn(() => new Date()),
});

export const audiobookshelfBookState = pgTable(
  'audiobookshelf_book_state',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    absLibraryItemId: varchar('abs_library_item_id', { length: 255 }).notNull(),
    absTitle: varchar('abs_title', { length: 1000 }),
    absAuthorName: varchar('abs_author_name', { length: 1000 }),
    bookId: integer('book_id').references(() => books.id, { onDelete: 'cascade' }),
    matchMethod: varchar('match_method', { length: 20 }),
    matchConfidence: real('match_confidence'),
    needsReview: boolean('needs_review').notNull().default(false),
    matchError: text('match_error'),
    lastMatchAttemptAt: timestamp('last_match_attempt_at', { withTimezone: true }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastSyncedAbsUpdate: bigint('last_synced_abs_update', { mode: 'number' }),
    lastSyncedPositionAbsUpdate: bigint('last_synced_position_abs_update', { mode: 'number' }),
    lastSyncedProgressAt: timestamp('last_synced_progress_at', { withTimezone: true }),
    syncError: text('sync_error'),
    syncExcluded: boolean('sync_excluded').notNull().default(false),
    manualUnlinked: boolean('manual_unlinked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    unique('audiobookshelf_book_state_user_item_uidx').on(t.userId, t.absLibraryItemId),
    index('audiobookshelf_book_state_user_book_idx').on(t.userId, t.bookId),
  ],
);

export type AudiobookshelfUserSetting = typeof audiobookshelfUserSettings.$inferSelect;
export type NewAudiobookshelfUserSetting = typeof audiobookshelfUserSettings.$inferInsert;
export type AudiobookshelfBookState = typeof audiobookshelfBookState.$inferSelect;
export type NewAudiobookshelfBookState = typeof audiobookshelfBookState.$inferInsert;
