import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { MonitoredAuthorConfig } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { MonitoredSyncSchedulerService } from './monitored-sync-scheduler.service';

const owner = { id: 4, isSuperuser: false } as RequestUser;

function monitor(patch: Partial<MonitoredAuthorConfig> = {}): MonitoredAuthorConfig {
  return {
    id: 'monitor-1',
    ownerUserId: 4,
    authorName: 'Test Author',
    localAuthorId: null,
    providerIds: { hardcover: 'author-1' },
    formats: {
      ebook: { mode: 'notify', libraryId: null, folderId: null },
      audiobook: { mode: 'off', libraryId: null, folderId: null },
    },
    paused: false,
    addedAt: '2026-03-15T10:00:00.000Z',
    lastRefreshedAt: null,
    ...patch,
  };
}

function harness(options: { due?: MonitoredAuthorConfig[]; syncEnabled?: boolean } = {}) {
  const store = {
    findMonitorsDueForSync: vi.fn().mockResolvedValue(options.due ?? [monitor()]),
    countMonitorsDueForSync: vi.fn().mockResolvedValue((options.due ?? [monitor()]).length),
    stampSyncAttempt: vi.fn().mockResolvedValue(undefined),
  };
  const monitored = { refreshForSchedule: vi.fn().mockResolvedValue(true) };
  const watcher = { checkMonitor: vi.fn().mockResolvedValue({ announced: 0 }) };
  const users = { findByIdWithPermissions: vi.fn().mockResolvedValue(owner) };
  const appSettings = {
    getMonitoredSettings: vi.fn().mockResolvedValue({
      refreshCooldownMinutes: 10,
      syncEnabled: options.syncEnabled ?? true,
      syncIntervalHours: 12,
    }),
  };
  const scheduler = new MonitoredSyncSchedulerService(store as never, monitored as never, watcher as never, users as never, appSettings as never);
  return { scheduler, store, monitored, watcher, users, appSettings };
}

