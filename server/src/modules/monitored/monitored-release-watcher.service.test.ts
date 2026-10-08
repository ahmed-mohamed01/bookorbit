import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, Logger } from '@nestjs/common';
import type { MonitoredAuthorConfig, MonitoredWork } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { MonitoredReleaseWatcher } from './monitored-release-watcher.service';
import { releaseEventKey, type MonitoredDueRelease } from './monitored-store.service';

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

function release(patch: Partial<MonitoredDueRelease> = {}): MonitoredDueRelease {
  return {
    workId: 'work-1',
    title: 'Test Work',
    seriesName: 'Test Series',
    seriesIndex: '2',
    format: 'ebook',
    releaseDate: '2026-09-01',
    storedDate: '2026-09-01',
    claimed: false,
    ...patch,
  };
}

function work(patch: Partial<MonitoredWork> = {}): MonitoredWork {
  return {
    id: 'work-1',
    title: 'Test Work',
    subtitle: null,
    seriesName: 'Test Series',
    seriesIndex: '2',
    seriesMemberships: [],
    releaseYear: 2026,
    ebookReleaseDate: '2026-09-01',
    ebookDatePrecision: 'day',
    audioReleaseDate: '2026-09-01',
    audioDatePrecision: 'day',
    coverUrl: null,
    description: null,
    verdict: 'verified',
    flags: [],
    sources: ['hardcover'],
    providerWorkIds: { hardcover: 'hardcover-work-1' },
    monitorState: 'monitoring',
    matchedBookId: null,
    matchedBookIds: {},
    ownedFormats: [],
    monitorFormats: {},
    requestIds: {},
    ...patch,
  };
}

function autoMonitor(
  ebook: MonitoredAuthorConfig['formats']['ebook']['mode'],
  audiobook: MonitoredAuthorConfig['formats']['audiobook']['mode'] = 'off',
) {
  return monitor({
    formats: {
      ebook: { mode: ebook, libraryId: null, folderId: null },
      audiobook: { mode: audiobook, libraryId: null, folderId: null },
    },
  });
}

function harness(options: { due?: MonitoredDueRelease[]; stamp?: Date | null; user?: RequestUser | null; works?: MonitoredWork[] } = {}) {
  const stamp = options.stamp === undefined ? new Date('2026-09-01') : options.stamp;
  const store = {
    findMonitorsDueForReleaseCheck: vi.fn().mockResolvedValue([{ monitor: monitor(), lastReleaseCheckAt: stamp }]),
    findReleaseCheckStamp: vi.fn().mockResolvedValue(stamp),
    findDueReleases: vi.fn().mockImplementation(({ limit }: { limit: number }) => Promise.resolve((options.due ?? []).slice(0, limit))),
    claimReleaseEvents: vi
      .fn()
      .mockImplementation((_monitor, releases: MonitoredDueRelease[]) =>
        Promise.resolve(new Set(releases.filter((item) => !item.claimed).map((item) => releaseEventKey(item.workId, item.format)))),
      ),
    leaseReleaseEvent: vi.fn().mockResolvedValue(true),
    releaseReleaseEventLease: vi.fn().mockResolvedValue(undefined),
    stampReleaseCheck: vi.fn().mockResolvedValue(undefined),
    getComposedWorks: vi.fn().mockImplementation((ids: string[]) => {
      const byId = new Map((options.works ?? []).map((item) => [item.id, item]));
      return Promise.resolve(new Map(ids.flatMap((id) => (byId.has(id) ? [[id, byId.get(id)!] as const] : []))));
    }),
  };
  const notifier = { notifyRelease: vi.fn().mockResolvedValue(undefined), logDispatchFailure: vi.fn() };
  const users = { findByIdWithPermissions: vi.fn().mockResolvedValue(options.user === undefined ? owner : options.user) };
  let nextRequestId = 500;
  const autoRequests = {
    submitWorkRequest: vi
      .fn()
      .mockImplementation((_user, _monitor, target: MonitoredWork, format: 'ebook' | 'audiobook') =>
        Promise.resolve({ ...target, requestIds: { ...target.requestIds, [format]: nextRequestId++ } }),
      ),
  };
  const watcher = new MonitoredReleaseWatcher(store as never, notifier as never, users as never, autoRequests as never);
  return { watcher, store, notifier, users, autoRequests };
}

