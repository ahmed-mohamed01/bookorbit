import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { isAudioFormat, type AudiobookshelfSyncResult, type ReadStatus } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { toDateKeyInTimeZone } from '../../common/utils/timezone.utils';
import { ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, AchievementEventsService } from '../achievement/achievement-events.service';
import { LibraryService } from '../library/library.service';
import { ReadingAttemptService } from '../user-book-status/reading-attempt.service';
import { UserBookStatusService } from '../user-book-status/user-book-status.service';
import { AudiobookshelfApiError, AudiobookshelfClientService, type AbsMediaProgress } from './audiobookshelf-client.service';
import { AudiobookshelfMatchService } from './audiobookshelf-match.service';
import { AudiobookshelfRepository } from './audiobookshelf.repository';
import { AudiobookshelfSessionsService } from './audiobookshelf-sessions.service';
import { buildBookAccessScope, describeError, isAbsSyncConfigured, resolveUserTimeZone } from './audiobookshelf-user.utils';
import {
  AUDIOBOOKSHELF_DURATION_TOLERANCE_BASE_SECONDS,
  AUDIOBOOKSHELF_DURATION_TOLERANCE_PER_FILE_SECONDS,
  AUDIOBOOKSHELF_DURATION_TOLERANCE_RELATIVE,
} from './audiobookshelf.constants';
import type { AudiobookshelfBookState } from './schema/audiobookshelf.schema';

export interface AudiobookshelfSyncOptions {
  // Re-apply every linked book even when ABS has not advanced past the last-synced watermark. Used
  // by full resync to re-baseline state after a toggle change.
  force?: boolean;
  // Run the deep reconciliation scan (full re-pagination) as the sessions phase instead of the
  // incremental watermark path.
  deepSessions?: boolean;
  // Reconcile the full ABS inventory (match new items) this run. Decoupled from the frequent progress
  // poll: only a fresh connection or an explicit rescan reconciles. Defaults to fresh-detection.
  reconcile?: boolean;
  // Hot tier: apply position/status for only the books currently in progress in ABS ("Continue
  // Listening"), skipping reconcile and the session ingest. Runs on a fast cadence for near-live
  // position; the full poll still handles finished books, sessions, and matching.
  hotInProgressOnly?: boolean;
  // Warm tier: hot-tier ticks set this at most every 90s to also ingest incremental sessions for
  // in-progress books (position still runs every 30s hot tick). Only ingests when a book is actually
  // in progress this run; never runs the deep scan.
  warmSessions?: boolean;
}

// Bounds the per-process duration-warning dedupe map (see `logDurationWarning`) across many users;
// cleared wholesale rather than evicted individually since a stale entry only costs one extra warn.
const DURATION_WARNING_SIGNATURE_CAP = 10_000;

// Upgrade-only ranking. A sync may promote a book toward completion but never move it backward.
// `abandoned` is terminal: in-progress ABS state never resurrects it, but `isFinished` still promotes to `read`.
const COMPLETION_RANK: Record<ReadStatus, number> = {
  unread: 0,
  want_to_read: 0,
  reading: 1,
  on_hold: 1,
  rereading: 1,
  skimmed: 2,
  read: 3,
  abandoned: 3,
};

export function resolveAbsTargetStatus(current: ReadStatus, isFinished: boolean): ReadStatus | null {
  if (current === 'abandoned') return isFinished ? 'read' : null;
  if (isFinished) return COMPLETION_RANK[current] >= 3 ? null : 'read';
  // ABS reports active playback. A finished book being listened to again is a reread: surface it as
  // active rather than leaving the status contradicting the in-progress attempt ABS already opened.
  // updateManual -> applyManualStatus adopts that attempt and projects reading vs rereading itself.
  if (current === 'read') return 'rereading';
  return COMPLETION_RANK[current] >= 1 ? null : 'reading';
}

export function resolveAbsPosition(
  files: { id: number; durationSeconds: number | null }[],
  currentTime: number,
): { currentFileId: number; positionSeconds: number } | null {
  if (files.length === 0) return null;
  const target = Math.max(0, currentTime);
  let cumulative = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const dur = file.durationSeconds ?? 0;
    const isLast = i === files.length - 1;
    if (target < cumulative + dur || isLast) {
      return { currentFileId: file.id, positionSeconds: Math.max(0, Math.min(target - cumulative, dur)) };
    }
    cumulative += dur;
  }
  const last = files[files.length - 1]!;
  return { currentFileId: last.id, positionSeconds: last.durationSeconds ?? 0 };
}

function msToDateKey(ms: number | null | undefined, timeZone: string): string | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  return toDateKeyInTimeZone(new Date(ms), timeZone);
}

