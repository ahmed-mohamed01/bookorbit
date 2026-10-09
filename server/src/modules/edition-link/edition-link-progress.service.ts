import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, max, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import { audiobookProgress, books, readingProgress, readingSessions } from '../../db/schema';
import type { ExtraProgress, ExtraProgressSource } from '../book/extra-progress-source';
import type { ReadAlongLink, ReadAlongLinkSource } from '../book/read-along-link-source';
import type { CurrentlyReadingGroupMembership, CurrentlyReadingGroupSource } from '../dashboard/currently-reading-group-source';
import type { ReadingSessionScopeMember, ReadingSessionScopeSource } from '../reading-session/reading-session-scope-source';
import { bookEditionLinks } from './schema/edition-link.schema';

type Db = NodePgDatabase<typeof schema>;

// Cross-format display progress for LINKED pairs: each side of a link surfaces the counterpart's
// progress, so both cards stay live while only one format is being read. The ebook's reading_progress
// row is deliberately never written by the alignment sync (it would clobber the precise CFI and defeat
// the open-time resolver's newest-wins check), so the merge happens at card-read time instead.
@Injectable()
export class EditionLinkProgressService implements ExtraProgressSource, ReadAlongLinkSource, ReadingSessionScopeSource, CurrentlyReadingGroupSource {
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

  // Activity comes from reading_sessions, never progress rows: the alignment sync projects audio position onto the
  // ebook's reading_progress row, the ebook-to-audio projection stamps audiobook_progress.updated_at, and the
  // Audiobookshelf sync writes the read-along row. A session is only recorded by a reader or player, or ingested from
  // Audiobookshelf listening, so its latest ended_at is real activity.
  async findGroupsForBooks(userId: number, bookIds: number[]): Promise<Map<number, CurrentlyReadingGroupMembership>> {
    if (bookIds.length === 0) return new Map();

    const links = await this.db
      .select({
        id: bookEditionLinks.id,
        textBookId: bookEditionLinks.textBookId,
        audioBookId: bookEditionLinks.audioBookId,
        readAlongBookId: bookEditionLinks.readAlongBookId,
      })
      .from(bookEditionLinks)
      .where(
        or(
          inArray(bookEditionLinks.textBookId, bookIds),
          inArray(bookEditionLinks.audioBookId, bookIds),
          inArray(bookEditionLinks.readAlongBookId, bookIds),
        ),
      );

    const requested = new Set(bookIds);
    const groupByBook = new Map<number, number>();
    for (const link of links) {
      for (const memberId of [link.textBookId, link.audioBookId, link.readAlongBookId]) {
        if (memberId != null && requested.has(memberId)) groupByBook.set(memberId, link.id);
      }
    }
    if (groupByBook.size === 0) return new Map();

    const activity = await this.db
      .select({ bookId: readingSessions.bookId, lastEndedAt: max(readingSessions.endedAt) })
      .from(readingSessions)
      .where(and(eq(readingSessions.userId, userId), inArray(readingSessions.bookId, [...groupByBook.keys()])))
      .groupBy(readingSessions.bookId);
    const lastEndedByBook = new Map(activity.map((row) => [row.bookId, row.lastEndedAt]));

    return new Map([...groupByBook].map(([bookId, groupId]) => [bookId, { groupId, lastActivityAt: lastEndedByBook.get(bookId) ?? null }]));
  }
}
