import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACHIEVEMENT_EVENT_AUDIO_POSITION_DERIVED,
  ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED,
  AchievementEventsService,
  type BookProgressChangedPayload,
} from '../achievement/achievement-events.service';
import {
  AudiobookshelfProgressPushService,
  AUDIOBOOKSHELF_POSITION_PUSH_DEBOUNCE_MS,
  AUDIOBOOKSHELF_POSITION_PUSH_MAX_WAIT_MS,
} from './audiobookshelf-progress-push.service';
import { AudiobookshelfSyncCoordinatorService } from './audiobookshelf-sync-coordinator.service';

const USER_ID = 7;
const BOOK_ID = 11;
const ITEM_ID = 'abs/item 1';

const mockRepo = {
  findSettings: vi.fn(),
  findBookStateByBookId: vi.fn(),
  markPositionPushPending: vi.fn(),
  findPendingPositionPushes: vi.fn(),
  findBookStateRow: vi.fn(),
  findAudioProgress: vi.fn(),
  clearPositionPushPendingIfUnchanged: vi.fn(),
  completePositionPush: vi.fn(),
};

const mockClient = {
  getMediaProgress: vi.fn(),
  updateMediaProgress: vi.fn(),
};

const mockBookService = {
  resolveAudiobookPositionForExternalSync: vi.fn(),
};

const mockEditionLinks = {
  findAudioBookIdByReadAlongBookId: vi.fn(),
};

function settings(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    pushPosition: true,
    serverUrl: 'https://abs.example.com',
    apiToken: 'secret',
    ...overrides,
  };
}

function bookState(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    userId: USER_ID,
    absLibraryItemId: ITEM_ID,
    bookId: BOOK_ID,
    syncExcluded: false,
    manualUnlinked: false,
    lastSyncedPositionAbsUpdate: 1000,
    lastSyncedProgressAt: new Date('2026-09-29T10:00:00.000Z'),
    pushPendingAt: new Date('2026-09-29T10:01:00.000Z'),
    ...overrides,
  } as any;
}

function localProgress(overrides: Record<string, unknown> = {}) {
  return {
    currentFileId: 31,
    positionSeconds: 40,
    percentage: 40,
    capturedAt: new Date(5000),
    updatedAt: new Date('2026-09-29T10:02:00.000Z'),
    revision: 4,
    ...overrides,
  };
}

function progressEvent(overrides: Partial<BookProgressChangedPayload> = {}): BookProgressChangedPayload {
  return { userId: USER_ID, bookId: BOOK_ID, progress: 40, source: 'web_reader', ...overrides };
}

