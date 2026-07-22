import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { AudiobookshelfApiError, type AbsMediaProgress } from './audiobookshelf-client.service';
import { AudiobookshelfSyncService, resolveAbsPosition, resolveAbsTargetStatus } from './audiobookshelf-sync.service';

const mockRepo = {
  findSettings: vi.fn(),
  updateSettings: vi.fn(),
  findSyncableBookStatesByAbsItemIds: vi.fn(),
  updateBookState: vi.fn(),
  findAudioFilesInPlayOrder: vi.fn(),
  findAudioProgress: vi.fn(),
  upsertAudioProgress: vi.fn(),
};

const mockClient = {
  getMe: vi.fn(),
};

const mockMatchService = {
  matchLibrary: vi.fn(),
};

const mockAttempts = {
  importExternalRead: vi.fn(),
};

const mockStatusService = {
  findOne: vi.fn(),
  updateManual: vi.fn(),
};

const mockSessionsService = {
  syncSessions: vi.fn(),
  deepReconciliationScan: vi.fn(),
};

const mockLibraryService = {
  findAccessibleLibraryIds: vi.fn(),
};

function makeService() {
  return new AudiobookshelfSyncService(
    mockRepo as any,
    mockClient as any,
    mockMatchService as any,
    mockAttempts as any,
    mockStatusService as any,
    mockSessionsService as any,
    mockLibraryService as any,
  );
}

const user = { id: 1, isSuperuser: true, active: true, permissions: [], contentFilters: undefined, settings: { timezone: 'UTC' } } as any;

function makeSettings(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    serverUrl: 'http://abs.local',
    apiToken: 'token-abc',
    syncStatus: true,
    syncPosition: true,
    syncSessions: false,
    initialReconcileCompletedAt: new Date('2026-01-01T00:00:00Z'),
    excludedLibraryIds: [],
    ...overrides,
  };
}

function makeMp(overrides: Partial<AbsMediaProgress> = {}): AbsMediaProgress {
  return {
    id: 'mp-1',
    libraryItemId: 'item-1',
    episodeId: null,
    mediaItemId: 'media-1',
    duration: 1000,
    progress: 0.5,
    currentTime: 500,
    isFinished: false,
    lastUpdate: 5000,
    startedAt: 1000,
    finishedAt: null,
    ...overrides,
  };
}

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    absLibraryItemId: 'item-1',
    bookId: 10,
    lastSyncedAbsUpdate: null,
    lastSyncedPositionAbsUpdate: null,
    lastSyncedProgressAt: null,
    lastSyncedProgress: null,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** True if any updateSettings call carried the given key in its patch object. */
function updateSettingsPatchedKey(key: string): boolean {
  return mockRepo.updateSettings.mock.calls.some(([, patch]) => patch != null && Object.prototype.hasOwnProperty.call(patch, key));
}

describe('AudiobookshelfSyncService pure exports', () => {
  describe('resolveAbsTargetStatus', () => {
    it('does not downgrade a read when ABS is only in progress', () => {
      expect(resolveAbsTargetStatus('read', false)).toBeNull();
    });

    it('promotes an in-progress book to reading', () => {
      expect(resolveAbsTargetStatus('unread', false)).toBe('reading');
    });

    it('promotes to read when ABS reports the book finished', () => {
      expect(resolveAbsTargetStatus('reading', true)).toBe('read');
    });

    it('treats abandoned as terminal for in-progress ABS state', () => {
      expect(resolveAbsTargetStatus('abandoned', false)).toBeNull();
    });

    it('still promotes abandoned to read when ABS reports finished', () => {
      expect(resolveAbsTargetStatus('abandoned', true)).toBe('read');
    });

    it('returns null when the current rank already equals the target (in-progress)', () => {
      expect(resolveAbsTargetStatus('reading', false)).toBeNull();
    });

    it('returns null when the current rank already equals the target (finished)', () => {
      expect(resolveAbsTargetStatus('read', true)).toBeNull();
    });
  });

  describe('resolveAbsPosition', () => {
    it('returns null for an empty file list', () => {
      expect(resolveAbsPosition([], 100)).toBeNull();
    });

    it('resolves an offset that falls within the first file', () => {
      const files = [
        { id: 1, durationSeconds: 100 },
        { id: 2, durationSeconds: 200 },
      ];
      expect(resolveAbsPosition(files, 50)).toEqual({ currentFileId: 1, positionSeconds: 50 });
    });

    it('resolves an offset that falls within the second file (within-file offset)', () => {
      const files = [
        { id: 1, durationSeconds: 100 },
        { id: 2, durationSeconds: 200 },
      ];
      expect(resolveAbsPosition(files, 150)).toEqual({ currentFileId: 2, positionSeconds: 50 });
    });

    it('clamps an offset past the end to the last file at its duration', () => {
      const files = [
        { id: 1, durationSeconds: 100 },
        { id: 2, durationSeconds: 200 },
      ];
      expect(resolveAbsPosition(files, 100000)).toEqual({ currentFileId: 2, positionSeconds: 200 });
    });
  });
});

