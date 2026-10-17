import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, ilike, inArray, isNotNull, isNull, or, type SQL, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { ContentFilterRules, EditionLinkCandidate, EditionLinkCounterpartSummary } from '@bookorbit/types';
import { AUDIO_FORMAT_LIST, isAudioFormat } from '@bookorbit/types';
import { buildContentFilterClauses } from '../../common/utils/content-filter-sql.utils';
import { isUniqueViolation } from '../../common/utils/db-error.utils';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { audiobookProgress, authors, bookAuthors, bookFiles, bookMetadata, books, readingProgress } from '../../db/schema';
import { normalizeName, scoreAuthors, scoreTitle, titleVolumeConflict } from '../../common/utils/fuzzy-match.utils';
import { seriesVolumeConflict } from '../../common/utils/series-volume.utils';
import { applySchemaStatements, findMissingTables } from '../../common/utils/schema-bootstrap.utils';
import { bookEditionLinks, type BookEditionLink } from './schema/edition-link.schema';

type Db = NodePgDatabase<typeof schema>;

const TEXT_FORMATS = new Set(['epub', 'kepub']);
const CANDIDATE_FETCH_LIMIT = 100;
const CANDIDATE_RESULT_LIMIT = 25;

export type BookModality = 'text' | 'audio' | 'both' | 'none';

export interface FindCounterpartCandidatesOptions {
  bookId: number;
  modality: 'text' | 'audio';
  accessibleLibraryIds: number[];
  contentFilters?: ContentFilterRules;
  query?: string;
}

export interface EditionLinkMemberIds {
  textBookId: number | null;
  audioBookId: number;
  readAlongBookId: number | null;
}

export interface ReadingPercentageTarget {
  bookId: number;
  /** Audiobooks keep book-level progress; every other book reads its primary file's row. */
  audio: boolean;
}

export interface EditionLinkMemberProgressRow {
  percentage: number;
  updatedAt: Date;
}

export interface EditionLinkMemberProgressRows {
  text: EditionLinkMemberProgressRow | null;
  audio: EditionLinkMemberProgressRow | null;
  readAlong: EditionLinkMemberProgressRow | null;
  readAlongNarrationPercentage: number | null;
}

