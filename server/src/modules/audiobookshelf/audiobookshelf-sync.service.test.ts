import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { AudiobookshelfApiError, type AbsMediaProgress } from './audiobookshelf-client.service';
import { AudiobookshelfSyncService, resolveAbsPosition, resolveAbsTargetStatus } from './audiobookshelf-sync.service';

const mockRepo = {
  findSettings: vi.fn(),
  updateSettings: vi.fn(),
  findSyncableBookStatesByAbsItemIds: vi.fn(),
  updateBookState: vi.fn(),
  findAudioFilesInPlayOrderForBooks: vi.fn(),
  findAudioProgressForBooks: vi.fn(),
  upsertAudioProgressGuarded: vi.fn(),
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

const mockAchievementEvents = {
  emit: vi.fn(),
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
    mockAchievementEvents as any,
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
    it('surfaces a re-listen of a finished book as rereading', () => {
      expect(resolveAbsTargetStatus('read', false)).toBe('rereading');
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
    mockStatusService.findOne.mockResolvedValue(null);
    mockRepo.findAudioFilesInPlayOrderForBooks.mockResolvedValue(new Map());
    mockRepo.findAudioProgressForBooks.mockResolvedValue(new Map());
    mockRepo.upsertAudioProgressGuarded.mockResolvedValue({ updatedAt: new Date('2026-07-20T00:00:00Z') });
    mockClient.getMe.mockResolvedValue({ mediaProgress: [] });
    mockMatchService.matchLibrary.mockResolvedValue({ autoLinked: 0 });
    mockAttempts.importExternalRead.mockResolvedValue(undefined);
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

  describe('warm session tier (hot tick, incremental sessions for in-progress books)', () => {
    function wireInProgress() {
      const inProgress = makeMp({ id: 'mp-hot', libraryItemId: 'item-hot', isFinished: false, progress: 0.4, currentTime: 400 });
      mockClient.getMe.mockResolvedValue({ mediaProgress: [inProgress] });
      mockRepo.findSettings.mockResolvedValue(makeSettings({ syncSessions: true }));
      mockRepo.findSyncableBookStatesByAbsItemIds.mockResolvedValue([makeState({ absLibraryItemId: 'item-hot', bookId: 77 })]);
    }

    it('does NOT ingest sessions on a hot tick with warmSessions:false', async () => {
      wireInProgress();

      await makeService().sync(user, { hotInProgressOnly: true, warmSessions: false });

      expect(mockSessionsService.syncSessions).not.toHaveBeenCalled();
      expect(mockSessionsService.deepReconciliationScan).not.toHaveBeenCalled();
    });

    it('ingests INCREMENTAL sessions on a warm hot tick when a book is in progress', async () => {
      wireInProgress();

      await makeService().sync(user, { hotInProgressOnly: true, warmSessions: true });

      expect(mockSessionsService.syncSessions).toHaveBeenCalledTimes(1);
      // Warm path never runs the deep scan - that stays tied to the full/full-resync path.
      expect(mockSessionsService.deepReconciliationScan).not.toHaveBeenCalled();
    });

    it('does NOT ingest sessions on a warm hot tick when no book is in progress', async () => {
      // Only finished/unstarted books, so the hot filter narrows `progresses` to empty - no warm work.
      const finished = makeMp({ id: 'mp-done', libraryItemId: 'item-done', isFinished: true, progress: 1, currentTime: 1000 });
      const unstarted = makeMp({ id: 'mp-new', libraryItemId: 'item-new', isFinished: false, progress: 0, currentTime: 0 });
      mockClient.getMe.mockResolvedValue({ mediaProgress: [finished, unstarted] });
      mockRepo.findSettings.mockResolvedValue(makeSettings({ syncSessions: true }));

      await makeService().sync(user, { hotInProgressOnly: true, warmSessions: true });

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
    it('routes a finish through importExternalRead + a single updateManual, and position through upsertAudioProgressGuarded', async () => {
      const finished = makeMp({ isFinished: true, progress: 1, currentTime: 1000, duration: 1000, finishedAt: 1_700_000_000_000 });
      mockClient.getMe.mockResolvedValue({ mediaProgress: [finished] });
      mockRepo.findSyncableBookStatesByAbsItemIds.mockResolvedValue([makeState({ bookId: 10 })]);
      mockStatusService.findOne.mockResolvedValue({ status: 'reading' });
      mockRepo.findAudioFilesInPlayOrderForBooks.mockResolvedValue(new Map([[10, [{ id: 501, format: 'm4b', durationSeconds: 1000 }]]]));

      await makeService().sync(user);

      expect(mockAttempts.importExternalRead).toHaveBeenCalledTimes(1);
      expect(mockStatusService.updateManual).toHaveBeenCalledTimes(1);
      expect(mockStatusService.updateManual).toHaveBeenCalledWith(user.id, 10, { status: 'read' });
      // Position write goes through the bare ABS upsert (no status side-effect), never a second status derivation.
      expect(mockRepo.upsertAudioProgressGuarded).toHaveBeenCalledWith(user.id, 10, 501, 1000, 100, null);
    });

    it('surfaces an in-progress re-listen of a finished book as rereading', async () => {
      const relisten = makeMp({ isFinished: false, progress: 0.4, currentTime: 400, duration: 1000 });
      mockClient.getMe.mockResolvedValue({ mediaProgress: [relisten] });
      mockRepo.findSyncableBookStatesByAbsItemIds.mockResolvedValue([makeState({ bookId: 10 })]);
      mockStatusService.findOne.mockResolvedValue({ status: 'read' });
      mockRepo.findAudioFilesInPlayOrderForBooks.mockResolvedValue(new Map([[10, [{ id: 501, format: 'm4b', durationSeconds: 1000 }]]]));

      await makeService().sync(user);

      expect(mockStatusService.updateManual).toHaveBeenCalledWith(user.id, 10, { status: 'rereading' });
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
      mockRepo.findAudioFilesInPlayOrderForBooks.mockResolvedValue(new Map());

      await makeService().sync(user);

      expect(mockRepo.upsertAudioProgressGuarded).not.toHaveBeenCalled();
    });

    it('skips position when the ABS duration is invalid (<= 0)', async () => {
      mockRepo.findSettings.mockResolvedValue(positionSettings());
      mockClient.getMe.mockResolvedValue({ mediaProgress: [makeMp({ duration: 0 })] });
      mockRepo.findSyncableBookStatesByAbsItemIds.mockResolvedValue([makeState({ bookId: 10 })]);
      mockRepo.findAudioFilesInPlayOrderForBooks.mockResolvedValue(new Map([[10, [{ id: 501, format: 'm4b', durationSeconds: 1000 }]]]));

      await makeService().sync(user);

      expect(mockRepo.upsertAudioProgressGuarded).not.toHaveBeenCalled();
    });

    it('skips position when local progress is newer (newest-wins)', async () => {
      mockRepo.findSettings.mockResolvedValue(positionSettings());
      mockClient.getMe.mockResolvedValue({ mediaProgress: [makeMp({ progress: 0.5, currentTime: 500, duration: 1000 })] });
      mockRepo.findSyncableBookStatesByAbsItemIds.mockResolvedValue([makeState({ bookId: 10, lastSyncedProgressAt: null })]);
      mockRepo.findAudioFilesInPlayOrderForBooks.mockResolvedValue(new Map([[10, [{ id: 501, format: 'm4b', durationSeconds: 1000 }]]]));
      // No prior ABS-write snapshot -> compare positions: local 90% beats ABS 50%.
      mockRepo.findAudioProgressForBooks.mockResolvedValue(new Map([[10, { percentage: 90, updatedAt: new Date('2026-07-19T00:00:00Z') }]]));

      await makeService().sync(user);

      expect(mockRepo.upsertAudioProgressGuarded).not.toHaveBeenCalled();
    });

    it('writes the resolved file and seconds when position is due and valid', async () => {
      mockRepo.findSettings.mockResolvedValue(positionSettings());
      mockClient.getMe.mockResolvedValue({ mediaProgress: [makeMp({ progress: 0.5, currentTime: 500, duration: 1000 })] });
      mockRepo.findSyncableBookStatesByAbsItemIds.mockResolvedValue([makeState({ bookId: 10 })]);
      mockRepo.findAudioFilesInPlayOrderForBooks.mockResolvedValue(new Map([[10, [{ id: 501, format: 'm4b', durationSeconds: 1000 }]]]));
      mockRepo.findAudioProgressForBooks.mockResolvedValue(new Map());

      await makeService().sync(user);

      expect(mockRepo.upsertAudioProgressGuarded).toHaveBeenCalledWith(user.id, 10, 501, 500, 50, null);
      // status disabled -> no status derivation on the position path.
      expect(mockStatusService.updateManual).not.toHaveBeenCalled();
    });
  });

  describe('batched pre-loads (no per-book reads in the apply loop)', () => {
    function wireBooks(count: number) {
      const bookIds = Array.from({ length: count }, (_, i) => 100 + i);
      const progresses = bookIds.map((_, i) =>
        makeMp({ id: `mp-${i}`, libraryItemId: `item-${i}`, progress: 0.5, currentTime: 500, duration: 1000 }),
      );
      mockClient.getMe.mockResolvedValue({ mediaProgress: progresses });
      mockRepo.findSyncableBookStatesByAbsItemIds.mockResolvedValue(bookIds.map((bookId, i) => makeState({ absLibraryItemId: `item-${i}`, bookId })));
      mockRepo.findAudioFilesInPlayOrderForBooks.mockResolvedValue(
        new Map(bookIds.map((bookId) => [bookId, [{ id: 500 + bookId, format: 'm4b', durationSeconds: 1000 }]])),
      );
      return bookIds;
    }

    it('reads audio files and audio position once per run for the whole due set', async () => {
      const bookIds = wireBooks(3);

      await makeService().sync(user);

      expect(mockRepo.findAudioFilesInPlayOrderForBooks).toHaveBeenCalledTimes(1);
      expect(mockRepo.findAudioFilesInPlayOrderForBooks).toHaveBeenCalledWith(bookIds);
      expect(mockRepo.findAudioProgressForBooks).toHaveBeenCalledTimes(1);
      expect(mockRepo.findAudioProgressForBooks).toHaveBeenCalledWith(user.id, bookIds);
      // Each book still applies its own status and position write.
      expect(mockStatusService.updateManual).toHaveBeenCalledTimes(3);
      expect(mockRepo.upsertAudioProgressGuarded).toHaveBeenCalledTimes(3);
    });

    it('pre-loads only the books whose phase is due', async () => {
      mockRepo.findSettings.mockResolvedValue(makeSettings({ syncStatus: true, syncPosition: false }));
      const bookIds = wireBooks(2);

      await makeService().sync(user);

      expect(mockStatusService.findOne).toHaveBeenCalledTimes(bookIds.length);
      expect(mockRepo.findAudioFilesInPlayOrderForBooks).toHaveBeenCalledWith([]);
      expect(mockRepo.findAudioProgressForBooks).toHaveBeenCalledWith(user.id, []);
    });

    it('derives each book status from its own fresh read, not a run-start snapshot', async () => {
      const bookIds = wireBooks(2);
      mockStatusService.findOne.mockResolvedValueOnce({ status: 'read' }).mockResolvedValueOnce({ status: 'unread' });

      await makeService().sync(user);

      expect(mockStatusService.updateManual).toHaveBeenCalledWith(user.id, bookIds[0], { status: 'rereading' });
      expect(mockStatusService.updateManual).toHaveBeenCalledWith(user.id, bookIds[1], { status: 'reading' });
    });

    it('keeps per-book error isolation when one book fails mid-loop', async () => {
      wireBooks(2);
      mockRepo.upsertAudioProgressGuarded.mockRejectedValueOnce(new Error('write failed'));

      const result = await makeService().sync(user);

      expect(result.failed).toBe(1);
      expect(result.positionApplied).toBe(1);
      expect(mockRepo.upsertAudioProgressGuarded).toHaveBeenCalledTimes(2);
      expect(mockRepo.updateBookState).toHaveBeenCalledWith(user.id, 'item-0', { syncError: 'write failed' });
    });

    it('drops the position write and its event when local playback wins the CAS race', async () => {
      mockRepo.findSettings.mockResolvedValue(makeSettings({ syncStatus: false, syncPosition: true }));
      wireBooks(1);
      mockRepo.upsertAudioProgressGuarded.mockResolvedValue(undefined);

      const result = await makeService().sync(user);

      expect(mockRepo.upsertAudioProgressGuarded).toHaveBeenCalledTimes(1);
      expect(result.positionApplied).toBe(0);
      expect(result.failed).toBe(0);
      expect(mockAchievementEvents.emit).not.toHaveBeenCalled();
    });
  });
});
