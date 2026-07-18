import { ConflictException } from '@nestjs/common';
import { Permission } from '@bookorbit/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import { AudiobookshelfSyncSchedulerService, isDeepSessionScanDue } from './audiobookshelf-sync-scheduler.service';
import {
  AUDIOBOOKSHELF_DEEP_SCAN_EVERY_N_RUNS,
  AUDIOBOOKSHELF_DEEP_SCAN_INTERVAL_MS,
  AUDIOBOOKSHELF_SCHEDULER_INTERVAL_MS,
} from './audiobookshelf.constants';

function makeUser(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    id: 1,
    active: true,
    isSuperuser: false,
    permissions: [Permission.AudiobookshelfSync],
    ...overrides,
  } as unknown as RequestUser;
}

interface EnabledUser {
  userId: number;
  lastDeepSessionScanAt: Date | null;
}

function makeDeps() {
  const repo = { findEnabledConfiguredUsers: vi.fn(), updateSettings: vi.fn().mockResolvedValue(undefined) };
  const syncService = { sync: vi.fn().mockResolvedValue({}) };
  const userService = { findByIdWithPermissions: vi.fn() };
  const service = new AudiobookshelfSyncSchedulerService(repo as never, syncService as never, userService as never);
  return { service, repo, syncService, userService };
}

// One page of the given users, then an empty page to end keyset iteration.
function singlePage(repo: { findEnabledConfiguredUsers: ReturnType<typeof vi.fn> }, users: EnabledUser[]) {
  repo.findEnabledConfiguredUsers.mockResolvedValueOnce(users).mockResolvedValue([]);
}

function notDeepUsers(ids: number[]): EnabledUser[] {
  // System time is pinned to 0 in beforeEach, so the current stagger slice is 0. Any userId whose
  // `id % slices != 0` is off-slice and therefore never deep-due this tick.
  return ids.map((userId) => ({ userId, lastDeepSessionScanAt: null }));
}

const SLICES = AUDIOBOOKSHELF_DEEP_SCAN_EVERY_N_RUNS;

function sliceOf(now: number): number {
  return Math.floor(now / AUDIOBOOKSHELF_SCHEDULER_INTERVAL_MS) % SLICES;
}

describe('isDeepSessionScanDue', () => {
  const now = 5_000 * AUDIOBOOKSHELF_SCHEDULER_INTERVAL_MS;
  const onSlice = sliceOf(now);

  it('is due when never scanned and the tick matches the user stagger slice', () => {
    expect(isDeepSessionScanDue(null, onSlice, now)).toBe(true);
  });

  it('staggers a never-scanned user off its slice so it is not yet due', () => {
    expect(isDeepSessionScanDue(null, onSlice + 1, now)).toBe(false);
  });

  it('is not due again before the deep interval elapses, even on its slice', () => {
    const justScanned = new Date(now - 1000);
    expect(isDeepSessionScanDue(justScanned, onSlice, now)).toBe(false);
  });

  it('becomes due once the deep interval has elapsed on its slice', () => {
    const longAgo = new Date(now - AUDIOBOOKSHELF_DEEP_SCAN_INTERVAL_MS);
    expect(isDeepSessionScanDue(longAgo, onSlice, now)).toBe(true);
  });

  it('spreads distinct users across different slices so they are not all due at once', () => {
    const due = [];
    for (let userId = 0; userId < SLICES; userId++) {
      if (isDeepSessionScanDue(null, userId, now)) due.push(userId);
    }
    // Exactly one userId in a full slice range is due on any single tick.
    expect(due).toEqual([onSlice]);
  });
});

