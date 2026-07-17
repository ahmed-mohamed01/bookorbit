import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { isAudioFormat, type AudiobookshelfSyncResult, type ReadStatus } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { BookService } from '../book/book.service';
import { ReadingAttemptService } from '../user-book-status/reading-attempt.service';
import { UserBookStatusService } from '../user-book-status/user-book-status.service';
import { AudiobookshelfClientService, type AbsMediaProgress } from './audiobookshelf-client.service';
import { AudiobookshelfMatchService } from './audiobookshelf-match.service';
import { AudiobookshelfRepository } from './audiobookshelf.repository';
import { AudiobookshelfSessionsService } from './audiobookshelf-sessions.service';
import { AUDIOBOOKSHELF_DURATION_TOLERANCE_SECONDS } from './audiobookshelf.constants';

export interface AudiobookshelfSyncOptions {
  // Re-apply every linked book even when ABS has not advanced past the last-synced watermark. Used
  // by full resync to re-baseline state after a toggle change.
  force?: boolean;
  // Run the deep reconciliation scan (full re-pagination) as the sessions phase instead of the
  // incremental watermark path.
  deepSessions?: boolean;
}

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
  const targetRank = isFinished ? 3 : 1;
  if (COMPLETION_RANK[current] >= targetRank) return null;
  return isFinished ? 'read' : 'reading';
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