describe('AudiobookshelfSyncService.sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRepo.findSettings.mockResolvedValue(makeSettings());
    mockRepo.updateSettings.mockResolvedValue({});
    mockRepo.findSyncableBookStatesByAbsItemIds.mockResolvedValue([]);
    mockRepo.updateBookState.mockResolvedValue(undefined);
    mockRepo.findAudioFilesInPlayOrder.mockResolvedValue([]);
    mockRepo.findAudioProgress.mockResolvedValue(null);
    mockRepo.upsertAudioProgress.mockResolvedValue({ updatedAt: new Date('2026-07-20T00:00:00Z') });
    mockClient.getMe.mockResolvedValue({ mediaProgress: [] });
    mockMatchService.matchLibrary.mockResolvedValue({ autoLinked: 0 });
    mockAttempts.importExternalRead.mockResolvedValue(undefined);
    mockStatusService.findOne.mockResolvedValue({ status: 'unread' });
    mockStatusService.updateManual.mockResolvedValue(undefined);
    mockSessionsService.syncSessions.mockResolvedValue({ inserted: 0, updated: 0 });
    mockSessionsService.deepReconciliationScan.mockResolvedValue({ inserted: 0, updated: 0 });
    mockLibraryService.findAccessibleLibraryIds.mockResolvedValue([]);
  });

  describe('reconcile gate', () => {
    it('reconciles and stamps completion on a fresh connection', async () => {
      mockRepo.findSettings.mockResolvedValue(makeSettings({ initialReconcileCompletedAt: null }));

      await makeService().sync(user);

      expect(mockMatchService.matchLibrary).toHaveBeenCalledTimes(1);
      expect(updateSettingsPatchedKey('initialReconcileCompletedAt')).toBe(true);
    });

    it('does not reconcile when the initial reconcile is already stamped', async () => {
      await makeService().sync(user);

      expect(mockMatchService.matchLibrary).not.toHaveBeenCalled();
    });

    it('always reconciles when options.reconcile is true even if already stamped', async () => {
      await makeService().sync(user, { reconcile: true });

      expect(mockMatchService.matchLibrary).toHaveBeenCalledTimes(1);
    });

    it('never reconciles in the hot in-progress-only tier, even on a fresh connection', async () => {
      mockRepo.findSettings.mockResolvedValue(makeSettings({ initialReconcileCompletedAt: null }));

      await makeService().sync(user, { hotInProgressOnly: true });

      expect(mockMatchService.matchLibrary).not.toHaveBeenCalled();
    });

    it('leaves the initial-reconcile flag null when a partial reconcile throws (so the next sync retries)', async () => {
      mockRepo.findSettings.mockResolvedValue(makeSettings({ initialReconcileCompletedAt: null }));
      mockMatchService.matchLibrary.mockRejectedValue(new Error('page 3 failed'));

      await expect(makeService().sync(user)).rejects.toThrow('page 3 failed');

      // The stamp happens only after matchLibrary returns, so a throw must leave it unwritten.
      expect(updateSettingsPatchedKey('initialReconcileCompletedAt')).toBe(false);
    });
  });

  describe('hot tier in-progress filter', () => {
    it('processes only in-progress mediaProgress and skips the sessions phase', async () => {
      const inProgress = makeMp({ id: 'mp-hot', libraryItemId: 'item-hot', isFinished: false, progress: 0.4, currentTime: 400 });
      const finished = makeMp({ id: 'mp-done', libraryItemId: 'item-done', isFinished: true, progress: 1, currentTime: 1000 });
      const unstarted = makeMp({ id: 'mp-new', libraryItemId: 'item-new', isFinished: false, progress: 0, currentTime: 0 });
      mockClient.getMe.mockResolvedValue({ mediaProgress: [inProgress, finished, unstarted] });
      // syncSessions would only ever be considered with syncSessions enabled; enable it to prove the
      // hot tier still bypasses it.
      mockRepo.findSettings.mockResolvedValue(makeSettings({ syncSessions: true }));
      mockRepo.findSyncableBookStatesByAbsItemIds.mockResolvedValue([makeState({ absLibraryItemId: 'item-hot', bookId: 77 })]);

      await makeService().sync(user, { hotInProgressOnly: true });

      expect(mockRepo.findSyncableBookStatesByAbsItemIds).toHaveBeenCalledWith(user.id, expect.anything(), ['item-hot']);
      expect(mockSessionsService.syncSessions).not.toHaveBeenCalled();
      expect(mockSessionsService.deepReconciliationScan).not.toHaveBeenCalled();
    });
  });

  describe('guards', () => {
    it('throws BadRequestException when settings are missing', async () => {
      mockRepo.findSettings.mockResolvedValue(null);
      await expect(makeService().sync(user)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequestException when sync is disabled', async () => {
      mockRepo.findSettings.mockResolvedValue(makeSettings({ enabled: false }));
      await expect(makeService().sync(user)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a concurrent sync for the same user with ConflictException', async () => {
      const gate = deferred<{ mediaProgress: AbsMediaProgress[] }>();
      mockClient.getMe.mockReturnValue(gate.promise);
      const service = makeService();

      const first = service.sync(user);
      // Yield so the first sync passes the in-flight guard and parks on getMe.
      await Promise.resolve();

      await expect(service.sync(user)).rejects.toBeInstanceOf(ConflictException);

      gate.resolve({ mediaProgress: [] });
      await first;
    });

    it('auto-disables sync and rethrows when the client reports a rejected token (401)', async () => {
      mockClient.getMe.mockRejectedValue(new AudiobookshelfApiError('unauthorized', 'http', 401));

      await expect(makeService().sync(user)).rejects.toBeInstanceOf(AudiobookshelfApiError);

      expect(mockRepo.updateSettings).toHaveBeenCalledWith(user.id, expect.objectContaining({ enabled: false }));
    });

    it('auto-disables sync on a 403 token rejection', async () => {
      mockClient.getMe.mockRejectedValue(new AudiobookshelfApiError('forbidden', 'http', 403));

      await expect(makeService().sync(user)).rejects.toBeInstanceOf(AudiobookshelfApiError);

      expect(mockRepo.updateSettings).toHaveBeenCalledWith(user.id, expect.objectContaining({ enabled: false }));
    });
  });

  describe('status is not double-written', () => {
    it('routes a finish through importExternalRead + a single updateManual, and position through upsertAudioProgress', async () => {
      const finished = makeMp({ isFinished: true, progress: 1, currentTime: 1000, duration: 1000, finishedAt: 1_700_000_000_000 });
      mockClient.getMe.mockResolvedValue({ mediaProgress: [finished] });
      mockRepo.findSyncableBookStatesByAbsItemIds.mockResolvedValue([makeState({ bookId: 10 })]);
      mockStatusService.findOne.mockResolvedValue({ status: 'reading' });
      mockRepo.findAudioFilesInPlayOrder.mockResolvedValue([{ id: 501, format: 'm4b', durationSeconds: 1000 }]);

      await makeService().sync(user);

      expect(mockAttempts.importExternalRead).toHaveBeenCalledTimes(1);
      expect(mockStatusService.updateManual).toHaveBeenCalledTimes(1);
      expect(mockStatusService.updateManual).toHaveBeenCalledWith(user.id, 10, { status: 'read' });
      // Position write goes through the bare ABS upsert (no status side-effect), never a second status derivation.
      expect(mockRepo.upsertAudioProgress).toHaveBeenCalledWith(user.id, 10, 501, 1000, 100);
    });
  });

  describe('applyPosition guards (position-only sync)', () => {
    function positionSettings() {
      return makeSettings({ syncStatus: false, syncPosition: true });
    }

    it('skips position when the book has no audio files', async () => {
      mockRepo.findSettings.mockResolvedValue(positionSettings());
      mockClient.getMe.mockResolvedValue({ mediaProgress: [makeMp()] });
      mockRepo.findSyncableBookStatesByAbsItemIds.mockResolvedValue([makeState({ bookId: 10 })]);
      mockRepo.findAudioFilesInPlayOrder.mockResolvedValue([]);

      await makeService().sync(user);

      expect(mockRepo.upsertAudioProgress).not.toHaveBeenCalled();
    });

    it('skips position when the ABS duration is invalid (<= 0)', async () => {
      mockRepo.findSettings.mockResolvedValue(positionSettings());
      mockClient.getMe.mockResolvedValue({ mediaProgress: [makeMp({ duration: 0 })] });
      mockRepo.findSyncableBookStatesByAbsItemIds.mockResolvedValue([makeState({ bookId: 10 })]);
      mockRepo.findAudioFilesInPlayOrder.mockResolvedValue([{ id: 501, format: 'm4b', durationSeconds: 1000 }]);

      await makeService().sync(user);

      expect(mockRepo.upsertAudioProgress).not.toHaveBeenCalled();
    });

    it('skips position when local progress is newer (newest-wins)', async () => {
      mockRepo.findSettings.mockResolvedValue(positionSettings());
      mockClient.getMe.mockResolvedValue({ mediaProgress: [makeMp({ progress: 0.5, currentTime: 500, duration: 1000 })] });
      mockRepo.findSyncableBookStatesByAbsItemIds.mockResolvedValue([makeState({ bookId: 10, lastSyncedProgressAt: null })]);
      mockRepo.findAudioFilesInPlayOrder.mockResolvedValue([{ id: 501, format: 'm4b', durationSeconds: 1000 }]);
      // No prior ABS-write snapshot -> compare positions: local 90% beats ABS 50%.
      mockRepo.findAudioProgress.mockResolvedValue({ percentage: 90, updatedAt: new Date('2026-07-19T00:00:00Z') });

      await makeService().sync(user);

      expect(mockRepo.upsertAudioProgress).not.toHaveBeenCalled();
    });

    it('writes the resolved file and seconds when position is due and valid', async () => {
      mockRepo.findSettings.mockResolvedValue(positionSettings());
      mockClient.getMe.mockResolvedValue({ mediaProgress: [makeMp({ progress: 0.5, currentTime: 500, duration: 1000 })] });
      mockRepo.findSyncableBookStatesByAbsItemIds.mockResolvedValue([makeState({ bookId: 10 })]);
      mockRepo.findAudioFilesInPlayOrder.mockResolvedValue([{ id: 501, format: 'm4b', durationSeconds: 1000 }]);
      mockRepo.findAudioProgress.mockResolvedValue(null);

      await makeService().sync(user);

      expect(mockRepo.upsertAudioProgress).toHaveBeenCalledWith(user.id, 10, 501, 500, 50);
      // status disabled -> no status derivation on the position path.
      expect(mockStatusService.updateManual).not.toHaveBeenCalled();
    });
  });
});
