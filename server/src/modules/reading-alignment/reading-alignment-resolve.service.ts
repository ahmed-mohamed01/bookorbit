import { Injectable, Logger } from '@nestjs/common';

import type { RequestUser } from '../../common/types/request-user';
import { BookService } from '../book/book.service';
import { EpubService } from '../reader/epub/epub.service';
import { buildAudioTimeline, filePositionToAbsoluteSeconds } from './reading-alignment-audio-timeline.util';
import { alignmentContentChanged } from './reading-alignment-content-hash.util';
import { computeAnchorFraction } from './reading-alignment-fraction.util';
import { ebookActivityTime, type EbookProgressActivity, isStrictlyNewer } from './reading-alignment-freshness.util';
import type { ReadingAlignmentPair } from './reading-alignment-pair.service';
import { ReadingAlignmentPairService } from './reading-alignment-pair.service';
import type { Anchor } from './reading-alignment-resolver.util';
import { audioSecondsToEbook } from './reading-alignment-resolver.util';
import { ReadingAlignmentRepository } from './reading-alignment.repository';
import type { AudiobookAlignmentAnchor } from './schema/reading-alignment.schema';

export type CrossFormatResume = { available: false } | { available: true; source: 'audio'; spineIndex: number; phrase: string; percentage: number };

const RESOLVE_EVENT = 'reading_alignment.resolve_resume';
const MIN_ANCHORS = 2;
const UNAVAILABLE: CrossFormatResume = { available: false };

@Injectable()
export class ReadingAlignmentResolveService {
  private readonly logger = new Logger(ReadingAlignmentResolveService.name);

  constructor(
    private readonly repo: ReadingAlignmentRepository,
    private readonly epub: EpubService,
    private readonly bookService: BookService,
    private readonly pairService: ReadingAlignmentPairService,
  ) {}

  // Resolve where to resume in the ebook when audiobook progress is strictly newer. Read-only: no
  // progress is written here and nothing is persisted beyond backfilling missing anchor fractions (the
  // live ebook projection is written by the sync service, never by this resolver).
  async resolveResume(bookId: number, user: RequestUser): Promise<CrossFormatResume> {
    const startedAt = Date.now();
    this.logger.log(`[${RESOLVE_EVENT}] [start] bookId=${bookId} userId=${user.id} - cross-format resume started`);

    await this.assertAccess(bookId, user);
    const pair = await this.pairService.resolveAlignmentPair(bookId);
    if (!pair) {
      return this.done(startedAt, bookId, null, UNAVAILABLE);
    }
    await this.assertPairAccess(pair, bookId, user);

    const ready = await this.repo.getReadyAlignmentWithAnchors(pair.textBookId, pair.audioBookId);
    if (!ready || ready.anchors.length < MIN_ANCHORS) {
      return this.done(startedAt, bookId, pair, UNAVAILABLE);
    }

    const { alignment } = ready;
    if (await alignmentContentChanged(this.repo, pair, alignment)) {
      return this.done(startedAt, bookId, pair, UNAVAILABLE, `alignmentId=${alignment.id} skipped=alignment_stale`);
    }
    const ebookFileId = alignment.ebookFileId;

    const anchors = await this.resolveAnchors(pair.textBookId, ebookFileId, user, ready.anchors);
    if (anchors.length < MIN_ANCHORS) {
      return this.done(startedAt, bookId, pair, UNAVAILABLE);
    }

    const ebookProgress = ebookFileId != null ? await this.repo.getReadingProgress(ebookFileId, user.id) : undefined;
    const audioProgress = await this.repo.getAudiobookProgress(user.id, pair.audioBookId);

    const result = await this.resolveEbookResume(pair.audioBookId, anchors, ebookProgress, audioProgress);

    return this.done(startedAt, bookId, pair, result);
  }

