import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, desc, eq, ilike, inArray, isNotNull, isNull, or, type SQL, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { ContentFilterRules, EditionLinkCandidate, EditionLinkCounterpartSummary } from '@bookorbit/types';
import { AUDIO_FORMAT_LIST, isAudioFormat, EBOOK_FORMAT_LIST } from '@bookorbit/types';
import { buildContentFilterClauses } from '../../common/utils/content-filter-sql.utils';
import { isUniqueViolation } from '../../common/utils/db-error.utils';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { audiobookProgress, authors, bookAuthors, bookFiles, bookMetadata, books, readingProgress } from '../../db/schema';
import { normalizeName, scoreAuthors, scoreTitle, titleVolumeConflict } from '../../common/utils/fuzzy-match.utils';
import { seriesVolumeConflict } from '../../common/utils/series-volume.utils';
import { applySchemaStatements, findMissingTables } from '../../common/utils/schema-bootstrap.utils';
import { bookEditionLinks, type BookEditionLink } from './schema/edition-link.schema';
import { bookEditionLinkMembers } from './schema/work.schema';
import { WorkScopeService } from './work-scope.service';

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

export interface FindMatchCandidatesOptions {
  bookId: number;
  /** The modality the candidates must have: the other one for counterparts, the same one for duplicates. */
  candidateModality: 'text' | 'audio';
  /** Duplicate search: every ebook format counts as text, not only the alignable EPUB and KEPUB. */
  anyTextFormat?: boolean;
  accessibleLibraryIds: number[];
  contentFilters?: ContentFilterRules;
}

export interface MatchCandidate {
  bookId: number;
  title: string | null;
  authorNames: string[];
  language: string | null;
  /** Combined score 0-1, the same weighting the link panel ranks with. */
  score: number;
  titleScore: number;
  authorScore: number;
}

interface CandidateSource {
  title: string;
  seriesName: string | null;
  seriesIndex: string | null;
  authorNames: string[];
}

