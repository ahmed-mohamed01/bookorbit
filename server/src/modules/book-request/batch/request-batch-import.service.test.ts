import { chmod, mkdir, mkdtemp, realpath, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import type { BookRequestDownloadRow, BookRequestRow } from '../../../db/schema';
import { PathMappingService } from '../download-clients/path-mapping.service';
import { RequestImportService } from '../fulfillment/request-import.service';
import { RequestBatchImportService } from './request-batch-import.service';

function request(overrides: Partial<BookRequestRow> = {}): BookRequestRow {
  return {
    id: 7,
    userId: 3,
    title: 'Dune',
    targetLibraryId: 2,
    targetFolderId: 5,
    ...overrides,
  } as BookRequestRow;
}

function download(contentPath: string, overrides: Partial<BookRequestDownloadRow> = {}): BookRequestDownloadRow {
  return { id: 11, requestId: 7, downloadClientId: 1, contentPath, ...overrides } as BookRequestDownloadRow;
}

async function makeHarness(options: { useHardlinks?: boolean; stagesLocally?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bookorbit-import-')));
  const bookDockPath = join(root, 'dock');
  const appDataPath = join(root, 'app-data');
  /** What a mapped download client declares, and what the import may therefore read out of. */
  const downloadsPath = join(root, 'downloads');
  /** Where a direct fetch stages, which is that download's own containment root. */
  const directDownloadsPath = join(appDataPath, 'request-downloads');
  await mkdir(bookDockPath, { recursive: true });
  await mkdir(downloadsPath, { recursive: true });
  await mkdir(directDownloadsPath, { recursive: true });

  let nextDockId = 100;
  const dockRepo = {
    create: vi.fn().mockImplementation((data: Record<string, unknown>) => Promise.resolve({ id: nextDockId++, ...data })),
    createUnit: vi.fn().mockImplementation((data: Record<string, unknown>) => Promise.resolve({ id: nextDockId++, ...data })),
    findById: vi.fn().mockResolvedValue(undefined),
    findUnitFiles: vi.fn().mockResolvedValue([]),
    deleteById: vi.fn().mockResolvedValue(undefined),
    findByAbsolutePath: vi.fn().mockResolvedValue(undefined),
    findByUnitDirectory: vi.fn().mockResolvedValue(undefined),
  };
  const downloads = {
    update: vi.fn().mockResolvedValue(undefined),
    updateIf: vi.fn(),
    findById: vi.fn().mockResolvedValue(undefined),
    findContentFileCount: vi.fn().mockResolvedValue(null),
    findExtension: vi.fn().mockResolvedValue({ filesPendingSince: null, extendsExisting: false }),
    setFilesPendingSince: vi.fn().mockResolvedValue(undefined),
  };
  // Conditional like the repository it stands for, because the choice import claims the attempt
  // with it: a mock that always answers would let two passes both believe they hold the same one.
  downloads.updateIf.mockImplementation(async (id: number, expected: readonly string[], patch: Record<string, unknown>) => {
    const row = (await downloads.findById(id)) as { status: string } | undefined;
    return row && expected.includes(row.status) ? { ...row, ...patch } : undefined;
  });
  const requests = {
    findById: vi.fn().mockResolvedValue({ request: request() }),
    findRequestViewerIds: vi.fn().mockResolvedValue(new Map([[7, [3]]])),
    update: vi.fn().mockResolvedValue(undefined),
    updateIf: vi.fn().mockImplementation((id: number, _expected: unknown, patch: Record<string, unknown>) => Promise.resolve({ id, ...patch })),
  };
  const gateway = { emitProgress: vi.fn(), emitChanged: vi.fn() };
  const fulfillment = { failDownload: vi.fn().mockResolvedValue(undefined), holdForReview: vi.fn().mockResolvedValue(undefined) };
  const dockIngest = { ingestFromWatchedFolder: vi.fn().mockResolvedValue(null) };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const removal = {
    cleanupStagedDirectDownload: vi.fn().mockResolvedValue(undefined),
    cleanupStagedClientDownload: vi.fn().mockResolvedValue(undefined),
    removeCompletedDownload: vi.fn().mockResolvedValue(undefined),
  };
  // The real containment check over a stubbed mapping, so these tests exercise the boundary the
  // importer actually applies rather than a mock that always agrees with it.
  const pathMappings = new PathMappingService({
    findPathMappings: vi.fn().mockResolvedValue([{ remotePath: downloadsPath, localPath: downloadsPath }]),
  } as never);
  vi.spyOn(pathMappings, 'assertWithinRoot');

  const batches = {
    findKinds: vi.fn().mockResolvedValue(new Map([[7, 'single']])),
    findUnits: vi.fn().mockResolvedValue([]),
    updateUnit: vi.fn().mockResolvedValue(undefined),
  };

  const importHook = new RequestBatchImportService(
    { getOrThrow: () => bookDockPath } as never,
    downloads as never,
    requests as never,
    gateway as never,
    dockRepo as never,
    dockIngest as never,
    fulfillment as never,
    removal as never,
    batches as never,
  );
  await importHook.onApplicationBootstrap();

  const service = new RequestImportService(
    { getOrThrow: (key: string) => (key === 'storage.appDataPath' ? appDataPath : bookDockPath) } as never,
    downloads as never,
    requests as never,
    gateway as never,
    {
      useHardlinks: vi.fn().mockResolvedValue(options.useHardlinks ?? true),
      stagesLocally: vi.fn().mockResolvedValue(options.stagesLocally ?? false),
    } as never,
    pathMappings as never,
    dockRepo as never,
    dockIngest as never,
    { sanitizeFilename: (name: string) => name } as never,
    fulfillment as never,
    removal as never,
    audit as never,
    importHook,
  );
  await service.onApplicationBootstrap();

  return {
    service,
    dockRepo,
    downloads,
    requests,
    gateway,
    fulfillment,
    dockIngest,
    audit,
    removal,
    batches,
    bookDockPath,
    appDataPath,
    downloadsPath,
    directDownloadsPath,
    pathMappings,
  };
}

async function makeFile(dir: string, name: string, contents = 'book'): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, contents);
  return path;
}

