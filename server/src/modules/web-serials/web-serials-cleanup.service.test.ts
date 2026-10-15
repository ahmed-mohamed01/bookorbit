import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WebSerialsCleanupService } from './web-serials-cleanup.service';

const importer = (ids: number[] = []) => ({
  listWorkJobIds: vi.fn().mockResolvedValue(ids),
  removeJobWorkDir: vi.fn().mockResolvedValue(undefined),
});
const runner = (active: number[] = []) => ({ isJobActive: vi.fn((id: number) => active.includes(id)) });

describe('WebSerialsCleanupService', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('removes finished jobs older than 14 days and logs start and end', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
    const repo = { deleteFinishedJobsBefore: vi.fn().mockResolvedValue(4) };

    await expect(new WebSerialsCleanupService(repo as never, importer() as never, runner() as never).cleanupFinishedJobs()).resolves.toBe(4);

    const cutoff = repo.deleteFinishedJobsBefore.mock.calls[0]![0] as Date;
    expect(cutoff.toISOString()).toBe('2026-09-30T12:00:00.000Z');
    expect(logSpy.mock.calls.map((call) => call[0] as string)).toEqual([
      expect.stringContaining('[web_serials.job.cleanup] [start] retentionDays=14'),
      expect.stringContaining('[web_serials.job.cleanup] [end] retentionDays=14'),
    ]);
    expect(logSpy.mock.calls[1]![0]).toContain('removed=4');
  });

  it('logs a failure instead of throwing out of the schedule', async () => {
    const repo = { deleteFinishedJobsBefore: vi.fn().mockRejectedValue(new Error('db "down"')) };

    await expect(new WebSerialsCleanupService(repo as never, importer() as never, runner() as never).cleanupFinishedJobs()).resolves.toBe(0);

    const message = errorSpy.mock.calls[0]![0] as string;
    expect(message).toContain('[web_serials.job.cleanup] [fail]');
    expect(message).toContain('errorClass=Error');
    expect(message).not.toContain('"down"');
  });

  it('removes work folders of completed, cancelled or deleted jobs and keeps those a job or a Retry can still resume or a run is using', async () => {
    const repo = { findJobIdsKeepingWorkDirs: vi.fn().mockResolvedValue([2]) };
    const files = importer([1, 2, 3, 4]);

    const removed = await new WebSerialsCleanupService(repo as never, files as never, runner([3]) as never).sweepWorkDirs();

    expect(repo.findJobIdsKeepingWorkDirs).toHaveBeenCalledWith([1, 2, 3, 4]);
    expect(files.removeJobWorkDir.mock.calls.map((call) => call[0])).toEqual([1, 4]);
    expect(removed).toBe(2);
  });

  it('does not touch the database when there are no work folders', async () => {
    const repo = { findJobIdsKeepingWorkDirs: vi.fn() };

    await expect(new WebSerialsCleanupService(repo as never, importer() as never, runner() as never).sweepWorkDirs()).resolves.toBe(0);
    expect(repo.findJobIdsKeepingWorkDirs).not.toHaveBeenCalled();
  });

  it('sweeps work folders after deleting old finished jobs', async () => {
    const repo = { deleteFinishedJobsBefore: vi.fn().mockResolvedValue(1), findJobIdsKeepingWorkDirs: vi.fn().mockResolvedValue([]) };
    const files = importer([5]);

    await new WebSerialsCleanupService(repo as never, files as never, runner() as never).cleanupFinishedJobs();

    expect(files.removeJobWorkDir).toHaveBeenCalledWith(5);
  });

  it('logs a sweep failure instead of throwing', async () => {
    const files = importer();
    files.listWorkJobIds.mockRejectedValue(new Error('disk "gone"'));

    await expect(new WebSerialsCleanupService({} as never, files as never, runner() as never).sweepWorkDirs()).resolves.toBe(0);
    expect(errorSpy.mock.calls[0]![0]).toContain('[web_serials.workdir.sweep] [fail]');
  });
});
