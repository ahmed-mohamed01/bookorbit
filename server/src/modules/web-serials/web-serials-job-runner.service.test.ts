/* eslint-disable @typescript-eslint/require-await */
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { BadGatewayException, GatewayTimeoutException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  MissingChaptersError,
  TooManyMissingChaptersError,
  UnitDownloadStopped,
  type EngineDownloadOptions,
  type EngineSeries,
  type EngineUnitHandle,
  type EngineUnitSpec,
} from './engines/web-serial-engine';
import type { WebSerialJobItemRow, WebSerialJobRow } from './schema/web-serials.schema';
import { mergeCbzChapters } from './web-serials-cbz-merge.utils';
import { EngineCredentialsRejectedException } from './engines/engine-http.utils';
import { DuplicateBookError, ImportStageError } from './web-serials-import.errors';
import type { WebSerialUnitImport } from './web-serials-import.service';
import { WebSerialsJobRunnerService } from './web-serials-job-runner.service';

const sourceAllowed = vi.hoisted(() => vi.fn((): boolean => true));
const novelSourceAllowed = vi.hoisted(() => vi.fn((): boolean => true));
vi.mock('./web-serials-engine-registry.service', () => ({
  WebSerialsEngineRegistry: class {},
  isSeriesSourceAllowed: sourceAllowed,
  isNovelSourceAllowed: novelSourceAllowed,
}));
vi.mock('./web-serials-import.service', () => ({
  WebSerialsImportService: class {},
  WEB_SERIAL_SIZE_CAPS: { manga: 2 * 1024 * 1024 * 1024, novel: 1024 * 1024 * 1024 },
  WEB_SERIAL_CHAPTER_SIZE_CAP: 500 * 1024 * 1024,
}));
vi.mock('./web-serials-schema-bootstrap.service', () => ({ WebSerialsSchemaBootstrapService: class {} }));
vi.mock('./web-serials-settings.service', () => ({ WebSerialsSettingsService: class {} }));
vi.mock('./web-serials-cbz-merge.utils', () => ({
  mergeCbzChapters: vi.fn().mockResolvedValue({ path: '/dev/null', pages: 4, sizeBytes: 100 }),
}));

const CONN = { url: 'http://engine', username: null, password: null };

const unit = (n: number): EngineUnitSpec => ({
  unitKey: `c${n}`,
  label: `Chapter ${n}`,
  sequence: String(n),
  chapterCount: 1,
  publishedAt: null,
  packaging: 'chapter',
  remote: { chapterId: String(n) },
});

const series = {
  kind: 'manga',
  title: 'Saga',
  authors: ['A'],
  synopsis: null,
  tags: [],
  language: null,
  units: [unit(1), unit(2), unit(3)],
} as unknown as EngineSeries;

function job(overrides: Partial<WebSerialJobRow> = {}): WebSerialJobRow {
  return {
    id: 1,
    userId: 7,
    kind: 'manga',
    seriesKey: 'm:5',
    seriesUrl: null,
    title: 'Saga',
    author: 'A',
    sourceName: 'MangaSource',
    packaging: 'chapter',
    selection: { mode: 'all' },
    skipImported: true,
    targetLibraryId: 2,
    targetFolderId: 4,
    status: 'running',
    metadata: {},
    ...overrides,
  } as WebSerialJobRow;
}

function setup(
  options: {
    existingItems?: WebSerialJobItemRow[];
    imported?: string[];
    config?: unknown;
    folders?: { id: number; path: string }[];
    workDir?: string;
  } = {},
) {
  const items: WebSerialJobItemRow[] = [...(options.existingItems ?? [])];
  const repo = {
    countItemsByStatus: vi.fn(async () => {
      const counts: Record<string, number> = {};
      for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1;
      return counts;
    }),
    insertItems: vi.fn(async (rows: Array<Partial<WebSerialJobItemRow>>) => {
      rows.forEach((row, index) => items.push({ id: 100 + index, status: 'pending', bookId: null, error: null, ...row } as WebSerialJobItemRow));
      return rows.length;
    }),
    findImportedUnitKeys: vi.fn().mockResolvedValue(options.imported ?? []),
    recordImports: vi.fn().mockResolvedValue(undefined),
    skipItems: vi.fn(async (_jobId: number, keys: string[]) => {
      for (const item of items) if (item.status === 'pending' && keys.includes(item.unitKey)) item.status = 'skipped';
      return keys.length;
    }),
    refreshCounters: vi.fn().mockResolvedValue(undefined),
    findNextItem: vi.fn(async (_jobId: number, now: Date): Promise<WebSerialJobItemRow | undefined> => {
      const due = items.filter((item) => {
        const retryAt = (item.remoteRef as { retryAt?: string } | null)?.retryAt;
        return ['pending', 'fetching', 'importing'].includes(item.status) && (!retryAt || Date.parse(retryAt) <= now.getTime());
      });
      return due.find((item) => item.status !== 'pending') ?? due[0];
    }),
    findWaitingRetries: vi.fn(async () => {
      const waiting = items
        .filter((item) => item.status === 'pending' && (item.remoteRef as { retryAt?: string } | null)?.retryAt)
        .sort((a, b) => Date.parse((a.remoteRef as { retryAt: string }).retryAt) - Date.parse((b.remoteRef as { retryAt: string }).retryAt));
      return waiting.length > 0 ? { count: waiting.length, next: waiting[0]! } : undefined;
    }),
    releaseItem: vi.fn(async (id: number) => {
      const index = items.findIndex((entry) => entry.id === id);
      if (index < 0 || !['fetching', 'importing'].includes(items[index]!.status)) return;
      items[index] = { ...items[index]!, status: 'pending', remoteRef: { ...(items[index]!.remoteRef as object), handle: null, member: null } };
    }),
    updateItem: vi.fn(async (id: number, values: Partial<WebSerialJobItemRow>) => {
      const index = items.findIndex((entry) => entry.id === id);
      items[index] = { ...items[index]!, ...values };
      return items[index];
    }),
    findItem: vi.fn(async (id: number) => items.find((entry) => entry.id === id)),
    setItemMember: vi.fn(async (id: number, member: unknown) => {
      const index = items.findIndex((entry) => entry.id === id);
      items[index] = { ...items[index]!, remoteRef: { ...(items[index]!.remoteRef as object), member } };
    }),
    countFailureReasons: vi.fn(async () => {
      const reasons = new Map<string, number>();
      for (const item of items) {
        if (item.status !== 'failed') continue;
        const reason = (item.remoteRef as { failureReason?: string }).failureReason ?? 'unknown';
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
      return reasons;
    }),
    getJobStatus: vi.fn().mockResolvedValue('running'),
    heartbeat: vi.fn().mockResolvedValue(undefined),
    setCurrentUnit: vi.fn().mockResolvedValue(undefined),
    transitionJob: vi.fn().mockResolvedValue({ id: 1 }),
    findQueuedJobs: vi.fn().mockResolvedValue([]),
    claimQueuedJob: vi.fn(),
    releaseInFlightItems: vi.fn().mockResolvedValue(0),
    findJobById: vi.fn().mockResolvedValue({ unitsDone: 3, libraryName: 'Manga' }),
    findLibraryFolders: vi.fn().mockResolvedValue(options.folders ?? [{ id: 4, path: '/a' }]),
    countGappedImports: vi.fn(async () => items.filter((item) => item.status === 'imported' && item.error?.startsWith('Imported with gaps:')).length),
    findLedgerKeysForBook: vi.fn().mockResolvedValue([]),
  };
  const settings = { getMaxConcurrentJobs: vi.fn().mockResolvedValue(2), isQueuePaused: vi.fn().mockResolvedValue(false) };
  const notifications = { upsertByGroupKey: vi.fn().mockResolvedValue(undefined) };
  const client = {
    getSeries: vi.fn().mockResolvedValue(series),
    startUnit: vi.fn(async (_conn: unknown, _id: string, spec: EngineUnitSpec): Promise<EngineUnitHandle> => ({
      unitKey: spec.unitKey,
      remote: { ...spec.remote, started: true },
    })),
    pollUnit: vi.fn().mockResolvedValue({ state: 'done' }),
    download: vi.fn().mockResolvedValue({ stream: null, fileName: 'c.cbz', format: 'cbz', size: 1 }),
    discardUnit: vi.fn().mockResolvedValue(undefined),
  };
  const engines = {
    getConfig: vi.fn().mockResolvedValue(options.config === undefined ? { connection: CONN } : options.config),
    client: vi.fn().mockReturnValue(client),
  };
  let nextBook = 500;
  const importer = {
    importUnit: vi.fn<(request: WebSerialUnitImport) => Promise<number>>(async () => nextBook++),
    prepareUnitWorkDir: vi.fn().mockResolvedValue(options.workDir ?? '/tmp/web-serial-work'),
    saveWorkDownload: vi.fn().mockResolvedValue(10),
    cleanupUnitWorkDir: vi.fn().mockResolvedValue(undefined),
    removeJobWorkDir: vi.fn().mockResolvedValue(undefined),
  };
  const runner = new WebSerialsJobRunnerService(
    repo as never,
    { ready: Promise.resolve({ requeued: [] }) } as never,
    settings as never,
    engines as never,
    importer as never,
    notifications as never,
  );
  const clock = { offset: 0 };
  vi.spyOn(runner as unknown as { now: () => Date }, 'now').mockImplementation(() => new Date(Date.now() + clock.offset));
  vi.spyOn(runner as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep').mockImplementation(async (ms) => {
    clock.offset += ms;
  });
  return { runner, repo, client, importer, items, engines, settings, notifications };
}

const finalTransition = (repo: ReturnType<typeof setup>['repo']) => repo.transitionJob.mock.calls.at(-1)!;

afterEach(() => {
  vi.restoreAllMocks();
  sourceAllowed.mockReset().mockReturnValue(true);
  novelSourceAllowed.mockReset().mockReturnValue(true);
});