describe('MonitoredReleaseWatcher.checkMonitor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('leases and announces a release', async () => {
    const { watcher, store, notifier } = harness({ due: [release()] });

    const result = await watcher.checkMonitor(monitor());

    expect(result.announced).toBe(1);
    expect(result.releases).toHaveLength(1);
    expect(store.claimReleaseEvents).toHaveBeenCalledWith(expect.anything(), [expect.objectContaining({ workId: 'work-1' })], true);
    expect(store.leaseReleaseEvent).toHaveBeenCalledWith('work-1', 'ebook', 4);
    expect(notifier.notifyRelease).toHaveBeenCalledWith(expect.objectContaining({ id: 'monitor-1' }), [
      expect.objectContaining({ workId: 'work-1' }),
    ]);
  });

  // Mirrors the Releases tab, which folds a work's format rows into one card: one message names
  // both formats, while the ledger and the lease stay per format.
  it('announces both formats of one work in a single notification', async () => {
    const { watcher, store, notifier } = harness({ due: [release(), release({ format: 'audiobook' })] });

    const result = await watcher.checkMonitor(monitor());

    expect(result.announced).toBe(2);
    expect(store.leaseReleaseEvent).toHaveBeenCalledTimes(2);
    expect(notifier.notifyRelease).toHaveBeenCalledTimes(1);
    expect(notifier.notifyRelease).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({ workId: 'work-1', format: 'ebook' }),
      expect.objectContaining({ workId: 'work-1', format: 'audiobook' }),
    ]);
  });

  it('keeps different works as separate notifications', async () => {
    const { watcher, notifier } = harness({ due: [release(), release({ workId: 'work-2' })] });

    await watcher.checkMonitor(monitor());

    expect(notifier.notifyRelease).toHaveBeenCalledTimes(2);
  });

  it('leaves a work that straddles the page boundary for the next pass', async () => {
    const firstPage = Array.from({ length: 24 }, (_, index) => release({ workId: `work-${index + 1}` }));
    const boundaryWork = [release({ workId: 'boundary-work', format: 'ebook' }), release({ workId: 'boundary-work', format: 'audiobook' })];
    const { watcher, store, notifier } = harness({ due: [...firstPage, ...boundaryWork] });

    const result = await watcher.checkMonitor(monitor());

    expect(result.announced).toBe(24);
    expect(notifier.notifyRelease).toHaveBeenCalledTimes(24);
    expect(notifier.notifyRelease).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([expect.objectContaining({ workId: 'boundary-work' })]),
    );
    expect(store.claimReleaseEvents).toHaveBeenCalledWith(expect.anything(), firstPage, true);
  });

  it('announces only the formats this pass managed to lease', async () => {
    const { watcher, store, notifier } = harness({ due: [release(), release({ format: 'audiobook' })] });
    store.leaseReleaseEvent.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const result = await watcher.checkMonitor(monitor());

    expect(result.announced).toBe(1);
    expect(notifier.notifyRelease).toHaveBeenCalledWith(expect.anything(), [expect.objectContaining({ format: 'ebook' })]);
  });

  it('releases every lease in the group when its one dispatch fails', async () => {
    const { watcher, store, notifier } = harness({ due: [release(), release({ format: 'audiobook' })] });
    notifier.notifyRelease.mockRejectedValueOnce(new Error('gateway down'));

    const result = await watcher.checkMonitor(monitor());

    expect(result.failed).toBe(2);
    expect(result.announced).toBe(0);
    expect(store.releaseReleaseEventLease).toHaveBeenCalledWith('work-1', 'ebook', 4);
    expect(store.releaseReleaseEventLease).toHaveBeenCalledWith('work-1', 'audiobook', 4);
    expect(notifier.logDispatchFailure).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([expect.objectContaining({ format: 'audiobook' })]),
      expect.any(Number),
      expect.any(Error),
    );
  });

  it('seeds silently on the first pass and announces nothing', async () => {
    const { watcher, store, notifier } = harness({ due: [release(), release({ workId: 'work-2' })], stamp: null });

    const result = await watcher.checkMonitor(monitor());

    expect(result.seeded).toBe(2);
    expect(result.announced).toBe(0);
    expect(notifier.notifyRelease).not.toHaveBeenCalled();
    expect(store.claimReleaseEvents).toHaveBeenCalledWith(expect.anything(), expect.any(Array), false);
    expect(store.stampReleaseCheck).toHaveBeenCalledWith('monitor-1', expect.any(Date));
  });

  it("excludes today's day-precision release from a full seed pass and leaves the monitor unstamped", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T12:00:00.000Z'));
    try {
      const many = Array.from({ length: 2000 }, (_, index) =>
        release({
          workId: `work-${index}`,
          releaseDate: index === 0 ? '2026-09-10' : '2026-09-09',
          storedDate: index === 0 ? '2026-09-10' : '2026-09-09',
        }),
      );
      const { watcher, store, notifier } = harness({ due: many, stamp: null });

      const result = await watcher.checkMonitor(monitor());

      expect(result.seeded).toBe(1999);
      expect(store.findDueReleases).toHaveBeenCalledWith(expect.objectContaining({ limit: 2000 }));
      const seeded = store.claimReleaseEvents.mock.calls[0]?.[1] as MonitoredDueRelease[];
      expect(seeded.some((item) => item.releaseDate === '2026-09-10')).toBe(false);
      expect(store.stampReleaseCheck).not.toHaveBeenCalled();
      expect(notifier.notifyRelease).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('excludes a month-precision release on its first due day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T12:00:00.000Z'));
    try {
      const { watcher, store } = harness({
        due: [release({ releaseDate: '2026-09-01', storedDate: '2026-09' })],
        stamp: null,
      });

      const result = await watcher.checkMonitor(monitor());

      expect(result.seeded).toBe(0);
      expect(store.claimReleaseEvents).toHaveBeenCalledWith(expect.anything(), [], false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('includes a month-precision release after its first due day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-02T12:00:00.000Z'));
    try {
      const due = release({ releaseDate: '2026-09-01', storedDate: '2026-09' });
      const { watcher, store } = harness({ due: [due], stamp: null });

      const result = await watcher.checkMonitor(monitor());

      expect(result.seeded).toBe(1);
      expect(store.claimReleaseEvents).toHaveBeenCalledWith(expect.anything(), [due], false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses a supplied stamp without another database lookup', async () => {
    const { watcher, store } = harness({ due: [] });

    await watcher.checkMonitor(monitor(), new Date('2026-09-01'));

    expect(store.findReleaseCheckStamp).not.toHaveBeenCalled();
  });

  it('retries a pending row through the same lease path', async () => {
    const { watcher, store, notifier } = harness({ due: [release({ claimed: true })] });

    const result = await watcher.checkMonitor(monitor());

    expect(result.announced).toBe(1);
    expect(store.leaseReleaseEvent).toHaveBeenCalledWith('work-1', 'ebook', 4);
    expect(notifier.notifyRelease).toHaveBeenCalledTimes(1);
  });

  it('skips a release when another pass owns the lease', async () => {
    const { watcher, store, notifier } = harness({ due: [release()] });
    store.leaseReleaseEvent.mockResolvedValueOnce(false);

    const result = await watcher.checkMonitor(monitor());

    expect(result.announced).toBe(0);
    expect(result.failed).toBe(0);
    expect(notifier.notifyRelease).not.toHaveBeenCalled();
  });

  it('releases the lease and counts a failed dispatch', async () => {
    const { watcher, store, notifier } = harness({ due: [release()] });
    notifier.notifyRelease.mockRejectedValueOnce(new Error('gateway down'));

    const result = await watcher.checkMonitor(monitor());

    expect(result.failed).toBe(1);
    expect(result.announced).toBe(0);
    expect(store.releaseReleaseEventLease).toHaveBeenCalledWith('work-1', 'ebook', 4);
    expect(notifier.logDispatchFailure).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.any(Number), expect.any(Error));
    expect(store.stampReleaseCheck).toHaveBeenCalled();
  });

  it('carries on to the next release when one dispatch fails', async () => {
    const { watcher, notifier } = harness({ due: [release(), release({ workId: 'work-2' })] });
    notifier.notifyRelease.mockRejectedValueOnce(new Error('gateway down'));

    const result = await watcher.checkMonitor(monitor());

    expect(result.failed).toBe(1);
    expect(result.announced).toBe(1);
    expect(result.releases).toEqual([expect.objectContaining({ workId: 'work-2' })]);
  });

  it('stamps a monitor whose owner cannot be resolved', async () => {
    const { watcher, store, notifier } = harness({ due: [release()], user: null });

    const result = await watcher.checkMonitor(monitor());

    expect(result.announced).toBe(0);
    expect(notifier.notifyRelease).not.toHaveBeenCalled();
    expect(store.findDueReleases).not.toHaveBeenCalled();
    expect(store.stampReleaseCheck).toHaveBeenCalledWith('monitor-1', expect.any(Date));
  });

  it('stamps the check even when nothing is due', async () => {
    const { watcher, store } = harness({ due: [] });

    await watcher.checkMonitor(monitor());

    expect(store.stampReleaseCheck).toHaveBeenCalledWith('monitor-1', expect.any(Date));
  });
});

