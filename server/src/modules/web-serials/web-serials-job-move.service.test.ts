/* eslint-disable @typescript-eslint/require-await */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { ADMIN, CONN, jobRow, mangaSeries, setupServices, USER } from '../../../test/support/web-serials/web-serials-test-fixtures';

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
  return { ...ctx, service: ctx.move };
}

describe('WebSerialJobMoveService move candidates', () => {
  const remaining = [
    { id: 1, sequence: '1', status: 'pending' },
    { id: 2, sequence: '2', status: 'fetching' },
    { id: 3, sequence: '3.0', status: 'failed' },
  ];

  it('finds the same matched series on other sources and counts numeric chapter coverage', async () => {
    const { service, repo, client, lookupService, engines } = setup();
    repo.findJobById.mockResolvedValue(jobRow({ metadata: { override: { matchId: '1995' }, match: { id: '1995', title: 'Canonical Saga' } } }));
    repo.findMoveItems.mockResolvedValue(remaining);
    client.search.mockResolvedValue({
      hits: [
        { remoteId: '1', title: 'Canonical Saga', author: null, remoteCoverPath: null, sourceName: 'MangaSource' },
        { remoteId: '2', title: 'Alt Saga', author: 'A', remoteCoverPath: '/alt', sourceName: 'AllManga' },
        { remoteId: '3', title: 'Wrong Saga', author: null, remoteCoverPath: null, sourceName: 'Other' },
      ],
      failedSources: ['SlowSource'],
    });
    lookupService.findMatch.mockImplementation(async (_kind: string, title: string) => ({ id: title === 'Alt Saga' ? '1995' : '999' }));
    client.getSeries.mockResolvedValue({
      ...mangaSeries,
      title: 'Alt Saga',
      sourceName: 'AllManga',
      units: [
        { ...mangaSeries.units[0]!, sequence: '01.0' },
        { ...mangaSeries.units[1]!, sequence: '3' },
      ],
    });

    await expect(service.getMoveCandidates(11, USER)).resolves.toEqual({
      remainingTotal: 3,
      candidates: [
        {
          seriesKey: 'm:2',
          title: 'Alt Saga',
          sourceName: 'AllManga',
          coverUrl: '/api/v1/web-serials/series/m:2/cover',
          confidence: 'same_series',
          remainingAvailable: 2,
          remainingTotal: 3,
        },
      ],
      failedSources: ['SlowSource'],
    });
    expect(client.search).toHaveBeenCalledWith(CONN, 'Canonical Saga', ['en'], expect.any(AbortSignal));
    expect(lookupService.findMatch).toHaveBeenCalledTimes(2);
    expect(lookupService.lookup).not.toHaveBeenCalled();
    expect(engines.client).toHaveBeenCalledWith('manga');
  });

  it('uses normalized title confidence without a match and caps the best six', async () => {
    const { service, repo, client } = setup();
    repo.findMoveItems.mockResolvedValue(Array.from({ length: 7 }, (_, index) => ({ id: index + 1, sequence: String(index + 1), status: 'failed' })));
    client.search.mockResolvedValue({
      hits: Array.from({ length: 7 }, (_, index) => ({
        remoteId: String(index + 2),
        title: index === 0 ? 'Dúngéon Saga!' : 'Dungeon Saga',
        author: null,
        remoteCoverPath: null,
        sourceName: `Source ${index + 1}`,
      })),
      failedSources: [],
    });
    client.getSeries.mockImplementation(async (_conn: unknown, remoteId: string) => ({
      ...mangaSeries,
      sourceName: `Source ${remoteId}`,
      units: mangaSeries.units.concat(
        Array.from({ length: Number(remoteId) - 2 }, (_, index) => ({ ...mangaSeries.units[0]!, unitKey: `x${index}`, sequence: String(index + 3) })),
      ),
    }));

    const result = await service.getMoveCandidates(11, USER);

    expect(result.candidates).toHaveLength(6);
    expect(result.candidates[0]).toMatchObject({ confidence: 'title_match', remainingAvailable: 7 });
  });

  it('rejects novels and jobs with nothing remaining', async () => {
    const novel = setup();
    novel.repo.findJobById.mockResolvedValue(jobRow({ kind: 'novel', seriesKey: 'n:1' }));
    await expect(novel.service.getMoveCandidates(11, USER)).rejects.toThrow('Moving novels between sites is not supported yet.');

    const empty = setup();
    empty.repo.countItemsByStatus.mockResolvedValue({ imported: 2 });
    await expect(empty.service.getMoveCandidates(11, USER)).rejects.toThrow('Nothing left to move.');
  });
});

