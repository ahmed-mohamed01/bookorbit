import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { MonitoredSyncSchedulerService } from './monitored-sync-scheduler.service';
import { MonitoredService } from './monitored.service';
import { MonitoredStoreService } from './monitored-store.service';
import { MonitoredSettingsService } from './monitored-settings.service';
import { MonitoredFetchCoordinator } from './fetch/monitored-fetch-coordinator.service';

async function harness(enabled = true) {
  const store = {
    findMonitorsDueForSync: vi.fn().mockResolvedValue([
      { id: 'a', ownerUserId: 1 },
      { id: 'b', ownerUserId: 2 },
    ]),
    countMonitorsDueForSync: vi.fn().mockResolvedValue(2),
    stampSyncAttempt: vi.fn(),
  };
  const coordinator = { request: vi.fn().mockResolvedValue(true) };
  const module = await Test.createTestingModule({
    providers: [
      MonitoredSyncSchedulerService,
      { provide: MonitoredStoreService, useValue: store },
      { provide: MonitoredFetchCoordinator, useValue: coordinator },
      {
        provide: MonitoredSettingsService,
        useValue: { getMonitoredSettings: () => Promise.resolve({ syncEnabled: enabled, syncIntervalHours: 12 }) },
      },
    ],
  }).compile();
  return { scheduler: module.get(MonitoredSyncSchedulerService), store, coordinator };
}
describe('background sync scheduler', () => {
  it('stamps due monitors before requesting sync and removes inline refresh', async () => {
    const h = await harness();
    await h.scheduler.runScheduledSync();
    expect(h.coordinator.request).toHaveBeenCalledWith('a', 'sync');
    expect(h.coordinator.request).toHaveBeenCalledWith('b', 'sync');
    expect(h.store.stampSyncAttempt.mock.invocationCallOrder[0]).toBeLessThan(h.coordinator.request.mock.invocationCallOrder[0]);
    expect(MonitoredService.prototype).not.toHaveProperty('refreshForSchedule');
  });
  it('skips disabled sync', async () => {
    const h = await harness(false);
    await h.scheduler.runScheduledSync();
    expect(h.coordinator.request).not.toHaveBeenCalled();
    expect(h.store.findMonitorsDueForSync).not.toHaveBeenCalled();
  });
  it('continues after a request fails', async () => {
    const h = await harness();
    h.coordinator.request.mockRejectedValueOnce(new Error('failed'));
    await h.scheduler.runScheduledSync();
    expect(h.coordinator.request).toHaveBeenCalledTimes(2);
  });
});