describe('WebSerialsJobRunnerService.runJob', () => {
  it('expands the selection, downloads and imports every unit, then completes', async () => {
    const { runner, repo, client, importer, items } = setup();

    await runner.runJob(job());

    expect(repo.insertItems).toHaveBeenCalledTimes(1);
    expect(items.map((item) => [item.unitKey, item.status, item.bookId])).toEqual([
      ['c1', 'imported', 500],
      ['c2', 'imported', 501],
      ['c3', 'imported', 502],
    ]);
    expect(client.startUnit).toHaveBeenCalledTimes(3);
    expect(importer.importUnit).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 1,
        userId: 7,
        kind: 'manga',
        targetLibraryId: 2,
        targetFolderId: 4,
        metadata: expect.objectContaining({ title: 'Saga Ch. 1', seriesName: 'Saga', seriesIndex: '1' }),
      }),
    );
    expect(finalTransition(repo)).toEqual([
      1,
      ['running', 'importing'],
      expect.objectContaining({ status: 'completed', message: null }),
      { requireSettledItems: true },
    ]);
  });

  it('records a ledger row for each imported unit, keyed to the job match', async () => {
    const { runner, repo } = setup();

    await runner.runJob(job({ metadata: { match: { id: '77' } } as WebSerialJobRow['metadata'] }));

    expect(repo.recordImports).toHaveBeenCalledTimes(3);
    expect(repo.recordImports).toHaveBeenNthCalledWith(1, [
      {
        userId: 7,
        seriesKey: 'm:5',
        matchKey: 'mb:77',
        kind: 'manga',
        packaging: 'chapter',
        bookId: 500,
        titleKey: 'saga',
        unitKey: 'c1',
        sequence: '1',
        chapterFrom: 1,
        chapterTo: 1,
      },
    ]);
    expect(repo.findImportedUnitKeys).toHaveBeenCalledWith(
      7,
      'm:5',
      [
        { key: 'c1', sequence: '1', packaging: 'chapter' },
        { key: 'c2', sequence: '2', packaging: 'chapter' },
        { key: 'c3', sequence: '3', packaging: 'chapter' },
      ],
      'mb:77',
      [],
    );
  });

  it('checks novel volumes owned from another engine by match id and by the series and match titles', async () => {
    const { runner, repo, client } = setup();
    client.getSeries.mockResolvedValue({ ...series, kind: 'novel' } as EngineSeries);

    await runner.runJob(
      job({
        kind: 'novel',
        seriesKey: 'nl:src:abc',
        title: 'Saga Novel',
        packaging: 'volume',
        metadata: { match: { id: '9', title: 'Saga' } } as never,
      }),
    );

    expect(repo.findImportedUnitKeys.mock.calls[0]!.slice(3)).toEqual(['mb:9', ['Saga Novel', 'Saga']]);
  });

  it('keeps a unit built from fetched chapters running and fetching until its book is built, then imports it', async () => {
    const { runner, repo, client, items } = setup();
    const statusesDuringFetch: string[] = [];
    Object.assign(client, { requiresUnitWorkDir: true });
    client.download.mockImplementation(
      async (_conn: unknown, _handle: unknown, _signal: unknown, onProgress?: (progress: Record<string, unknown>) => Promise<void>) => {
        statusesDuringFetch.push(items[0]!.status);
        await onProgress?.({ chaptersDone: 1, chaptersTotal: 2, stage: 'fetching' });
        await onProgress?.({ chaptersDone: 2, chaptersTotal: 2, stage: 'building' });
        return { stream: null, fileName: 'v.epub', format: 'epub', size: 1 };
      },
    );

    await runner.runJob(job({ selection: { mode: 'range', fromSequence: '1', toSequence: '1' } }));

    expect(statusesDuringFetch).toEqual(['fetching']);
    const importingAt = repo.transitionJob.mock.calls.findIndex((call) => (call[2] as { status?: string }).status === 'importing');
    const downloadOrder = client.download.mock.invocationCallOrder[0]!;
    expect(repo.transitionJob.mock.invocationCallOrder[importingAt]!).toBeGreaterThan(downloadOrder);
    expect(repo.setCurrentUnit.mock.calls.map((call) => (call[1] as { stage?: string } | null)?.stage ?? null)).toEqual([
      'fetching',
      'building',
      'importing',
      null,
    ]);
    expect(items[0]!.status).toBe('imported');
  });

  it('keeps an imported unit imported when its ledger row cannot be written', async () => {
    const { runner, repo, items } = setup();
    repo.recordImports.mockRejectedValue(new Error('db down'));

    await runner.runJob(job());

    expect(items.map((item) => item.status)).toEqual(['imported', 'imported', 'imported']);
  });

  it('skips units the user already imported', async () => {
    const { runner, items, client } = setup({ imported: ['c2'] });

    await runner.runJob(job());

    expect(items.find((item) => item.unitKey === 'c2')!.status).toBe('skipped');
    expect(client.startUnit).toHaveBeenCalledTimes(2);
  });

  it('does not skip when skipImported is off', async () => {
    const { runner, repo } = setup({ imported: ['c2'] });

    await runner.runJob(job({ skipImported: false }));

    expect(repo.findImportedUnitKeys).not.toHaveBeenCalled();
  });

  it('finishes with gaps when some units fail and carries on past a failure', async () => {
    const { runner, repo, client, items } = setup();
    client.pollUnit.mockImplementation(async (_conn: unknown, handle: { unitKey: string }) =>
      handle.unitKey === 'c2' ? { state: 'failed', reason: 'source error' } : { state: 'done' },
    );

    await runner.runJob(job());

    expect(items.map((item) => item.status)).toEqual(['imported', 'failed', 'imported']);
    expect(items[1]!.error).toBe('Chapter 2: source error');
    expect((items[1]!.remoteRef as { handle: unknown }).handle).toBeNull();
    expect(finalTransition(repo)[2]).toMatchObject({ status: 'completed_with_gaps', message: '1 chapter could not be downloaded from MangaSource.' });
  });

  it('fails the job when nothing was imported and something failed', async () => {
    const { runner, repo, client } = setup();
    client.pollUnit.mockResolvedValue({ state: 'failed', reason: 'nope' });

    await runner.runJob(job());

    expect(finalTransition(repo)[2]).toMatchObject({ status: 'failed', message: '3 chapters could not be downloaded from MangaSource.' });
  });

  it('records an import failure on the item without failing the job', async () => {
    const { runner, importer, items, repo } = setup();
    importer.importUnit.mockRejectedValueOnce(new Error('dock refused')).mockResolvedValue(600);

    await runner.runJob(job());

    expect(items[0]).toMatchObject({ status: 'failed', error: 'Chapter 1: dock refused' });
    expect(finalTransition(repo)[2]).toMatchObject({ status: 'completed_with_gaps' });
  });

  describe('failure reasons and retries', () => {
    const sleeps = (runner: unknown) => (runner as { sleep: Mock<(ms: number) => Promise<void>> }).sleep;
    const oneChapter = () => job({ selection: { mode: 'range', fromSequence: '1', toSequence: '1' } });

    it('stores a plain reason naming the source and states a shared reason once', async () => {
      const { runner, repo, client, items } = setup();
      client.pollUnit.mockResolvedValue({ state: 'failed', reason: 'not found' });

      await runner.runJob(job());

      expect(items[0]!.error).toBe('Chapter 1: MangaSource no longer has this chapter.');
      expect(finalTransition(repo)[2]).toMatchObject({
        status: 'failed',
        message: '3 chapters could not be downloaded: MangaSource no longer has this chapter.',
      });
      expect(client.startUnit).toHaveBeenCalledTimes(3);
    });

    it('retries after 2 then 10 minutes, announces the wait and clears it when the attempt starts', async () => {
      const { runner, repo, client, items } = setup();
      client.pollUnit
        .mockResolvedValueOnce({ state: 'failed', reason: 'The chapter download failed' })
        .mockResolvedValueOnce({ state: 'failed', reason: 'The chapter download failed' })
        .mockResolvedValue({ state: 'done' });

      await runner.runJob(oneChapter());

      expect(items[0]!.status).toBe('imported');
      expect(client.startUnit).toHaveBeenCalledTimes(3);
      const waits = sleeps(runner).mock.calls.map((call: number[]) => call[0]!);
      // The wait is cut into 5 s slices against a clock that also advances by real elapsed time, so allow one slice either way.
      const slices = waits.filter((ms: number) => ms === 5000).length;
      expect(slices).toBeGreaterThanOrEqual(120 / 5 + 600 / 5 - 2);
      expect(slices).toBeLessThanOrEqual(120 / 5 + 600 / 5 + 2);
      const messages = repo.transitionJob.mock.calls.map((call) => (call[2] as { message?: string | null }).message).filter((m) => m !== undefined);
      expect(messages).toContain("Waiting to retry 1 chapter: MangaSource's image server failed for this chapter. Next try in 2 minutes.");
      expect(messages).toContain("Waiting to retry 1 chapter: MangaSource's image server failed for this chapter. Next try in 10 minutes.");
      expect(repo.setCurrentUnit).not.toHaveBeenCalledWith(1, expect.objectContaining({ label: 'Chapter 1', stage: 'fetching' }));
      expect(finalTransition(repo)[2]).toMatchObject({ status: 'completed', message: null });
    });

    it('lets the other units proceed while one waits to retry, then retries it', async () => {
      const { runner, repo, client, items } = setup();
      let failedOnce = false;
      client.pollUnit.mockImplementation(async (_conn: unknown, handle: { unitKey: string }) => {
        if (handle.unitKey === 'c1' && !failedOnce) {
          failedOnce = true;
          return { state: 'failed', reason: 'The chapter download failed' };
        }
        return { state: 'done' };
      });
      const order: string[] = [];
      client.startUnit.mockImplementation(async (_conn: unknown, _id: string, spec: EngineUnitSpec) => {
        order.push(spec.unitKey);
        return { unitKey: spec.unitKey, remote: { ...spec.remote, started: true } };
      });

      await runner.runJob(job());

      expect(order).toEqual(['c1', 'c2', 'c3', 'c1']);
      expect(items.map((item) => item.status)).toEqual(['imported', 'imported', 'imported']);
      const waits = sleeps(runner).mock.calls.length;
      expect(waits).toBeGreaterThanOrEqual(120 / 5 - 1);
      expect(waits).toBeLessThanOrEqual(120 / 5 + 1);
      expect(finalTransition(repo)[2]).toMatchObject({ status: 'completed', message: null });
    });

    it('persists attempts and retryAt on the item and drops the stale handle', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-14T10:00:00.000Z'));
      try {
        const { runner, repo, client, items } = setup({ existingItems: [] });
        client.pollUnit.mockResolvedValue({ state: 'failed', reason: 'The chapter download failed' });
        repo.findNextItem.mockImplementationOnce(async () => items[0]).mockImplementationOnce(async () => undefined);
        repo.findWaitingRetries.mockResolvedValueOnce(undefined);

        await runner.runJob(oneChapter());

        expect(items[0]!.status).toBe('pending');
        expect(items[0]!.remoteRef).toMatchObject({
          handle: null,
          member: null,
          attempts: 1,
          retryAt: '2026-10-14T10:02:00.000Z',
          retryReason: 'source_images_failed',
          unit: expect.objectContaining({ unitKey: 'c1' }),
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('waits only when nothing else is due, naming the units and the minutes', async () => {
      const { runner, repo, client, items } = setup();
      let c2Starts = 0;
      client.pollUnit.mockImplementation(async (_conn: unknown, handle: { unitKey: string }) =>
        handle.unitKey === 'c2' && c2Starts++ === 0 ? { state: 'failed', reason: 'The chapter download failed' } : { state: 'done' },
      );
      const sleepsBeforeC3 = { count: -1 };
      client.startUnit.mockImplementation(async (_conn: unknown, _id: string, spec: EngineUnitSpec) => {
        if (spec.unitKey === 'c3') sleepsBeforeC3.count = sleeps(runner).mock.calls.length;
        return { unitKey: spec.unitKey, remote: { ...spec.remote, started: true } };
      });

      await runner.runJob(job());

      expect(sleepsBeforeC3.count).toBe(0);
      expect(items.every((item) => item.status === 'imported')).toBe(true);
      const messages = repo.transitionJob.mock.calls.map((call) => (call[2] as { message?: string | null }).message).filter((m) => m);
      expect(messages[0]).toMatch(/^Waiting to retry 1 chapter: .* Next try in 2 minutes\.$/);
      expect(repo.setCurrentUnit).not.toHaveBeenCalledWith(1, expect.objectContaining({ label: 'Chapter 2', stage: 'fetching' }));
      expect(repo.heartbeat).toHaveBeenCalled();
    });

    it('resumes a restarted job with the stored attempts and only the remaining retries', async () => {
      const retryAt = new Date(Date.now() + 60_000).toISOString();
      const existing = {
        id: 9,
        jobId: 1,
        unitKey: 'c1',
        label: 'Chapter 1',
        sequence: '1',
        status: 'pending',
        bookId: null,
        error: null,
        remoteRef: { unit: unit(1), handle: null, attempts: 2, retryAt, retryReason: 'source_images_failed' },
      } as unknown as WebSerialJobItemRow;
      const { runner, client, items } = setup({ existingItems: [existing] });
      client.pollUnit.mockResolvedValue({ state: 'failed', reason: 'The chapter download failed' });

      await runner.runJob(job());

      expect(client.startUnit).toHaveBeenCalledTimes(1);
      expect(items[0]!.status).toBe('failed');
      expect(sleeps(runner).mock.calls.length).toBe(60 / 5);
      expect(items[0]!.remoteRef).not.toHaveProperty('retryAt');
    });

    it('marks the item failed after the retries are used up', async () => {
      const { runner, repo, client, items } = setup();
      client.pollUnit.mockResolvedValue({ state: 'failed', reason: 'The chapter download failed' });

      await runner.runJob(oneChapter());

      expect(client.startUnit).toHaveBeenCalledTimes(3);
      expect(items[0]).toMatchObject({ status: 'failed', error: "Chapter 1: MangaSource's image server failed for this chapter." });
      expect(finalTransition(repo)[2]).toMatchObject({
        status: 'failed',
        message: "1 chapter could not be downloaded: MangaSource's image server failed for this chapter. Try again later.",
      });
    });

    it.each([
      ['not_found', 'HTTP 404 not found'],
      ['source_blocked', 'HTTP 403 forbidden'],
      ['unknown', 'something odd'],
    ])('does not retry %s', async (_name, reason) => {
      const { runner, client } = setup();
      client.pollUnit.mockResolvedValue({ state: 'failed', reason });

      await runner.runJob(oneChapter());

      expect(client.startUnit).toHaveBeenCalledTimes(1);
      expect(sleeps(runner)).not.toHaveBeenCalledWith(5000);
    });

    it('retries when the engine call itself times out', async () => {
      const { runner, client, items } = setup();
      client.startUnit.mockRejectedValueOnce(new GatewayTimeoutException('The remote service did not answer in time'));

      await runner.runJob(oneChapter());

      expect(items[0]!.status).toBe('imported');
      expect(client.startUnit).toHaveBeenCalledTimes(2);
    });

    it('stops waiting promptly when the job is cancelled', async () => {
      const { runner, repo, client, items } = setup();
      client.pollUnit.mockResolvedValue({ state: 'failed', reason: 'The chapter download failed' });
      let checks = 0;
      repo.getJobStatus.mockImplementation(async () => (++checks > 6 ? 'cancelled' : 'running'));

      await runner.runJob(oneChapter());

      expect(client.startUnit).toHaveBeenCalledTimes(1);
      expect(sleeps(runner).mock.calls.length).toBeLessThan(6);
      expect(items[0]!.status).not.toBe('failed');
    });

    it('waits in slices on the real clock without holding up the tick', async () => {
      vi.useFakeTimers();
      try {
        const { runner, client, items } = setup();
        vi.mocked(runner as unknown as { sleep: (ms: number) => Promise<void> }).sleep.mockRestore?.();
        client.pollUnit.mockResolvedValueOnce({ state: 'failed', reason: 'The chapter download failed' }).mockResolvedValue({ state: 'done' });

        const run = runner.runJob(oneChapter());
        await vi.advanceTimersByTimeAsync(119_000);
        expect(client.startUnit).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2_000);
        await run;
        expect(client.startUnit).toHaveBeenCalledTimes(2);
        expect(items[0]!.status).toBe('imported');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('keeps polling while the unit runs and tolerates transient poll errors', async () => {
    const { runner, client, repo } = setup();
    client.pollUnit
      .mockResolvedValueOnce({ state: 'pending', progress: null })
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValueOnce({ state: 'running', progress: 0.5 })
      .mockResolvedValue({ state: 'done' });

    await runner.runJob(job({ selection: { mode: 'range', fromSequence: '1', toSequence: '1' } }));

    expect(client.pollUnit.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(repo.heartbeat).toHaveBeenCalled();
    expect(finalTransition(repo)[2]).toMatchObject({ status: 'completed' });
  });

  it('resumes a unit from its persisted handle instead of starting it again', async () => {
    const existing = {
      id: 9,
      jobId: 1,
      unitKey: 'c1',
      label: 'Chapter 1',
      sequence: '1',
      status: 'pending',
      bookId: null,
      error: null,
      remoteRef: { unit: unit(1), handle: { chapterId: '1', started: true } },
    } as unknown as WebSerialJobItemRow;
    const { runner, client, repo, importer } = setup({ existingItems: [existing] });

    await runner.runJob(job());

    expect(repo.insertItems).not.toHaveBeenCalled();
    expect(client.startUnit).not.toHaveBeenCalled();
    expect(client.pollUnit).toHaveBeenCalledWith(CONN, { unitKey: 'c1', remote: { chapterId: '1', started: true } });
    expect(importer.importUnit).toHaveBeenCalledTimes(1);
  });

  it('records the engine progress of the unit, then importing, and clears it after each item', async () => {
    const { runner, client, repo } = setup();
    client.pollUnit
      .mockResolvedValueOnce({ state: 'running', progress: 0.3, chaptersDone: 3, chaptersTotal: 10 })
      .mockResolvedValueOnce({ state: 'running', progress: 0.3, chaptersDone: 3, chaptersTotal: 10 })
      .mockResolvedValueOnce({ state: 'running', progress: 0.9, stage: 'building' })
      .mockResolvedValue({ state: 'done' });

    await runner.runJob(job({ selection: { mode: 'range', fromSequence: '1', toSequence: '1' } }));

    expect(repo.setCurrentUnit.mock.calls.map((call) => call[1])).toEqual([
      { label: 'Chapter 1', stage: 'fetching', chaptersDone: 3, chaptersTotal: 10, progress: 0.3 },
      { label: 'Chapter 1', stage: 'building', chaptersDone: null, chaptersTotal: null, progress: 0.9 },
      { label: 'Chapter 1', stage: 'importing', chaptersDone: null, chaptersTotal: null, progress: null },
      null,
    ]);
  });

  it('reports member chapters done out of total for a grouped unit', async () => {
    const grouped: EngineUnitSpec = {
      unitKey: 'vol:1',
      label: 'Volume 1',
      sequence: '1',
      chapterCount: 2,
      publishedAt: null,
      packaging: 'volume',
      remote: {
        chapters: [
          { chapterId: '1', label: 'Chapter 1', sequence: '1' },
          { chapterId: '2', label: 'Chapter 2', sequence: '2' },
        ],
      },
    };
    const { runner, client, repo } = setup();
    client.pollUnit.mockResolvedValue({ state: 'running', progress: 0.5 });
    client.pollUnit.mockResolvedValueOnce({ state: 'running', progress: 0.5 }).mockResolvedValueOnce({ state: 'done' });
    client.pollUnit.mockResolvedValueOnce({ state: 'running', progress: 0.5 }).mockResolvedValueOnce({ state: 'done' });

    await runner.runJob(job({ packaging: 'volume', engineState: { units: [grouped] } }));

    const written = repo.setCurrentUnit.mock.calls.map((call) => call[1]);
    expect(written[0]).toEqual({ label: 'Volume 1', stage: 'fetching', chaptersDone: 0, chaptersTotal: 2, progress: 0.25 });
    expect(written).toContainEqual({ label: 'Volume 1', stage: 'building', chaptersDone: 2, chaptersTotal: 2, progress: 1 });
    expect(written).toContainEqual({ label: 'Volume 1', stage: 'importing', chaptersDone: null, chaptersTotal: null, progress: null });
    expect(written.at(-1)).toBeNull();
  });

  it('clears the current unit when the job ends', async () => {
    const { runner, repo } = setup();

    await runner.runJob(job());

    expect(finalTransition(repo)[2]).toMatchObject({ currentUnit: null });
  });

  it('stops between units when the job is cancelled and leaves the status alone', async () => {
    const { runner, repo, importer, items } = setup();
    repo.getJobStatus.mockResolvedValueOnce('running').mockResolvedValueOnce('running').mockResolvedValue('cancelled');
    repo.transitionJob.mockImplementation(async (_id: number, _from: unknown, values: { finishedAt?: Date }) =>
      values.finishedAt ? undefined : { id: 1 },
    );

    await runner.runJob(job());

    expect(importer.importUnit).toHaveBeenCalledTimes(1);
    expect(items.filter((item) => item.status === 'imported')).toHaveLength(1);
    expect(items.filter((item) => item.status === 'pending')).toHaveLength(2);
    expect(repo.transitionJob).toHaveBeenCalledTimes(3);
    expect(repo.transitionJob.mock.calls.every((call) => call[2].status !== 'cancelled')).toBe(true);
  });

  describe('pausing', () => {
    it('stops between units, keeps every item and leaves the paused status alone', async () => {
      const { runner, repo, importer, items, notifications } = setup();
      repo.getJobStatus.mockResolvedValueOnce('running').mockResolvedValueOnce('running').mockResolvedValue('paused');
      repo.transitionJob.mockImplementation(async (_id: number, _from: unknown, values: { finishedAt?: Date }) =>
        values.finishedAt ? undefined : { id: 1 },
      );

      await runner.runJob(job());

      expect(importer.importUnit).toHaveBeenCalledTimes(1);
      expect(items.filter((item) => item.status === 'imported')).toHaveLength(1);
      expect(items.filter((item) => item.status === 'pending')).toHaveLength(2);
      expect(repo.transitionJob.mock.calls.every((call) => !['cancelled', 'failed'].includes(call[2].status as string))).toBe(true);
      expect(repo.releaseInFlightItems).toHaveBeenCalledWith(1);
      expect(notifications.upsertByGroupKey).not.toHaveBeenCalled();
    });

    it('cancels the in-flight engine unit while waiting and releases the item', async () => {
      const { runner, repo, client } = setup();
      const cancelUnit = vi.fn().mockResolvedValue(undefined);
      (client as Record<string, unknown>)['cancelUnit'] = cancelUnit;
      client.pollUnit.mockResolvedValue({ state: 'running', progress: 0.2 });
      let checks = 0;
      repo.getJobStatus.mockImplementation(async () => (++checks > 3 ? 'paused' : 'running'));

      await runner.runJob(job({ selection: { mode: 'all' } }));

      expect(cancelUnit).toHaveBeenCalledTimes(1);
      expect(repo.releaseInFlightItems).toHaveBeenCalledWith(1);
    });

    it('does not release items of a job that was cancelled', async () => {
      const { runner, repo } = setup();
      repo.getJobStatus.mockResolvedValueOnce('running').mockResolvedValue('cancelled');
      repo.transitionJob.mockResolvedValue(undefined);

      await runner.runJob(job());

      expect(repo.releaseInFlightItems).not.toHaveBeenCalled();
    });
  });

  it('saves a handle the engine moved on while polling, so a restart resumes that step instead of starting it again', async () => {
    const { runner, repo, client } = setup();
    client.pollUnit.mockImplementationOnce(async (_conn: unknown, handle: { remote: Record<string, unknown> }) => {
      handle.remote['stage'] = 'building';
      handle.remote['jobId'] = 'build-1';
      return { state: 'running', progress: 0.5 };
    });

    await runner.runJob(job({ selection: { mode: 'range', fromSequence: '1', toSequence: '1' } }));

    const saved = repo.updateItem.mock.calls.map((call) => (call[1] as { remoteRef?: { handle?: Record<string, unknown> } }).remoteRef?.handle);
    expect(saved).toContainEqual(expect.objectContaining({ stage: 'building', jobId: 'build-1' }));
  });

  it('files the book under the series title with the apostrophe case the queue shows', async () => {
    const { runner, client, importer } = setup();
    client.getSeries.mockResolvedValue({ ...series, title: "Omniscient Reader'S Viewpoint" } as EngineSeries);

    await runner.runJob(job({ selection: { mode: 'range', fromSequence: '1', toSequence: '1' } }));

    expect((importer.importUnit.mock.calls[0] as unknown[])[0]).toMatchObject({
      metadata: { title: "Omniscient Reader's Viewpoint Ch. 1", seriesName: "Omniscient Reader's Viewpoint" },
    });
  });

  it('names volumes, not chapters, in the notification of a volume job', async () => {
    const grouped: EngineUnitSpec = {
      unitKey: 'vol:1',
      label: 'Volume 1',
      sequence: '1',
      chapterCount: 1,
      publishedAt: null,
      packaging: 'volume',
      remote: { chapters: [{ chapterId: 'x1', label: 'Chapter 1', sequence: '1' }] },
    };
    const { runner, notifications } = setup();

    await runner.runJob(job({ packaging: 'volume', engineState: { units: [grouped] } }));

    expect(notifications.upsertByGroupKey).toHaveBeenCalledWith(
      7,
      'web-serial-job:1',
      expect.objectContaining({ message: '3 volumes added to Manga.' }),
      {
        markUnread: true,
      },
    );
  });

  describe('outcome notifications', () => {
    it('tells the owner a finished download is in the library, grouped per job', async () => {
      const { runner, notifications } = setup();

      await runner.runJob(job());

      expect(notifications.upsertByGroupKey).toHaveBeenCalledTimes(1);
      expect(notifications.upsertByGroupKey).toHaveBeenCalledWith(
        7,
        'web-serial-job:1',
        expect.objectContaining({
          type: 'web_serial_completed',
          title: 'Saga is in your library',
          message: '3 chapters added to Manga.',
          actionUrl: '/web-serials/queue',
        }),
        { markUnread: true },
      );
    });

    it('warns about gaps and reports a failed job', async () => {
      const gaps = setup();
      gaps.client.pollUnit.mockImplementation(async (_conn: unknown, handle: { unitKey: string }) =>
        handle.unitKey === 'c2' ? { state: 'failed', reason: 'source error' } : { state: 'done' },
      );
      await gaps.runner.runJob(job());
      expect(gaps.notifications.upsertByGroupKey.mock.calls[0]![2]).toMatchObject({
        type: 'web_serial_completed_with_gaps',
        title: 'Saga was added with gaps',
        message: '1 chapter could not be downloaded from MangaSource.',
      });

      const failed = setup({ config: null });
      await failed.runner.runJob(job());
      expect(failed.notifications.upsertByGroupKey.mock.calls[0]![2]).toMatchObject({
        type: 'web_serial_failed',
        title: 'Saga could not be downloaded',
        message: 'This download source is not available right now.',
      });
    });

    it('stays silent when the job was cancelled and survives a notification failure', async () => {
      const cancelled = setup();
      cancelled.repo.getJobStatus.mockResolvedValueOnce('running').mockResolvedValue('cancelled');
      cancelled.repo.transitionJob.mockResolvedValue(undefined);
      await cancelled.runner.runJob(job());
      expect(cancelled.notifications.upsertByGroupKey).not.toHaveBeenCalled();

      const broken = setup();
      broken.notifications.upsertByGroupKey.mockRejectedValue(new Error('db down'));
      await expect(broken.runner.runJob(job())).resolves.toBeUndefined();
    });
  });

  it('fails the job when the engine is not configured', async () => {
    const { runner, repo } = setup({ config: null });

    await runner.runJob(job());

    expect(finalTransition(repo)[2]).toMatchObject({ status: 'failed', message: 'This download source is not available right now.' });
  });

  it('fails the job with a plain message when the series cannot be loaded', async () => {
    const { runner, repo, client } = setup();
    client.getSeries.mockRejectedValue(new Error('engine down'));

    await runner.runJob(job());

    expect(finalTransition(repo)[2]).toMatchObject({ status: 'failed', message: 'The download from MangaSource could not be completed.' });
  });

  it('imports with the metadata snapshot saved on the job', async () => {
    const { runner, importer } = setup();

    await runner.runJob(
      job({
        selection: { mode: 'range', fromSequence: '1', toSequence: '1' },
        metadata: {
          override: { authors: ['Chosen Author'], artists: ['Chosen Artist'] },
          match: {
            provider: 'mangabaka',
            id: '9',
            title: 'Canonical Saga',
            url: 'https://mangabaka.org/9',
            year: null,
            authors: ['Matched Author'],
            artists: ['Matched Artist'],
            status: 'ongoing',
            genres: ['Adventure'],
          },
        },
      }),
    );

    expect(importer.importUnit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          title: 'Canonical Saga Ch. 1',
          authors: ['Chosen Author'],
          comicMetadata: { pencillers: ['Chosen Artist'] },
        }),
      }),
    );
  });

  it('downloads every grouped manga chapter in order, merges once and imports once', async () => {
    const grouped: EngineUnitSpec = {
      unitKey: 'vol:1',
      label: 'Volume 1',
      sequence: '1',
      chapterCount: 2,
      publishedAt: null,
      packaging: 'volume',
      remote: {
        chapters: [
          { chapterId: '1', label: 'Chapter 1', sequence: '1' },
          { chapterId: '2', label: 'Chapter 2', sequence: '2' },
        ],
      },
    };
    const { runner, client, importer, items } = setup();

    await runner.runJob(job({ packaging: 'volume', engineState: { units: [grouped] } }));

    expect(client.startUnit.mock.calls.map((call) => call[2].remote.chapterId)).toEqual(['1', '2']);
    expect(importer.saveWorkDownload).toHaveBeenCalledTimes(2);
    expect(mergeCbzChapters).toHaveBeenCalledTimes(1);
    expect(importer.importUnit).toHaveBeenCalledTimes(1);
    expect(importer.cleanupUnitWorkDir).toHaveBeenCalledWith(1, items[0]!.id);
    expect(items[0]).toMatchObject({ unitKey: 'vol:1', status: 'imported' });
  });

  it('records the grouped unit and each member chapter', async () => {
    const grouped: EngineUnitSpec = {
      unitKey: 'vol:1',
      label: 'Volume 1',
      sequence: '1',
      chapterCount: 2,
      publishedAt: null,
      packaging: 'volume',
      remote: {
        chapters: [
          { chapterId: 'x1', label: 'Chapter 1', sequence: '1' },
          { chapterId: 'x2', label: 'Chapter 2', sequence: '2' },
        ],
      },
    };
    const { runner, repo } = setup();

    await runner.runJob(job({ packaging: 'volume', engineState: { units: [grouped] } }));

    const base = { userId: 7, seriesKey: 'm:5', matchKey: null, kind: 'manga', packaging: 'volume', bookId: 500, titleKey: 'saga' };
    expect(repo.recordImports).toHaveBeenCalledWith([
      { ...base, unitKey: 'vol:1', sequence: '1-2', chapterFrom: 1, chapterTo: 2 },
      { ...base, unitKey: 'x1', sequence: '1' },
      { ...base, unitKey: 'x2', sequence: '2' },
    ]);
  });

  it('records an extra without a chapter number so its invented number never matches a later chapter', async () => {
    const extra: EngineUnitSpec = { ...unit(10), unitKey: 'e1', sequence: '10.001', positional: true, remote: { chapterId: 'e1' } };
    const grouped: EngineUnitSpec = {
      unitKey: 'vol:1',
      label: 'Volume 1',
      sequence: '1',
      chapterCount: 2,
      publishedAt: null,
      packaging: 'volume',
      remote: {
        chapters: [
          { chapterId: 'x10', label: 'Chapter 10', sequence: '10' },
          { chapterId: 'e2', label: 'Omake', sequence: '10.001', positional: true },
        ],
      },
    };
    const single = setup();
    await single.runner.runJob(job({ engineState: { units: [extra] } }));
    expect(single.repo.recordImports).toHaveBeenCalledWith([
      expect.objectContaining({ unitKey: 'e1', sequence: '~10.001', chapterFrom: null, chapterTo: null }),
    ]);
    expect(single.repo.findImportedUnitKeys.mock.calls[0]![2]).toEqual([{ key: 'e1', sequence: '10.001', packaging: 'chapter', positional: true }]);

    const volume = setup();
    await volume.runner.runJob(job({ packaging: 'volume', engineState: { units: [grouped] } }));
    expect(volume.repo.recordImports).toHaveBeenCalledWith([
      expect.objectContaining({ unitKey: 'vol:1', chapterFrom: 10, chapterTo: 10 }),
      expect.objectContaining({ unitKey: 'x10', sequence: '10' }),
      expect.objectContaining({ unitKey: 'e2', sequence: '~10.001' }),
    ]);
  });

  it('titles the growing last volume of an ongoing manga with its chapters and checks ownership by its range', async () => {
    const grouped: EngineUnitSpec = {
      unitKey: 'vol:12:100-103',
      label: 'Volume 12',
      sequence: '12',
      chapterCount: 2,
      publishedAt: null,
      packaging: 'volume',
      chapterRange: { from: 100, to: 103 },
      remote: {
        chapters: [
          { chapterId: 'x100', label: 'Chapter 100', sequence: '100' },
          { chapterId: 'x103', label: 'Chapter 103', sequence: '103' },
        ],
      },
    };
    const { runner, repo, importer } = setup();

    await runner.runJob(job({ packaging: 'volume', engineState: { units: [grouped] } }));

    expect(repo.findImportedUnitKeys.mock.calls[0]![2]).toEqual([
      { key: 'vol:12:100-103', sequence: '12', packaging: 'volume', range: { from: 100, to: 103 } },
    ]);
    expect((importer.importUnit.mock.calls[0] as unknown[])[0]).toMatchObject({ metadata: { title: 'Saga, Volume 12 (Chapters 100-103)' } });
    expect(repo.recordImports).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ unitKey: 'vol:12:100-103', chapterFrom: 100, chapterTo: 103 })]),
    );
  });

  it('fails a grouped unit with a plain message naming the failed chapter and cleans its work folder', async () => {
    const grouped: EngineUnitSpec = {
      unitKey: 'sel:c1-c2',
      label: 'Saga',
      sequence: '1',
      chapterCount: 2,
      publishedAt: null,
      packaging: 'series',
      remote: {
        chapters: [
          { chapterId: '1', label: 'Chapter 1', sequence: '1' },
          { chapterId: '2', label: 'Chapter 2', sequence: '2' },
        ],
      },
    };
    const { runner, client, importer, items } = setup();
    client.pollUnit.mockImplementation(async (_conn: unknown, handle: { unitKey: string }) =>
      handle.unitKey === '2' ? { state: 'failed', reason: 'internal engine detail' } : { state: 'done' },
    );

    await runner.runJob(job({ packaging: 'series', engineState: { units: [grouped] } }));

    expect(items[0]).toMatchObject({ status: 'failed', error: 'Saga: Chapter 2 could not be downloaded.' });
    expect(importer.importUnit).not.toHaveBeenCalled();
    expect(importer.cleanupUnitWorkDir).toHaveBeenCalledWith(1, items[0]!.id);
  });

  it('keeps downloaded grouped members across a restart and resumes at the first missing chapter', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'web-serial-runner-'));
    try {
      await writeFile(join(workDir, 'chapter-0001.cbz'), 'already downloaded');
      const grouped: EngineUnitSpec = {
        unitKey: 'vol:1',
        label: 'Volume 1',
        sequence: '1',
        chapterCount: 2,
        publishedAt: null,
        packaging: 'volume',
        remote: {
          chapters: [
            { chapterId: '1', label: 'Chapter 1', sequence: '1' },
            { chapterId: '2', label: 'Chapter 2', sequence: '2' },
          ],
        },
      };
      const { runner, client } = setup({ workDir });

      await runner.runJob(job({ packaging: 'volume', engineState: { units: [grouped] } }));

      expect(client.startUnit).toHaveBeenCalledTimes(1);
      expect(client.startUnit.mock.calls[0]![2].remote.chapterId).toBe('2');
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

describe('WebSerialsJobRunnerService review fixes', () => {
  const sleeps = (runner: unknown) => (runner as { sleep: Mock<(ms: number) => Promise<void>> }).sleep;
  const oneChapter = () => job({ selection: { mode: 'range', fromSequence: '1', toSequence: '1' } });
  const groupedUnit = (chapters: number, packaging: 'volume' | 'series' = 'volume'): EngineUnitSpec => ({
    unitKey: 'vol:1',
    label: 'Volume 1',
    sequence: '1',
    chapterCount: chapters,
    publishedAt: null,
    packaging,
    remote: {
      chapters: Array.from({ length: chapters }, (_, index) => ({
        chapterId: String(index + 1),
        label: `Chapter ${index + 1}`,
        sequence: String(index + 1),
      })),
    },
  });

  it('removes the work folder of a job that ended cancelled or completed, and keeps a paused or failed job folder for the resume', async () => {
    const cancelled = setup();
    cancelled.repo.getJobStatus.mockResolvedValue('cancelled');
    await cancelled.runner.runJob(job());
    expect(cancelled.importer.removeJobWorkDir).toHaveBeenCalledWith(1);

    const paused = setup();
    paused.repo.getJobStatus.mockResolvedValue('paused');
    await paused.runner.runJob(job());
    expect(paused.importer.removeJobWorkDir).not.toHaveBeenCalled();

    const failed = setup();
    failed.client.getSeries.mockRejectedValue(new Error('engine down'));
    failed.repo.getJobStatus.mockResolvedValue('failed');
    await failed.runner.runJob(job());
    expect(failed.importer.removeJobWorkDir).not.toHaveBeenCalled();

    const gapped = setup();
    gapped.repo.getJobStatus.mockResolvedValue('completed_with_gaps');
    await gapped.runner.runJob(job());
    expect(gapped.importer.removeJobWorkDir).not.toHaveBeenCalled();

    const completed = setup();
    completed.repo.getJobStatus.mockResolvedValue('completed');
    await completed.runner.runJob(job());
    expect(completed.importer.removeJobWorkDir).toHaveBeenCalledWith(1);
  });

  it('records a unit whose book is already filed as skipped and writes the ledger instead of failing it', async () => {
    const { runner, repo, importer, items } = setup();
    importer.importUnit.mockRejectedValueOnce(new DuplicateBookError(77)).mockResolvedValue(600);

    await runner.runJob(job());

    expect(items[0]).toMatchObject({ status: 'skipped', bookId: 77 });
    expect(repo.recordImports).toHaveBeenCalledWith([expect.objectContaining({ unitKey: 'c1', bookId: 77 })]);
    expect(finalTransition(repo)[2]).toMatchObject({ status: 'completed' });
  });

  it('runs again when an item was re-armed just before the final transition', async () => {
    const { runner, repo, items, importer } = setup();
    let strandedAdded = false;
    repo.transitionJob.mockImplementation(async (_id: number, _from: unknown, values: { finishedAt?: Date }) => {
      if (values.finishedAt && !strandedAdded) {
        strandedAdded = true;
        items.push({
          id: 900,
          jobId: 1,
          unitKey: 'c9',
          label: 'Chapter 9',
          sequence: '9',
          status: 'pending',
          bookId: null,
          error: null,
          remoteRef: { unit: unit(9), handle: null },
        } as unknown as WebSerialJobItemRow);
        return undefined;
      }
      return { id: 1 };
    });

    await runner.runJob(oneChapter());

    expect(items.find((item) => item.unitKey === 'c9')!.status).toBe('imported');
    expect(importer.importUnit).toHaveBeenCalledTimes(2);
    expect(finalTransition(repo)[2]).toMatchObject({ status: 'completed' });
  });

  it('does not import when the job was cancelled, paused or re-queued while the unit downloaded', async () => {
    const { runner, repo, client, importer } = setup();
    const cancelUnit = vi.fn().mockResolvedValue(undefined);
    (client as Record<string, unknown>)['cancelUnit'] = cancelUnit;
    repo.transitionJob.mockImplementation(async (_id: number, _from: unknown, values: { status?: string }) =>
      values.status === 'importing' ? undefined : { id: 1 },
    );
    repo.getJobStatus.mockResolvedValueOnce('running').mockResolvedValueOnce('running').mockResolvedValue('cancelled');

    await runner.runJob(oneChapter());

    expect(importer.importUnit).not.toHaveBeenCalled();
    expect(cancelUnit).toHaveBeenCalledTimes(1);
  });

  it('stops a run whose job was paused and resumed under it', async () => {
    const { runner, repo, importer } = setup();
    repo.getJobStatus.mockResolvedValueOnce('running').mockResolvedValueOnce('running').mockResolvedValue('queued');
    repo.transitionJob.mockImplementation(async (_id: number, _from: unknown, values: { finishedAt?: Date }) =>
      values.finishedAt ? undefined : { id: 1 },
    );

    await runner.runJob(job());

    expect(importer.importUnit).toHaveBeenCalledTimes(1);
  });

  describe('setup failures', () => {
    it('waits out an engine that cannot be reached instead of failing the job', async () => {
      const { runner, repo, client, items } = setup();
      client.getSeries.mockRejectedValueOnce(new ServiceUnavailableException('The download service could not be reached')).mockResolvedValue(series);

      await runner.runJob(oneChapter());

      expect(client.getSeries).toHaveBeenCalledTimes(2);
      expect(items[0]!.status).toBe('imported');
      const messages = repo.transitionJob.mock.calls.map((call) => (call[2] as { message?: string | null }).message).filter((m) => m);
      expect(messages).toContain('Waiting to retry: The download service is not reachable. Next try in 2 minutes.');
      expect(finalTransition(repo)[2]).toMatchObject({ status: 'completed' });
    });

    it('waits out a source failure of a resumed job that already has items, whatever its reason', async () => {
      const resumed = {
        id: 100,
        jobId: 1,
        unitKey: 'c1',
        label: 'Chapter 1',
        sequence: '1',
        status: 'pending',
        bookId: null,
        error: null,
        remoteRef: { unit: unit(1), handle: null },
      };
      const { runner, repo, client, items } = setup({ existingItems: [resumed as unknown as WebSerialJobItemRow] });
      client.getSeries
        .mockRejectedValueOnce(new BadGatewayException('The remote service could not complete the GraphQL request'))
        .mockResolvedValue(series);

      await runner.runJob(oneChapter());

      expect(client.getSeries).toHaveBeenCalledTimes(2);
      expect(items[0]!.status).toBe('imported');
      expect(finalTransition(repo)[2]).toMatchObject({ status: 'completed' });
    });

    it('still fails a new job at once when its setup fails for a reason that is not worth waiting for', async () => {
      const { runner, repo, client } = setup();
      client.getSeries.mockRejectedValue(new BadGatewayException('The remote service could not complete the GraphQL request'));

      await runner.runJob(oneChapter());

      expect(client.getSeries).toHaveBeenCalledTimes(1);
      expect(finalTransition(repo)[2]).toMatchObject({ status: 'failed' });
    });

    it('fails the job once the setup retries are used up', async () => {
      const { runner, repo, client } = setup();
      client.getSeries.mockRejectedValue(new ServiceUnavailableException('The download service could not be reached'));

      await runner.runJob(oneChapter());

      expect(client.getSeries).toHaveBeenCalledTimes(3);
      expect(finalTransition(repo)[2]).toMatchObject({ status: 'failed' });
    });
  });

  it('stops downloading the members of one book as soon as the running size passes the cap', async () => {
    const { runner, client, importer, items } = setup();
    importer.saveWorkDownload.mockResolvedValue(900 * 1024 * 1024);

    await runner.runJob(job({ packaging: 'series', engineState: { units: [groupedUnit(5, 'series')] } }));

    expect(client.startUnit).toHaveBeenCalledTimes(3);
    expect(mergeCbzChapters).not.toHaveBeenCalled();
    expect(items[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('larger than the allowed size') });
  });

  it('cancels the engine handle started in the attempt that failed, and keeps the stored member state', async () => {
    const { runner, client, items } = setup();
    const cancelUnit = vi.fn().mockResolvedValue(undefined);
    (client as Record<string, unknown>)['cancelUnit'] = cancelUnit;
    client.pollUnit.mockResolvedValueOnce({ state: 'failed', reason: 'The chapter download failed' }).mockResolvedValue({ state: 'done' });

    await runner.runJob(oneChapter());

    expect(cancelUnit).toHaveBeenCalledWith(CONN, { unitKey: 'c1', remote: { chapterId: '1', started: true } });
    expect(items[0]!.status).toBe('imported');
  });

  it('does not make a manually retried item wait behind the earliest deferred retry', async () => {
    const { runner, client, items } = setup();
    client.pollUnit.mockResolvedValueOnce({ state: 'failed', reason: 'The chapter download failed' }).mockResolvedValue({ state: 'done' });
    const sleepsBeforeSecond = { count: -1 };
    client.startUnit.mockImplementation(async (_conn: unknown, _id: string, spec: EngineUnitSpec) => {
      if (spec.unitKey === 'c2') sleepsBeforeSecond.count = sleeps(runner).mock.calls.length;
      return { unitKey: spec.unitKey, remote: { ...spec.remote, started: true } };
    });
    let calls = 0;
    const advanceClock = sleeps(runner).getMockImplementation()!;
    sleeps(runner).mockImplementation((ms: number) => {
      const advanced = advanceClock(ms);
      calls += 1;
      if (calls === 2) {
        items.push({
          id: 901,
          jobId: 1,
          unitKey: 'c2',
          label: 'Chapter 2',
          sequence: '2',
          status: 'pending',
          bookId: null,
          error: null,
          remoteRef: { unit: unit(2), handle: null },
        } as unknown as WebSerialJobItemRow);
      }
      return advanced;
    });

    await runner.runJob(oneChapter());

    expect(sleepsBeforeSecond.count).toBeLessThanOrEqual(3);
    expect(items.map((item) => item.status)).toEqual(['imported', 'imported']);
  });

  it('names volumes and books in the failure and wait messages of grouped packagings', async () => {
    const volumes = setup();
    volumes.client.pollUnit.mockResolvedValue({ state: 'failed', reason: 'internal engine detail' });
    await volumes.runner.runJob(job({ packaging: 'volume', engineState: { units: [groupedUnit(1)] } }));
    expect(finalTransition(volumes.repo)[2]).toMatchObject({ message: '1 volume could not be downloaded from MangaSource.' });

    const book = setup();
    book.client.pollUnit.mockResolvedValue({ state: 'failed', reason: 'internal engine detail' });
    await book.runner.runJob(job({ packaging: 'series', engineState: { units: [groupedUnit(1, 'series')] } }));
    expect(finalTransition(book.repo)[2]).toMatchObject({ message: '1 book could not be downloaded from MangaSource.' });
  });

  it('builds the failure summary from every failed item of the job, not just this run', async () => {
    const earlier = {
      id: 9,
      jobId: 1,
      unitKey: 'c1',
      label: 'Chapter 1',
      sequence: '1',
      status: 'failed',
      bookId: null,
      error: 'Chapter 1: MangaSource no longer has this chapter.',
      remoteRef: { unit: unit(1), handle: null, failureReason: 'not_found' },
    } as unknown as WebSerialJobItemRow;
    const pending = {
      id: 10,
      jobId: 1,
      unitKey: 'c2',
      label: 'Chapter 2',
      sequence: '2',
      status: 'pending',
      bookId: null,
      error: null,
      remoteRef: { unit: unit(2), handle: null },
    } as unknown as WebSerialJobItemRow;
    const { runner, repo, client } = setup({ existingItems: [earlier, pending] });
    client.pollUnit.mockResolvedValue({ state: 'failed', reason: 'HTTP 404 not found' });

    await runner.runJob(job());

    expect(finalTransition(repo)[2]).toMatchObject({
      status: 'failed',
      message: '2 chapters could not be downloaded: MangaSource no longer has this chapter.',
    });
  });

  it('stores only the member marker while a grouped unit downloads, never the whole unit description', async () => {
    const { runner, repo, items } = setup();

    await runner.runJob(job({ packaging: 'volume', engineState: { units: [groupedUnit(2)] } }));

    const itemId = items[0]!.id;
    expect(repo.setItemMember.mock.calls.map((call) => call[1])).toEqual([
      { index: 0, handle: expect.objectContaining({ started: true }) },
      null,
      { index: 1, handle: expect.objectContaining({ started: true }) },
      null,
    ]);
    expect(repo.setItemMember.mock.calls.every((call) => call[0] === itemId)).toBe(true);
    const rewrites = repo.updateItem.mock.calls.filter((call) => call[0] === itemId && 'remoteRef' in (call[1] as object));
    expect(rewrites).toHaveLength(0);
  });

  it('caps a single manga chapter at 500 MB but leaves novels on their own cap', async () => {
    const manga = setup();
    await manga.runner.runJob(oneChapter());
    expect(manga.importer.importUnit).toHaveBeenCalledWith(expect.objectContaining({ maxBytes: 500 * 1024 * 1024 }));

    const novel = setup();
    novel.client.getSeries.mockResolvedValue({ ...series, kind: 'novel' } as EngineSeries);
    await novel.runner.runJob(job({ kind: 'novel', seriesKey: 'n:5', packaging: 'volume', selection: { mode: 'all' } }));
    expect(novel.importer.importUnit).toHaveBeenCalled();
    expect(novel.importer.importUnit.mock.calls[0]![0]).not.toHaveProperty('maxBytes');
  });

  it('logs a scheduled retry as a fail with the retry fields, never as a retry phase', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { runner, client } = setup();
    client.pollUnit.mockResolvedValueOnce({ state: 'failed', reason: 'The chapter download failed' }).mockResolvedValue({ state: 'done' });

    await runner.runJob(oneChapter());

    const lines = warn.mock.calls.map((call) => call[0] as string);
    expect(lines.some((line) => line.includes('[retry]'))).toBe(false);
    expect(lines).toContainEqual(
      expect.stringMatching(
        /\[web_serials\.job_item\] \[fail\] jobId=1 itemId=\d+ unitKey="c1" durationMs=\d+ .*retryScheduled=true attempt=1 delayMs=120000/,
      ),
    );
  });

  it('classifies a filing failure as unknown, so it never reads as the source missing the chapter', async () => {
    const { runner, client, importer, items } = setup();
    importer.importUnit.mockRejectedValue(new ImportStageError('Book Dock file not found', new Error('x')));

    await runner.runJob(oneChapter());

    expect(client.startUnit).toHaveBeenCalledTimes(1);
    expect(items[0]).toMatchObject({ status: 'failed', error: 'Chapter 1: Book Dock file not found' });
  });

  it('polls quickly at first and backs off to the steady interval', async () => {
    const { runner, client } = setup();
    client.pollUnit
      .mockResolvedValueOnce({ state: 'running', progress: 0.1 })
      .mockResolvedValueOnce({ state: 'running', progress: 0.2 })
      .mockResolvedValueOnce({ state: 'running', progress: 0.3 })
      .mockResolvedValueOnce({ state: 'running', progress: 0.4 })
      .mockResolvedValueOnce({ state: 'running', progress: 0.5 })
      .mockResolvedValueOnce({ state: 'running', progress: 0.6 })
      .mockResolvedValueOnce({ state: 'running', progress: 0.7 })
      .mockResolvedValue({ state: 'done' });

    await runner.runJob(oneChapter());

    expect(sleeps(runner).mock.calls.map((call: number[]) => call[0])).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000]);
  });

  it('retries a unit whose engine job vanished instead of reporting the chapter as gone', async () => {
    const { runner, client, items } = setup();
    client.pollUnit
      .mockRejectedValueOnce(new BadGatewayException('The remote service rejected the request with status 404'))
      .mockResolvedValue({ state: 'done' });

    await runner.runJob(oneChapter());

    expect(client.startUnit).toHaveBeenCalledTimes(2);
    expect(items[0]!.status).toBe('imported');
  });
});

