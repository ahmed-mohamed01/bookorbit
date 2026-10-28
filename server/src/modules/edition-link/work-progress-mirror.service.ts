import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import type { WorkVariantRole } from '@bookorbit/types';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import {
  ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED,
  AchievementEventsService,
  type BookProgressChangedPayload,
} from '../achievement/achievement-events.service';
import { EditionLinkSettingsService } from './edition-link-settings.service';
import { WorkEventsService } from './work-events.service';
import { type MirrorTargetState, WorkRepository } from './work.repository';
import { WorkScopeService, type WorkMember } from './work-scope.service';
import { audioPositionAt, mirrorSkipReason } from './work.utils';

const EVENT = 'work.progress_mirror';
const MIN_DELTA = 0.5;

export type MirrorOutcome = 'written' | 'skipped_owned' | 'skipped_close' | 'skipped_newer' | 'skipped_no_position';

/**
 * Rough position sync between variants no precise mapping covers: the percentage read on one copy is
 * written onto every other copy's own progress, marked or timed so a real read there still wins. It
 * never emits a progress event, so no session, achievement or integration push follows a mirror.
 */
@Injectable()
export class WorkProgressMirrorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkProgressMirrorService.name);
  private readonly onProgressChanged = (payload: BookProgressChangedPayload): void => {
    void this.handle(payload);
  };

  constructor(
    private readonly achievementEvents: AchievementEventsService,
    private readonly settings: EditionLinkSettingsService,
    private readonly scope: WorkScopeService,
    private readonly repo: WorkRepository,
    private readonly events: WorkEventsService,
  ) {}

  onModuleInit(): void {
    this.achievementEvents.on(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, this.onProgressChanged);
  }

  onModuleDestroy(): void {
    this.achievementEvents.removeListener(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, this.onProgressChanged);
  }

  async handle(payload: BookProgressChangedPayload): Promise<Map<number, MirrorOutcome>> {
    const startedAt = Date.now();
    const outcomes = new Map<number, MirrorOutcome>();
    try {
      const settings = await this.settings.get(payload.userId);
      if (!settings.enabled || settings.positionSync !== 'rough') return outcomes;
      const work = await this.scope.resolve(payload.userId, payload.bookId);
      const source = work?.members.find((member) => member.bookId === payload.bookId);
      if (!work || !source) return outcomes;

      const targets = work.members.filter((member) => member.bookId !== payload.bookId);
      const at = new Date(Math.min(payload.occurredAt?.getTime() ?? startedAt, startedAt));
      const states = new Map(
        (
          await this.repo.findMirrorTargetStates(
            payload.userId,
            targets.map((target) => target.bookId),
          )
        ).map((row) => [row.bookId, row]),
      );
      for (const target of targets) {
        outcomes.set(target.bookId, await this.mirrorOnto(payload, source, target, states.get(target.bookId), work.members, at));
      }
      const written = [...outcomes].filter(([, outcome]) => outcome === 'written').map(([bookId]) => bookId);
      if (written.length > 0) {
        await this.events.notifyBooksChanged(
          payload.userId,
          written,
          targets.filter((target) => target.role === 'audio').map((target) => target.bookId),
        );
        this.logger.debug(
          `[${EVENT}] [end] userId=${payload.userId} bookId=${payload.bookId} durationMs=${Date.now() - startedAt} targets=${targets.length} written=${written.length} - progress mirrored`,
        );
      }
      return outcomes;
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : 'UnknownError';
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[${EVENT}] [fail] userId=${payload.userId} bookId=${payload.bookId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - progress mirror failed`,
      );
      return outcomes;
    }
  }

  private async mirrorOnto(
    payload: BookProgressChangedPayload,
    source: WorkMember,
    target: WorkMember,
    state: MirrorTargetState | undefined,
    members: readonly WorkMember[],
    at: Date,
  ): Promise<MirrorOutcome> {
    if (!state) return 'skipped_no_position';
    if (await this.isOwned(source, target, members)) return 'skipped_owned';
    const percentage = Math.min(100, Math.max(0, payload.progress));

    if (target.role === 'audio') {
      if (state.audioPercentage !== null && Math.abs(state.audioPercentage - percentage) < MIN_DELTA) return 'skipped_close';
      if (state.audioUpdatedAt && state.audioUpdatedAt >= at) return 'skipped_newer';
      const position = audioPositionAt(await this.repo.findAudioPlayOrder(target.bookId), percentage);
      if (!position) return 'skipped_no_position';
      const applied = await this.repo.mirrorAudiobookProgress(
        payload.userId,
        target.bookId,
        position.currentFileId,
        position.positionSeconds,
        percentage,
        at,
      );
      return applied ? 'written' : 'skipped_newer';
    }

    if (state.primaryFileId === null) return 'skipped_no_position';
    if (state.filePercentage !== null && Math.abs(state.filePercentage - percentage) < MIN_DELTA) return 'skipped_close';
    const activeAt =
      state.fileProjectedAt && state.fileLastReadAt && state.fileProjectedAt >= state.fileLastReadAt ? state.fileProjectedAt : state.fileLastReadAt;
    if (activeAt && activeAt >= at) return 'skipped_newer';
    const applied = await this.repo.mirrorReadingProgress(payload.userId, state.primaryFileId, percentage, at);
    return applied ? 'written' : 'skipped_newer';
  }

  private async isOwned(source: WorkMember, target: WorkMember, members: readonly WorkMember[]): Promise<boolean> {
    const primaryOf = (role: WorkVariantRole) => members.find((member) => member.role === role && member.isPrimary)?.bookId ?? null;
    const pair = [source, target];
    const text = pair.find((member) => member.role === 'text');
    const audio = pair.find((member) => member.role === 'audio');
    const readAlong = pair.find((member) => member.role === 'readAlong');
    const primaryPair = (member: WorkMember | undefined) => member !== undefined && primaryOf(member.role) === member.bookId;

    const alignmentReady =
      text !== undefined &&
      audio !== undefined &&
      primaryPair(text) &&
      primaryPair(audio) &&
      (await this.repo.hasReadyAlignment(text.bookId, audio.bookId));
    const readAlongOffsets = readAlong !== undefined && audio !== undefined && (await this.repo.hasReadAlongOffsets(readAlong.bookId, audio.bookId));
    return mirrorSkipReason(source.role, target.role, { alignmentReady, readAlongOffsets }) !== null;
  }
}