describe('WebSerialJobMoveService move job', () => {
  it('pauses and settles the source, marks moved and missing items, and preserves target job fields', async () => {
    const { service, repo, client, runner } = setup();
    const source = jobRow({
      status: 'running',
      metadata: { override: { matchId: '1995', authors: ['Chosen'], artists: ['Artist'] }, match: { id: '1995', title: 'Canonical' } },
    });
    repo.findJobById.mockImplementation(async (id: number) =>
      id === 22
        ? jobRow({ id: 22, seriesKey: 'm:2', sourceName: 'AllManga', status: 'queued', selection: { mode: 'list', sequences: ['1', '2'] } })
        : source,
    );
    repo.findMoveItems.mockResolvedValue([
      { id: 1, sequence: '1', status: 'pending' },
      { id: 2, sequence: '2.0', status: 'fetching' },
      { id: 3, sequence: '3', status: 'failed' },
    ]);
    repo.countItemsByStatus.mockResolvedValue({ pending: 1, failed: 1, imported: 2 });
    client.search.mockResolvedValue({
      hits: [{ remoteId: '2', title: 'Dungeon Saga', author: 'A', remoteCoverPath: '/two', sourceName: 'AllManga' }],
      failedSources: [],
    });
    client.getSeries.mockResolvedValue({ ...mangaSeries, sourceName: 'AllManga', sourceUrl: 'https://all/2' });

    const result = await service.moveJob(11, { seriesKey: 'm:2' }, USER);

    expect(repo.pauseJob).toHaveBeenCalledWith(11);
    expect(runner.interruptChapterFetch).toHaveBeenCalledWith(11);
    expect(runner.abortJob).not.toHaveBeenCalled();
    expect(runner.interruptChapterFetch.mock.invocationCallOrder[0]!).toBeLessThan(runner.waitForJobToSettle.mock.invocationCallOrder[0]!);
    expect(runner.waitForJobToSettle).toHaveBeenCalledWith(11, expect.any(Number));
    expect(runner.waitForJobToSettle.mock.calls[0]![1]).toBeLessThanOrEqual(15_000);
    expect(repo.hasInFlightItems).toHaveBeenCalledWith(11);
    expect(repo.moveJob).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceJobId: 11,
        sourceExpectedStatus: 'paused',
        movedItemIds: [1, 2],
        missingItemIds: [3],
        sourceMessage: 'Remaining chapters moved to AllManga.',
        movedError: 'Moved to AllManga.',
        missingError: 'Not available on AllManga.',
        targetJob: expect.objectContaining({
          userId: 7,
          seriesKey: 'm:2',
          seriesUrl: 'https://all/2',
          packaging: 'chapter',
          selection: { mode: 'list', sequences: ['1', '2.0'] },
          skipImported: true,
          targetLibraryId: 3,
          targetFolderId: 30,
          metadata: source.metadata,
        }),
      }),
    );
    expect(result).toMatchObject({ from: { id: 11 }, to: { id: 22, seriesKey: 'm:2' } });
  });

  it('materializes a queued job before moving it', async () => {
    const { service, repo, client } = setup();
    const source = jobRow({ status: 'queued' });
    repo.findJobById.mockImplementation(async (id: number) => (id === 22 ? jobRow({ id: 22, seriesKey: 'm:2' }) : source));
    repo.countItemsByStatus.mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockResolvedValue({ pending: 2 });
    repo.findMoveItems
      .mockResolvedValueOnce([
        { id: 10, sequence: '1', status: 'pending' },
        { id: 11, sequence: '2', status: 'pending' },
      ])
      .mockResolvedValueOnce([
        { id: 10, sequence: '1', status: 'pending' },
        { id: 11, sequence: '2', status: 'pending' },
      ]);
    client.search.mockResolvedValue({
      hits: [{ remoteId: '2', title: 'Dungeon Saga', author: null, remoteCoverPath: null, sourceName: 'AllManga' }],
      failedSources: [],
    });
    client.getSeries.mockResolvedValue({ ...mangaSeries, sourceName: 'AllManga' });

    await service.moveJob(11, { seriesKey: 'm:2' }, USER);

    expect(repo.insertItems).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ jobId: 11, sequence: '1' })]));
    expect(repo.moveJob).toHaveBeenCalledWith(expect.objectContaining({ sourceExpectedStatus: 'paused', movedItemIds: [10, 11] }));
  });

  it("allows an admin to move another user's job while preserving its owner", async () => {
    const { service, repo, client } = setup();
    const source = jobRow({ userId: 8, status: 'paused' });
    repo.findJobById.mockImplementation(async (id: number) =>
      id === 22 ? jobRow({ id: 22, userId: 8, seriesKey: 'm:2', sourceName: 'AllManga' }) : source,
    );
    repo.findMoveItems.mockResolvedValue([{ id: 1, sequence: '1', status: 'failed' }]);
    repo.countItemsByStatus.mockResolvedValue({ failed: 1 });
    client.search.mockResolvedValue({
      hits: [{ remoteId: '2', title: 'Dungeon Saga', author: null, remoteCoverPath: null, sourceName: 'AllManga' }],
      failedSources: [],
    });
    client.getSeries.mockResolvedValue({ ...mangaSeries, sourceName: 'AllManga' });

    await expect(service.moveJob(11, { seriesKey: 'm:2' }, ADMIN)).resolves.toMatchObject({
      from: { owner: { id: 8 } },
      to: { owner: { id: 8 } },
    });
    expect(repo.moveJob).toHaveBeenCalledWith(expect.objectContaining({ targetJob: expect.objectContaining({ userId: 8 }) }));
  });

  it('conflicts without changing items when the runner does not settle', async () => {
    const { service, repo, client, runner } = setup();
    repo.findJobById.mockResolvedValue(jobRow({ status: 'running' }));
    runner.waitForJobToSettle.mockResolvedValue(false);
    client.search.mockResolvedValue({
      hits: [{ remoteId: '2', title: 'Dungeon Saga', author: null, remoteCoverPath: null, sourceName: 'AllManga' }],
      failedSources: [],
    });
    client.getSeries.mockResolvedValue({ ...mangaSeries, sourceName: 'AllManga' });

    await expect(service.moveJob(11, { seriesKey: 'm:2' }, USER)).rejects.toThrow('The download is busy; try again in a moment.');
    expect(repo.moveJob).not.toHaveBeenCalled();
  });

  it('rejects moving a novel', async () => {
    const { service, repo } = setup();
    repo.findJobById.mockResolvedValue(jobRow({ kind: 'novel', seriesKey: 'n:1' }));

    await expect(service.moveJob(11, { seriesKey: 'm:2' }, USER)).rejects.toThrow('Moving novels between sites is not supported yet.');
  });

  it('rejects a disabled, same-source, or chapterless target', async () => {
    const disabled = setup();
    disabled.client.getSeries.mockRejectedValue(new NotFoundException('That series is not available from an enabled source'));
    await expect(disabled.service.moveJob(11, { seriesKey: 'm:2' }, USER)).rejects.toThrow('enabled source');

    const same = setup();
    same.client.search.mockResolvedValue({
      hits: [{ remoteId: '2', title: 'Dungeon Saga', author: null, remoteCoverPath: null, sourceName: 'Other label' }],
      failedSources: [],
    });
    same.client.getSeries.mockResolvedValue({ ...mangaSeries, sourceName: 'MangaSource' });
    await expect(same.service.moveJob(11, { seriesKey: 'm:2' }, USER)).rejects.toThrow('different source');

    const empty = setup();
    empty.repo.findMoveItems.mockResolvedValue([{ id: 1, sequence: '9', status: 'failed' }]);
    empty.repo.countItemsByStatus.mockResolvedValue({ failed: 1 });
    empty.client.search.mockResolvedValue({
      hits: [{ remoteId: '2', title: 'Dungeon Saga', author: null, remoteCoverPath: null, sourceName: 'AllManga' }],
      failedSources: [],
    });
    empty.client.getSeries.mockResolvedValue({ ...mangaSeries, sourceName: 'AllManga' });
    await expect(empty.service.moveJob(11, { seriesKey: 'm:2' }, USER)).rejects.toThrow('does not have any remaining chapters');
  });
});

