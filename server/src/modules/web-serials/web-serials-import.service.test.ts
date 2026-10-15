import { existsSync } from 'fs';
import { mkdtemp, readdir, readFile, realpath, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DuplicateBookError, ImportStageError } from './web-serials-import.errors';
import { WEB_SERIAL_CHAPTER_SIZE_CAP, WebSerialsImportService, type WebSerialUnitImport } from './web-serials-import.service';

vi.mock('../book-dock/book-dock-finalize.service', () => ({ BookDockFinalizeService: class {} }));
vi.mock('../book-dock/book-dock.repository', () => ({ BookDockRepository: class {} }));

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'web-serials-import-')));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function setup(finalize: Record<string, unknown> = { success: true, bookId: 99 }) {
  const dockRepo = { create: vi.fn().mockResolvedValue({ id: 5 }), deleteByAbsolutePath: vi.fn().mockResolvedValue(undefined) };
  const dockFinalize = { finalizeManagedFile: vi.fn().mockResolvedValue(finalize) };
  const config = { getOrThrow: vi.fn().mockReturnValue(dir) };
  const service = new WebSerialsImportService(config as never, dockRepo as never, dockFinalize as never);
  await service.onApplicationBootstrap();
  return { service, dockRepo, dockFinalize };
}

function request(overrides: Partial<WebSerialUnitImport> = {}, body: string | Buffer = 'cbz-bytes'): WebSerialUnitImport {
  return {
    jobId: 3,
    itemId: 8,
    userId: 7,
    kind: 'manga',
    download: { stream: Readable.from([Buffer.from(body)]), fileName: 'c.cbz', format: 'cbz', size: null },
    metadata: { title: 'Saga Ch. 1' },
    targetLibraryId: 2,
    targetFolderId: 4,
    ...overrides,
  };
}