describe('MonitoredSyncSchedulerService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refreshes a due monitor and checks its releases straight after', async () => {
    const { scheduler, store, monitored, watcher } = harness();

    await scheduler.runScheduledSync();

    expect(monitored.refreshForSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: 'monitor-1' }), owner);
    expect(watcher.checkMonitor).toHaveBeenCalledWith(expect.objectContaining({ id: 'monitor-1' }));
    expect(store.stampSyncAttempt).toHaveBeenCalledWith('monitor-1', expect.any(Date));
    expect(store.stampSyncAttempt.mock.invocationCallOrder[0]).toBeLessThan(watcher.checkMonitor.mock.invocationCallOrder[0]);
  });

  it('does nothing at all when the operator has turned sync off', async () => {
    const { scheduler, store, monitored } = harness({ syncEnabled: false });

    await scheduler.runScheduledSync();

    expect(store.findMonitorsDueForSync).not.toHaveBeenCalled();
    expect(monitored.refreshForSchedule).not.toHaveBeenCalled();
  });

  it('asks for monitors older than the configured interval', async () => {
    const { scheduler, store } = harness();

    await scheduler.runScheduledSync();

    const [staleBefore, limit] = store.findMonitorsDueForSync.mock.calls[0];
    expect(staleBefore).toBeInstanceOf(Date);
    expect(Date.now() - (staleBefore as Date).getTime()).toBeGreaterThanOrEqual(12 * 60 * 60 * 1000 - 5_000);
    expect(limit).toBeGreaterThan(0);
  });

  // A missing Hardcover token is a configuration gap, not an error, and must not stop the sweep.
  it('skips a monitor whose owner has no Hardcover token, without checking its releases', async () => {
    const { scheduler, store, monitored, watcher } = harness();
    monitored.refreshForSchedule.mockResolvedValueOnce(false);

    await scheduler.runScheduledSync();

    expect(watcher.checkMonitor).not.toHaveBeenCalled();
    expect(store.stampSyncAttempt).toHaveBeenCalledWith('monitor-1', expect.any(Date));
  });

  it('skips a monitor whose owner cannot be resolved', async () => {
    const { scheduler, store, monitored, users } = harness();
    users.findByIdWithPermissions.mockResolvedValueOnce(null);

    await scheduler.runScheduledSync();

    expect(monitored.refreshForSchedule).not.toHaveBeenCalled();
    expect(store.stampSyncAttempt).toHaveBeenCalledWith('monitor-1', expect.any(Date));
  });

  it('isolates a failing monitor so the rest of the sweep still runs', async () => {
    const { scheduler, store, monitored, watcher } = harness({ due: [monitor(), monitor({ id: 'monitor-2' })] });
    monitored.refreshForSchedule.mockRejectedValueOnce(new Error('hardcover timeout'));

    await expect(scheduler.runScheduledSync()).resolves.toBeUndefined();

    expect(monitored.refreshForSchedule).toHaveBeenCalledTimes(2);
    expect(watcher.checkMonitor).toHaveBeenCalledTimes(1);
    expect(watcher.checkMonitor).toHaveBeenCalledWith(expect.objectContaining({ id: 'monitor-2' }));
    expect(store.stampSyncAttempt).toHaveBeenCalledWith('monitor-1', expect.any(Date));
    expect(store.stampSyncAttempt).toHaveBeenCalledWith('monitor-2', expect.any(Date));
  });

  it('continues after an owner lookup throws for the first monitor', async () => {
    const { scheduler, store, monitored, users } = harness({ due: [monitor(), monitor({ id: 'monitor-2' })] });
    users.findByIdWithPermissions.mockRejectedValueOnce(new Error('database unavailable'));

    await scheduler.runScheduledSync();

    expect(users.findByIdWithPermissions).toHaveBeenCalledTimes(2);
    expect(monitored.refreshForSchedule).toHaveBeenCalledTimes(1);
    expect(monitored.refreshForSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: 'monitor-2' }), owner);
    expect(store.stampSyncAttempt).toHaveBeenCalledWith('monitor-1', expect.any(Date));
  });

  // A refresh that landed is a success even if the announcement afterwards could not be made.
  it('does not fail a good refresh when the release check throws', async () => {
    const { scheduler, watcher } = harness();
    watcher.checkMonitor.mockRejectedValueOnce(new Error('notification gateway down'));

    await expect(scheduler.runScheduledSync()).resolves.toBeUndefined();
  });

  it('logs a stamp failure without counting a successful refresh as failed', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { scheduler, store, watcher } = harness();
    store.stampSyncAttempt.mockRejectedValueOnce(new Error('stamp failed'));

    await scheduler.runScheduledSync();

    expect(store.stampSyncAttempt).toHaveBeenCalledTimes(1);
    expect(watcher.checkMonitor).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.map(([message]) => String(message)).find((message) => message.includes('[monitored.sync] [end]'))).toContain(
      'refreshed=1 skipped=0 failed=0',
    );
    log.mockRestore();
  });

  it('does not start a second run while one is in flight', async () => {
    const { scheduler, store, appSettings } = harness();
    let release: () => void = () => {};
    appSettings.getMonitoredSettings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ refreshCooldownMinutes: 10, syncEnabled: true, syncIntervalHours: 12 });
        }),
    );

    const first = scheduler.runScheduledSync();
    await scheduler.runScheduledSync();
    expect(store.findMonitorsDueForSync).not.toHaveBeenCalled();

    release();
    await first;
    expect(store.findMonitorsDueForSync).toHaveBeenCalledTimes(1);
  });

  it('logs the total due count at the start and end of a run', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { scheduler, store } = harness();
    store.countMonitorsDueForSync.mockResolvedValueOnce(37);

    await scheduler.runScheduledSync();

    const messages = log.mock.calls.map(([message]) => String(message));
    expect(messages.find((message) => message.includes('[monitored.sync] [start]'))).toContain('due=37');
    expect(messages.find((message) => message.includes('[monitored.sync] [end]'))).toContain('due=37');
  });
});
