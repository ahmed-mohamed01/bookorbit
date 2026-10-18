import { sql } from 'drizzle-orm';
import { check, integer, pgTable, primaryKey, timestamp, varchar } from 'drizzle-orm/pg-core';

import { books } from '../../../db/schema/books';

export const bookCoverPlaceholders = pgTable(
  'book_cover_placeholders',
  {
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    medium: varchar('medium', { length: 5 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.bookId, table.medium] }),
    check('book_cover_placeholders_medium_check', sql`${table.medium} in ('ebook', 'audio')`),
  ],
);
