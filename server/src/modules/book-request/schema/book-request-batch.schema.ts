import { bigint, integer, pgTable, serial, text, timestamp, varchar } from 'drizzle-orm/pg-core';

// Holds only the fork-owned kind column on the physical book_requests table, so Drizzle can read and write it without an upstream schema edit.
export const bookRequestKind = pgTable('book_requests', {
  id: integer('id').primaryKey(),
  kind: varchar('kind', { length: 10 }).notNull().default('single'),
});

export const bookRequestBatchUnits = pgTable('book_request_batch_units', {
  id: serial('id').primaryKey(),
  requestId: integer('request_id').notNull(),
  unitIndex: integer('unit_index').notNull(),
  title: varchar('title', { length: 500 }),
  primaryPath: text('primary_path').notNull(),
  filePaths: text('file_paths').array().notNull(),
  mediaKind: varchar('media_kind', { length: 10 }).notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  fileSizes: bigint('file_sizes', { mode: 'number' }).array(),
  status: varchar('status', { length: 10 }).notNull().default('waiting'),
  bookDockFileId: integer('book_dock_file_id'),
  bookId: integer('book_id'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdateFn(() => new Date()),
});

export type BatchUnitRow = typeof bookRequestBatchUnits.$inferSelect;
export type NewBatchUnitRow = typeof bookRequestBatchUnits.$inferInsert;