describe('MonitoredReleaseWatcher request hand-off', () => {
  beforeEach(() => vi.clearAllMocks());

  const destinationRefusal = () =>
    new BadRequestException({ message: 'Pick a destination', errorCode: 'SUBMIT_DESTINATION_REQUIRED', statusCode: 400 });

  it('files a request for each announced auto format after notifying, deferring from the fourth', async () => {
    const ids = ['work-1', 'work-2', 'work-3', 'work-4', 'work-5'];
    const { watcher, notifier, autoRequests } = harness({
      due: ids.map((workId) => release({ workId })),
      works: ids.map((id) => work({ id })),
    });

    const result = await watcher.checkMonitor(autoMonitor('auto-upcoming'));

    expect(result).toMatchObject({ announced: 5, requested: 5, requestFailed: 0 });
    expect(autoRequests.submitWorkRequest).toHaveBeenCalledTimes(5);
    expect(notifier.notifyRelease.mock.invocationCallOrder.at(-1)).toBeLessThan(autoRequests.submitWorkRequest.mock.invocationCallOrder[0]);
    expect(autoRequests.submitWorkRequest.mock.calls.map(([user, , target, format, opts]) => [user, target.id, format, opts])).toEqual([
      [owner, 'work-1', 'ebook', { autoGrab: true, deferAutomation: false }],
      [owner, 'work-2', 'ebook', { autoGrab: true, deferAutomation: false }],
      [owner, 'work-3', 'ebook', { autoGrab: true, deferAutomation: false }],
      [owner, 'work-4', 'ebook', { autoGrab: true, deferAutomation: true }],
      [owner, 'work-5', 'ebook', { autoGrab: true, deferAutomation: true }],
    ]);
  });

  it('files nothing for a notify-mode format of the same monitor', async () => {
    const { watcher, autoRequests } = harness({
      due: [release(), release({ format: 'audiobook' })],
      works: [work()],
    });

    const result = await watcher.checkMonitor(autoMonitor('auto-all', 'notify'));

    expect(result).toMatchObject({ announced: 2, requested: 1 });
    expect(autoRequests.submitWorkRequest).toHaveBeenCalledTimes(1);
    expect(autoRequests.submitWorkRequest).toHaveBeenCalledWith(owner, expect.anything(), expect.objectContaining({ id: 'work-1' }), 'ebook', {
      autoGrab: true,
      deferAutomation: false,
    });
  });

  it('files nothing when no format is in an auto mode', async () => {
    const { watcher, store, autoRequests } = harness({ due: [release()], works: [work()] });

    await watcher.checkMonitor(monitor());

    expect(store.getComposedWorks).not.toHaveBeenCalled();
    expect(autoRequests.submitWorkRequest).not.toHaveBeenCalled();
  });

  it('skips a work that already carries a request for the format', async () => {
    const { watcher, autoRequests } = harness({ due: [release()], works: [work({ requestIds: { ebook: 77 } })] });

    const result = await watcher.checkMonitor(autoMonitor('auto-upcoming'));

    expect(result).toMatchObject({ announced: 1, requested: 0, requestFailed: 0 });
    expect(autoRequests.submitWorkRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['an owned format', { ownedFormats: ['ebook' as const] }],
    ['a format switched off on the work', { monitorFormats: { ebook: false } }],
  ])('skips %s', async (_label, patch) => {
    const { watcher, autoRequests } = harness({ due: [release()], works: [work(patch)] });

    await watcher.checkMonitor(autoMonitor('auto-all'));

    expect(autoRequests.submitWorkRequest).not.toHaveBeenCalled();
  });

  it('keeps the notification when the request fails and does not throw', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { watcher, store, autoRequests } = harness({ due: [release()], works: [work()] });
    autoRequests.submitWorkRequest.mockRejectedValueOnce(new Error('request service down'));

    const result = await watcher.checkMonitor(autoMonitor('auto-upcoming'));

    expect(result).toMatchObject({ announced: 1, failed: 0, requested: 0, requestFailed: 1 });
    expect(store.releaseReleaseEventLease).not.toHaveBeenCalled();
    expect(store.stampReleaseCheck).toHaveBeenCalledWith('monitor-1', expect.any(Date));
    expect(warn.mock.calls.map(([message]) => String(message)).find((message) => message.includes('[monitored.release.request] [fail]'))).toContain(
      'error="request service down"',
    );
    warn.mockRestore();
  });

  it('keeps the notification when loading the works fails', async () => {
    const { watcher, store, autoRequests } = harness({ due: [release()], works: [work()] });
    store.getComposedWorks.mockRejectedValueOnce(new Error('database gone'));

    const result = await watcher.checkMonitor(autoMonitor('auto-upcoming'));

    expect(result).toMatchObject({ announced: 1, requested: 0, requestFailed: 1 });
    expect(autoRequests.submitWorkRequest).not.toHaveBeenCalled();
    expect(store.stampReleaseCheck).toHaveBeenCalled();
  });

  it('stops filing a format for the rest of the pass after a destination refusal', async () => {
    const ids = ['work-1', 'work-2', 'work-3', 'work-4', 'work-5'];
    const { watcher, autoRequests } = harness({
      due: [...ids.map((workId) => release({ workId })), release({ workId: 'work-5', format: 'audiobook' })],
      works: ids.map((id) => work({ id })),
    });
    autoRequests.submitWorkRequest.mockImplementation((_user, _monitor, target: MonitoredWork, format: string) =>
      format === 'ebook' ? Promise.reject(destinationRefusal()) : Promise.resolve({ ...target, requestIds: { [format]: 9 } }),
    );

    const result = await watcher.checkMonitor(autoMonitor('auto-all', 'auto-all'));

    const ebookCalls = autoRequests.submitWorkRequest.mock.calls.filter(([, , , format]) => format === 'ebook');
    expect(ebookCalls).toHaveLength(3);
    expect(autoRequests.submitWorkRequest.mock.calls.filter(([, , , format]) => format === 'audiobook')).toHaveLength(1);
    expect(result).toMatchObject({ announced: 6, requested: 1, requestFailed: 3 });
  });

  it('files nothing during the seed pass', async () => {
    const { watcher, store, autoRequests } = harness({ due: [release()], works: [work()], stamp: null });

    await watcher.checkMonitor(autoMonitor('auto-all'));

    expect(store.getComposedWorks).not.toHaveBeenCalled();
    expect(autoRequests.submitWorkRequest).not.toHaveBeenCalled();
  });

  it('loads the announced works once and skips one that is gone', async () => {
    const { watcher, store, autoRequests } = harness({
      due: [release(), release({ format: 'audiobook' }), release({ workId: 'work-gone' })],
      works: [work()],
    });

    const result = await watcher.checkMonitor(autoMonitor('auto-upcoming', 'auto-upcoming'));

    expect(store.getComposedWorks).toHaveBeenCalledTimes(1);
    expect(store.getComposedWorks).toHaveBeenCalledWith(['work-1', 'work-gone'], owner);
    expect(autoRequests.submitWorkRequest).toHaveBeenCalledTimes(2);
    expect(autoRequests.submitWorkRequest.mock.calls.every(([, , target]) => target.id === 'work-1')).toBe(true);
    expect(result).toMatchObject({ announced: 3, requested: 2, requestFailed: 0 });
  });

  it('files nothing for a paused monitor', async () => {
    const { watcher, autoRequests } = harness({ due: [release()], works: [work()] });

    await watcher.checkMonitor({ ...autoMonitor('auto-all'), paused: true });

    expect(autoRequests.submitWorkRequest).not.toHaveBeenCalled();
  });

  it('logs the request id when a request is filed', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { watcher } = harness({ due: [release()], works: [work()] });

    await watcher.checkMonitor(autoMonitor('auto-upcoming'));

    const messages = log.mock.calls.map(([message]) => String(message));
    expect(messages).toContainEqual(
      expect.stringContaining('[monitored.release.request] [start] monitorId="monitor-1" userId=4 workId="work-1" format=ebook'),
    );
    expect(messages.find((message) => message.includes('[monitored.release.request] [end]'))).toMatch(
      /workId="work-1" format=ebook requestId=500 deferred=false durationMs=\d+/,
    );
    log.mockRestore();
  });
});