interface CandidateRow {
  bookId: number;
  title: string | null;
  seriesName: string | null;
  seriesIndex: string | null;
  language: string | null;
  coverUpdatedAt: Date | null;
  authorNames: string[];
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
  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() private readonly workScope?: WorkScopeService,
  ) {}

  private changed<T>(result: T): T {
    this.workScope?.invalidate();
    return result;
  }

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
          or(
            eq(bookEditionLinks.textBookId, bookId),
            eq(bookEditionLinks.audioBookId, bookId),
            eq(bookEditionLinks.readAlongBookId, bookId),
            sql`${bookEditionLinks.id} IN (SELECT member.link_id FROM ${bookEditionLinkMembers} member WHERE member.book_id = ${bookId})`,
          ),
          or(
            isNotNull(bookEditionLinks.textBookId),
            isNotNull(bookEditionLinks.readAlongBookId),
            sql`EXISTS (SELECT 1 FROM ${bookEditionLinkMembers} duplicate WHERE duplicate.link_id = ${bookEditionLinks.id} AND NOT duplicate.is_primary)`,
          ),
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
    return new Map(
      rows.flatMap((row) => (row.readAlongBookId === null || row.audioBookId === null ? [] : [[row.audioBookId, row.readAlongBookId] as const])),
    );
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
      return this.changed(row);
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
      return this.changed(row);
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
    return this.changed(row);
  }

  // The clear and the delete share one transaction so no audio-only row is ever committed. The
  // update's row lock serializes a concurrent clear of the other optional member: whichever runs
  // second sees both sides empty and drops the row. Returns the cleared row, deleted or not.
  private async clearMember(set: { textBookId: null } | { readAlongBookId: null }, where: SQL | undefined): Promise<BookEditionLink | undefined> {
    const cleared = await this.db.transaction(async (tx) => {
      const [row] = await tx.update(bookEditionLinks).set(set).where(where).returning();
      if (row && row.textBookId === null && row.readAlongBookId === null) {
        await tx.delete(bookEditionLinks).where(eq(bookEditionLinks.id, row.id));
      }
      return row;
    });
    return this.changed(cleared);
  }

  // Keyed by the resolved link id, never by a member book: an OR across the three member columns
  // would delete every link a book belongs to while reporting only the first row back.
  async deleteLink(linkId: number): Promise<BookEditionLink | undefined> {
    const [row] = await this.db.delete(bookEditionLinks).where(eq(bookEditionLinks.id, linkId)).returning();
    return this.changed(row);
  }

  async findCounterpartCandidates(options: FindCounterpartCandidatesOptions): Promise<EditionLinkCandidate[]> {
    if (options.accessibleLibraryIds.length === 0) return [];

    const source = await this.findCandidateSource(options.bookId);
    const query = options.query?.trim() || undefined;
    if (!query && !source.title.trim()) return [];

    // An audiobook linked to a read-along alone is still open to an ebook: link() fills that row's text side.
    const notLinked = sql`NOT EXISTS (
      SELECT 1 FROM book_edition_links existing_link
      WHERE existing_link.text_book_id = ${books.id}
         OR (existing_link.audio_book_id = ${books.id} AND existing_link.text_book_id IS NOT NULL)
         OR existing_link.read_along_book_id = ${books.id}
    ) AND NOT EXISTS (
      SELECT 1 FROM ${bookEditionLinkMembers} existing_member
      WHERE existing_member.book_id = ${books.id} AND NOT existing_member.is_primary
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
      : undefined;
    const rows = await this.findCandidateRows({
      bookId: options.bookId,
      candidateModality: options.modality === 'text' ? 'audio' : 'text',
      accessibleLibraryIds: options.accessibleLibraryIds,
      contentFilters: options.contentFilters,
      orderTerm: query ?? source.title,
      extra: [notLinked, matchFilter],
      similarityTo: query ? undefined : source.title,
    });

    const normalizedQuery = query ? normalizeName(query) : null;
    const scored = rows.flatMap((row) => {
      if (normalizedQuery) {
        if (![row.title, ...row.authorNames].some((value) => value && normalizeName(value).includes(normalizedQuery))) return [];
        const titleScore = scoreTitle(query!, row.title ?? '');
        const authorScore = scoreAuthors([query!], row.authorNames);
        return [{ row, score: Math.max(titleScore, authorScore) }];
      }
      const match = scoreCandidate(source, row);
      return match ? [{ row, score: match.score }] : [];
    });

    return scored
      .map(({ row, score }) => ({
        bookId: row.bookId,
        title: row.title,
        authorName: row.authorNames[0] ?? null,
        coverVersion: row.coverUpdatedAt?.toISOString() ?? null,
        score: Math.round(score * 100),
      }))
      .sort((left, right) => right.score - left.score || left.bookId - right.bookId)
      .slice(0, CANDIDATE_RESULT_LIMIT);
  }

  /**
   * The same similarity search and scoring the link panel ranks with, linked books included, for the
   * match scan. Scores stay unrounded and split into title and author parts.
   */
  async findMatchCandidates(options: FindMatchCandidatesOptions): Promise<MatchCandidate[]> {
    if (options.accessibleLibraryIds.length === 0) return [];
    const source = await this.findCandidateSource(options.bookId);
    if (!source.title.trim()) return [];

    const rows = await this.findCandidateRows({
      bookId: options.bookId,
      candidateModality: options.candidateModality,
      anyTextFormat: options.anyTextFormat,
      accessibleLibraryIds: options.accessibleLibraryIds,
      contentFilters: options.contentFilters,
      orderTerm: source.title,
      extra: [],
      similarityTo: source.title,
    });
    return rows
      .flatMap((row) => {
        const match = scoreCandidate(source, row);
        return match ? [{ bookId: row.bookId, title: row.title, authorNames: row.authorNames, language: row.language, ...match }] : [];
      })
      .sort((left, right) => right.score - left.score || left.bookId - right.bookId)
      .slice(0, CANDIDATE_RESULT_LIMIT);
  }

  private async findCandidateSource(bookId: number): Promise<CandidateSource> {
    const [source] = await this.db
      .select({ title: bookMetadata.title, seriesName: bookMetadata.seriesName, seriesIndex: bookMetadata.seriesIndex })
      .from(bookMetadata)
      .where(eq(bookMetadata.bookId, bookId))
      .limit(1);
    const sourceAuthors = await this.db
      .select({ name: authors.name })
      .from(bookAuthors)
      .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
      .where(eq(bookAuthors.bookId, bookId))
      .orderBy(bookAuthors.displayOrder);
    return {
      title: source?.title ?? '',
      seriesName: source?.seriesName ?? null,
      seriesIndex: source?.seriesIndex ?? null,
      authorNames: sourceAuthors.map((row) => row.name),
    };
  }

  private async findCandidateRows(options: {
    bookId: number;
    candidateModality: 'text' | 'audio';
    anyTextFormat?: boolean;
    accessibleLibraryIds: number[];
    contentFilters?: ContentFilterRules;
    orderTerm: string;
    extra: (SQL | undefined)[];
    similarityTo: string | undefined;
  }): Promise<CandidateRow[]> {
    const contentFilters = options.contentFilters ? buildContentFilterClauses(options.contentFilters, this.db) : [];
    const audioFormats = sql.join(
      AUDIO_FORMAT_LIST.map((format) => sql`${format}`),
      sql`, `,
    );
    const textFormats = options.anyTextFormat
      ? sql.join(
          EBOOK_FORMAT_LIST.map((format) => sql`${format}`),
          sql`, `,
        )
      : sql`'epub', 'kepub'`;
    const [required, excluded] = options.candidateModality === 'audio' ? [audioFormats, sql`'epub', 'kepub'`] : [textFormats, audioFormats];
    const requiredModality = sql`EXISTS (
        SELECT 1 FROM book_files candidate_file
        WHERE candidate_file.book_id = ${books.id}
          AND candidate_file.role = 'content'
          AND lower(coalesce(candidate_file.format, '')) IN (${required})
      )
      AND NOT EXISTS (
        SELECT 1 FROM book_files candidate_file
        WHERE candidate_file.book_id = ${books.id}
          AND candidate_file.role = 'content'
          AND lower(coalesce(candidate_file.format, '')) IN (${excluded})
      )`;
    const similarity =
      options.similarityTo === undefined
        ? undefined
        : sql`similarity(
          public.bookorbit_unaccent(coalesce(${bookMetadata.title}, '')),
          public.bookorbit_unaccent(${options.similarityTo})
        ) >= 0.15`;

    return this.db
      .select({
        bookId: books.id,
        title: bookMetadata.title,
        seriesName: bookMetadata.seriesName,
        seriesIndex: bookMetadata.seriesIndex,
        language: bookMetadata.language,
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
          ...options.extra,
          similarity,
          ...contentFilters,
        ),
      )
      .groupBy(books.id, bookMetadata.title, bookMetadata.seriesName, bookMetadata.seriesIndex, bookMetadata.language, bookMetadata.coverUpdatedAt)
      .orderBy(
        desc(
          sql`similarity(
            public.bookorbit_unaccent(coalesce(${bookMetadata.title}, '')),
            public.bookorbit_unaccent(${options.orderTerm})
          )`,
        ),
        books.id,
      )
      .limit(CANDIDATE_FETCH_LIMIT);
  }
}

// Sibling volumes share the author and differ by a digit, so edit distance puts "Series 13" and
// "Series 11" in the high nineties - and spelled-out volumes ("Book Seven", "Book Three") or a bare
// first book against its numbered sequels score near 100. A typed search is exempt: the reader may
// want any volume.
function scoreCandidate(source: CandidateSource, row: CandidateRow): { score: number; titleScore: number; authorScore: number } | null {
  const candidate = { title: row.title ?? '', seriesName: row.seriesName, seriesIndex: row.seriesIndex };
  const otherVolume = titleVolumeConflict(source.title, candidate.title) || seriesVolumeConflict(source, candidate);
  const titleScore = otherVolume ? 0 : scoreTitle(source.title, candidate.title);
  const authorScore = scoreAuthors(source.authorNames, row.authorNames);
  const comparableAuthors = source.authorNames.length > 0 && row.authorNames.length > 0;
  if (titleScore < 0.8 || (comparableAuthors ? authorScore < 0.75 : titleScore < 0.9)) return null;
  return { score: comparableAuthors ? titleScore * 0.7 + authorScore * 0.3 : titleScore, titleScore, authorScore };
}
