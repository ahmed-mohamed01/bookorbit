import { Logger } from '@nestjs/common';
import { Permission } from '@bookorbit/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACHIEVEMENT_EVENT_AUDIO_POSITION_DERIVED,
  ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED,
  AchievementEventsService,
  type BookProgressChangedPayload,
} from '../achievement/achievement-events.service';
import { AudiobookshelfApiError } from './audiobookshelf-client.service';
import {
  AudiobookshelfProgressPushService,
  AUDIOBOOKSHELF_POSITION_PUSH_DEBOUNCE_MS,
  AUDIOBOOKSHELF_POSITION_PUSH_MAX_WAIT_MS,
  AUDIOBOOKSHELF_POSITION_PUSH_SWEEP_LIMIT,
  isWithinAbsDurationTolerance,
} from './audiobookshelf-progress-push.service';
import { AudiobookshelfSyncCoordinatorService } from './audiobookshelf-sync-coordinator.service';

const USER_ID = 7;
const BOOK_ID = 11;
const ITEM_ID = 'abs/item 1';
const LIBRARY_IDS = [3];
const EXCLUDED_ABS_LIBRARIES = ['abs-lib-hidden'];
const SCOPE = { libraryIds: LIBRARY_IDS, contentFilters: undefined };

const mockRepo = {
  findSettings: vi.fn(),
  findPushableBookStateByBookId: vi.fn(),
  findPushableBookStateRow: vi.fn(),
  markPositionPushPending: vi.fn(),
  findPendingPositionPushes: vi.fn(),
  clearIneligiblePositionPushes: vi.fn(),
  clearPositionPushPending: vi.fn(),
  findAudioProgress: vi.fn(),
  findAudioFilesInPlayOrderForBooks: vi.fn(),
  clearPositionPushPendingIfUnchanged: vi.fn(),
  completePositionPush: vi.fn(),
};

const mockUserService = {
  findByIdWithPermissions: vi.fn(),
};

const mockLibraryService = {
  findAccessibleLibraryIds: vi.fn(),
};

function syncUser(overrides: Record<string, unknown> = {}) {
  return { id: USER_ID, active: true, isSuperuser: true, permissions: [], contentFilters: undefined, ...overrides };
}

const mockClient = {
  getMediaProgress: vi.fn(),
  updateMediaProgress: vi.fn(),
};

const mockBookService = {
  resolveAudiobookPositionForExternalSync: vi.fn(),
};

const mockEditionLinks = {
  findLinkForBook: vi.fn(),
};

function settings(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    pushPosition: true,
    serverUrl: 'https://abs.example.com',
    apiToken: 'secret',
    excludedLibraryIds: EXCLUDED_ABS_LIBRARIES,
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
    mockUserService as any,
    mockLibraryService as any,
  );
  service.onModuleInit();
  return { service, events, coordinator };
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 50; index += 1) await Promise.resolve();
}

