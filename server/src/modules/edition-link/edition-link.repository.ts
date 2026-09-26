import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { ContentFilterRules, EditionLinkCandidate, EditionLinkCounterpartSummary } from '@bookorbit/types';
import { AUDIO_FORMAT_LIST, isAudioFormat } from '@bookorbit/types';
import { buildContentFilterClauses } from '../../common/utils/content-filter-sql.utils';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { audiobookProgress, authors, bookAuthors, bookFiles, bookMetadata, books, readingProgress } from '../../db/schema';
import { normalizeName, scoreAuthors, scoreTitle } from '../../common/utils/fuzzy-match.utils';
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
  textBookId: number;
  audioBookId: number;
  readAlongBookId: number | null;
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
      .where(or(eq(bookEditionLinks.textBookId, bookId), eq(bookEditionLinks.audioBookId, bookId), eq(bookEditionLinks.readAlongBookId, bookId)))
      .limit(1);
    return row;
  }

  // Per-member reading progress for the link popover. Text and read-along read the book's primary
  // file row in `reading_progress`; the audiobook keeps its own book-level `audiobook_progress` row.
  async findMemberProgress(userId: number, ids: EditionLinkMemberIds): Promise<EditionLinkMemberProgressRows> {
    const fileBookIds = ids.readAlongBookId === null ? [ids.textBookId] : [ids.textBookId, ids.readAlongBookId];

    const [fileRows, audioRows] = await Promise.all([
      this.db
        .select({
          bookId: books.id,
          percentage: readingProgress.percentage,
          lastReadAt: readingProgress.lastReadAt,
          narrationPercentage: readingProgress.narrationPercentage,
        })
        .from(books)
        .innerJoin(readingProgress, and(eq(readingProgress.bookFileId, books.primaryFileId), eq(readingProgress.userId, userId)))
        .where(inArray(books.id, fileBookIds)),
      this.db
        .select({ percentage: audiobookProgress.percentage, updatedAt: audiobookProgress.updatedAt })
        .from(audiobookProgress)
        .where(and(eq(audiobookProgress.bookId, ids.audioBookId), eq(audiobookProgress.userId, userId)))
        .limit(1),
    ]);

    const byBookId = new Map(fileRows.map((row) => [row.bookId, row]));
    const textRow = byBookId.get(ids.textBookId);
    const readAlongRow = ids.readAlongBookId === null ? undefined : byBookId.get(ids.readAlongBookId);
    const audioRow = audioRows[0];

    return {
      text: textRow ? { percentage: textRow.percentage, updatedAt: textRow.lastReadAt } : null,
      audio: audioRow ? { percentage: audioRow.percentage, updatedAt: audioRow.updatedAt } : null,
      readAlong: readAlongRow ? { percentage: readAlongRow.percentage, updatedAt: readAlongRow.lastReadAt } : null,
      readAlongNarrationPercentage: readAlongRow?.narrationPercentage ?? null,
    };
  }

  async insertLink(textBookId: number, audioBookId: number, createdBy: number): Promise<BookEditionLink | undefined> {
    const [row] = await this.db.insert(bookEditionLinks).values({ textBookId, audioBookId, createdBy }).onConflictDoNothing().returning();
    return row;
  }

  // Returns undefined when nothing was updated: either the link is gone, or the book is already the
  // text or audio member of SOME link - this one or another. A row-scoped predicate would only catch
  // the first case, so the exclusion is a subquery over the whole table. A book that is already
  // another link's read-along member is rejected by the partial unique index as a 23505 instead,
  // which the caller maps to its own error.
  async setReadAlongBook(linkId: number, bookId: number | null): Promise<BookEditionLink | undefined> {
    const notAlreadyAPairMember =
      bookId === null
        ? undefined
        : sql`NOT EXISTS (
            SELECT 1 FROM book_edition_links member_link
            WHERE member_link.text_book_id = ${bookId}
               OR member_link.audio_book_id = ${bookId}
          )`;
    const [row] = await this.db
      .update(bookEditionLinks)
      .set({ readAlongBookId: bookId })
      .where(and(eq(bookEditionLinks.id, linkId), notAlreadyAPairMember))
      .returning();
    return row;
  }

  // Keyed by the resolved link id, never by a member book: an OR across the three member columns
  // would delete every link a book belongs to while reporting only the first row back.
  async deleteLink(linkId: number): Promise<BookEditionLink | undefined> {
    const [row] = await this.db.delete(bookEditionLinks).where(eq(bookEditionLinks.id, linkId)).returning();
    return row;
  }

  async findCounterpartCandidates(options: FindCounterpartCandidatesOptions): Promise<EditionLinkCandidate[]> {
    if (options.accessibleLibraryIds.length === 0) return [];

    const [source] = await this.db.select({ title: bookMetadata.title }).from(bookMetadata).where(eq(bookMetadata.bookId, options.bookId)).limit(1);
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
    const notLinked = sql`NOT EXISTS (
      SELECT 1 FROM book_edition_links existing_link
      WHERE existing_link.text_book_id = ${books.id}
         OR existing_link.audio_book_id = ${books.id}
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
      .groupBy(books.id, bookMetadata.title, bookMetadata.coverUpdatedAt)
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

    return rows
      .filter((row) => {
        if (normalizedQuery) {
          return [row.title, ...row.authorNames].some((value) => value && normalizeName(value).includes(normalizedQuery));
        }
        const titleScore = scoreTitle(source!.title!, row.title ?? '');
        const authorScore = scoreAuthors(sourceAuthorNames, row.authorNames);
        return titleScore >= 0.8 && (sourceAuthorNames.length === 0 || row.authorNames.length === 0 ? titleScore >= 0.9 : authorScore >= 0.75);
      })
      .map((row) => {
        const titleScore = scoreTitle(query ?? source!.title!, row.title ?? '');
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
