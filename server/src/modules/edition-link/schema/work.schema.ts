import type { EditionLinkMatchBucket, WorkPositionSync, WorkVariantRole } from '@bookorbit/types';
import { sql } from 'drizzle-orm';
import { boolean, index, integer, pgTable, primaryKey, real, serial, text, timestamp, unique, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

import { users } from '../../../db/schema/auth';
import { books } from '../../../db/schema/books';
import { bookEditionLinks } from './edition-link.schema';

export type EditionLinkScanRowState = 'running' | 'done' | 'failed';
export type EditionLinkMatchTargetRole = WorkVariantRole | 'duplicate';

export const bookEditionLinkMembers = pgTable(
  'book_edition_link_members',
  {
    id: serial('id').primaryKey(),
    linkId: integer('link_id')
      .notNull()
      .references(() => bookEditionLinks.id, { onDelete: 'cascade' }),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 16 }).$type<WorkVariantRole>().notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('book_edition_link_members_book_id_unique').on(table.bookId),
    index('book_edition_link_members_link_id_idx').on(table.linkId),
    uniqueIndex('book_edition_link_members_primary_unique')
      .on(table.linkId, table.role)
      .where(sql`${table.isPrimary}`),
  ],
);

export type BookEditionLinkMember = typeof bookEditionLinkMembers.$inferSelect;

export const editionLinkUserSettings = pgTable('edition_link_user_settings', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(true),
  shareReadingState: boolean('share_reading_state').notNull().default(true),
  sameTypeAsOneWork: boolean('same_type_as_one_work').notNull().default(true),
  positionSync: varchar('position_sync', { length: 10 }).$type<WorkPositionSync>().notNull().default('rough'),
  autoLinkStrong: boolean('auto_link_strong').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const editionLinkMatchScans = pgTable(
  'edition_link_match_scans',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    libraryId: integer('library_id'),
    state: varchar('state', { length: 16 }).$type<EditionLinkScanRowState>().notNull().default('running'),
    processed: integer('processed').notNull().default(0),
    total: integer('total').notNull().default(0),
    autoLinked: integer('auto_linked').notNull().default(0),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [index('edition_link_match_scans_user_started_idx').on(table.userId, sql`${table.startedAt} desc`)],
);

export type EditionLinkMatchScan = typeof editionLinkMatchScans.$inferSelect;

export const editionLinkMatchResults = pgTable(
  'edition_link_match_results',
  {
    id: serial('id').primaryKey(),
    scanId: integer('scan_id')
      .notNull()
      .references(() => editionLinkMatchScans.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sourceBookId: integer('source_book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    targetBookId: integer('target_book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    targetRole: varchar('target_role', { length: 16 }).$type<EditionLinkMatchTargetRole>().notNull(),
    bucket: varchar('bucket', { length: 20 }).$type<EditionLinkMatchBucket>().notNull(),
    score: real('score').notNull(),
    titleScore: real('title_score').notNull(),
    authorScore: real('author_score').notNull(),
    isbnMatch: boolean('isbn_match').notNull().default(false),
    reason: text('reason').notNull(),
    linkId: integer('link_id'),
    competingBookIds: integer('competing_book_ids')
      .array()
      .notNull()
      .default(sql`'{}'`),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('edition_link_match_results_scan_bucket_idx').on(table.scanId, table.bucket),
    index('edition_link_match_results_user_idx').on(table.userId),
  ],
);

export type EditionLinkMatchResult = typeof editionLinkMatchResults.$inferSelect;
export type NewEditionLinkMatchResult = typeof editionLinkMatchResults.$inferInsert;

export const editionLinkMatchDismissals = pgTable(
  'edition_link_match_dismissals',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bookIdA: integer('book_id_a')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    bookIdB: integer('book_id_b')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ name: 'edition_link_match_dismissals_pk', columns: [table.userId, table.bookIdA, table.bookIdB] })],
);