describe('WebSerialJobMoveService moving grouped jobs', () => {
  const chapterUnit = (n: number) => ({
    ...mangaSeries.units[0]!,
    unitKey: `t${n}`,
    label: `Chapter ${n}`,
    sequence: String(n),
    remote: { chapterId: `t${n}`, sequence: String(n) },
  });
  const target = {
    ...mangaSeries,
    sourceName: 'AllManga',
    chapterCount: 4,
    units: [11, 12, 13, 14].map(chapterUnit),
  };
  const volumeUnit = {
    unitKey: 'vol:2',
    label: 'Volume 2',
    sequence: '2',
    chapterCount: 2,
    publishedAt: null,
    volume: '2',
    packaging: 'volume',
    remote: { chapters: [{ sequence: '11' }, { sequence: '12' }] },
  };
  const looseUnit = {
    unitKey: 'c13',
    label: 'Chapter 13',
    sequence: '13',
    chapterCount: 1,
    publishedAt: null,
    packaging: 'chapter',
    remote: { chapterId: 'c13', sequence: '13' },
  };

  function prepare(job: Record<string, unknown>, items: Array<Record<string, unknown>>) {
    const ctx = setup();
    ctx.repo.findJobById.mockImplementation(async (id: number) =>
      id === 22 ? jobRow({ id: 22, seriesKey: 'm:2', sourceName: 'AllManga' }) : jobRow(job),
    );
    ctx.repo.findMoveItems.mockResolvedValue(items);
    ctx.repo.countItemsByStatus.mockResolvedValue({ pending: items.length, imported: 1 });
    ctx.client.search.mockResolvedValue({
      hits: [{ remoteId: '2', title: 'Dungeon Saga', author: null, remoteCoverPath: null, sourceName: 'AllManga' }],
      failedSources: [],
    });
    ctx.client.getSeries.mockResolvedValue(target);
    return ctx;
  }

  it('moves the member chapters of an unfinished volume and keeps the volume packaging', async () => {
    const { service, repo } = prepare({ status: 'paused', packaging: 'volume' }, [
      { id: 1, sequence: '2', status: 'pending', unitKey: 'vol:2', remoteRef: { unit: volumeUnit, handle: null } },
      { id: 2, sequence: '13', status: 'pending', unitKey: 'c13', remoteRef: { unit: looseUnit, handle: null } },
    ]);

    await service.moveJob(11, { seriesKey: 'm:2' }, USER);

    const call = repo.moveJob.mock.calls[0]![0] as {
      movedItemIds: number[];
      targetJob: { packaging: string; selection: unknown; engineState: { units: Array<{ unitKey: string; chapterCount: number }> } };
    };
    expect(call.movedItemIds).toEqual([1, 2]);
    expect(call.targetJob.packaging).toBe('volume');
    expect(call.targetJob.selection).toEqual({ mode: 'list', sequences: ['11', '12', '13'] });
    expect(call.targetJob.engineState.units.map((unit) => [unit.unitKey, unit.chapterCount])).toEqual([
      ['vol:2', 2],
      ['t13', 1],
    ]);
  });

  it('moves a one-book job as one book of its remaining chapters, not as its first chapter number', async () => {
    const bookUnit = {
      ...volumeUnit,
      unitKey: 'sel:a-b',
      label: 'Chapters 11-13',
      sequence: '11',
      volume: undefined,
      packaging: 'series',
      remote: { chapters: [{ sequence: '11' }, { sequence: '12' }, { sequence: '13' }] },
    };
    const { service, repo } = prepare({ status: 'paused', packaging: 'series' }, [
      { id: 1, sequence: '11', status: 'pending', unitKey: 'sel:a-b', remoteRef: { unit: bookUnit, handle: null } },
    ]);

    await service.moveJob(11, { seriesKey: 'm:2' }, USER);

    const call = repo.moveJob.mock.calls[0]![0] as {
      targetJob: { packaging: string; selection: unknown; engineState: { units: Array<{ unitKey: string; chapterCount: number }> } };
    };
    expect(call.targetJob.packaging).toBe('series');
    expect(call.targetJob.selection).toEqual({ mode: 'list', sequences: ['11', '12', '13'] });
    expect(call.targetJob.engineState.units).toHaveLength(1);
    expect(call.targetJob.engineState.units[0]).toMatchObject({ packaging: 'series', chapterCount: 3 });
  });

  it('falls back to the saved job units for a grouped job that never started', async () => {
    const { service, repo } = prepare({ status: 'queued', packaging: 'volume' }, []);
    repo.findJobUnits.mockResolvedValue([volumeUnit]);
    repo.countItemsByStatus.mockResolvedValue({});

    await service.moveJob(11, { seriesKey: 'm:2' }, USER);

    expect(repo.moveJob).toHaveBeenCalledWith(
      expect.objectContaining({ targetJob: expect.objectContaining({ selection: { mode: 'list', sequences: ['11', '12'] } }) }),
    );
  });

  it('keeps a volume the target only has in part on the source as missing', async () => {
    const { service, repo } = prepare({ status: 'paused', packaging: 'volume' }, [
      {
        id: 1,
        sequence: '2',
        status: 'pending',
        unitKey: 'vol:2',
        remoteRef: { unit: { ...volumeUnit, remote: { chapters: [{ sequence: '11' }, { sequence: '99' }] } }, handle: null },
      },
      { id: 2, sequence: '13', status: 'pending', unitKey: 'c13', remoteRef: { unit: looseUnit, handle: null } },
    ]);

    await service.moveJob(11, { seriesKey: 'm:2' }, USER);

    const call = repo.moveJob.mock.calls[0]![0] as { movedItemIds: number[]; missingItemIds: number[]; targetJob: { selection: unknown } };
    expect(call.movedItemIds).toEqual([2]);
    expect(call.missingItemIds).toEqual([1]);
    expect(call.targetJob.selection).toEqual({ mode: 'list', sequences: ['13'] });
  });

  it('counts chapters, not units, in the candidate coverage', async () => {
    const { service, repo, lookupService } = prepare({ status: 'paused', packaging: 'volume' }, [
      { id: 1, sequence: '2', status: 'pending', unitKey: 'vol:2', remoteRef: { unit: volumeUnit, handle: null } },
      { id: 2, sequence: '13', status: 'pending', unitKey: 'c13', remoteRef: { unit: looseUnit, handle: null } },
    ]);
    repo.findJobById.mockResolvedValue(jobRow({ status: 'paused', packaging: 'volume', metadata: { match: { id: '1995', title: 'Dungeon Saga' } } }));
    lookupService.findMatch.mockResolvedValue({ id: '1995' });

    const result = await service.getMoveCandidates(11, USER);

    expect(result.remainingTotal).toBe(3);
    expect(result.candidates[0]).toMatchObject({ remainingAvailable: 3, remainingTotal: 3 });
  });
});

