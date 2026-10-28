import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';

import type { EditionLinkMatchBucket } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { buildContentFilterClauses } from '../../common/utils/content-filter-sql.utils';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { bookDuplicateDismissals, bookMetadata, books } from '../../db/schema';
import {
  editionLinkMatchDismissals,
  editionLinkMatchResults,
  editionLinkMatchScans,
  type EditionLinkMatchResult,
  type EditionLinkMatchScan,
  type NewEditionLinkMatchResult,
} from './schema/work.schema';

type Db = NodePgDatabase<typeof schema>;

const SCAN_LOCK_NAMESPACE = 1_163_215_947;

export interface ScanBookRow {
  id: number;
  title: string | null;
  language: string | null;
  formats: string[];
  isbn13: string | null;
  isbn10: string | null;
  amazonId: string | null;
  audibleId: string | null;
}

export interface IdentifierMatchRow {
  sourceBookId: number;
  targetBookId: number;
  targetFormats: string[];
}

export type MatchBookCardRow = {
  id: number;
  title: string | null;
  authorName: string | null;
  coverUpdatedAt: string | null;
  libraryId: number;
  libraryName: string;
  formats: string[];
  seriesName: string | null;
  seriesIndex: string | null;
  isbn: string | null;
  readStatus: string | null;
  progress: number | null;
  authorNames: string[];
};

