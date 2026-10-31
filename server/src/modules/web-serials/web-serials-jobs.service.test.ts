import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { ADMIN, jobRow, mangaSeries, setupServices, USER } from '../../../test/support/web-serials/web-serials-test-fixtures';

vi.mock('./web-serials-engine-registry.service', () => ({ WebSerialsEngineRegistry: class {} }));
vi.mock('./web-serials-cover.service', () => ({ WebSerialsCoverService: class {} }));
vi.mock('./web-serials-settings.service', () => ({ WebSerialsSettingsService: class {} }));
vi.mock('./web-serials-job-runner.service', () => ({ WebSerialsJobRunnerService: class {} }));
vi.mock('./web-serials-import.service', () => ({ WebSerialsImportService: class {} }));
vi.mock('./lookup/web-serials-lookup.service', () => ({
  WebSerialsLookupService: class {},
  normalizeTitle: (value: string) =>
    value
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .replace(/[\p{P}\p{S}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
}));
vi.mock('../library/library.service', () => ({ LibraryService: class {} }));

function setup(options: Parameters<typeof setupServices>[0] = {}) {
  const ctx = setupServices(options);
  return { ...ctx, service: ctx.jobs };
}

describe('WebSerialJobsService createJob', () => {
  const input = { seriesKey: 'm:1', packaging: 'chapter' as const, selection: { mode: 'all' as const }, libraryId: 3 };

  it('creates a queued job scoped to the user and the admin default folder', async () => {
    const { service, repo, libraryService } = setup();

    const job = await service.createJob(input, USER);

    expect(libraryService.verifyUserAccess).toHaveBeenCalledWith(7, 3, false);
    expect(repo.createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 7,
        kind: 'manga',
        seriesKey: 'm:1',
        packaging: 'chapter',
        skipImported: true,
        targetLibraryId: 3,
        targetFolderId: 30,
        engineState: expect.objectContaining({ hasCover: true, units: mangaSeries.units }),
        metadata: {},
      }),
    );
    expect(job).toMatchObject({
      id: 11,
      coverUrl: '/api/v1/web-serials/series/m:1/cover',
      libraryName: 'Manga',
      createdAt: '2026-10-13T10:00:00.000Z',
    });
  });

  it('falls back to the first library folder for another library', async () => {
    const { service, repo } = setup();

    await service.createJob({ ...input, libraryId: 9 }, USER);

    expect(repo.createJob).toHaveBeenCalledWith(expect.objectContaining({ targetLibraryId: 9, targetFolderId: 20 }));
  });

  it('rejects a library the user cannot reach before any engine call', async () => {
    const { service, libraryService, client } = setup();
    libraryService.verifyUserAccess.mockRejectedValue(new ForbiddenException('No access to this library'));

    await expect(service.createJob(input, USER)).rejects.toBeInstanceOf(ForbiddenException);
    expect(client.getSeries).not.toHaveBeenCalled();
  });

  it('rejects packaging that does not match the kind', async () => {
    const { service } = setup();

    await expect(service.createJob({ ...input, packaging: 'volume' }, USER)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.createJob({ ...input, seriesKey: 'n:abc', packaging: 'chapter' }, USER)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('stores volume grouping from source and lookup data on the job', async () => {
    const { service, repo, lookupService } = setup();
    mangaSeries.units[0]!.volume = '1';
    lookupService.lookup.mockResolvedValue({ state: 'matched', match: null, message: null, chapterVolumes: { c2: '1' } });

    await service.createJob({ ...input, packaging: 'volume' }, USER);

    expect(repo.createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        packaging: 'volume',
        engineState: expect.objectContaining({
          units: [
            expect.objectContaining({
              unitKey: 'vol:1:1-2',
              packaging: 'volume',
              chapterRange: { from: 1, to: 2 },
              remote: { chapters: [{ chapterId: '1' }, { chapterId: '2' }] },
            }),
          ],
        }),
      }),
    );
    delete mangaSeries.units[0]!.volume;
  });

  it('allows a range for one manga book and rejects volume packaging without any known volumes', async () => {
    const { service } = setup();

    await expect(
      service.createJob({ ...input, packaging: 'series', selection: { mode: 'range', fromSequence: '1', toSequence: '2' } }, USER),
    ).resolves.toBeDefined();
    await expect(service.createJob({ ...input, packaging: 'volume' }, USER)).rejects.toThrow("Volume information isn't available");
  });

  it('rejects a library that does not allow the format, an unknown folder and an empty range', async () => {
    const restricted = setup({ library: { allowedFormats: ['epub'] } });
    await expect(restricted.service.createJob(input, USER)).rejects.toThrow('cbz');

    const { service } = setup();
    await expect(service.createJob({ ...input, folderId: 99 }, USER)).rejects.toThrow('Folder does not belong');
    await expect(service.createJob({ ...input, selection: { mode: 'range', fromSequence: '50', toSequence: '60' } }, USER)).rejects.toThrow(
      'Nothing to download',
    );
    await expect(service.createJob({ ...input, selection: { mode: 'range', fromSequence: '5', toSequence: '1' } }, USER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses a lightnovel-crawler book of part of a novel, which would hold every volume it ever fetched', async () => {
    const { service, repo } = setup();

    const refused = await service
      .createJob({ ...input, seriesKey: 'n:abc', packaging: 'series', selection: { mode: 'list', sequences: ['1'] } }, USER)
      .catch((error: unknown) => error);
    expect((refused as BadRequestException).getResponse()).toMatchObject({ errorCode: 'WEB_SERIAL_RANGE_NEEDS_VOLUMES' });
    expect(repo.createJob).not.toHaveBeenCalled();
  });

  it('refuses a series address too long to store with its own code, before anything else', async () => {
    const { service, repo, client } = setup();

    const refused = await service.createJob({ ...input, seriesKey: `nl:src:${'a'.repeat(1100)}` }, USER).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(BadRequestException);
    expect((refused as BadRequestException).getResponse()).toMatchObject({ errorCode: 'WEB_SERIAL_SERIES_KEY_TOO_LONG' });
    expect(client.getSeries).not.toHaveBeenCalled();
    expect(repo.createJob).not.toHaveBeenCalled();
  });

  it('refuses to resume a paused job while the owner already has the most active downloads', async () => {
    const { service, repo } = setup();
    repo.findJobById.mockResolvedValue(jobRow({ status: 'paused' }));
    repo.countActiveJobs.mockResolvedValue(25);

    const refused = await service.resumeJob(11, USER).catch((error: unknown) => error);
    expect((refused as BadRequestException).getResponse()).toMatchObject({ errorCode: 'WEB_SERIAL_TOO_MANY_JOBS' });
    expect(repo.countActiveJobs).toHaveBeenCalledWith(7);
    expect(repo.resumeJob).not.toHaveBeenCalled();
  });

  it('refuses to retry a failed job or one of its items while the owner already has the most downloads', async () => {
    const { service, repo } = setup();
    repo.findJobById.mockResolvedValue(jobRow({ status: 'failed' }));
    repo.countCappedJobsForUser.mockResolvedValue(25);

    for (const retry of [() => service.retryJob(11, USER), () => service.retryItem(11, 5, USER)]) {
      const refused = await retry().catch((error: unknown) => error);
      expect((refused as BadRequestException).getResponse()).toMatchObject({ errorCode: 'WEB_SERIAL_TOO_MANY_JOBS', errorMeta: { limit: 25 } });
      expect((refused as BadRequestException).message).toContain('paused');
    }
    expect(repo.countCappedJobsForUser).toHaveBeenCalledWith(7);
    expect(repo.requeueForRetry).not.toHaveBeenCalled();
    expect(repo.retryItem).not.toHaveBeenCalled();
  });

  it('retries an item of a running job without counting it against the cap', async () => {
    const { service, repo } = setup();
    repo.findJobById.mockResolvedValue(jobRow({ status: 'running' }));
    repo.countCappedJobsForUser.mockResolvedValue(25);

    await service.retryItem(11, 5, USER);
    expect(repo.retryItem).toHaveBeenCalledWith(11, 5);
  });

  it('caps the active and paused jobs per user', async () => {
    const { service, repo } = setup();
    repo.countCappedJobsForUser.mockResolvedValue(25);

    const refused = await service.createJob(input, USER).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(BadRequestException);
    expect((refused as BadRequestException).getResponse()).toMatchObject({ errorCode: 'WEB_SERIAL_TOO_MANY_JOBS', errorMeta: { limit: 25 } });
    expect(repo.createJob).not.toHaveBeenCalled();
  });

  it('stores a resolved match snapshot and the final authors on the job', async () => {
    const { service, repo, lookupService } = setup();
    const match = {
      provider: 'mangabaka',
      id: '1995',
      title: 'Canonical Saga',
      url: 'https://mangabaka.org/1995',
      year: 2020,
      authors: ['Matched Author'],
      artists: ['Matched Artist'],
      status: 'ongoing',
      genres: ['Fantasy'],
    };
    lookupService.getMatch.mockResolvedValue(match);

    await service.createJob({ ...input, metadata: { matchId: '1995', authors: ['Chosen Author'] } }, USER);

    expect(lookupService.getMatch).toHaveBeenCalledWith('1995', 'manga');
    expect(repo.createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        author: 'Chosen Author',
        metadata: { override: { matchId: '1995', authors: ['Chosen Author'] }, match },
      }),
    );
  });

  it('keeps the override and creates the job when match resolution is unavailable', async () => {
    const { service, repo, lookupService } = setup();
    lookupService.getMatch.mockResolvedValue(null);

    await service.createJob({ ...input, metadata: { matchId: '1995' } }, USER);

    expect(repo.createJob).toHaveBeenCalledWith(expect.objectContaining({ author: 'A. Writer', metadata: { override: { matchId: '1995' } } }));
  });
});

describe('WebSerialJobsService job management', () => {
  it('lists the users own jobs with the active count and the queue pause flag', async () => {
    const { service, repo, settings } = setup();
    repo.countActiveJobs.mockResolvedValue(2);
    settings.isQueuePaused.mockResolvedValue(true);

    const result = await service.listJobs(USER, 'mine', 20, 0);

    expect(repo.listJobs).toHaveBeenCalledWith(7, 20, 0);
    expect(repo.countActiveJobs).toHaveBeenCalledWith(7);
    expect(result).toMatchObject({ activeCount: 2, queuePaused: true });
    expect(result.items[0]).toMatchObject({ id: 11, current: null, queuePosition: null, owner: null });
  });

  it('reports how many jobs exist and how many of them are finished', async () => {
    const { service, repo } = setup();
    repo.countJobs.mockResolvedValue({ total: 120, finishedCount: 90 });

    const result = await service.listJobs(USER, 'mine', 20, 0);

    expect(repo.countJobs).toHaveBeenCalledWith(7);
    expect(result).toMatchObject({ total: 120, finishedCount: 90 });
  });

  it('shows the whole instance with owners to an admin only', async () => {
    const { service, repo } = setup();

    const result = await service.listJobs(ADMIN, 'all', 20, 0);

    expect(repo.listJobs).toHaveBeenCalledWith(null, 20, 0);
    expect(repo.countActiveJobs).toHaveBeenCalledWith(null);
    expect(result.items[0]!.owner).toEqual({ id: 7, name: 'Ann' });
    await expect(service.listJobs(USER, 'all')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.clearFinished(USER, 'all')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('maps the stored current unit and queue position onto the job', async () => {
    const { service, repo } = setup();
    const current = { label: 'Overgeared', stage: 'fetching', chaptersDone: 1651, chaptersTotal: 2082, progress: 0.79 };
    repo.listJobs.mockResolvedValue([jobRow({ currentUnit: current, queuePosition: 3 })]);

    const result = await service.listJobs(USER, 'mine', 20, 0);

    expect(result.items[0]!.current).toEqual(current);
    expect(result.items[0]!.queuePosition).toBe(3);
  });

  it("refuses every action on another user's job unless the caller is an admin", async () => {
    const { service, move, repo } = setup();
    repo.findJobById.mockResolvedValue(jobRow({ userId: 8 }));

    const actions = [
      () => service.cancelJob(11, USER),
      () => service.retryJob(11, USER),
      () => service.pauseJob(11, USER),
      () => service.resumeJob(11, USER),
      () => service.moveJobToTop(11, USER),
      () => service.removeJob(11, USER),
      () => service.getJobDetail(11, USER),
      () => service.retryItem(11, 5, USER),
      () => move.getMoveCandidates(11, USER),
      () => move.moveJob(11, { seriesKey: 'm:2' }, USER),
    ];
    for (const action of actions) await expect(action()).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.cancelJob).not.toHaveBeenCalled();
    expect(repo.requeueForRetry).not.toHaveBeenCalled();
    expect(repo.pauseJob).not.toHaveBeenCalled();
    expect(repo.deleteFinishedJob).not.toHaveBeenCalled();
    expect(repo.retryItem).not.toHaveBeenCalled();

    await expect(service.pauseJob(11, ADMIN)).resolves.toMatchObject({ id: 11, owner: { id: 8, name: 'Ann' } });
  });

  it('reports a missing job as not found', async () => {
    const { service, repo } = setup();
    repo.findJobById.mockResolvedValue(undefined);

    await expect(service.cancelJob(11, USER)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getJobDetail(11, USER)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('cancels through the repository once ownership is verified', async () => {
    const { service, repo } = setup();

    await service.cancelJob(11, USER);

    expect(repo.cancelJob).toHaveBeenCalledWith(11);
  });

  it('stops the running downloads of a cancelled job and removes its work folder once it settled', async () => {
    const { service, runner, importer } = setup();

    await service.cancelJob(11, USER);

    expect(runner.abortJob).toHaveBeenCalledWith(11);
    expect(importer.removeJobWorkDir).toHaveBeenCalledWith(11);
  });

  it('leaves the work folder to the runner when a cancelled job has not settled yet', async () => {
    const { service, runner, importer } = setup();
    runner.waitForJobToSettle.mockResolvedValue(false);

    await service.cancelJob(11, USER);

    expect(importer.removeJobWorkDir).not.toHaveBeenCalled();
  });

  it('removes the work folder of a removed job', async () => {
    const { service, repo, importer } = setup();
    repo.findJobById.mockResolvedValue(jobRow({ status: 'completed' }));

    await expect(service.removeJob(11, USER)).resolves.toBeUndefined();

    expect(importer.removeJobWorkDir).toHaveBeenCalledWith(11);
  });

  it('refuses to retry an item of a cancelled job with a clear message', async () => {
    const { service, repo } = setup();
    repo.findJobById.mockResolvedValue(jobRow({ status: 'cancelled' }));

    await expect(service.retryItem(11, 5, USER)).rejects.toThrow('This download was cancelled');
    expect(repo.retryItem).not.toHaveBeenCalled();
  });

  it('refuses to retry a job that is not failed or gapped', async () => {
    const { service, repo } = setup();
    repo.requeueForRetry.mockResolvedValue(false);

    await expect(service.retryJob(11, USER)).rejects.toBeInstanceOf(ConflictException);
  });

  it('stops the in-flight fetch of a paused job at once, and leaves a job that could not be paused alone', async () => {
    const { service, repo, runner, importer } = setup();

    await service.pauseJob(11, USER);
    expect(runner.interruptChapterFetch).toHaveBeenCalledWith(11);
    expect(runner.abortJob).not.toHaveBeenCalled();
    expect(importer.removeJobWorkDir).not.toHaveBeenCalled();

    runner.interruptChapterFetch.mockClear();
    repo.pauseJob.mockResolvedValue(undefined);
    const refused = await service.pauseJob(11, USER).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ConflictException);
    expect((refused as ConflictException).getResponse()).toMatchObject({ errorCode: 'WEB_SERIAL_JOB_PAUSE_NOT_ALLOWED' });
    expect(runner.interruptChapterFetch).not.toHaveBeenCalled();
  });

  it('pauses, resumes and moves a job, and conflicts when the state does not allow it', async () => {
    const { service, repo } = setup();

    await service.pauseJob(11, USER);
    await service.resumeJob(11, USER);
    await service.moveJobToTop(11, USER);
    expect(repo.pauseJob).toHaveBeenCalledWith(11);
    expect(repo.resumeJob).toHaveBeenCalledWith(11);
    expect(repo.moveJobToTop).toHaveBeenCalledWith(11, USER.id);

    repo.pauseJob.mockResolvedValue(undefined);
    repo.resumeJob.mockResolvedValue(undefined);
    repo.moveJobToTop.mockResolvedValue(undefined);
    await expect(service.pauseJob(11, USER)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.resumeJob(11, USER)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.moveJobToTop(11, USER)).rejects.toBeInstanceOf(ConflictException);
  });

  it('removes only finished jobs and tells the caller to cancel an active or paused one first', async () => {
    const { service, repo } = setup();

    for (const status of ['queued', 'running', 'importing', 'paused']) {
      repo.findJobById.mockResolvedValue(jobRow({ status }));
      await expect(service.removeJob(11, USER)).rejects.toThrow('Cancel it first.');
    }
    expect(repo.deleteFinishedJob).not.toHaveBeenCalled();

    repo.findJobById.mockResolvedValue(jobRow({ status: 'completed' }));
    await expect(service.removeJob(11, USER)).resolves.toBeUndefined();
    expect(repo.deleteFinishedJob).toHaveBeenCalledWith(11);
  });

  it('clears the callers finished jobs, or everyones for an admin asking for all', async () => {
    const { service, repo, importer } = setup();

    await expect(service.clearFinished(USER)).resolves.toEqual({ removed: 3 });
    expect(repo.clearFinishedJobs).toHaveBeenLastCalledWith(7);
    expect(importer.removeJobWorkDir.mock.calls.map((call) => call[0])).toEqual([21, 22, 23]);
    await service.clearFinished(ADMIN, 'mine');
    expect(repo.clearFinishedJobs).toHaveBeenLastCalledWith(1);
    await service.clearFinished(ADMIN, 'all');
    expect(repo.clearFinishedJobs).toHaveBeenLastCalledWith(null);
  });

  it('returns the job with its items ordered and owner-free for its own user', async () => {
    const { service, repo } = setup();
    repo.findItemsForDetail.mockResolvedValue([
      { id: 1, label: 'Chapter 1', sequence: '1', status: 'imported', error: null, bookId: 9, updatedAt: new Date('2026-10-13T10:00:00Z') },
      {
        id: 2,
        label: 'Chapter 2',
        sequence: '2',
        status: 'failed',
        error: 'Chapter 2: gone',
        bookId: null,
        updatedAt: new Date('2026-10-13T10:01:00Z'),
      },
    ]);

    const detail = await service.getJobDetail(11, USER);

    expect(detail.job).toMatchObject({ id: 11, owner: null });
    expect(detail.items).toEqual([
      { id: 1, label: 'Chapter 1', sequence: '1', status: 'imported', error: null, bookId: 9, updatedAt: '2026-10-13T10:00:00.000Z' },
      { id: 2, label: 'Chapter 2', sequence: '2', status: 'failed', error: 'Chapter 2: gone', bookId: null, updatedAt: '2026-10-13T10:01:00.000Z' },
    ]);
  });

  it('retries one failed item and returns the refreshed detail, or conflicts when it is not failed', async () => {
    const { service, repo } = setup();

    await expect(service.retryItem(11, 2, USER)).resolves.toMatchObject({ job: { id: 11 } });
    expect(repo.retryItem).toHaveBeenCalledWith(11, 2);

    repo.retryItem.mockResolvedValue(false);
    await expect(service.retryItem(11, 2, USER)).rejects.toBeInstanceOf(ConflictException);
  });

  it('pauses and resumes the whole queue through the settings', async () => {
    const { service, settings } = setup();

    await expect(service.pauseQueue(ADMIN)).resolves.toEqual({ queuePaused: true });
    expect(settings.setQueuePaused).toHaveBeenLastCalledWith(true, ADMIN);
    await expect(service.resumeQueue(ADMIN)).resolves.toEqual({ queuePaused: false });
    expect(settings.setQueuePaused).toHaveBeenLastCalledWith(false, ADMIN);
  });
});

describe('WebSerialJobsService selection mapping', () => {
  const base = { seriesKey: 'm:1', packaging: 'chapter' as const, libraryId: 3 };

  it('maps a range and a list request body to the selection the job stores', async () => {
    const range = setup();
    await range.service.createJob({ ...base, selection: { mode: 'range', fromSequence: '1', toSequence: '2' } }, USER);
    expect(range.repo.createJob).toHaveBeenCalledWith(expect.objectContaining({ selection: { mode: 'range', fromSequence: '1', toSequence: '2' } }));

    const list = setup();
    await list.service.createJob({ ...base, selection: { mode: 'list', sequences: ['2'] } }, USER);
    expect(list.repo.createJob).toHaveBeenCalledWith(expect.objectContaining({ selection: { mode: 'list', sequences: ['2'] } }));
  });

  it('refuses a range or list whose fields are missing instead of asserting them present', async () => {
    const { service, repo } = setup();

    await expect(service.createJob({ ...base, selection: { mode: 'range', fromSequence: '1' } }, USER)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.createJob({ ...base, selection: { mode: 'list' } }, USER)).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.createJob).not.toHaveBeenCalled();
  });
});

it.each([ADMIN, { ...USER, isSuperuser: true }])('allows global priority for an administrator', async (user) => {
  const { service, repo } = setup();
  await service.moveJobToTop(11, user);
  expect(repo.moveJobToTop).toHaveBeenCalledWith(11, null);
});
