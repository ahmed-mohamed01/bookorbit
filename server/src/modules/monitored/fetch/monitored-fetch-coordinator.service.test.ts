import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MonitoredFetchCoordinator } from './monitored-fetch-coordinator.service';
import { MonitoredStoreService } from '../monitored-store.service';
import { MonitoredFetchJobService } from './monitored-fetch-job.service';
import { MonitoredService } from '../monitored.service';
import { MonitoredGateway } from '../monitored.gateway';
import { MonitoredSettingsService } from '../monitored-settings.service';

afterEach(() => vi.useRealTimers());
async function flush() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}
async function harness() {
  const rows = new Map<string, { id: string; state: string; paused: boolean; retryAt: string | null }>();
  const store = {
    markFetchQueued: vi.fn((id) => {
      const row = rows.get(id);
      if (!row || ['queued', 'fetching'].includes(row.state)) return false;
      row.state = 'queued';
      return true;
    }),
    resetInterruptedFetches: vi.fn(() => {
      let count = 0;
      for (const row of rows.values())
        if (row.state === 'fetching') {
          row.state = 'queued';
          count++;
        }
      return count;
    }),
    findQueuedFetches: vi.fn((after: { id: string } | null, limit: number) =>
      [...rows.values()]
        .filter((row) => row.state === 'queued' && (!after || row.id > after.id))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((row) => ({ id: row.id, addedAt: '2026-01-01' })),
    ),
    findPendingRetries: vi.fn(() => [...rows.values()].filter((row) => row.retryAt).map((row) => ({ id: row.id, retryAt: row.retryAt }))),
    getMonitorForFetch: vi.fn((id) => {
      const row = rows.get(id);
      return row
        ? {
            ownerUserId: 1,
            paused: row.paused,
            formats: { ebook: { mode: 'notify' } },
            fetch: { state: row.state, errorKind: 'timeout', retryAt: row.retryAt },
            lastRefreshedAt: null,
          }
        : null;
    }),
  };
  const job = {
    run: vi.fn((id) => {
      rows.get(id)!.state = 'idle';
      return { outcome: 'succeeded', retryAt: null };
    }),
  };
  const gateway = { emitFetch: vi.fn() };
  const module = await Test.createTestingModule({
    providers: [
      MonitoredFetchCoordinator,
      { provide: MonitoredStoreService, useValue: store },
      { provide: MonitoredFetchJobService, useValue: job },
      { provide: MonitoredService, useValue: { toFetchEventItem: vi.fn((id) => ({ id, ownerUserId: 1 })) } },
      { provide: MonitoredGateway, useValue: gateway },
      { provide: MonitoredSettingsService, useValue: { getMonitoredSettings: () => Promise.resolve({ syncIntervalHours: 12 }) } },
    ],
  }).compile();
  const coordinator = module.get(MonitoredFetchCoordinator);
  const add = (id: string, state: string, retryAt: string | null = null) => rows.set(id, { id, state, retryAt, paused: false });
  return { coordinator, store, job, rows, add, gateway };
}
describe('MonitoredFetchCoordinator', () => {
  it('requests twice but enqueues once', async () => {
    const h = await harness();
    h.add('a', 'idle');
    h.job.run.mockImplementation(() => new Promise(() => {}));
    expect(await h.coordinator.request('a', 'refresh')).toBe(true);
    expect(await h.coordinator.request('a', 'refresh')).toBe(false);
    expect(h.job.run).toHaveBeenCalledTimes(1);
    h.coordinator.onModuleDestroy();
  });
  it('recovers two interrupted fetches and one queued row', async () => {
    const h = await harness();
    h.add('a', 'fetching');
    h.add('b', 'fetching');
    h.add('c', 'queued');
    await h.coordinator.onApplicationBootstrap();
    await flush();
    expect(h.job.run).toHaveBeenCalledTimes(3);
    expect([...h.rows.values()].every((row) => row.state === 'idle')).toBe(true);
    h.coordinator.onModuleDestroy();
  });
  it('does not fail startup when recovery cannot reach the database', async () => {
    const h = await harness();
    h.store.resetInterruptedFetches.mockImplementation(() => {
      throw new Error('connection refused');
    });
    await expect(h.coordinator.onApplicationBootstrap()).resolves.toBeUndefined();
    h.coordinator.onModuleDestroy();
  });
  it('recovers all rows in keyset batches of 100', async () => {
    const h = await harness();
    for (let i = 0; i < 250; i++) h.add(String(i).padStart(3, '0'), 'queued');
    await h.coordinator.onApplicationBootstrap();
    for (let i = 0; i < 30; i++) await flush();
    expect(h.job.run).toHaveBeenCalledTimes(250);
    expect(h.store.findQueuedFetches).toHaveBeenCalledWith({ id: '099', addedAt: '2026-01-01' }, 100);
    expect(h.store.findQueuedFetches).toHaveBeenCalledWith({ id: '199', addedAt: '2026-01-01' }, 100);
    expect(h.job.run).toHaveBeenCalledWith('000', 'retry', expect.any(AbortSignal));
    h.coordinator.onModuleDestroy();
  });
  it('carries create and sync triggers into the job', async () => {
    const h = await harness();
    h.add('create', 'queued');
    h.add('sync', 'idle');
    h.coordinator.enqueueInserted('create');
    await h.coordinator.request('sync', 'sync');
    await flush();
    expect(h.job.run).toHaveBeenCalledWith('create', 'create', expect.any(AbortSignal));
    expect(h.job.run).toHaveBeenCalledWith('sync', 'sync', expect.any(AbortSignal));
    h.coordinator.onModuleDestroy();
  });
  it('restores a future retry and immediately requests an overdue retry', async () => {
    vi.useFakeTimers();
    const h = await harness();
    h.add('future', 'failed', new Date(Date.now() + 60000).toISOString());
    h.add('past', 'failed', new Date(Date.now() - 1).toISOString());
    await h.coordinator.onApplicationBootstrap();
    await flush();
    expect(h.job.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000);
    await flush();
    expect(h.job.run).toHaveBeenCalledTimes(2);
    expect(h.store.markFetchQueued).toHaveBeenCalledWith('future');
    h.coordinator.onModuleDestroy();
  });
  it('does not request a retry for a row paused before the timer fires', async () => {
    vi.useFakeTimers();
    const h = await harness();
    h.add('a', 'failed', new Date(Date.now() + 60000).toISOString());
    await h.coordinator.onApplicationBootstrap();
    h.rows.get('a')!.paused = true;
    await vi.advanceTimersByTimeAsync(60000);
    await flush();
    expect(h.store.markFetchQueued).not.toHaveBeenCalled();
    expect(h.job.run).not.toHaveBeenCalled();
    h.coordinator.onModuleDestroy();
  });
  it('stops queue and retry timers on destroy', async () => {
    vi.useFakeTimers();
    const h = await harness();
    h.add('a', 'failed', new Date(Date.now() + 60000).toISOString());
    await h.coordinator.onApplicationBootstrap();
    h.coordinator.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
    h.add('b', 'queued');
    h.coordinator.enqueueInserted('b');
    await flush();
    expect(h.job.run).not.toHaveBeenCalled();
  });
});