function msToDateString(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

@Injectable()
export class AudiobookshelfSyncService {
  private readonly logger = new Logger(AudiobookshelfSyncService.name);
  private readonly runningUsers = new Set<number>();

  constructor(
    private readonly repo: AudiobookshelfRepository,
    private readonly client: AudiobookshelfClientService,
    private readonly matchService: AudiobookshelfMatchService,
    private readonly attempts: ReadingAttemptService,
    private readonly statusService: UserBookStatusService,
    private readonly bookService: BookService,
    private readonly sessionsService: AudiobookshelfSessionsService,
  ) {}

  /**
   * Full resync: re-baseline the user's read state from scratch. Bypasses the per-book
   * `lastSyncedAbsUpdate` short-circuit (so single-toggle watermark advances re-apply) and runs the
   * deep reconciliation scan as the sessions phase (full re-pagination, not the incremental
   * watermark path). Same in-flight guard and disabled/unconfigured rejection as `sync`.
   */
  async fullResync(user: RequestUser): Promise<AudiobookshelfSyncResult> {
    return this.sync(user, { force: true, deepSessions: true });
  }

  async sync(user: RequestUser, options: AudiobookshelfSyncOptions = {}): Promise<AudiobookshelfSyncResult> {
    const settings = await this.repo.findSettings(user.id);
    if (!settings || !settings.enabled || !settings.serverUrl || !settings.apiToken) {
      throw new BadRequestException('Audiobookshelf sync is not configured');
    }

    if (this.runningUsers.has(user.id)) {
      throw new ConflictException('An Audiobookshelf sync is already running');
    }
    this.runningUsers.add(user.id);

    const startedAt = Date.now();
    this.logger.log(
      `[abs.sync] [start] userId=${user.id} syncStatus=${settings.syncStatus} syncPosition=${settings.syncPosition} force=${options.force === true} deepSessions=${options.deepSessions === true} - sync started`,
    );

    const result: AudiobookshelfSyncResult = { matched: 0, statusApplied: 0, positionApplied: 0, sessionsApplied: 0, skipped: 0, failed: 0 };
    try {
      const matchSummary = await this.matchService.matchLibrary(user, settings.serverUrl, settings.apiToken, {
        force: options.force === true,
        excludedLibraryIds: settings.excludedLibraryIds ?? [],
      });
      result.matched = matchSummary.autoLinked;
      const selectedAbsItemIds = new Set(matchSummary.selectedAbsItemIds);

      const me = await this.client.getMe(user.id, settings.serverUrl, settings.apiToken);
      const candidateProgresses = me.mediaProgress.filter((mp) => mp.libraryItemId && !mp.episodeId);
      const progresses = candidateProgresses.filter((mp) => selectedAbsItemIds.has(mp.libraryItemId!));
      result.skipped += candidateProgresses.length - progresses.length;

      const progressItemIds = progresses.map((mp) => mp.libraryItemId!);
      const states = progressItemIds.length ? await this.repo.findBookStatesByAbsItemIds(user.id, progressItemIds) : [];
      const stateByItemId = new Map(states.map((state) => [state.absLibraryItemId, state]));

      for (const mp of progresses) {
        const state = stateByItemId.get(mp.libraryItemId!);
        if (!state || state.bookId == null || state.needsReview || state.syncExcluded || state.matchError) {
          result.skipped++;
          continue;
        }
        if (!options.force && state.lastSyncedAbsUpdate != null && mp.lastUpdate <= state.lastSyncedAbsUpdate) {
          result.skipped++;
          continue;
        }
        if (!settings.syncStatus && !settings.syncPosition) {
          result.skipped++;
          continue;
        }

        try {
          const outcome = await this.applyProgressToBook(user.id, state.bookId, mp, {
            syncStatus: settings.syncStatus,
            syncPosition: settings.syncPosition,
          });
          if (outcome.statusApplied) result.statusApplied++;
          if (outcome.positionApplied) result.positionApplied++;
          await this.repo.updateBookState(user.id, state.absLibraryItemId, {
            lastSyncedAt: new Date(),
            lastSyncedStatus: outcome.appliedStatus,
            lastSyncedProgress: mp.progress,
            lastSyncedAbsUpdate: mp.lastUpdate,
            syncError: null,
          });
        } catch (err) {
          result.failed++;
          const errorClass = err instanceof Error ? err.constructor.name : 'Error';
          const error = sanitizeLogValue(err instanceof Error ? err.message : String(err));
          this.logger.warn(
            `[abs.sync] [fail] userId=${user.id} bookId=${state.bookId} absItemId="${sanitizeLogValue(state.absLibraryItemId)}" errorClass=${errorClass} error="${error}" - book sync failed`,
          );
          await this.repo.updateBookState(user.id, state.absLibraryItemId, { syncError: error });
        }
      }

      let sessionsError: string | null = null;
      if (settings.syncSessions) {
        try {
          const sessions = options.deepSessions
            ? await this.sessionsService.deepReconciliationScan(user, settings)
            : await this.sessionsService.syncSessions(user, settings);
          result.sessionsApplied = sessions.inserted + sessions.updated;
        } catch (err) {
          // Isolate session-ingest failures: status/position work is already committed, so record the
          // error and still report those counts rather than failing the whole run.
          sessionsError = sanitizeLogValue(err instanceof Error ? err.message : String(err));
          const errorClass = err instanceof Error ? err.constructor.name : 'Error';
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
      const errorClass = err instanceof Error ? err.constructor.name : 'Error';
      const error = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.error(
        `[abs.sync] [fail] userId=${user.id} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${error}" - sync failed`,
      );
      await this.repo.updateSettings(user.id, { lastSyncError: error }).catch(() => undefined);
      throw err;
    } finally {
      this.runningUsers.delete(user.id);
    }
  }

  private async applyProgressToBook(
    userId: number,
    bookId: number,
    mp: AbsMediaProgress,
    toggles: { syncStatus: boolean; syncPosition: boolean },
  ): Promise<{ statusApplied: boolean; positionApplied: boolean; appliedStatus: ReadStatus | null }> {
    let statusApplied = false;
    let positionApplied = false;
    let appliedStatus: ReadStatus | null = null;

    if (toggles.syncStatus) {
      const current = (await this.statusService.findOne(userId, bookId))?.status ?? 'unread';
      const startedOn = msToDateString(mp.startedAt);
      const endedOn = mp.isFinished ? (msToDateString(mp.finishedAt) ?? msToDateString(mp.lastUpdate)) : null;

      // Attempts FIRST, then status. Reversing this creates a duplicate manual attempt dated today
      // and loses the ABS finish date.
      await this.attempts.importExternalRead(userId, bookId, {
        provider: 'audiobookshelf',
        externalId: mp.id,
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

    if (toggles.syncPosition) {
      positionApplied = await this.applyPosition(userId, bookId, mp);
    }

    return { statusApplied, positionApplied, appliedStatus };
  }

  private async applyPosition(userId: number, bookId: number, mp: AbsMediaProgress): Promise<boolean> {
    const files = (await this.bookService.getAudioFilesInPlayOrder(bookId)).filter((file) => file.format && isAudioFormat(file.format));
    if (files.length === 0) return false;

    if (!Number.isFinite(mp.duration) || mp.duration <= 0) {
      this.logger.warn(`[abs.sync] [fail] userId=${userId} bookId=${bookId} absDuration=${mp.duration} - position skipped: invalid ABS duration`);
      return false;
    }

    const totalDuration = files.reduce((sum, file) => sum + (file.durationSeconds ?? 0), 0);
    if (Math.abs(totalDuration - mp.duration) > AUDIOBOOKSHELF_DURATION_TOLERANCE_SECONDS) {
      this.logger.warn(
        `[abs.sync] [fail] userId=${userId} bookId=${bookId} localDuration=${totalDuration} absDuration=${mp.duration} - position skipped: duration mismatch`,
      );
      return false;
    }

    const resolved = resolveAbsPosition(files, mp.currentTime);
    if (!resolved) return false;

    const percentage = Math.max(0, Math.min(100, (mp.currentTime / mp.duration) * 100));
    await this.bookService.upsertAudioProgressFromSync(userId, bookId, resolved.currentFileId, resolved.positionSeconds, percentage);
    return true;
  }
}
