import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BookProgressChangedPayload } from '../achievement/achievement-events.service';
import { ReadingAlignmentSyncService } from './reading-alignment-sync.service';

const USER_ID = 42;
const TEXT_BOOK_ID = 8;
const AUDIO_BOOK_ID = 9;
const EBOOK_FILE_ID = 5;
const AUDIO_FILE_A = 20;
const AUDIO_FILE_B = 21;

const NEWER = new Date('2026-02-02T00:00:00Z');
const MIDDLE = new Date('2026-01-15T00:00:00Z');
const OLDER = new Date('2026-01-01T00:00:00Z');

// Two anchors spanning 0..200s over ebook fraction 0..1, with fractions already backfilled.
function anchors() {
  return [
    { id: 1, alignmentId: 3, audioSeconds: 0, spineIndex: 0, phrase: 'start', confidence: 1, ebookFraction: 0 },
    { id: 2, alignmentId: 3, audioSeconds: 200, spineIndex: 4, phrase: 'end', confidence: 1, ebookFraction: 1 },
  ];
}

// Two 100s files: absolute timeline 0..200s.
function playOrder() {
  return [
    { fileId: AUDIO_FILE_A, durationSeconds: 100 },
    { fileId: AUDIO_FILE_B, durationSeconds: 100 },
  ];
}

interface Overrides {
  pair?: { textBookId: number; audioBookId: number } | null;
  ready?: unknown;
  ebookProgress?: { percentage: number; updatedAt: Date; lastReadAt?: Date } | undefined;
  audioProgress?: { currentFileId: number; positionSeconds: number; percentage: number; updatedAt: Date } | undefined;
  bookFileKind?: 'text' | 'audio' | null;
  finishThreshold?: number;
  advancingReadStatus?: { status: string } | undefined;
}

function build(overrides: Overrides = {}) {
  const pairService = {
    resolveAlignmentPair: vi
      .fn()
      .mockResolvedValue(overrides.pair === undefined ? { textBookId: TEXT_BOOK_ID, audioBookId: AUDIO_BOOK_ID } : overrides.pair),
  };
  const ready = 'ready' in overrides ? overrides.ready : { alignment: { id: 3, ebookFileId: EBOOK_FILE_ID }, anchors: anchors() };
  const repo = {
    getReadyAlignmentWithAnchors: vi.fn().mockResolvedValue(ready),
    getReadingProgress: vi.fn().mockResolvedValue(overrides.ebookProgress),
    getAudiobookProgress: vi.fn().mockResolvedValue(overrides.audioProgress),
    resolveAudioPlayOrder: vi.fn().mockResolvedValue(playOrder()),
    resolveBookFileKind: vi.fn().mockResolvedValue(overrides.bookFileKind ?? null),
    projectAudiobookProgress: vi.fn().mockResolvedValue(true),
    getUserBookStatus: vi.fn().mockResolvedValue('advancingReadStatus' in overrides ? overrides.advancingReadStatus : { status: 'read' }),
  };
  const achievementEvents = { on: vi.fn(), removeListener: vi.fn(), emit: vi.fn() };
  const bookReadService = { findLibraryIdByBookId: vi.fn().mockResolvedValue(1) };
  const libraryService = {
    findOne: vi.fn().mockResolvedValue({ markAsFinishedPercentComplete: overrides.finishThreshold ?? 98 }),
  };
  const bookService = {
    autoUpdateReadStatusForProgress: vi.fn().mockResolvedValue(undefined),
    verifyBookAccess: vi.fn().mockResolvedValue(undefined),
  };
  const userService = { findByIdWithPermissions: vi.fn().mockResolvedValue({ id: USER_ID, isSuperuser: false, contentFilters: undefined }) };

  const service = new ReadingAlignmentSyncService(
    achievementEvents as never,
    pairService as never,
    repo as never,
    bookReadService as never,
    libraryService as never,
    bookService as never,
    userService as never,
  );
  return { service, pairService, repo, achievementEvents, bookReadService, libraryService, bookService, userService };
}