describe('WebSerialsJobRunnerService round 2 fixes', () => {
  const oneChapter = () => job({ selection: { mode: 'range', fromSequence: '1', toSequence: '1' } });

  it('hands a unit back when a pause is resumed before the run notices, so the next run never reuses the cancelled engine job', async () => {
    const { runner, repo, client, items } = setup();
    const cancelled = new Set<string>();
    let seq = 0;
    (client as Record<string, unknown>)['cancelUnit'] = vi.fn(async (_c: unknown, handle: { remote: { jobId: string } }) => {
      cancelled.add(handle.remote.jobId);
    });
    client.startUnit.mockImplementation(async (_c: unknown, _id: string, spec: EngineUnitSpec) => ({
      unitKey: spec.unitKey,
      remote: { jobId: `j${++seq}` },
    }));
    let polls = 0;
    client.pollUnit.mockImplementation(async (_c: unknown, handle: { remote: { jobId: string } }) => {
      if (cancelled.has(handle.remote.jobId)) return { state: 'failed', reason: 'The download was cancelled' };
      polls += 1;
      return polls === 1 ? { state: 'running', progress: 0.1 } : { state: 'done' };
    });
    let requeued = true;
    repo.getJobStatus.mockImplementation(async () => (requeued && polls >= 1 ? 'queued' : 'running'));

    await runner.runJob(oneChapter());
    requeued = false;
    expect(items[0]).toMatchObject({ status: 'pending', remoteRef: { handle: null } });

    await runner.runJob(oneChapter());
    expect(items[0]!.status).toBe('imported');
    expect(client.startUnit).toHaveBeenCalledTimes(2);
  });

  it('hands a grouped unit back with its member dropped when the run is stopped', async () => {
    const { runner, repo, client, items } = setup();
    (client as Record<string, unknown>)['cancelUnit'] = vi.fn().mockResolvedValue(undefined);
    client.pollUnit.mockResolvedValue({ state: 'running', progress: 0.2 });
    let checks = 0;
    repo.getJobStatus.mockImplementation(async () => (++checks > 4 ? 'queued' : 'running'));
    const volume: EngineUnitSpec = {
      unitKey: 'vol:1',
      label: 'Volume 1',
      sequence: '1',
      chapterCount: 2,
      publishedAt: null,
      packaging: 'volume',
      remote: {
        chapters: [
          { chapterId: '1', label: 'Chapter 1', sequence: '1' },
          { chapterId: '2', label: 'Chapter 2', sequence: '2' },
        ],
      },
    };

    await runner.runJob(job({ packaging: 'volume', engineState: { units: [volume] } }));

    expect(items[0]).toMatchObject({ status: 'pending', remoteRef: { member: null } });
  });

  it('names the unit noun in a summary that states a shared reason', async () => {
    const { runner, repo, client } = setup();
    client.pollUnit.mockResolvedValue({ state: 'failed', reason: 'HTTP error 404' });
    await runner.runJob(
      job({
        packaging: 'volume',
        engineState: {
          units: [
            {
              unitKey: 'vol:1',
              label: 'Volume 1',
              sequence: '1',
              chapterCount: 1,
              publishedAt: null,
              packaging: 'volume',
              remote: { chapters: [{ chapterId: '1', label: 'Chapter 1', sequence: '1' }] },
            },
          ],
        },
      }),
    );

    expect(finalTransition(repo)[2]).toMatchObject({ message: '1 volume could not be downloaded: MangaSource no longer has this volume.' });
  });

  it('stops the whole job once when the engine rejects its credentials, leaving the units pending', async () => {
    const { runner, repo, client, items, notifications } = setup();
    client.startUnit.mockRejectedValue(new EngineCredentialsRejectedException());

    await runner.runJob(job());

    expect(client.startUnit).toHaveBeenCalledTimes(1);
    expect(items.map((item) => item.status)).toEqual(['pending', 'pending', 'pending']);
    expect(finalTransition(repo)[2]).toMatchObject({
      status: 'failed',
      message: 'The download service rejected its credentials. Ask an admin to check the connection settings.',
    });
    expect(notifications.upsertByGroupKey).toHaveBeenCalledTimes(1);
  });

  it('fails a job whose source the admin has disabled since it was queued, without retrying', async () => {
    const { runner, repo, client, items } = setup();
    sourceAllowed.mockReturnValue(false);

    await runner.runJob(job());

    expect(finalTransition(repo)[2]).toMatchObject({
      status: 'failed',
      message: 'MangaSource is no longer an enabled source. Ask an admin to enable it, then retry.',
    });
    expect(client.startUnit).not.toHaveBeenCalled();
    expect(items).toHaveLength(0);
  });

  it('does not check the manga source selection for a novel, nor a source for a lightnovel-crawler novel', async () => {
    const { runner } = setup();
    sourceAllowed.mockReturnValue(false);
    novelSourceAllowed.mockReturnValue(false);

    await runner.runJob(job({ kind: 'novel', seriesKey: 'n:5', packaging: 'volume' }));

    expect(sourceAllowed).not.toHaveBeenCalled();
    expect(novelSourceAllowed).not.toHaveBeenCalled();
  });

  it('fails an LNReader job whose site the admin has disabled since it was queued', async () => {
    const { runner, repo, client, items } = setup();
    novelSourceAllowed.mockReturnValue(false);

    await runner.runJob(job({ kind: 'novel', seriesKey: 'nl:src:abc', packaging: 'volume', sourceName: 'Alpha Novels' }));

    expect(novelSourceAllowed).toHaveBeenCalledWith('src:abc', undefined);
    expect(finalTransition(repo)[2]).toMatchObject({
      status: 'failed',
      message: 'Alpha Novels is no longer an enabled source. Ask an admin to enable it, then retry.',
    });
    expect(client.getSeries).not.toHaveBeenCalled();
    expect(client.startUnit).not.toHaveBeenCalled();
    expect(items).toHaveLength(0);
  });

  it.each([
    ['paused', (runner: WebSerialsJobRunnerService) => runner.interruptChapterFetch(1)],
    ['cancelled', (runner: WebSerialsJobRunnerService) => runner.abortJob(1)],
    ['shut down', (runner: WebSerialsJobRunnerService) => void runner.onModuleDestroy()],
  ])('releases its slot at once when %s while the chapter list still loads', async (_name, stop) => {
    const { runner, repo, client, notifications } = setup();
    let loadSignal: AbortSignal | undefined;
    client.getSeries.mockImplementation(
      (_conn: unknown, _id: string, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          loadSignal = options.signal;
          options.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        }),
    );

    const running = runner.runJob(job());
    await vi.waitFor(() => expect(loadSignal).toBeDefined());
    stop(runner);
    await running;

    expect(loadSignal!.aborted).toBe(true);
    expect(repo.transitionJob).not.toHaveBeenCalled();
    expect(notifications.upsertByGroupKey).not.toHaveBeenCalled();
    expect(repo.insertItems).not.toHaveBeenCalled();
  });
});

