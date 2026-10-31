import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import {
  ACHIEVEMENT_EVENT_AUDIO_POSITION_DERIVED,
  ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED,
  AchievementEventsService,
  type BookProgressChangedPayload,
} from '../achievement/achievement-events.service';
import { BookReadService } from '../book/book-read.service';
import { LibraryService } from '../library/library.service';
import { absoluteSecondsToFilePosition, buildAudioTimeline, filePositionToAbsoluteSeconds } from '../../common/utils/audio-timeline.utils';
import { clampToPresent, ebookActivityTime, isProjectedEbookProgress, isStrictlyNewer } from './reading-alignment-freshness.util';
import { alignmentContentChanged } from './reading-alignment-content-hash.util';
import { describeError } from './reading-alignment-error.util';
import { classifyMovement, type MovementState } from './reading-alignment-movement.util';
import type { ReadingAlignmentPair } from './reading-alignment-pair.service';
import { ReadingAlignmentPairService } from './reading-alignment-pair.service';
import type { Anchor } from './reading-alignment-resolver.util';
import { audioSecondsToEbook, ebookFractionToAudioSeconds } from './reading-alignment-resolver.util';
import type { ReadyAlignmentWithAnchors } from './reading-alignment.repository';
import { ReadingAlignmentRepository } from './reading-alignment.repository';
import type { AudiobookAlignmentAnchor } from './schema/reading-alignment.schema';

const SYNC_EVENT = 'reading_alignment.progress_sync';
// Bounds the in-memory movement-state map (one entry per user+pair+side with recent activity).
const MAX_MOVEMENT_STATES = 5000;
// Ceiling on how far ahead of the server clock a device-reported activity time may claim to be.
const MAX_OCCURRED_AT_SKEW_MS = 5 * 60_000;
const MIN_ANCHORS = 2;
const DEFAULT_FINISH_THRESHOLD = 98;
const MAX_PERCENTAGE = 100;

type AdvancedSide = 'ebook' | 'audio';
type ProjectionDirection = 'ebook_to_audio' | 'audio_to_ebook';