  // Ensure every anchor carries a usable ebookFraction, enforcing library access along the way.
  // When any fraction is missing, the spine text is extracted once (which enforces access) and the
  // missing fractions are computed and persisted; anchors whose phrase cannot be located are dropped.
  // When nothing needs backfilling, an explicit cheap access check runs instead so a caller can never
  // read another user's alignment.
  private async resolveAnchors(bookId: number, ebookFileId: number | null, user: RequestUser, rows: AudiobookAlignmentAnchor[]): Promise<Anchor[]> {
    const needsBackfill = rows.some((row) => row.ebookFraction == null);

    if (!needsBackfill) {
      await this.assertAccess(bookId, user);
      return rows.filter(hasAnchorFraction).map(toAnchor);
    }

    const spines = await this.epub.extractSpineText(bookId, ebookFileId ?? undefined, user);

    const anchors: Anchor[] = [];
    for (const row of rows) {
      if (hasAnchorFraction(row)) {
        anchors.push(toAnchor(row));
        continue;
      }
      const fraction = computeAnchorFraction(spines, row.spineIndex, row.phrase);
      if (fraction == null) continue;
      await this.repo.backfillAnchorFraction(row.id, fraction);
      anchors.push({ audioSeconds: row.audioSeconds, ebookFraction: fraction, spineIndex: row.spineIndex, phrase: row.phrase });
    }
    return anchors;
  }

  private async resolveEbookResume(
    audioBookId: number,
    anchors: Anchor[],
    ebookProgress: EbookProgressActivity | undefined,
    audioProgress: { currentFileId: number; positionSeconds: number; updatedAt: Date } | undefined,
  ): Promise<CrossFormatResume> {
    if (!audioProgress) return UNAVAILABLE;
    // A real read is compared by its real recency (lastReadAt, since KOReader freezes updatedAt), so a
    // user actively re-reading is never yanked forward to a stale audio position. A projected row is
    // where the audiobook already put the ebook, so the audiobook is the fresher side by definition and
    // the precise phrase resume stays available.
    const ebookActiveAt = ebookActivityTime(ebookProgress);
    if (!isStrictlyNewer(audioProgress.updatedAt, ebookActiveAt)) return UNAVAILABLE;

    const timeline = buildAudioTimeline(await this.repo.resolveAudioPlayOrder(audioBookId));
    if (timeline.incomplete || timeline.entries.length === 0) return UNAVAILABLE;

    const absoluteSeconds = filePositionToAbsoluteSeconds(timeline, audioProgress.currentFileId, audioProgress.positionSeconds);
    const resolution = audioSecondsToEbook(anchors, absoluteSeconds);
    if (!resolution) return UNAVAILABLE;

    return { available: true, source: 'audio', spineIndex: resolution.spineIndex, phrase: resolution.phrase, percentage: resolution.percentage };
  }

  private async assertAccess(bookId: number, user: RequestUser): Promise<void> {
    // verifyBookAccess is content-filter aware (unlike a bare library check), so a hidden book cannot
    // have its cross-format phrases or positions read by a user it is filtered from.
    await this.bookService.verifyBookAccess(bookId, user);
  }

  private async assertPairAccess(pair: ReadingAlignmentPair, requestedBookId: number, user: RequestUser): Promise<void> {
    const counterpartIds = new Set([pair.textBookId, pair.audioBookId]);
    counterpartIds.delete(requestedBookId);
    await Promise.all([...counterpartIds].map((bookId) => this.assertAccess(bookId, user)));
  }

  private done(startedAt: number, bookId: number, pair: ReadingAlignmentPair | null, result: CrossFormatResume, skip?: string): CrossFormatResume {
    const pairFields = pair ? ` textBookId=${pair.textBookId} audioBookId=${pair.audioBookId}` : '';
    const skipFields = skip ? ` ${skip}` : '';
    this.logger.log(
      `[${RESOLVE_EVENT}] [end] bookId=${bookId}${pairFields} durationMs=${Date.now() - startedAt}${skipFields} available=${result.available} - cross-format resume completed`,
    );
    return result;
  }
}

type ResolvedAnchorRow = AudiobookAlignmentAnchor & { ebookFraction: number };

function hasAnchorFraction(row: AudiobookAlignmentAnchor): row is ResolvedAnchorRow {
  return row.ebookFraction != null;
}

function toAnchor(row: ResolvedAnchorRow): Anchor {
  return { audioSeconds: row.audioSeconds, ebookFraction: row.ebookFraction, spineIndex: row.spineIndex, phrase: row.phrase };
}
