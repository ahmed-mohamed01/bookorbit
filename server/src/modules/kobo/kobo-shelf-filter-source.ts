import type { SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

export const KOBO_SHELF_FILTER_SOURCE = Symbol('KOBO_SHELF_FILTER_SOURCE');

export interface KoboShelfFilterSource {
  // An extra condition a book must meet to be put on the user's device, or undefined for none.
  shelfFilter(userId: number, bookId: PgColumn): Promise<SQL | undefined>;
}
