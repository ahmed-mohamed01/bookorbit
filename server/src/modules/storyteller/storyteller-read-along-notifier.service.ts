import { Injectable, Logger } from '@nestjs/common';

import { NotificationType, type ReadAlongNotificationMeta } from '@bookorbit/types';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { LibraryService } from '../library/library.service';
import { NotificationService, type NotificationPatch, type UpsertByGroupKeyOptions } from '../notification/notification.service';
import { describeError } from './storyteller-log.utils';
import { StorytellerRepository } from './storyteller.repository';

const NOTIFY_EVENT = 'storyteller.read_along.notify';
const PROGRESS_MIN_STEP_POINTS = 5;
const PROGRESS_MIN_INTERVAL_MS = 30_000;
const MAX_TITLE_CHARS = 200;
const MAX_MESSAGE_CHARS = 1000;

export type ReadAlongNotifyStage = 'sending' | 'transcribing' | 'aligning' | 'importing';

// The four stages the read-along panel shows, in its words.
const STAGE_LABELS: Record<ReadAlongNotifyStage, string> = {
  sending: 'Sending',
  transcribing: 'Transcribing',
  aligning: 'Aligning',
  importing: 'Importing',
};

/** The panel's stage for a build phase: any Storyteller task other than syncing counts as transcription. */
export function readAlongNotifyStage(phase: string | null, remoteTask: string | null): ReadAlongNotifyStage {
  if (phase === 'wait') return remoteTask?.toUpperCase() === 'SYNC_CHAPTERS' ? 'aligning' : 'transcribing';
  if (phase === 'collect' || phase === 'link') return 'importing';
  return 'sending';
}

/**
 * One build attempt: a row is reused by every later retry or rebuild of its pair, so the attempt's
 * origin (when it was queued, else when it started) keeps each attempt on its own notification.
 */
export interface ReadAlongAttempt {
  buildId: number;
  textBookId: number;
  stamp: number;
}

export function readAlongAttempt(row: { id: number; textBookId: number; queuedAt: Date | null; startedAt: Date | null }): ReadAlongAttempt {
  return { buildId: row.id, textBookId: row.textBookId, stamp: (row.queuedAt ?? row.startedAt)?.getTime() ?? 0 };
}

type SendKind = 'queued' | 'started' | 'progress' | 'ready' | 'failed' | 'cancelled';

const TERMINAL_KINDS: ReadonlySet<SendKind> = new Set(['ready', 'failed', 'cancelled']);

interface SentProgress {
  stage: ReadAlongNotifyStage;
  percent: number | null;
  sentAt: number;
}

function clip(value: string, maxChars: number): string {
  const chars = Array.from(value);
  return chars.length <= maxChars ? value : chars.slice(0, maxChars).join('');
}

/**
 * One notification per build attempt, rewritten in place from queued to its end so the bell tracks it
 * the way the panel does. Sends for one attempt run one after another, and once its outcome is sent
 * a late start or progress tick is dropped rather than overwriting it. Every call is best effort: a
 * notification that cannot be written never fails or slows a build.
 */
@Injectable()
export class StorytellerReadAlongNotifierService {
  private readonly logger = new Logger(StorytellerReadAlongNotifierService.name);
  private readonly lastProgress = new Map<string, SentProgress>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly finished = new Set<string>();

  constructor(
    private readonly notifications: NotificationService,
    private readonly repo: StorytellerRepository,
    private readonly libraryService: LibraryService,
  ) {}

  queued(userId: number, attempt: ReadAlongAttempt, position: number): Promise<void> {
    return this.send(userId, attempt, 'queued', (title) => ({
      type: NotificationType.ReadAlongBuild,
      title: `Read-along queued: ${title}`,
      message: `Waiting for another read-along to finish (${position} in line)`,
      meta: this.meta(attempt, {}),
    }));
  }

  started(userId: number, attempt: ReadAlongAttempt): Promise<void> {
    const key = this.chainKey(userId, attempt);
    if (!this.finished.has(key)) this.lastProgress.set(key, { stage: 'sending', percent: null, sentAt: Date.now() });
    return this.send(userId, attempt, 'started', (title) => ({
      type: NotificationType.ReadAlongBuild,
      title: `Building read-along: ${title}`,
      message: 'Sending to Storyteller',
      meta: this.meta(attempt, {}),
    }));
  }