describe('WebSerialJobMoveService move failure handling', () => {
  function prepare(status: string) {
    const ctx = setup();
    ctx.repo.findJobById.mockResolvedValue(jobRow({ status }));
    ctx.client.search.mockResolvedValue({
      hits: [{ remoteId: '2', title: 'Dungeon Saga', author: null, remoteCoverPath: null, sourceName: 'AllManga' }],
      failedSources: [],
    });
    ctx.client.getSeries.mockResolvedValue({ ...mangaSeries, sourceName: 'AllManga' });
    ctx.repo.findMoveItems.mockResolvedValue([{ id: 1, sequence: '1', status: 'pending' }]);
    ctx.repo.countItemsByStatus.mockResolvedValue({ pending: 1 });
    return ctx;
  }

  it('checks the target before pausing, so a move that cannot work never touches a running download', async () => {
    const { service, repo } = prepare('running');
    repo.findMoveItems.mockResolvedValue([{ id: 1, sequence: '9', status: 'pending' }]);

    await expect(service.moveJob(11, { seriesKey: 'm:2' }, USER)).rejects.toBeInstanceOf(ConflictException);

    expect(repo.pauseJob).not.toHaveBeenCalled();
    expect(repo.restoreAfterMove).not.toHaveBeenCalled();
  });

  it('puts a download that the move paused back at its place in the queue when the move fails afterwards', async () => {
    const { service, repo, runner } = prepare('running');
    repo.findJobById.mockResolvedValue(jobRow({ status: 'running', queueOrder: 1234 }));
    runner.waitForJobToSettle.mockResolvedValue(false);

    await expect(service.moveJob(11, { seriesKey: 'm:2' }, USER)).rejects.toBeInstanceOf(ConflictException);

    expect(repo.pauseJob).toHaveBeenCalledWith(11);
    expect(repo.restoreAfterMove).toHaveBeenCalledWith(11, 1234);
    expect(repo.resumeJob).not.toHaveBeenCalled();
  });

  it('does not search the sources again to confirm the target', async () => {
    const { service, client } = prepare('paused');

    await service.moveJob(11, { seriesKey: 'm:2' }, USER);

    expect(client.search).not.toHaveBeenCalled();
  });

  it('ends the source as completed so the moved summary stays visible, even when nothing had been downloaded', async () => {
    const { service, repo } = prepare('paused');
    repo.countItemsByStatus.mockResolvedValue({ pending: 1 });

    await service.moveJob(11, { seriesKey: 'm:2' }, USER);

    expect(repo.moveJob).toHaveBeenCalledWith(expect.not.objectContaining({ sourceStatus: expect.anything() }));
  });

  it('does not resume a download it never paused', async () => {
    const { service, repo } = prepare('paused');
    repo.findMoveItems.mockResolvedValue([{ id: 1, sequence: '9', status: 'pending' }]);

    await expect(service.moveJob(11, { seriesKey: 'm:2' }, USER)).rejects.toBeInstanceOf(ConflictException);

    expect(repo.pauseJob).not.toHaveBeenCalled();
    expect(repo.restoreAfterMove).not.toHaveBeenCalled();
  });

  it('refuses to move a download that was cancelled while the move waited for it to settle', async () => {
    const { service, repo } = prepare('running');
    repo.getJobStatus.mockResolvedValue('cancelled');

    await expect(service.moveJob(11, { seriesKey: 'm:2' }, USER)).rejects.toThrow('changed while it was being moved');

    expect(repo.moveJob).not.toHaveBeenCalled();
    expect(repo.restoreAfterMove).toHaveBeenCalledWith(11, 5000);
  });
});