@Injectable()
export class WorkMatchRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  private scopeWhere(libraryIds: number[], user: RequestUser): SQL {
    if (libraryIds.length === 0) return sql`false`;
    const clauses: SQL[] = [inArray(books.libraryId, libraryIds), eq(books.status, 'present')];
    if (!user.isSuperuser) clauses.push(...buildContentFilterClauses(user.contentFilters, this.db));
    return and(...clauses)!;
  }

  async markInterruptedScansFailed(): Promise<void> {
    await this.db
      .update(editionLinkMatchScans)
      .set({ state: 'failed', error: 'interrupted', finishedAt: new Date() })
      .where(eq(editionLinkMatchScans.state, 'running'));
  }

  async createScanUnlessActive(userId: number, libraryId: number | null): Promise<EditionLinkMatchScan | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SCAN_LOCK_NAMESPACE}, ${userId})`);
      const [active] = await tx
        .select({ id: editionLinkMatchScans.id })
        .from(editionLinkMatchScans)
        .where(and(eq(editionLinkMatchScans.userId, userId), eq(editionLinkMatchScans.state, 'running')))
        .limit(1);
      if (active) return null;
      const [row] = await tx.insert(editionLinkMatchScans).values({ userId, libraryId }).returning();
      return row!;
    });
  }

  async findScan(scanId: number): Promise<EditionLinkMatchScan | null> {
    const [row] = await this.db.select().from(editionLinkMatchScans).where(eq(editionLinkMatchScans.id, scanId)).limit(1);
    return row ?? null;
  }

  async findLatestScan(userId: number, state?: 'done'): Promise<EditionLinkMatchScan | null> {
    const [row] = await this.db
      .select()
      .from(editionLinkMatchScans)
      .where(and(eq(editionLinkMatchScans.userId, userId), state ? eq(editionLinkMatchScans.state, state) : undefined))
      .orderBy(desc(editionLinkMatchScans.startedAt), desc(editionLinkMatchScans.id))
      .limit(1);
    return row ?? null;
  }

  async updateScan(scanId: number, values: Partial<Omit<EditionLinkMatchScan, 'id' | 'userId'>>): Promise<void> {
    await this.db.update(editionLinkMatchScans).set(values).where(eq(editionLinkMatchScans.id, scanId));
  }

  async deleteOlderScans(userId: number, keepScanId: number): Promise<void> {
    await this.db.execute(sql`
      DELETE FROM ${editionLinkMatchScans}
      WHERE user_id = ${userId} AND id <> ${keepScanId} AND state <> 'running'
    `);
  }

  async countScanBooks(libraryIds: number[], user: RequestUser): Promise<number> {
    const [row] = await this.db.select({ count: count() }).from(books).where(this.scopeWhere(libraryIds, user));
    return row?.count ?? 0;
  }

  async findScanBatch(libraryIds: number[], user: RequestUser, afterBookId: number, limit: number): Promise<ScanBookRow[]> {
    return this.db
      .select({
        id: books.id,
        title: bookMetadata.title,
        language: bookMetadata.language,
        formats: sql<string[]>`coalesce((
          SELECT array_agg(DISTINCT lower(scan_file.format)) FROM book_files scan_file
          WHERE scan_file.book_id = ${books.id} AND scan_file.role = 'content' AND scan_file.format IS NOT NULL
        ), ARRAY[]::text[])`,
        isbn13: bookMetadata.isbn13,
        isbn10: bookMetadata.isbn10,
        amazonId: bookMetadata.amazonId,
        audibleId: bookMetadata.audibleId,
      })
      .from(books)
      .leftJoin(bookMetadata, eq(bookMetadata.bookId, books.id))
      .where(and(this.scopeWhere(libraryIds, user), sql`${books.id} > ${afterBookId}`))
      .orderBy(asc(books.id))
      .limit(limit);
  }

  /** Books in scope sharing an ISBN or ASIN with one of the given books. */
  async findIdentifierMatches(bookIds: number[], libraryIds: number[], user: RequestUser): Promise<IdentifierMatchRow[]> {
    if (bookIds.length === 0) return [];
    const target = alias(bookMetadata, 'target_metadata');
    const source = alias(bookMetadata, 'source_metadata');
    const sameIdentifier = or(
      sql`${source.isbn13} IS NOT NULL AND ${source.isbn13} = ${target.isbn13}`,
      sql`${source.isbn10} IS NOT NULL AND ${source.isbn10} = ${target.isbn10}`,
      sql`${source.amazonId} IS NOT NULL AND ${source.amazonId} = ${target.amazonId}`,
      sql`${source.audibleId} IS NOT NULL AND ${source.audibleId} = ${target.audibleId}`,
    );
    return this.db
      .select({
        sourceBookId: source.bookId,
        targetBookId: books.id,
        targetFormats: sql<string[]>`coalesce((
          SELECT array_agg(DISTINCT lower(target_file.format)) FROM book_files target_file
          WHERE target_file.book_id = ${books.id} AND target_file.role = 'content' AND target_file.format IS NOT NULL
        ), ARRAY[]::text[])`,
      })
      .from(source)
      .innerJoin(target, and(sameIdentifier, sql`${target.bookId} <> ${source.bookId}`))
      .innerJoin(books, eq(books.id, target.bookId))
      .where(and(inArray(source.bookId, bookIds), this.scopeWhere(libraryIds, user)));
  }

  /** Pairs the user has judged, from this tool and from the duplicates tool, keyed "low:high". */
  async findDismissedPairs(userId: number, bookIds: number[]): Promise<Set<string>> {
    if (bookIds.length === 0) return new Set();
    const [own, duplicates] = await Promise.all([
      this.db
        .select({ a: editionLinkMatchDismissals.bookIdA, b: editionLinkMatchDismissals.bookIdB })
        .from(editionLinkMatchDismissals)
        .where(
          and(
            eq(editionLinkMatchDismissals.userId, userId),
            or(inArray(editionLinkMatchDismissals.bookIdA, bookIds), inArray(editionLinkMatchDismissals.bookIdB, bookIds)),
          ),
        ),
      this.db
        .select({ a: bookDuplicateDismissals.bookIdA, b: bookDuplicateDismissals.bookIdB })
        .from(bookDuplicateDismissals)
        .where(
          and(
            eq(bookDuplicateDismissals.userId, userId),
            or(inArray(bookDuplicateDismissals.bookIdA, bookIds), inArray(bookDuplicateDismissals.bookIdB, bookIds)),
          ),
        ),
    ]);
    return new Set([...own, ...duplicates].map((row) => `${row.a}:${row.b}`));
  }

  async findAuthorNames(bookIds: number[]): Promise<Map<number, string[]>> {
    if (bookIds.length === 0) return new Map();
    const result = await this.db.execute<{ bookId: number; names: string[] }>(sql`
      SELECT ba.book_id AS "bookId", array_agg(a.name ORDER BY ba.display_order, a.id) AS "names"
      FROM book_authors ba JOIN authors a ON a.id = ba.author_id
      WHERE ba.book_id IN ${bookIds}
      GROUP BY ba.book_id
    `);
    return new Map(result.rows.map((row) => [row.bookId, row.names]));
  }

  async insertResults(rows: NewEditionLinkMatchResult[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(editionLinkMatchResults).values(rows);
  }

  async findStrongClaims(scanId: number): Promise<{ resultId: number; sourceBookId: number; targetBookId: number }[]> {
    return this.db
      .select({
        resultId: editionLinkMatchResults.id,
        sourceBookId: editionLinkMatchResults.sourceBookId,
        targetBookId: editionLinkMatchResults.targetBookId,
      })
      .from(editionLinkMatchResults)
      .where(
        and(
          eq(editionLinkMatchResults.scanId, scanId),
          eq(editionLinkMatchResults.bucket, 'strong'),
          sql`${editionLinkMatchResults.targetBookId} IN (
            SELECT claim.target_book_id FROM ${editionLinkMatchResults} claim
            WHERE claim.scan_id = ${scanId} AND claim.bucket = 'strong'
            GROUP BY claim.target_book_id HAVING count(*) > 1
          )`,
        ),
      );
  }

  async markConflict(resultId: number, competingBookIds: number[]): Promise<void> {
    await this.db
      .update(editionLinkMatchResults)
      .set({ bucket: 'conflict', competingBookIds, reason: `also claimed by ${competingBookIds.map((id) => `#${id}`).join(', ')}` })
      .where(eq(editionLinkMatchResults.id, resultId));
  }

  async countBuckets(scanId: number): Promise<Map<EditionLinkMatchBucket, number>> {
    const rows = await this.db
      .select({ bucket: editionLinkMatchResults.bucket, count: count() })
      .from(editionLinkMatchResults)
      .where(eq(editionLinkMatchResults.scanId, scanId))
      .groupBy(editionLinkMatchResults.bucket);
    return new Map(rows.map((row) => [row.bucket, row.count]));
  }

  async countDismissals(userId: number): Promise<number> {
    const [row] = await this.db.select({ count: count() }).from(editionLinkMatchDismissals).where(eq(editionLinkMatchDismissals.userId, userId));
    return row?.count ?? 0;
  }

  async listResults(
    scanId: number,
    buckets: EditionLinkMatchBucket[],
    libraryId: number | undefined,
    page: number,
    pageSize: number,
  ): Promise<{ items: EditionLinkMatchResult[]; total: number }> {
    const libraryFilter =
      libraryId === undefined
        ? undefined
        : sql`EXISTS (
            SELECT 1 FROM ${books} scoped
            WHERE scoped.library_id = ${libraryId}
              AND scoped.id IN (${editionLinkMatchResults.sourceBookId}, ${editionLinkMatchResults.targetBookId})
          )`;
    const where = and(
      eq(editionLinkMatchResults.scanId, scanId),
      buckets.length > 0 ? inArray(editionLinkMatchResults.bucket, buckets) : undefined,
      libraryFilter,
    );
    const [items, totals] = await Promise.all([
      this.db
        .select()
        .from(editionLinkMatchResults)
        .where(where)
        .orderBy(desc(editionLinkMatchResults.score), asc(editionLinkMatchResults.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ total: count() }).from(editionLinkMatchResults).where(where),
    ]);
    return { items, total: totals[0]?.total ?? 0 };
  }

  async findBookCards(userId: number, bookIds: number[]): Promise<Map<number, MatchBookCardRow>> {
    if (bookIds.length === 0) return new Map();
    const result = await this.db.execute<MatchBookCardRow>(sql`
      SELECT
        b.id AS "id",
        m.title AS "title",
        authors.names[1] AS "authorName",
        coalesce(authors.names, ARRAY[]::varchar[]) AS "authorNames",
        m.cover_updated_at AS "coverUpdatedAt",
        b.library_id AS "libraryId",
        l.name AS "libraryName",
        coalesce((
          SELECT array_agg(DISTINCT lower(f.format)) FROM book_files f
          WHERE f.book_id = b.id AND f.role = 'content' AND f.format IS NOT NULL
        ), ARRAY[]::text[]) AS "formats",
        m.series_name AS "seriesName",
        m.series_index AS "seriesIndex",
        coalesce(m.isbn13, m.isbn10) AS "isbn",
        s.status AS "readStatus",
        GREATEST(
          (SELECT rp.percentage FROM reading_progress rp WHERE rp.book_file_id = b.primary_file_id AND rp.user_id = ${userId}),
          (SELECT ap.percentage FROM audiobook_progress ap WHERE ap.book_id = b.id AND ap.user_id = ${userId})
        ) AS "progress"
      FROM ${books} b
      JOIN libraries l ON l.id = b.library_id
      LEFT JOIN book_metadata m ON m.book_id = b.id
      LEFT JOIN user_book_status s ON s.book_id = b.id AND s.user_id = ${userId}
      LEFT JOIN LATERAL (
        SELECT array_agg(a.name ORDER BY ba.display_order, a.id) AS names
        FROM book_authors ba JOIN authors a ON a.id = ba.author_id
        WHERE ba.book_id = b.id
      ) authors ON true
      WHERE b.id IN ${bookIds}
    `);
    return new Map(result.rows.map((row) => [row.id, row]));
  }

  async findResult(resultId: number, userId: number): Promise<EditionLinkMatchResult | null> {
    const [row] = await this.db
      .select()
      .from(editionLinkMatchResults)
      .where(and(eq(editionLinkMatchResults.id, resultId), eq(editionLinkMatchResults.userId, userId)))
      .limit(1);
    return row ?? null;
  }

  async findStrongUnlinked(scanId: number, afterId: number, limit: number): Promise<EditionLinkMatchResult[]> {
    return this.db
      .select()
      .from(editionLinkMatchResults)
      .where(
        and(
          eq(editionLinkMatchResults.scanId, scanId),
          eq(editionLinkMatchResults.bucket, 'strong'),
          isNull(editionLinkMatchResults.linkId),
          sql`${editionLinkMatchResults.id} > ${afterId}`,
        ),
      )
      .orderBy(asc(editionLinkMatchResults.id))
      .limit(limit);
  }

  async markLinked(resultId: number, linkId: number | null): Promise<void> {
    await this.db
      .update(editionLinkMatchResults)
      .set({ bucket: 'linked_ok', linkId, reason: 'linked' })
      .where(eq(editionLinkMatchResults.id, resultId));
  }

  async insertDismissal(userId: number, bookIdA: number, bookIdB: number): Promise<void> {
    await this.db.insert(editionLinkMatchDismissals).values({ userId, bookIdA, bookIdB }).onConflictDoNothing();
    await this.db.execute(sql`
      DELETE FROM ${editionLinkMatchResults}
      WHERE user_id = ${userId}
        AND least(source_book_id, target_book_id) = ${bookIdA}
        AND greatest(source_book_id, target_book_id) = ${bookIdB}
    `);
  }

  async deleteDismissal(userId: number, bookIdA: number, bookIdB: number): Promise<number> {
    const result = await this.db
      .delete(editionLinkMatchDismissals)
      .where(
        and(
          eq(editionLinkMatchDismissals.userId, userId),
          eq(editionLinkMatchDismissals.bookIdA, bookIdA),
          eq(editionLinkMatchDismissals.bookIdB, bookIdB),
        ),
      );
    return result.rowCount ?? 0;
  }

  async listDismissals(
    userId: number,
    limit: number,
  ): Promise<{ bookIdA: number; bookIdB: number; titleA: string | null; titleB: string | null; createdAt: Date }[]> {
    const metadataA = alias(bookMetadata, 'metadata_a');
    const metadataB = alias(bookMetadata, 'metadata_b');
    return this.db
      .select({
        bookIdA: editionLinkMatchDismissals.bookIdA,
        bookIdB: editionLinkMatchDismissals.bookIdB,
        titleA: metadataA.title,
        titleB: metadataB.title,
        createdAt: editionLinkMatchDismissals.createdAt,
      })
      .from(editionLinkMatchDismissals)
      .leftJoin(metadataA, eq(metadataA.bookId, editionLinkMatchDismissals.bookIdA))
      .leftJoin(metadataB, eq(metadataB.bookId, editionLinkMatchDismissals.bookIdB))
      .where(eq(editionLinkMatchDismissals.userId, userId))
      .orderBy(desc(editionLinkMatchDismissals.createdAt))
      .limit(limit);
  }
}