interface AbsDueBook {
  mp: AbsMediaProgress;
  state: AudiobookshelfBookState;
  bookId: number;
  statusDue: boolean;
  positionDue: boolean;
}

/**
 * Everything the per-book apply step reads, fetched in one batched query per kind before the loop
 * instead of per book. Writes stay per-book (they are conditional), so the maps are kept
 * write-through: two ABS items can link to the same book, and a repeat pass must observe the write
 * the earlier one made, exactly as the per-book reads did.
 */
interface AbsSyncPreload {
  audioFilesByBookId: Map<number, { id: number; format: string | null; durationSeconds: number | null }[]>;
  audioProgressByBookId: Map<number, { percentage: number; updatedAt: Date }>;
}

@Injectable()
export class AudiobookshelfSyncService {
  private readonly logger = new Logger(AudiobookshelfSyncService.name);
  private readonly runningUsers = new Set<number>();
  // Last warned position-skip signature per "userId:bookId", so the hot tier's 30s cadence doesn't
  // re-warn every tick for a book stuck out of tolerance. See `logDurationWarning`.
  private readonly durationWarningSignatures = new Map<string, string>();

  constructor(
    private readonly repo: AudiobookshelfRepository,
    private readonly client: AudiobookshelfClientService,
    private readonly matchService: AudiobookshelfMatchService,
    private readonly attempts: ReadingAttemptService,
    private readonly statusService: UserBookStatusService,
    private readonly sessionsService: AudiobookshelfSessionsService,
    private readonly libraryService: LibraryService,
    private readonly achievementEvents: AchievementEventsService,
  ) {}

  /**
   * Full resync: re-baseline the user's read state from scratch. Bypasses the per-book
   * `lastSyncedAbsUpdate` short-circuit (so single-toggle watermark advances re-apply) and runs the
   * deep reconciliation scan as the sessions phase (full re-pagination, not the incremental
   * watermark path). Same in-flight guard and disabled/unconfigured rejection as `sync`.
   */
  async fullResync(user: RequestUser): Promise<AudiobookshelfSyncResult> {
    return this.sync(user, { force: true, deepSessions: true, reconcile: true });
  }