@Injectable()
export class EditionLinkRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findMissingTables(tableNames: readonly string[]): Promise<string[]> {
    return findMissingTables(this.db, tableNames);
  }

  async applySchemaStatements(statements: readonly string[]): Promise<void> {
    return applySchemaStatements(this.db, statements);
  }

  async getBookModality(bookId: number): Promise<BookModality> {
    const rows = await this.db
      .select({ format: bookFiles.format })
      .from(bookFiles)
      .where(and(eq(bookFiles.bookId, bookId), eq(bookFiles.role, 'content')));

    let hasText = false;
    let hasAudio = false;
    for (const row of rows) {
      if (!row.format) continue;
      hasText ||= TEXT_FORMATS.has(row.format.toLowerCase());
      hasAudio ||= isAudioFormat(row.format);
    }

    if (hasText && hasAudio) return 'both';
    if (hasText) return 'text';
    if (hasAudio) return 'audio';
    return 'none';
  }

  // Single joined query for the display-only member summaries (title + first author), so the client
  // never has to fetch each member's full book detail just to render them. A book with no metadata row
  // is simply absent from the map (should not happen for a present book, but keeps this defensive).
  async findBookSummaries(bookIds: number[]): Promise<Map<number, EditionLinkCounterpartSummary>> {
    if (bookIds.length === 0) return new Map();

    const rows = await this.db
      .select({
        id: books.id,
        title: bookMetadata.title,
        coverUpdatedAt: bookMetadata.coverUpdatedAt,
        authorNames: sql<string[]>`coalesce(
          array_agg(${authors.name} ORDER BY ${bookAuthors.displayOrder}, ${authors.id})
            FILTER (WHERE ${authors.id} IS NOT NULL),
          ARRAY[]::varchar[]
        )`,
      })
      .from(books)
      .leftJoin(bookMetadata, eq(bookMetadata.bookId, books.id))
      .leftJoin(bookAuthors, eq(bookAuthors.bookId, books.id))
      .leftJoin(authors, eq(authors.id, bookAuthors.authorId))
      .where(inArray(books.id, bookIds))
      .groupBy(books.id, bookMetadata.title, bookMetadata.coverUpdatedAt);

    return new Map(
      rows.map((row) => [
        row.id,
        { id: row.id, title: row.title, authorName: row.authorNames[0] ?? null, coverVersion: row.coverUpdatedAt?.toISOString() ?? null },
      ]),
    );
  }

  async findBookSummary(bookId: number): Promise<EditionLinkCounterpartSummary | null> {
    const summaries = await this.findBookSummaries([bookId]);
    return summaries.get(bookId) ?? null;
  }

  async findLinkForBook(bookId: number): Promise<BookEditionLink | undefined> {
    const [row] = await this.db
      .select()
      .from(bookEditionLinks)
      .where(
        and(
          or(eq(bookEditionLinks.textBookId, bookId), eq(bookEditionLinks.audioBookId, bookId), eq(bookEditionLinks.readAlongBookId, bookId)),
          or(isNotNull(bookEditionLinks.textBookId), isNotNull(bookEditionLinks.readAlongBookId)),
        ),
      )
      .limit(1);
    return row;
  }

  async findReadAlongBookIdsByAudioBookIds(audioBookIds: number[]): Promise<Map<number, number>> {
    if (audioBookIds.length === 0) return new Map();
    const rows = await this.db
      .select({ audioBookId: bookEditionLinks.audioBookId, readAlongBookId: bookEditionLinks.readAlongBookId })
      .from(bookEditionLinks)
      .where(and(inArray(bookEditionLinks.audioBookId, audioBookIds), isNotNull(bookEditionLinks.readAlongBookId)));
    return new Map(rows.flatMap((row) => (row.readAlongBookId === null ? [] : [[row.audioBookId, row.readAlongBookId] as const])));
  }

  // Per-member reading progress for the link popover. Text and read-along read the book's primary
  // file row in `reading_progress`; the audiobook keeps its own book-level `audiobook_progress` row.
  async findMemberProgress(userId: number, ids: EditionLinkMemberIds): Promise<EditionLinkMemberProgressRows> {
    const fileBookIds = [ids.textBookId, ids.readAlongBookId].filter((id): id is number => id !== null);

    const [fileRows, audioRows] = await Promise.all([
      this.findFileProgressRows(userId, fileBookIds),
      this.db
        .select({ percentage: audiobookProgress.percentage, updatedAt: audiobookProgress.updatedAt })
        .from(audiobookProgress)
        .where(and(eq(audiobookProgress.bookId, ids.audioBookId), eq(audiobookProgress.userId, userId)))
        .limit(1),
    ]);

    const byBookId = new Map(fileRows.map((row) => [row.bookId, row]));
    const textRow = ids.textBookId === null ? undefined : byBookId.get(ids.textBookId);
    const readAlongRow = ids.readAlongBookId === null ? undefined : byBookId.get(ids.readAlongBookId);
    const audioRow = audioRows[0];

    return {
      text: textRow ? { percentage: textRow.percentage, updatedAt: textRow.lastReadAt } : null,
      audio: audioRow ? { percentage: audioRow.percentage, updatedAt: audioRow.updatedAt } : null,
      readAlong: readAlongRow ? { percentage: readAlongRow.percentage, updatedAt: readAlongRow.lastReadAt } : null,
      readAlongNarrationPercentage: readAlongRow?.narrationPercentage ?? null,
    };
  }

  async findReadingPercentages(userId: number, targets: readonly ReadingPercentageTarget[]): Promise<Map<number, number>> {
    if (targets.length === 0) return new Map();
    const rows = await this.db
      .select({ bookId: books.id, filePercentage: readingProgress.percentage, audioPercentage: audiobookProgress.percentage })
      .from(books)
      .leftJoin(readingProgress, and(eq(readingProgress.bookFileId, books.primaryFileId), eq(readingProgress.userId, userId)))
      .leftJoin(audiobookProgress, and(eq(audiobookProgress.bookId, books.id), eq(audiobookProgress.userId, userId)))
      .where(
        inArray(
          books.id,
          targets.map((target) => target.bookId),
        ),
      );
    const audioIds = new Set(targets.filter((target) => target.audio).map((target) => target.bookId));
    const percentages = new Map<number, number>();
    for (const row of rows) {
      const percentage = audioIds.has(row.bookId) ? row.audioPercentage : row.filePercentage;
      if (percentage !== null) percentages.set(row.bookId, percentage);
    }
    return percentages;
  }

  private async findFileProgressRows(userId: number, bookIds: number[]) {
    if (bookIds.length === 0) return [];
    return this.db
      .select({
        bookId: books.id,
        percentage: readingProgress.percentage,
        lastReadAt: readingProgress.lastReadAt,
        narrationPercentage: readingProgress.narrationPercentage,
      })
      .from(books)
      .innerJoin(readingProgress, and(eq(readingProgress.bookFileId, books.primaryFileId), eq(readingProgress.userId, userId)))
      .where(inArray(books.id, bookIds));
  }

  // A row left holding the audiobook alone (its read-along hard-deleted through the SET NULL FK) is
  // invisible to findLinkForBook, so the audiobook reads as unlinked: the insert claims that row
  // instead of conflicting on it. A conflict on any other row, or on a text or read-along member,
  // reads as nothing inserted.
  async insertLink(
    textBookId: number | null,
    audioBookId: number,
    createdBy: number,
    readAlongBookId: number | null = null,
  ): Promise<BookEditionLink | undefined> {
    try {
      const [row] = await this.db
        .insert(bookEditionLinks)
        .values({ textBookId, audioBookId, createdBy, readAlongBookId })
        .onConflictDoUpdate({
          target: bookEditionLinks.audioBookId,
          set: { textBookId, readAlongBookId, createdBy, createdAt: sql`now()` },
          setWhere: and(isNull(bookEditionLinks.textBookId), isNull(bookEditionLinks.readAlongBookId)),
        })
        .returning();
      return row;
    } catch (err) {
      if (isUniqueViolation(err)) return undefined;
      throw err;
    }
  }

  // Compare-and-set on the text side, like setReadAlongBook: a caller acting on a stale read must not
  // overwrite a text member set or cleared in between. A book that is already another link's text
  // member trips the unique constraint, which reads as "nothing updated". Clearing it drops a row that
  // is then left holding the audiobook alone.
  async setTextBook(linkId: number, textBookId: number | null, expected: number | null = null): Promise<BookEditionLink | undefined> {
    const where = and(
      eq(bookEditionLinks.id, linkId),
      expected === null ? isNull(bookEditionLinks.textBookId) : eq(bookEditionLinks.textBookId, expected),
    );
    if (textBookId === null) return this.clearMember({ textBookId: null }, where);
    try {
      const [row] = await this.db.update(bookEditionLinks).set({ textBookId }).where(where).returning();
      return row;
    } catch (err) {
      if (isUniqueViolation(err)) return undefined;
      throw err;
    }
  }

  // Returns undefined when nothing was updated: the link is gone, the link already names another
  // read-along, or the book is already the text or audio member of SOME link - this one or another. A
  // row-scoped predicate would only catch the member case for this row, so that exclusion is a
  // subquery over the whole table. Attaching is a compare-and-set: a caller acting on a stale read
  // must not overwrite a detach or another read-along made in between, so only an empty slot, the
  // same book (a rebuild replaced in place) or the `replacing` book it read is taken over. A book that
  // is already another link's read-along member is rejected by the partial unique index as a 23505
  // instead, which the caller maps to its own error. A detach is a compare-and-set too: it clears
  // only while the slot still names the `expected` book the caller read.
  async setReadAlongBook(linkId: number, bookId: number | null, expected: number | null = null): Promise<BookEditionLink | undefined> {
    const attachable =
      bookId === null
        ? undefined
        : and(
            or(
              isNull(bookEditionLinks.readAlongBookId),
              eq(bookEditionLinks.readAlongBookId, bookId),
              expected === null ? undefined : eq(bookEditionLinks.readAlongBookId, expected),
            ),
            sql`NOT EXISTS (
              SELECT 1 FROM book_edition_links member_link
              WHERE member_link.text_book_id = ${bookId}
                 OR member_link.audio_book_id = ${bookId}
            )`,
          );
    if (bookId === null) {
      const current = expected === null ? isNull(bookEditionLinks.readAlongBookId) : eq(bookEditionLinks.readAlongBookId, expected);
      return this.clearMember({ readAlongBookId: null }, and(eq(bookEditionLinks.id, linkId), current));
    }
    const [row] = await this.db
      .update(bookEditionLinks)
      .set({ readAlongBookId: bookId })
      .where(and(eq(bookEditionLinks.id, linkId), attachable))
      .returning();
    return row;
  }

  // The clear and the delete share one transaction so no audio-only row is ever committed. The
  // update's row lock serializes a concurrent clear of the other optional member: whichever runs
  // second sees both sides empty and drops the row. Returns the cleared row, deleted or not.
  private async clearMember(set: { textBookId: null } | { readAlongBookId: null }, where: SQL | undefined): Promise<BookEditionLink | undefined> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(bookEditionLinks).set(set).where(where).returning();
      if (row && row.textBookId === null && row.readAlongBookId === null) {
        await tx.delete(bookEditionLinks).where(eq(bookEditionLinks.id, row.id));
      }
      return row;
    });
  }

  // Keyed by the resolved link id, never by a member book: an OR across the three member columns
  // would delete every link a book belongs to while reporting only the first row back.
  async deleteLink(linkId: number): Promise<BookEditionLink | undefined> {
    const [row] = await this.db.delete(bookEditionLinks).where(eq(bookEditionLinks.id, linkId)).returning();
    return row;
  }

  async findCounterpartCandidates(options: FindCounterpartCandidatesOptions): Promise<EditionLinkCandidate[]> {
    if (options.accessibleLibraryIds.length === 0) return [];

    const [source] = await this.db
      .select({ title: bookMetadata.title, seriesName: bookMetadata.seriesName, seriesIndex: bookMetadata.seriesIndex })
      .from(bookMetadata)
      .where(eq(bookMetadata.bookId, options.bookId))
      .limit(1);
    const sourceAuthors = await this.db
      .select({ name: authors.name })
      .from(bookAuthors)
      .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
      .where(eq(bookAuthors.bookId, options.bookId))
      .orderBy(bookAuthors.displayOrder);

    const query = options.query?.trim() || undefined;
    if (!query && !source?.title?.trim()) return [];

    const contentFilters = options.contentFilters ? buildContentFilterClauses(options.contentFilters, this.db) : [];
    const audioFormats = sql.join(
      AUDIO_FORMAT_LIST.map((format) => sql`${format}`),
      sql`, `,
    );
    const requiredModality =
      options.modality === 'text'
        ? sql`EXISTS (
            SELECT 1 FROM book_files candidate_file
            WHERE candidate_file.book_id = ${books.id}
              AND candidate_file.role = 'content'
              AND lower(coalesce(candidate_file.format, '')) IN (${audioFormats})
          )
          AND NOT EXISTS (
            SELECT 1 FROM book_files candidate_file
            WHERE candidate_file.book_id = ${books.id}
              AND candidate_file.role = 'content'
              AND lower(coalesce(candidate_file.format, '')) IN ('epub', 'kepub')
          )`
        : sql`EXISTS (
            SELECT 1 FROM book_files candidate_file
            WHERE candidate_file.book_id = ${books.id}
              AND candidate_file.role = 'content'
              AND lower(coalesce(candidate_file.format, '')) IN ('epub', 'kepub')
          )
          AND NOT EXISTS (
            SELECT 1 FROM book_files candidate_file
            WHERE candidate_file.book_id = ${books.id}
              AND candidate_file.role = 'content'
              AND lower(coalesce(candidate_file.format, '')) IN (${audioFormats})
          )`;
    // An audiobook linked to a read-along alone is still open to an ebook: link() fills that row's text side.
    const notLinked = sql`NOT EXISTS (
      SELECT 1 FROM book_edition_links existing_link
      WHERE existing_link.text_book_id = ${books.id}
         OR (existing_link.audio_book_id = ${books.id} AND existing_link.text_book_id IS NOT NULL)
         OR existing_link.read_along_book_id = ${books.id}
    )`;
    const matchFilter = query
      ? or(
          ilike(bookMetadata.title, `%${query}%`),
          sql`EXISTS (
            SELECT 1
            FROM book_authors search_ba
            JOIN authors search_author ON search_author.id = search_ba.author_id
            WHERE search_ba.book_id = ${books.id}
              AND search_author.name ILIKE ${`%${query}%`}
          )`,
        )
      : sql`similarity(
          public.bookorbit_unaccent(coalesce(${bookMetadata.title}, '')),
          public.bookorbit_unaccent(${source!.title!})
        ) >= 0.15`;
    const orderTerm = query ?? source!.title!;

    const rows = await this.db
      .select({
        bookId: books.id,
        title: bookMetadata.title,
        seriesName: bookMetadata.seriesName,
        seriesIndex: bookMetadata.seriesIndex,
        coverUpdatedAt: bookMetadata.coverUpdatedAt,
        authorNames: sql<string[]>`coalesce(
          array_agg(${authors.name} ORDER BY ${bookAuthors.displayOrder}, ${authors.id})
            FILTER (WHERE ${authors.id} IS NOT NULL),
          ARRAY[]::varchar[]
        )`,
      })
      .from(books)
      .innerJoin(bookMetadata, eq(bookMetadata.bookId, books.id))
      .leftJoin(bookAuthors, eq(bookAuthors.bookId, books.id))
      .leftJoin(authors, eq(authors.id, bookAuthors.authorId))
      .where(
        and(
          inArray(books.libraryId, options.accessibleLibraryIds),
          eq(books.status, 'present'),
          sql`${books.id} <> ${options.bookId}`,
          requiredModality,
          notLinked,
          matchFilter,
          ...contentFilters,
        ),
      )
      .groupBy(books.id, bookMetadata.title, bookMetadata.seriesName, bookMetadata.seriesIndex, bookMetadata.coverUpdatedAt)
      .orderBy(
        desc(
          sql`similarity(
            public.bookorbit_unaccent(coalesce(${bookMetadata.title}, '')),
            public.bookorbit_unaccent(${orderTerm})
          )`,
        ),
        books.id,
      )
      .limit(CANDIDATE_FETCH_LIMIT);

    const sourceAuthorNames = sourceAuthors.map((row) => row.name);
    const normalizedQuery = query ? normalizeName(query) : null;
    // Sibling volumes share the author and differ by a digit, so edit distance puts "Series 13" and
    // "Series 11" in the high nineties - and spelled-out volumes ("Book Seven", "Book Three") or a bare
    // first book against its numbered sequels score near 100. A typed search is exempt: the reader may
    // want any volume.
    const sourcePlaced = { title: source?.title ?? '', seriesName: source?.seriesName ?? null, seriesIndex: source?.seriesIndex ?? null };
    const scoreSourceTitle = (row: { title: string | null; seriesName: string | null; seriesIndex: string | null }) => {
      const candidate = { title: row.title ?? '', seriesName: row.seriesName, seriesIndex: row.seriesIndex };
      const otherVolume = titleVolumeConflict(sourcePlaced.title, candidate.title) || seriesVolumeConflict(sourcePlaced, candidate);
      return otherVolume ? 0 : scoreTitle(sourcePlaced.title, candidate.title);
    };

    return rows
      .filter((row) => {
        if (normalizedQuery) {
          return [row.title, ...row.authorNames].some((value) => value && normalizeName(value).includes(normalizedQuery));
        }
        const titleScore = scoreSourceTitle(row);
        const authorScore = scoreAuthors(sourceAuthorNames, row.authorNames);
        return titleScore >= 0.8 && (sourceAuthorNames.length === 0 || row.authorNames.length === 0 ? titleScore >= 0.9 : authorScore >= 0.75);
      })
      .map((row) => {
        const titleScore = query ? scoreTitle(query, row.title ?? '') : scoreSourceTitle(row);
        const authorScore = query ? scoreAuthors([query], row.authorNames) : scoreAuthors(sourceAuthorNames, row.authorNames);
        const hasComparableAuthors = query ? row.authorNames.length > 0 : sourceAuthorNames.length > 0 && row.authorNames.length > 0;
        const score = query ? Math.max(titleScore, authorScore) : hasComparableAuthors ? titleScore * 0.7 + authorScore * 0.3 : titleScore;
        return {
          bookId: row.bookId,
          title: row.title,
          authorName: row.authorNames[0] ?? null,
          coverVersion: row.coverUpdatedAt?.toISOString() ?? null,
          score: Math.round(score * 100),
        };
      })
      .sort((left, right) => right.score - left.score || left.bookId - right.bookId)
      .slice(0, CANDIDATE_RESULT_LIMIT);
  }
}
