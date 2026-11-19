import { Inject, Injectable } from '@nestjs/common';
import type { CoverMedium } from '@bookorbit/types';
import { and, asc, isNull, sql, type SQL } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import { bookCovers } from '../../db/schema';
import { bookCoverPlaceholders } from '../book-cover-store/schema/book-cover-placeholder.schema';

type Db = NodePgDatabase<typeof schema>;

export type ThumbnailBackfillCursor = { bookId: number; medium: CoverMedium };

@Injectable()
export class CoverThumbnailBackfillRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async countServedSlots(): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(bookCovers)
      .where(and(isNull(bookCovers.dormantSince), this.notPlaceholder()));
    return row?.count ?? 0;
  }

  /** Served slots (not dormant, not a placeholder) after the cursor, in primary-key order. */
  async servedSlotsAfter(cursor: ThumbnailBackfillCursor | null, limit: number): Promise<ThumbnailBackfillCursor[]> {
    const rows = await this.db
      .select({ bookId: bookCovers.bookId, medium: bookCovers.medium })
      .from(bookCovers)
      .where(
        and(
          isNull(bookCovers.dormantSince),
          this.notPlaceholder(),
          cursor ? sql`(${bookCovers.bookId}, ${bookCovers.medium}) > (${cursor.bookId}, ${cursor.medium})` : undefined,
        ),
      )
      .orderBy(asc(bookCovers.bookId), asc(bookCovers.medium))
      .limit(limit);
    return rows.map((row) => ({ bookId: row.bookId, medium: row.medium as CoverMedium }));
  }

  private notPlaceholder(): SQL {
    return sql`not exists (select 1 from ${bookCoverPlaceholders} where ${bookCoverPlaceholders.bookId} = "book_covers"."book_id" and ${bookCoverPlaceholders.medium} = "book_covers"."medium")`;
  }
}