  async sync(user: RequestUser, options: AudiobookshelfSyncOptions = {}): Promise<AudiobookshelfSyncResult> {
    const settings = await this.repo.findSettings(user.id);
    if (!settings || !isAbsSyncConfigured(settings)) {
      throw new BadRequestException('Audiobookshelf sync is not configured');
    }

    if (this.runningUsers.has(user.id)) {
      throw new ConflictException('An Audiobookshelf sync is already running');
    }
    this.runningUsers.add(user.id);

    // Fresh connection reconciles the whole inventory; subsequent syncs only poll progress against the
    // already-matched state. Forced paths (full resync, explicit rescan) always reconcile. The hot
    // tier never reconciles - it only refreshes position for already-matched in-progress books.
    const reconcile = options.hotInProgressOnly ? false : (options.reconcile ?? settings.initialReconcileCompletedAt == null);
    const startedAt = Date.now();
    this.logger.log(
      `[abs.sync] [start] userId=${user.id} syncStatus=${settings.syncStatus} syncPosition=${settings.syncPosition} force=${options.force === true} deepSessions=${options.deepSessions === true} reconcile=${reconcile} - sync started`,
    );

    const result: AudiobookshelfSyncResult = { matched: 0, statusApplied: 0, positionApplied: 0, sessionsApplied: 0, skipped: 0, failed: 0 };
    try {
      // Full inventory MATCH (no prune), run only on a fresh connection or an explicit rescan. When
      // skipped, the frequent poll applies progress against already-persisted book state instead of
      // re-materializing and re-matching the entire remote library.
      if (reconcile) {
        const matchSummary = await this.matchService.matchLibrary(user, settings.serverUrl, settings.apiToken, {
          force: options.force === true,
          excludedLibraryIds: settings.excludedLibraryIds ?? [],
          pathMappings: settings.pathMappings ?? [],
        });
        result.matched = matchSummary.autoLinked;
        // Stamp completion only after matchLibrary returns: a partial (page-by-page) reconcile that
        // throws leaves this null so the next sync retries the full reconcile instead of skipping it.
        await this.repo.updateSettings(user.id, { initialReconcileCompletedAt: new Date() });
      }

      const me = await this.client.getMe(user.id, settings.serverUrl, settings.apiToken);
      // Unlinked items need no pre-filter: findSyncableBookStatesByAbsItemIds already scopes to
      // linked, non-excluded, in-scope rows, so anything it omits is skipped in the loop below.
      // The hot tier narrows to books currently in progress ("Continue Listening") - not finished and
      // partway through - so a fast cadence stays cheap and never re-touches settled books.
      const progresses = me.mediaProgress.filter(
        (mp) => mp.libraryItemId && !mp.episodeId && (!options.hotInProgressOnly || (!mp.isFinished && mp.progress > 0 && mp.progress < 1)),
      );

      const progressItemIds = progresses.map((mp) => mp.libraryItemId!);
      const scope = await buildBookAccessScope(user, this.libraryService);
      const timeZone = resolveUserTimeZone(user);
      const states = progressItemIds.length
        ? await this.repo.findSyncableBookStatesByAbsItemIds(user.id, scope, progressItemIds, settings.excludedLibraryIds ?? [])
        : [];
      const stateByItemId = new Map(states.map((state) => [state.absLibraryItemId, state]));

      const dueBooks: AbsDueBook[] = [];
      for (const mp of progresses) {
        const state = stateByItemId.get(mp.libraryItemId!);
        if (!state || state.bookId == null) {
          result.skipped++;
          continue;
        }
        // Split per-phase watermarks: a skipped or disabled position phase must not consume the ABS
        // update a later position retry needs, and a status-only advance must not skip position.
        const statusDue = settings.syncStatus && (options.force || state.lastSyncedAbsUpdate == null || mp.lastUpdate > state.lastSyncedAbsUpdate);
        // Use only the position watermark: a null means position was never synced (e.g. matched before
        // its audio files were scanned, so the position phase skipped), and it must keep retrying until
        // it lands. Accepted cost: a legacy row that synced position under the pre-split single-watermark
        // scheme re-syncs position once (idempotent, harmless).
        const positionWatermark = state.lastSyncedPositionAbsUpdate;
        const positionDue = settings.syncPosition && (options.force || positionWatermark == null || mp.lastUpdate > positionWatermark);
        if (!statusDue && !positionDue) {
          result.skipped++;
          continue;
        }
        dueBooks.push({ mp, state, bookId: state.bookId, statusDue, positionDue });
      }

      const preload = await this.preloadForDueBooks(user.id, dueBooks);

      for (const { mp, state, bookId, statusDue, positionDue } of dueBooks) {
        try {
          const outcome = await this.applyProgressToBook(
            user.id,
            bookId,
            mp,
            timeZone,
            { status: statusDue, position: positionDue },
            state.lastSyncedProgressAt,
            preload,
          );
          if (outcome.statusApplied) result.statusApplied++;
          if (outcome.positionApplied) result.positionApplied++;
          await this.repo.updateBookState(user.id, state.absLibraryItemId, {
            lastSyncedAt: new Date(),
            syncError: null,
            ...(statusDue ? { lastSyncedAbsUpdate: mp.lastUpdate } : {}),
            ...(outcome.positionWatermarkAdvanced
              ? { lastSyncedPositionAbsUpdate: mp.lastUpdate, lastSyncedProgressAt: outcome.positionProgressAt }
              : {}),
          });
        } catch (err) {
          result.failed++;
          const { errorClass, error } = describeError(err);
          this.logger.warn(
            `[abs.sync] [fail] userId=${user.id} bookId=${state.bookId} absItemId="${sanitizeLogValue(state.absLibraryItemId)}" errorClass=${errorClass} error="${error}" - book sync failed`,
          );
          await this.repo.updateBookState(user.id, state.absLibraryItemId, { syncError: error });
        }
      }

      // Sessions ingest on the full/full-resync path (deep or incremental), and on the warm hot-tier
      // path but only when a book is actually in progress this run (the hot filter above already
      // narrowed `progresses` to in-progress books, so a non-empty array means there is warm work).
      // The warm path never runs the deep scan - deep stays tied to the full path's `deepSessions`.
      const warmSessionsDue = options.warmSessions === true && progresses.length > 0;
      let sessionsError: string | null = null;
      if (settings.syncSessions && (!options.hotInProgressOnly || warmSessionsDue)) {
        try {
          const sessions =
            options.deepSessions && !options.hotInProgressOnly
              ? await this.sessionsService.deepReconciliationScan(user, settings)
              : await this.sessionsService.syncSessions(user, settings);
          result.sessionsApplied = sessions.inserted + sessions.updated;
        } catch (err) {
          // Isolate session-ingest failures: status/position work is already committed, so record the
          // error and still report those counts rather than failing the whole run.
          const { errorClass, error } = describeError(err);
          sessionsError = error;
          this.logger.error(
            `[abs.sync] [fail] userId=${user.id} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sessionsError}" - session ingest failed`,
          );
        }
      }

      await this.repo.updateSettings(user.id, { lastSyncedAt: new Date(), lastSyncError: sessionsError });
      this.logger.log(
        `[abs.sync] [end] userId=${user.id} durationMs=${Date.now() - startedAt} matched=${result.matched} statusApplied=${result.statusApplied} positionApplied=${result.positionApplied} sessionsApplied=${result.sessionsApplied} skipped=${result.skipped} failed=${result.failed} - sync completed`,
      );
      return result;
    } catch (err) {
      const { errorClass, error } = describeError(err);
      // A rejected token never recovers on its own; without this the scheduler retries it forever.
      const tokenRejected = err instanceof AudiobookshelfApiError && (err.status === 401 || err.status === 403);
      this.logger.error(
        `[abs.sync] [fail] userId=${user.id} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${error}" tokenRejected=${tokenRejected} - sync failed${tokenRejected ? ', sync disabled' : ''}`,
      );
      await this.repo
        .updateSettings(user.id, tokenRejected ? { enabled: false, lastSyncError: error } : { lastSyncError: error })
        .catch(() => undefined);
      throw err;
    } finally {
      this.runningUsers.delete(user.id);
    }
  }