describe('WebSerialsJobRunnerService engine integration', () => {
  it('passes its shutdown signal to the download and does not retry rejected credentials', async () => {
    const { runner, client, items } = setup();
    await runner.runJob(job({ selection: { mode: 'range', fromSequence: '1', toSequence: '1' } }));
    expect(client.download).toHaveBeenCalledWith(CONN, expect.anything(), expect.any(AbortSignal));
    expect(items[0]!.status).toBe('imported');

    const rejected = setup();
    rejected.client.startUnit.mockRejectedValue(new EngineCredentialsRejectedException());
    await rejected.runner.runJob(job({ selection: { mode: 'range', fromSequence: '1', toSequence: '1' } }));
    expect(rejected.client.startUnit).toHaveBeenCalledTimes(1);
    expect(rejected.items[0]).toMatchObject({ status: 'pending' });
  });

  it('retries a stream that stalled and surfaced as a gateway timeout', async () => {
    const { runner, client, items } = setup();
    client.download.mockRejectedValueOnce(new GatewayTimeoutException('The remote service did not answer in time'));
    await runner.runJob(job({ selection: { mode: 'range', fromSequence: '1', toSequence: '1' } }));
    expect(client.startUnit).toHaveBeenCalledTimes(2);
    expect(items[0]!.status).toBe('imported');
  });

  it('clears the current unit before it waits for a deferred retry', async () => {
    const { runner, repo, client } = setup();
    client.pollUnit
      .mockResolvedValueOnce({ state: 'running', progress: 0.5 })
      .mockResolvedValueOnce({ state: 'failed', reason: 'The chapter download failed' })
      .mockResolvedValue({ state: 'done' });
    await runner.runJob(job({ selection: { mode: 'range', fromSequence: '1', toSequence: '1' } }));

    const running = repo.setCurrentUnit.mock.calls.findIndex((call) => call[1] !== null);
    const cleared =
      repo.setCurrentUnit.mock.invocationCallOrder[repo.setCurrentUnit.mock.calls.findIndex((call, index) => index > running && call[1] === null)]!;
    expect(running).toBeGreaterThanOrEqual(0);
    expect(cleared).toBeLessThan(client.startUnit.mock.invocationCallOrder[1]!);
  });

  it('aborts the download signal when the job is cancelled and neither retries nor fails the unit', async () => {
    const { runner, client, items } = setup();
    let seen: AbortSignal | undefined;
    client.download.mockImplementationOnce(async (_conn: unknown, _handle: unknown, signal: AbortSignal) => {
      seen = signal;
      runner.abortJob(1);
      throw new DOMException('aborted', 'AbortError');
    });

    await runner.runJob(job({ selection: { mode: 'range', fromSequence: '1', toSequence: '1' } }));

    expect(seen?.aborted).toBe(true);
    expect(client.startUnit).toHaveBeenCalledTimes(1);
    expect(items[0]!.status).not.toBe('failed');
  });

  it('lets an engine download that is already importing finish when the job is paused or moved', async () => {
    const { runner, client, items } = setup();
    let seen: AbortSignal | undefined;
    client.download.mockImplementationOnce(async (_conn: unknown, _handle: unknown, signal: AbortSignal) => {
      seen = signal;
      runner.interruptChapterFetch(1);
      return { stream: null, fileName: 'c.cbz', format: 'cbz', size: 1 };
    });

    await runner.runJob(job({ selection: { mode: 'range', fromSequence: '1', toSequence: '1' } }));

    expect(seen?.aborted).toBe(false);
    expect(items[0]!.status).toBe('imported');
  });

  it('writes no current unit while waiting for a deferred retry', async () => {
    const { runner, repo, client } = setup();
    client.pollUnit.mockResolvedValueOnce({ state: 'failed', reason: 'The chapter download failed' }).mockResolvedValue({ state: 'done' });
    await runner.runJob(job({ selection: { mode: 'range', fromSequence: '1', toSequence: '1' } }));
    expect(
      repo.setCurrentUnit.mock.calls.some(
        (call) => call[1] !== null && (call[1] as { stage: string }).stage === 'fetching' && (call[1] as { progress: unknown }).progress === null,
      ),
    ).toBe(false);
  });
});

