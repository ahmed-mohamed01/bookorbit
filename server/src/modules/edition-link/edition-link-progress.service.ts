import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNotNull, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import { audiobookProgress, books, readingProgress } from '../../db/schema';
import type { ExtraProgress, ExtraProgressSource } from '../book/extra-progress-source';
import type { ReadAlongLink, ReadAlongLinkSource } from '../book/read-along-link-source';
import type { ReadingSessionScopeMember, ReadingSessionScopeSource } from '../reading-session/reading-session-scope-source';
import { bookEditionLinks } from './schema/edition-link.schema';

type Db = NodePgDatabase<typeof schema>;

// Cross-format display progress for LINKED pairs: each side of a link surfaces the counterpart's
// progress, so both cards stay live while only one format is being read. The ebook's reading_progress
// row is deliberately never written by the alignment sync (it would clobber the precise CFI and defeat
// the open-time resolver's newest-wins check), so the merge happens at card-read time instead.
@Injectable()
export class EditionLinkProgressService implements ExtraProgressSource, ReadAlongLinkSource, ReadingSessionScopeSource {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findReadAlongLink(bookId: number): Promise<ReadAlongLink | null> {
    const [row] = await this.db
      .select({ audioBookId: bookEditionLinks.audioBookId, readAlongBookId: bookEditionLinks.readAlongBookId })
      .from(bookEditionLinks)
      .where(
        and(isNotNull(bookEditionLinks.readAlongBookId), or(eq(bookEditionLinks.audioBookId, bookId), eq(bookEditionLinks.readAlongBookId, bookId))),
      )
      .limit(1);
    return row?.readAlongBookId != null ? { audioBookId: row.audioBookId, readAlongBookId: row.readAlongBookId } : null;
  }

  async resolveScope(bookId: number): Promise<ReadingSessionScopeMember[] | null> {
    const [row] = await this.db
      .select({
        textBookId: bookEditionLinks.textBookId,
        audioBookId: bookEditionLinks.audioBookId,
        readAlongBookId: bookEditionLinks.readAlongBookId,
      })
      .from(bookEditionLinks)
      .where(or(eq(bookEditionLinks.textBookId, bookId), eq(bookEditionLinks.audioBookId, bookId), eq(bookEditionLinks.readAlongBookId, bookId)))
      .limit(1);
    if (!row) return null;

    const members: ReadingSessionScopeMember[] = [
      { bookId: row.textBookId, role: 'text' },
      { bookId: row.audioBookId, role: 'audio' },
    ];
    if (row.readAlongBookId != null) members.push({ bookId: row.readAlongBookId, role: 'readAlong' });
    return members;
  }

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
