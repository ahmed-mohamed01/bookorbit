import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { ContentFilterRules, EditionLinkCandidate } from '@bookorbit/types';
import { buildContentFilterClauses } from '../../common/utils/content-filter-sql.utils';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { authors, bookAuthors, bookFiles, bookMetadata, books } from '../../db/schema';
import { normalizeName, scoreAuthors, scoreTitle } from '../hardcover/hardcover-import.service';
import { AUDIO_FORMATS, isAudioFormat } from '../scanner/lib/classify';
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

@Injectable()
export class EditionLinkRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async applySchemaStatements(statements: readonly string[]): Promise<void> {
    for (const statement of statements) {
      await this.db.execute(sql.raw(statement));
    }
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

  async findLinkForBook(bookId: number): Promise<BookEditionLink | undefined> {
    const [row] = await this.db
      .select()
      .from(bookEditionLinks)
      .where(or(eq(bookEditionLinks.textBookId, bookId), eq(bookEditionLinks.audioBookId, bookId)))
      .limit(1);
    return row;
  }

  async insertLink(textBookId: number, audioBookId: number, createdBy: number): Promise<BookEditionLink | undefined> {
    const [row] = await this.db.insert(bookEditionLinks).values({ textBookId, audioBookId, createdBy }).onConflictDoNothing().returning();
    return row;
  }

  async deleteLinkForBook(bookId: number): Promise<BookEditionLink | undefined> {
    const [row] = await this.db
      .delete(bookEditionLinks)
      .where(or(eq(bookEditionLinks.textBookId, bookId), eq(bookEditionLinks.audioBookId, bookId)))
      .returning();
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
      [...AUDIO_FORMATS].map((format) => sql`${format}`),
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
      .groupBy(books.id, bookMetadata.title)
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
          score: Math.round(score * 100),
        };
      })
      .sort((left, right) => right.score - left.score || left.bookId - right.bookId)
      .slice(0, CANDIDATE_RESULT_LIMIT);
  }
}