  /**
   * One batched read per kind for the whole run for the position phase. Status reads stay per-book:
   * status transitions are rare, and a fresh read is what lets the upgrade-only rank guard see a
   * status the user set while the run was in flight. The position maps are safe to snapshot because
   * the write itself is guarded (CAS on updatedAt) against concurrent local writes.
   */
  private async preloadForDueBooks(userId: number, dueBooks: AbsDueBook[]): Promise<AbsSyncPreload> {
    const positionBookIds = dueBooks.filter((book) => book.positionDue).map((book) => book.bookId);
    const [audioFilesByBookId, audioProgressByBookId] = await Promise.all([
      this.repo.findAudioFilesInPlayOrderForBooks(positionBookIds),
      this.repo.findAudioProgressForBooks(userId, positionBookIds),
    ]);
    return { audioFilesByBookId, audioProgressByBookId };
  }

  private async applyProgressToBook(
    userId: number,
    bookId: number,
    mp: AbsMediaProgress,
    timeZone: string,
    due: { status: boolean; position: boolean },
    positionSyncedProgressAt: Date | null,
    preload: AbsSyncPreload,
  ): Promise<{
    statusApplied: boolean;
    positionApplied: boolean;
    positionWatermarkAdvanced: boolean;
    appliedStatus: ReadStatus | null;
    positionProgressAt: Date | null;
  }> {
    let statusApplied = false;
    let positionApplied = false;
    let positionWatermarkAdvanced = false;
    let appliedStatus: ReadStatus | null = null;
    let positionProgressAt: Date | null = null;

    if (due.status) {
      const current = (await this.statusService.findOne(userId, bookId))?.status ?? 'unread';
      const startedOn = msToDateKey(mp.startedAt, timeZone);
      const endedOn = mp.isFinished ? (msToDateKey(mp.finishedAt, timeZone) ?? msToDateKey(mp.lastUpdate, timeZone)) : null;

      // Attempts FIRST, then status. Reversing this creates a duplicate manual attempt dated today
      // and loses the ABS finish date.
      await this.attempts.importUnlinkedRead(userId, bookId, {
        origin: 'audiobookshelf',
        startedOn,
        endedOn,
      });

      const target = resolveAbsTargetStatus(current, mp.isFinished);
      if (target) {
        await this.statusService.updateManual(userId, bookId, { status: target });
        statusApplied = true;
        appliedStatus = target;
      } else {
        appliedStatus = current;
      }
    }

    if (due.position) {
      const position = await this.applyPosition(userId, bookId, mp, positionSyncedProgressAt, preload);
      positionApplied = position.applied;
      positionWatermarkAdvanced = position.watermarkAdvanced;
      positionProgressAt = position.progressAt;
    }

    return { statusApplied, positionApplied, positionWatermarkAdvanced, appliedStatus, positionProgressAt };
  }

