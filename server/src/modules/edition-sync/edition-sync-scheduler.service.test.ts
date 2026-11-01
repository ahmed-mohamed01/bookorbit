import { EditionSyncQueueService } from './edition-sync-queue.service';
import { checkEditionSyncSources } from './edition-sync-source-check';
vi.mock('./edition-sync-source-check', () => ({ checkEditionSyncSources: vi.fn() }));
import { ConflictException, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EDITION_SYNC_CRON_JOB_NAME, EDITION_SYNC_UPSTREAM_WAIT_MS } from './edition-sync.constants';
import { EditionSyncSchedulerService } from './edition-sync-scheduler.service';
import type { EditionSyncClaim, EditionSyncIndexOutcome } from './edition-sync.types';

const okHealth = {
  state: 'ok',
  health: { activeJobId: null, activeJobs: 0, capacity: 1, version: '1.0', device: 'cpu', protocol: 1 },
} as const;

function outcome(claim: EditionSyncClaim, status: EditionSyncIndexOutcome['status']): EditionSyncIndexOutcome {
  return {
    bookId: claim.bookId,
    workerJobId: claim.workerJobId,
    status,
    durationMs: 1,
    audioSeconds: status === 'ready' ? 3600 : null,
    errorCode: null,
    error: null,
  };
}

function claimFor(bookId: number, pinned = false): EditionSyncClaim {
  return { bookId, workerJobId: `job-${bookId}`, pinned };
}

function setup(options: { runHours?: number; cron?: string | null; onFilesChanged?: 'next_run' | 'immediate' } = {}) {
  const repo = {
    findAdminSettings: vi.fn().mockResolvedValue({
      id: 1,
      onFilesChanged: options.onFilesChanged ?? 'next_run',
      cronExpression: options.cron ?? null,
      runHours: options.runHours ?? 8,
      updatedAt: new Date(),
      updatedByUserId: null,
    }),
    createRun: vi
      .fn()
      .mockImplementation((trigger: string, windowUntil: Date | null) => Promise.resolve({ id: 5, trigger, windowUntil, startedAt: new Date() })),
    clearPin: vi.fn().mockResolvedValue(undefined),
    widenRun: vi.fn().mockResolvedValue(undefined),
    finishRun: vi.fn().mockResolvedValue(undefined),
    endInterruptedRuns: vi.fn().mockResolvedValue(0),
    markInterruptedRows: vi.fn().mockResolvedValue(0),
    hasUpstreamActiveJobs: vi.fn().mockResolvedValue(false),
    findIndexRowByWorkerJobId: vi.fn().mockResolvedValue(null),
    findNextQueuedBook: vi.fn().mockResolvedValue(null),
    pinFilesChangedBooks: vi.fn().mockResolvedValue(2),
    findBooksNeedingRecheck: vi.fn().mockResolvedValue([]),
    findIndexRow: vi.fn().mockResolvedValue(null),
    findBookTitle: vi.fn().mockResolvedValue('Edgedancer'),
    countIndexStates: vi.fn().mockResolvedValue({ indexed: 1, queued: 4, failed: 0, stale: 0 }),
    countUnused: vi.fn().mockResolvedValue({ count: 0, bytes: 0 }),
    findRecentThroughput: vi.fn().mockResolvedValue({ books: 2, seconds: 7200 }),
  };
  const queue = { claimNext: vi.fn().mockResolvedValue(null), ensureValid: vi.fn().mockResolvedValue(true) };
  const indexer = {
    currentWorkerJobId: null as string | null,
    indexBook: vi.fn((claim: EditionSyncClaim, options: { shouldStop(): boolean; shouldYield(): Promise<boolean> }) =>
      Promise.resolve(outcome(claim, options.shouldStop() ? 'cancelled' : 'ready')),
    ),
    cancelCurrent: vi.fn().mockResolvedValue(undefined),
  };
  const workerClient = { healthState: vi.fn().mockResolvedValue(okHealth), cancel: vi.fn().mockResolvedValue({}) };
  const upstreamWorker = { currentJobId: null as string | null };
  const registry = new SchedulerRegistry();
  const service = new EditionSyncSchedulerService(
    repo as never,
    queue as never,
    indexer as never,
    workerClient as never,
    upstreamWorker as never,
    registry,
  );
  const finished = () => vi.waitFor(() => expect(repo.finishRun).toHaveBeenCalled());
  return { service, repo, queue, indexer, workerClient, upstreamWorker, registry, finished };
}

