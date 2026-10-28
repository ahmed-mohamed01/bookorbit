import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, lt, or, type SQL, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { ContentFilterRules, ReadingAttemptOrigin, ReadingAttemptOutcome, WorkVariantRole } from '@bookorbit/types';
import { isAudioFormat } from '@bookorbit/types';
import { compareAudioTracks } from '../../common/utils/book-media.utils';
import { buildContentFilterClauses } from '../../common/utils/content-filter-sql.utils';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { audiobookProgress, bookFiles, books, libraries, readingAttempts, readingSessions } from '../../db/schema';
import { readingProgressProjection } from '../reading-alignment/schema/reading-progress-projection.schema';
import { bookEditionLinks } from './schema/edition-link.schema';
import { bookEditionLinkMembers } from './schema/work.schema';

type Db = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface WorkMemberRankRow {
  linkId: number;
  bookId: number;
  role: WorkVariantRole;
  isPrimary: boolean;
  createdAt: Date;
  primaryFormat: string | null;
  primaryReadAlong: boolean;
  formatPriority: string[] | null;
}

export interface BookRankRow {
  bookId: number;
  primaryFormat: string | null;
  primaryReadAlong: boolean;
  formatPriority: string[] | null;
}

export interface WorkPrimaries {
  text: number | null;
  audio: number | null;
  readAlong: number | null;
}

export interface AttemptRow {
  id: number;
  bookId: number;
  startedOn: string | null;
  endedOn: string | null;
  outcome: ReadingAttemptOutcome | null;
  origin: ReadingAttemptOrigin;
}

export interface AttemptMergePlan {
  moveIds: number[];
  deletes: { id: number; keptId: number }[];
}

export type VariantDetailRow = {
  bookId: number;
  title: string | null;
  authorName: string | null;
  coverUpdatedAt: Date | null;
  libraryId: number;
  libraryName: string;
  formats: string[];
  sizeBytes: number | null;
  metadataDurationSeconds: number | null;
  audioDurationSeconds: number | null;
};

export type VariantProgressRow = {
  bookId: number;
  primaryFileId: number | null;
  filePercentage: number | null;
  fileLastReadAt: Date | null;
  fileProjectedAt: Date | null;
  audioPercentage: number | null;
  audioUpdatedAt: Date | null;
  sessionSource: string | null;
};

export type MirrorTargetState = Omit<VariantProgressRow, 'sessionSource'>;

const MEMBER_RANK_COLUMNS = {
  linkId: bookEditionLinkMembers.linkId,
  bookId: bookEditionLinkMembers.bookId,
  role: bookEditionLinkMembers.role,
  isPrimary: bookEditionLinkMembers.isPrimary,
  createdAt: bookEditionLinkMembers.createdAt,
  primaryFormat: bookFiles.format,
  primaryReadAlong: sql<boolean>`coalesce(${bookFiles.mediaOverlayAvailable}, false)`,
  formatPriority: sql<string[] | null>`${libraries.formatPriority}`,
};