  private async applyPosition(
    userId: number,
    bookId: number,
    mp: AbsMediaProgress,
    syncedProgressAt: Date | null,
    preload: AbsSyncPreload,
  ): Promise<{ applied: boolean; watermarkAdvanced: boolean; progressAt: Date | null }> {
    const skipped = { applied: false, watermarkAdvanced: false, progressAt: null };
    const files = (preload.audioFilesByBookId.get(bookId) ?? []).filter((file) => file.format && isAudioFormat(file.format));
    if (files.length === 0) return skipped;

    if (!Number.isFinite(mp.duration) || mp.duration <= 0) {
      this.logDurationWarning(
        userId,
        bookId,
        'invalid',
        `[abs.sync] userId=${userId} bookId=${bookId} absDuration=${mp.duration} - position skipped: invalid ABS duration`,
      );
      return skipped;
    }

    const totalDuration = files.reduce((sum, file) => sum + (file.durationSeconds ?? 0), 0);
    const durationTolerance =
      Math.max(AUDIOBOOKSHELF_DURATION_TOLERANCE_BASE_SECONDS, files.length * AUDIOBOOKSHELF_DURATION_TOLERANCE_PER_FILE_SECONDS) +
      totalDuration * AUDIOBOOKSHELF_DURATION_TOLERANCE_RELATIVE;
    if (Math.abs(totalDuration - mp.duration) > durationTolerance) {
      this.logDurationWarning(
        userId,
        bookId,
        `${totalDuration}:${mp.duration}`,
        `[abs.sync] userId=${userId} bookId=${bookId} localDuration=${totalDuration} absDuration=${mp.duration} - position skipped: duration mismatch`,
      );
      return skipped;
    }

    // Newest-wins guard: never move a locally advanced position backward. A snapshot of the progress
    // row's updatedAt from our last ABS write that no longer matches means local playback changed it
    // since; with no snapshot (first sync) compare positions rather than the two systems' clocks.
    const local = preload.audioProgressByBookId.get(bookId);
    if (local) {
      const localAdvanced =
        syncedProgressAt != null ? local.updatedAt.getTime() !== syncedProgressAt.getTime() : (local.percentage ?? 0) > mp.progress * 100;
      if (localAdvanced) {
        this.logger.debug(`[abs.sync] userId=${userId} bookId=${bookId} - position skipped: local progress is newer`);
        return { applied: false, watermarkAdvanced: true, progressAt: local.updatedAt };
      }
    }

    const resolved = resolveAbsPosition(files, mp.currentTime);
    if (!resolved) return skipped;

    const percentage = Math.max(0, Math.min(100, (mp.currentTime / mp.duration) * 100));
    const written = await this.repo.upsertAudioProgressGuarded(
      userId,
      bookId,
      resolved.currentFileId,
      resolved.positionSeconds,
      percentage,
      local?.updatedAt ?? null,
    );
    if (!written) {
      // The CAS missed: local playback wrote the row between the pre-load snapshot and this apply.
      // Defer exactly like the guard above; the next run re-snapshots and re-decides.
      this.logger.debug(`[abs.sync] userId=${userId} bookId=${bookId} - position skipped: local progress won the write race`);
      return { applied: false, watermarkAdvanced: true, progressAt: local?.updatedAt ?? null };
    }
    this.durationWarningSignatures.delete(`${userId}:${bookId}`);
    preload.audioProgressByBookId.set(bookId, { percentage, updatedAt: written.updatedAt });
    // Announce the position write on the shared bus like every other progress writer (web reader, Kobo,
    // KOReader), so source-agnostic listeners such as the reading-alignment sync observe ABS advances.
    this.achievementEvents.emit(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, {
      userId,
      bookId,
      bookFileId: resolved.currentFileId,
      progress: percentage,
      source: 'audiobookshelf',
      // ABS reports the real client playback time; carry it so a delayed poll of older progress cannot
      // look newer than a more recent local update and drag the linked ebook backward.
      ...(mp.lastUpdate ? { occurredAt: new Date(mp.lastUpdate) } : {}),
    });
    return { applied: true, watermarkAdvanced: true, progressAt: written.updatedAt };
  }

  /**
   * The hot tier re-runs position apply every 30s for every in-progress book, so a book stuck out of
   * duration tolerance would otherwise log the same warning forever. Only the first occurrence of a
   * given signature (or a changed one) logs at warn; an identical repeat logs the same line at debug
   * so the condition stays visible in logs without flooding warn level. The map is cleared on an
   * applied position (see `applyPosition`) and capped so it cannot grow unbounded across many users.
   */
  private logDurationWarning(userId: number, bookId: number, signature: string, message: string): void {
    const key = `${userId}:${bookId}`;
    if (this.durationWarningSignatures.get(key) === signature) {
      this.logger.debug(message);
      return;
    }
    if (!this.durationWarningSignatures.has(key) && this.durationWarningSignatures.size >= DURATION_WARNING_SIGNATURE_CAP) {
      this.durationWarningSignatures.clear();
    }
    this.durationWarningSignatures.set(key, signature);
    this.logger.warn(message);
  }
}
