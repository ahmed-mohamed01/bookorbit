import { BadGatewayException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { isAudioFormat } from '@bookorbit/types';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import {
  ACHIEVEMENT_EVENT_AUDIO_POSITION_DERIVED,
  ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED,
  AchievementEventsService,
  type AudioPositionDerivedPayload,
  type BookProgressChangedPayload,
} from '../achievement/achievement-events.service';
import { BookService } from '../book/book.service';
import { EditionLinkRepository } from '../edition-link/edition-link.repository';
import { LibraryService } from '../library/library.service';
import { UserService } from '../user/user.service';
import { AudiobookshelfApiError, AudiobookshelfClientService } from './audiobookshelf-client.service';
import { AudiobookshelfRepository, type AbsBookAccessScope } from './audiobookshelf.repository';
import { AudiobookshelfSyncCoordinatorService } from './audiobookshelf-sync-coordinator.service';
import { buildBookAccessScope, describeError, isAbsSyncConfigured, isEligibleSyncUser } from './audiobookshelf-user.utils';
import {
  AUDIOBOOKSHELF_DURATION_TOLERANCE_BASE_SECONDS,
  AUDIOBOOKSHELF_DURATION_TOLERANCE_PER_FILE_SECONDS,
  AUDIOBOOKSHELF_DURATION_TOLERANCE_RELATIVE,
} from './audiobookshelf.constants';
import type { AudiobookshelfBookState, AudiobookshelfUserSetting } from './schema/audiobookshelf.schema';

export const AUDIOBOOKSHELF_POSITION_PUSH_DEBOUNCE_MS = 10_000;
// The player saves every few seconds while playing, which would keep resetting the debounce, so a
// continuous session still pushes at least this often.
export const AUDIOBOOKSHELF_POSITION_PUSH_MAX_WAIT_MS = 60_000;
export const AUDIOBOOKSHELF_POSITION_PUSH_SWEEP_LIMIT = 200;
// Audiobookshelf marks an item finished when a client reports less than this much remaining.
export const AUDIOBOOKSHELF_POSITION_PUSH_NEAR_END_SECONDS = 10;
// A playing client saves every few seconds; the eligibility lookup behind marking is reused for this
// long instead of repeated per save. Every push run still loads it fresh.
export const AUDIOBOOKSHELF_POSITION_PUSH_CONTEXT_TTL_MS = 10_000;

/** Same tolerance for both directions: a position is only exchanged when both sides describe the same recording. */
export function isWithinAbsDurationTolerance(localTotalSeconds: number, localFileCount: number, absDurationSeconds: number): boolean {
  const tolerance =
    Math.max(AUDIOBOOKSHELF_DURATION_TOLERANCE_BASE_SECONDS, localFileCount * AUDIOBOOKSHELF_DURATION_TOLERANCE_PER_FILE_SECONDS) +
    localTotalSeconds * AUDIOBOOKSHELF_DURATION_TOLERANCE_RELATIVE;
  return Math.abs(localTotalSeconds - absDurationSeconds) <= tolerance;
}

interface PushContext {
  settings: AudiobookshelfUserSetting;
  scope: AbsBookAccessScope;
  excludedLibraryIds: string[];
}

type PushOutcome = 'pushed' | 'skipped' | 'failed' | 'unreachable';

interface PushDebounceState {
  key: string;
  userId: number;
  bookId: number;
  timer: ReturnType<typeof setTimeout> | null;
  firstRequestedAt: number | null;
  inFlight: boolean;
  rerun: boolean;
}

@Injectable()
export class AudiobookshelfProgressPushService implements OnModuleInit {
  private readonly logger = new Logger(AudiobookshelfProgressPushService.name);
  private readonly states = new Map<string, PushDebounceState>();
  private readonly userQueues = new Map<number, Promise<void>>();
  private readonly eventContexts = new Map<number, { context: Promise<PushContext | null>; expiresAt: number }>();

  constructor(
    private readonly achievementEvents: AchievementEventsService,
    private readonly repo: AudiobookshelfRepository,
    private readonly client: AudiobookshelfClientService,
    private readonly bookService: BookService,
    private readonly editionLinks: EditionLinkRepository,
    private readonly coordinator: AudiobookshelfSyncCoordinatorService,
    private readonly userService: UserService,
    private readonly libraryService: LibraryService,
  ) {}

  onModuleInit(): void {
    this.achievementEvents.on(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, (payload: BookProgressChangedPayload) => {
      if (payload.source === 'audiobookshelf') return;
      void this.handleProgressChanged(payload);
    });
    // Reading the read-along can move the audiobook without moving the text, so no progress event fires.
    this.achievementEvents.on(ACHIEVEMENT_EVENT_AUDIO_POSITION_DERIVED, (payload: AudioPositionDerivedPayload) => {
      void this.handleProgressChanged(payload);
    });
  }

  /** Runs inside the caller's sync lock. Stops at the first unreachable-server failure so an outage cannot hold the lock. */
  async sweepPending(userId: number): Promise<void> {
    const startedAt = Date.now();
    const context = await this.loadPushContext(userId);
    if (!context) {
      await this.repo.clearPositionPushPending(userId);
      return;
    }
    await this.repo.clearIneligiblePositionPushes(userId, context.scope, context.excludedLibraryIds);
    const states = await this.repo.findPendingPositionPushes(
      userId,
      context.scope,
      context.excludedLibraryIds,
      AUDIOBOOKSHELF_POSITION_PUSH_SWEEP_LIMIT,
    );
    if (states.length === 0) return;

    this.logger.log(`[abs.push_sweep] [start] userId=${userId} pending=${states.length} - pending position push sweep started`);
    let attempted = 0;
    let pushed = 0;
    let stoppedUnreachable = false;
    for (const state of states) {
      attempted++;
      const outcome = await this.pushPosition(context, state);
      if (outcome === 'pushed') pushed++;
      if (outcome === 'unreachable') {
        stoppedUnreachable = true;
        break;
      }
    }
    this.logger.log(
      `[abs.push_sweep] [end] userId=${userId} durationMs=${Date.now() - startedAt} pending=${states.length} attempted=${attempted} pushed=${pushed} stoppedUnreachable=${stoppedUnreachable} - pending position push sweep completed`,
    );
  }

  /** Schedules a debounced push for a book whose ABS row is already marked pending. */
  requestPush(userId: number, bookId: number): void {
    const state = this.getOrCreateState(userId, bookId);
    if (state.inFlight) {
      state.rerun = true;
      return;
    }
    this.schedule(state);
  }

  private async handleProgressChanged(payload: { userId: number; bookId: number }): Promise<void> {
    const startedAt = Date.now();
    try {
      const context = await this.eventContext(payload.userId);
      if (!context) return;

      let state = await this.repo.findPushableBookStateByBookId(payload.userId, payload.bookId, context.scope, context.excludedLibraryIds);
      if (!state) {
        // The text edition and the read-along reach Audiobookshelf through their linked audiobook.
        const link = await this.editionLinks.findLinkForBook(payload.bookId);
        if (!link || link.audioBookId === payload.bookId) return;
        state = await this.repo.findPushableBookStateByBookId(payload.userId, link.audioBookId, context.scope, context.excludedLibraryIds);
      }
      if (!state || state.bookId === null) return;

      await this.repo.markPositionPushPending(payload.userId, state.absLibraryItemId);
      this.requestPush(payload.userId, state.bookId);
    } catch (error) {
      const described = describeError(error);
      this.logger.warn(
        `[abs.push_position] [fail] userId=${payload.userId} bookId=${payload.bookId} durationMs=${Date.now() - startedAt} errorClass=${described.errorClass} error="${described.error}" - progress event handling failed`,
      );
    }
  }

  /** The same gate the sync scheduler applies (configured, active, permitted), plus the push opt-in. */
  private async loadPushContext(userId: number): Promise<PushContext | null> {
    const settings = await this.repo.findSettings(userId);
    if (!settings || !isAbsSyncConfigured(settings) || !settings.pushPosition) return null;
    const user = await this.userService.findByIdWithPermissions(userId);
    if (!user || !isEligibleSyncUser(user)) return null;
    return {
      settings,
      scope: await buildBookAccessScope(user, this.libraryService),
      excludedLibraryIds: settings.excludedLibraryIds ?? [],
    };
  }

  private eventContext(userId: number): Promise<PushContext | null> {
    const now = Date.now();
    const cached = this.eventContexts.get(userId);
    if (cached && cached.expiresAt > now) return cached.context;
    for (const [key, entry] of this.eventContexts) {
      if (entry.expiresAt <= now) this.eventContexts.delete(key);
    }
    const context = this.loadPushContext(userId);
    this.eventContexts.set(userId, { context, expiresAt: now + AUDIOBOOKSHELF_POSITION_PUSH_CONTEXT_TTL_MS });
    context.catch(() => this.eventContexts.delete(userId));
    return context;
  }

  private getOrCreateState(userId: number, bookId: number): PushDebounceState {
    const key = `${userId}:${bookId}`;
    const existing = this.states.get(key);
    if (existing) return existing;
    const state: PushDebounceState = { key, userId, bookId, timer: null, firstRequestedAt: null, inFlight: false, rerun: false };
    this.states.set(key, state);
    return state;
  }

  private schedule(state: PushDebounceState, delayMs?: number): void {
    if (state.timer) clearTimeout(state.timer);
    const now = Date.now();
    state.firstRequestedAt ??= now;
    const untilMaxWait = Math.max(0, state.firstRequestedAt + AUDIOBOOKSHELF_POSITION_PUSH_MAX_WAIT_MS - now);
    state.timer = setTimeout(
      () => {
        state.timer = null;
        void this.runDuePush(state.key);
      },
      delayMs ?? Math.min(AUDIOBOOKSHELF_POSITION_PUSH_DEBOUNCE_MS, untilMaxWait),
    );
  }

  private async runDuePush(key: string): Promise<void> {
    const state = this.states.get(key);
    if (!state || state.inFlight) return;
    if (this.coordinator.isSyncRunning(state.userId)) {
      this.schedule(state, AUDIOBOOKSHELF_POSITION_PUSH_DEBOUNCE_MS);
      return;
    }

    state.inFlight = true;
    state.rerun = false;
    state.firstRequestedAt = null;
    const startedAt = Date.now();
    try {
      await this.enqueueUser(state.userId, async () => {
        if (!this.coordinator.tryStartPush(state.userId)) {
          state.rerun = true;
          return;
        }
        try {
          const context = await this.loadPushContext(state.userId);
          if (!context) {
            await this.repo.clearPositionPushPending(state.userId);
            return;
          }
          const bookState = await this.repo.findPushableBookStateByBookId(state.userId, state.bookId, context.scope, context.excludedLibraryIds);
          if (bookState) await this.pushPosition(context, bookState);
          else await this.repo.clearIneligiblePositionPushes(state.userId, context.scope, context.excludedLibraryIds);
        } finally {
          this.coordinator.endPush(state.userId);
        }
      });
    } catch (error) {
      const described = describeError(error);
      this.logger.warn(
        `[abs.push_position] [fail] userId=${state.userId} bookId=${state.bookId} durationMs=${Date.now() - startedAt} errorClass=${described.errorClass} error="${described.error}" - queued position push failed`,
      );
    } finally {
      state.inFlight = false;
      if (state.rerun) this.schedule(state);
      else this.states.delete(key);
    }
  }

  private enqueueUser(userId: number, task: () => Promise<void>): Promise<void> {
    const previous = this.userQueues.get(userId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    this.userQueues.set(userId, current);
    current
      .finally(() => {
        if (this.userQueues.get(userId) === current) this.userQueues.delete(userId);
      })
      .catch(() => undefined);
    return current;
  }

  private async pushPosition(context: PushContext, initialState: AudiobookshelfBookState): Promise<PushOutcome> {
    if (initialState.bookId === null) return 'skipped';
    const { settings, scope, excludedLibraryIds } = context;
    const userId = initialState.userId;
    const bookId = initialState.bookId;
    const absItemId = initialState.absLibraryItemId;
    const safeAbsItemId = sanitizeLogValue(absItemId);
    const startedAt = Date.now();
    this.logger.log(`[abs.push_position] [start] userId=${userId} bookId=${bookId} absItemId="${safeAbsItemId}" - position push started`);

    try {
      // Re-read right before the PATCH: the row may have been unlinked, excluded or flagged since it was queued.
      const [state, local] = await Promise.all([
        this.repo.findPushableBookStateRow(userId, absItemId, scope, excludedLibraryIds),
        this.repo.findAudioProgress(userId, bookId),
      ]);
      if (!state) {
        await this.repo.clearPositionPushPending(userId, absItemId);
        return this.logEnd(userId, bookId, safeAbsItemId, startedAt, 'skipped', 'ineligible');
      }
      if (state.bookId !== bookId) return this.logEnd(userId, bookId, safeAbsItemId, startedAt, 'skipped', 'relinked');

      if (!local || (state.lastSyncedProgressAt !== null && local.updatedAt.getTime() === state.lastSyncedProgressAt.getTime())) {
        await this.repo.clearPositionPushPendingIfUnchanged(userId, absItemId, bookId, local?.updatedAt ?? null);
        return this.logEnd(userId, bookId, safeAbsItemId, startedAt, 'skipped', 'no_local_change');
      }

      const abs = await this.client.getMediaProgress(userId, settings.serverUrl, settings.apiToken, absItemId);
      // Checked even when ABS has not moved past our watermark: the watermark may record an ABS update
      // that was never applied locally, and an older local position must not overwrite it.
      if (abs && abs.lastUpdate > local.capturedAt.getTime()) {
        await this.repo.clearPositionPushPendingIfUnchanged(userId, absItemId, bookId, local.updatedAt);
        return this.logEnd(userId, bookId, safeAbsItemId, startedAt, 'skipped', 'abs_newer');
      }

      const position = await this.bookService.resolveAudiobookPositionForExternalSync(bookId, local.currentFileId, local.positionSeconds);
      if (!position) {
        await this.repo.clearPositionPushPendingIfUnchanged(userId, absItemId, bookId, local.updatedAt);
        return this.logEnd(userId, bookId, safeAbsItemId, startedAt, 'skipped', 'no_timeline');
      }

      const absDurationValid = abs !== null && Number.isFinite(abs.duration) && abs.duration > 0;
      if (absDurationValid && !(await this.matchesAbsDuration(bookId, position.audioTotalSeconds, abs.duration))) {
        await this.repo.clearPositionPushPendingIfUnchanged(userId, absItemId, bookId, local.updatedAt);
        return this.logEnd(userId, bookId, safeAbsItemId, startedAt, 'skipped', 'duration_mismatch');
      }

      const duration = absDurationValid ? abs.duration : position.audioTotalSeconds;
      const currentTime = Math.max(0, Math.min(position.audioSeconds, duration));
      if (!Number.isFinite(duration) || duration <= 0) {
        await this.repo.clearPositionPushPendingIfUnchanged(userId, absItemId, bookId, local.updatedAt);
        return this.logEnd(userId, bookId, safeAbsItemId, startedAt, 'skipped', 'no_timeline');
      }
      if (duration - currentTime < AUDIOBOOKSHELF_POSITION_PUSH_NEAR_END_SECONDS) {
        await this.repo.clearPositionPushPendingIfUnchanged(userId, absItemId, bookId, local.updatedAt);
        return this.logEnd(userId, bookId, safeAbsItemId, startedAt, 'skipped', 'near_end');
      }

      const lastUpdate = local.capturedAt.getTime();
      await this.client.updateMediaProgress(userId, settings.serverUrl, settings.apiToken, absItemId, {
        currentTime,
        duration,
        progress: currentTime / duration,
        lastUpdate,
      });

      let watermark = lastUpdate;
      if (!abs) {
        const created = await this.client.getMediaProgress(userId, settings.serverUrl, settings.apiToken, absItemId);
        if (!created) throw new BadGatewayException('Audiobookshelf did not return created progress');
        watermark = created.lastUpdate;
      }
      await this.repo.completePositionPush(userId, absItemId, bookId, local.updatedAt, watermark);
      return this.logEnd(userId, bookId, safeAbsItemId, startedAt, 'pushed', 'pushed');
    } catch (error) {
      const described = describeError(error);
      const unreachable = error instanceof AudiobookshelfApiError && (error.code === 'network' || error.code === 'timeout');
      this.logger.warn(
        `[abs.push_position] [fail] userId=${userId} bookId=${bookId} absItemId="${safeAbsItemId}" durationMs=${Date.now() - startedAt} unreachable=${unreachable} errorClass=${described.errorClass} error="${described.error}" - position push failed`,
      );
      return unreachable ? 'unreachable' : 'failed';
    }
  }

  private async matchesAbsDuration(bookId: number, localTotalSeconds: number, absDurationSeconds: number): Promise<boolean> {
    const files = ((await this.repo.findAudioFilesInPlayOrderForBooks([bookId])).get(bookId) ?? []).filter(
      (file) => file.format && isAudioFormat(file.format),
    );
    return isWithinAbsDurationTolerance(localTotalSeconds, files.length, absDurationSeconds);
  }

  private logEnd(userId: number, bookId: number, safeAbsItemId: string, startedAt: number, outcome: PushOutcome, reason: string): PushOutcome {
    this.logger.log(
      `[abs.push_position] [end] userId=${userId} bookId=${bookId} absItemId="${safeAbsItemId}" durationMs=${Date.now() - startedAt} pushed=${outcome === 'pushed'} reason=${reason} - position push completed`,
    );
    return outcome;
  }
}
