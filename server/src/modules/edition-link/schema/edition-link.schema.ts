import { sql } from 'drizzle-orm';
import { integer, pgTable, serial, timestamp, unique, uniqueIndex } from 'drizzle-orm/pg-core';

import { users } from '../../../db/schema/auth';
import { books } from '../../../db/schema/books';

export const bookEditionLinks = pgTable(
  'book_edition_links',
  {
    id: serial('id').primaryKey(),
    textBookId: integer('text_book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    audioBookId: integer('audio_book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    // Optional third member: the generated read-along book. ON DELETE SET NULL so deleting the
    // generated output leaves the text/audio pair linked instead of dropping the whole row.
    readAlongBookId: integer('read_along_book_id').references(() => books.id, { onDelete: 'set null' }),
    // Informational only. Nullable + ON DELETE SET NULL so deleting the creator never blocks an
    // upstream user deletion (the link itself is keyed by the two books, not its creator).
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('book_edition_links_text_book_id_unique').on(table.textBookId),
    unique('book_edition_links_audio_book_id_unique').on(table.audioBookId),
    uniqueIndex('book_edition_links_read_along_book_id_unique')
      .on(table.readAlongBookId)
      .where(sql`${table.readAlongBookId} is not null`),
  ],
);

export type BookEditionLink = typeof bookEditionLinks.$inferSelect;