describe('EditionSyncSchedulerService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('indexes queued books one at a time until the queue is empty (manual run, no window)', async () => {
    const { service, repo, queue, indexer, finished } = setup();
    queue.claimNext.mockResolvedValueOnce(claimFor(1)).mockResolvedValueOnce(claimFor(2)).mockResolvedValueOnce(null);

    const status = await service.startManualRun();
    await finished();

    expect(status.run.active).toBe(true);
    expect(repo.createRun).toHaveBeenCalledWith('manual', null);
    expect(queue.claimNext).toHaveBeenNthCalledWith(1, { pinnedOnly: false, excludeBookIds: [] });
    expect(indexer.indexBook).toHaveBeenCalledTimes(2);
    expect(repo.finishRun).toHaveBeenCalledWith(5, { stopReason: 'empty', booksIndexed: 2, booksFailed: 0, secondsIndexed: 7200 });
  });

  it('rejects a second manual run while one is active', async () => {
    const { service, queue } = setup();
    let release: (value: null) => void = () => undefined;
    queue.claimNext.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));

    await service.startManualRun();
    await expect(service.startManualRun()).rejects.toBeInstanceOf(ConflictException);
    release(null);
  });

  it('stops starting unpinned books once the window closes, but lets the running book finish', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T02:00:00Z'));
    const { service, repo, queue, indexer, finished } = setup({ runHours: 1, cron: '0 2 * * *' });
    queue.claimNext.mockImplementation(({ pinnedOnly }: { pinnedOnly: boolean }) => Promise.resolve(pinnedOnly ? null : claimFor(1)));
    indexer.indexBook.mockImplementationOnce((claim: EditionSyncClaim) => {
      // The book outlasts the window; it still completes and counts.
      vi.setSystemTime(new Date('2026-11-01T03:30:00Z'));
      return Promise.resolve(outcome(claim, 'ready'));
    });

    (service as unknown as { onCronTick(): void }).onCronTick();
    await finished();

    expect(repo.createRun).toHaveBeenCalledWith('scheduled', new Date('2026-11-01T03:00:00Z'));
    expect(indexer.indexBook).toHaveBeenCalledTimes(1);
    expect(queue.claimNext).toHaveBeenLastCalledWith({ pinnedOnly: true, excludeBookIds: [] });
    expect(repo.finishRun).toHaveBeenCalledWith(5, expect.objectContaining({ stopReason: 'window_closed', booksIndexed: 1 }));
  });

  it('keeps indexing pinned books after the window closed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T02:00:00Z'));
    const { service, repo, queue, indexer, finished } = setup({ runHours: 1 });
    vi.setSystemTime(new Date('2026-11-01T02:00:00Z'));
    queue.claimNext
      .mockResolvedValueOnce(claimFor(1))
      .mockImplementationOnce(({ pinnedOnly }: { pinnedOnly: boolean }) => Promise.resolve(pinnedOnly ? claimFor(9, true) : null))
      .mockResolvedValue(null);
    indexer.indexBook.mockImplementationOnce((claim: EditionSyncClaim) => {
      vi.setSystemTime(new Date('2026-11-01T04:00:00Z'));
      return Promise.resolve(outcome(claim, 'ready'));
    });

    (service as unknown as { onCronTick(): void }).onCronTick();
    await finished();

    expect(indexer.indexBook.mock.calls.map(([claim]) => claim.bookId)).toEqual([1, 9]);
    expect(repo.finishRun).toHaveBeenCalledWith(5, expect.objectContaining({ stopReason: 'window_closed', booksIndexed: 2 }));
  });

  it('starts a pinned-only toggle run from a poke, outside any window', async () => {
    const { service, repo, queue, indexer, finished } = setup({ cron: null });
    repo.findNextQueuedBook.mockResolvedValueOnce({ bookId: 3, pinned: true });
    queue.claimNext.mockResolvedValueOnce(claimFor(3, true)).mockResolvedValueOnce(null);

    await service.tick();
    await finished();

    expect(repo.createRun).toHaveBeenCalledWith('toggle', null);
    expect(queue.claimNext).toHaveBeenCalledWith({ pinnedOnly: true, excludeBookIds: [] });
    expect(indexer.indexBook).toHaveBeenCalledWith(claimFor(3, true), expect.anything());
    expect(repo.finishRun).toHaveBeenCalledWith(5, expect.objectContaining({ stopReason: 'empty', booksIndexed: 1 }));
  });

  it('does not start a toggle run when nothing is pinned', async () => {
    const { service, repo } = setup();
    await service.tick();
    expect(repo.createRun).not.toHaveBeenCalled();
  });

  it('waits while upstream has read-aloud work, then continues', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { service, repo, queue, indexer, finished } = setup();
    repo.hasUpstreamActiveJobs.mockResolvedValueOnce(true).mockResolvedValue(false);
    queue.claimNext.mockResolvedValueOnce(claimFor(1)).mockResolvedValueOnce(null);

    await service.startManualRun();
    await vi.waitFor(() => expect(repo.hasUpstreamActiveJobs).toHaveBeenCalledTimes(1));
    expect(indexer.indexBook).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(EDITION_SYNC_UPSTREAM_WAIT_MS);
    await finished();

    expect(indexer.indexBook).toHaveBeenCalledTimes(1);
  });

  it('passes a yield check to the indexer and resumes a yielded book later in the run', async () => {
    const { service, repo, queue, indexer, finished } = setup();
    queue.claimNext.mockResolvedValueOnce(claimFor(1)).mockResolvedValueOnce(claimFor(1)).mockResolvedValueOnce(null);
    indexer.indexBook.mockImplementationOnce(async (claim: EditionSyncClaim, options: { shouldYield(): Promise<boolean> }) => {
      repo.hasUpstreamActiveJobs.mockResolvedValueOnce(true);
      expect(await options.shouldYield()).toBe(true);
      return outcome(claim, 'yielded');
    });

    await service.startManualRun();
    await finished();

    expect(queue.claimNext).toHaveBeenNthCalledWith(2, { pinnedOnly: false, excludeBookIds: [] });
    expect(repo.finishRun).toHaveBeenCalledWith(5, expect.objectContaining({ stopReason: 'empty', booksIndexed: 1 }));
  });

  it('does not claim a failed book again in the same run', async () => {
    const { service, repo, queue, indexer, finished } = setup();
    queue.claimNext.mockResolvedValueOnce(claimFor(1)).mockResolvedValueOnce(null);
    indexer.indexBook.mockImplementationOnce((claim: EditionSyncClaim) => Promise.resolve(outcome(claim, 'failed')));

    await service.startManualRun();
    await finished();

    expect(queue.claimNext).toHaveBeenLastCalledWith({ pinnedOnly: false, excludeBookIds: [1] });
    expect(repo.finishRun).toHaveBeenCalledWith(5, expect.objectContaining({ booksFailed: 1 }));
  });

  it('ends the run when the worker is unavailable', async () => {
    const { service, repo, workerClient, indexer, finished } = setup();
    workerClient.healthState.mockResolvedValue({ state: 'unreachable' });

    await service.startManualRun();
    await finished();

    expect(indexer.indexBook).not.toHaveBeenCalled();
    expect(repo.finishRun).toHaveBeenCalledWith(5, expect.objectContaining({ stopReason: 'worker_unavailable' }));
  });

  it('cancels a leftover index job of ours still running on the worker', async () => {
    const { service, repo, workerClient, queue, finished } = setup();
    workerClient.healthState
      .mockResolvedValueOnce({ state: 'ok', health: { ...okHealth.health, activeJobId: 'old-job', activeJobs: 1 } })
      .mockResolvedValue(okHealth);
    repo.findIndexRowByWorkerJobId.mockResolvedValueOnce({ bookId: 4 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    await service.startManualRun();
    await vi.waitFor(() => expect(workerClient.cancel).toHaveBeenCalledWith('old-job'));
    await vi.advanceTimersByTimeAsync(EDITION_SYNC_UPSTREAM_WAIT_MS);
    await finished();

    expect(queue.claimNext).toHaveBeenCalled();
  });

  it('persists the scheduled window when cron widens a toggle run', async () => {
    const { service, repo } = setup();
    const run = { id: 5, trigger: 'toggle', pinnedOnly: true, stopRequested: false, windowUntil: null };
    const internal = service as unknown as { run: typeof run; onCronTick(): void };
    internal.run = run;
    internal.onCronTick();
    await vi.waitFor(() => expect(repo.widenRun).toHaveBeenCalledWith(5, expect.any(Date)));
    expect(run).toMatchObject({ trigger: 'scheduled', pinnedOnly: false, windowUntil: expect.any(Date) });
  });

  it('stop cancels the current worker job and ends the run as stopped', async () => {
    const { service, repo, queue, indexer, finished } = setup();
    queue.claimNext.mockResolvedValue(claimFor(1));
    let finish: (value: EditionSyncIndexOutcome) => void = () => undefined;
    indexer.indexBook.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    indexer.cancelCurrent.mockImplementationOnce(() => {
      finish(outcome(claimFor(1), 'cancelled'));
      return Promise.resolve();
    });

    await service.startManualRun();
    await vi.waitFor(() => expect(indexer.indexBook).toHaveBeenCalled());
    await service.stop();
    await finished();

    expect(indexer.cancelCurrent).toHaveBeenCalled();
    expect(repo.clearPin).toHaveBeenCalledWith(1);
    expect(repo.finishRun).toHaveBeenCalledWith(5, expect.objectContaining({ stopReason: 'stopped' }));
  });

  it('registers the cron job in the system time zone and removes it for Never', () => {
    const { service, registry } = setup();
    expect(service.syncSchedule('0 2 * * *')).toBe(true);
    expect(registry.doesExist('cron', EDITION_SYNC_CRON_JOB_NAME)).toBe(true);
    expect(service.nextRunAt()).toBeInstanceOf(Date);
    expect(service.syncSchedule(null)).toBe(true);
    expect(registry.doesExist('cron', EDITION_SYNC_CRON_JOB_NAME)).toBe(false);
    expect(service.nextRunAt()).toBeNull();
    service.onModuleDestroy();
  });

  it('reports status with the current book and a backlog estimate', async () => {
    const { service, repo, queue, indexer } = setup();
    queue.claimNext.mockResolvedValueOnce(claimFor(1));
    repo.findIndexRow.mockResolvedValue({ stage: 'aligning', progress: 63 });
    let finish: (value: EditionSyncIndexOutcome) => void = () => undefined;
    indexer.indexBook.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));

    await service.startManualRun();
    await vi.waitFor(() => expect(indexer.indexBook).toHaveBeenCalled());
    const status = await service.getAdminStatus();

    expect(status.run).toMatchObject({
      active: true,
      trigger: 'manual',
      current: { bookId: 1, title: 'Edgedancer', stage: 'aligning', progress: 63 },
    });
    expect(status.backlogEstimate).toEqual({ books: 4, hoursAtRecentRate: 4 });
    expect(status.worker).toMatchObject({ configured: true, state: 'ok', rebuildSupported: false });
    finish(outcome(claimFor(1), 'ready'));
  });

  it('closes interrupted runs and rows on boot and registers the saved schedule', async () => {
    const { service, repo, registry } = setup({ cron: '0 2 * * *' });
    await service.onApplicationBootstrap();
    expect(repo.endInterruptedRuns).toHaveBeenCalled();
    expect(repo.markInterruptedRows).toHaveBeenCalled();
    expect(registry.doesExist('cron', EDITION_SYNC_CRON_JOB_NAME)).toBe(true);
    service.onModuleDestroy();
  });
  it('defers pinned runs while the worker is down and logs once per state', async () => {
    const { service, repo, workerClient, finished } = setup();
    const log = vi.spyOn(Logger.prototype, 'log');
    repo.findNextQueuedBook.mockResolvedValue({ bookId: 3, pinned: true });
    workerClient.healthState.mockResolvedValue({ state: 'unreachable' });
    await service.tick();
    await service.tick();
    await service.tick();
    expect(repo.createRun).not.toHaveBeenCalled();
    expect(log.mock.calls.filter(([message]) => String(message).includes('skipped=worker_unavailable'))).toHaveLength(1);
    workerClient.healthState.mockResolvedValue(okHealth);
    await service.tick();
    await finished();
    expect(repo.createRun).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
  it('passes a stop received during a claim to the indexer', async () => {
    const { service, queue, indexer, finished } = setup();
    let release: (claim: EditionSyncClaim) => void = () => undefined;
    queue.claimNext.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    await service.startManualRun();
    await vi.waitFor(() => expect(queue.claimNext).toHaveBeenCalled());
    await service.stop();
    release(claimFor(1));
    await finished();
    const options = indexer.indexBook.mock.calls[0]?.[1] as unknown as { shouldStop(): boolean };
    expect(options.shouldStop()).toBe(true);
  });
});

