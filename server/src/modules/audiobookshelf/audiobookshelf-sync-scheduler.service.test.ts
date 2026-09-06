import { ConflictException, Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AudiobookshelfSyncSchedulerService } from './audiobookshelf-sync-scheduler.service';

const mockRepo = {
  findEnabledConfiguredUsers: vi.fn(),
};

const mockSyncService = {
  sync: vi.fn(),
};

const mockUserService = {
  findByIdWithPermissions: vi.fn(),
};

function eligibleUser(userId: number) {
  return { id: userId, active: true, isSuperuser: true, permissions: [] };
}

function makeDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeService() {
  return new AudiobookshelfSyncSchedulerService(mockRepo as any, mockSyncService as any, mockUserService as any);
}

describe('AudiobookshelfSyncSchedulerService', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    mockSyncService.sync.mockResolvedValue(undefined);
    mockUserService.findByIdWithPermissions.mockImplementation((id: number) => Promise.resolve(eligibleUser(id)));
    // Single short page by default: one user, fewer than the page size, so the loop stops after one page.
    mockRepo.findEnabledConfiguredUsers.mockResolvedValue([{ userId: 1 }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('runScheduledSync', () => {
    it('logs nothing when no users are configured', async () => {
      mockRepo.findEnabledConfiguredUsers.mockResolvedValue([]);

      await makeService().runScheduledSync();

      expect(logSpy).not.toHaveBeenCalled();
    });

    it('syncs each eligible user with full options', async () => {
      await makeService().runScheduledSync();

      expect(mockSyncService.sync).toHaveBeenCalledTimes(1);
      expect(mockSyncService.sync).toHaveBeenCalledWith(eligibleUser(1), {});
    });

    it('logs start and end when a user is synced', async () => {
      await makeService().runScheduledSync();

      expect(logSpy).toHaveBeenCalledTimes(2);
      expect(logSpy).toHaveBeenCalledWith('[abs.scheduler] [start] - run started');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[abs.scheduler] [end]'));
    });

    it('walks keyset pages, advancing afterUserId to the last user of the page', async () => {
      const firstPage = Array.from({ length: 100 }, (_, i) => ({ userId: i + 1 }));
      mockRepo.findEnabledConfiguredUsers.mockResolvedValueOnce(firstPage).mockResolvedValueOnce([]);

      await makeService().runScheduledSync();

      expect(mockRepo.findEnabledConfiguredUsers).toHaveBeenNthCalledWith(1, 0, 100);
      expect(mockRepo.findEnabledConfiguredUsers).toHaveBeenNthCalledWith(2, 100, 100);
      expect(mockSyncService.sync).toHaveBeenCalledTimes(100);
    });

    it('skips the tick when a previous full run is still in flight', async () => {
      const pending = makeDeferred<void>();
      mockSyncService.sync.mockReturnValueOnce(pending.promise);

      const service = makeService();
      const first = service.runScheduledSync();
      const second = service.runScheduledSync();

      // Only the first run entered the loop; the overlap guard short-circuited the second.
      expect(mockRepo.findEnabledConfiguredUsers).toHaveBeenCalledTimes(1);

      pending.resolve();
      await Promise.all([first, second]);
    });

    it('releases the overlap guard so a later run proceeds', async () => {
      const service = makeService();
      await service.runScheduledSync();
      await service.runScheduledSync();

      expect(mockRepo.findEnabledConfiguredUsers).toHaveBeenCalledTimes(2);
    });

    it('skips an ineligible (inactive) user without calling sync', async () => {
      mockUserService.findByIdWithPermissions.mockResolvedValue({ ...eligibleUser(1), active: false });

      await makeService().runScheduledSync();

      expect(mockSyncService.sync).not.toHaveBeenCalled();
    });

    it('skips a user that fails to resolve', async () => {
      mockUserService.findByIdWithPermissions.mockRejectedValue(new Error('lookup failed'));

      await makeService().runScheduledSync();

      expect(mockSyncService.sync).not.toHaveBeenCalled();
    });

    it('isolates a ConflictException so the rest of the batch still syncs', async () => {
      mockRepo.findEnabledConfiguredUsers.mockResolvedValue([{ userId: 1 }, { userId: 2 }, { userId: 3 }]);
      mockSyncService.sync.mockImplementation((user: { id: number }) =>
        user.id === 2 ? Promise.reject(new ConflictException('in flight')) : Promise.resolve(undefined),
      );

      await makeService().runScheduledSync();

      expect(mockSyncService.sync).toHaveBeenCalledTimes(3);
    });

    it('isolates a generic sync error so the rest of the batch still syncs', async () => {
      mockRepo.findEnabledConfiguredUsers.mockResolvedValue([{ userId: 1 }, { userId: 2 }, { userId: 3 }]);
      mockSyncService.sync.mockImplementation((user: { id: number }) =>
        user.id === 2 ? Promise.reject(new Error('boom')) : Promise.resolve(undefined),
      );

      await makeService().runScheduledSync();

      expect(mockSyncService.sync).toHaveBeenCalledTimes(3);
    });

    it('does not abort the run when a page fetch throws', async () => {
      mockRepo.findEnabledConfiguredUsers.mockRejectedValue(new Error('db down'));

      await expect(makeService().runScheduledSync()).resolves.toBeUndefined();
      expect(mockSyncService.sync).not.toHaveBeenCalled();
    });
  });

  describe('runHotSync', () => {
    it('logs nothing when no users are configured', async () => {
      mockRepo.findEnabledConfiguredUsers.mockResolvedValue([]);

      await makeService().runHotSync();

      expect(logSpy).not.toHaveBeenCalled();
    });

    it('syncs each eligible user with hotInProgressOnly (and warmSessions on the first tick)', async () => {
      await makeService().runHotSync();

      // First hot tick for a user always warms (no prior warm timestamp).
      expect(mockSyncService.sync).toHaveBeenCalledWith(eligibleUser(1), { hotInProgressOnly: true, warmSessions: true });
    });

    it('does not log start or end when a user is synced', async () => {
      await makeService().runHotSync();

      expect(mockSyncService.sync).toHaveBeenCalledTimes(1);
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('sets warmSessions at most once per 90s per user across successive hot ticks', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-20T00:00:00Z'));
      const service = makeService();

      // Tick 1 (T+0): first ever tick warms.
      await service.runHotSync();
      expect(mockSyncService.sync).toHaveBeenNthCalledWith(1, eligibleUser(1), { hotInProgressOnly: true, warmSessions: true });

      // Tick 2 (T+30s): inside the 90s window, so no warm - position only.
      vi.setSystemTime(new Date('2026-07-20T00:00:30Z'));
      await service.runHotSync();
      expect(mockSyncService.sync).toHaveBeenNthCalledWith(2, eligibleUser(1), { hotInProgressOnly: true, warmSessions: false });

      // Tick 3 (T+90s): 90s elapsed since the last warm, so warm again.
      vi.setSystemTime(new Date('2026-07-20T00:01:30Z'));
      await service.runHotSync();
      expect(mockSyncService.sync).toHaveBeenNthCalledWith(3, eligibleUser(1), { hotInProgressOnly: true, warmSessions: true });
    });

    it('throttles warmSessions independently per user', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-20T00:00:00Z'));
      mockRepo.findEnabledConfiguredUsers.mockResolvedValue([{ userId: 1 }, { userId: 2 }]);
      const service = makeService();

      // Both users warm on their first tick.
      await service.runHotSync();
      expect(mockSyncService.sync).toHaveBeenCalledWith(eligibleUser(1), { hotInProgressOnly: true, warmSessions: true });
      expect(mockSyncService.sync).toHaveBeenCalledWith(eligibleUser(2), { hotInProgressOnly: true, warmSessions: true });

      // 30s later both are throttled.
      vi.clearAllMocks();
      mockUserService.findByIdWithPermissions.mockImplementation((id: number) => Promise.resolve(eligibleUser(id)));
      mockRepo.findEnabledConfiguredUsers.mockResolvedValue([{ userId: 1 }, { userId: 2 }]);
      mockSyncService.sync.mockResolvedValue(undefined);
      vi.setSystemTime(new Date('2026-07-20T00:00:30Z'));
      await service.runHotSync();
      expect(mockSyncService.sync).toHaveBeenCalledWith(eligibleUser(1), { hotInProgressOnly: true, warmSessions: false });
      expect(mockSyncService.sync).toHaveBeenCalledWith(eligibleUser(2), { hotInProgressOnly: true, warmSessions: false });
    });

    it('does not add warmSessions to the full (non-hot) run options', async () => {
      await makeService().runScheduledSync();

      expect(mockSyncService.sync).toHaveBeenCalledWith(eligibleUser(1), {});
    });

    it('skips the tick when a previous hot run is still in flight', async () => {
      const pending = makeDeferred<void>();
      mockSyncService.sync.mockReturnValueOnce(pending.promise);

      const service = makeService();
      const first = service.runHotSync();
      const second = service.runHotSync();

      expect(mockRepo.findEnabledConfiguredUsers).toHaveBeenCalledTimes(1);

      pending.resolve();
      await Promise.all([first, second]);
    });

    it('uses a separate guard from the full run so a full run does not block a hot run', async () => {
      const pending = makeDeferred<void>();
      mockSyncService.sync.mockReturnValueOnce(pending.promise);

      const service = makeService();
      const full = service.runScheduledSync();
      const hot = service.runHotSync();

      // Full run holds its own guard; the hot run runs concurrently and still enters the loop.
      expect(mockRepo.findEnabledConfiguredUsers).toHaveBeenCalledTimes(2);

      pending.resolve();
      await Promise.all([full, hot]);
    });
  });
});
