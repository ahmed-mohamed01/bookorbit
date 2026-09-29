import { afterEach, describe, expect, it, vi } from 'vitest';

import { AudiobookshelfSyncCoordinatorService } from './audiobookshelf-sync-coordinator.service';

const USER_ID = 7;

describe('AudiobookshelfSyncCoordinatorService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses a second sync for the same user but not for another user', async () => {
    const coordinator = new AudiobookshelfSyncCoordinatorService();

    await expect(coordinator.acquireSync(USER_ID, 10_000)).resolves.toBe(true);
    await expect(coordinator.acquireSync(USER_ID, 10_000)).resolves.toBe(false);
    await expect(coordinator.acquireSync(USER_ID + 1, 10_000)).resolves.toBe(true);
  });

  it('lets a sync wait for an in-flight push and take the lock when it ends', async () => {
    const coordinator = new AudiobookshelfSyncCoordinatorService();
    expect(coordinator.tryStartPush(USER_ID)).toBe(true);

    const acquired = coordinator.acquireSync(USER_ID, 10_000);
    expect(coordinator.isSyncRunning(USER_ID)).toBe(true);
    coordinator.endPush(USER_ID);

    await expect(acquired).resolves.toBe(true);
    expect(coordinator.tryStartPush(USER_ID)).toBe(false);
  });

  it('blocks new pushes while a sync is waiting, so pushes cannot starve it', () => {
    const coordinator = new AudiobookshelfSyncCoordinatorService();
    coordinator.tryStartPush(USER_ID);

    void coordinator.acquireSync(USER_ID, 10_000);
    coordinator.endPush(USER_ID);

    expect(coordinator.tryStartPush(USER_ID)).toBe(false);
  });

  it('gives up after the wait when the push does not end, and lets pushes run again', async () => {
    vi.useFakeTimers();
    const coordinator = new AudiobookshelfSyncCoordinatorService();
    coordinator.tryStartPush(USER_ID);

    const acquired = coordinator.acquireSync(USER_ID, 10_000);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(acquired).resolves.toBe(false);
    expect(coordinator.isSyncRunning(USER_ID)).toBe(false);
    coordinator.endPush(USER_ID);
    expect(coordinator.tryStartPush(USER_ID)).toBe(true);
  });
});