  /**
   * Sent when the stage changes, or when the percentage has moved at least five points and thirty
   * seconds have passed since the last one: a twelve-hour build polls far more often than anyone reads.
   */
  progress(userId: number, attempt: ReadAlongAttempt, stage: ReadAlongNotifyStage, progress: number | null): Promise<void> {
    const key = this.chainKey(userId, attempt);
    if (this.finished.has(key)) return Promise.resolve();
    const now = Date.now();
    const percent = progress === null || !Number.isFinite(progress) ? null : Math.round(Math.min(Math.max(progress, 0), 1) * 100);
    const last = this.lastProgress.get(key);
    if (last && last.stage === stage) {
      const moved = percent !== null && (last.percent === null || Math.abs(percent - last.percent) >= PROGRESS_MIN_STEP_POINTS);
      if (!moved || now - last.sentAt < PROGRESS_MIN_INTERVAL_MS) return Promise.resolve();
    }
    this.lastProgress.set(key, { stage, percent, sentAt: now });
    const label = STAGE_LABELS[stage];
    return this.send(userId, attempt, 'progress', (title) => ({
      type: NotificationType.ReadAlongBuild,
      title: `Building read-along: ${title}`,
      message: percent === null ? label : `${label} · ${percent}%`,
      meta: this.meta(attempt, percent === null ? {} : { progress: percent / 100 }),
    }));
  }

  ready(userId: number, attempt: ReadAlongAttempt, outputBookId: number, targetLibraryId: number | null): Promise<void> {
    return this.send(userId, attempt, 'ready', async (title) => {
      const library = targetLibraryId === null ? null : await this.libraryService.findOne(targetLibraryId).catch(() => null);
      return {
        type: NotificationType.ReadAlongBuild,
        title: `Read-along ready: ${title}`,
        message: library?.name ? `Added to ${library.name}` : undefined,
        actionUrl: `/book/${outputBookId}`,
        meta: this.meta(attempt, { done: true }),
      };
    });
  }

  failed(userId: number, attempt: ReadAlongAttempt, error: string): Promise<void> {
    return this.send(userId, attempt, 'failed', (title) => ({
      type: NotificationType.ReadAlongBuildFailed,
      title: `Read-along failed: ${title}`,
      message: error,
      actionUrl: `/book/${attempt.textBookId}?tab=details`,
      meta: this.meta(attempt, { done: true }),
    }));
  }

  cancelled(userId: number, attempt: ReadAlongAttempt): Promise<void> {
    return this.send(userId, attempt, 'cancelled', (title) => ({
      type: NotificationType.ReadAlongBuild,
      title: `Read-along cancelled: ${title}`,
      meta: this.meta(attempt, { done: true }),
    }));
  }

  private groupKey(attempt: ReadAlongAttempt): string {
    return `read_along_build:${attempt.buildId}:${attempt.stamp}`;
  }

  private chainKey(userId: number, attempt: ReadAlongAttempt): string {
    return `${userId}:${this.groupKey(attempt)}`;
  }

  private meta(attempt: ReadAlongAttempt, extra: Omit<ReadAlongNotificationMeta, 'buildId'>): Record<string, unknown> {
    const meta: ReadAlongNotificationMeta = { buildId: attempt.buildId, ...extra };
    return { ...meta };
  }

  private send(
    userId: number,
    attempt: ReadAlongAttempt,
    kind: SendKind,
    compose: (title: string) => NotificationPatch | Promise<NotificationPatch>,
  ): Promise<void> {
    const key = this.chainKey(userId, attempt);
    const terminal = TERMINAL_KINDS.has(kind);
    if (!terminal && this.finished.has(key)) return Promise.resolve();
    if (terminal) this.finished.add(key);

    // Terminal sends mark the row unread so the outcome reaches the bell even after the progress row
    // was read; progress only ever updates a row, so a dismissed notification stays dismissed.
    const options: UpsertByGroupKeyOptions = { markUnread: terminal, updateOnly: kind === 'progress' };
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(() => this.deliver(userId, attempt, kind, compose, options));
    this.chains.set(key, next);
    if (terminal) {
      void next.then(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
        this.lastProgress.delete(key);
        this.finished.delete(key);
      });
    }
    return next;
  }

  private async deliver(
    userId: number,
    attempt: ReadAlongAttempt,
    kind: SendKind,
    compose: (title: string) => NotificationPatch | Promise<NotificationPatch>,
    options: UpsertByGroupKeyOptions,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      const identity = await this.repo.findBookTitleAndAuthors(attempt.textBookId);
      const patch = await compose(identity?.title || 'Untitled');
      const bounded: NotificationPatch = {
        ...patch,
        title: clip(patch.title, MAX_TITLE_CHARS),
        message: patch.message === undefined ? undefined : clip(patch.message, MAX_MESSAGE_CHARS),
      };
      await this.notifications.upsertByGroupKey(userId, this.groupKey(attempt), bounded, options);
    } catch (error) {
      const { errorClass, message } = describeError(error);
      this.logger.warn(
        `[${NOTIFY_EVENT}] [fail] buildId=${attempt.buildId} userId=${userId} step=${kind} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - read-along notification could not be sent`,
      );
    }
  }
}
