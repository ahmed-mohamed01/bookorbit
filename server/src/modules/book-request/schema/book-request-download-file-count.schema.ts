import { integer, pgTable } from 'drizzle-orm/pg-core';

export const bookRequestDownloadFileCount = pgTable('book_request_downloads', {
  id: integer('id').primaryKey(),
  contentFileCount: integer('content_file_count'),
});