// Drives the private listener the same way the event bus would, but awaited so assertions are stable.
function dispatch(service: ReadingAlignmentSyncService, payload: BookProgressChangedPayload): Promise<void> {
  return (service as unknown as { handleProgressChanged: (p: BookProgressChangedPayload) => Promise<void> }).handleProgressChanged(payload);
}

function ebookEvent(overrides: Partial<BookProgressChangedPayload> = {}): BookProgressChangedPayload {
  return { userId: USER_ID, bookId: TEXT_BOOK_ID, bookFileId: EBOOK_FILE_ID, progress: 50, source: 'web_reader', ...overrides };
}

function audioEvent(overrides: Partial<BookProgressChangedPayload> = {}): BookProgressChangedPayload {
  return { userId: USER_ID, bookId: AUDIO_BOOK_ID, bookFileId: AUDIO_FILE_A, progress: 25, source: 'web_reader', ...overrides };
}

describe('ReadingAlignmentSyncService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('lifecycle', () => {
    it('registers and removes its listener', () => {
      const { service, achievementEvents } = build();
      service.onModuleInit();
      expect(achievementEvents.on).toHaveBeenCalledWith('book.progress-changed', expect.any(Function));
      service.onModuleDestroy();
      expect(achievementEvents.removeListener).toHaveBeenCalledWith('book.progress-changed', expect.any(Function));
    });
  });

  describe('ebook advance projects to audio', () => {
    it('maps the ebook percentage to an audio file position and writes it', async () => {
      const { service, repo, achievementEvents } = build({
        ebookProgress: { percentage: 50, updatedAt: NEWER },
        audioProgress: undefined,
      });

      await dispatch(service, ebookEvent());

      // fraction 0.5 -> 100s absolute -> second file (start 100s) offset 0s; 100/200 -> 50%.
      expect(repo.projectAudiobookProgress).toHaveBeenCalledWith(USER_ID, AUDIO_BOOK_ID, AUDIO_FILE_B, 0, 50, NEWER);
      // The projection must NOT re-emit a progress event - that drove external trackers (Storygraph /
      // Hardcover) and achievement eval off derived, non-user progress.
      expect(achievementEvents.emit).not.toHaveBeenCalled();
    });
  });

  describe('audio advance syncs ebook status only (no position clobber)', () => {
    it('advances the ebook read status but never writes the ebook position or emits a progress refresh', async () => {
      const { service, repo, achievementEvents, bookService } = build({
        audioProgress: { currentFileId: AUDIO_FILE_A, positionSeconds: 50, percentage: 25, updatedAt: NEWER },
        ebookProgress: undefined,
      });

      await dispatch(service, audioEvent());

      // The ebook keeps its own last-read position; the open-time resolver provides a precise resume.
      // 50s absolute -> fraction 0.25 -> ebook status advanced to 25%.
      expect(bookService.autoUpdateReadStatusForProgress).toHaveBeenCalledWith(USER_ID, { bookId: TEXT_BOOK_ID, libraryId: 1 }, 25);
      expect(repo.projectAudiobookProgress).not.toHaveBeenCalled();
      // No coarse position is written onto reading_progress, and no ebook progress event is emitted.
      expect(achievementEvents.emit).not.toHaveBeenCalled();
    });
  });

  describe('newest-wins', () => {
    it('skips an ebook advance when the audio counterpart is fresher', async () => {
      const { service, repo, achievementEvents } = build({
        ebookProgress: { percentage: 50, updatedAt: OLDER },
        audioProgress: { currentFileId: AUDIO_FILE_A, positionSeconds: 10, percentage: 40, updatedAt: NEWER },
      });

      await dispatch(service, ebookEvent());

      expect(repo.projectAudiobookProgress).not.toHaveBeenCalled();
      expect(achievementEvents.emit).not.toHaveBeenCalled();
    });

    it('skips an ebook advance when timestamps are equal (not strictly newer)', async () => {
      const { service, repo } = build({
        ebookProgress: { percentage: 50, updatedAt: NEWER },
        audioProgress: { currentFileId: AUDIO_FILE_A, positionSeconds: 10, percentage: 40, updatedAt: NEWER },
      });

      await dispatch(service, ebookEvent());

      expect(repo.projectAudiobookProgress).not.toHaveBeenCalled();
    });
  });

  describe('no projection targets', () => {
    it('does nothing when the book has no alignment pair', async () => {
      const { service, repo } = build({ pair: null });

      await dispatch(service, ebookEvent());

      expect(repo.getReadyAlignmentWithAnchors).not.toHaveBeenCalled();
      expect(repo.projectAudiobookProgress).not.toHaveBeenCalled();
    });

    it('does nothing when the pair has no ready alignment', async () => {
      const { service, repo } = build({ ready: undefined, ebookProgress: { percentage: 50, updatedAt: NEWER } });

      await dispatch(service, ebookEvent());

      expect(repo.projectAudiobookProgress).not.toHaveBeenCalled();
    });

    it('does nothing when fewer than two anchors carry an ebook fraction', async () => {
      const partialAnchors = [
        { id: 1, alignmentId: 3, audioSeconds: 0, spineIndex: 0, phrase: 'start', confidence: 1, ebookFraction: 0 },
        { id: 2, alignmentId: 3, audioSeconds: 200, spineIndex: 4, phrase: 'end', confidence: 1, ebookFraction: null },
      ];
      const { service, repo } = build({
        ready: { alignment: { id: 3, ebookFileId: EBOOK_FILE_ID }, anchors: partialAnchors },
        ebookProgress: { percentage: 50, updatedAt: NEWER },
      });

      await dispatch(service, ebookEvent());

      expect(repo.projectAudiobookProgress).not.toHaveBeenCalled();
    });
  });

  describe('status sync', () => {
    it('completes the counterpart status when the advancing side is finished', async () => {
      const { service, bookService } = build({
        ebookProgress: { percentage: 100, updatedAt: NEWER },
        finishThreshold: 98,
      });

      await dispatch(service, ebookEvent({ progress: 100 }));

      expect(bookService.autoUpdateReadStatusForProgress).toHaveBeenCalledWith(USER_ID, { bookId: AUDIO_BOOK_ID, libraryId: 1 }, 100);
    });

    it('does not force completion when the advancing side is below the finish threshold', async () => {
      const { service, bookService } = build({
        ebookProgress: { percentage: 50, updatedAt: NEWER },
        finishThreshold: 98,
      });

      await dispatch(service, ebookEvent());

      // Counterpart status advances with the mapped percentage, not a forced 100.
      expect(bookService.autoUpdateReadStatusForProgress).toHaveBeenCalledWith(USER_ID, { bookId: AUDIO_BOOK_ID, libraryId: 1 }, 50);
    });
  });

  describe('freshness signal (occurredAt)', () => {
    it('projects an ebook advance whose row timestamp is frozen (KOReader) using the event occurredAt', async () => {
      const { service, repo } = build({
        ebookProgress: { percentage: 50, updatedAt: OLDER }, // reading_progress.updatedAt frozen by KOReader
        audioProgress: { currentFileId: AUDIO_FILE_A, positionSeconds: 10, percentage: 40, updatedAt: MIDDLE },
      });

      // The real device read time (occurredAt) is newer than the audio side, so the advance projects and
      // the audio write is stamped with it - not the stale row time.
      await dispatch(service, ebookEvent({ source: 'koreader', occurredAt: NEWER }));

      expect(repo.projectAudiobookProgress).toHaveBeenCalledWith(USER_ID, AUDIO_BOOK_ID, AUDIO_FILE_B, 0, 50, NEWER);
    });

    it('skips that same advance when no occurredAt is provided and the row time is stale', async () => {
      const { service, repo } = build({
        ebookProgress: { percentage: 50, updatedAt: OLDER },
        audioProgress: { currentFileId: AUDIO_FILE_A, positionSeconds: 10, percentage: 40, updatedAt: MIDDLE },
      });

      await dispatch(service, ebookEvent({ source: 'koreader' }));

      expect(repo.projectAudiobookProgress).not.toHaveBeenCalled();
    });

    it('uses the event occurredAt as the freshness signal for an audio advance status sync', async () => {
      const { service, bookService } = build({
        audioProgress: { currentFileId: AUDIO_FILE_A, positionSeconds: 50, percentage: 25, updatedAt: OLDER },
        ebookProgress: { percentage: 10, updatedAt: MIDDLE },
      });

      // The audio row time (OLDER) is stale vs the ebook (MIDDLE), but the real activity time (occurredAt)
      // is newer, so the ebook status still advances. 50s absolute -> fraction 0.25 -> 25%.
      await dispatch(service, audioEvent({ occurredAt: NEWER }));

      expect(bookService.autoUpdateReadStatusForProgress).toHaveBeenCalledWith(USER_ID, { bookId: TEXT_BOOK_ID, libraryId: 1 }, 25);
    });
  });

  describe('stale projection guard', () => {
    it('does not sync status or emit a refresh when the atomic write is a no-op (a fresher write won)', async () => {
      const { service, repo, bookService, achievementEvents } = build({
        ebookProgress: { percentage: 50, updatedAt: NEWER },
        audioProgress: undefined,
      });
      repo.projectAudiobookProgress.mockResolvedValue(false);

      await dispatch(service, ebookEvent());

      expect(repo.projectAudiobookProgress).toHaveBeenCalled();
      expect(bookService.autoUpdateReadStatusForProgress).not.toHaveBeenCalled();
      expect(achievementEvents.emit).not.toHaveBeenCalled();
    });
  });

  describe('counterpart access', () => {
    it('does not project onto a counterpart the user can no longer access', async () => {
      const { service, repo, bookService } = build({ ebookProgress: { percentage: 50, updatedAt: NEWER }, audioProgress: undefined });
      bookService.verifyBookAccess.mockRejectedValue(new ForbiddenException('No access to this library'));

      await dispatch(service, ebookEvent());

      expect(repo.projectAudiobookProgress).not.toHaveBeenCalled();
    });

    it('does not project onto a counterpart hidden by the user content filters', async () => {
      const { service, repo, bookService } = build({ ebookProgress: { percentage: 50, updatedAt: NEWER }, audioProgress: undefined });
      // A content filter surfaces as NotFound from verifyBookAccess (the same signal the routes use), so
      // the background projection must skip the hidden counterpart rather than write progress onto it.
      bookService.verifyBookAccess.mockRejectedValue(new NotFoundException('Book 9 not found'));

      await dispatch(service, ebookEvent());

      expect(repo.projectAudiobookProgress).not.toHaveBeenCalled();
      expect(bookService.verifyBookAccess).toHaveBeenCalledWith(AUDIO_BOOK_ID, expect.objectContaining({ id: USER_ID }));
    });
  });

  describe('finish snapping', () => {
    it('snaps the audio to the end when the ebook is finished, even if anchors stop short', async () => {
      const shortAnchors = [
        { id: 1, alignmentId: 3, audioSeconds: 0, spineIndex: 0, phrase: 'start', confidence: 1, ebookFraction: 0 },
        { id: 2, alignmentId: 3, audioSeconds: 160, spineIndex: 4, phrase: 'near-end', confidence: 1, ebookFraction: 0.8 },
      ];
      const { service, repo } = build({
        ready: { alignment: { id: 3, ebookFileId: EBOOK_FILE_ID }, anchors: shortAnchors },
        ebookProgress: { percentage: 100, updatedAt: NEWER },
        audioProgress: undefined,
        finishThreshold: 98,
      });

      await dispatch(service, ebookEvent({ progress: 100 }));

      // Snapped to totalSeconds (200) -> last file end -> 100%, not the last anchor's 160s/80%.
      expect(repo.projectAudiobookProgress).toHaveBeenCalledWith(USER_ID, AUDIO_BOOK_ID, AUDIO_FILE_B, 100, 100, NEWER);
    });
  });

  describe('incomplete timeline', () => {
    it('skips projection when an audio file has an unknown duration', async () => {
      const { service, repo } = build({ ebookProgress: { percentage: 50, updatedAt: NEWER }, audioProgress: undefined });
      repo.resolveAudioPlayOrder.mockResolvedValue([
        { fileId: AUDIO_FILE_A, durationSeconds: null },
        { fileId: AUDIO_FILE_B, durationSeconds: 100 },
      ]);

      await dispatch(service, ebookEvent());

      expect(repo.projectAudiobookProgress).not.toHaveBeenCalled();
    });
  });

  describe('self-pair', () => {
    it('uses the event file kind to route an audio advance to the ebook side', async () => {
      const { service, repo, bookService } = build({
        pair: { textBookId: TEXT_BOOK_ID, audioBookId: TEXT_BOOK_ID },
        audioProgress: { currentFileId: AUDIO_FILE_A, positionSeconds: 50, percentage: 25, updatedAt: NEWER },
        ebookProgress: undefined,
        bookFileKind: 'audio',
      });

      await dispatch(service, { userId: USER_ID, bookId: TEXT_BOOK_ID, bookFileId: AUDIO_FILE_A, progress: 25, source: 'web_reader' });

      expect(repo.resolveBookFileKind).toHaveBeenCalledWith(AUDIO_FILE_A);
      // Routed into the audio->ebook path (reached the timeline resolve)...
      expect(repo.resolveAudioPlayOrder).toHaveBeenCalled();
      // ...but a self-pair shares one status row and the ebook position is left untouched, so nothing is written.
      expect(bookService.autoUpdateReadStatusForProgress).not.toHaveBeenCalled();
    });
  });
});

