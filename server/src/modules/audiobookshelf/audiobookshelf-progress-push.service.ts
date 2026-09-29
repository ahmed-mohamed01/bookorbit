import { BadGatewayException, Injectable, Logger, OnModuleInit } from '@nestjs/common';

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
import { AudiobookshelfClientService } from './audiobookshelf-client.service';
import { AudiobookshelfRepository } from './audiobookshelf.repository';
import { AudiobookshelfSyncCoordinatorService } from './audiobookshelf-sync-coordinator.service';
import { describeError } from './audiobookshelf-user.utils';
import type { AudiobookshelfBookState } from './schema/audiobookshelf.schema';

export const AUDIOBOOKSHELF_POSITION_PUSH_DEBOUNCE_MS = 10_000;
// The player saves every few seconds while playing, which would keep resetting the debounce, so a
// continuous session still pushes at least this often.
export const AUDIOBOOKSHELF_POSITION_PUSH_MAX_WAIT_MS = 60_000;
export const AUDIOBOOKSHELF_POSITION_PUSH_SWEEP_LIMIT = 200;

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

  constructor(
    private readonly achievementEvents: AchievementEventsService,
    private readonly repo: AudiobookshelfRepository,
    private readonly client: AudiobookshelfClientService,
    private readonly bookService: BookService,
    private readonly editionLinks: EditionLinkRepository,
    private readonly coordinator: AudiobookshelfSyncCoordinatorService,
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

  async sweepPending(userId: number): Promise<void> {
    const states = await this.repo.findPendingPositionPushes(userId, AUDIOBOOKSHELF_POSITION_PUSH_SWEEP_LIMIT);
    for (const state of states) {
      await this.pushPosition(state);
    }
  }

  private async handleProgressChanged(payload: { userId: number; bookId: number }): Promise<void> {
    const startedAt = Date.now();
    try {
      const settings = await this.repo.findSettings(payload.userId);
      if (!settings?.enabled || !settings.pushPosition) return;

      let state = await this.repo.findBookStateByBookId(payload.userId, payload.bookId);
      if (!state) {
        const audioBookId = await this.editionLinks.findAudioBookIdByReadAlongBookId(payload.bookId);
        if (audioBookId === null) return;
        state = await this.repo.findBookStateByBookId(payload.userId, audioBookId);
      }
      if (!state || state.bookId === null || state.syncExcluded || state.manualUnlinked) return;

      await this.repo.markPositionPushPending(payload.userId, state.absLibraryItemId);
      this.requestPush(payload.userId, state.bookId);
    } catch (error) {
      const described = describeError(error);
      this.logger.warn(
        `[abs.push_position] [fail] userId=${payload.userId} bookId=${payload.bookId} durationMs=${Date.now() - startedAt} errorClass=${described.errorClass} error="${described.error}" - progress event handling failed`,
      );
    }
  }

  private requestPush(userId: number, bookId: number): void {
    const state = this.getOrCreateState(userId, bookId);
    if (state.inFlight) {
      state.rerun = true;
      return;
    }
    this.schedule(state);
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
          const bookState = await this.repo.findBookStateByBookId(state.userId, state.bookId);
          if (bookState) await this.pushPosition(bookState);
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

  private async pushPosition(initialState: AudiobookshelfBookState): Promise<void> {
    if (initialState.bookId === null) return;
    const userId = initialState.userId;
    const bookId = initialState.bookId;
    const absItemId = initialState.absLibraryItemId;
    const safeAbsItemId = sanitizeLogValue(absItemId);
    const startedAt = Date.now();
    this.logger.log(`[abs.push_position] [start] userId=${userId} bookId=${bookId} absItemId="${safeAbsItemId}" - position push started`);

    try {
      const [settings, state, local] = await Promise.all([
        this.repo.findSettings(userId),
        this.repo.findBookStateRow(userId, absItemId),
        this.repo.findAudioProgress(userId, bookId),
      ]);
      if (!settings?.enabled || !settings.pushPosition || !state || state.bookId !== bookId || state.syncExcluded || state.manualUnlinked) {
        this.logEnd(userId, bookId, safeAbsItemId, startedAt, false, 'disabled_or_unlinked');
        return;
      }

      if (!local || (state.lastSyncedProgressAt !== null && local.updatedAt.getTime() === state.lastSyncedProgressAt.getTime())) {
        await this.repo.clearPositionPushPendingIfUnchanged(userId, absItemId, bookId, local?.updatedAt ?? null);
        this.logEnd(userId, bookId, safeAbsItemId, startedAt, false, 'no_local_change');
        return;
      }

      const abs = await this.client.getMediaProgress(userId, settings.serverUrl, settings.apiToken, absItemId);
      if (abs && abs.lastUpdate > (state.lastSyncedPositionAbsUpdate ?? 0) && abs.lastUpdate > local.capturedAt.getTime()) {
        await this.repo.clearPositionPushPendingIfUnchanged(userId, absItemId, bookId, local.updatedAt);
        this.logEnd(userId, bookId, safeAbsItemId, startedAt, false, 'abs_newer');
        return;
      }

      const position = await this.bookService.resolveAudiobookPositionForExternalSync(bookId, local.currentFileId, local.positionSeconds);
      if (!position) {
        await this.repo.clearPositionPushPendingIfUnchanged(userId, absItemId, bookId, local.updatedAt);
        this.logEnd(userId, bookId, safeAbsItemId, startedAt, false, 'no_timeline');
        return;
      }

      const duration = abs && Number.isFinite(abs.duration) && abs.duration > 0 ? abs.duration : position.audioTotalSeconds;
      const currentTime = Math.max(0, Math.min(position.audioSeconds, duration));
      if (!Number.isFinite(duration) || duration <= 0) {
        await this.repo.clearPositionPushPendingIfUnchanged(userId, absItemId, bookId, local.updatedAt);
        this.logEnd(userId, bookId, safeAbsItemId, startedAt, false, 'no_timeline');
        return;
      }
      if (duration - currentTime < 10) {
        await this.repo.clearPositionPushPendingIfUnchanged(userId, absItemId, bookId, local.updatedAt);
        this.logEnd(userId, bookId, safeAbsItemId, startedAt, false, 'near_end');
        return;
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
      this.logEnd(userId, bookId, safeAbsItemId, startedAt, true, 'pushed');
    } catch (error) {
      const described = describeError(error);
      this.logger.warn(
        `[abs.push_position] [fail] userId=${userId} bookId=${bookId} absItemId="${safeAbsItemId}" durationMs=${Date.now() - startedAt} errorClass=${described.errorClass} error="${described.error}" - position push failed`,
      );
    }
  }

  private logEnd(userId: number, bookId: number, safeAbsItemId: string, startedAt: number, pushed: boolean, reason: string): void {
    this.logger.log(
      `[abs.push_position] [end] userId=${userId} bookId=${bookId} absItemId="${safeAbsItemId}" durationMs=${Date.now() - startedAt} pushed=${pushed} reason=${reason} - position push completed`,
    );
  }
}