describe('AudiobookshelfProgressPushService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRepo.findSettings.mockResolvedValue(settings());
    mockRepo.findPushableBookStateByBookId.mockResolvedValue(bookState());
    mockRepo.markPositionPushPending.mockResolvedValue(undefined);
    mockRepo.findPendingPositionPushes.mockResolvedValue([bookState()]);
    mockRepo.clearIneligiblePositionPushes.mockResolvedValue(undefined);
    mockRepo.clearPositionPushPending.mockResolvedValue(undefined);
    mockRepo.findPushableBookStateRow.mockResolvedValue(bookState());
    mockRepo.findAudioProgress.mockResolvedValue(localProgress());
    mockRepo.findAudioFilesInPlayOrderForBooks.mockResolvedValue(new Map([[BOOK_ID, [{ id: 31, format: 'mp3', durationSeconds: 100 }]]]));
    mockUserService.findByIdWithPermissions.mockResolvedValue(syncUser());
    mockLibraryService.findAccessibleLibraryIds.mockResolvedValue(LIBRARY_IDS);
    mockRepo.clearPositionPushPendingIfUnchanged.mockResolvedValue(undefined);
    mockRepo.completePositionPush.mockResolvedValue(undefined);
    mockClient.getMediaProgress.mockResolvedValue({ duration: 100, lastUpdate: 1000 });
    mockClient.updateMediaProgress.mockResolvedValue(undefined);
    mockBookService.resolveAudiobookPositionForExternalSync.mockResolvedValue({ audioSeconds: 40, audioTotalSeconds: 100 });
    mockEditionLinks.findLinkForBook.mockResolvedValue(undefined);
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
    mockRepo.findPushableBookStateByBookId.mockResolvedValueOnce(undefined).mockResolvedValueOnce(bookState({ bookId: 44 }));
    mockEditionLinks.findLinkForBook.mockResolvedValue({ textBookId: 88, audioBookId: 44, readAlongBookId: 99 });
    const { events } = makeService();

    events.emit(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, progressEvent({ bookId: 99 }));
    await flushAsyncWork();

    expect(mockEditionLinks.findLinkForBook).toHaveBeenCalledWith(99);
    expect(mockRepo.findPushableBookStateByBookId).toHaveBeenNthCalledWith(2, USER_ID, 44, SCOPE, EXCLUDED_ABS_LIBRARIES);
    expect(mockRepo.markPositionPushPending).toHaveBeenCalledWith(USER_ID, ITEM_ID);
  });

  it('schedules a push when reading the read-along moved the audiobook without a progress event', async () => {
    vi.useFakeTimers();
    const { events } = makeService();

    events.emit(ACHIEVEMENT_EVENT_AUDIO_POSITION_DERIVED, { userId: USER_ID, bookId: BOOK_ID });
    await flushAsyncWork();

    expect(mockRepo.findPushableBookStateByBookId).toHaveBeenCalledWith(USER_ID, BOOK_ID, SCOPE, EXCLUDED_ABS_LIBRARIES);
    expect(mockRepo.markPositionPushPending).toHaveBeenCalledWith(USER_ID, ITEM_ID);
  });

  it('maps a text edition event to its linked audiobook, so the alignment estimate is pushed too', async () => {
    vi.useFakeTimers();
    mockRepo.findPushableBookStateByBookId.mockResolvedValueOnce(undefined).mockResolvedValueOnce(bookState({ bookId: 44 }));
    mockEditionLinks.findLinkForBook.mockResolvedValue({ textBookId: 88, audioBookId: 44, readAlongBookId: null });
    const { events } = makeService();

    events.emit(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, progressEvent({ bookId: 88 }));
    await flushAsyncWork();

    expect(mockRepo.findPushableBookStateByBookId).toHaveBeenNthCalledWith(2, USER_ID, 44, SCOPE, EXCLUDED_ABS_LIBRARIES);
    expect(mockRepo.markPositionPushPending).toHaveBeenCalledWith(USER_ID, ITEM_ID);
  });

  it('ignores a book with no edition link and no Audiobookshelf match', async () => {
    mockRepo.findPushableBookStateByBookId.mockResolvedValue(undefined);
    const { events } = makeService();

    events.emit(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, progressEvent({ bookId: 77 }));
    await flushAsyncWork();

    expect(mockRepo.markPositionPushPending).not.toHaveBeenCalled();
  });

  it('gates event scheduling on enabled push settings', async () => {
    mockRepo.findSettings.mockResolvedValue(settings({ pushPosition: false }));
    const { events } = makeService();

    events.emit(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, progressEvent());
    await flushAsyncWork();

    expect(mockRepo.findPushableBookStateByBookId).not.toHaveBeenCalled();
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
    await expect(coordinator.acquireSync(USER_ID, 0)).resolves.toBe(true);
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
    mockRepo.findPushableBookStateByBookId.mockImplementation((_userId: number, bookId: number) => (bookId === 11 ? first : second));
    mockRepo.findPushableBookStateRow.mockImplementation((_userId: number, itemId: string) => (itemId === 'item-11' ? first : second));
    mockRepo.findAudioFilesInPlayOrderForBooks.mockImplementation(([bookId]: number[]) =>
      Promise.resolve(new Map([[bookId, [{ id: 31, format: 'mp3', durationSeconds: 100 }]]])),
    );
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
    mockRepo.findPushableBookStateRow.mockResolvedValue(bookState({ lastSyncedProgressAt: snapshot }));
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

  it('sweeps at most the sweep limit of eligible pending rows, after clearing ineligible ones', async () => {
    mockRepo.findPendingPositionPushes.mockResolvedValue([]);

    await makeService().service.sweepPending(USER_ID);

    expect(mockRepo.clearIneligiblePositionPushes).toHaveBeenCalledWith(USER_ID, SCOPE, EXCLUDED_ABS_LIBRARIES);
    expect(mockRepo.findPendingPositionPushes).toHaveBeenCalledWith(USER_ID, SCOPE, EXCLUDED_ABS_LIBRARIES, AUDIOBOOKSHELF_POSITION_PUSH_SWEEP_LIMIT);
    expect(mockRepo.clearIneligiblePositionPushes.mock.invocationCallOrder[0]).toBeLessThan(
      mockRepo.findPendingPositionPushes.mock.invocationCallOrder[0]!,
    );
  });

  describe('eligibility (same rows the pull accepts)', () => {
    it('marks through the pull-equivalent lookup scoped to library access and excluded ABS libraries', async () => {
      vi.useFakeTimers();
      const { events } = makeService();

      events.emit(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, progressEvent());
      await flushAsyncWork();

      expect(mockLibraryService.findAccessibleLibraryIds).toHaveBeenCalledWith(syncUser());
      expect(mockRepo.findPushableBookStateByBookId).toHaveBeenCalledWith(USER_ID, BOOK_ID, SCOPE, EXCLUDED_ABS_LIBRARIES);
      expect(mockRepo.markPositionPushPending).toHaveBeenCalledWith(USER_ID, ITEM_ID);
    });

    it('does not mark a book whose only match the pull would refuse', async () => {
      mockRepo.findPushableBookStateByBookId.mockResolvedValue(undefined);
      const { events } = makeService();

      events.emit(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, progressEvent());
      await flushAsyncWork();

      expect(mockRepo.markPositionPushPending).not.toHaveBeenCalled();
    });

    it('re-checks the fresh row before PATCH and clears the marker when it became ineligible', async () => {
      mockRepo.findPushableBookStateRow.mockResolvedValue(undefined);

      await makeService().service.sweepPending(USER_ID);

      expect(mockRepo.findPushableBookStateRow).toHaveBeenCalledWith(USER_ID, ITEM_ID, SCOPE, EXCLUDED_ABS_LIBRARIES);
      expect(mockRepo.clearPositionPushPending).toHaveBeenCalledWith(USER_ID, ITEM_ID);
      expect(mockClient.getMediaProgress).not.toHaveBeenCalled();
      expect(mockClient.updateMediaProgress).not.toHaveBeenCalled();
    });

    it('clears ineligible pending rows when a debounced push finds no eligible match', async () => {
      vi.useFakeTimers();
      const { events } = makeService();
      events.emit(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, progressEvent());
      await flushAsyncWork();
      mockRepo.findPushableBookStateByBookId.mockResolvedValue(undefined);

      await vi.advanceTimersByTimeAsync(AUDIOBOOKSHELF_POSITION_PUSH_DEBOUNCE_MS);
      await flushAsyncWork();

      expect(mockRepo.clearIneligiblePositionPushes).toHaveBeenCalledWith(USER_ID, SCOPE, EXCLUDED_ABS_LIBRARIES);
      expect(mockClient.updateMediaProgress).not.toHaveBeenCalled();
    });
  });

  describe('user eligibility (same gate as the sync scheduler)', () => {
    it.each([
      ['inactive', syncUser({ active: false })],
      ['without the Audiobookshelf sync permission', syncUser({ isSuperuser: false, permissions: [] })],
      ['missing', null],
    ])('does not mark for a user who is %s', async (_label, user) => {
      mockUserService.findByIdWithPermissions.mockResolvedValue(user);
      const { events } = makeService();

      events.emit(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, progressEvent());
      await flushAsyncWork();

      expect(mockRepo.markPositionPushPending).not.toHaveBeenCalled();
    });

    it('marks for a non-superuser who holds the Audiobookshelf sync permission', async () => {
      vi.useFakeTimers();
      mockUserService.findByIdWithPermissions.mockResolvedValue(syncUser({ isSuperuser: false, permissions: [Permission.AudiobookshelfSync] }));
      const { events } = makeService();

      events.emit(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, progressEvent());
      await flushAsyncWork();

      expect(mockRepo.markPositionPushPending).toHaveBeenCalled();
    });

    it('sweeps nothing and clears every pending marker once the permission is revoked', async () => {
      mockUserService.findByIdWithPermissions.mockResolvedValue(syncUser({ isSuperuser: false, permissions: [] }));

      await makeService().service.sweepPending(USER_ID);

      expect(mockRepo.clearPositionPushPending).toHaveBeenCalledWith(USER_ID);
      expect(mockRepo.findPendingPositionPushes).not.toHaveBeenCalled();
      expect(mockClient.updateMediaProgress).not.toHaveBeenCalled();
    });

    it('does not send a queued push when the permission is revoked before it runs', async () => {
      vi.useFakeTimers();
      const { events } = makeService();
      events.emit(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, progressEvent());
      await flushAsyncWork();
      mockUserService.findByIdWithPermissions.mockResolvedValue(syncUser({ active: false }));

      await vi.advanceTimersByTimeAsync(AUDIOBOOKSHELF_POSITION_PUSH_DEBOUNCE_MS);
      await flushAsyncWork();

      expect(mockClient.updateMediaProgress).not.toHaveBeenCalled();
      expect(mockRepo.clearPositionPushPending).toHaveBeenCalledWith(USER_ID);
    });

    it('resolves the user once for a storm of saves, not once per event', async () => {
      vi.useFakeTimers();
      const { events } = makeService();

      for (let index = 0; index < 5; index += 1) {
        events.emit(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, progressEvent({ progress: 40 + index }));
        await flushAsyncWork();
      }

      expect(mockUserService.findByIdWithPermissions).toHaveBeenCalledTimes(1);
      expect(mockRepo.markPositionPushPending).toHaveBeenCalledTimes(5);
    });
  });

  it('sweeps nothing and clears the user markers when push is switched off', async () => {
    mockRepo.findSettings.mockResolvedValue(settings({ pushPosition: false }));

    await makeService().service.sweepPending(USER_ID);

    expect(mockRepo.clearPositionPushPending).toHaveBeenCalledWith(USER_ID);
    expect(mockRepo.findPendingPositionPushes).not.toHaveBeenCalled();
    expect(mockClient.getMediaProgress).not.toHaveBeenCalled();
  });

  it('refuses when ABS is newer than the local capture even if ABS has not moved past the watermark', async () => {
    mockRepo.findPushableBookStateRow.mockResolvedValue(bookState({ lastSyncedPositionAbsUpdate: 9000 }));
    mockClient.getMediaProgress.mockResolvedValue({ duration: 100, lastUpdate: 6000 });

    await makeService().service.sweepPending(USER_ID);

    expect(mockClient.updateMediaProgress).not.toHaveBeenCalled();
    expect(mockRepo.clearPositionPushPendingIfUnchanged).toHaveBeenCalledWith(USER_ID, ITEM_ID, BOOK_ID, localProgress().updatedAt);
    expect(Logger.prototype.log).toHaveBeenCalledWith(expect.stringContaining('reason=abs_newer'));
  });

  it('does not push when the local and ABS durations differ beyond the pull tolerance', async () => {
    mockBookService.resolveAudiobookPositionForExternalSync.mockResolvedValue({ audioSeconds: 40, audioTotalSeconds: 200 });

    await makeService().service.sweepPending(USER_ID);

    expect(mockClient.updateMediaProgress).not.toHaveBeenCalled();
    expect(mockRepo.clearPositionPushPendingIfUnchanged).toHaveBeenCalledWith(USER_ID, ITEM_ID, BOOK_ID, localProgress().updatedAt);
    expect(Logger.prototype.log).toHaveBeenCalledWith(expect.stringContaining('reason=duration_mismatch'));
  });

  it('pushes when the durations differ within the tolerance', async () => {
    mockBookService.resolveAudiobookPositionForExternalSync.mockResolvedValue({ audioSeconds: 40, audioTotalSeconds: 103 });

    await makeService().service.sweepPending(USER_ID);

    expect(mockClient.updateMediaProgress).toHaveBeenCalledTimes(1);
  });

  describe('sweep during an Audiobookshelf outage', () => {
    const rows = [
      bookState({ id: 1, absLibraryItemId: 'item-a' }),
      bookState({ id: 2, absLibraryItemId: 'item-b' }),
      bookState({ id: 3, absLibraryItemId: 'item-c' }),
    ];

    beforeEach(() => {
      mockRepo.findPendingPositionPushes.mockResolvedValue(rows);
      mockRepo.findPushableBookStateRow.mockImplementation((_userId: number, itemId: string) =>
        Promise.resolve(rows.find((row) => row.absLibraryItemId === itemId)),
      );
    });

    it.each(['network', 'timeout'] as const)('stops at the first %s failure and keeps the remaining rows pending', async (code) => {
      mockClient.getMediaProgress.mockRejectedValue(new AudiobookshelfApiError('unreachable', code));

      await makeService().service.sweepPending(USER_ID);

      expect(mockClient.getMediaProgress).toHaveBeenCalledTimes(1);
      expect(mockRepo.clearPositionPushPendingIfUnchanged).not.toHaveBeenCalled();
      expect(mockRepo.clearPositionPushPending).not.toHaveBeenCalled();
    });

    it('keeps going after a failure that is not about reaching the server', async () => {
      mockClient.getMediaProgress.mockRejectedValueOnce(new AudiobookshelfApiError('bad', 'http', 500));

      await makeService().service.sweepPending(USER_ID);

      expect(mockClient.getMediaProgress).toHaveBeenCalledTimes(3);
      expect(mockClient.updateMediaProgress).toHaveBeenCalledTimes(2);
    });
  });

  describe('isWithinAbsDurationTolerance', () => {
    it('allows the base, per-file and relative slack and rejects anything beyond it', () => {
      expect(isWithinAbsDurationTolerance(1000, 1, 1015)).toBe(true);
      expect(isWithinAbsDurationTolerance(1000, 1, 1016)).toBe(false);
      expect(isWithinAbsDurationTolerance(1000, 20, 1030)).toBe(true);
      expect(isWithinAbsDurationTolerance(1000, 20, 1031)).toBe(false);
    });
  });
});
