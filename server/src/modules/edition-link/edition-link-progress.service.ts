import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import { audiobookProgress, books, readingProgress } from '../../db/schema';
import type { ExtraProgress, ExtraProgressSource } from '../book/extra-progress-source';

type Db = NodePgDatabase<typeof schema>;

// Cross-format display progress for LINKED pairs: each side of a link surfaces the counterpart's
// progress, so both cards stay live while only one format is being read. The ebook's reading_progress
// row is deliberately never written by the alignment sync (it would clobber the precise CFI and defeat
// the open-time resolver's newest-wins check), so the merge happens at card-read time instead.
@Injectable()
export class EditionLinkProgressService implements ExtraProgressSource {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findProgressForBooks(userId: number, bookIds: number[]): Promise<Map<number, ExtraProgress>> {
    if (bookIds.length === 0) return new Map();

    const result = await this.db.execute<{ bookId: number; percentage: number; at: Date }>(sql`
      select bel.text_book_id as "bookId", ab.percentage as "percentage", ab.updated_at as "at"
      from book_edition_links bel
      join ${audiobookProgress} ab on ab.book_id = bel.audio_book_id and ab.user_id = ${userId}
      where bel.text_book_id in ${bookIds}
      union all
      select bel.audio_book_id as "bookId", rp.percentage as "percentage", rp.last_read_at as "at"
      from book_edition_links bel
      join ${books} tb on tb.id = bel.text_book_id
      join ${readingProgress} rp on rp.book_file_id = tb.primary_file_id and rp.user_id = ${userId}
      where bel.audio_book_id in ${bookIds}
    `);

    // Raw execute() bypasses drizzle's column mapping, so timestamps arrive as strings: normalize to
    // Date here or the newest-wins comparison against real Date columns silently coerces to NaN.
    return new Map(result.rows.map((row) => [row.bookId, { percentage: row.percentage, updatedAt: new Date(row.at) }]));
  }
}