describe('AudiobookshelfSyncSchedulerService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('syncs each enabled+configured user that still holds the permission', async () => {
    const { service, repo, syncService, userService } = makeDeps();
    singlePage(repo, notDeepUsers([1, 2]));
    userService.findByIdWithPermissions.mockImplementation((id: number) => Promise.resolve(makeUser({ id })));

    await service.runScheduledSync();

    expect(syncService.sync).toHaveBeenCalledTimes(2);
    expect(syncService.sync).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), { deepSessions: false, reconcile: false });
    expect(syncService.sync).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }), { deepSessions: false, reconcile: false });
  });

  it('skips users who were deleted, deactivated, or lost the sync permission', async () => {
    const { service, repo, syncService, userService } = makeDeps();
    singlePage(repo, notDeepUsers([1, 2, 3]));
    userService.findByIdWithPermissions.mockImplementation((id: number) => {
      if (id === 1) return Promise.resolve(null);
      if (id === 2) return Promise.resolve(makeUser({ id: 2, active: false }));
      return Promise.resolve(makeUser({ id: 3, permissions: [] }));
    });

    await service.runScheduledSync();

    expect(syncService.sync).not.toHaveBeenCalled();
  });

  it('isolates one user failure so the loop still processes the rest', async () => {
    const { service, repo, syncService, userService } = makeDeps();
    singlePage(repo, notDeepUsers([1, 2]));
    userService.findByIdWithPermissions.mockImplementation((id: number) => Promise.resolve(makeUser({ id })));
    syncService.sync.mockImplementation((user: RequestUser) => (user.id === 1 ? Promise.reject(new Error('boom')) : Promise.resolve({})));

    await expect(service.runScheduledSync()).resolves.toBeUndefined();

    expect(syncService.sync).toHaveBeenCalledTimes(2);
  });

  it('treats a per-user in-flight ConflictException as a skip, not a failure', async () => {
    const { service, repo, syncService, userService } = makeDeps();
    singlePage(repo, notDeepUsers([1]));
    userService.findByIdWithPermissions.mockResolvedValue(makeUser({ id: 1 }));
    syncService.sync.mockRejectedValue(new ConflictException('already running'));
    const warnSpy = vi.spyOn((service as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => undefined);

    await service.runScheduledSync();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('skips a tick while the previous run is still in flight (overlap guard)', async () => {
    const { service, repo, syncService, userService } = makeDeps();
    repo.findEnabledConfiguredUsers.mockResolvedValueOnce(notDeepUsers([1])).mockResolvedValue([]);
    userService.findByIdWithPermissions.mockResolvedValue(makeUser({ id: 1 }));

    let release: (() => void) | undefined;
    syncService.sync.mockReturnValueOnce(
      new Promise<object>((resolve) => {
        release = () => resolve({});
      }),
    );

    const first = service.runScheduledSync();
    await Promise.resolve();

    await service.runScheduledSync();
    expect(syncService.sync).toHaveBeenCalledTimes(1);

    release?.();
    await first;
  });

  it('deep-scans only the user whose slice matches this tick and stamps its deep watermark', async () => {
    const now = 5_000 * AUDIOBOOKSHELF_SCHEDULER_INTERVAL_MS;
    vi.setSystemTime(now);
    const onSlice = sliceOf(now);
    const offSlice = onSlice + 1;

    const { service, repo, syncService, userService } = makeDeps();
    singlePage(repo, [
      { userId: onSlice, lastDeepSessionScanAt: null },
      { userId: offSlice, lastDeepSessionScanAt: null },
    ]);
    userService.findByIdWithPermissions.mockImplementation((id: number) => Promise.resolve(makeUser({ id })));

    await service.runScheduledSync();

    expect(syncService.sync).toHaveBeenCalledWith(expect.objectContaining({ id: onSlice }), { deepSessions: true, reconcile: true });
    expect(syncService.sync).toHaveBeenCalledWith(expect.objectContaining({ id: offSlice }), { deepSessions: false, reconcile: false });
    expect(repo.updateSettings).toHaveBeenCalledWith(onSlice, { lastDeepSessionScanAt: expect.any(Date) });
    expect(repo.updateSettings).not.toHaveBeenCalledWith(offSlice, expect.anything());
  });

  it('does not stamp the deep watermark when a deep-due user fails', async () => {
    const now = 5_000 * AUDIOBOOKSHELF_SCHEDULER_INTERVAL_MS;
    vi.setSystemTime(now);
    const onSlice = sliceOf(now);

    const { service, repo, syncService, userService } = makeDeps();
    singlePage(repo, [{ userId: onSlice, lastDeepSessionScanAt: null }]);
    userService.findByIdWithPermissions.mockResolvedValue(makeUser({ id: onSlice }));
    syncService.sync.mockRejectedValue(new Error('deep boom'));

    await service.runScheduledSync();

    expect(repo.updateSettings).not.toHaveBeenCalled();
  });
});
