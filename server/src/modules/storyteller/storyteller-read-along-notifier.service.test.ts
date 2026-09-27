import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationType } from '@bookorbit/types';
import {
  StorytellerReadAlongNotifierService,
  readAlongAttempt,
  readAlongAttemptFromNotification,
  readAlongNotifyStage,
} from './storyteller-read-along-notifier.service';

const QUEUED_AT = new Date('2026-02-01T00:00:00Z');
const ATTEMPT = { buildId: 7, textBookId: 10, stamp: QUEUED_AT.getTime() };
const KEY = `read_along_build:7:${QUEUED_AT.getTime()}`;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function setup() {
  const notifications = { upsertByGroupKey: vi.fn().mockResolvedValue(undefined) };
  const repo = {
    findBookTitleAndAuthors: vi.fn().mockResolvedValue({ title: 'Dune', authorNames: [], isbn10: null, isbn13: null, asin: null }),
  };
  const libraryService = { findOne: vi.fn().mockResolvedValue({ id: 3, name: 'Read-alongs' }) };
  const notifier = new StorytellerReadAlongNotifierService(notifications as never, repo as never, libraryService as never);
  const lastPatch = () => notifications.upsertByGroupKey.mock.calls.at(-1)![2];
  const lastOptions = () => notifications.upsertByGroupKey.mock.calls.at(-1)![3];
  const sentMessages = () => notifications.upsertByGroupKey.mock.calls.map((call) => call[2].title as string);
  return { notifier, notifications, repo, libraryService, lastPatch, lastOptions, sentMessages };
}