describe('ReadingAlignmentSyncService movement gate', () => {
  const t = (seconds: number) => new Date(1_700_000_000_000 + seconds * 1000);

  it('quarantines a sudden audio jump and accepts it after listening continues for the confirmation window', async () => {
    const { service, repo, bookService } = build({ ebookProgress: undefined });

    // Gradual listening at the start of the book: trusted and synced.
    repo.getAudiobookProgress.mockResolvedValueOnce({ currentFileId: AUDIO_FILE_A, positionSeconds: 0, percentage: 0, updatedAt: t(0) });
    await dispatch(service, audioEvent({ occurredAt: t(0) }));
    expect(bookService.autoUpdateReadStatusForProgress).toHaveBeenCalledTimes(1);

    // One second later the position is deep into the 200s book (not finished, so the finished
    // exception does not apply): physically impossible pace, quarantined.
    repo.getAudiobookProgress.mockResolvedValueOnce({ currentFileId: AUDIO_FILE_B, positionSeconds: 90, percentage: 95, updatedAt: t(1) });
    await dispatch(service, audioEvent({ occurredAt: t(1) }));
    expect(bookService.autoUpdateReadStatusForProgress).toHaveBeenCalledTimes(1);

    // Listening continues from the jumped position past the 2-minute window: now trusted.
    repo.getAudiobookProgress.mockResolvedValueOnce({ currentFileId: AUDIO_FILE_B, positionSeconds: 90, percentage: 95, updatedAt: t(130) });
    await dispatch(service, audioEvent({ occurredAt: t(130) }));
    expect(bookService.autoUpdateReadStatusForProgress).toHaveBeenCalledTimes(2);
  });

  it('quarantines a sudden ebook jump so it never projects onto the audiobook', async () => {
    const { service, repo } = build({ audioProgress: undefined });

    repo.getReadingProgress.mockResolvedValueOnce({ percentage: 0, updatedAt: t(0) });
    await dispatch(service, ebookEvent({ occurredAt: t(0) }));
    expect(repo.projectAudiobookProgress).toHaveBeenCalledTimes(1);

    // A scroll to the end of the book one second later is not reading; nothing is written.
    repo.getReadingProgress.mockResolvedValueOnce({ percentage: 100, updatedAt: t(1) });
    await dispatch(service, ebookEvent({ occurredAt: t(1) }));
    expect(repo.projectAudiobookProgress).toHaveBeenCalledTimes(1);
  });

  it('drops an abandoned jump when reading resumes near the accepted position', async () => {
    const { service, repo } = build({ audioProgress: undefined });

    repo.getReadingProgress.mockResolvedValueOnce({ percentage: 5, updatedAt: t(0) });
    await dispatch(service, ebookEvent({ occurredAt: t(0) }));
    repo.getReadingProgress.mockResolvedValueOnce({ percentage: 100, updatedAt: t(1) });
    await dispatch(service, ebookEvent({ occurredAt: t(1) }));
    expect(repo.projectAudiobookProgress).toHaveBeenCalledTimes(1);

    // Back near the old position and reading on: trusted immediately, the pending jump is discarded.
    repo.getReadingProgress.mockResolvedValueOnce({ percentage: 6, updatedAt: t(30) });
    await dispatch(service, ebookEvent({ occurredAt: t(30) }));
    expect(repo.projectAudiobookProgress).toHaveBeenCalledTimes(2);
  });
});

