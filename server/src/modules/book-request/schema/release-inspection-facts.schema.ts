import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const releaseInspectionFacts = pgTable('release_inspection_facts', {
  infoHash: text('info_hash').primaryKey(),
  fileCount: integer('file_count').notNull(),
  unitCount: integer('unit_count'),
  primaryFileCount: integer('primary_file_count').notNull(),
  formats: text('formats').array().notNull().default([]),
  inspectedAt: timestamp('inspected_at', { withTimezone: true }).notNull().defaultNow(),
});
