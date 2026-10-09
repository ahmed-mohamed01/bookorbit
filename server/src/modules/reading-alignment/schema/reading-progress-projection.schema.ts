import { integer, pgTable, primaryKey, real, timestamp, varchar } from 'drizzle-orm/pg-core';

// This second pgTable maps the physical reading_progress table for the live ebook projection only. It carries the fork-owned alignment_projected_at column without an upstream schema edit, and it declares no $onUpdateFn on any column, so a projection write leaves updated_at and last_read_at alone unless it sets them explicitly. Those two columns must keep meaning real reading activity.
export const readingProgressProjection = pgTable(
  'reading_progress',
  {
    bookFileId: integer('book_file_id').notNull(),
    userId: integer('user_id').notNull(),
    percentage: real('percentage').notNull(),
    cfi: varchar('cfi', { length: 2000 }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull(),
    alignmentProjectedAt: timestamp('alignment_projected_at', { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.bookFileId, table.userId] })],
);
