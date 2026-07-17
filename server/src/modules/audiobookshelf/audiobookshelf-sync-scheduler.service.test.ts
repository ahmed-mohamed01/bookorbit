import { ConflictException } from '@nestjs/common';
import { Permission } from '@bookorbit/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import { AudiobookshelfSyncSchedulerService } from './audiobookshelf-sync-scheduler.service';
import { AUDIOBOOKSHELF_DEEP_SCAN_EVERY_N_RUNS } from './audiobookshelf.constants';

function makeUser(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    id: 1,
    active: true,
    isSuperuser: false,
    permissions: [Permission.AudiobookshelfSync],
    ...overrides,
  } as unknown as RequestUser;
}

function makeDeps() {
  const repo = { findEnabledConfiguredUserIds: vi.fn() };
  const syncService = { sync: vi.fn().mockResolvedValue({}) };
  const userService = { findByIdWithPermissions: vi.fn() };
  const service = new AudiobookshelfSyncSchedulerService(repo as never, syncService as never, userService as never);
  return { service, repo, syncService, userService };
}

// One page of the given ids, then an empty page to end keyset iteration.
function singlePage(repo: { findEnabledConfiguredUserIds: ReturnType<typeof vi.fn> }, ids: number[]) {
  repo.findEnabledConfiguredUserIds.mockResolvedValueOnce(ids).mockResolvedValue([]);
}

describe('AudiobookshelfSyncSchedulerService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('syncs each enabled+configured user that still holds the permission', async () => {
    const { service, repo, syncService, userService } = makeDeps();
    singlePage(repo, [1, 2]);
    userService.findByIdWithPermissions.mockImplementation((id: number) => Promise.resolve(makeUser({ id })));

    await service.runScheduledSync();

    expect(syncService.sync).toHaveBeenCalledTimes(2);
    expect(syncService.sync).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), { deepSessions: false });
    expect(syncService.sync).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }), { deepSessions: false });
  });

  it('skips users who were deleted, deactivated, or lost the sync permission', async () => {
    const { service, repo, syncService, userService } = makeDeps();
    singlePage(repo, [1, 2, 3]);
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
    singlePage(repo, [1, 2]);
    userService.findByIdWithPermissions.mockImplementation((id: number) => Promise.resolve(makeUser({ id })));
    syncService.sync.mockImplementation((user: RequestUser) => (user.id === 1 ? Promise.reject(new Error('boom')) : Promise.resolve({})));

    await expect(service.runScheduledSync()).resolves.toBeUndefined();

    expect(syncService.sync).toHaveBeenCalledTimes(2);
  });

  it('treats a per-user in-flight ConflictException as a skip, not a failure', async () => {
    const { service, repo, syncService, userService } = makeDeps();
    singlePage(repo, [1]);
    userService.findByIdWithPermissions.mockResolvedValue(makeUser({ id: 1 }));
    syncService.sync.mockRejectedValue(new ConflictException('already running'));
    const warnSpy = vi.spyOn((service as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => undefined);

    await service.runScheduledSync();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('skips a tick while the previous run is still in flight (overlap guard)', async () => {
    const { service, repo, syncService, userService } = makeDeps();
    repo.findEnabledConfiguredUserIds.mockResolvedValueOnce([1]).mockResolvedValue([]);
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

  it('runs a deep reconciliation scan every Nth executed run', async () => {
    const { service, repo, syncService, userService } = makeDeps();
    repo.findEnabledConfiguredUserIds.mockImplementation((after: number) => Promise.resolve(after === 0 ? [1] : []));
    userService.findByIdWithPermissions.mockResolvedValue(makeUser({ id: 1 }));

    for (let run = 1; run < AUDIOBOOKSHELF_DEEP_SCAN_EVERY_N_RUNS; run++) {
      await service.runScheduledSync();
    }
    expect(syncService.sync).toHaveBeenLastCalledWith(expect.anything(), { deepSessions: false });

    await service.runScheduledSync();
    expect(syncService.sync).toHaveBeenLastCalledWith(expect.anything(), { deepSessions: true });
  });
});