describe('WebSerialsImportService', () => {
  it('stages a grouped chapter through a part file and cleans the unit folder', async () => {
    const { service } = await setup();
    const workDir = await service.prepareUnitWorkDir(3, 8);
    const finalPath = join(workDir, 'chapter-0001.cbz');

    await expect(
      service.saveWorkDownload({ stream: Readable.from(['chapter']), fileName: 'chapter.cbz', format: 'cbz', size: 7 }, finalPath),
    ).resolves.toBe(7);
    expect(await readFile(finalPath, 'utf8')).toBe('chapter');
    expect(existsSync(`${finalPath}.part`)).toBe(false);

    await service.cleanupUnitWorkDir(3, 8);
    expect(existsSync(workDir)).toBe(false);
  });

  it('files the download through the dock and returns the book id', async () => {
    const { service, dockRepo, dockFinalize } = await setup();
    let seenOnDisk = '';
    dockFinalize.finalizeManagedFile.mockImplementation(async () => {
      seenOnDisk = await readFile(join(dir, 'web-serial-3-8.cbz'), 'utf8');
      return { success: true, bookId: 99 };
    });

    await expect(service.importUnit(request())).resolves.toBe(99);

    expect(seenOnDisk).toBe('cbz-bytes');
    expect(dockRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: 'web-serial-3-8.cbz',
        format: 'cbz',
        fileSize: 9,
        status: 'ready',
        selectedMetadata: { title: 'Saga Ch. 1' },
        targetLibraryId: 2,
        targetFolderId: 4,
        uploadedBy: 7,
        autoFinalizeSuppressed: true,
      }),
    );
    expect(dockFinalize.finalizeManagedFile).toHaveBeenCalledWith(5, { libraryId: 2, folderId: 4 });
    expect(existsSync(join(dir, '.web-serial-3-8.cbz.part'))).toBe(false);
  });

  it('accepts a web stream', async () => {
    const { service } = await setup();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('epub'));
        controller.close();
      },
    });

    await expect(service.importUnit(request({ kind: 'novel', download: { stream, fileName: 'a.epub', format: 'epub', size: 4 } }))).resolves.toBe(99);
  });

  it('refuses a declared size above the cap without writing anything', async () => {
    const { service, dockRepo } = await setup();

    await expect(
      service.importUnit(request({ download: { stream: Readable.from([]), fileName: 'c.cbz', format: 'cbz', size: 2 * 1024 * 1024 * 1024 + 1 } })),
    ).rejects.toThrow('larger than the allowed size');

    expect(dockRepo.create).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it('cleans up when the dock cannot file the book', async () => {
    const { service, dockRepo } = await setup({ success: false, message: 'bad archive' });

    await expect(service.importUnit(request())).rejects.toThrow('bad archive');

    expect(dockRepo.deleteByAbsolutePath).toHaveBeenCalledWith(join(dir, 'web-serial-3-8.cbz'));
    expect(await readdir(dir)).toEqual([]);
  });

  it('reports a duplicate as a conflict', async () => {
    const { service } = await setup({ success: false, isDuplicate: true, newName: 'x' });

    await expect(service.importUnit(request())).rejects.toThrow('already in the library');
  });

  it('removes the partial file when the stream breaks', async () => {
    const { service } = await setup();
    const stream = new Readable({
      read() {
        this.push(Buffer.from('partial'));
        this.destroy(new Error('connection reset'));
      },
    });

    await expect(service.importUnit(request({ download: { stream, fileName: 'c.cbz', format: 'cbz', size: null } }))).rejects.toThrow();

    expect(await readdir(dir)).toEqual([]);
  });

  it('reports an already filed book with the id of the existing one', async () => {
    const { service, dockRepo } = await setup({ success: false, isDuplicate: true, existingBookId: 41 });

    const failure = await service.importUnit(request()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DuplicateBookError);
    expect((failure as DuplicateBookError).bookId).toBe(41);
    expect(dockRepo.deleteByAbsolutePath).toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it('marks a failure while filing as an import-stage error but leaves stream failures alone', async () => {
    const filing = await setup({ success: false, message: 'Book Dock file not found' });
    await expect(filing.service.importUnit(request())).rejects.toBeInstanceOf(ImportStageError);

    const { service } = await setup();
    const stream = new Readable({
      read() {
        this.destroy(new Error('connection reset'));
      },
    });
    const failure = await service
      .importUnit(request({ download: { stream, fileName: 'c.cbz', format: 'cbz', size: null } }))
      .catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(ImportStageError);
  });

  it('honours a smaller size cap for a single chapter', async () => {
    const { service, dockRepo } = await setup();

    await expect(
      service.importUnit(
        request({
          maxBytes: WEB_SERIAL_CHAPTER_SIZE_CAP,
          download: { stream: Readable.from([]), fileName: 'c.cbz', format: 'cbz', size: WEB_SERIAL_CHAPTER_SIZE_CAP + 1 },
        }),
      ),
    ).rejects.toThrow('larger than the allowed size');
    expect(dockRepo.create).not.toHaveBeenCalled();
  });

  it('refuses a work download above the 500 MB chapter cap', async () => {
    const { service } = await setup();
    const workDir = await service.prepareUnitWorkDir(3, 8);

    await expect(
      service.saveWorkDownload(
        { stream: Readable.from([]), fileName: 'c.cbz', format: 'cbz', size: WEB_SERIAL_CHAPTER_SIZE_CAP + 1 },
        join(workDir, 'chapter-0001.cbz'),
      ),
    ).rejects.toThrow('larger than the allowed size');
  });

  it('lists and removes job work folders', async () => {
    const { service } = await setup();
    await service.prepareUnitWorkDir(3, 8);
    await service.prepareUnitWorkDir(4, 9);

    expect((await service.listWorkJobIds()).sort()).toEqual([3, 4]);
    await service.removeJobWorkDir(3);
    expect(await service.listWorkJobIds()).toEqual([4]);
  });
});
