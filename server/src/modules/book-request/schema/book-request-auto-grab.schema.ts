import { boolean, integer, pgTable } from 'drizzle-orm/pg-core';

// This second pgTable holds only the fork-owned column on the physical book_requests table, letting Drizzle render "book_requests"."auto_grab" beside the upstream table without a join or an upstream schema edit.
export const bookRequestAutoGrab = pgTable('book_requests', {
  id: integer('id').primaryKey(),
  autoGrab: boolean('auto_grab'),
});