describe('WebSerialsJobRunnerService.tick', () => {
  it('claims queued jobs up to the free capacity and runs each once', async () => {
    const { runner, repo } = setup();
    repo.findQueuedJobs.mockResolvedValue([job({ id: 1 }), job({ id: 2 })]);
    repo.claimQueuedJob.mockImplementation(async (id: number) => (id === 2 ? undefined : job({ id })));
    const run = vi.spyOn(runner, 'runJob').mockResolvedValue(undefined);

    await runner.tick();

    expect(repo.findQueuedJobs).toHaveBeenCalledWith(2);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it('claims nothing while an admin has paused the queue', async () => {
    const { runner, repo, settings } = setup();
    settings.isQueuePaused.mockResolvedValue(true);

    await runner.tick();

    expect(repo.findQueuedJobs).not.toHaveBeenCalled();
    expect(repo.claimQueuedJob).not.toHaveBeenCalled();
  });

  it('does nothing while every slot is taken', async () => {
    const { runner, repo, settings } = setup();
    settings.getMaxConcurrentJobs.mockResolvedValue(1);
    (runner as unknown as { active: Map<number, Promise<void>> }).active.set(1, new Promise(() => undefined));

    await runner.tick();

    expect(repo.findQueuedJobs).not.toHaveBeenCalled();
  });

  it("files into the library's first folder when the job's folder is gone", async () => {
    const { runner, importer } = setup({ folders: [{ id: 9, path: '/b' }] });
    await runner.runJob(job({ targetFolderId: null }));
    expect(importer.importUnit).toHaveBeenCalledWith(expect.objectContaining({ targetFolderId: 9 }));
  });
});

describe('WebSerialsJobRunnerService.waitForJobToSettle', () => {
  it('waits for an active job and reports a timeout without blocking', async () => {
    vi.useFakeTimers();
    try {
      const { runner } = setup();
      let finish!: () => void;
      const active = new Promise<void>((resolve) => {
        finish = resolve;
      });
      (runner as unknown as { active: Map<number, Promise<void>> }).active.set(1, active);

      const settled = runner.waitForJobToSettle(1, 1000);
      finish();
      await expect(settled).resolves.toBe(true);

      (runner as unknown as { active: Map<number, Promise<void>> }).active.set(2, new Promise(() => undefined));
      const timedOut = runner.waitForJobToSettle(2, 1000);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(timedOut).resolves.toBe(false);
      await expect(runner.waitForJobToSettle(3, 1000)).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('WebSerialsJobRunnerService engine cleanup', () => {
  const groupedVolume: EngineUnitSpec = {
    unitKey: 'vol:1',
    label: 'Volume 1',
    sequence: '1',
    chapterCount: 2,
    publishedAt: null,
    packaging: 'volume',
    remote: {
      chapters: [
        { chapterId: '11', label: 'Chapter 1', sequence: '1' },
        { chapterId: '12', label: 'Chapter 2', sequence: '2' },
      ],
    },
  };

  it('removes the engine copy of each imported unit', async () => {
    const { runner, client } = setup();

    await runner.runJob(job());

    expect(client.discardUnit).toHaveBeenCalledTimes(3);
    expect(client.discardUnit).toHaveBeenNthCalledWith(1, CONN, [{ unitKey: 'c1', remote: { chapterId: '1' } }]);
  });

  it('removes every member chapter of a grouped unit in one call', async () => {
    const { runner, client } = setup();

    await runner.runJob(job({ packaging: 'volume', engineState: { units: [groupedVolume] } }));

    expect(client.discardUnit).toHaveBeenCalledTimes(1);
    expect(client.discardUnit).toHaveBeenCalledWith(CONN, [
      { unitKey: '11', remote: { chapterId: '11' } },
      { unitKey: '12', remote: { chapterId: '12' } },
    ]);
  });

  it('removes the engine copy of a unit skipped as a duplicate', async () => {
    const { runner, client, importer, items } = setup();
    importer.importUnit.mockRejectedValueOnce(new DuplicateBookError(77)).mockResolvedValue(600);

    await runner.runJob(job());

    expect(items[0]).toMatchObject({ status: 'skipped' });
    expect(client.discardUnit).toHaveBeenCalledWith(CONN, [{ unitKey: 'c1', remote: { chapterId: '1' } }]);
  });

  it('keeps the engine copy of a failed unit so a retry can reuse it', async () => {
    const { runner, client, importer } = setup();
    importer.importUnit.mockRejectedValue(new Error('dock refused'));

    await runner.runJob(job());

    expect(client.discardUnit).not.toHaveBeenCalled();
  });

  it('does not touch units skipped before any download', async () => {
    const { runner, client } = setup({ imported: ['c1', 'c2', 'c3'] });

    await runner.runJob(job());

    expect(client.discardUnit).not.toHaveBeenCalled();
  });

  it('logs a failing cleanup and still counts the unit as imported', async () => {
    const { runner, client, items } = setup();
    client.discardUnit.mockRejectedValue(new Error('suwayomi down'));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await runner.runJob(job());

    expect(items.map((item) => item.status)).toEqual(['imported', 'imported', 'imported']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[web_serials.engine_cleanup] [fail] jobId=1 itemId='));
  });

  it('does nothing for an engine without cleanup support', async () => {
    const { runner, client, items } = setup();
    delete (client as { discardUnit?: unknown }).discardUnit;

    await runner.runJob(job());

    expect(items.map((item) => item.status)).toEqual(['imported', 'imported', 'imported']);
  });
});

describe('WebSerialsJobRunnerService LNReader volumes', () => {
  const volume = (sequence: number, chapters: number, unitKey = `volume-${sequence}`): EngineUnitSpec => ({
    unitKey,
    label: `Volume ${sequence}`,
    sequence: String(sequence),
    chapterCount: chapters,
    publishedAt: null,
    packaging: 'volume',
    remote: { sourceId: 'src', chapterPaths: [] },
  });
  const novelJob = () => job({ kind: 'novel', seriesKey: 'nl:src:abc', packaging: 'volume', title: 'Novel' });
  const epub = { stream: null, fileName: 'v.epub', format: 'epub', size: 1 };

  function novelSetup(units: EngineUnitSpec[], attempts?: number) {
    const existingItems =
      attempts === undefined
        ? undefined
        : units.map(
            (unit, index) =>
              ({
                id: 100 + index,
                jobId: 1,
                unitKey: unit.unitKey,
                label: unit.label,
                sequence: unit.sequence,
                status: 'pending',
                bookId: null,
                error: null,
                remoteRef: { unit, handle: null, attempts },
              }) as unknown as WebSerialJobItemRow,
          );
    const context = setup({ existingItems });
    Object.assign(context.client, { requiresUnitWorkDir: true });
    context.client.getSeries.mockResolvedValue({ ...series, kind: 'novel', units } as EngineSeries);
    return context;
  }

  it('opens the series for a download in the bulk lane of the engine', async () => {
    const { runner, client } = novelSetup([volume(1, 100)]);
    client.download.mockResolvedValue(epub);

    await runner.runJob(novelJob());

    expect(client.getSeries).toHaveBeenCalledWith(CONN, 'src:abc', { priority: 'bulk', signal: expect.any(AbortSignal) });
  });

  it('stops a volume download between chapters when the job is paused, and hands the unit back unimported', async () => {
    const { runner, repo, client, importer, items } = novelSetup([volume(1, 100)]);
    let downloading = false;
    repo.getJobStatus.mockImplementation(async () => (downloading ? 'paused' : 'running'));
    client.download.mockImplementation(
      async (_conn: unknown, _handle: unknown, _signal: unknown, _progress: unknown, options?: EngineDownloadOptions) => {
        downloading = true;
        if (await options?.shouldStop?.()) throw new UnitDownloadStopped();
        return epub;
      },
    );

    await runner.runJob(novelJob());

    expect(importer.importUnit).not.toHaveBeenCalled();
    expect(repo.releaseItem).toHaveBeenCalledWith(100);
    expect(items[0]!.status).toBe('pending');
  });

  it('stops the chapter in flight when the job is paused, hands the unit back without an attempt and keeps the work folder', async () => {
    const { runner, repo, client, importer, items } = novelSetup([volume(1, 100)]);
    let status = 'running';
    repo.getJobStatus.mockImplementation(async () => status);
    client.download.mockImplementation(
      (_conn: unknown, _handle: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')), { once: true });
          status = 'paused';
          runner.interruptChapterFetch(1);
        }),
    );

    await runner.runJob(novelJob());

    expect(importer.importUnit).not.toHaveBeenCalled();
    expect(repo.releaseInFlightItems).toHaveBeenCalledWith(1);
    expect(importer.removeJobWorkDir).not.toHaveBeenCalled();
    expect(items[0]!.status).not.toBe('failed');
    expect((items[0]!.remoteRef as { attempts?: number }).attempts ?? 0).toBe(0);
  });

  it('retries a volume with a missing chapter, then files it with a notice on the last attempt', async () => {
    const early = novelSetup([volume(1, 100)], 0);
    early.client.download.mockImplementation(
      async (_conn: unknown, _handle: unknown, _signal: unknown, _progress: unknown, options?: EngineDownloadOptions) => {
        if (!options?.allowMissingChapters) throw new MissingChaptersError(['Chapter 57']);
        return epub;
      },
    );
    early.repo.getJobStatus.mockResolvedValueOnce('running').mockResolvedValueOnce('running').mockResolvedValue('paused');
    await early.runner.runJob(novelJob());
    expect(early.importer.importUnit).not.toHaveBeenCalled();
    expect(early.items[0]).toMatchObject({
      status: 'pending',
      remoteRef: expect.objectContaining({ attempts: 1, retryReason: 'source_unavailable' }),
    });

    const last = novelSetup([volume(1, 100)], 2);
    last.client.download.mockImplementation(
      async (_conn: unknown, _handle: unknown, _signal: unknown, _progress: unknown, options?: EngineDownloadOptions) =>
        options?.allowMissingChapters ? { ...epub, missingChapters: ['Chapter 57'] } : Promise.reject(new MissingChaptersError(['Chapter 57'])),
    );
    await last.runner.runJob(novelJob());
    expect(last.items[0]).toMatchObject({ status: 'imported', error: 'Imported with gaps: Chapter 57 could not be downloaded.' });
  });

  it('fails a volume most of whose chapters are missing on the last attempt, saying so, and files nothing', async () => {
    const { runner, client, importer, items } = novelSetup([volume(1, 3)], 2);
    client.download.mockRejectedValue(new TooManyMissingChaptersError(['One', 'Two', 'Three'], 3));

    await runner.runJob(novelJob());

    expect(importer.importUnit).not.toHaveBeenCalled();
    expect(items[0]).toMatchObject({ status: 'failed', error: 'Volume 1: 3 of 3 chapters could not be fetched, too many to file this volume' });
  });

  it('ends a job whose volume was filed with missing chapters as completed with gaps, and says so', async () => {
    const { runner, repo, client, notifications } = novelSetup([volume(1, 100), volume(2, 100)], 2);
    client.download.mockImplementation(async (_conn: unknown, handle: { unitKey: string }) =>
      handle.unitKey === 'volume-2' ? { ...epub, missingChapters: ['Chapter 157'] } : epub,
    );

    await runner.runJob(novelJob());

    expect(finalTransition(repo)[2]).toMatchObject({ status: 'completed_with_gaps', message: '1 volume was added with missing chapters.' });
    expect(notifications.upsertByGroupKey).toHaveBeenCalledWith(
      7,
      'web-serial-job:1',
      expect.objectContaining({ type: 'web_serial_completed_with_gaps', message: '1 volume was added with missing chapters.' }),
      { markUnread: true },
    );
  });

  it('drops a volume work folder once its book is filed', async () => {
    const { runner, client, importer } = novelSetup([volume(1, 100)]);
    client.download.mockResolvedValue(epub);

    await runner.runJob(novelJob());

    expect(importer.cleanupUnitWorkDir).toHaveBeenCalledWith(1, 100);
  });

  it('fails a grown volume the library files where its shorter copy is, instead of taking the shorter book for it', async () => {
    const { runner, repo, client, importer, items } = novelSetup([volume(3, 100)]);
    client.download.mockResolvedValue(epub);
    importer.importUnit.mockRejectedValue(new DuplicateBookError(77));
    repo.findLedgerKeysForBook.mockResolvedValue(['volume-3:201-250']);

    await runner.runJob(novelJob());

    expect(repo.findLedgerKeysForBook).toHaveBeenCalledWith(7, 'nl:src:abc', 77);
    expect(items[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('shorter copy of this volume') });
    expect(repo.recordImports).not.toHaveBeenCalled();
  });

  it('titles a short last volume with its chapter range, so its grown copy is filed as a new book', async () => {
    const { runner, client, importer } = novelSetup([volume(1, 100), volume(2, 50, 'volume-2:101-150')]);
    client.download.mockResolvedValue(epub);

    await runner.runJob(novelJob());

    expect(importer.importUnit.mock.calls.map((call) => ((call as unknown[])[0] as { metadata: { title: string } }).metadata.title)).toEqual([
      'Saga, Volume 1',
      'Saga, Volume 2 (Chapters 101-150)',
    ]);
  });

  it('records the range of a short last volume in the ledger, so the full volume later is not taken as owned', async () => {
    const { runner, repo, client } = novelSetup([volume(1, 100), volume(2, 50, 'volume-2:101-150')]);
    client.download.mockResolvedValue(epub);

    await runner.runJob(novelJob());

    expect(repo.recordImports.mock.calls.map((call) => (call[0] as Array<{ unitKey: string; sequence: string }>)[0])).toEqual([
      expect.objectContaining({ unitKey: 'volume-1', sequence: '1', chapterFrom: 1, chapterTo: 100 }),
      expect.objectContaining({ unitKey: 'volume-2:101-150', sequence: '2', chapterFrom: 101, chapterTo: 150 }),
    ]);
  });
});