describe('ReadingAlignmentSyncService adversarial fixes', () => {
  const t = (seconds: number) => new Date(1_700_000_000_000 + seconds * 1000);

  it('honors a finished ebook jump as a status-only completion instead of quarantining it', async () => {
    const { service, repo, bookService } = build({ audioProgress: undefined });

    repo.getReadingProgress.mockResolvedValueOnce({ percentage: 5, updatedAt: t(0) });
    await dispatch(service, ebookEvent({ occurredAt: t(0) }));
    expect(repo.projectAudiobookProgress).toHaveBeenCalledTimes(1);

    // A sudden jump to 100% one second later is a movement-gate jump, but the source says finished:
    // the audiobook status completes while the position write stays quarantined.
    repo.getReadingProgress.mockResolvedValueOnce({ percentage: 100, updatedAt: t(1) });
    await dispatch(service, ebookEvent({ occurredAt: t(1) }));

    expect(repo.projectAudiobookProgress).toHaveBeenCalledTimes(1);
    expect(bookService.autoUpdateReadStatusForProgress).toHaveBeenCalledWith(USER_ID, { bookId: AUDIO_BOOK_ID, libraryId: 1 }, 100);
  });

  it('honors a finished audiobook jump as a status completion for the ebook', async () => {
    const { service, repo, bookService } = build({ ebookProgress: undefined });

    repo.getAudiobookProgress.mockResolvedValueOnce({ currentFileId: AUDIO_FILE_A, positionSeconds: 0, percentage: 0, updatedAt: t(0) });
    await dispatch(service, audioEvent({ occurredAt: t(0) }));
    const callsAfterFirst = bookService.autoUpdateReadStatusForProgress.mock.calls.length;

    repo.getAudiobookProgress.mockResolvedValueOnce({ currentFileId: AUDIO_FILE_B, positionSeconds: 100, percentage: 100, updatedAt: t(1) });
    await dispatch(service, audioEvent({ occurredAt: t(1) }));

    expect(bookService.autoUpdateReadStatusForProgress).toHaveBeenCalledTimes(callsAfterFirst + 1);
    expect(bookService.autoUpdateReadStatusForProgress).toHaveBeenLastCalledWith(USER_ID, { bookId: TEXT_BOOK_ID, libraryId: 1 }, 100);
  });

  it('keeps a near-end scrub quarantined when the source has not marked the book read', async () => {
    const { service, repo, bookService } = build({ ebookProgress: undefined, advancingReadStatus: { status: 'reading' } });

    repo.getAudiobookProgress.mockResolvedValueOnce({ currentFileId: AUDIO_FILE_A, positionSeconds: 0, percentage: 0, updatedAt: t(0) });
    await dispatch(service, audioEvent({ occurredAt: t(0) }));
    const callsAfterFirst = bookService.autoUpdateReadStatusForProgress.mock.calls.length;

    // Scrubbed to 99% - over the finish threshold, but the source never marked the book read.
    repo.getAudiobookProgress.mockResolvedValueOnce({ currentFileId: AUDIO_FILE_B, positionSeconds: 90, percentage: 99, updatedAt: t(1) });
    await dispatch(service, audioEvent({ occurredAt: t(1) }));

    expect(bookService.autoUpdateReadStatusForProgress).toHaveBeenCalledTimes(callsAfterFirst);
  });

  it('clamps a far-future device timestamp before it reaches newest-wins state', async () => {
    const farFuture = new Date('9999-01-01T00:00:00Z');
    const { service, repo } = build({
      ebookProgress: { percentage: 50, updatedAt: farFuture },
      audioProgress: undefined,
    });

    await dispatch(service, ebookEvent({ occurredAt: farFuture }));

    expect(repo.projectAudiobookProgress).toHaveBeenCalledTimes(1);
    const writtenAt = repo.projectAudiobookProgress.mock.calls[0][5] as Date;
    expect(writtenAt.getTime()).toBeLessThanOrEqual(Date.now() + 5 * 60_000 + 1000);
  });

  it('respects active KOReader re-reading in the ongoing sync (frozen updatedAt, newer lastReadAt)', async () => {
    const { service, bookService } = build({
      audioProgress: { currentFileId: AUDIO_FILE_A, positionSeconds: 50, percentage: 25, updatedAt: MIDDLE },
      ebookProgress: { percentage: 60, updatedAt: OLDER, lastReadAt: NEWER },
    });

    await dispatch(service, audioEvent({ occurredAt: MIDDLE }));

    expect(bookService.autoUpdateReadStatusForProgress).not.toHaveBeenCalled();
  });
});