describe('MonitoredReleaseWatcher.sweepReleases', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not start a second sweep while one is in flight', async () => {
    const { watcher, store } = harness({ due: [] });
    let releaseFetch: () => void = () => {};
    store.findMonitorsDueForReleaseCheck.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFetch = () => resolve([]);
        }),
    );

    const first = watcher.sweepReleases();
    await watcher.sweepReleases();
    expect(store.findMonitorsDueForReleaseCheck).toHaveBeenCalledTimes(1);

    releaseFetch();
    await first;
  });

  it('survives the monitor list fetch throwing and reports the failure rather than rethrowing', async () => {
    const { watcher, store } = harness({ due: [] });
    store.findMonitorsDueForReleaseCheck.mockRejectedValueOnce(new Error('database gone'));

    await expect(watcher.sweepReleases()).resolves.toBeUndefined();
  });

  it('leaves a failed seed unstamped, stamps a failed normal check, and continues', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const first = monitor({ id: 'monitor-1' });
    const second = monitor({ id: 'monitor-2' });
    const { watcher, store } = harness({ due: [] });
    store.findMonitorsDueForReleaseCheck.mockResolvedValueOnce([
      { monitor: first, lastReleaseCheckAt: null },
      { monitor: second, lastReleaseCheckAt: new Date('2026-09-01') },
    ]);
    const check = vi.spyOn(watcher, 'checkMonitor').mockRejectedValueOnce(new Error('seed failed')).mockRejectedValueOnce(new Error('normal failed'));

    await watcher.sweepReleases();

    expect(check).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenNthCalledWith(2, second, new Date('2026-09-01'));
    expect(store.stampReleaseCheck).toHaveBeenCalledTimes(1);
    expect(store.stampReleaseCheck).toHaveBeenCalledWith('monitor-2', expect.any(Date));
    expect(log.mock.calls.map(([message]) => String(message)).find((message) => message.includes('[monitored.release.sweep] [end]'))).toContain(
      'monitorsFailed=2 seeded=0 announced=0 failed=0 requested=0 requestFailed=0',
    );
    log.mockRestore();
  });

  it('adds request counters to the sweep totals', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { watcher } = harness({ due: [] });
    vi.spyOn(watcher, 'checkMonitor').mockResolvedValueOnce({ seeded: 0, announced: 2, failed: 0, requested: 1, requestFailed: 1, releases: [] });

    await watcher.sweepReleases();

    expect(log.mock.calls.map(([message]) => String(message)).find((message) => message.includes('[monitored.release.sweep] [end]'))).toContain(
      'announced=2 failed=0 requested=1 requestFailed=1',
    );
    log.mockRestore();
  });
});