describe('files changed scheduling', () => {
  it.each(['next_run', 'immediate'] as const)('queues changed files only in immediate mode: %s', async (onFilesChanged) => {
    const { service, repo } = setup({ onFilesChanged });
    const before = Date.now();
    await service.tick();
    if (onFilesChanged === 'immediate') {
      expect(repo.pinFilesChangedBooks).toHaveBeenCalledWith(expect.any(Date), 20);
      const cutoff = repo.pinFilesChangedBooks.mock.calls[0]![0] as Date;
      expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 600_000);
      expect(cutoff.getTime()).toBeLessThanOrEqual(Date.now() - 600_000);
    } else expect(repo.pinFilesChangedBooks).not.toHaveBeenCalled();
    expect((await service.getAdminStatus()).schedule.onFilesChanged).toBe(onFilesChanged);
  });
});

it('logs pin duration and isolates pin failures from recheck failures', async () => {
  const { service, repo, queue } = setup({ onFilesChanged: 'immediate' });
  const log = vi.spyOn(Logger.prototype, 'log');
  const error = vi.spyOn(Logger.prototype, 'error');
  repo.findBooksNeedingRecheck.mockResolvedValue([7]);
  await service.tick();
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/\[edition_sync.files_changed\] \[end\] durationMs=\d+ pinned=2/));
  log.mockClear();
  repo.pinFilesChangedBooks.mockResolvedValueOnce(0);
  await service.tick();
  expect(log.mock.calls.some(([message]) => String(message).includes('[edition_sync.files_changed]'))).toBe(false);
  repo.pinFilesChangedBooks.mockRejectedValue(new Error('bad "pin"\nline'));
  await service.tick();
  expect(queue.ensureValid).toHaveBeenCalledTimes(3);
  expect(error).toHaveBeenCalledWith(expect.stringMatching(/\[edition_sync.files_changed\] \[fail\] durationMs=\d+ errorClass=Error error="bad/));
  expect(error.mock.calls.some(([message]) => String(message).includes('[edition_sync.recheck]'))).toBe(false);
  log.mockRestore();
  error.mockRestore();
});