describe('reconcilePairOnReady', () => {
  const PAIR = { textBookId: TEXT_BOOK_ID, audioBookId: AUDIO_BOOK_ID };

  it('pulls the ebook status up to the audiobook when audio is fresher and positionally ahead', async () => {
    const { service, bookService, repo } = build({
      // Audio at absolute 100s of 200s -> projected ebook 50%, fresher than the 20% ebook.
      audioProgress: { currentFileId: AUDIO_FILE_A, positionSeconds: 100, percentage: 50, updatedAt: NEWER },
      ebookProgress: { percentage: 20, updatedAt: OLDER },
    });

    await service.reconcilePairOnReady(PAIR, USER_ID);

    expect(bookService.autoUpdateReadStatusForProgress).toHaveBeenCalledWith(USER_ID, { bookId: TEXT_BOOK_ID, libraryId: 1 }, 50);
    // Reconcile is status-only: the ebook position row is never written.
    expect(repo.projectAudiobookProgress).not.toHaveBeenCalled();
  });

  it('leaves the ebook alone when its activity is newer than the audiobook', async () => {
    const { service, bookService } = build({
      audioProgress: { currentFileId: AUDIO_FILE_A, positionSeconds: 100, percentage: 50, updatedAt: OLDER },
      ebookProgress: { percentage: 20, updatedAt: NEWER },
    });

    await service.reconcilePairOnReady(PAIR, USER_ID);

    expect(bookService.autoUpdateReadStatusForProgress).not.toHaveBeenCalled();
  });

  it('leaves the ebook alone when the audiobook is fresher but positionally behind', async () => {
    const { service, bookService } = build({
      // Audio projects to 50% but the ebook already sits at 80%.
      audioProgress: { currentFileId: AUDIO_FILE_A, positionSeconds: 100, percentage: 50, updatedAt: NEWER },
      ebookProgress: { percentage: 80, updatedAt: OLDER },
    });

    await service.reconcilePairOnReady(PAIR, USER_ID);

    expect(bookService.autoUpdateReadStatusForProgress).not.toHaveBeenCalled();
  });

  it('respects recent KOReader ebook reading whose updatedAt is frozen (lastReadAt is newer)', async () => {
    const { service, bookService } = build({
      audioProgress: { currentFileId: AUDIO_FILE_A, positionSeconds: 100, percentage: 50, updatedAt: MIDDLE },
      // KOReader freezes updatedAt; lastReadAt carries the real (newer) reading activity.
      ebookProgress: { percentage: 20, updatedAt: OLDER, lastReadAt: NEWER },
    });

    await service.reconcilePairOnReady(PAIR, USER_ID);

    expect(bookService.autoUpdateReadStatusForProgress).not.toHaveBeenCalled();
  });

  it('treats a finished audiobook as fully ahead even when its last anchor maps short of 100%', async () => {
    const { service, bookService } = build({
      // Absolute 192s of 200s -> anchors map to 96%, below the 97% ebook - but percentage 100 is finished.
      audioProgress: { currentFileId: AUDIO_FILE_B, positionSeconds: 92, percentage: 100, updatedAt: NEWER },
      ebookProgress: { percentage: 97, updatedAt: OLDER },
    });

    await service.reconcilePairOnReady(PAIR, USER_ID);

    expect(bookService.autoUpdateReadStatusForProgress).toHaveBeenCalledWith(USER_ID, { bookId: TEXT_BOOK_ID, libraryId: 1 }, 100);
  });

  it('ignores an untouched 0% audiobook row instead of flipping the ebook to reading', async () => {
    const { service, bookService } = build({
      audioProgress: { currentFileId: AUDIO_FILE_A, positionSeconds: 0, percentage: 0, updatedAt: NEWER },
      ebookProgress: undefined,
    });

    await service.reconcilePairOnReady(PAIR, USER_ID);

    expect(bookService.autoUpdateReadStatusForProgress).not.toHaveBeenCalled();
  });

  it('does not force-complete a recently-and-actively-read ebook at match time', async () => {
    const now = Date.now();
    const { service, bookService } = build({
      // Audio claims "finished just now" (a fresh import stamps updatedAt with the server clock).
      audioProgress: { currentFileId: AUDIO_FILE_B, positionSeconds: 100, percentage: 100, updatedAt: new Date(now - 3_600_000) },
      // The user actually read the ebook two days ago and is mid-book.
      ebookProgress: { percentage: 30, updatedAt: new Date(now - 30 * 86_400_000), lastReadAt: new Date(now - 2 * 86_400_000) },
    });

    await service.reconcilePairOnReady(PAIR, USER_ID);

    expect(bookService.autoUpdateReadStatusForProgress).not.toHaveBeenCalled();
  });

  it('does not treat a scrubbed-but-unread audiobook as finished at reconcile', async () => {
    const { service, bookService } = build({
      audioProgress: { currentFileId: AUDIO_FILE_B, positionSeconds: 92, percentage: 99, updatedAt: NEWER },
      ebookProgress: { percentage: 97, updatedAt: OLDER },
      advancingReadStatus: { status: 'reading' },
    });

    await service.reconcilePairOnReady(PAIR, USER_ID);

    // Without the marked-read finished override, 192s maps to 96% which is not ahead of 97%.
    expect(bookService.autoUpdateReadStatusForProgress).not.toHaveBeenCalled();
  });

  it('does nothing when the user has never played the audiobook', async () => {
    const { service, bookService } = build({ audioProgress: undefined, ebookProgress: { percentage: 20, updatedAt: OLDER } });

    await service.reconcilePairOnReady(PAIR, USER_ID);

    expect(bookService.autoUpdateReadStatusForProgress).not.toHaveBeenCalled();
  });
});