// Works are edition links read through their members. Every slot write below goes through the
// book_edition_links trigger, which keeps each slot equal to the primary member of its role.
@Injectable()
export class WorkRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findWorkMembersByBook(bookId: number): Promise<WorkMemberRankRow[]> {
    const linkIds = this.db
      .select({ linkId: bookEditionLinkMembers.linkId })
      .from(bookEditionLinkMembers)
      .where(eq(bookEditionLinkMembers.bookId, bookId));
    return this.selectMembers(inArray(bookEditionLinkMembers.linkId, linkIds));
  }

  /** Every member of every work holding one of the books, in one query. */
  async findWorkMembersForBooks(bookIds: number[]): Promise<WorkMemberRankRow[]> {
    if (bookIds.length === 0) return [];
    const linkIds = this.db
      .select({ linkId: bookEditionLinkMembers.linkId })
      .from(bookEditionLinkMembers)
      .where(inArray(bookEditionLinkMembers.bookId, bookIds));
    return this.selectMembers(inArray(bookEditionLinkMembers.linkId, linkIds));
  }

  async findWorkMembersByLink(linkId: number): Promise<WorkMemberRankRow[]> {
    return this.selectMembers(eq(bookEditionLinkMembers.linkId, linkId));
  }

  async findBookRanks(bookIds: number[]): Promise<Map<number, BookRankRow>> {
    if (bookIds.length === 0) return new Map();
    const rows = await this.db
      .select({
        bookId: books.id,
        primaryFormat: bookFiles.format,
        primaryReadAlong: sql<boolean>`coalesce(${bookFiles.mediaOverlayAvailable}, false)`,
        formatPriority: sql<string[] | null>`${libraries.formatPriority}`,
      })
      .from(books)
      .innerJoin(libraries, eq(libraries.id, books.libraryId))
      .leftJoin(bookFiles, eq(bookFiles.id, books.primaryFileId))
      .where(inArray(books.id, bookIds));
    return new Map(rows.map((row) => [row.bookId, row]));
  }

  async createWork(createdBy: number, primaries: WorkPrimaries, duplicates: { bookId: number; role: WorkVariantRole }[]): Promise<number> {
    return this.db.transaction(async (tx) => {
      const [link] = await tx
        .insert(bookEditionLinks)
        .values({ textBookId: primaries.text, audioBookId: primaries.audio, readAlongBookId: primaries.readAlong, createdBy })
        .returning({ id: bookEditionLinks.id });
      if (duplicates.length > 0) {
        await tx.insert(bookEditionLinkMembers).values(duplicates.map((member) => ({ linkId: link!.id, ...member, isPrimary: false })));
      }
      return link!.id;
    });
  }

  async addDuplicate(linkId: number, bookId: number, role: WorkVariantRole): Promise<void> {
    await this.db.insert(bookEditionLinkMembers).values({ linkId, bookId, role, isPrimary: false });
  }

  /** Demotes first so the one-primary-per-role index never sees two primaries, then moves the slots. */
  async applyPrimaries(linkId: number, primaries: WorkPrimaries, tx?: Tx): Promise<void> {
    const run = async (db: Tx) => {
      const chosen = [primaries.text, primaries.audio, primaries.readAlong].filter((id): id is number => id !== null);
      await db
        .update(bookEditionLinkMembers)
        .set({ isPrimary: false })
        .where(
          and(
            eq(bookEditionLinkMembers.linkId, linkId),
            eq(bookEditionLinkMembers.isPrimary, true),
            chosen.length > 0
              ? sql`${bookEditionLinkMembers.bookId} NOT IN (${sql.join(
                  chosen.map((id) => sql`${id}`),
                  sql`, `,
                )})`
              : undefined,
          ),
        );
      if (chosen.length > 0) {
        await db
          .update(bookEditionLinkMembers)
          .set({ isPrimary: true })
          .where(and(eq(bookEditionLinkMembers.linkId, linkId), inArray(bookEditionLinkMembers.bookId, chosen)));
      }
      await db
        .update(bookEditionLinks)
        .set({ textBookId: primaries.text, audioBookId: primaries.audio, readAlongBookId: primaries.readAlong })
        .where(eq(bookEditionLinks.id, linkId));
    };
    if (tx) return run(tx);
    return this.db.transaction(run);
  }

  /** Removes a member and its link row once a single member is left. Returns the members left. */
  async removeMember(linkId: number, bookId: number, primaries: WorkPrimaries): Promise<number> {
    return this.db.transaction(async (tx) => {
      await tx.delete(bookEditionLinkMembers).where(and(eq(bookEditionLinkMembers.linkId, linkId), eq(bookEditionLinkMembers.bookId, bookId)));
      const [{ remaining } = { remaining: 0 }] = await tx
        .select({ remaining: sql<number>`count(*)::int` })
        .from(bookEditionLinkMembers)
        .where(eq(bookEditionLinkMembers.linkId, linkId));
      if (remaining < 2) {
        await tx.delete(bookEditionLinks).where(eq(bookEditionLinks.id, linkId));
        return remaining;
      }
      await this.applyPrimaries(linkId, primaries, tx);
      return remaining;
    });
  }

  /** Folds one work into another; the caller re-picks the primaries of the merged work. */
  async mergeWorks(keepLinkId: number, dropLinkId: number, primaries: WorkPrimaries): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(bookEditionLinkMembers).set({ linkId: keepLinkId, isPrimary: false }).where(eq(bookEditionLinkMembers.linkId, dropLinkId));
      await tx.delete(bookEditionLinks).where(eq(bookEditionLinks.id, dropLinkId));
      await this.applyPrimaries(keepLinkId, primaries, tx);
    });
  }

  async findVariantDetails(bookIds: number[]): Promise<VariantDetailRow[]> {
    if (bookIds.length === 0) return [];
    const result = await this.db.execute<VariantDetailRow>(sql`
      SELECT
        b.id AS "bookId",
        m.title AS "title",
        (
          SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id
          WHERE ba.book_id = b.id ORDER BY ba.display_order, a.id LIMIT 1
        ) AS "authorName",
        m.cover_updated_at AS "coverUpdatedAt",
        b.library_id AS "libraryId",
        l.name AS "libraryName",
        coalesce((
          SELECT array_agg(DISTINCT lower(f.format)) FROM book_files f
          WHERE f.book_id = b.id AND f.role = 'content' AND f.format IS NOT NULL
        ), ARRAY[]::text[]) AS "formats",
        (SELECT sum(f.size_bytes)::float8 FROM book_files f WHERE f.book_id = b.id AND f.role = 'content') AS "sizeBytes",
        m.duration_seconds AS "metadataDurationSeconds",
        (SELECT sum(f.duration_seconds)::int FROM book_files f WHERE f.book_id = b.id AND f.role = 'content') AS "audioDurationSeconds"
      FROM ${books} b
      JOIN ${libraries} l ON l.id = b.library_id
      LEFT JOIN book_metadata m ON m.book_id = b.id
      WHERE b.id IN ${bookIds}
    `);
    return result.rows.map((row) => ({ ...row, coverUpdatedAt: row.coverUpdatedAt ? new Date(row.coverUpdatedAt) : null }));
  }

  async findVariantProgress(userId: number, bookIds: number[]): Promise<VariantProgressRow[]> {
    if (bookIds.length === 0) return [];
    const result = await this.db.execute<VariantProgressRow>(sql`
      SELECT
        b.id AS "bookId",
        b.primary_file_id AS "primaryFileId",
        rp.percentage AS "filePercentage",
        rp.last_read_at AS "fileLastReadAt",
        rp.alignment_projected_at AS "fileProjectedAt",
        ap.percentage AS "audioPercentage",
        ap.updated_at AS "audioUpdatedAt",
        (
          SELECT rs.source FROM ${readingSessions} rs
          WHERE rs.user_id = ${userId} AND rs.book_id = b.id
          ORDER BY rs.ended_at DESC LIMIT 1
        ) AS "sessionSource"
      FROM ${books} b
      LEFT JOIN reading_progress rp ON rp.book_file_id = b.primary_file_id AND rp.user_id = ${userId}
      LEFT JOIN ${audiobookProgress} ap ON ap.book_id = b.id AND ap.user_id = ${userId}
      WHERE b.id IN ${bookIds}
    `);
    return result.rows.map((row) => ({
      ...row,
      fileLastReadAt: row.fileLastReadAt ? new Date(row.fileLastReadAt) : null,
      fileProjectedAt: row.fileProjectedAt ? new Date(row.fileProjectedAt) : null,
      audioUpdatedAt: row.audioUpdatedAt ? new Date(row.audioUpdatedAt) : null,
    }));
  }

  async findAttempts(userId: number, bookIds: number[]): Promise<AttemptRow[]> {
    if (bookIds.length === 0) return [];
    return this.db
      .select({
        id: readingAttempts.id,
        bookId: readingAttempts.bookId,
        startedOn: readingAttempts.startedOn,
        endedOn: readingAttempts.endedOn,
        outcome: readingAttempts.outcome,
        origin: readingAttempts.origin,
      })
      .from(readingAttempts)
      .where(and(eq(readingAttempts.userId, userId), inArray(readingAttempts.bookId, bookIds), isNull(readingAttempts.deletedAt)))
      .orderBy(asc(readingAttempts.id));
  }

  async findUserIdsWithAttempts(bookIds: number[]): Promise<number[]> {
    if (bookIds.length === 0) return [];
    const rows = await this.db
      .selectDistinct({ userId: readingAttempts.userId })
      .from(readingAttempts)
      .where(and(inArray(readingAttempts.bookId, bookIds), isNull(readingAttempts.deletedAt)));
    return rows.map((row) => row.userId);
  }

  /** Works holding a book the user has history on, in id order for keyset batches. */
  async findLinkIdsWithUserAttempts(userId: number, afterLinkId: number, limit: number): Promise<number[]> {
    const rows = await this.db
      .selectDistinct({ linkId: bookEditionLinkMembers.linkId })
      .from(bookEditionLinkMembers)
      .innerJoin(readingAttempts, and(eq(readingAttempts.bookId, bookEditionLinkMembers.bookId), eq(readingAttempts.userId, userId)))
      .where(and(isNull(readingAttempts.deletedAt), sql`${bookEditionLinkMembers.linkId} > ${afterLinkId}`))
      .orderBy(asc(bookEditionLinkMembers.linkId))
      .limit(limit);
    return rows.map((row) => row.linkId);
  }

  async findMemberBookIdsByLinks(linkIds: number[]): Promise<Map<number, number[]>> {
    if (linkIds.length === 0) return new Map();
    const rows = await this.db
      .select({ linkId: bookEditionLinkMembers.linkId, bookId: bookEditionLinkMembers.bookId })
      .from(bookEditionLinkMembers)
      .where(inArray(bookEditionLinkMembers.linkId, linkIds));
    const result = new Map<number, number[]>();
    for (const row of rows) result.set(row.linkId, [...(result.get(row.linkId) ?? []), row.bookId]);
    return result;
  }

  /** Soft-deletes the duplicates first, handing their sessions to the kept row, then moves the rest. */
  async applyAttemptMerge(userId: number, canonicalBookId: number, plan: AttemptMergePlan): Promise<void> {
    if (plan.moveIds.length === 0 && plan.deletes.length === 0) return;
    await this.db.transaction(async (tx) => {
      for (const { id, keptId } of plan.deletes) {
        await tx.update(readingSessions).set({ attemptId: keptId }).where(eq(readingSessions.attemptId, id));
      }
      const deleteIds = plan.deletes.map((entry) => entry.id);
      if (deleteIds.length > 0) {
        const now = new Date();
        await tx
          .update(readingAttempts)
          .set({ deletedAt: now, updatedAt: now })
          .where(and(eq(readingAttempts.userId, userId), inArray(readingAttempts.id, deleteIds)));
      }
      if (plan.moveIds.length > 0) {
        await tx
          .update(readingAttempts)
          .set({ bookId: canonicalBookId, updatedAt: new Date() })
          .where(and(eq(readingAttempts.userId, userId), inArray(readingAttempts.id, plan.moveIds)));
      }
    });
  }

  /** New rows with the same history; the external link stays with the original row it was made for. */
  async copyAttempts(userId: number, fromBookId: number, toBookId: number): Promise<number> {
    const result = await this.db.execute(sql`
      INSERT INTO ${readingAttempts} (user_id, book_id, started_on, ended_on, outcome, origin)
      SELECT source.user_id, ${toBookId}, source.started_on, source.ended_on, source.outcome, source.origin
      FROM ${readingAttempts} source
      WHERE source.user_id = ${userId} AND source.book_id = ${fromBookId} AND source.deleted_at IS NULL
        AND NOT (source.outcome IS NULL AND EXISTS (
          SELECT 1 FROM ${readingAttempts} active
          WHERE active.user_id = ${userId} AND active.book_id = ${toBookId} AND active.outcome IS NULL AND active.deleted_at IS NULL
        ))
    `);
    return result.rowCount ?? 0;
  }

  async softDeleteAttempts(userId: number, attemptIds: number[]): Promise<number> {
    if (attemptIds.length === 0) return 0;
    const now = new Date();
    const rows = await this.db
      .update(readingAttempts)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(readingAttempts.userId, userId), inArray(readingAttempts.id, attemptIds), isNull(readingAttempts.deletedAt)))
      .returning({ id: readingAttempts.id });
    return rows.length;
  }

  /** Books holding a completed Audiobookshelf attempt, in id order for keyset batches. */
  async findAbsFinishedBookIds(userId: number, afterBookId: number, limit: number): Promise<number[]> {
    const rows = await this.db
      .selectDistinct({ bookId: readingAttempts.bookId })
      .from(readingAttempts)
      .where(
        and(
          eq(readingAttempts.userId, userId),
          sql`${readingAttempts.origin} = 'audiobookshelf'`,
          eq(readingAttempts.outcome, 'completed'),
          isNull(readingAttempts.deletedAt),
          sql`${readingAttempts.bookId} > ${afterBookId}`,
        ),
      )
      .orderBy(asc(readingAttempts.bookId))
      .limit(limit);
    return rows.map((row) => row.bookId);
  }

  async findCompletedAttempts(userId: number, bookIds: number[]): Promise<AttemptRow[]> {
    if (bookIds.length === 0) return [];
    return this.db
      .select({
        id: readingAttempts.id,
        bookId: readingAttempts.bookId,
        startedOn: readingAttempts.startedOn,
        endedOn: readingAttempts.endedOn,
        outcome: readingAttempts.outcome,
        origin: readingAttempts.origin,
      })
      .from(readingAttempts)
      .where(
        and(
          eq(readingAttempts.userId, userId),
          inArray(readingAttempts.bookId, bookIds),
          eq(readingAttempts.outcome, 'completed'),
          isNull(readingAttempts.deletedAt),
        ),
      );
  }

  /** The reading-goal count: completed attempts ending in a window, in libraries the reader can open. */
  async countCompletedBetween(
    userId: number,
    accessibleLibraryIds: number[],
    fromDay: string,
    untilDay: string,
    contentFilters?: ContentFilterRules,
  ): Promise<number> {
    if (accessibleLibraryIds.length === 0) return 0;
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(readingAttempts)
      .innerJoin(books, eq(books.id, readingAttempts.bookId))
      .where(
        and(
          eq(readingAttempts.userId, userId),
          eq(readingAttempts.outcome, 'completed'),
          isNull(readingAttempts.deletedAt),
          sql`${readingAttempts.endedOn} >= ${fromDay} AND ${readingAttempts.endedOn} < ${untilDay}`,
          inArray(books.libraryId, accessibleLibraryIds),
          ...(contentFilters ? buildContentFilterClauses(contentFilters, this.db) : []),
        ),
      );
    return row?.count ?? 0;
  }

  async findMirrorTargetStates(userId: number, bookIds: number[]): Promise<MirrorTargetState[]> {
    return this.findVariantProgress(userId, bookIds);
  }

  async hasReadyAlignment(textBookId: number, audioBookId: number): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT 1 FROM audiobook_alignment
      WHERE text_book_id = ${textBookId} AND audio_book_id = ${audioBookId} AND status = 'ready'
      LIMIT 1
    `);
    return result.rows.length > 0;
  }

  async hasReadAlongOffsets(readAlongBookId: number, audioBookId: number): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT 1 FROM read_along_narration_offsets offsets
      JOIN ${books} b ON b.primary_file_id = offsets.read_along_file_id
      WHERE b.id = ${readAlongBookId} AND offsets.audio_book_id = ${audioBookId} AND offsets.status = 'ready'
      LIMIT 1
    `);
    return result.rows.length > 0;
  }

  async findAudioPlayOrder(audioBookId: number): Promise<{ id: number; durationSeconds: number | null }[]> {
    const rows = await this.db
      .select({
        id: bookFiles.id,
        format: bookFiles.format,
        absolutePath: bookFiles.absolutePath,
        sortOrder: bookFiles.sortOrder,
        durationSeconds: bookFiles.durationSeconds,
      })
      .from(bookFiles)
      .where(and(eq(bookFiles.bookId, audioBookId), eq(bookFiles.role, 'content')))
      .orderBy(asc(bookFiles.sortOrder));
    return rows
      .filter((row) => row.format != null && isAudioFormat(row.format))
      .sort(compareAudioTracks)
      .map((row) => ({ id: row.id, durationSeconds: row.durationSeconds }));
  }

  /**
   * A percentage-only write onto the ebook row, marked as a projection the way the alignment sync
   * marks one, so a real read still wins and the stored CFI is never touched.
   */
  async mirrorReadingProgress(userId: number, bookFileId: number, percentage: number, projectedAt: Date): Promise<boolean> {
    const rows = await this.db
      .insert(readingProgressProjection)
      .values({ userId, bookFileId, percentage, cfi: null, updatedAt: projectedAt, lastReadAt: projectedAt, alignmentProjectedAt: projectedAt })
      .onConflictDoUpdate({
        target: [readingProgressProjection.bookFileId, readingProgressProjection.userId],
        set: { percentage, alignmentProjectedAt: projectedAt },
        setWhere: and(
          lt(readingProgressProjection.lastReadAt, projectedAt),
          or(isNull(readingProgressProjection.alignmentProjectedAt), lt(readingProgressProjection.alignmentProjectedAt, projectedAt)),
        ),
      })
      .returning({ userId: readingProgressProjection.userId });
    return rows.length > 0;
  }

  async mirrorAudiobookProgress(
    userId: number,
    audioBookId: number,
    currentFileId: number,
    positionSeconds: number,
    percentage: number,
    at: Date,
  ): Promise<boolean> {
    const rows = await this.db
      .insert(audiobookProgress)
      .values({ userId, bookId: audioBookId, currentFileId, positionSeconds, percentage, capturedAt: at, updatedAt: at })
      .onConflictDoUpdate({
        target: [audiobookProgress.userId, audiobookProgress.bookId],
        set: { currentFileId, positionSeconds, percentage, revision: sql`${audiobookProgress.revision} + 1`, capturedAt: at, updatedAt: at },
        setWhere: lt(audiobookProgress.updatedAt, at),
      })
      .returning({ userId: audiobookProgress.userId });
    return rows.length > 0;
  }

  private async selectMembers(where: SQL): Promise<WorkMemberRankRow[]> {
    return this.db
      .select(MEMBER_RANK_COLUMNS)
      .from(bookEditionLinkMembers)
      .innerJoin(books, eq(books.id, bookEditionLinkMembers.bookId))
      .innerJoin(libraries, eq(libraries.id, books.libraryId))
      .leftJoin(bookFiles, eq(bookFiles.id, books.primaryFileId))
      .where(where)
      .orderBy(asc(bookEditionLinkMembers.createdAt), asc(bookEditionLinkMembers.id));
  }
}