describe('RequestBatchImportService through RequestImportService.importDownload', () => {
  it('imports every file of a download whose client named only the first, from its own folder', async () => {
    const harness = await makeHarness();
    const folder = join(harness.downloadsPath, 'audiobook');
    const first = await makeFile(folder, 'track-01.mp3');
    await makeFile(folder, 'track-02.mp3');

    harness.downloads.findContentFileCount.mockResolvedValue(2);
    await expect(harness.service.importDownload(download(first))).resolves.toBe(true);

    expect(harness.dockRepo.createUnit).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'track-01.mp3' }), [
      expect.objectContaining({ fileName: 'track-01.mp3' }),
      expect.objectContaining({ fileName: 'track-02.mp3' }),
    ]);
  });

  it('holds a multi-file download whose files share a folder with others, rather than guessing', async () => {
    const harness = await makeHarness();
    const first = await makeFile(harness.downloadsPath, 'track-01.mp3');
    await makeFile(harness.downloadsPath, 'track-02.mp3');
    await makeFile(harness.downloadsPath, 'Another Book.epub');

    harness.requests.findById.mockResolvedValue({ request: request({ mediaKind: 'audiobook' }) });

    harness.downloads.findContentFileCount.mockResolvedValue(2);
    await harness.service.importDownload(download(first));

    expect(harness.fulfillment.holdForReview).toHaveBeenCalledWith(
      expect.objectContaining({ id: 11 }),
      expect.objectContaining({ id: 7 }),
      expect.stringContaining('wrote 2 files for this audiobook into a folder that holds other files too'),
    );
    expect(harness.dockRepo.createUnit).not.toHaveBeenCalled();
  });

  it('imports the named file of a multi-file ebook whose files share a folder, since it is a whole book', async () => {
    const harness = await makeHarness();
    harness.requests.findById.mockResolvedValue({ request: request({ mediaKind: 'ebook' }) });
    const named = await makeFile(harness.downloadsPath, 'Dune.epub');
    await makeFile(harness.downloadsPath, 'Dune.mobi');
    await makeFile(harness.downloadsPath, 'Another Book.epub');

    harness.downloads.findContentFileCount.mockResolvedValue(2);
    await expect(harness.service.importDownload(download(named))).resolves.toBe(true);

    expect(harness.fulfillment.holdForReview).not.toHaveBeenCalled();
    expect(harness.dockRepo.createUnit).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'request-7-Dune.epub', format: 'epub' }), []);
  });

  describe('batch requests', () => {
    function unitRow(index: number, overrides: Record<string, unknown> = {}) {
      return {
        id: 500 + index,
        requestId: 7,
        unitIndex: index,
        primaryPath: `Book ${index}.epub`,
        status: 'waiting',
        ...overrides,
      };
    }

    async function batchHarness(rows: Array<ReturnType<typeof unitRow>>, files: string[]) {
      const harness = await makeHarness();
      harness.batches.findKinds.mockResolvedValue(new Map([[7, 'batch']]));
      harness.batches.findUnits.mockResolvedValue(rows);
      harness.requests.findById.mockResolvedValue({ request: request({ status: 'importing' }) });
      const folder = join(harness.downloadsPath, 'pack');
      for (const name of files) await makeFile(folder, name);
      return { harness, folder };
    }

    it('places every ticked unit into Book Dock and marks the batch available', async () => {
      const { harness, folder } = await batchHarness(
        [unitRow(0), unitRow(1), unitRow(2)],
        ['Book 0.epub', 'Book 1.epub', 'Book 2.epub', 'Book 3.epub', 'Book 4.epub'],
      );

      await expect(harness.service.importDownload(download(folder))).resolves.toBe(true);

      expect(harness.dockRepo.createUnit).toHaveBeenCalledTimes(3);
      expect(harness.dockIngest.ingestFromWatchedFolder).toHaveBeenCalledTimes(3);
      const inDock = harness.batches.updateUnit.mock.calls.filter(([, data]) => data.status === 'in_dock');
      expect(inDock).toEqual([
        [500, { status: 'in_dock', bookDockFileId: 100 }],
        [501, { status: 'in_dock', bookDockFileId: 101 }],
        [502, { status: 'in_dock', bookDockFileId: 102 }],
      ]);
      expect(harness.requests.updateIf).toHaveBeenCalledWith(7, ['importing'], { status: 'available' });
      expect(harness.downloads.updateIf).toHaveBeenCalledWith(11, ['completed'], { status: 'imported' });
      expect(harness.downloads.update.mock.calls.every(([, data]) => !('bookDockFileId' in data))).toBe(true);
      expect(harness.fulfillment.holdForReview).not.toHaveBeenCalled();
    });

    it('keeps a rerun available when every batch unit is already filed', async () => {
      const { harness, folder } = await batchHarness(
        [unitRow(0, { status: 'filed', bookDockFileId: 90 }), unitRow(1, { status: 'filed', bookDockFileId: 91 })],
        ['Book 0.epub', 'Book 1.epub'],
      );

      await expect(harness.service.importDownload(download(folder))).resolves.toBe(true);

      expect(harness.dockRepo.createUnit).not.toHaveBeenCalled();
      expect(harness.batches.updateUnit).not.toHaveBeenCalled();
      expect(harness.requests.updateIf).toHaveBeenCalledWith(7, ['importing'], { status: 'available' });
      expect(harness.downloads.updateIf).toHaveBeenCalledWith(11, ['completed'], { status: 'imported' });
    });

    it('marks a unit failed when its file is missing and places the rest', async () => {
      const { harness, folder } = await batchHarness([unitRow(0), unitRow(1), unitRow(2)], ['Book 0.epub', 'Book 2.epub']);

      await harness.service.importDownload(download(folder));

      expect(harness.batches.updateUnit).toHaveBeenCalledWith(501, {
        status: 'failed',
        errorMessage: 'This file was not found in the finished download.',
      });
      expect(harness.batches.updateUnit).toHaveBeenCalledWith(500, expect.objectContaining({ status: 'in_dock' }));
      expect(harness.batches.updateUnit).toHaveBeenCalledWith(502, expect.objectContaining({ status: 'in_dock' }));
      expect(harness.requests.updateIf).toHaveBeenCalledWith(7, ['importing'], { status: 'available' });
    });

    it('marks the batch failed when no unit could be placed', async () => {
      const { harness, folder } = await batchHarness([unitRow(0), unitRow(1)], ['Other.epub']);

      await harness.service.importDownload(download(folder));

      expect(harness.dockRepo.createUnit).not.toHaveBeenCalled();
      expect(harness.requests.updateIf).toHaveBeenCalledWith(7, ['importing'], {
        status: 'failed',
        statusReason: 'None of the ticked books could be placed in Book Dock.',
      });
      expect(harness.downloads.updateIf).toHaveBeenCalledWith(11, ['completed'], { status: 'imported' });
    });

    it('fails the batch once with the real reason when the download folder cannot be read', async () => {
      const { harness, folder } = await batchHarness([unitRow(0), unitRow(1)], ['Book 0.epub', 'Book 1.epub']);
      await chmod(folder, 0o000);

      try {
        await harness.service.importDownload(download(folder));
      } finally {
        await chmod(folder, 0o755);
      }

      const reason = `BookOrbit could not read the finished download at ${folder} (permission denied). The download client reported ${folder}; check the path mapping for this client.`;
      expect(harness.requests.updateIf).toHaveBeenCalledWith(7, expect.anything(), { status: 'failed', statusReason: reason });
      expect(harness.downloads.updateIf).toHaveBeenCalledWith(11, expect.anything(), { status: 'failed', errorMessage: reason });
      expect(harness.batches.updateUnit).not.toHaveBeenCalled();
      expect(harness.dockRepo.createUnit).not.toHaveBeenCalled();
    });

    it('names both paths and "not found" when the batch folder is missing', async () => {
      const { harness, folder } = await batchHarness([unitRow(0)], ['Book 0.epub']);
      const missing = join(folder, 'gone');

      await harness.service.importDownload(download(missing));

      expect(harness.fulfillment.failDownload).toHaveBeenCalledWith(
        expect.anything(),
        `BookOrbit could not read the finished download at ${missing} (not found). The download client reported ${missing}; check the path mapping for this client.`,
      );
    });

    it('fails the batch once when the download folder is empty', async () => {
      const { harness, folder } = await batchHarness([unitRow(0), unitRow(1)], []);
      await mkdir(folder, { recursive: true });

      await harness.service.importDownload(download(folder));

      const reason = 'BookOrbit could not read the finished download: the download folder is empty';
      expect(harness.requests.updateIf).toHaveBeenCalledWith(7, expect.anything(), { status: 'failed', statusReason: reason });
      expect(harness.downloads.updateIf).toHaveBeenCalledWith(11, expect.anything(), { status: 'failed', errorMessage: reason });
      expect(harness.batches.updateUnit).not.toHaveBeenCalled();
    });

    describe('extended torrent completion guard', () => {
      const NEVER_ARRIVED = 'The download client reported the download finished, but some selected files never arrived.';
      const recent = () => new Date(Date.now() - 60_000);
      const old = () => new Date(Date.now() - 31 * 60_000);

      it('puts the download and request back to downloading when a file is missing, failing no unit', async () => {
        const { harness, folder } = await batchHarness(
          [unitRow(0, { filePaths: ['Book 0.epub'], fileSizes: [4] }), unitRow(1, { filePaths: ['Book 1.epub'], fileSizes: [4] })],
          ['Book 0.epub'],
        );

        await harness.service.importDownload(download(folder, { grabbedAt: recent() }));

        expect(harness.downloads.updateIf).toHaveBeenCalledWith(
          11,
          ['completed', 'importing'],
          expect.objectContaining({ status: 'downloading', completedAt: null }),
        );
        expect(harness.requests.updateIf).toHaveBeenCalledWith(7, ['importing'], { status: 'downloading' });
        expect(harness.batches.updateUnit).not.toHaveBeenCalled();
        expect(harness.dockRepo.createUnit).not.toHaveBeenCalled();
        expect(harness.requests.updateIf).not.toHaveBeenCalledWith(7, expect.anything(), expect.objectContaining({ status: 'failed' }));
      });

      it('treats a file smaller than recorded as not complete yet', async () => {
        const { harness, folder } = await batchHarness([unitRow(0, { filePaths: ['Book 0.epub'], fileSizes: [400] })], ['Book 0.epub']);

        await harness.service.importDownload(download(folder, { grabbedAt: recent() }));

        expect(harness.downloads.updateIf).toHaveBeenCalledWith(11, ['completed', 'importing'], expect.objectContaining({ status: 'downloading' }));
        expect(harness.batches.updateUnit).not.toHaveBeenCalled();
      });

      it('records when the files were first seen incomplete', async () => {
        const { harness, folder } = await batchHarness([unitRow(0, { filePaths: ['Book 0.epub'], fileSizes: [4] })], []);
        await mkdir(folder, { recursive: true });

        await harness.service.importDownload(download(folder, { grabbedAt: old() }));

        expect(harness.downloads.setFilesPendingSince).toHaveBeenCalledWith(11, expect.any(Date));
      });

      it('does not fail a long download that has only just finished', async () => {
        const { harness, folder } = await batchHarness(
          [unitRow(0, { filePaths: ['Book 0.epub'], fileSizes: [4] }), unitRow(1, { filePaths: ['Book 1.epub'], fileSizes: [4] })],
          ['Book 0.epub'],
        );

        await harness.service.importDownload(download(folder, { grabbedAt: old() }));

        expect(harness.downloads.updateIf).toHaveBeenCalledWith(11, ['completed', 'importing'], expect.objectContaining({ status: 'downloading' }));
        expect(harness.requests.updateIf).not.toHaveBeenCalledWith(7, expect.anything(), expect.objectContaining({ status: 'failed' }));
      });

      it('keeps waiting while the files have been incomplete for under 30 minutes', async () => {
        const { harness, folder } = await batchHarness([unitRow(0, { filePaths: ['Book 0.epub'], fileSizes: [4] })], []);
        await mkdir(folder, { recursive: true });
        harness.downloads.findExtension.mockResolvedValue({ filesPendingSince: new Date(Date.now() - 29 * 60_000), extendsExisting: false });

        await harness.service.importDownload(download(folder));

        expect(harness.downloads.updateIf).toHaveBeenCalledWith(11, ['completed', 'importing'], expect.objectContaining({ status: 'downloading' }));
        expect(harness.downloads.setFilesPendingSince).not.toHaveBeenCalled();
      });

      it('fails the batch with the exact message after 30 minutes of continuous incompleteness', async () => {
        const { harness, folder } = await batchHarness(
          [unitRow(0, { filePaths: ['Book 0.epub'], fileSizes: [4] }), unitRow(1, { filePaths: ['Book 1.epub'], fileSizes: [4] })],
          ['Book 0.epub'],
        );
        harness.downloads.findExtension.mockResolvedValue({ filesPendingSince: new Date(Date.now() - 31 * 60_000), extendsExisting: false });

        await harness.service.importDownload(download(folder, { grabbedAt: recent() }));

        expect(harness.requests.updateIf).toHaveBeenCalledWith(7, expect.anything(), { status: 'failed', statusReason: NEVER_ARRIVED });
        expect(harness.downloads.updateIf).toHaveBeenCalledWith(11, expect.anything(), { status: 'failed', errorMessage: NEVER_ARRIVED });
        expect(harness.batches.updateUnit).not.toHaveBeenCalled();
      });

      it('clears the pending timestamp once the files are complete', async () => {
        const { harness, folder } = await batchHarness([unitRow(0, { filePaths: ['Book 0.epub'], fileSizes: [4] })], ['Book 0.epub']);
        harness.downloads.findExtension.mockResolvedValue({ filesPendingSince: new Date(Date.now() - 10 * 60_000), extendsExisting: false });

        await harness.service.importDownload(download(folder));

        expect(harness.downloads.setFilesPendingSince).toHaveBeenCalledWith(11, null);
        expect(harness.dockRepo.createUnit).toHaveBeenCalledTimes(1);
      });

      it('places the units when every file is there at its recorded size', async () => {
        const { harness, folder } = await batchHarness(
          [unitRow(0, { filePaths: ['Book 0.epub'], fileSizes: [4] }), unitRow(1, { filePaths: ['Book 1.epub'], fileSizes: [4] })],
          ['Book 0.epub', 'Book 1.epub'],
        );

        await harness.service.importDownload(download(folder, { grabbedAt: recent() }));

        expect(harness.dockRepo.createUnit).toHaveBeenCalledTimes(2);
        expect(harness.requests.updateIf).toHaveBeenCalledWith(7, ['importing'], { status: 'available' });
      });

      it('keeps the old behaviour for rows without recorded sizes', async () => {
        const { harness, folder } = await batchHarness([unitRow(0, { fileSizes: null }), unitRow(1, { fileSizes: null })], ['Book 0.epub']);

        await harness.service.importDownload(download(folder, { grabbedAt: old() }));

        expect(harness.batches.updateUnit).toHaveBeenCalledWith(501, {
          status: 'failed',
          errorMessage: 'This file was not found in the finished download.',
        });
        expect(harness.requests.updateIf).toHaveBeenCalledWith(7, ['importing'], { status: 'available' });
      });
    });

    it('skips units already in Book Dock on a re-run', async () => {
      const { harness, folder } = await batchHarness(
        [unitRow(0, { status: 'in_dock', bookDockFileId: 90 }), unitRow(1), unitRow(2)],
        ['Book 0.epub', 'Book 1.epub', 'Book 2.epub'],
      );

      await harness.service.importDownload(download(folder));

      expect(harness.dockRepo.createUnit).toHaveBeenCalledTimes(2);
      expect(harness.batches.updateUnit).not.toHaveBeenCalledWith(500, expect.anything());
      expect(harness.requests.updateIf).toHaveBeenCalledWith(7, ['importing'], { status: 'available' });
    });

    it('records the dock row on the unit before placing it', async () => {
      const { harness, folder } = await batchHarness([unitRow(0)], ['Book 0.epub']);

      await harness.service.importDownload(download(folder));

      expect(harness.batches.updateUnit).toHaveBeenCalledWith(500, { status: 'placing', bookDockFileId: 100 });
    });

    it('adopts a placing unit whose file already landed instead of placing it again', async () => {
      const { harness, folder } = await batchHarness([unitRow(0, { status: 'placing', bookDockFileId: 90 })], ['Book 0.epub']);
      const landed = await makeFile(harness.bookDockPath, 'request-7-Book 0.epub');
      harness.dockRepo.findById.mockResolvedValue({ id: 90, absolutePath: landed, fileSize: (await stat(landed)).size });

      await harness.service.importDownload(download(folder));

      expect(harness.dockRepo.createUnit).not.toHaveBeenCalled();
      expect(harness.dockRepo.deleteById).not.toHaveBeenCalled();
      expect(harness.dockIngest.ingestFromWatchedFolder).toHaveBeenCalledWith(landed);
      expect(harness.batches.updateUnit).toHaveBeenCalledWith(500, { status: 'in_dock', bookDockFileId: 90 });
      expect(harness.requests.updateIf).toHaveBeenCalledWith(7, ['importing'], { status: 'available' });
    });

    it('drops a stale dock row and places a placing unit again when its file never landed', async () => {
      const { harness, folder } = await batchHarness([unitRow(0, { status: 'placing', bookDockFileId: 90 })], ['Book 0.epub']);
      harness.dockRepo.findById.mockResolvedValue({ id: 90, absolutePath: join(harness.bookDockPath, 'missing.epub'), fileSize: 5 });

      await harness.service.importDownload(download(folder));

      expect(harness.dockRepo.deleteById).toHaveBeenCalledWith(90);
      expect(harness.dockRepo.createUnit).toHaveBeenCalledTimes(1);
      expect(harness.batches.updateUnit).toHaveBeenCalledWith(500, { status: 'in_dock', bookDockFileId: 100 });
    });

    it('removes the files of a stale claim before placing the unit again', async () => {
      const { harness, folder } = await batchHarness([unitRow(0, { status: 'placing', bookDockFileId: 90 })], ['Book 0.epub']);
      const partial = await makeFile(harness.bookDockPath, 'request-7-Book 0.epub');
      harness.dockRepo.findById.mockResolvedValue({ id: 90, absolutePath: partial, fileSize: 999, unitDirectory: null });
      let leftoverGoneAtDelete = false;
      harness.dockRepo.deleteById.mockImplementation(async (id: number) => {
        if (id === 90)
          leftoverGoneAtDelete = await stat(partial).then(
            () => false,
            () => true,
          );
      });

      await harness.service.importDownload(download(folder));

      expect(leftoverGoneAtDelete).toBe(true);
      expect(harness.dockRepo.createUnit).toHaveBeenCalledTimes(1);
    });

    describe('a resumed multi-file unit', () => {
      async function resumedUnit(withSecondTrack: boolean) {
        const { harness, folder } = await batchHarness([unitRow(0, { status: 'placing', bookDockFileId: 90 })], ['Book 0.epub']);
        const unitDirectory = join(harness.bookDockPath, 'request-7-Audio');
        const first = await makeFile(unitDirectory, 'track01.mp3');
        const second = join(unitDirectory, 'track02.mp3');
        if (withSecondTrack) await makeFile(unitDirectory, 'track02.mp3');
        const size = (await stat(first)).size;
        harness.dockRepo.findById.mockResolvedValue({ id: 90, absolutePath: first, fileSize: size, unitDirectory });
        harness.dockRepo.findUnitFiles.mockResolvedValue([
          { absolutePath: first, fileSize: size },
          { absolutePath: second, fileSize: size },
        ]);
        return { harness, folder, unitDirectory, first };
      }

      it('is not adopted when a track is missing, and the landed tracks are removed', async () => {
        const { harness, folder, unitDirectory, first } = await resumedUnit(false);

        await harness.service.importDownload(download(folder));

        expect(harness.dockRepo.deleteById).toHaveBeenCalledWith(90);
        await expect(stat(first)).rejects.toThrow();
        await expect(stat(unitDirectory)).rejects.toThrow();
        expect(harness.dockRepo.createUnit).toHaveBeenCalledTimes(1);
      });

      it('is adopted when every track landed', async () => {
        const { harness, folder, first } = await resumedUnit(true);

        await harness.service.importDownload(download(folder));

        expect(harness.dockRepo.deleteById).not.toHaveBeenCalled();
        expect(harness.dockRepo.createUnit).not.toHaveBeenCalled();
        expect(harness.dockIngest.ingestFromWatchedFolder).toHaveBeenCalledWith(first);
        expect(harness.batches.updateUnit).toHaveBeenCalledWith(500, { status: 'in_dock', bookDockFileId: 90 });
      });
    });

    it('clears the dock id on a unit whose placement failed for good', async () => {
      const { harness, folder } = await batchHarness([unitRow(0)], ['Book 0.epub']);
      const link = vi.spyOn(harness.service as never as { placeFile: () => Promise<void> }, 'placeFile').mockRejectedValue(new Error('disk full'));

      await harness.service.importDownload(download(folder));
      link.mockRestore();

      expect(harness.dockRepo.deleteById).toHaveBeenCalledWith(100);
      expect(harness.batches.updateUnit).toHaveBeenCalledWith(500, { bookDockFileId: null });
      expect(harness.batches.updateUnit).toHaveBeenCalledWith(500, { status: 'failed', errorMessage: 'disk full' });
    });

    it('settles the request before the download so a crash between them cannot strand it', async () => {
      const { harness, folder } = await batchHarness([unitRow(0)], ['Book 0.epub']);

      await harness.service.importDownload(download(folder));

      const requestWrite = harness.requests.updateIf.mock.calls.findIndex(([, , patch]) => patch.status === 'available');
      const downloadWrite = harness.downloads.updateIf.mock.calls.findIndex(([, , patch]) => patch.status === 'imported');
      expect(harness.requests.updateIf.mock.invocationCallOrder[requestWrite]).toBeLessThan(
        harness.downloads.updateIf.mock.invocationCallOrder[downloadWrite]!,
      );
    });

    it('fails only the unit whose placement throws and carries on', async () => {
      const { harness, folder } = await batchHarness([unitRow(0), unitRow(1)], ['Book 0.epub', 'Book 1.epub']);
      harness.dockRepo.createUnit.mockRejectedValueOnce(new Error('disk full'));

      await harness.service.importDownload(download(folder));

      expect(harness.batches.updateUnit).toHaveBeenCalledWith(500, { status: 'failed', errorMessage: 'disk full' });
      expect(harness.batches.updateUnit).toHaveBeenCalledWith(501, expect.objectContaining({ status: 'in_dock' }));
      expect(harness.requests.updateIf).toHaveBeenCalledWith(7, ['importing'], { status: 'available' });
    });

    it('does not hold a truncated batch download for review', async () => {
      const { harness, folder } = await batchHarness([unitRow(0)], ['Book 0.epub']);
      await Promise.all(Array.from({ length: 2_001 }, (_, index) => makeFile(folder, `pad-${index}.txt`)));

      await harness.service.importDownload(download(folder));

      expect(harness.fulfillment.holdForReview).not.toHaveBeenCalled();
      expect(harness.dockRepo.createUnit).toHaveBeenCalledTimes(1);
    });

    it('places nothing when the request can no longer be claimed', async () => {
      const { harness, folder } = await batchHarness([unitRow(0)], ['Book 0.epub']);
      harness.requests.updateIf.mockResolvedValue(undefined);

      await harness.service.importDownload(download(folder));

      expect(harness.dockRepo.createUnit).not.toHaveBeenCalled();
      expect(harness.batches.updateUnit).not.toHaveBeenCalled();
    });

    it('stops placing when the request is cancelled mid-import and leaves it cancelled', async () => {
      const { harness, folder } = await batchHarness([unitRow(0), unitRow(1)], ['Book 0.epub', 'Book 1.epub']);
      harness.requests.findById
        .mockResolvedValueOnce({ request: request({ status: 'importing' }) })
        .mockResolvedValueOnce({ request: request({ status: 'importing' }) })
        .mockResolvedValue({ request: request({ status: 'cancelled' }) });

      await harness.service.importDownload(download(folder));

      expect(harness.dockRepo.createUnit).toHaveBeenCalledTimes(1);
      expect(harness.requests.updateIf).not.toHaveBeenCalledWith(7, ['importing'], expect.anything());
      expect(harness.requests.update).not.toHaveBeenCalled();
      expect(harness.downloads.updateIf).not.toHaveBeenCalledWith(11, ['completed'], { status: 'imported' });
    });

    it('resumes a request already importing and places only the remaining units', async () => {
      const { harness, folder } = await batchHarness(
        [unitRow(0, { status: 'in_dock', bookDockFileId: 90 }), unitRow(1)],
        ['Book 0.epub', 'Book 1.epub'],
      );

      await harness.service.importDownload(download(folder, { status: 'completed' }));

      expect(harness.requests.updateIf).toHaveBeenCalledWith(7, expect.arrayContaining(['importing']), { status: 'importing' });
      expect(harness.dockRepo.createUnit).toHaveBeenCalledTimes(1);
      expect(harness.batches.updateUnit).toHaveBeenCalledWith(501, expect.objectContaining({ status: 'in_dock' }));
    });

    it('takes the single path when the request kind is single', async () => {
      const harness = await makeHarness();
      const source = await makeFile(harness.downloadsPath, 'dune.epub');

      await harness.service.importDownload(download(source));

      expect(harness.batches.findUnits).not.toHaveBeenCalled();
      expect(harness.requests.updateIf).toHaveBeenCalledWith(7, expect.anything(), expect.objectContaining({ bookDockFileId: expect.any(Number) }));
    });
  });
});
