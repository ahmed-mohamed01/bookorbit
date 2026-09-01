import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import { isAudioFormat } from '../scanner/lib/classify';
import type { AudioTimelineFile } from './reading-alignment-audio-timeline.util';
import { audiobookAlignment, audiobookAlignmentAnchor } from './schema/reading-alignment.schema';
import type {
  AudiobookAlignment,
  AudiobookAlignmentAnchor,
  NewAudiobookAlignment,
  NewAudiobookAlignmentAnchor,
} from './schema/reading-alignment.schema';

type Db = NodePgDatabase<typeof schema>;

const TEXT_FILE_FORMATS = new Set(['epub', 'kepub']);

// A ready alignment paired with its anchors in ascending audio order, the shape the
// cross-format resume resolver consumes.
export type ReadyAlignmentWithAnchors = { alignment: AudiobookAlignment; anchors: AudiobookAlignmentAnchor[] };

// Minimal progress projections. Only the fields the resolver compares (freshness)
// and maps (position) are read; the wide progress rows are never returned whole.
type ReadingProgressSnapshot = { percentage: number; updatedAt: Date; lastReadAt: Date };
type AudiobookProgressSnapshot = { currentFileId: number; positionSeconds: number; percentage: number; updatedAt: Date };

// An audio content file resolved in play order, carrying both the on-disk path the transcriber needs
// and the duration the timeline needs.
type AudioFileWithPath = { fileId: number; absolutePath: string; durationSeconds: number | null };

// The book's primary EPUB content file, used both to feed the spine extractor and to hash for change
// detection.
type EbookFileRef = { id: number; absolutePath: string; sizeBytes: number | null };

type AlignmentProgress = { samplesDone: number; anchorCount: number };