function makeService(events = new AchievementEventsService(), coordinator = new AudiobookshelfSyncCoordinatorService()) {
  const service = new AudiobookshelfProgressPushService(
    events,
    mockRepo as any,
    mockClient as any,
    mockBookService as any,
    mockEditionLinks as any,
    coordinator,
  );
  service.onModuleInit();
  return { service, events, coordinator };
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe('AudiobookshelfProgressPushService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRepo.findSettings.mockResolvedValue(settings());
    mockRepo.findBookStateByBookId.mockResolvedValue(bookState());
    mockRepo.markPositionPushPending.mockResolvedValue(undefined);
    mockRepo.findPendingPositionPushes.mockResolvedValue([bookState()]);
    mockRepo.findBookStateRow.mockResolvedValue(bookState());
    mockRepo.findAudioProgress.mockResolvedValue(localProgress());
    mockRepo.clearPositionPushPendingIfUnchanged.mockResolvedValue(undefined);
    mockRepo.completePositionPush.mockResolvedValue(undefined);
    mockClient.getMediaProgress.mockResolvedValue({ duration: 100, lastUpdate: 1000 });
    mockClient.updateMediaProgress.mockResolvedValue(undefined);
    mockBookService.resolveAudiobookPositionForExternalSync.mockResolvedValue({ audioSeconds: 40, audioTotalSeconds: 100 });
    mockEditionLinks.findAudioBookIdByReadAlongBookId.mockResolvedValue(null);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('never schedules positions emitted by the Audiobookshelf pull', async () => {
    const { events } = makeService();

    events.emit(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, progressEvent({ source: 'audiobookshelf' }));
    await flushAsyncWork();

    expect(mockRepo.findSettings).not.toHaveBeenCalled();
    expect(mockRepo.markPositionPushPending).not.toHaveBeenCalled();
  });

  it('maps a read-along event to its linked audiobook', async () => {
    vi.useFakeTimers();
    mockRepo.findBookStateByBookId.mockResolvedValueOnce(undefined).mockResolvedValueOnce(bookState({ bookId: 44 }));
    mockEditionLinks.findAudioBookIdByReadAlongBookId.mockResolvedValue(44);
    const { events } = makeService();

    events.emit(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, progressEvent({ bookId: 99 }));
    await flushAsyncWork();

    expect(mockEditionLinks.findAudioBookIdByReadAlongBookId).toHaveBeenCalledWith(99);
    expect(mockRepo.findBookStateByBookId).toHaveBeenNthCalledWith(2, USER_ID, 44);
    expect(mockRepo.markPositionPushPending).toHaveBeenCalledWith(USER_ID, ITEM_ID);
  });

  it('schedules a push when reading the read-along moved the audiobook without a progress event', async () => {
    vi.useFakeTimers();
    const { events } = makeService();

    events.emit(ACHIEVEMENT_EVENT_AUDIO_POSITION_DERIVED, { userId: USER_ID, bookId: BOOK_ID });
    await flushAsyncWork();

    expect(mockRepo.findBookStateByBookId).toHaveBeenCalledWith(USER_ID, BOOK_ID);
    expect(mockRepo.markPositionPushPending).toHaveBeenCalledWith(USER_ID, ITEM_ID);
  });

  it('ignores a text edition that is not the read-along member', async () => {
    mockRepo.findBookStateByBookId.mockResolvedValue(undefined);
    const { events } = makeService();

    events.emit(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, progressEvent({ bookId: 88 }));
    await flushAsyncWork();

    expect(mockEditionLinks.findAudioBookIdByReadAlongBookId).toHaveBeenCalledWith(88);
    expect(mockRepo.markPositionPushPending).not.toHaveBeenCalled();
  });

  it('gates event scheduling on enabled push settings', async () => {
    mockRepo.findSettings.mockResolvedValue(settings({ pushPosition: false }));
    const { events } = makeService();

    events.emit(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, progressEvent());
    await flushAsyncWork();

    expect(mockRepo.findBookStateByBookId).not.toHaveBeenCalled();
    expect(mockRepo.markPositionPushPending).not.toHaveBeenCalled();
  });

  it('collapses a burst of events into one push after ten seconds', async () => {
    vi.useFakeTimers();
    const { events } = makeService();

    events.emit(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, progressEvent());
    await flushAsyncWork();
    events.emit(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, progressEvent({ progress: 41 }));
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(AUDIOBOOKSHELF_POSITION_PUSH_DEBOUNCE_MS);
    await flushAsyncWork();

    expect(mockClient.updateMediaProgress).toHaveBeenCalledTimes(1);
  });

  it('still pushes once a minute while saves keep arriving every five seconds', async () => {
    vi.useFakeTimers();
    const { events } = makeService();
    const playFor = async (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 5_000) {
        events.emit(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, progressEvent());
        await flushAsyncWork();
        await vi.advanceTimersByTimeAsync(5_000);
        await flushAsyncWork();
      }
    };

    await playFor(AUDIOBOOKSHELF_POSITION_PUSH_MAX_WAIT_MS - 5_000);
    expect(mockClient.updateMediaProgress).not.toHaveBeenCalled();

    await playFor(10_000);
    expect(mockClient.updateMediaProgress).toHaveBeenCalledTimes(1);

    await playFor(AUDIOBOOKSHELF_POSITION_PUSH_MAX_WAIT_MS);
    expect(mockClient.updateMediaProgress).toHaveBeenCalledTimes(2);
  });

  it('reschedules instead of overlapping a pull sync for the same user', async () => {
    vi.useFakeTimers();
    const coordinator = new AudiobookshelfSyncCoordinatorService();
    expect(coordinator.tryStartSync(USER_ID)).toBe(true);
    const { events } = makeService(new AchievementEventsService(), coordinator);

    events.emit(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, progressEvent());
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(AUDIOBOOKSHELF_POSITION_PUSH_DEBOUNCE_MS);
    expect(mockClient.updateMediaProgress).not.toHaveBeenCalled();

    coordinator.endSync(USER_ID);
    await vi.advanceTimersByTimeAsync(AUDIOBOOKSHELF_POSITION_PUSH_DEBOUNCE_MS);
    await flushAsyncWork();
    expect(mockClient.updateMediaProgress).toHaveBeenCalledTimes(1);
  });

  it('serializes pushes for two audiobooks owned by the same user', async () => {
    vi.useFakeTimers();
    const first = bookState({ id: 1, bookId: 11, absLibraryItemId: 'item-11' });
    const second = bookState({ id: 2, bookId: 12, absLibraryItemId: 'item-12' });
    mockRepo.findBookStateByBookId.mockImplementation((_userId: number, bookId: number) => (bookId === 11 ? first : second));
    mockRepo.findBookStateRow.mockImplementation((_userId: number, itemId: string) => (itemId === 'item-11' ? first : second));
    let resolveFirst!: () => void;
    const firstRequest = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    mockClient.updateMediaProgress.mockImplementationOnce(() => firstRequest).mockResolvedValueOnce(undefined);
    const { events } = makeService();

    events.emit(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, progressEvent({ bookId: 11 }));
    events.emit(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, progressEvent({ bookId: 12 }));
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(AUDIOBOOKSHELF_POSITION_PUSH_DEBOUNCE_MS);
    await flushAsyncWork();

    expect(mockClient.updateMediaProgress).toHaveBeenCalledTimes(1);
    resolveFirst();
    await flushAsyncWork();
    expect(mockClient.updateMediaProgress).toHaveBeenCalledTimes(2);
  });

  it('clears pending without calling ABS when local progress equals the pull snapshot', async () => {
    const snapshot = new Date('2026-09-29T10:02:00.000Z');
    mockRepo.findPendingPositionPushes.mockResolvedValue([bookState({ lastSyncedProgressAt: snapshot })]);
    mockRepo.findBookStateRow.mockResolvedValue(bookState({ lastSyncedProgressAt: snapshot }));
    mockRepo.findAudioProgress.mockResolvedValue(localProgress({ updatedAt: snapshot }));

    await makeService().service.sweepPending(USER_ID);

    expect(mockRepo.clearPositionPushPendingIfUnchanged).toHaveBeenCalledWith(USER_ID, ITEM_ID, BOOK_ID, snapshot);
    expect(mockClient.getMediaProgress).not.toHaveBeenCalled();
  });

  it('keeps the ABS position when its remote update is newer', async () => {
    mockClient.getMediaProgress.mockResolvedValue({ duration: 100, lastUpdate: 6000 });

    await makeService().service.sweepPending(USER_ID);

    expect(mockRepo.clearPositionPushPendingIfUnchanged).toHaveBeenCalledWith(USER_ID, ITEM_ID, BOOK_ID, localProgress().updatedAt);
    expect(mockClient.updateMediaProgress).not.toHaveBeenCalled();
  });

  it('skips positions within ten seconds of the end', async () => {
    mockBookService.resolveAudiobookPositionForExternalSync.mockResolvedValue({ audioSeconds: 95, audioTotalSeconds: 100 });

    await makeService().service.sweepPending(USER_ID);

    expect(mockClient.updateMediaProgress).not.toHaveBeenCalled();
    expect(mockRepo.clearPositionPushPendingIfUnchanged).toHaveBeenCalled();
  });

  it('clears pending when no ABS-compatible audiobook timeline is available', async () => {
    mockBookService.resolveAudiobookPositionForExternalSync.mockResolvedValue(null);

    await makeService().service.sweepPending(USER_ID);

    expect(mockClient.updateMediaProgress).not.toHaveBeenCalled();
    expect(mockRepo.clearPositionPushPendingIfUnchanged).toHaveBeenCalled();
  });

  it('reads a newly created ABS record back for its server-assigned watermark', async () => {
    mockClient.getMediaProgress.mockResolvedValueOnce(null).mockResolvedValueOnce({ duration: 100, lastUpdate: 7777 });

    await makeService().service.sweepPending(USER_ID);

    expect(mockRepo.completePositionPush).toHaveBeenCalledWith(USER_ID, ITEM_ID, BOOK_ID, localProgress().updatedAt, 7777);
  });

  it('uses the sent local capture time as the watermark for an existing record', async () => {
    await makeService().service.sweepPending(USER_ID);

    expect(mockClient.updateMediaProgress).toHaveBeenCalledWith(USER_ID, 'https://abs.example.com', 'secret', ITEM_ID, {
      currentTime: 40,
      duration: 100,
      progress: 0.4,
      lastUpdate: 5000,
    });
    expect(mockRepo.completePositionPush).toHaveBeenCalledWith(USER_ID, ITEM_ID, BOOK_ID, localProgress().updatedAt, 5000);
  });

  it('keeps the pending marker and resolves when an ABS request fails', async () => {
    mockClient.updateMediaProgress.mockRejectedValue(new Error('network down'));

    await expect(makeService().service.sweepPending(USER_ID)).resolves.toBeUndefined();

    expect(mockRepo.completePositionPush).not.toHaveBeenCalled();
    expect(mockRepo.clearPositionPushPendingIfUnchanged).not.toHaveBeenCalled();
  });

  it('passes the original local revision timestamp to the atomic completion when local progress changes in flight', async () => {
    const original = localProgress();
    mockRepo.findAudioProgress.mockResolvedValue(original);
    mockClient.updateMediaProgress.mockImplementation(() => {
      mockRepo.findAudioProgress.mockResolvedValue(localProgress({ updatedAt: new Date('2026-09-29T10:03:00.000Z') }));
      return {};
    });

    await makeService().service.sweepPending(USER_ID);

    expect(mockRepo.completePositionPush).toHaveBeenCalledWith(USER_ID, ITEM_ID, BOOK_ID, original.updatedAt, 5000);
  });

  it('sweeps at most two hundred pending rows, oldest first through the repository contract', async () => {
    mockRepo.findPendingPositionPushes.mockResolvedValue([]);

    await makeService().service.sweepPending(USER_ID);

    expect(mockRepo.findPendingPositionPushes).toHaveBeenCalledWith(USER_ID, 200);
  });
});
