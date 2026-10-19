import { boolean, integer, pgTable, timestamp } from 'drizzle-orm/pg-core';

// Fork-owned columns on the physical book_request_downloads table, kept out of the upstream schema file.
export const bookRequestDownloadExtension = pgTable('book_request_downloads', {
  id: integer('id').primaryKey(),
  filesPendingSince: timestamp('files_pending_since', { withTimezone: true }),
  extendsExisting: boolean('extends_existing'),
});
