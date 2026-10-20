import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MonitoredFetchJobService } from './monitored-fetch-job.service';
import { MonitoredStoreService } from '../monitored-store.service';
import { MonitoredCatalogService } from '../monitored-catalog.service';
import { MonitoredService } from '../monitored.service';
import { MonitoredGateway } from '../monitored.gateway';
import { MonitoredProviderConfigService } from '../monitored-provider-config.service';
import { UserService } from '../../user/user.service';
import { CatalogFetchError } from '../monitored-fetch-error';

afterEach(() => vi.useRealTimers());
async function harness(attempts = 0) {
  const store = {
    claimFetch: vi.fn().mockResolvedValue(true),
    releaseFetch: vi.fn().mockResolvedValue(true),
    getMonitorForFetch: vi.fn().mockResolvedValue({ id: 'a', ownerUserId: 1, localAuthorId: null, fetchAttempts: attempts }),
    finishFetchSucceeded: vi.fn().mockResolvedValue(true),
    finishFetchFailed: vi.fn().mockResolvedValue(true),
  };
  const catalog = {
    fetchCatalog: vi.fn().mockResolvedValue({ catalog: { fetchedAt: '2026-10-20T12:00:00.000Z', works: [] }, hardcoverAuthorId: '42' }),
  };
  const service = { toFetchEventItem: vi.fn().mockResolvedValue({ id: 'a' }), runFetchFollowUps: vi.fn().mockResolvedValue(undefined) };
  const gateway = { emitFetch: vi.fn() };
  const configs = { forUser: vi.fn().mockResolvedValue({ hardcover: { enabled: true, apiKey: 'key' } }) };
  const users = { findByIdWithPermissions: vi.fn().mockResolvedValue({ id: 1 }) };
  const module = await Test.createTestingModule({
    providers: [
      MonitoredFetchJobService,
      { provide: MonitoredStoreService, useValue: store },
      { provide: MonitoredCatalogService, useValue: catalog },
      { provide: MonitoredService, useValue: service },
      { provide: MonitoredGateway, useValue: gateway },
      { provide: MonitoredProviderConfigService, useValue: configs },
      { provide: UserService, useValue: users },
    ],
  }).compile();
  return { job: module.get(MonitoredFetchJobService), store, catalog, service, gateway, configs, users };
}
describe('MonitoredFetchJobService', () => {
  it.each(['monitor', 'owner', 'config'])('records unavailable after a %s lookup throws', async (lookup) => {
    const h = await harness();
    const target = lookup === 'monitor' ? h.store.getMonitorForFetch : lookup === 'owner' ? h.users.findByIdWithPermissions : h.configs.forUser;
    target.mockRejectedValue(new Error('lookup failed'));
    expect(await h.job.run('a', 'create', new AbortController().signal)).toEqual({ outcome: 'failed', retryAt: expect.any(Date) });
    expect(h.store.finishFetchFailed).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ kind: 'unavailable', attempts: 1, retryAt: expect.any(String) }),
    );
  });
  it('retries a failed failure-state write once', async () => {
    const h = await harness();
    h.catalog.fetchCatalog.mockRejectedValue(new CatalogFetchError('timeout', null, null));
    h.store.finishFetchFailed.mockRejectedValueOnce(new Error('write failed'));
    expect((await h.job.run('a', 'retry', new AbortController().signal)).outcome).toBe('failed');
    expect(h.store.finishFetchFailed).toHaveBeenCalledTimes(2);
    expect(h.store.finishFetchFailed).toHaveBeenLastCalledWith('a', expect.objectContaining({ kind: 'unavailable' }));
  });
  it('returns failed and logs after both failure-state writes throw', async () => {
    const h = await harness();
    const warn = vi.spyOn((h.job as unknown as { logger: { warn: (message: string) => void } }).logger, 'warn');
    h.store.getMonitorForFetch.mockRejectedValue(new Error('read failed'));
    h.store.finishFetchFailed.mockRejectedValue(new Error('write failed'));
    expect(await h.job.run('a', 'retry', new AbortController().signal)).toEqual({ outcome: 'failed', retryAt: expect.any(Date) });
    expect(h.store.finishFetchFailed).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('errorClass=Error error="write failed" - fetch state write failed'));
  });
  it('releases a claim when the owner is missing', async () => {
    const h = await harness();
    h.users.findByIdWithPermissions.mockResolvedValue(null);
    await h.job.run('a', 'create', new AbortController().signal);
    expect(h.store.releaseFetch).toHaveBeenCalledWith('a');
    expect(h.store.finishFetchFailed).not.toHaveBeenCalled();
    expect(h.store.finishFetchSucceeded).not.toHaveBeenCalled();
    expect(h.catalog.fetchCatalog).not.toHaveBeenCalled();
  });
  it('claims, emits, saves success, emits idle and then runs follow-ups', async () => {
    const h = await harness();
    expect(await h.job.run('a', 'create', new AbortController().signal)).toEqual({ outcome: 'succeeded', retryAt: null });
    expect(h.store.claimFetch).toHaveBeenCalledWith('a');
    expect(h.store.finishFetchSucceeded).toHaveBeenCalledWith('a', {
      lastRefreshedAt: '2026-10-20T12:00:00.000Z',
      hardcoverAuthorId: '42',
      localAuthorId: null,
    });
    expect(h.gateway.emitFetch).toHaveBeenCalledTimes(2);
    expect(h.gateway.emitFetch.mock.invocationCallOrder[0]).toBeLessThan(h.catalog.fetchCatalog.mock.invocationCallOrder[0]);
    expect(h.gateway.emitFetch.mock.invocationCallOrder[1]).toBeLessThan(h.service.runFetchFollowUps.mock.invocationCallOrder[0]);
  });
  it('skips an unclaimed row', async () => {
    const h = await harness();
    h.store.claimFetch.mockResolvedValue(false);
    expect((await h.job.run('a', 'refresh', new AbortController().signal)).outcome).toBe('skipped');
    expect(h.store.getMonitorForFetch).not.toHaveBeenCalled();
  });
  it('records not_configured without retry', async () => {
    const h = await harness();
    h.configs.forUser.mockResolvedValue({ hardcover: { enabled: false, apiKey: '' } });
    expect(await h.job.run('a', 'refresh', new AbortController().signal)).toEqual({ outcome: 'failed', retryAt: null });
    expect(h.store.finishFetchFailed).toHaveBeenCalledWith('a', expect.objectContaining({ kind: 'not_configured', retryAt: null }));
    expect(h.catalog.fetchCatalog).not.toHaveBeenCalled();
  });
  it.each([0, 3])('records timeout with saturating attempts from %s', async (attempts) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
    const h = await harness(attempts);
    h.catalog.fetchCatalog.mockRejectedValue(new CatalogFetchError('timeout', null, null));
    const retryAt = attempts === 0 ? new Date(Date.now() + 300000) : null;
    expect(await h.job.run('a', 'retry', new AbortController().signal)).toEqual({ outcome: 'failed', retryAt });
    expect(h.store.finishFetchFailed).toHaveBeenCalledWith('a', {
      kind: 'timeout',
      at: new Date().toISOString(),
      retryAt: retryAt?.toISOString() ?? null,
      attempts: Math.min(attempts + 1, 3),
    });
    expect(h.store.finishFetchSucceeded).not.toHaveBeenCalled();
    expect(h.service.runFetchFollowUps).not.toHaveBeenCalled();
  });
  it('records nothing after an abort mid-fetch', async () => {
    const h = await harness();
    const controller = new AbortController();
    h.catalog.fetchCatalog.mockImplementation(() => {
      controller.abort();
      throw controller.signal.reason;
    });
    const emittedBefore = () => h.gateway.emitFetch.mock.calls.length;
    expect(await h.job.run('a', 'refresh', controller.signal)).toEqual({ outcome: 'skipped', retryAt: null });
    expect(h.store.finishFetchFailed).not.toHaveBeenCalled();
    expect(h.store.finishFetchSucceeded).not.toHaveBeenCalled();
    expect(emittedBefore()).toBe(1);
  });
  it('does not emit or retry when failure write finds a deleted row', async () => {
    const h = await harness();
    h.catalog.fetchCatalog.mockRejectedValue(new CatalogFetchError('timeout', null, null));
    h.store.finishFetchFailed.mockResolvedValue(false);
    expect((await h.job.run('a', 'retry', new AbortController().signal)).retryAt).toBeNull();
    expect(h.gateway.emitFetch).toHaveBeenCalledTimes(1);
  });
  it('keeps success when follow-ups throw', async () => {
    const h = await harness();
    h.service.runFetchFollowUps.mockRejectedValue(new Error('follow-up'));
    expect((await h.job.run('a', 'sync', new AbortController().signal)).outcome).toBe('succeeded');
    expect(h.store.finishFetchFailed).not.toHaveBeenCalled();
  });
  it.each(['monitor', 'owner'])('silently skips missing %s', async (missing) => {
    const h = await harness();
    if (missing === 'monitor') h.store.getMonitorForFetch.mockResolvedValue(null);
    else h.users.findByIdWithPermissions.mockResolvedValue(null);
    expect((await h.job.run('a', 'retry', new AbortController().signal)).outcome).toBe('skipped');
    expect(h.catalog.fetchCatalog).not.toHaveBeenCalled();
    expect(h.gateway.emitFetch).not.toHaveBeenCalled();
  });
});