@Injectable()
export class ReadingAlignmentRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  // Applies the reading-alignment schema bootstrap statements. DB access lives here rather than in
  // the bootstrap service so services never inject the Drizzle instance directly.
  async applySchemaStatements(statements: readonly string[]): Promise<void> {
    for (const statement of statements) {
      await this.db.execute(sql.raw(statement));
    }
  }

  async resolveAudioPlayOrder(audioBookId: number): Promise<AudioTimelineFile[]> {
    const rows = await this.db
      .select({
        id: schema.bookFiles.id,
        format: schema.bookFiles.format,
        durationSeconds: schema.bookFiles.durationSeconds,
      })
      .from(schema.bookFiles)
      .where(and(eq(schema.bookFiles.bookId, audioBookId), eq(schema.bookFiles.role, 'content')))
      .orderBy(asc(schema.bookFiles.sortOrder), asc(schema.bookFiles.id));

    return rows
      .filter((row) => row.format != null && isAudioFormat(row.format))
      .map((row) => ({ fileId: row.id, durationSeconds: row.durationSeconds }));
  }

  // Same play order as resolveAudioPlayOrder, but also carries the absolute path each audio window is
  // decoded from. The build service both times the audiobook and transcribes from this one list.
  async resolveAudioFilesWithPaths(audioBookId: number): Promise<AudioFileWithPath[]> {
    const rows = await this.db
      .select({
        id: schema.bookFiles.id,
        format: schema.bookFiles.format,
        absolutePath: schema.bookFiles.absolutePath,
        durationSeconds: schema.bookFiles.durationSeconds,
      })
      .from(schema.bookFiles)
      .where(and(eq(schema.bookFiles.bookId, audioBookId), eq(schema.bookFiles.role, 'content')))
      .orderBy(asc(schema.bookFiles.sortOrder), asc(schema.bookFiles.id));

    return rows
      .filter((row) => row.format != null && isAudioFormat(row.format))
      .map((row) => ({ fileId: row.id, absolutePath: row.absolutePath, durationSeconds: row.durationSeconds }));
  }

  // The primary EPUB content file for a book. Only epub is selected, because the spine-text extractor
  // renders the original EPUB and rejects other formats; a kepub-only text record therefore has no
  // ebook here and its pair is cleanly reported unalignable rather than failing mid-build.
  async findEbookFile(textBookId: number): Promise<EbookFileRef | undefined> {
    const [row] = await this.db
      .select({
        id: schema.bookFiles.id,
        absolutePath: schema.bookFiles.absolutePath,
        sizeBytes: schema.bookFiles.sizeBytes,
      })
      .from(schema.bookFiles)
      .where(and(eq(schema.bookFiles.bookId, textBookId), eq(schema.bookFiles.role, 'content'), eq(schema.bookFiles.format, 'epub')))
      .orderBy(asc(schema.bookFiles.sortOrder), asc(schema.bookFiles.id))
      .limit(1);
    return row;
  }

  async getAlignmentByPair(textBookId: number, audioBookId: number): Promise<AudiobookAlignment | undefined> {
    const [row] = await this.db
      .select()
      .from(audiobookAlignment)
      .where(and(eq(audiobookAlignment.textBookId, textBookId), eq(audiobookAlignment.audioBookId, audioBookId)))
      .limit(1);
    return row;
  }

  async upsertAlignment(
    textBookId: number,
    audioBookId: number,
    values: Partial<Omit<NewAudiobookAlignment, 'textBookId' | 'audioBookId'>>,
  ): Promise<AudiobookAlignment> {
    const [row] = await this.db
      .insert(audiobookAlignment)
      .values({ textBookId, audioBookId, ...values })
      .onConflictDoUpdate({
        target: [audiobookAlignment.textBookId, audiobookAlignment.audioBookId],
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    return row!;
  }

  async updateAlignmentProgress(id: number, progress: AlignmentProgress): Promise<void> {
    await this.db
      .update(audiobookAlignment)
      .set({ samplesDone: progress.samplesDone, anchorCount: progress.anchorCount, updatedAt: new Date() })
      .where(eq(audiobookAlignment.id, id));
  }

  async setAlignmentStatus(id: number, status: string, extra?: Partial<NewAudiobookAlignment>): Promise<void> {
    await this.db
      .update(audiobookAlignment)
      .set({ status, ...extra, updatedAt: new Date() })
      .where(eq(audiobookAlignment.id, id));
  }

  async clearAnchors(alignmentId: number): Promise<void> {
    await this.db.delete(audiobookAlignmentAnchor).where(eq(audiobookAlignmentAnchor.alignmentId, alignmentId));
  }

  // On boot, any alignment still marked 'building' was interrupted by a restart or crash (a build runs
  // in-process and cannot survive one). Reset it to 'failed' so the row is retryable instead of leaving
  // the client polling a state that will never advance.
  async failInterruptedBuilds(): Promise<number> {
    const rows = await this.db
      .update(audiobookAlignment)
      .set({ status: 'failed', error: 'build interrupted by a server restart', updatedAt: new Date() })
      .where(eq(audiobookAlignment.status, 'building'))
      .returning({ id: audiobookAlignment.id });
    return rows.length;
  }

  // Idempotent by (alignmentId, audioSeconds): a resumed build re-processes the sample it crashed on,
  // so the re-insert conflicts and is skipped. Returns whether a new row was actually written, so the
  // caller counts anchors from real inserts and never double-counts a re-processed sample.
  async insertAnchor(row: NewAudiobookAlignmentAnchor): Promise<boolean> {
    const inserted = await this.db
      .insert(audiobookAlignmentAnchor)
      .values(row)
      .onConflictDoNothing({ target: [audiobookAlignmentAnchor.alignmentId, audiobookAlignmentAnchor.audioSeconds] })
      .returning({ id: audiobookAlignmentAnchor.id });
    return inserted.length > 0;
  }

  // The true persisted anchor count, so a resume seeds its running total from the rows on disk rather
  // than a checkpoint value that a crash may have left one behind the last inserted anchor.
  async countAnchors(alignmentId: number): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(audiobookAlignmentAnchor)
      .where(eq(audiobookAlignmentAnchor.alignmentId, alignmentId));
    return row?.count ?? 0;
  }

  // Highest spineIndex among a build's existing anchors, so a resumed build keeps the monotonic window
  // moving forward instead of restarting from spine 0.
  async getMaxAnchorSpineIndex(alignmentId: number): Promise<number | null> {
    const [row] = await this.db
      .select({ maxSpineIndex: sql<number | null>`max(${audiobookAlignmentAnchor.spineIndex})` })
      .from(audiobookAlignmentAnchor)
      .where(eq(audiobookAlignmentAnchor.alignmentId, alignmentId));
    return row?.maxSpineIndex ?? null;
  }

  // Highest ebook fraction among a build's existing anchors, so a resumed build keeps the monotonic
  // fraction guard moving forward instead of resetting it and accepting a backward anchor.
  async getMaxAnchorFraction(alignmentId: number): Promise<number | null> {
    const [row] = await this.db
      .select({ maxFraction: sql<number | null>`max(${audiobookAlignmentAnchor.ebookFraction})` })
      .from(audiobookAlignmentAnchor)
      .where(eq(audiobookAlignmentAnchor.alignmentId, alignmentId));
    return row?.maxFraction ?? null;
  }

  // The pair's ready alignment together with its anchors ordered by audioSeconds. Returns undefined
  // when there is no alignment or it is not in the 'ready' status, so a caller never resumes off a
  // half-built or unalignable row.
  async getReadyAlignmentWithAnchors(textBookId: number, audioBookId: number): Promise<ReadyAlignmentWithAnchors | undefined> {
    const [alignment] = await this.db
      .select()
      .from(audiobookAlignment)
      .where(
        and(eq(audiobookAlignment.textBookId, textBookId), eq(audiobookAlignment.audioBookId, audioBookId), eq(audiobookAlignment.status, 'ready')),
      )
      .limit(1);
    if (!alignment) return undefined;

    const anchors = await this.db
      .select()
      .from(audiobookAlignmentAnchor)
      .where(eq(audiobookAlignmentAnchor.alignmentId, alignment.id))
      .orderBy(asc(audiobookAlignmentAnchor.audioSeconds), asc(audiobookAlignmentAnchor.id));

    return { alignment, anchors };
  }

  async backfillAnchorFraction(anchorId: number, fraction: number): Promise<void> {
    await this.db.update(audiobookAlignmentAnchor).set({ ebookFraction: fraction }).where(eq(audiobookAlignmentAnchor.id, anchorId));
  }

  // The user's ebook progress for a specific file, projected to just the fields the resolver needs.
  async getReadingProgress(bookFileId: number, userId: number): Promise<ReadingProgressSnapshot | undefined> {
    const [row] = await this.db
      .select({
        percentage: schema.readingProgress.percentage,
        updatedAt: schema.readingProgress.updatedAt,
        // updatedAt is deliberately frozen by some writers (KOReader); lastReadAt is the honest
        // "when did the user actually read this" ordering column (see the schema comment).
        lastReadAt: schema.readingProgress.lastReadAt,
      })
      .from(schema.readingProgress)
      .where(and(eq(schema.readingProgress.bookFileId, bookFileId), eq(schema.readingProgress.userId, userId)))
      .limit(1);
    return row;
  }

  // The user's own status row for a book: read only to check whether its source actually marked it
  // finished, which gates the movement gate's finished exception.
  async getUserBookStatus(userId: number, bookId: number): Promise<{ status: string } | undefined> {
    const [row] = await this.db
      .select({ status: schema.userBookStatus.status })
      .from(schema.userBookStatus)
      .where(and(eq(schema.userBookStatus.userId, userId), eq(schema.userBookStatus.bookId, bookId)))
      .limit(1);
    return row;
  }

  // The user's audiobook progress for the audio book, projected to just the fields the resolver needs.
  async getAudiobookProgress(userId: number, audioBookId: number): Promise<AudiobookProgressSnapshot | undefined> {
    const [row] = await this.db
      .select({
        currentFileId: schema.audiobookProgress.currentFileId,
        positionSeconds: schema.audiobookProgress.positionSeconds,
        percentage: schema.audiobookProgress.percentage,
        updatedAt: schema.audiobookProgress.updatedAt,
      })
      .from(schema.audiobookProgress)
      .where(and(eq(schema.audiobookProgress.userId, userId), eq(schema.audiobookProgress.bookId, audioBookId)))
      .limit(1);
    return row;
  }

  // Classifies a content file as text or audio so a self-pair (one record with both formats) can tell
  // which side a progress event advanced. Returns null for an unknown or non-alignable format.
  async resolveBookFileKind(bookFileId: number): Promise<'text' | 'audio' | null> {
    const [row] = await this.db
      .select({ format: schema.bookFiles.format })
      .from(schema.bookFiles)
      .where(eq(schema.bookFiles.id, bookFileId))
      .limit(1);
    const format = row?.format;
    if (!format) return null;
    if (isAudioFormat(format)) return 'audio';
    if (TEXT_FILE_FORMATS.has(format.toLowerCase())) return 'text';
    return null;
  }

  // Writes the audio side of an alignment projection with an atomic newest-wins guard: `updatedAt` is
  // the advancing (ebook) side's effective update time, not "now", and `setWhere` ensures a stale
  // projection never overwrites a fresher stored position. Returns true when the row was actually
  // written; a stale projection that loses the race is a no-op, and the caller uses this to avoid
  // touching read status or emitting a display refresh off data the DB just rejected.
  async projectAudiobookProgress(
    userId: number,
    audioBookId: number,
    currentFileId: number,
    positionSeconds: number,
    percentage: number,
    updatedAt: Date,
  ): Promise<boolean> {
    const rows = await this.db
      .insert(schema.audiobookProgress)
      .values({ userId, bookId: audioBookId, currentFileId, positionSeconds, percentage, updatedAt })
      .onConflictDoUpdate({
        target: [schema.audiobookProgress.userId, schema.audiobookProgress.bookId],
        set: { currentFileId, positionSeconds, percentage, updatedAt },
        setWhere: lt(schema.audiobookProgress.updatedAt, updatedAt),
      })
      .returning({ userId: schema.audiobookProgress.userId });
    return rows.length > 0;
  }
}