// Same-book cross-format progress sync. When one side of an alignment pair advances - from the
// web reader, Kobo, KOReader, or Audiobookshelf - this listener projects the new position onto the
// other side of the pair without duplicating the position math.
@Injectable()
export class ReadingAlignmentSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReadingAlignmentSyncService.name);
  private readonly onProgressChanged = (payload: BookProgressChangedPayload): void => {
    void this.handleProgressChanged(payload);
  };
  private readonly movement = new Map<string, MovementState>();

  constructor(
    private readonly achievementEvents: AchievementEventsService,
    private readonly pairService: ReadingAlignmentPairService,
    private readonly repo: ReadingAlignmentRepository,
    private readonly bookReadService: BookReadService,
    private readonly libraryService: LibraryService,
  ) {}

  onModuleInit(): void {
    this.achievementEvents.on(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, this.onProgressChanged);
  }

  onModuleDestroy(): void {
    this.achievementEvents.removeListener(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, this.onProgressChanged);
  }

  private async handleProgressChanged(payload: BookProgressChangedPayload): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.project(payload, startedAt);
    } catch (error: unknown) {
      const { errorClass, message } = describeError(error);
      this.logger.warn(
        `[${SYNC_EVENT}] [fail] userId=${payload.userId} bookId=${payload.bookId} source=${payload.source} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - progress sync failed`,
      );
    }
  }

  private async project(payload: BookProgressChangedPayload, startedAt: number): Promise<void> {
    const pair = await this.pairService.resolveAlignmentPair(payload.bookId);
    if (!pair) return;

    const ready = await this.repo.getReadyAlignmentWithAnchors(pair.textBookId, pair.audioBookId);
    if (!ready) return;
    // Interpolation needs at least two anchors that carry an ebook fraction. Fractions are backfilled
    // when a user opens the book cross-format; until then we no-op rather than project off partial data.
    const anchors = usableAnchors(ready.anchors);
    if (anchors.length < MIN_ANCHORS) return;

    const side = await this.determineAdvancedSide(payload, ready);
    if (!side) return;

    if (await alignmentContentChanged(this.repo, pair, ready.alignment)) {
      this.logger.debug(
        `[${SYNC_EVENT}] [end] userId=${payload.userId} bookId=${payload.bookId} textBookId=${pair.textBookId} audioBookId=${pair.audioBookId} alignmentId=${ready.alignment.id} durationMs=${Date.now() - startedAt} skipped=alignment_stale - alignment stale, sync paused`,
      );
      return;
    }

    if (side === 'ebook') {
      await this.projectEbookToAudio(payload, pair, ready, anchors);
    } else {
      await this.projectAudioToEbook(payload, pair, ready, anchors);
    }
  }

  // The "actively reading" gate (see reading-alignment-movement.util): classifies the sample AND
  // records it as the new tracking state. Re-setting the key on every
  // event keeps the map in access order, so overflow eviction drops the longest-idle entry.
  private trackMovement(key: string, posSeconds: number, atMs: number): boolean {
    const decision = classifyMovement(this.movement.get(key), posSeconds, atMs);
    this.movement.delete(key);
    if (this.movement.size >= MAX_MOVEMENT_STATES) {
      const oldest = this.movement.keys().next().value;
      if (oldest !== undefined) this.movement.delete(oldest);
    }
    this.movement.set(key, decision.state);
    return decision.accept;
  }

  private logQuarantined(payload: BookProgressChangedPayload, pair: ReadingAlignmentPair, direction: ProjectionDirection, startedAt: number): void {
    this.logger.log(
      `[${SYNC_EVENT}] [end] userId=${payload.userId} bookId=${payload.bookId} textBookId=${pair.textBookId} audioBookId=${pair.audioBookId} direction=${direction} durationMs=${Date.now() - startedAt} skipped=jump_quarantined - sudden position jump held until reading continues from it`,
    );
  }

  private async determineAdvancedSide(payload: BookProgressChangedPayload, ready: ReadyAlignmentWithAnchors): Promise<AdvancedSide | null> {
    if (payload.bookFileId != null) {
      if (ready.alignment.ebookFileId != null && payload.bookFileId === ready.alignment.ebookFileId) return 'ebook';
      const kind = await this.repo.resolveBookFileKind(payload.bookFileId);
      if (kind === 'audio') return 'audio';
      return null;
    }
    return null;
  }

  private async projectEbookToAudio(
    payload: BookProgressChangedPayload,
    pair: ReadingAlignmentPair,
    ready: ReadyAlignmentWithAnchors,
    anchors: Anchor[],
  ): Promise<void> {
    const startedAt = Date.now();
    const ebookFileId = ready.alignment.ebookFileId;
    if (ebookFileId == null) return;

    const ebookProgress = await this.repo.getReadingProgress(ebookFileId, payload.userId);
    if (!ebookProgress) return;

    // Newest-wins: only advance the audio side when the ebook update is strictly newer than the audio
    // side's last real update, so a fresher counterpart position is never clobbered. reading_progress
    // .updatedAt is intentionally frozen by some sources (KOReader), so trust the event's real activity
    // time (occurredAt) when present and fall back to the row's timestamp otherwise.
    // Clamped: a device clock in the future must not poison newest-wins state (see clampToPresent).
    const advancedAt = clampToPresent(payload.occurredAt ?? ebookProgress.updatedAt, MAX_OCCURRED_AT_SKEW_MS);
    const audioProgress = await this.repo.getAudiobookProgress(payload.userId, pair.audioBookId);
    if (!isStrictlyNewer(advancedAt, audioProgress?.updatedAt)) return;

    const timeline = buildAudioTimeline(await this.repo.resolveAudioPlayOrder(pair.audioBookId));
    // An unknown file duration makes every absolute offset unreliable; skip rather than seek the wrong file.
    if (timeline.incomplete || timeline.entries.length === 0 || timeline.totalSeconds <= 0) return;

    // A finished ebook snaps the audio to the very end, even when the last anchor stops short of it, so a
    // completed pair never leaves the counterpart parked mid-book.
    const finished = await this.isFinished(pair.textBookId, ebookProgress.percentage);
    const audioSeconds = finished ? timeline.totalSeconds : ebookFractionToAudioSeconds(anchors, ebookProgress.percentage / 100);
    if (audioSeconds == null) return;

    if (!this.trackMovement(`${payload.userId}:${pair.audioBookId}:ebook`, audioSeconds, advancedAt.getTime())) {
      if (!finished || !(await this.isMarkedRead(payload.userId, pair.textBookId))) {
        return this.logQuarantined(payload, pair, 'ebook_to_audio', startedAt);
      }
      // A confirmed completion keeps its outcome while the position write stays gated.
      return this.logEnd(payload, pair, 'ebook_to_audio', MAX_PERCENTAGE, startedAt);
    }

    const { fileId, positionSeconds } = absoluteSecondsToFilePosition(timeline, audioSeconds);
    // The denominator is deliberately the sum of the file durations, because the anchors this position
    // comes from are built against that same file timeline. It differs from the player's percentage only
    // when book_metadata.duration_seconds has been overridden, which the player prefers over the sum.
    const audioPercentage = finished ? MAX_PERCENTAGE : clampPercentage((audioSeconds / timeline.totalSeconds) * 100);

    this.logStart(payload, pair, 'ebook_to_audio');
    // The write may be a no-op if a concurrent fresher counterpart write beat it (setWhere guard). Only
    // sync status when the position actually changed, so it never runs off stale data. This projection
    // deliberately does NOT re-emit a progress event: doing so drove external trackers (Storygraph /
    // Hardcover) and achievement evaluation off derived, non-user progress. Real per-format activity
    // still emits its own events; the counterpart's status change is broadcast by the status path below.
    // The narrower derived-position event lets outbound position sync (Audiobookshelf) pick up this
    // write, which can land after the push already ran for the triggering progress event.
    const applied = await this.repo.projectAudiobookProgress(payload.userId, pair.audioBookId, fileId, positionSeconds, audioPercentage, advancedAt);
    if (!applied) return this.logSkippedStale(payload, pair, 'ebook_to_audio', startedAt);
    this.achievementEvents.emit(ACHIEVEMENT_EVENT_AUDIO_POSITION_DERIVED, { userId: payload.userId, bookId: pair.audioBookId });

    this.logEnd(payload, pair, 'ebook_to_audio', audioPercentage, startedAt);
  }

  // Audio advancing writes a percentage-only projection onto the ebook row, marked by the fork-owned
  // alignment_projected_at column, so every view of the ebook's own progress agrees with the audiobook.
  // The stored CFI is never touched, so the reader keeps its precise position and its Undo target. On
  // update the row's updated_at and last_read_at are left alone, so the projection carries no reading
  // activity: the open-time resolver still sees the audiobook as the fresher side and jumps to the exact
  // narrated phrase. A real read bumps last_read_at past the projection time and the row is a real read
  // again.
  private async projectAudioToEbook(
    payload: BookProgressChangedPayload,
    pair: ReadingAlignmentPair,
    ready: ReadyAlignmentWithAnchors,
    anchors: Anchor[],
  ): Promise<void> {
    const startedAt = Date.now();
    const ebookFileId = ready.alignment.ebookFileId;
    if (ebookFileId == null) return;

    const audioProgress = await this.repo.getAudiobookProgress(payload.userId, pair.audioBookId);
    if (!audioProgress) return;

    // audiobook_progress.updatedAt is reliably stamped by every audio writer, so the row time is a
    // sound fallback; occurredAt still wins when a source reports a real activity time.
    const advancedAt = clampToPresent(payload.occurredAt ?? audioProgress.updatedAt, MAX_OCCURRED_AT_SKEW_MS);
    const ebookProgress = await this.repo.getReadingProgress(ebookFileId, payload.userId);
    // A projection is compared against its own projection time, so a re-delivered or out-of-order audio
    // event is a no-op. A real read is compared against its real activity, so an actively re-read ebook
    // is never dragged forward by stale audio events.
    const ebookActiveAt =
      ebookProgress && isProjectedEbookProgress(ebookProgress) ? ebookProgress.alignmentProjectedAt! : ebookActivityTime(ebookProgress);
    if (!isStrictlyNewer(advancedAt, ebookActiveAt)) return;

    const timeline = buildAudioTimeline(await this.repo.resolveAudioPlayOrder(pair.audioBookId));
    if (timeline.incomplete || timeline.entries.length === 0) return;

    // A finished audiobook marks the ebook complete at 100% even when anchor coverage stops short.
    const finished = await this.isFinished(pair.audioBookId, audioProgress.percentage);
    const absoluteSeconds = filePositionToAbsoluteSeconds(timeline, audioProgress.currentFileId, audioProgress.positionSeconds);
    if (!this.trackMovement(`${payload.userId}:${pair.audioBookId}:audio`, absoluteSeconds, advancedAt.getTime())) {
      if (!finished || !(await this.isMarkedRead(payload.userId, pair.audioBookId))) {
        return this.logQuarantined(payload, pair, 'audio_to_ebook', startedAt);
      }
      return this.logEnd(payload, pair, 'audio_to_ebook', MAX_PERCENTAGE, startedAt);
    }

    const resolution = audioSecondsToEbook(anchors, absoluteSeconds);
    if (!resolution) return;

    const ebookPercentage = finished ? MAX_PERCENTAGE : resolution.percentage;
    // Never store a future projection time: a real read inside the skew window must un-project the row.
    const projectedAt = clampToPresent(advancedAt, 0);

    this.logStart(payload, pair, 'audio_to_ebook');
    // No progress event follows this write: its listeners (achievements, Storygraph, Hardcover, the
    // Audiobookshelf push) must run off real activity only, and the client already refreshes off the
    // audiobook's own event.
    const applied = await this.repo.projectReadingProgress(payload.userId, ebookFileId, ebookPercentage, projectedAt);
    if (!applied) return this.logSkippedStale(payload, pair, 'audio_to_ebook', startedAt);

    this.logEnd(payload, pair, 'audio_to_ebook', ebookPercentage, startedAt);
  }

  // The finished exception only fires when the advancing book's own source has actually marked it
  // read - a bare percentage over the threshold can be a scrub parked near the end.
  private async isMarkedRead(userId: number, bookId: number): Promise<boolean> {
    const status = await this.repo.getUserBookStatus(userId, bookId);
    return status?.status === 'read';
  }

  private async isFinished(bookId: number, percentage: number): Promise<boolean> {
    const libraryId = await this.bookReadService.findLibraryIdByBookId(bookId);
    if (libraryId == null) return false;
    const library = await this.libraryService.findOne(libraryId);
    const threshold = library.markAsFinishedPercentComplete ?? DEFAULT_FINISH_THRESHOLD;
    return percentage >= threshold;
  }

  private logStart(payload: BookProgressChangedPayload, pair: ReadingAlignmentPair, direction: ProjectionDirection): void {
    this.logger.log(
      `[${SYNC_EVENT}] [start] userId=${payload.userId} bookId=${payload.bookId} textBookId=${pair.textBookId} audioBookId=${pair.audioBookId} direction=${direction} source=${payload.source} - projecting progress`,
    );
  }

  private logEnd(
    payload: BookProgressChangedPayload,
    pair: ReadingAlignmentPair,
    direction: ProjectionDirection,
    counterpartPercentage: number,
    startedAt: number,
  ): void {
    this.logger.log(
      `[${SYNC_EVENT}] [end] userId=${payload.userId} bookId=${payload.bookId} textBookId=${pair.textBookId} audioBookId=${pair.audioBookId} direction=${direction} durationMs=${Date.now() - startedAt} counterpartPercentage=${counterpartPercentage.toFixed(2)} - progress projected`,
    );
  }

  private logSkippedStale(payload: BookProgressChangedPayload, pair: ReadingAlignmentPair, direction: ProjectionDirection, startedAt: number): void {
    this.logger.log(
      `[${SYNC_EVENT}] [end] userId=${payload.userId} bookId=${payload.bookId} textBookId=${pair.textBookId} audioBookId=${pair.audioBookId} direction=${direction} durationMs=${Date.now() - startedAt} skipped=stale - a fresher counterpart write won the race`,
    );
  }
}

function usableAnchors(rows: readonly AudiobookAlignmentAnchor[]): Anchor[] {
  const anchors: Anchor[] = [];
  for (const row of rows) {
    if (row.ebookFraction == null || !Number.isFinite(row.ebookFraction)) continue;
    anchors.push({ audioSeconds: row.audioSeconds, ebookFraction: row.ebookFraction, spineIndex: row.spineIndex, phrase: row.phrase });
  }
  return anchors;
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > MAX_PERCENTAGE) return MAX_PERCENTAGE;
  return value;
}