describe('StorytellerReadAlongNotifierService', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-03-01T00:00:00Z') }));
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('attempt keys', () => {
    it('keys an attempt to its row and the time the attempt began', () => {
      const started = new Date('2026-03-01T00:00:00Z');

      expect(readAlongAttempt({ id: 7, textBookId: 10, attemptAt: QUEUED_AT, queuedAt: QUEUED_AT, startedAt: started })).toEqual(ATTEMPT);
      expect(readAlongAttempt({ id: 7, textBookId: 10, attemptAt: null, queuedAt: null, startedAt: started }).stamp).toBe(started.getTime());
    });

    it('keeps the key of an attempt a restart re-queued, whose queued_at moved', () => {
      const interrupted = { id: 7, textBookId: 10, attemptAt: QUEUED_AT, queuedAt: null, startedAt: new Date('2026-02-02T00:00:00Z') };
      const requeued = { ...interrupted, queuedAt: new Date('2026-03-01T00:00:00Z'), startedAt: new Date('2026-03-01T00:01:00Z') };

      expect(readAlongAttempt(requeued)).toEqual(readAlongAttempt(interrupted));
      expect(readAlongAttempt(requeued).stamp).toBe(QUEUED_AT.getTime());
    });

    it('sends every notification of one attempt to the same row, and a later rebuild of the pair to a new one', async () => {
      const { notifier, notifications } = setup();
      const rebuild = { ...ATTEMPT, stamp: ATTEMPT.stamp + 21 * 24 * 60 * 60_000 };

      await notifier.queued(42, ATTEMPT, 2);
      await notifier.started(42, ATTEMPT);
      await notifier.started(42, rebuild);

      expect(notifications.upsertByGroupKey.mock.calls.map((call) => [call[0], call[1]])).toEqual([
        [42, KEY],
        [42, KEY],
        [42, `read_along_build:7:${rebuild.stamp}`],
      ]);
    });
  });

  describe('lifecycle messages', () => {
    it('describes a queued build with its place in line, and may create the row', async () => {
      const { notifier, lastPatch, lastOptions } = setup();

      await notifier.queued(42, ATTEMPT, 2);

      expect(lastPatch()).toEqual({
        type: NotificationType.ReadAlongBuild,
        title: 'Read-along queued: Dune',
        message: 'Waiting for another read-along to finish (2 in line)',
        meta: { buildId: 7, bookId: 10, locked: true, cancellable: true },
      });
      expect(lastOptions()).toEqual({ markUnread: false, updateOnly: false });
    });

    it('describes a started build', async () => {
      const { notifier, lastPatch } = setup();

      await notifier.started(42, ATTEMPT);

      expect(lastPatch()).toMatchObject({
        title: 'Building read-along: Dune',
        message: 'Sending to Storyteller',
        meta: { buildId: 7, bookId: 10, locked: true, cancellable: true },
      });
    });

    it('reports progress with the stage name, the percentage and meta.progress, updating only', async () => {
      const { notifier, lastPatch, lastOptions } = setup();

      await notifier.progress(42, ATTEMPT, 'transcribing', 0.123);

      expect(lastPatch()).toEqual({
        type: NotificationType.ReadAlongBuild,
        title: 'Building read-along: Dune',
        message: 'Transcribing · 12%',
        meta: { buildId: 7, bookId: 10, progress: 0.12, locked: true, cancellable: true },
      });
      expect(lastOptions()).toEqual({ markUnread: false, updateOnly: true });
    });

    it('stays locked while importing but can no longer be cancelled', async () => {
      const { notifier, lastPatch } = setup();

      await notifier.progress(42, ATTEMPT, 'importing', null);

      expect(lastPatch().meta).toEqual({ buildId: 7, bookId: 10, locked: true, cancellable: false });
    });

    it('describes a ready read-along with its library and a link to it, and marks it unread', async () => {
      const { notifier, lastPatch, lastOptions, libraryService } = setup();

      await notifier.ready(42, ATTEMPT, 99, 3);

      expect(libraryService.findOne).toHaveBeenCalledWith(3);
      expect(lastPatch()).toEqual({
        type: NotificationType.ReadAlongBuild,
        title: 'Read-along ready: Dune',
        message: 'Added to Read-alongs',
        actionUrl: '/book/99',
        meta: { buildId: 7, bookId: 10, done: true, locked: false, cancellable: false },
      });
      expect(lastOptions()).toEqual({ markUnread: true, updateOnly: false });
    });

    it('describes a failure with the error and a link to the text edition', async () => {
      const { notifier, lastPatch, lastOptions } = setup();

      await notifier.failed(42, ATTEMPT, 'no audio');

      expect(lastPatch()).toEqual({
        type: NotificationType.ReadAlongBuildFailed,
        title: 'Read-along failed: Dune',
        message: 'no audio',
        actionUrl: '/book/10?tab=details',
        meta: { buildId: 7, bookId: 10, done: true, locked: false, cancellable: false },
      });
      expect(lastOptions()).toMatchObject({ markUnread: true });
    });

    it('describes a cancelled build', async () => {
      const { notifier, lastPatch } = setup();

      await notifier.cancelled(42, ATTEMPT);

      expect(lastPatch()).toEqual({
        type: NotificationType.ReadAlongBuild,
        title: 'Read-along cancelled: Dune',
        meta: { buildId: 7, bookId: 10, done: true, locked: false, cancellable: false },
      });
    });

    it('ends a notification whose build is gone as a dismissable failure, only while it is still locked', async () => {
      const { notifier, lastPatch, lastOptions } = setup();

      await notifier.untracked(42, ATTEMPT);

      expect(lastPatch()).toEqual({
        type: NotificationType.ReadAlongBuildFailed,
        title: 'Read-along failed: Dune',
        message: 'This build is no longer running',
        actionUrl: '/book/10?tab=details',
        meta: { buildId: 7, bookId: 10, done: true, locked: false, cancellable: false },
      });
      expect(lastOptions()).toEqual({ markUnread: true, updateOnly: true, onlyWhileLocked: true });
    });

    it('clips the title to 200 characters and the message to 1000, by code point', async () => {
      const { notifier, repo, lastPatch } = setup();
      repo.findBookTitleAndAuthors.mockResolvedValue({ title: '😀'.repeat(400), authorNames: [] });

      await notifier.failed(42, ATTEMPT, 'x'.repeat(3000));

      const patch = lastPatch();
      expect(Array.from(patch.title as string)).toHaveLength(200);
      expect(patch.title.startsWith('Read-along failed: ')).toBe(true);
      expect(patch.message).toHaveLength(1000);
    });
  });

  describe('throttling', () => {
    it('sends a stage change at once, however recent the last update was', async () => {
      const { notifier, notifications, lastPatch } = setup();

      await notifier.progress(42, ATTEMPT, 'transcribing', 0.9);
      await notifier.progress(42, ATTEMPT, 'aligning', 0.01);

      expect(notifications.upsertByGroupKey).toHaveBeenCalledTimes(2);
      expect(lastPatch().message).toBe('Aligning · 1%');
    });

    it('holds back progress within a stage until it moved five points and thirty seconds passed', async () => {
      const { notifier, notifications, lastPatch } = setup();
      await notifier.progress(42, ATTEMPT, 'transcribing', 0.1);

      await notifier.progress(42, ATTEMPT, 'transcribing', 0.3);
      expect(notifications.upsertByGroupKey).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(30_000);
      await notifier.progress(42, ATTEMPT, 'transcribing', 0.13);
      expect(notifications.upsertByGroupKey).toHaveBeenCalledTimes(1);

      await notifier.progress(42, ATTEMPT, 'transcribing', 0.15);
      expect(notifications.upsertByGroupKey).toHaveBeenCalledTimes(2);
      expect(lastPatch().message).toBe('Transcribing · 15%');
    });
  });

  describe('ordering after the outcome', () => {
    it('runs the sends of one attempt one after another', async () => {
      const { notifier, notifications, sentMessages } = setup();
      const gate = deferred();
      notifications.upsertByGroupKey.mockImplementationOnce(() => gate.promise);

      const queued = notifier.queued(42, ATTEMPT, 1);
      const started = notifier.started(42, ATTEMPT);
      await vi.advanceTimersByTimeAsync(0);
      expect(notifications.upsertByGroupKey).toHaveBeenCalledOnce();

      gate.resolve();
      await Promise.all([queued, started]);
      expect(sentMessages()).toEqual(['Read-along queued: Dune', 'Building read-along: Dune']);
    });

    it('drops a start that arrives after the failure was sent', async () => {
      const { notifier, sentMessages } = setup();

      const failed = notifier.failed(42, ATTEMPT, 'boom');
      const started = notifier.started(42, ATTEMPT);
      await Promise.all([failed, started]);

      expect(sentMessages()).toEqual(['Read-along failed: Dune']);
    });

    it('drops a progress tick that arrives after the cancel was sent', async () => {
      const { notifier, sentMessages } = setup();

      const cancelled = notifier.cancelled(42, ATTEMPT);
      const progress = notifier.progress(42, ATTEMPT, 'aligning', 0.5);
      await Promise.all([cancelled, progress]);

      expect(sentMessages()).toEqual(['Read-along cancelled: Dune']);
    });

    it('forgets an attempt once its outcome has been sent', async () => {
      const { notifier } = setup();

      await notifier.progress(42, ATTEMPT, 'aligning', 0.5);
      await notifier.ready(42, ATTEMPT, 99, null);
      await vi.advanceTimersByTimeAsync(0);

      expect(notifier['chains'].size).toBe(0);
      expect(notifier['lastProgress'].size).toBe(0);
      expect(notifier['finished'].size).toBe(0);
    });
  });

  it('logs a notification it could not send and never throws', async () => {
    const { notifier, notifications } = setup();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    notifications.upsertByGroupKey.mockRejectedValue(new Error('db "down"'));

    await expect(notifier.failed(42, ATTEMPT, 'boom')).resolves.toBeUndefined();

    expect(String(warn.mock.calls[0]![0])).toMatch(
      /^\[storyteller\.read_along\.notify\] \[fail\] buildId=7 userId=42 step=failed durationMs=\d+ errorClass=Error error="db \\"down\\""/,
    );
  });
});

describe('readAlongNotifyStage', () => {
  it.each([
    ['prepare', null, 'sending'],
    ['process', null, 'sending'],
    ['wait', 'transcribe', 'transcribing'],
    ['wait', 'SYNC_CHAPTERS', 'aligning'],
    ['collect', null, 'importing'],
    ['link', null, 'importing'],
  ])('maps %s with task %s to %s', (phase, task, stage) => {
    expect(readAlongNotifyStage(phase, task)).toBe(stage);
  });
});

describe('readAlongAttemptFromNotification', () => {
  it('reads the attempt back from the key and meta the notifier wrote', () => {
    expect(readAlongAttemptFromNotification(KEY, { buildId: 7, bookId: 10, locked: true })).toEqual(ATTEMPT);
  });

  it.each([
    ['another key shape', 'scan_completed:user', { buildId: 7, bookId: 10 }],
    ['no key', null, { buildId: 7, bookId: 10 }],
    ['no book id', KEY, { buildId: 7 }],
    ['a build id the key does not name', KEY, { buildId: 8, bookId: 10 }],
  ])('answers null for %s', (_case, key, meta) => {
    expect(readAlongAttemptFromNotification(key, meta)).toBeNull();
  });
});
