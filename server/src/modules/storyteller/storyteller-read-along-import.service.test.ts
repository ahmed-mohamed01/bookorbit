import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConflictException, Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SelfWriteRegistry } from '../../common/services/self-write-registry.service';
import { StorytellerReadAlongImportService, type StorytellerReadAlongImport } from './storyteller-read-along-import.service';

vi.mock('../reader/epub/epub-media-overlay-capability', () => ({
  inspectEpubMediaOverlayFields: vi.fn().mockResolvedValue({
    mediaOverlayAvailable: true,
    mediaOverlayDurationSeconds: 3600,
    mediaOverlayCheckedAt: new Date('2026-01-01T00:00:00Z'),
  }),
}));

const METADATA = { title: 'Elantris', authors: ['Brandon Sanderson'], genres: ['Fantasy'], narrators: ['Jack Garrett'] };

let root = '';
let dockDir = '';
let stagingDir = '';
let libraryDir = '';

beforeEach(async () => {
  // The service resolves the dock to its real path, as the dock watcher does, so the fixture starts
  // from one too: macOS keeps the temp dir behind a /var -> /private/var symlink.
  root = await realpath(await mkdtemp(join(tmpdir(), 'storyteller-import-')));
  dockDir = join(root, 'dock');
  stagingDir = join(root, 'staging');
  libraryDir = join(root, 'library');
  await Promise.all([mkdir(dockDir), mkdir(stagingDir), mkdir(libraryDir)]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function setup() {
  const repo = {
    findReadAlongMetadata: vi.fn().mockResolvedValue(METADATA),
    findReplaceableEpubContentFile: vi.fn().mockResolvedValue(null),
    recordReplacedFile: vi.fn().mockResolvedValue(undefined),
  };
  const dockRows: Array<Record<string, unknown>> = [];
  const dockRepo = {
    create: vi.fn().mockImplementation((row: Record<string, unknown>) => {
      const created = { ...row, id: 500 + dockRows.length };
      dockRows.push(created);
      return Promise.resolve(created);
    }),
    update: vi.fn().mockResolvedValue({}),
    deleteByAbsolutePath: vi.fn().mockResolvedValue(undefined),
  };
  // Stands in for the dock: files the placed file into the library, as finalize moves it there.
  const filedPaths: string[] = [];
  const dockFinalize = {
    finalizeManagedFile: vi.fn().mockImplementation(async (fileId: number) => {
      const row = dockRows.find((candidate) => candidate.id === fileId)!;
      const destination = join(libraryDir, 'Brandon Sanderson', 'Elantris.epub');
      await mkdir(join(libraryDir, 'Brandon Sanderson'), { recursive: true });
      await writeFile(destination, await readFile(row.absolutePath as string));
      await rm(row.absolutePath as string);
      filedPaths.push(destination);
      return { fileId, fileName: row.fileName, success: true, bookId: 77 };
    }),
  };
  const selfWrites = new SelfWriteRegistry();
  const session = {
    downloadReadaloud: vi.fn().mockImplementation(async (_uuid: string, destination: string) => {
      await writeFile(destination, 'downloaded');
    }),
  };
  const config = { getOrThrow: vi.fn().mockReturnValue(dockDir) };
  const service = new StorytellerReadAlongImportService(config as never, repo as never, dockRepo as never, dockFinalize as never, selfWrites);
  await service.onApplicationBootstrap();
  return { service, repo, dockRepo, dockFinalize, selfWrites, session, filedPaths };
}

function request(session: unknown, overrides: Partial<StorytellerReadAlongImport> = {}): StorytellerReadAlongImport {
  return {
    buildId: 3,
    textBookId: 10,
    audioBookId: 11,
    userId: 42,
    session: session as StorytellerReadAlongImport['session'],
    storytellerBookUuid: 'story-uuid-123',
    stagedPath: null,
    consumeStaged: false,
    targetLibraryId: 9,
    targetFolderId: 30,
    replaceBookId: null,
    ...overrides,
  };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe('StorytellerReadAlongImportService', () => {
  it('files a new read-along through the dock with the linked editions metadata, never its own', async () => {
    const { service, session, dockRepo, dockFinalize, filedPaths } = await setup();

    await expect(service.importReadAlong(request(session))).resolves.toEqual({ outputBookId: 77, replaced: false });

    const dockPath = join(dockDir, 'storyteller-read-along-3-story-uu.epub');
    expect(session.downloadReadaloud).toHaveBeenCalledWith('story-uuid-123', join(dockDir, '.storyteller-read-along-3-story-uu.epub.part'));
    expect(dockRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        absolutePath: dockPath,
        fileSize: 'downloaded'.length,
        status: 'ready',
        selectedMetadata: METADATA,
        targetLibraryId: 9,
        targetFolderId: 30,
        uploadedBy: 42,
        autoFinalizeSuppressed: true,
      }),
    );
    expect(dockFinalize.finalizeManagedFile).toHaveBeenCalledWith(500, { libraryId: 9, folderId: 30 });
    expect(await readFile(filedPaths[0]!, 'utf8')).toBe('downloaded');
    expect(await exists(join(dockDir, '.storyteller-read-along-3-story-uu.epub.part'))).toBe(false);
  });

  // A download runs for up to two hours: a row listed that long could be filed or discarded from the
  // dock by hand, which breaks the build and can let Storyteller's metadata in.
  it('lists nothing in the dock while the read-along downloads, and claims the row before it takes its real name', async () => {
    const { service, session, dockRepo } = await setup();
    const dockPath = join(dockDir, 'storyteller-read-along-3-story-uu.epub');
    let rowsDuringDownload = -1;
    let realNameDuringDownload = true;
    session.downloadReadaloud.mockImplementationOnce(async (_uuid: string, destination: string) => {
      rowsDuringDownload = dockRepo.create.mock.calls.length;
      realNameDuringDownload = await exists(dockPath);
      await writeFile(destination, 'downloaded');
    });
    let realNameAtClaim = true;
    const claim = dockRepo.create.getMockImplementation()!;
    dockRepo.create.mockImplementationOnce(async (row: Record<string, unknown>) => {
      realNameAtClaim = await exists(dockPath);
      return claim(row);
    });

    await service.importReadAlong(request(session));

    expect(rowsDuringDownload).toBe(0);
    expect(realNameDuringDownload).toBe(false);
    // The watcher never sees the real name before the row exists, so it cannot ingest it as its own.
    expect(realNameAtClaim).toBe(false);
  });

  it('clears its partial download and claims no row when the download breaks', async () => {
    const { service, session, dockRepo } = await setup();
    session.downloadReadaloud.mockImplementationOnce(async (_uuid: string, destination: string) => {
      await writeFile(destination, 'half');
      throw new Error('connection reset');
    });

    await expect(service.importReadAlong(request(session))).rejects.toThrow('connection reset');

    expect(dockRepo.create).not.toHaveBeenCalled();
    expect(await exists(join(dockDir, '.storyteller-read-along-3-story-uu.epub.part'))).toBe(false);
  });

  it('logs how long a failed staged cleanup took', async () => {
    const { service, session } = await setup();
    const warnings: string[] = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
    // A directory where a file is expected: unlink refuses it with something other than ENOENT.
    const staged = join(stagingDir, 'staged.epub');
    await mkdir(staged);

    await (service as unknown as { removeStagedBestEffort(r: StorytellerReadAlongImport): Promise<void> }).removeStagedBestEffort(
      request(session, { stagedPath: staged, consumeStaged: true }),
    );

    expect(
      warnings.some((line) => /^\[storyteller\.read_along\.staged_cleanup\] \[fail\] buildId=3 path="[^"]+" durationMs=\d+ errorClass=/.test(line)),
    ).toBe(true);
  });

  it('names a read-along whose text edition has no title rather than filing it untitled', async () => {
    const { service, session, repo, dockRepo } = await setup();
    repo.findReadAlongMetadata.mockResolvedValue(null);

    await service.importReadAlong(request(session));

    expect(dockRepo.create).toHaveBeenCalledWith(expect.objectContaining({ selectedMetadata: { title: 'Read-along' } }));
  });

  it('hard-links a staged read-along it is taking, then removes the staged name once filed', async () => {
    const { service, session, dockFinalize } = await setup();
    const staged = join(stagingDir, '- 04-16.epub');
    await writeFile(staged, 'aligned');
    let linkCount = 0;
    dockFinalize.finalizeManagedFile.mockImplementationOnce(async (fileId: number) => {
      linkCount = Number((await stat(join(dockDir, 'storyteller-read-along-3-story-uu.epub'))).nlink);
      return { fileId, fileName: 'x', success: true, bookId: 77 };
    });

    await service.importReadAlong(request(session, { stagedPath: staged, consumeStaged: true }));

    expect(session.downloadReadaloud).not.toHaveBeenCalled();
    expect(linkCount).toBe(2);
    expect(await exists(staged)).toBe(false);
  });

  it('copies a staged read-along Storyteller keeps, and leaves it where it is', async () => {
    const { service, session, dockFinalize } = await setup();
    const staged = join(stagingDir, 'Elantris.epub');
    await writeFile(staged, 'aligned');
    let linkCount = 0;
    dockFinalize.finalizeManagedFile.mockImplementationOnce(async (fileId: number) => {
      linkCount = Number((await stat(join(dockDir, 'storyteller-read-along-3-story-uu.epub'))).nlink);
      return { fileId, fileName: 'x', success: true, bookId: 77 };
    });

    await service.importReadAlong(request(session, { stagedPath: staged, consumeStaged: false }));

    // A link would share bytes with whatever Storyteller writes to that path next.
    expect(linkCount).toBe(1);
    expect(await readFile(staged, 'utf8')).toBe('aligned');
  });

  it('keeps the staged read-along and clears its dock entry when filing fails', async () => {
    const { service, session, dockRepo, dockFinalize } = await setup();
    const staged = join(stagingDir, 'Elantris.epub');
    await writeFile(staged, 'aligned');
    dockFinalize.finalizeManagedFile.mockResolvedValueOnce({
      fileId: 500,
      fileName: 'x',
      newName: 'Brandon Sanderson/Elantris.epub',
      success: false,
      isDuplicate: true,
      message: 'A file with this name already exists at the target location',
    });

    await expect(service.importReadAlong(request(session, { stagedPath: staged, consumeStaged: true }))).rejects.toBeInstanceOf(ConflictException);

    const dockPath = join(dockDir, 'storyteller-read-along-3-story-uu.epub');
    expect(await exists(staged)).toBe(true);
    expect(await exists(dockPath)).toBe(false);
    expect(dockRepo.deleteByAbsolutePath).toHaveBeenLastCalledWith(dockPath);
  });

  it('clears what an interrupted attempt left at its own dock path before claiming it again', async () => {
    const { service, session, dockRepo } = await setup();
    const dockPath = join(dockDir, 'storyteller-read-along-3-story-uu.epub');
    await writeFile(dockPath, 'stale');

    await service.importReadAlong(request(session));

    expect(dockRepo.deleteByAbsolutePath).toHaveBeenCalledWith(dockPath);
    expect(dockRepo.deleteByAbsolutePath.mock.invocationCallOrder[0]).toBeLessThan(dockRepo.create.mock.invocationCallOrder[0]);
    expect(session.downloadReadaloud).toHaveBeenCalledOnce();
  });

  describe('a rebuild of a read-along that is already a book', () => {
    it('swaps the bytes under the existing book and records them before the scanner may look', async () => {
      const { service, session, repo, dockRepo, selfWrites } = await setup();
      const bookFile = join(libraryDir, 'Elantris.epub');
      await writeFile(bookFile, 'old alignment');
      repo.findReplaceableEpubContentFile.mockResolvedValue({ id: 40, absolutePath: bookFile });
      let suppressedWhileRecording = false;
      repo.recordReplacedFile.mockImplementation(() => {
        suppressedWhileRecording = selfWrites.isSuppressed(bookFile);
        return Promise.resolve();
      });

      await expect(service.importReadAlong(request(session, { replaceBookId: 88 }))).resolves.toEqual({ outputBookId: 88, replaced: true });

      expect(await readFile(bookFile, 'utf8')).toBe('downloaded');
      expect(repo.recordReplacedFile).toHaveBeenCalledWith(
        88,
        40,
        expect.objectContaining({ sizeBytes: 'downloaded'.length, mediaOverlayAvailable: true, mediaOverlayDurationSeconds: 3600 }),
      );
      expect(suppressedWhileRecording).toBe(true);
      expect(selfWrites.isSuppressed(bookFile)).toBe(false);
      expect(dockRepo.create).not.toHaveBeenCalled();
    });

    it('takes a staged read-along into the existing book and removes the staged name', async () => {
      const { service, session, repo } = await setup();
      const bookFile = join(libraryDir, 'Elantris.epub');
      await writeFile(bookFile, 'old alignment');
      const staged = join(stagingDir, '- 04-16.epub');
      await writeFile(staged, 'new alignment');
      repo.findReplaceableEpubContentFile.mockResolvedValue({ id: 40, absolutePath: bookFile });

      await service.importReadAlong(request(session, { replaceBookId: 88, stagedPath: staged, consumeStaged: true }));

      expect(await readFile(bookFile, 'utf8')).toBe('new alignment');
      expect(await exists(staged)).toBe(false);
      expect(session.downloadReadaloud).not.toHaveBeenCalled();
    });

    it('files a new book instead only when the previous output holds no EPUB', async () => {
      const { service, session, repo, dockFinalize } = await setup();
      repo.findReplaceableEpubContentFile.mockResolvedValue(null);

      await expect(service.importReadAlong(request(session, { replaceBookId: 88 }))).resolves.toEqual({ outputBookId: 77, replaced: false });

      expect(repo.recordReplacedFile).not.toHaveBeenCalled();
      expect(dockFinalize.finalizeManagedFile).toHaveBeenCalledOnce();
    });

    it('leaves the existing file untouched when the new bytes cannot be fetched', async () => {
      const { service, session, repo } = await setup();
      const bookFile = join(libraryDir, 'Elantris.epub');
      await writeFile(bookFile, 'old alignment');
      repo.findReplaceableEpubContentFile.mockResolvedValue({ id: 40, absolutePath: bookFile });
      session.downloadReadaloud.mockRejectedValueOnce(new Error('connection reset'));

      await expect(service.importReadAlong(request(session, { replaceBookId: 88 }))).rejects.toThrow('connection reset');

      expect(await readFile(bookFile, 'utf8')).toBe('old alignment');
      expect(await exists(join(libraryDir, '.storyteller-read-along-3.tmp'))).toBe(false);
      expect(repo.recordReplacedFile).not.toHaveBeenCalled();
    });
  });
});
