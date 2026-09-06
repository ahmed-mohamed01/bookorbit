import { ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import {
  ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED,
  AchievementEventsService,
  type BookProgressChangedPayload,
} from '../achievement/achievement-events.service';
import { BookReadService } from '../book/book-read.service';
import { BookService } from '../book/book.service';
import { LibraryService } from '../library/library.service';
import { UserService } from '../user/user.service';
import { absoluteSecondsToFilePosition, buildAudioTimeline, filePositionToAbsoluteSeconds } from './reading-alignment-audio-timeline.util';
import { clampToPresent, isStrictlyNewer } from './reading-alignment-freshness.util';
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
const RECONCILE_EVENT = 'reading_alignment.reconcile';
// Bounds the in-memory movement-state map (one entry per user+pair+side with recent activity).
const MAX_MOVEMENT_STATES = 5000;
// Ceiling on how far ahead of the server clock a device-reported activity time may claim to be.
const MAX_OCCURRED_AT_SKEW_MS = 5 * 60_000;
// Match-time reconcile refuses to force-complete an ebook the user actually read this recently while
// still mid-book: audiobook_progress.updatedAt is a server write time, so a fresh import can fake
// recency, and active reading is the ground truth.
const RECENT_EBOOK_ACTIVITY_MS = 7 * 24 * 3_600_000;
const ESTABLISHED_EBOOK_PERCENTAGE = 90;
const MIN_ANCHORS = 2;
const DEFAULT_FINISH_THRESHOLD = 98;
const MAX_PERCENTAGE = 100;

type AdvancedSide = 'ebook' | 'audio';
type ProjectionDirection = 'ebook_to_audio' | 'audio_to_ebook';

// Source-agnostic cross-record progress sync. When one side of an alignment pair advances - from the
// web reader, Kobo, KOReader, or Audiobookshelf - this listener projects the new position onto the
// other side of the pair and keeps read status in sync, without re-reimplementing the position math.
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
    private readonly bookService: BookService,
    private readonly userService: UserService,
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
      await this.project(payload);
    } catch (error: unknown) {
      const { errorClass, message } = describeError(error);
      this.logger.warn(
        `[${SYNC_EVENT}] [fail] userId=${payload.userId} bookId=${payload.bookId} source=${payload.source} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - progress sync failed`,
      );
    }
  }

  private async project(payload: BookProgressChangedPayload): Promise<void> {
    const pair = await this.pairService.resolveAlignmentPair(payload.bookId);
    if (!pair) return;

    const ready = await this.repo.getReadyAlignmentWithAnchors(pair.textBookId, pair.audioBookId);
    if (!ready) return;

    // Interpolation needs at least two anchors that carry an ebook fraction. Fractions are backfilled
    // when a user opens the book cross-format; until then we no-op rather than project off partial data.
    const anchors = usableAnchors(ready.anchors);
    if (anchors.length < MIN_ANCHORS) return;

    const side = await this.determineAdvancedSide(payload, pair, ready);
    if (!side) return;

    // For a linked pair we write progress onto the counterpart record; never do so for a book the user
    // can no longer access (library access can change after a link is created). A self-pair writes onto
    // the same record the event already came from, so no extra check is needed there.
    if (pair.textBookId !== pair.audioBookId) {
      const counterpartBookId = side === 'ebook' ? pair.audioBookId : pair.textBookId;
      if (!(await this.userCanAccess(payload.userId, counterpartBookId))) return;
    }

    if (side === 'ebook') {
      await this.projectEbookToAudio(payload, pair, ready, anchors);
    } else {
      await this.projectAudioToEbook(payload, pair, ready, anchors);
    }
  }

  // One-shot reconcile for when a pair first becomes alignable (link created + alignment ready). The
  // audiobook is the preferred side, but it only pulls the ebook's reading state forward when it is
  // BOTH the more recently active side AND positionally ahead; an ebook with newer activity is left
  // untouched until real listening resumes. Never writes a position - the ebook keeps its own CFI and
  // the open-time resolver provides the precise jump.
  async reconcilePairOnReady(pair: ReadingAlignmentPair, userId: number): Promise<void> {
    const startedAt = Date.now();
    try {
      if (pair.textBookId === pair.audioBookId) return;

      this.logger.log(
        `[${RECONCILE_EVENT}] [start] userId=${userId} textBookId=${pair.textBookId} audioBookId=${pair.audioBookId} - reconcile started`,
      );

      const ready = await this.repo.getReadyAlignmentWithAnchors(pair.textBookId, pair.audioBookId);
      if (!ready || ready.alignment.ebookFileId == null) return this.logReconcileEnd(pair, userId, startedAt, 'not_ready');
      const anchors = usableAnchors(ready.anchors);
      if (anchors.length < MIN_ANCHORS) return this.logReconcileEnd(pair, userId, startedAt, 'too_few_anchors');

      const [audioProgress, ebookProgress] = await Promise.all([
        this.repo.getAudiobookProgress(userId, pair.audioBookId),
        this.repo.getReadingProgress(ready.alignment.ebookFileId, userId),
      ]);
      if (!audioProgress) return this.logReconcileEnd(pair, userId, startedAt, 'no_audio_progress');
      // A 0% row (e.g. an untouched ABS import) must not clamp to the first anchor and flip an
      // unread ebook to "reading".
      if (audioProgress.percentage <= 0) return this.logReconcileEnd(pair, userId, startedAt, 'audio_not_started');
      // KOReader deliberately freezes reading_progress.updatedAt, so ebook recency must come from
      // lastReadAt - the honest last-actually-read column - with updatedAt as a safety fallback.
      const ebookActiveAt = ebookProgress ? (ebookProgress.lastReadAt ?? ebookProgress.updatedAt) : undefined;
      if (ebookActiveAt && !isStrictlyNewer(audioProgress.updatedAt, ebookActiveAt)) {
        return this.logReconcileEnd(pair, userId, startedAt, 'ebook_newer');
      }

      const timeline = buildAudioTimeline(await this.repo.resolveAudioPlayOrder(pair.audioBookId));
      if (timeline.incomplete || timeline.entries.length === 0) return this.logReconcileEnd(pair, userId, startedAt, 'incomplete_timeline');

      const absoluteSeconds = filePositionToAbsoluteSeconds(timeline, audioProgress.currentFileId, audioProgress.positionSeconds);
      const resolution = audioSecondsToEbook(anchors, absoluteSeconds);
      if (!resolution) return this.logReconcileEnd(pair, userId, startedAt, 'unresolvable_position');

      // A finished audiobook counts as fully ahead even when its last anchor maps short of 100% -
      // but only when its source actually marked it read; a bare percentage can be a parked scrub.
      const finished = (await this.isFinished(pair.audioBookId, audioProgress.percentage)) && (await this.isMarkedRead(userId, pair.audioBookId));
      const projectedPercentage = finished ? MAX_PERCENTAGE : resolution.percentage;
      if (projectedPercentage <= (ebookProgress?.percentage ?? 0)) {
        return this.logReconcileEnd(pair, userId, startedAt, 'audio_not_ahead');
      }

      if (
        projectedPercentage >= MAX_PERCENTAGE &&
        ebookProgress &&
        ebookProgress.percentage < ESTABLISHED_EBOOK_PERCENTAGE &&
        Date.now() - (ebookProgress.lastReadAt ?? ebookProgress.updatedAt).getTime() < RECENT_EBOOK_ACTIVITY_MS
      ) {
        return this.logReconcileEnd(pair, userId, startedAt, 'ebook_recently_active');
      }

      if (!(await this.userCanAccess(userId, pair.textBookId))) return this.logReconcileEnd(pair, userId, startedAt, 'no_access');

      await this.syncCounterpartStatus(userId, pair.textBookId, pair.audioBookId, audioProgress.percentage, projectedPercentage);
      this.logReconcileEnd(pair, userId, startedAt, 'ebook_status_updated');
    } catch (error: unknown) {
      const { errorClass, message } = describeError(error);
      this.logger.warn(
        `[${RECONCILE_EVENT}] [fail] userId=${userId} textBookId=${pair.textBookId} audioBookId=${pair.audioBookId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - reconcile failed`,
      );
    }
  }

  private logReconcileEnd(pair: ReadingAlignmentPair, userId: number, startedAt: number, outcome: string): void {
    this.logger.log(
      `[${RECONCILE_EVENT}] [end] userId=${userId} textBookId=${pair.textBookId} audioBookId=${pair.audioBookId} durationMs=${Date.now() - startedAt} outcome=${outcome} - reconcile completed`,
    );
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

  private async userCanAccess(userId: number, bookId: number): Promise<boolean> {
    const user = await this.userService.findByIdWithPermissions(userId);
    if (!user) return false;
    try {
      // Content-filter-aware, matching the edition-link routes: a counterpart hidden by the user's
      // content filters (or no longer in an accessible library) must not receive projected progress.
      await this.bookService.verifyBookAccess(bookId, user);
      return true;
    } catch (error) {
      // A genuine denial (Forbidden) or a book filtered/absent for this user (NotFound) means skip. A
      // transient error (e.g. DB blip) must not be mistaken for no-access; let it surface as a failure.
      if (error instanceof ForbiddenException || error instanceof NotFoundException) return false;
      throw error;
    }
  }

  // For a linked pair the bookId names the side. For a self-pair (one record, both formats) it cannot,
  // so we read the file the event carried; a book-level event with no file is ambiguous and skipped
  // rather than guessed from the source.
  private async determineAdvancedSide(
    payload: BookProgressChangedPayload,
    pair: ReadingAlignmentPair,
    ready: ReadyAlignmentWithAnchors,
  ): Promise<AdvancedSide | null> {
    if (pair.textBookId !== pair.audioBookId) {
      if (payload.bookId === pair.textBookId) return 'ebook';
      if (payload.bookId === pair.audioBookId) return 'audio';
      return null;
    }

    if (payload.bookFileId != null) {
      if (ready.alignment.ebookFileId != null && payload.bookFileId === ready.alignment.ebookFileId) return 'ebook';
      const kind = await this.repo.resolveBookFileKind(payload.bookFileId);
      if (kind === 'text') return 'ebook';
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
      // Finished is the one jump honored while unconfirmed: the source has actually marked the book
      // read (a bare percentage can be a scrub parked near the end), it may never emit another event
      // to confirm with, and a status-only completion cannot corrupt a position. The position write
      // below stays gated.
      await this.syncCounterpartStatus(payload.userId, pair.audioBookId, pair.textBookId, ebookProgress.percentage, MAX_PERCENTAGE);
      return this.logEnd(payload, pair, 'ebook_to_audio', MAX_PERCENTAGE, startedAt);
    }

    const { fileId, positionSeconds } = absoluteSecondsToFilePosition(timeline, audioSeconds);
    const audioPercentage = finished ? MAX_PERCENTAGE : clampPercentage((audioSeconds / timeline.totalSeconds) * 100);

    this.logStart(payload, pair, 'ebook_to_audio');
    // The write may be a no-op if a concurrent fresher counterpart write beat it (setWhere guard). Only
    // sync status when the position actually changed, so it never runs off stale data. This projection
    // deliberately does NOT re-emit a progress event: doing so drove external trackers (Storygraph /
    // Hardcover) and achievement evaluation off derived, non-user progress. Real per-format activity
    // still emits its own events; the counterpart's status change is broadcast by the status path below.
    const applied = await this.repo.projectAudiobookProgress(payload.userId, pair.audioBookId, fileId, positionSeconds, audioPercentage, advancedAt);
    if (!applied) return this.logSkippedStale(payload, pair, 'ebook_to_audio', startedAt);
    await this.syncCounterpartStatus(payload.userId, pair.audioBookId, pair.textBookId, ebookProgress.percentage, audioPercentage);
    this.logEnd(payload, pair, 'ebook_to_audio', audioPercentage, startedAt);
  }

  // Audio advancing deliberately does NOT write a position onto the ebook row. A coarse percentage
  // projected here would (a) clobber the reader's precise CFI and (b) stamp the ebook row with the
  // audio activity time, which defeats the open-time cross-format resolver's newest-wins check and
  // leaves it unable to fire. Instead the ebook keeps its own last-read position, and the resolver
  // provides a precise phrase-based resume when the ebook is opened. Only read-status is kept in sync
  // here so finishing (or starting) the audiobook still advances the ebook's status.
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
    // KOReader freezes reading_progress.updatedAt; lastReadAt carries the real reading recency, so
    // an actively re-read ebook is never dragged forward by stale audio events.
    const ebookActiveAt = ebookProgress ? (ebookProgress.lastReadAt ?? ebookProgress.updatedAt) : undefined;
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
      // Finished-and-marked-read skips the gate for this status-only direction (see the twin above).
      await this.syncCounterpartStatus(payload.userId, pair.textBookId, pair.audioBookId, audioProgress.percentage, MAX_PERCENTAGE);
      return this.logEnd(payload, pair, 'audio_to_ebook', MAX_PERCENTAGE, startedAt);
    }

    const resolution = audioSecondsToEbook(anchors, absoluteSeconds);
    if (!resolution) return;

    const ebookPercentage = finished ? MAX_PERCENTAGE : resolution.percentage;

    this.logStart(payload, pair, 'audio_to_ebook');
    await this.syncCounterpartStatus(payload.userId, pair.textBookId, pair.audioBookId, audioProgress.percentage, ebookPercentage);
    this.logEnd(payload, pair, 'audio_to_ebook', ebookPercentage, startedAt);
  }

  // Reuses the book module's status path so thresholds, manual-override guards, and status events all
  // behave exactly like a first-party progress write. A self-pair shares one status row, so there is
  // nothing to project; when the advancing side is finished the counterpart is forced complete even if
  // anchor coverage stops short of the very end.
  private async syncCounterpartStatus(
    userId: number,
    counterpartBookId: number,
    advancingBookId: number,
    advancingPercentage: number,
    counterpartPercentage: number,
  ): Promise<void> {
    if (counterpartBookId === advancingBookId) return;

    const counterpartLibraryId = await this.bookReadService.findLibraryIdByBookId(counterpartBookId);
    if (counterpartLibraryId == null) return;

    const advancingFinished = await this.isFinished(advancingBookId, advancingPercentage);
    const statusPercentage = advancingFinished ? MAX_PERCENTAGE : counterpartPercentage;
    await this.bookService.autoUpdateReadStatusForProgress(userId, { bookId: counterpartBookId, libraryId: counterpartLibraryId }, statusPercentage);
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