it('shares one time budget across the batch and defers rows after ten seconds', async () => {
  vi.useFakeTimers();
  try {
    const { service, repo, queue } = setup();
    const started = Date.now();
    repo.findBooksNeedingRecheck.mockResolvedValue([1, 2, 3, 4]);
    const rows = {
      findIndexRow: vi.fn().mockResolvedValue({ status: 'ready', provenance: {} }),
      flagRecheck: vi.fn(),
      markStale: vi.fn(),
    };
    vi.mocked(checkEditionSyncSources).mockResolvedValue({ valid: false, reason: 'epub_changed', canCheckContent: true });
    const store = {
      checkContent: vi.fn().mockImplementation(() => {
        vi.setSystemTime(Date.now() + 5000);
        return Promise.resolve('metadata_only');
      }),
    };
    const realQueue = new EditionSyncQueueService(rows as never, store as never, {} as never, { invalidateBook: vi.fn() } as never);
    queue.ensureValid.mockImplementation(realQueue.ensureValid.bind(realQueue) as never);
    await service.tick();
    const budgets = queue.ensureValid.mock.calls.map((call) => (call as unknown[])[1]);
    expect(budgets).toHaveLength(4);
    expect(budgets.every((budget) => budget === budgets[0])).toBe(true);
    expect(budgets[0]).toEqual({ deadline: started + 10_000 });
    expect(store.checkContent.mock.calls.map((call) => call[0])).toEqual([1, 2]);
    expect(rows.flagRecheck.mock.calls.map((call) => call[0])).toEqual([3, 4]);
    expect(rows.markStale).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
