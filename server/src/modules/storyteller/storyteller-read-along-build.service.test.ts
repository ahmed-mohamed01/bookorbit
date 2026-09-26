import { mkdtemp, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { ConflictException, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import { BookService } from '../book/book.service';
import { EditionLinkRepository } from '../edition-link/edition-link.repository';
import { LibraryService } from '../library/library.service';
import { ScannerService } from '../scanner/scanner.service';
import * as buildServiceModule from './storyteller-read-along-build.service';
import { STORYTELLER_SLEEP, StorytellerReadAlongBuildService, type StorytellerRunBuildOptions } from './storyteller-read-along-build.service';
import type { StorytellerReadAlongPair } from './storyteller-read-along-status.service';
import { StorytellerClientError, StorytellerClientService } from './storyteller-client.service';
import { storytellerConfig } from './storyteller.config';
import { StorytellerRepository } from './storyteller.repository';
import { StorytellerSettingsService } from './storyteller-settings.service';

const USER = { id: 42, isSuperuser: false, permissions: [] } as unknown as RequestUser;
const PAIR: StorytellerReadAlongPair = {
  textBookId: 10,
  audioBookId: 11,
  linkId: 5,
  role: 'text',
  link: { id: 5, textBookId: 10, audioBookId: 11, readAlongBookId: null, createdBy: 42, createdAt: new Date() },
};
const OTHER_PAIR: StorytellerReadAlongPair = {
  textBookId: 12,
  audioBookId: 13,
  linkId: 6,
  role: 'text',
  link: { id: 6, textBookId: 12, audioBookId: 13, readAlongBookId: null, createdBy: 42, createdAt: new Date() },
};

function linkNaming(readAlongBookId: number | null) {
  return { id: 5, textBookId: 10, audioBookId: 11, readAlongBookId, createdBy: 42, createdAt: new Date() };
}

function pairWithPreviousOutput(readAlongBookId: number): StorytellerReadAlongPair {
  return { ...PAIR, link: linkNaming(readAlongBookId) };
}

// What `collectByTransfer` names a download: the build id keeps two pairs apart, the Storyteller
// book keeps two outputs of one pair apart. `story-uu` is the key for the fixtures' `story-uuid`.
function downloadDestination(buildId: number, remoteKey = 'story-uu', title = 'Remote Title'): string {
  return join(libraryDir, `${title} (read-along ${buildId}-${remoteKey}).epub`);
}

// The library every fixture's target folder belongs to. A row the scan resolved for a path can name
// a different one - book_files.absolute_path is unique instance-wide while library folders may
// overlap - so the library is spelled out on every located row rather than assumed.
const TARGET_LIBRARY_ID = 3;

function located(bookId: number, fileId: number, libraryId = TARGET_LIBRARY_ID) {
  return { bookId, fileId, libraryId };
}

// The library folder is a temp directory made per test, so table-driven cases name it with a
// placeholder the case resolves once the directory exists.
function resolveMappings(mappings: { localPrefix: string; remotePrefix: string }[]) {
  return mappings.map((mapping) => (mapping.localPrefix === '@library' ? { ...mapping, localPrefix: libraryDir } : mapping));
}

// A build always runs behind the one slot its caller took: the status service reserves, claims the
// row and hands the slot over. Tests that drive the reservation itself call the service directly.
function runBuild(
  service: StorytellerReadAlongBuildService,
  buildId: number,
  pair: StorytellerReadAlongPair,
  user: RequestUser,
  options: StorytellerRunBuildOptions = {},
): Promise<void> {
  const slot = service.tryReserve(pair);
  if (!slot) throw new Error('the build slot was already held');
  return service.runBuild(buildId, pair, user, options, slot);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

const IDLE = { state: 'idle', task: null, progress: null, error: null };

function libraryDirParent(dir: string): string {
  return dir.slice(0, dir.lastIndexOf('/')) || '/';
}

function remoteBook(overrides: Record<string, unknown> = {}) {
  return {
    uuid: 'story-uuid',
    title: 'Remote Title',
    authors: ['Author'],
    identifiers: [],
    aligned: false,
    hasEbook: true,
    hasAudiobook: true,
    readaloudPath: null,
    ebookPath: null,
    audiobookPath: null,
    processing: { state: 'running', task: 'align', progress: 0.5, error: null },
    ...overrides,
  };
}

let libraryDir = '';

beforeEach(async () => {
  libraryDir = await mkdtemp(join(tmpdir(), 'storyteller-library-'));
});

afterEach(async () => {
  await rm(libraryDir, { recursive: true, force: true });
});

async function setup(options: { waitCeilingMs?: number; settings?: Record<string, unknown>; remoteSettings?: Record<string, unknown> } = {}) {
  const repo = {
    updateBuild: vi.fn().mockResolvedValue({}),
    findBuildByPair: vi.fn().mockResolvedValue({ storytellerBookUuid: null }),
    findSourceEpubFile: vi.fn().mockResolvedValue({ id: 20, absolutePath: '/books/text.epub', sizeBytes: 100, mediaOverlayAvailable: false }),
    findAudioFiles: vi.fn().mockResolvedValue([{ fileId: 21, absolutePath: '/books/audio.mp3', durationSeconds: 60, format: 'mp3' }]),
    findLibraryFolders: vi.fn().mockImplementation(() => Promise.resolve([{ id: 30, path: libraryDir }])),
    findBookFileByAbsolutePath: vi.fn().mockResolvedValue(located(99, 50)),
    findBuildByOutputBook: vi.fn().mockResolvedValue(undefined),
    hasContentFileOtherThan: vi.fn().mockResolvedValue(false),
    findBookTitleAndAuthors: vi.fn().mockResolvedValue({ title: 'Local Title', authorNames: [], isbn10: null, isbn13: null, asin: null }),
  };
  const settings = {
    serverUrl: 'http://storyteller',
    username: 'service',
    passwordConfigured: true,
    pathMappings: [],
    targetLibraryId: TARGET_LIBRARY_ID,
    targetFolderId: 30,
    transport: 'api-transfer',
    deleteRemoteAfterImport: false,
    collectionName: null,
    lastCheckedAt: null,
    lastCheck: null,
    ...options.settings,
  };
  const remoteSettings = {
    readaloudLocationType: 'INTERNAL',
    readaloudLocation: null,
    importMode: 'reference',
    aligner: null,
    transcriptionEngine: null,
    alignmentGranularity: null,
    ...options.remoteSettings,
  };
  const session = {
    getServerInfo: vi.fn().mockResolvedValue({ version: '1', capabilities: ['books'] }),
    getSettings: vi.fn().mockResolvedValue(remoteSettings),
    getBook: vi.fn().mockResolvedValue(remoteBook()),
    importByReference: vi.fn().mockResolvedValue({ kind: 'created', uuid: 'story-uuid' }),
    listBooks: vi.fn().mockResolvedValue([]),
    uploadBook: vi.fn().mockResolvedValue({ uuid: 'story-uuid' }),
    process: vi.fn().mockResolvedValue(undefined),
    readaloudAvailable: vi.fn().mockResolvedValue(true),
    // Faithful to the client: a download is published with a hard link, so an occupied destination
    // fails rather than being overwritten.
    downloadReadaloud: vi.fn().mockImplementation(async (_uuid: string, destination: string) => {
      if (await exists(destination)) throw new StorytellerClientError('A read-along file already sits at the download destination', null);
      await writeFile(destination, Buffer.from('PK\u0003\u0004'));
      return { bytes: 4, filename: null };
    }),
    mergeBooks: vi.fn().mockResolvedValue({ uuid: 'story-uuid' }),
    deleteBook: vi.fn().mockResolvedValue(undefined),
    deleteCache: vi.fn().mockResolvedValue(undefined),
    cancelProcessing: vi.fn().mockResolvedValue(undefined),
    ensureCollection: vi.fn().mockResolvedValue(null),
  };
  const settingsService = {
    getConnection: vi.fn().mockResolvedValue({ serverUrl: 'http://storyteller', username: 'u', password: 'p' }),
    getSettings: vi.fn().mockResolvedValue(settings),
  };
  const client = { createSession: vi.fn().mockReturnValue(session) };
  // Read fresh at the link phase, so the default is a link that names no read-along at all: a
  // removal has to be told which book the link carried, never merely left unopposed.
  const editionLinks = {
    setReadAlongBook: vi.fn().mockResolvedValue(PAIR.link),
    findLinkForBook: vi.fn().mockResolvedValue(linkNaming(null)),
  };
  const bookService = { deleteBooks: vi.fn().mockResolvedValue(undefined) };
  const libraryService = {
    verifyUserAccess: vi.fn().mockResolvedValue(undefined),
    findOne: vi.fn().mockResolvedValue({ id: TARGET_LIBRARY_ID, type: 'books', allowedFormats: ['epub'], organizationMode: 'book_per_file' }),
  };
  const scannerService = { startScan: vi.fn().mockResolvedValue({ jobId: 1 }) };
  const sleep = vi.fn<(milliseconds: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

  const module = await Test.createTestingModule({
    providers: [
      StorytellerReadAlongBuildService,
      { provide: storytellerConfig.KEY, useValue: { waitCeilingMs: options.waitCeilingMs ?? 12 * 60 * 60_000 } },
      { provide: StorytellerRepository, useValue: repo },
      { provide: StorytellerSettingsService, useValue: settingsService },
      { provide: StorytellerClientService, useValue: client },
      { provide: EditionLinkRepository, useValue: editionLinks },
      { provide: BookService, useValue: bookService },
      { provide: LibraryService, useValue: libraryService },
      { provide: ScannerService, useValue: scannerService },
      { provide: STORYTELLER_SLEEP, useValue: sleep },
    ],
  }).compile();
  return {
    service: module.get(StorytellerReadAlongBuildService),
    repo,
    session,
    settings,
    settingsService,
    editionLinks,
    bookService,
    libraryService,
    scannerService,
    sleep,
  };
}

function captureLogs(level: 'log' | 'warn' | 'error'): string[] {
  const lines: string[] = [];
  vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
    lines.push(String(message));
  });
  return lines;
}

function countPhase(lines: string[], event: string, phase: string): number {
  return lines.filter((line) => line.startsWith(`[${event}] [${phase}]`)).length;
}

function advanceClock(sleep: ReturnType<typeof vi.fn<(milliseconds: number, signal?: AbortSignal) => Promise<void>>>): void {
  sleep.mockImplementation((milliseconds: number) => {
    vi.setSystemTime(Date.now() + milliseconds);
    return Promise.resolve();
  });
}

// `prepare` validates the source EPUB on disk; these fixtures are paths, not files.
import * as epubUtils from './storyteller-epub.utils';

vi.mock('./storyteller-epub.utils', () => ({ findSourceEpubProblem: vi.fn().mockResolvedValue(null) }));

describe('StorytellerReadAlongBuildService', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('uses api-transfer when auto transport has no path mappings', async () => {
    const { service, session } = await setup({ settings: { transport: 'auto' } });

    await runBuild(service, 1, PAIR, USER);

    expect(session.uploadBook).toHaveBeenCalledOnce();
    expect(session.importByReference).not.toHaveBeenCalled();
  });

  it('uses shared paths when mappings and CUSTOM_FOLDER cover the target', async () => {
    const { service, session, repo } = await setup({
      settings: {
        transport: 'auto',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    repo.findBookFileByAbsolutePath.mockResolvedValue(located(99, 50));

    await runBuild(service, 1, PAIR, USER);

    // Each side is imported alone and then merged: one request carrying both lets the two
    // candidates race for the same uuid, and the loser is dropped.
    expect(session.importByReference).toHaveBeenNthCalledWith(1, { paths: ['/remote/books/text.epub'], importMode: 'reference' });
    expect(session.importByReference).toHaveBeenNthCalledWith(2, { paths: ['/remote/books/audio.mp3'], importMode: 'reference' });
    expect(session.mergeBooks).toHaveBeenCalledWith(['story-uuid', 'story-uuid']);
    expect(session.uploadBook).not.toHaveBeenCalled();
  });

  // Pinned shared paths means "never push my files over the network". Falling through to an upload
  // spends hours of bandwidth on a pair the settings page reports as unavailable.
  it.each([
    {
      condition: 'no path mappings are configured',
      settings: { pathMappings: [] },
      remoteSettings: {},
      message: /no path mappings/,
    },
    {
      condition: 'the target folder is not mapped',
      settings: { pathMappings: [{ localPrefix: '/books', remotePrefix: '/remote/books' }] },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
      message: /target folder is not covered/,
    },
    {
      condition: 'the read-along location is not a custom folder',
      settings: { pathMappings: [{ localPrefix: '@library', remotePrefix: '/remote/output' }] },
      remoteSettings: {},
      message: /custom folder/,
    },
    {
      condition: 'the read-along folder sits outside the target folder',
      settings: {
        pathMappings: [
          { localPrefix: '@library', remotePrefix: '/remote/output' },
          { localPrefix: '/elsewhere', remotePrefix: '/remote/elsewhere' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/elsewhere' },
      message: /outside the target folder/,
    },
  ])('fails a pinned shared-paths build when $condition', async ({ settings, remoteSettings, message }) => {
    const { service, session, repo } = await setup({
      settings: { transport: 'shared-paths', ...settings, pathMappings: resolveMappings(settings.pathMappings) },
      remoteSettings,
    });

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow(message);

    expect(session.uploadBook).not.toHaveBeenCalled();
    expect(session.importByReference).not.toHaveBeenCalled();
    expect(repo.updateBuild).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'failed', phase: 'prepare' }));
  });

  it('fails a pinned shared-paths build when the read-along would not become its own book', async () => {
    const { service, session, libraryService } = await setup({
      settings: {
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output/readalouds' },
    });
    libraryService.findOne.mockResolvedValue({ id: TARGET_LIBRARY_ID, type: 'books', allowedFormats: ['epub'], organizationMode: 'book_per_folder' });

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow(/its own book/);

    expect(session.uploadBook).not.toHaveBeenCalled();
  });

  it('takes shared paths for a pinned build whose configuration is fully viable', async () => {
    const { service, session } = await setup({
      settings: {
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });

    await runBuild(service, 1, PAIR, USER);

    expect(session.importByReference).toHaveBeenCalled();
    expect(session.uploadBook).not.toHaveBeenCalled();
  });

  it('re-imports an EPUB2 source as a local copy rather than uploading it', async () => {
    const { service, session, repo } = await setup({
      settings: {
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    session.importByReference
      .mockResolvedValueOnce({ kind: 'epub2_detected', paths: ['/remote/books/text.epub'] })
      .mockResolvedValueOnce({ kind: 'created', uuid: 'story-uuid' });

    await runBuild(service, 1, PAIR, USER);

    // Storyteller copies from the shared mount itself; pushing the same bytes over HTTP would be
    // strictly more expensive. Only the ebook is copied - the audio stays referenced.
    expect(session.importByReference).toHaveBeenNthCalledWith(2, { paths: ['/remote/books/text.epub'], importMode: 'copy' });
    expect(session.importByReference).toHaveBeenNthCalledWith(3, expect.objectContaining({ importMode: 'reference' }));
    expect(session.uploadBook).not.toHaveBeenCalled();
    expect(repo.updateBuild).toHaveBeenCalledWith(1, expect.objectContaining({ transport: 'api-transfer' }));
  });

  it('uploads only when a copy import cannot take the EPUB2 either', async () => {
    const { service, session, repo } = await setup({
      settings: {
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    repo.findBookFileByAbsolutePath.mockResolvedValue(located(99, 50));
    session.importByReference.mockResolvedValue({ kind: 'epub2_detected', paths: ['/remote/books/text.epub'] });

    await runBuild(service, 1, PAIR, USER);

    // Reference, then copy, then give up and push the bytes.
    expect(session.importByReference).toHaveBeenCalledTimes(2);
    expect(session.uploadBook).toHaveBeenCalledOnce();
    expect(repo.updateBuild).toHaveBeenCalledWith(1, expect.objectContaining({ transport: 'api-transfer' }));
  });

  it('uploads instead when Storyteller only registered part of a referenced pair', async () => {
    const { service, session, repo } = await setup({
      settings: {
        deleteRemoteAfterImport: true,
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    repo.findBookFileByAbsolutePath.mockResolvedValue(located(99, 50));
    session.importByReference.mockResolvedValue({ kind: 'created', uuid: 'referenced-uuid' });
    session.mergeBooks.mockResolvedValue({ uuid: 'merged-uuid' });
    session.uploadBook.mockResolvedValue({ uuid: 'uploaded-uuid' });
    session.getBook.mockResolvedValue(remoteBook({ processing: IDLE }));
    session.process.mockRejectedValueOnce(
      new StorytellerClientError('Storyteller answered 409: both ebook and audiobook must be present and not missing.', 409),
    );

    await runBuild(service, 1, PAIR, USER);

    expect(session.uploadBook).toHaveBeenCalledOnce();
    expect(session.process).toHaveBeenCalledTimes(2);
    // Cleanup is reached (deleteRemoteAfterImport is on), and it must take the uploaded book -
    // Storyteller owns every file of that one. The partial referenced book stays: deleting it asks
    // Storyteller to delete source files BookOrbit does not own.
    expect(session.deleteBook).toHaveBeenCalledWith('uploaded-uuid', { preventReImport: true });
    expect(session.deleteBook).not.toHaveBeenCalledWith('merged-uuid', expect.anything());
    expect(repo.updateBuild).toHaveBeenCalledWith(1, expect.objectContaining({ transport: 'api-transfer' }));
  });

  // The user's rule: a file inside a BookOrbit library folder is never deleted by this feature.
  // Deleting a Storyteller book deletes the files attached to it, so an uploaded build whose
  // read-along Storyteller wrote into a mapped folder drops only the cache - even though the collect
  // ends up downloading, which is what used to decide this.
  it('never deletes the remote book when its read-along sits in a folder BookOrbit can see', async () => {
    const { service, session, libraryService } = await setup({
      settings: {
        transport: 'api-transfer',
        deleteRemoteAfterImport: true,
        pathMappings: [{ localPrefix: libraryDir, remotePrefix: '/remote/output' }],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    // A subfolder in a book_per_folder library is refused by the shared-path collect, which is what
    // downgrades the transport and used to unlock the delete.
    libraryService.findOne.mockResolvedValue({ id: TARGET_LIBRARY_ID, type: 'books', allowedFormats: ['epub'], organizationMode: 'book_per_folder' });
    session.uploadBook.mockResolvedValue({ uuid: 'uploaded-uuid' });
    session.getBook.mockResolvedValue(remoteBook({ aligned: true, readaloudPath: '/remote/output/aligned/Remote Title.epub' }));

    await runBuild(service, 1, PAIR, USER);

    expect(session.deleteBook).not.toHaveBeenCalled();
    expect(session.deleteCache).toHaveBeenCalledWith('uploaded-uuid');
  });

  // A mapping is a prefix rewrite, not a library membership test. A broad one covers Storyteller's
  // own asset directory, and treating that as "in a library" would leave every uploaded copy on the
  // server forever while the UI kept saying the copy was reclaimable.
  it('reclaims an uploaded book whose read-along is outside the target folder, mapping or not', async () => {
    const { service, session } = await setup({
      settings: {
        transport: 'api-transfer',
        deleteRemoteAfterImport: true,
        pathMappings: [{ localPrefix: libraryDirParent(libraryDir), remotePrefix: '/remote' }],
      },
      remoteSettings: { readaloudLocationType: 'INTERNAL', readaloudLocation: '/remote/assets' },
    });
    session.uploadBook.mockResolvedValue({ uuid: 'uploaded-uuid' });
    session.getBook.mockResolvedValue(remoteBook({ aligned: true, readaloudPath: '/remote/assets/book/aligned.epub' }));

    await runBuild(service, 1, PAIR, USER);

    expect(session.deleteBook).toHaveBeenCalledWith('uploaded-uuid', { preventReImport: true });
  });

  // Storyteller can finish a read-along and still leave a terminal job record behind, and the job
  // record is what `normalizeProcessing` reads first. Failing on it would wedge the pair: the retry
  // re-adopts the same book, an aligned book is never re-processed, and the first poll throws again.
  // Every other claim check is negative, so a book that is none of those things still becomes this
  // build's output - and a later forced rebuild deletes whatever that was. A read-along is one file:
  // a book owning anything else is the user's, not this build's.
  // A build can be resumed long after the request that checked the file, and the message has to name
  // it: the provider's own answer for an unreadable EPUB is a bare 500.
  it('names the unreadable source epub rather than surfacing a provider error', async () => {
    const { service, session } = await setup();
    vi.mocked(epubUtils.findSourceEpubProblem).mockResolvedValueOnce('missing_container');

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow(/text\.epub cannot be read as an EPUB/);
    expect(session.importByReference).not.toHaveBeenCalled();
  });

  it('refuses a collected book that owns files this build did not produce', async () => {
    const { service, session, repo } = await setup({
      settings: { transport: 'api-transfer', pathMappings: [] },
    });
    session.uploadBook.mockResolvedValue({ uuid: 'uploaded-uuid' });
    session.getBook.mockResolvedValue(remoteBook({ aligned: true, readaloudPath: null }));
    repo.hasContentFileOtherThan.mockResolvedValue(true);

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow(/never appeared/i);
  });

  it('collects an aligned read-along even when the job record reports a failure', async () => {
    const { service, session } = await setup({
      settings: { transport: 'api-transfer', pathMappings: [] },
    });
    session.uploadBook.mockResolvedValue({ uuid: 'uploaded-uuid' });
    session.getBook.mockResolvedValue(
      remoteBook({ aligned: true, readaloudPath: null, processing: { state: 'failed', task: 'align', progress: 0.7, error: 'stopped' } }),
    );

    await expect(runBuild(service, 1, PAIR, USER)).resolves.not.toThrow();
    expect(session.downloadReadaloud).toHaveBeenCalled();
  });

  it('does not upload when process fails for a reason other than missing media', async () => {
    const { service, session } = await setup({
      settings: {
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    session.getBook.mockResolvedValue(remoteBook({ processing: { state: 'idle', task: null, progress: null, error: null } }));
    session.process.mockRejectedValueOnce(new StorytellerClientError('Storyteller answered 500', 500));

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow();

    expect(session.uploadBook).not.toHaveBeenCalled();
  });

  it('downloads when Storyteller reports the read-along outside the target folder', async () => {
    const { service, session, repo } = await setup({
      settings: {
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    // An uploaded book keeps its read-along inside Storyteller, nowhere near the shared folder.
    session.getBook.mockResolvedValue(remoteBook({ aligned: true, readaloudPath: '/data/assets/Book/aligned/Book.epub' }));

    await runBuild(service, 1, PAIR, USER);

    expect(session.downloadReadaloud).toHaveBeenCalled();
    expect(repo.findBookFileByAbsolutePath).toHaveBeenCalled();
  });

  it('collects a resumed build with the transport that registered the book, not the configured one', async () => {
    const { service, session, repo } = await setup({
      settings: {
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    // A previous attempt uploaded this pair, so its read-aloud lives inside Storyteller.
    repo.findBuildByPair.mockResolvedValue({ storytellerBookUuid: 'story-uuid', transport: 'api-transfer' });

    await runBuild(service, 1, PAIR, USER);

    expect(session.importByReference).not.toHaveBeenCalled();
    expect(session.downloadReadaloud).toHaveBeenCalled();
  });

  describe('when Storyteller already holds the paths', () => {
    const SHARED = {
      settings: {
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: '@library', remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    };
    const REFUSED = new StorytellerClientError('Storyteller answered 405: {"message":"Unable to create book from provided paths"}', 405);

    async function refusedSetup() {
      const context = await setup({ ...SHARED, settings: { ...SHARED.settings, pathMappings: resolveMappings(SHARED.settings.pathMappings) } });
      context.session.importByReference.mockRejectedValueOnce(REFUSED);
      return context;
    }

    it('takes over the one book whose ebook sits at the offered path and processes it', async () => {
      const { service, session, repo } = await refusedSetup();
      const logs = captureLogs('log');
      session.listBooks.mockResolvedValue([
        remoteBook({ uuid: 'other-uuid', ebookPath: '/remote/books/other.epub' }),
        remoteBook({ uuid: 'existing-uuid', ebookPath: '/remote/books/text.epub' }),
      ]);
      session.getBook
        .mockResolvedValueOnce(remoteBook({ uuid: 'existing-uuid', processing: IDLE }))
        .mockResolvedValue(remoteBook({ uuid: 'existing-uuid' }));

      await runBuild(service, 1, PAIR, USER);

      expect(repo.updateBuild).toHaveBeenCalledWith(1, { transport: 'shared-paths', storytellerBookUuid: 'existing-uuid' });
      expect(session.process).toHaveBeenCalledWith('existing-uuid');
      expect(session.importByReference).toHaveBeenCalledOnce();
      expect(session.mergeBooks).not.toHaveBeenCalled();
      expect(session.uploadBook).not.toHaveBeenCalled();
      expect(
        logs.some(
          (line) =>
            line.startsWith('[storyteller.read_along.register] [end]') &&
            line.includes('outcome=reused_existing') &&
            line.includes('storytellerBookUuid=existing-uuid'),
        ),
      ).toBe(true);
    });

    it.each([
      ['no book matches', [remoteBook({ uuid: 'other-uuid', ebookPath: '/remote/books/other.epub' })]],
      [
        'two books match',
        [remoteBook({ uuid: 'a-uuid', ebookPath: '/remote/books/text.epub' }), remoteBook({ uuid: 'b-uuid', ebookPath: '/remote/books/text.epub' })],
      ],
      ['the path differs only in case', [remoteBook({ uuid: 'cased-uuid', ebookPath: '/remote/books/Text.epub' })]],
    ])('fails with a clear error when %s', async (_case, books) => {
      const { service, session, repo } = await refusedSetup();
      session.listBooks.mockResolvedValue(books);

      await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow(
        'Storyteller already has a book for these files and it could not be matched; remove or import it in Storyteller',
      );

      expect(session.process).not.toHaveBeenCalled();
      expect(session.uploadBook).not.toHaveBeenCalled();
      expect(repo.updateBuild).not.toHaveBeenCalledWith(1, expect.objectContaining({ storytellerBookUuid: expect.any(String) }));
    });
  });

  // A Generate after a cancel claims the kept row with its uuid: importing the same paths again is
  // what Storyteller refuses with a 405 while it still holds the referenced book.
  it('resumes the reference-imported book a cancelled build kept instead of importing its paths again', async () => {
    const { service, session, repo } = await setup({
      settings: {
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    repo.findBuildByPair.mockResolvedValue({ storytellerBookUuid: 'story-uuid', transport: 'shared-paths' });

    await runBuild(service, 1, PAIR, USER);

    expect(session.importByReference).not.toHaveBeenCalled();
    expect(session.uploadBook).not.toHaveBeenCalled();
    expect(repo.updateBuild).not.toHaveBeenCalledWith(1, { storytellerBookUuid: null });
    expect(repo.updateBuild).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'ready' }));
  });

  it('keeps the remembered uuid when the book read fails rather than importing a second copy', async () => {
    const { service, session, repo } = await setup();
    repo.findBuildByPair.mockResolvedValue({ storytellerBookUuid: 'story-uuid', transport: 'api-transfer' });
    // Only a 404 reads as null; an unreadable response throws, and treating that as an absence
    // would register the pair all over again.
    session.getBook.mockRejectedValue(new StorytellerClientError('Storyteller returned a book response that could not be read', 200));

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow('could not be read');

    expect(repo.updateBuild).not.toHaveBeenCalledWith(1, { storytellerBookUuid: null });
    expect(session.uploadBook).not.toHaveBeenCalled();
    expect(session.importByReference).not.toHaveBeenCalled();
  });

  it('re-registers the pair when Storyteller no longer has the remembered book', async () => {
    const { service, session, repo } = await setup();
    repo.findBuildByPair.mockResolvedValue({ storytellerBookUuid: 'story-uuid', transport: 'api-transfer' });
    session.getBook.mockResolvedValueOnce(null).mockResolvedValue(remoteBook());

    await runBuild(service, 1, PAIR, USER);

    expect(repo.updateBuild).toHaveBeenCalledWith(1, { storytellerBookUuid: null });
    expect(session.uploadBook).toHaveBeenCalledOnce();
  });

  it('uploads the pair when the merge that pairs it fails', async () => {
    const { service, session } = await setup({
      settings: {
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    session.mergeBooks.mockRejectedValue(new Error('merge refused'));

    // Without a merge the two imported halves stay separate books, neither of which can be aligned.
    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow('merge refused');
  });

  it('waits for both media links before processing a freshly imported pair', async () => {
    const { service, session } = await setup();
    const idle = { state: 'idle', task: null, progress: null, error: null };
    session.getBook
      .mockResolvedValueOnce(remoteBook({ hasEbook: true, hasAudiobook: false, processing: idle }))
      .mockResolvedValue(remoteBook({ hasEbook: true, hasAudiobook: true, processing: idle }));

    await runBuild(service, 1, PAIR, USER);

    // Storyteller rejects processing outright until both halves are attached, so the unlinked read
    // must not be the one that triggers it.
    expect(session.getBook.mock.calls.length).toBeGreaterThan(1);
    expect(session.getBook.mock.invocationCallOrder[1]).toBeLessThan(session.process.mock.invocationCallOrder[0]);
    expect(session.process).toHaveBeenCalledOnce();
  });

  it('skips process when the Storyteller book is already aligned', async () => {
    const { service, session } = await setup();
    session.getBook.mockResolvedValue(remoteBook({ aligned: true, processing: { state: 'completed', task: null, progress: 1, error: null } }));

    await runBuild(service, 1, PAIR, USER);

    expect(session.process).not.toHaveBeenCalled();
  });

  it('replaces the previous output only once the new one is collected and linked', async () => {
    const { service, repo, session, editionLinks, bookService } = await setup();
    editionLinks.findLinkForBook.mockResolvedValue(linkNaming(88));
    // The disk state every force rebuild of a downloaded read-along starts from: the previous
    // output is a file this pair fetched and the scan indexed.
    const previousOutput = join(libraryDir, 'Remote Title (read-along 1).epub');
    await writeFile(previousOutput, Buffer.from('PK\u0003\u0004'));
    repo.findBookFileByAbsolutePath.mockImplementation((path: string) =>
      Promise.resolve(path === previousOutput ? located(88, 40) : located(99, 50)),
    );

    await runBuild(service, 1, pairWithPreviousOutput(88), USER, { force: true, oldOutputBookId: 88 });

    // A rebuild was asked for a new alignment, so it fetches one and lands beside the file it
    // replaces. Adopting that file instead reports the old read-along as the new one, refuses the
    // removal as "the same book", and leaves the remote cleanup to delete the alignment nobody kept.
    expect(session.downloadReadaloud).toHaveBeenCalledOnce();
    expect(session.downloadReadaloud).not.toHaveBeenCalledWith(expect.anything(), previousOutput);
    expect(bookService.deleteBooks).toHaveBeenCalledWith([88], USER);
    expect(bookService.deleteBooks.mock.invocationCallOrder[0]).toBeGreaterThan(editionLinks.setReadAlongBook.mock.invocationCallOrder[0]);
  });

  it('refuses the rebuild rather than adopt the output it was asked to replace', async () => {
    const { service, repo, session, bookService } = await setup();
    // A rebuild registers a new Storyteller book, so its destination is free - unless the caller
    // pinned it to the book the current output came from, and then the file there is that output.
    const previousOutput = downloadDestination(1);
    await writeFile(previousOutput, Buffer.from('PK\u0003\u0004'));
    repo.findBookFileByAbsolutePath.mockResolvedValue(located(88, 40));

    await expect(runBuild(service, 1, pairWithPreviousOutput(88), USER, { force: true, oldOutputBookId: 88 })).rejects.toThrow('cannot adopt');

    expect(session.downloadReadaloud).not.toHaveBeenCalled();
    expect(bookService.deleteBooks).not.toHaveBeenCalled();
  });

  it('keeps the previous output when a force rebuild fails before a replacement exists', async () => {
    const { service, session, bookService } = await setup();
    session.uploadBook.mockRejectedValue(new Error('storyteller unreachable'));

    await expect(runBuild(service, 1, PAIR, USER, { force: true, oldOutputBookId: 88 })).rejects.toThrow('storyteller unreachable');

    // Deleting up front leaves the user with nothing: the file is gone from disk, the book row with
    // it, and the link cleared, while the replacement was never built.
    expect(bookService.deleteBooks).not.toHaveBeenCalled();
  });

  it('keeps the previous output when a shared-path rebuild resolves to the same book', async () => {
    const { service, bookService, editionLinks } = await setup({
      settings: {
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    // Every other refusal passes, so the same-book one is the only thing that can stop the delete.
    editionLinks.findLinkForBook.mockResolvedValue(linkNaming(99));

    await runBuild(service, 1, PAIR, USER, { force: true, oldOutputBookId: 99 });

    expect(bookService.deleteBooks).not.toHaveBeenCalled();
  });

  it('waits with fake time until the read-along is available', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { service, session, sleep } = await setup();
    advanceClock(sleep);
    session.readaloudAvailable.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await runBuild(service, 1, PAIR, USER);

    expect(sleep).toHaveBeenCalledWith(10_000, expect.any(AbortSignal));
    expect(session.readaloudAvailable).toHaveBeenCalledTimes(2);
  });

  // A reported failure only ends the build when there is nothing to fetch: Storyteller can finish a
  // read-along and still leave a terminal job record, and the file is the evidence that matters.
  it('fails the wait when Storyteller reports a failure and no read-along is there to fetch', async () => {
    const { service, session, repo } = await setup();
    session.readaloudAvailable.mockResolvedValue(false);
    session.getBook
      .mockResolvedValueOnce(remoteBook())
      .mockResolvedValueOnce(remoteBook({ processing: { state: 'failed', task: 'align', progress: 0.4, error: 'alignment failed' } }));

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow('alignment failed');
    expect(repo.updateBuild).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'failed', phase: 'wait' }));
  });

  it('stops waiting at the configured ceiling', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { service, session, sleep, repo } = await setup({ waitCeilingMs: 10_000 });
    advanceClock(sleep);
    session.readaloudAvailable.mockResolvedValue(false);

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow('wait ceiling');
    expect(repo.updateBuild).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'failed', phase: 'wait' }));
  });

  it('stops after 20 consecutive read-along availability errors', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { service, session, sleep } = await setup();
    advanceClock(sleep);
    session.readaloudAvailable.mockRejectedValue(new Error('proxy unavailable'));

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow('20 times');
    expect(session.readaloudAvailable).toHaveBeenCalledTimes(20);
  });

  it('falls back to api-transfer when shared-path collection times out', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { service, session, repo, scannerService, sleep } = await setup({
      settings: {
        transport: 'auto',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    advanceClock(sleep);
    // Storyteller's own output never appears; only the file BookOrbit downloads does.
    repo.findBookFileByAbsolutePath.mockImplementation((path: string) =>
      Promise.resolve(path.includes('(read-along ') ? located(99, 50) : undefined),
    );

    await runBuild(service, 1, PAIR, USER);

    expect(scannerService.startScan).toHaveBeenCalledTimes(3);
    expect(repo.updateBuild).toHaveBeenCalledWith(1, { transport: 'api-transfer' });
    expect(session.downloadReadaloud).toHaveBeenCalledOnce();
  });

  it('fails the build at the collect phase when the transfer breaks', async () => {
    const { service, session, repo, editionLinks } = await setup();
    session.downloadReadaloud.mockRejectedValue(new Error('connection reset'));

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow('connection reset');
    expect(repo.updateBuild).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'failed', phase: 'collect' }));
    expect(editionLinks.setReadAlongBook).not.toHaveBeenCalled();
  });

  it('gives two pairs that share a title their own download destinations', async () => {
    const { service, session, repo } = await setup();
    // The pair is the unique key of a build row, so two builds of the SAME pair can never carry two
    // ids; what has to stay apart is two pairs that sanitize to the same filename.
    repo.findBookFileByAbsolutePath.mockImplementation((path: string) =>
      Promise.resolve(path.includes('read-along 7') ? located(97, 50) : located(98, 51)),
    );

    await runBuild(service, 7, PAIR, USER);
    await runBuild(service, 8, OTHER_PAIR, USER);

    expect(session.downloadReadaloud).toHaveBeenNthCalledWith(1, 'story-uuid', downloadDestination(7));
    expect(session.downloadReadaloud).toHaveBeenNthCalledWith(2, 'story-uuid', downloadDestination(8));
    expect(repo.updateBuild).toHaveBeenCalledWith(7, expect.objectContaining({ status: 'ready', outputBookId: 97 }));
    expect(repo.updateBuild).toHaveBeenCalledWith(8, expect.objectContaining({ status: 'ready', outputBookId: 98 }));
  });

  it('adopts the read-along a previous attempt already published instead of downloading it again', async () => {
    const { service, session, repo } = await setup();
    // A retry resumes the Storyteller book the failed attempt registered, so it computes that
    // attempt's exact filename again.
    repo.findBuildByPair.mockResolvedValue({ storytellerBookUuid: 'story-uuid', transport: 'api-transfer' });
    await writeFile(downloadDestination(1), Buffer.from('PK\u0003\u0004'));

    await runBuild(service, 1, PAIR, USER);

    expect(session.downloadReadaloud).not.toHaveBeenCalled();
    expect(repo.updateBuild).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'ready', outputBookId: 99 }));
  });

  it('clears the orphan a previous attempt left at the destination so the retry can publish', async () => {
    const { service, session, repo } = await setup();
    const destination = downloadDestination(1);
    // Attempt one downloaded, then died before the scan indexed it: a file with no book row.
    await writeFile(destination, Buffer.from('half a build'));
    let scanned = false;
    session.downloadReadaloud.mockImplementation(async (_uuid: string, target: string) => {
      if (await exists(target)) throw new StorytellerClientError('A read-along file already sits at the download destination', null);
      await writeFile(target, Buffer.from('PK\u0003\u0004'));
      scanned = true;
      return { bytes: 4, filename: null };
    });
    repo.findBookFileByAbsolutePath.mockImplementation(() => Promise.resolve(scanned ? located(99, 50) : undefined));

    await runBuild(service, 1, PAIR, USER);

    expect(session.downloadReadaloud).toHaveBeenCalledOnce();
    expect(repo.updateBuild).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'ready', outputBookId: 99 }));
  });

  it('persists the collect phase for a downloaded read-along', async () => {
    const { service, repo } = await setup();

    await runBuild(service, 1, PAIR, USER);

    // Without this the UI reports the wait phase, with the Storyteller progress it stopped
    // updating, for as long as the download runs.
    expect(repo.updateBuild).toHaveBeenCalledWith(1, { phase: 'collect' });
  });

  it('clears only the processing cache for a referenced book, never the book itself', async () => {
    const { service, session, repo } = await setup({
      settings: {
        deleteRemoteAfterImport: true,
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    repo.findBookFileByAbsolutePath.mockResolvedValue(located(99, 50));

    await runBuild(service, 1, PAIR, USER);

    // A referenced book's ebook and audio are the user's own files; deleting the book would ask
    // Storyteller to remove them.
    expect(session.deleteCache).toHaveBeenCalledWith('story-uuid');
    expect(session.deleteBook).not.toHaveBeenCalled();
  });

  it('clears only the processing cache when Storyteller copied the ebook but still references the audio', async () => {
    const { service, session } = await setup({
      settings: {
        deleteRemoteAfterImport: true,
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    session.importByReference
      .mockResolvedValueOnce({ kind: 'epub2_detected', paths: ['/remote/books/text.epub'] })
      .mockResolvedValue({ kind: 'created', uuid: 'story-uuid' });

    await runBuild(service, 1, PAIR, USER);

    // The EPUB2 retry copies the ebook, which moves the read-along inside Storyteller and so sets
    // the transport to api-transfer - but the audio is still the user's own file, and deleting the
    // book would ask Storyteller to delete it.
    expect(session.deleteCache).toHaveBeenCalledWith('story-uuid');
    expect(session.deleteBook).not.toHaveBeenCalled();
  });

  it('honours a per-build cleanup override over the instance setting', async () => {
    const { service, session } = await setup({ settings: { deleteRemoteAfterImport: false } });

    await runBuild(service, 1, PAIR, USER, { cleanUpRemote: true });

    expect(session.deleteBook).toHaveBeenCalledOnce();
  });

  it('skips cleanup when a per-build override turns the instance setting off', async () => {
    const { service, session } = await setup({ settings: { deleteRemoteAfterImport: true } });

    await runBuild(service, 1, PAIR, USER, { cleanUpRemote: false });

    expect(session.deleteBook).not.toHaveBeenCalled();
    expect(session.deleteCache).not.toHaveBeenCalled();
  });

  it('keeps a successful import when remote deletion fails', async () => {
    const { service, session, repo } = await setup({ settings: { deleteRemoteAfterImport: true } });
    session.deleteBook.mockRejectedValue(new Error('delete denied'));

    await expect(runBuild(service, 1, PAIR, USER)).resolves.toBeUndefined();
    expect(repo.updateBuild).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'ready', outputBookId: 99 }));
  });

  it('maps a unique violation while linking and persists the failed build', async () => {
    const { service, editionLinks, repo, session } = await setup({ settings: { deleteRemoteAfterImport: true } });
    editionLinks.setReadAlongBook.mockRejectedValue({ code: '23505' });

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow('imported book was kept');
    expect(repo.updateBuild).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'failed', phase: 'link', error: expect.stringContaining('imported book was kept') }),
    );
    expect(session.deleteBook).not.toHaveBeenCalled();
  });

  it('persists failures without deleting the Storyteller book', async () => {
    const { service, session, repo } = await setup();
    session.getBook.mockResolvedValue(remoteBook({ processing: { state: 'idle', task: null, progress: null, error: null } }));
    session.process.mockRejectedValue(new Error('process rejected'));

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow('process rejected');
    expect(repo.updateBuild).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'failed', phase: 'process' }));
    expect(session.deleteBook).not.toHaveBeenCalled();
  });

  it('stores the error the user reads, not the log-escaped one', async () => {
    const { service, session, repo } = await setup();
    session.getBook.mockResolvedValue(remoteBook({ processing: { state: 'idle', task: null, progress: null, error: null } }));
    session.process.mockRejectedValue(new Error('cannot read "/books/a\\b.epub"'));

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow();

    expect(repo.updateBuild).toHaveBeenCalledWith(1, expect.objectContaining({ error: 'cannot read "/books/a\\b.epub"' }));
  });

  it('records the imported book before it is attached to the link', async () => {
    const { service, editionLinks, repo } = await setup();
    editionLinks.setReadAlongBook.mockRejectedValue({ code: '23505' });

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow('imported book was kept');

    // The failure says the imported book was kept, so the row has to say which book that is.
    expect(repo.updateBuild).toHaveBeenCalledWith(1, { outputBookId: 99 });
  });

  it('keeps the shared-paths transport when the upload that would replace it fails', async () => {
    const { service, session, repo } = await setup({
      settings: {
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    session.importByReference.mockResolvedValue({ kind: 'epub2_detected', paths: ['/remote/books/text.epub'] });
    session.uploadBook.mockRejectedValue(new Error('upload refused'));

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow('upload refused');

    // A row left claiming api-transfer with the old referenced uuid can never take the fallback
    // again, because the fallback only fires for a build that still says shared-paths.
    expect(repo.updateBuild).not.toHaveBeenCalledWith(1, expect.objectContaining({ transport: 'api-transfer' }));
  });

  it('collects from the path Storyteller reports once the read-along exists', async () => {
    const { service, session, repo } = await setup({
      settings: {
        transport: 'api-transfer',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    // The snapshot the wait loop polls with predates the read-along, so it reports no path at all.
    session.getBook
      .mockResolvedValueOnce(remoteBook())
      .mockResolvedValueOnce(remoteBook())
      .mockResolvedValue(remoteBook({ aligned: true, readaloudPath: '/remote/output/Remote Title.epub' }));

    await runBuild(service, 1, PAIR, USER);

    expect(session.downloadReadaloud).not.toHaveBeenCalled();
    expect(repo.findBookFileByAbsolutePath).toHaveBeenCalledWith(join(libraryDir, 'Remote Title.epub'));
  });

  it('retries a transient book read while waiting instead of failing the build', async () => {
    const { service, session } = await setup();
    session.getBook.mockResolvedValueOnce(remoteBook()).mockRejectedValueOnce(new Error('gateway timeout')).mockResolvedValue(remoteBook());

    // The same 503 from the availability probe buys 20 retries; a 12-hour build must not die
    // because the read beside it was the one that hit it.
    await expect(runBuild(service, 1, PAIR, USER)).resolves.toBeUndefined();
    expect(session.readaloudAvailable).toHaveBeenCalled();
  });

  it('logs the build start before preparation can fail', async () => {
    const { service, repo } = await setup();
    const logged = captureLogs('log');
    repo.findSourceEpubFile.mockResolvedValue(null);

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow('no EPUB file');

    // A [fail] whose [start] was never logged reads as a build that never ran.
    expect(countPhase(logged, 'storyteller.read_along.build', 'start')).toBe(1);
  });

  it('balances the register event when the pair has to be uploaded after all', async () => {
    const { service, session } = await setup({
      settings: {
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    const logged = captureLogs('log');
    session.importByReference.mockResolvedValue({ kind: 'epub2_detected', paths: ['/remote/books/text.epub'] });

    await runBuild(service, 1, PAIR, USER);

    expect(countPhase(logged, 'storyteller.read_along.register', 'start')).toBe(1);
    expect(countPhase(logged, 'storyteller.read_along.register', 'end')).toBe(1);
    expect(countPhase(logged, 'storyteller.read_along.upload', 'start')).toBe(1);
    expect(countPhase(logged, 'storyteller.read_along.upload', 'end')).toBe(1);
  });

  it('attributes a cleanup failure to the cleanup event, not to the completed build', async () => {
    const { service, session } = await setup({ settings: { deleteRemoteAfterImport: true } });
    const warned = captureLogs('warn');
    const logged = captureLogs('log');
    session.deleteBook.mockRejectedValue(new Error('delete denied'));

    await runBuild(service, 1, PAIR, USER);

    expect(countPhase(warned, 'storyteller.read_along.cleanup', 'fail')).toBe(1);
    expect(countPhase(warned, 'storyteller.read_along.build', 'fail')).toBe(0);
    expect(countPhase(warned, 'storyteller.read_along.collect', 'fail')).toBe(0);
    expect(countPhase(logged, 'storyteller.read_along.build', 'end')).toBe(1);
  });

  it('downloads when a resumed shared-path build resolves outside the target folder', async () => {
    const { service, session, repo } = await setup({
      settings: {
        transport: 'auto',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
          { localPrefix: '/elsewhere', remotePrefix: '/remote/elsewhere' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/elsewhere' },
    });
    repo.findBuildByPair.mockResolvedValue({ storytellerBookUuid: 'story-uuid', transport: 'shared-paths' });
    // Storyteller reports no path of its own, so collection derives one from the read-aloud folder,
    // which has since been pointed at a library the scan never covers.
    session.getBook.mockResolvedValue(remoteBook({ aligned: true, readaloudPath: null }));

    await runBuild(service, 1, PAIR, USER);

    expect(session.downloadReadaloud).toHaveBeenCalled();
  });

  it('never makes one of the pair own editions the collected output', async () => {
    const { service, repo, editionLinks, bookService } = await setup();
    repo.findBookFileByAbsolutePath.mockResolvedValue(located(PAIR.textBookId, 50));

    await expect(runBuild(service, 1, PAIR, USER, { force: true, oldOutputBookId: 88 })).rejects.toThrow('never appeared in the read-along library');

    // Adopting the source edition is what later lets a force rebuild delete the user's own ebook.
    expect(editionLinks.setReadAlongBook).not.toHaveBeenCalled();
    expect(bookService.deleteBooks).not.toHaveBeenCalled();
  });

  it('does not adopt a book another read-along build already produced', async () => {
    const { service, repo, editionLinks } = await setup();
    const warned = captureLogs('warn');
    const logged = captureLogs('log');
    repo.findBuildByOutputBook.mockResolvedValue({ id: 2, outputBookId: 99 });

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow('never appeared in the read-along library');

    expect(editionLinks.setReadAlongBook).not.toHaveBeenCalled();
    // The rejected candidate is its own operation: logged under the collect event it is an extra
    // line inside a collect that may still go on to succeed through another route.
    expect(countPhase(logged, 'storyteller.read_along.claim', 'start')).toBe(1);
    expect(countPhase(warned, 'storyteller.read_along.claim', 'end')).toBe(1);
    // A decision that declined is an outcome, not an exception: nothing named RejectedOutputBook is
    // ever thrown, so a [fail] carrying it as errorClass names a class that does not exist.
    expect(countPhase(warned, 'storyteller.read_along.claim', 'fail')).toBe(0);
    expect(warned.some((line) => line.includes('claimed=false') && line.includes('build 2 output'))).toBe(true);
    expect(warned.some((line) => line.includes('errorClass='))).toBe(false);
  });

  it('logs an adoption under its own event instead of a second collect end', async () => {
    const { service, repo } = await setup();
    repo.findBuildByPair.mockResolvedValue({ storytellerBookUuid: 'story-uuid', transport: 'api-transfer' });
    await writeFile(downloadDestination(1), Buffer.from('PK\u0003\u0004'));
    const logged = captureLogs('log');

    await runBuild(service, 1, PAIR, USER);

    expect(countPhase(logged, 'storyteller.read_along.collect', 'start')).toBe(1);
    expect(countPhase(logged, 'storyteller.read_along.collect', 'end')).toBe(1);
    expect(countPhase(logged, 'storyteller.read_along.adopt', 'start')).toBe(1);
    expect(countPhase(logged, 'storyteller.read_along.adopt', 'end')).toBe(1);
  });

  it('logs clearing an orphaned download under its own event instead of a second collect start', async () => {
    const { service, repo, session } = await setup();
    // Attempt one downloaded, then died before the scan indexed it: a file with no book row.
    await writeFile(downloadDestination(1), Buffer.from('half a build'));
    let scanned = false;
    session.downloadReadaloud.mockImplementation(async (_uuid: string, target: string) => {
      await writeFile(target, Buffer.from('PK\u0003\u0004'));
      scanned = true;
      return { bytes: 4, filename: null };
    });
    repo.findBookFileByAbsolutePath.mockImplementation(() => Promise.resolve(scanned ? located(99, 50) : undefined));
    const logged = captureLogs('log');

    await runBuild(service, 1, PAIR, USER);

    expect(countPhase(logged, 'storyteller.read_along.collect', 'start')).toBe(1);
    expect(countPhase(logged, 'storyteller.read_along.collect', 'end')).toBe(1);
    expect(countPhase(logged, 'storyteller.read_along.clear_orphan', 'start')).toBe(1);
    expect(countPhase(logged, 'storyteller.read_along.clear_orphan', 'end')).toBe(1);
  });

  it('never downloads a read-along into a dotfile no scanner walk would index', async () => {
    const { service, session } = await setup();
    session.getBook.mockResolvedValue(remoteBook({ title: '.hack//SIGN' }));

    await runBuild(service, 1, PAIR, USER);

    // A dotfile is skipped by every walk, so the collect would spin out its 15-minute ceiling and
    // each retry would download it again.
    const destination = session.downloadReadaloud.mock.calls[0]?.[1] ?? '';
    expect(basename(destination).startsWith('.')).toBe(false);
  });

  it('refuses shared paths when a book_per_folder library would fold the read-along into a folder book', async () => {
    const { service, session, libraryService } = await setup({
      settings: {
        transport: 'auto',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output/readalouds' },
    });
    libraryService.findOne.mockResolvedValue({ id: 3, type: 'books', allowedFormats: ['epub'], organizationMode: 'book_per_folder' });

    await runBuild(service, 1, PAIR, USER);

    // One folder below the library root, book_per_folder makes the whole subfolder one book: the
    // read-along would join a book this build cannot claim, every build in that folder would
    // download its content a second time, and a rebuild would delete the lot.
    expect(session.uploadBook).toHaveBeenCalledOnce();
    expect(session.importByReference).not.toHaveBeenCalled();
  });

  it('keeps shared paths in a book_per_folder library when the read-along lands in the folder root', async () => {
    const { service, session, libraryService } = await setup({
      settings: {
        transport: 'auto',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    libraryService.findOne.mockResolvedValue({ id: 3, type: 'books', allowedFormats: ['epub'], organizationMode: 'book_per_folder' });

    await runBuild(service, 1, PAIR, USER);

    // A root-level primary file is its own book whatever the organization mode, so the mode alone
    // must not cost the transport.
    expect(session.importByReference).toHaveBeenCalled();
    expect(session.uploadBook).not.toHaveBeenCalled();
  });

  it('downloads when Storyteller writes the read-along into a subfolder of a book_per_folder library', async () => {
    const { service, session, libraryService } = await setup({
      settings: {
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    libraryService.findOne.mockResolvedValue({ id: 3, type: 'books', allowedFormats: ['epub'], organizationMode: 'book_per_folder' });
    // The read-aloud folder was root-level at registration; Storyteller wrote a folder deeper.
    session.getBook.mockResolvedValue(remoteBook({ aligned: true, readaloudPath: '/remote/output/aligned/Remote Title.epub' }));

    await runBuild(service, 1, PAIR, USER);

    expect(session.downloadReadaloud).toHaveBeenCalledOnce();
  });

  it('keeps the Storyteller book the caller chose when it answers 409 at process', async () => {
    const { service, session, repo } = await setup({
      settings: {
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    // A caller-chosen uuid: startBuild stored it and left the transport null, because BookOrbit
    // never registered this book and knows nothing about what is attached to it.
    repo.findBuildByPair.mockResolvedValue({ storytellerBookUuid: 'chosen-uuid', transport: null });
    session.getBook.mockResolvedValue(remoteBook({ uuid: 'chosen-uuid', processing: IDLE }));
    session.process.mockRejectedValue(new StorytellerClientError('Storyteller answered 409: both ebook and audiobook must be present.', 409));

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow('409');

    // The 409 fallback answers an import this run made. Uploading here abandons the book the user
    // picked and pushes gigabytes they never asked to copy.
    expect(session.uploadBook).not.toHaveBeenCalled();
  });

  it('refuses to delete a previous output that is one of the pair own editions', async () => {
    const { service, bookService, editionLinks } = await setup();
    editionLinks.findLinkForBook.mockResolvedValue(linkNaming(PAIR.textBookId));

    await runBuild(service, 1, PAIR, USER, { force: true, oldOutputBookId: PAIR.textBookId });

    // deleteBooks removes every file the book owns from disk.
    expect(bookService.deleteBooks).not.toHaveBeenCalled();
  });

  it('refuses to delete a previous output the edition link never named', async () => {
    const { service, bookService, editionLinks } = await setup();
    editionLinks.findLinkForBook.mockResolvedValue(linkNaming(88));

    await runBuild(service, 1, pairWithPreviousOutput(88), USER, { force: true, oldOutputBookId: 77 });

    expect(bookService.deleteBooks).not.toHaveBeenCalled();
  });

  it('refuses to delete a previous output the link no longer names, however the request remembered it', async () => {
    const { service, bookService, editionLinks } = await setup();
    // The user unlinked the read-along to keep it as a book of its own. That clears the link column
    // and nothing else: the build row still remembers the book, and the pair snapshot this build
    // was handed at request time still names it.
    editionLinks.findLinkForBook.mockResolvedValue(linkNaming(null));

    await runBuild(service, 1, pairWithPreviousOutput(300), USER, { force: true, oldOutputBookId: 300 });

    // Nothing left says this build produced book 300, and deleteBooks takes its files with it.
    expect(bookService.deleteBooks).not.toHaveBeenCalled();
  });

  it('refuses to delete a previous output that another build owns', async () => {
    const { service, repo, bookService, editionLinks } = await setup();
    const warned = captureLogs('warn');
    editionLinks.findLinkForBook.mockResolvedValue(linkNaming(88));
    repo.findBuildByOutputBook.mockImplementation((bookId: number) => Promise.resolve(bookId === 88 ? { id: 2, outputBookId: 88 } : undefined));

    await runBuild(service, 1, pairWithPreviousOutput(88), USER, { force: true, oldOutputBookId: 88 });

    expect(bookService.deleteBooks).not.toHaveBeenCalled();
    // A removal that declined is the operation's outcome, not an exception: nothing named
    // RefusedPreviousOutput is ever thrown, so errorClass has no class to name here.
    const refusal = warned.find((line) => line.startsWith('[storyteller.read_along.cleanup] [end]'));
    expect(refusal).toContain('removed=false');
    expect(refusal).not.toContain('errorClass=');
  });

  it('keeps the uploaded uuid when the 409 fallback cannot process the book it uploaded', async () => {
    const { service, session, repo } = await setup({
      settings: {
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    session.importByReference.mockResolvedValue({ kind: 'created', uuid: 'referenced-uuid' });
    session.mergeBooks.mockResolvedValue({ uuid: 'merged-uuid' });
    session.uploadBook.mockResolvedValue({ uuid: 'uploaded-uuid' });
    session.getBook.mockResolvedValue(remoteBook({ processing: IDLE }));
    session.process
      .mockRejectedValueOnce(new StorytellerClientError('Storyteller answered 409: both ebook and audiobook must be present.', 409))
      .mockRejectedValueOnce(new Error('process refused'));

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow('process refused');

    // The upload persisted its own uuid. Writing the merged one back over it orphans gigabytes that
    // nothing points at, and the next retry resumes the book that 409s and uploads another copy.
    const uuidWrites = repo.updateBuild.mock.calls.filter((call) => 'storytellerBookUuid' in call[1]);
    expect(uuidWrites.at(-1)?.[1]).toMatchObject({ storytellerBookUuid: 'uploaded-uuid' });
  });

  it('waits for the uploaded book media links before processing it after a 409', async () => {
    const { service, session, sleep } = await setup({
      settings: {
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    session.getBook
      .mockResolvedValueOnce(remoteBook({ processing: IDLE }))
      .mockResolvedValueOnce(remoteBook({ hasAudiobook: false, processing: IDLE }))
      .mockResolvedValue(remoteBook({ processing: IDLE }));
    session.process.mockRejectedValueOnce(new StorytellerClientError('Storyteller answered 409: both ebook and audiobook must be present.', 409));

    await runBuild(service, 1, PAIR, USER);

    // A many-track audiobook is exactly what produced the 409, and a TUS transfer that has just
    // finalised has not attached its tracks yet: processing straight after the upload is the same
    // mistake the first attempt was told to wait out.
    expect(session.process).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000, expect.any(AbortSignal));
    expect(session.getBook.mock.invocationCallOrder[2]).toBeLessThan(session.process.mock.invocationCallOrder[1]);
  });

  it('retries a transient book read while the media links attach', async () => {
    const { service, session } = await setup();
    session.getBook.mockRejectedValueOnce(new Error('gateway timeout')).mockResolvedValue(remoteBook({ processing: IDLE }));

    // One 503 in this window used to discard everything the build had done, including an upload
    // that had just finished pushing gigabytes.
    await expect(runBuild(service, 1, PAIR, USER)).resolves.toBeUndefined();
    expect(session.process).toHaveBeenCalledOnce();
  });

  it('stops after 20 consecutive book reads fail while the media links attach', async () => {
    const { service, session } = await setup();
    session.getBook.mockRejectedValue(new Error('proxy unavailable'));

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow('20 times in a row');
    expect(session.getBook).toHaveBeenCalledTimes(20);
  });

  it('treats a book Storyteller no longer has as terminal while the media links attach', async () => {
    const { service, session } = await setup();
    session.getBook.mockResolvedValue(null);

    // Only a genuine 404 ends the wait; a retry budget must not turn an absence into 20 polls.
    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow('disappeared before processing');
    expect(session.getBook).toHaveBeenCalledOnce();
  });

  it('never claims a book a second library indexed at the read-along path', async () => {
    const { service, session, repo, editionLinks } = await setup({
      settings: {
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    // Book libraries may cover overlapping folders and absolute_path is unique across all of them,
    // so the row at the path Storyteller wrote to belongs to whichever library indexed it first. In
    // a book_per_folder library that row is the folder-book for the whole read-along directory, and
    // claiming it is what later lets a force rebuild delete every file in it.
    // The path this build predicts before registering is free: Storyteller names the file from its
    // own title, so the collision only becomes visible once the file is there.
    repo.findBookFileByAbsolutePath.mockImplementation((path: string) => {
      if (path.includes('(read-along ')) return Promise.resolve(located(99, 50));
      return Promise.resolve(path.endsWith('Remote Title.epub') ? located(77, 40, 9) : undefined);
    });

    await runBuild(service, 1, PAIR, USER);

    expect(session.downloadReadaloud).toHaveBeenCalledOnce();
    expect(editionLinks.setReadAlongBook).toHaveBeenCalledWith(5, 99);
    expect(repo.updateBuild).not.toHaveBeenCalledWith(1, expect.objectContaining({ outputBookId: 77 }));
  });

  it('refuses a download destination a second library book owns instead of adopting it', async () => {
    const { service, session, repo } = await setup();
    // A retry recomputes the filename of the attempt it resumes, so it meets that attempt's own
    // download - indexed, while it was being published, by the other library covering the folder.
    repo.findBuildByPair.mockResolvedValue({ storytellerBookUuid: 'story-uuid', transport: 'api-transfer' });
    await writeFile(downloadDestination(1), Buffer.from('PK\u0003\u0004'));
    repo.findBookFileByAbsolutePath.mockResolvedValue(located(77, 40, 9));

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow('already owns the download destination');

    expect(session.downloadReadaloud).not.toHaveBeenCalled();
  });

  it('keeps asking for the rescan while every scan request is swallowed as a conflict', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { service, repo, scannerService, sleep } = await setup({
      settings: {
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    advanceClock(sleep);
    // A scheduled scan is already in flight, and it walked the folder before Storyteller wrote into
    // it. Every request the collect makes is refused while it runs.
    scannerService.startScan.mockRejectedValue(new ConflictException(`A scan is already running for library ${TARGET_LIBRARY_ID}`));
    repo.findBookFileByAbsolutePath.mockImplementation((path: string) =>
      Promise.resolve(path.includes('(read-along ') ? located(99, 50) : undefined),
    );

    await runBuild(service, 1, PAIR, USER);

    // Spending the one recovery rescan on a request that was swallowed burns the whole 15-minute
    // ceiling on a folder nothing ever rescanned: three requests is the whole budget the build used
    // to have for both collection routes together.
    expect(scannerService.startScan.mock.calls.length).toBeGreaterThan(3);
    expect(repo.updateBuild).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'ready', outputBookId: 99 }));
  });

  it('refuses a force rebuild rather than clear a file it cannot account for', async () => {
    const { service, session, repo } = await setup();
    // The uuid the caller pinned puts the destination back on a name an earlier build published,
    // and the book row that owned it is gone: a library removed and re-added, or an attempt that
    // died before any scan.
    repo.findBuildByPair.mockResolvedValue({ storytellerBookUuid: 'story-uuid', transport: 'api-transfer' });
    const destination = downloadDestination(1);
    await writeFile(destination, Buffer.from('a read-along this build cannot account for'));
    repo.findBookFileByAbsolutePath.mockResolvedValue(undefined);

    await expect(runBuild(service, 1, PAIR, USER, { force: true, oldOutputBookId: 88 })).rejects.toThrow('cannot adopt or clear');

    // An owner-less file is this build's orphan only on the retry that resumed the book which wrote
    // it. Under force the file is something else, and rm is not how you find out what.
    expect(await exists(destination)).toBe(true);
    expect(session.downloadReadaloud).not.toHaveBeenCalled();
  });

  it('retries the write that fails a build so the row cannot stay building', async () => {
    const { service, session, repo } = await setup();
    session.uploadBook.mockRejectedValue(new Error('storyteller unreachable'));
    let terminalWrites = 0;
    repo.updateBuild.mockImplementation((_id: number, values: Record<string, unknown>) => {
      if (values.status !== 'failed') return Promise.resolve({});
      terminalWrites += 1;
      return terminalWrites === 1 ? Promise.reject(new Error('connection terminated unexpectedly')) : Promise.resolve({});
    });

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow('storyteller unreachable');

    // startBuild claims a pair only when its row is not already 'building', so a terminal write that
    // is dropped makes every later request for this pair answer busy until the next restart.
    expect(terminalWrites).toBe(2);
    expect(repo.updateBuild).toHaveBeenLastCalledWith(1, { status: 'failed', error: 'storyteller unreachable' });
  });

  // readaloudLocation is one global Storyteller setting, so every shared-paths build writes
  // <folder>/<title>.epub with no discriminator of any kind. Two books whose titles sanitize to the
  // same segment collide, and the loser's file is overwritten before anything can refuse it.
  it('fails a pinned shared-paths build whose predicted read-along path belongs to another book', async () => {
    const { service, session, repo } = await setup({
      settings: {
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    repo.findBookFileByAbsolutePath.mockImplementation((path: string) =>
      Promise.resolve(path === join(libraryDir, 'Local Title.epub') ? located(77, 40) : undefined),
    );
    repo.findBuildByOutputBook.mockImplementation((bookId: number) => Promise.resolve(bookId === 77 ? { id: 2, outputBookId: 77 } : undefined));

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow(/belongs to book 77/);

    expect(session.importByReference).not.toHaveBeenCalled();
    expect(session.uploadBook).not.toHaveBeenCalled();
    expect(repo.updateBuild).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'failed', error: expect.stringContaining('77') }));
  });

  it('falls back to api-transfer when auto transport predicts a read-along path another book owns', async () => {
    const { service, session, repo } = await setup({
      settings: {
        transport: 'auto',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    const warned = captureLogs('warn');
    repo.findBookFileByAbsolutePath.mockImplementation((path: string) =>
      Promise.resolve(path.includes('(read-along ') ? located(99, 50) : located(77, 40)),
    );
    repo.findBuildByOutputBook.mockImplementation((bookId: number) => Promise.resolve(bookId === 77 ? { id: 2, outputBookId: 77 } : undefined));

    await runBuild(service, 1, PAIR, USER);

    // The download route carries two discriminators, so it cannot land on another book file.
    expect(session.importByReference).not.toHaveBeenCalled();
    expect(session.uploadBook).toHaveBeenCalledOnce();
    expect(warned.some((line) => line.includes('ownerBookId=77'))).toBe(true);
  });

  it('keeps shared paths when the predicted read-along path is free', async () => {
    const { service, session, repo } = await setup({
      settings: {
        transport: 'auto',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    repo.findBookFileByAbsolutePath.mockImplementation((path: string) =>
      Promise.resolve(path === join(libraryDir, 'Local Title.epub') ? undefined : located(99, 50)),
    );

    await runBuild(service, 1, PAIR, USER);

    expect(session.importByReference).toHaveBeenCalled();
    expect(session.uploadBook).not.toHaveBeenCalled();
  });

  it('warns with both book ids when Storyteller wrote a read-along over another book file', async () => {
    const { service, session, repo } = await setup({
      settings: {
        transport: 'auto',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    const warned = captureLogs('warn');
    session.getBook.mockResolvedValue(remoteBook({ aligned: true, readaloudPath: '/remote/output/Remote Title.epub' }));
    repo.findBookFileByAbsolutePath.mockImplementation((path: string) => {
      if (path.includes('(read-along ')) return Promise.resolve(located(99, 50));
      return Promise.resolve(path.endsWith('Remote Title.epub') ? located(77, 40) : undefined);
    });
    repo.findBuildByOutputBook.mockImplementation((bookId: number) => Promise.resolve(bookId === 77 ? { id: 2, outputBookId: 77 } : undefined));

    await runBuild(service, 1, PAIR, USER);

    // The claim refusal alone reads as a build that took the other route; nothing says a file that
    // belonged to another book was destroyed to get there.
    const destroyed = warned.find((line) => line.startsWith('[storyteller.read_along.overwrite]'));
    expect(destroyed).toContain('textBookId=10');
    expect(destroyed).toContain('ownerBookId=77');
    expect(destroyed).toMatch(/durationMs=\d+/);
    expect(destroyed).toContain('errorClass=ConflictException');
    expect(destroyed).toMatch(/error="[^"]+"/);
    expect(session.downloadReadaloud).toHaveBeenCalledOnce();
  });

  it('re-registers by upload rather than resume a book that would overwrite another read-along', async () => {
    const { service, session, repo } = await setup({
      settings: {
        transport: 'auto',
        deleteRemoteAfterImport: true,
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    // This pair registered by reference and then died at the wait. A pair whose title sanitizes the
    // same has since published its own read-along at the one path Storyteller writes to.
    repo.findBuildByPair.mockResolvedValue({ storytellerBookUuid: 'referenced-uuid', transport: 'shared-paths' });
    session.getBook.mockResolvedValue(remoteBook({ processing: IDLE }));
    session.uploadBook.mockResolvedValue({ uuid: 'uploaded-uuid' });
    repo.findBookFileByAbsolutePath.mockImplementation((path: string) =>
      Promise.resolve(path.includes('(read-along ') ? located(99, 50) : located(77, 40)),
    );
    repo.findBuildByOutputBook.mockImplementation((bookId: number) => Promise.resolve(bookId === 77 ? { id: 2, outputBookId: 77 } : undefined));

    await runBuild(service, 1, PAIR, USER);

    // Processing the resumed book writes <readaloudLocation>/<title>.epub, the exact path the guard
    // just reported as book 77's, and the collect that refuses to claim it is hours too late.
    expect(session.process).not.toHaveBeenCalledWith('referenced-uuid');
    expect(session.uploadBook).toHaveBeenCalledOnce();
    expect(session.process).toHaveBeenCalledWith('uploaded-uuid');
    expect(repo.updateBuild).toHaveBeenCalledWith(1, { storytellerBookUuid: null });
    expect(await exists(join(libraryDir, 'Local Title.epub'))).toBe(false);
    // The abandoned book holds the user's own files by reference, so it is left where it is.
    expect(session.deleteBook).not.toHaveBeenCalledWith('referenced-uuid', expect.anything());
  });

  it('re-registers by upload rather than resume a reference-imported book the current selection would not have made', async () => {
    const { service, session, repo } = await setup({
      settings: {
        transport: 'api-transfer',
        deleteRemoteAfterImport: true,
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    // The row still carries the book a shared-paths run registered by reference, and a retry
    // preserves both the uuid and that transport. What the admin has pinned since only decides how
    // a fresh registration would go: Storyteller processes the remembered book by reference and
    // writes into its one global read-along folder whatever this run selected.
    repo.findBuildByPair.mockResolvedValue({ storytellerBookUuid: 'referenced-uuid', transport: 'shared-paths' });
    session.getBook.mockResolvedValue(remoteBook({ processing: IDLE }));
    session.uploadBook.mockResolvedValue({ uuid: 'uploaded-uuid' });
    repo.findBookFileByAbsolutePath.mockImplementation((path: string) =>
      Promise.resolve(path.includes('(read-along ') ? located(99, 50) : located(77, 40)),
    );
    repo.findBuildByOutputBook.mockImplementation((bookId: number) => Promise.resolve(bookId === 77 ? { id: 2, outputBookId: 77 } : undefined));

    await runBuild(service, 1, PAIR, USER);

    expect(session.process).not.toHaveBeenCalledWith('referenced-uuid');
    expect(session.uploadBook).toHaveBeenCalledOnce();
    expect(session.process).toHaveBeenCalledWith('uploaded-uuid');
    expect(repo.updateBuild).toHaveBeenCalledWith(1, { storytellerBookUuid: null });
    expect(await exists(join(libraryDir, 'Local Title.epub'))).toBe(false);
    expect(session.deleteBook).not.toHaveBeenCalledWith('referenced-uuid', expect.anything());
  });

  it('reports a collision the build avoided as an outcome, not as a failed operation', async () => {
    const { service, repo } = await setup({
      settings: {
        transport: 'auto',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    const warned = captureLogs('warn');
    repo.findBookFileByAbsolutePath.mockImplementation((path: string) =>
      Promise.resolve(path.includes('(read-along ') ? located(99, 50) : located(77, 40)),
    );
    repo.findBuildByOutputBook.mockImplementation((bookId: number) => Promise.resolve(bookId === 77 ? { id: 2, outputBookId: 77 } : undefined));

    await runBuild(service, 1, PAIR, USER);

    // Nothing failed: the build uploaded instead and nothing was written over.
    expect(countPhase(warned, 'storyteller.read_along.overwrite', 'fail')).toBe(0);
    const avoided = warned.find((line) => line.startsWith('[storyteller.read_along.overwrite] [end]'));
    expect(avoided).toContain('ownerBookId=77');
    expect(avoided).toContain('overwritten=false');
    expect(avoided).toMatch(/durationMs=\d+/);
  });

  it('keeps the collision a pinned shared-paths build refuses as a failure', async () => {
    const { service, repo } = await setup({
      settings: {
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    const warned = captureLogs('warn');
    repo.findBookFileByAbsolutePath.mockResolvedValue(located(77, 40));
    repo.findBuildByOutputBook.mockImplementation((bookId: number) => Promise.resolve(bookId === 77 ? { id: 2, outputBookId: 77 } : undefined));

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow(/belongs to book 77/);

    expect(countPhase(warned, 'storyteller.read_along.overwrite', 'fail')).toBe(1);
    expect(countPhase(warned, 'storyteller.read_along.overwrite', 'end')).toBe(0);
    const refused = warned.find((line) => line.startsWith('[storyteller.read_along.overwrite] [fail]'));
    expect(refused).toMatch(/durationMs=\d+/);
    expect(refused).toContain('errorClass=ConflictException');
    expect(refused).toMatch(/error="[^"]+"/);
  });

  it('reuses the refusal the claim already computed when a read-along was overwritten', async () => {
    const { service, session, repo } = await setup({
      settings: {
        transport: 'auto',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    const sharedPath = join(libraryDir, 'Remote Title.epub');
    session.getBook.mockResolvedValue(remoteBook({ aligned: true, readaloudPath: '/remote/output/Remote Title.epub' }));
    repo.findBookFileByAbsolutePath.mockImplementation((path: string) => {
      if (path.includes('(read-along ')) return Promise.resolve(located(99, 50));
      return Promise.resolve(path === sharedPath ? located(77, 40) : undefined);
    });
    repo.findBuildByOutputBook.mockImplementation((bookId: number) => Promise.resolve(bookId === 77 ? { id: 2, outputBookId: 77 } : undefined));

    await runBuild(service, 1, PAIR, USER);

    // The claim decided this moments earlier and logged it. Asking the database the same three
    // questions again is a per-build cost paid for an answer already in hand.
    expect(repo.findBookFileByAbsolutePath.mock.calls.filter((call) => call[0] === sharedPath)).toHaveLength(1);
    expect(repo.findBuildByOutputBook.mock.calls.filter((call) => call[0] === 77)).toHaveLength(1);
  });

  it('does not look for an overwrite when the shared-path collect simply timed out', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { service, repo, sleep } = await setup({
      settings: {
        transport: 'auto',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    advanceClock(sleep);
    const warned = captureLogs('warn');
    const sharedPath = join(libraryDir, 'Remote Title.epub');
    repo.findBookFileByAbsolutePath.mockImplementation((path: string) =>
      Promise.resolve(path.includes('(read-along ') ? located(99, 50) : undefined),
    );

    await runBuild(service, 1, PAIR, USER);

    // Storyteller never wrote anything, so there is nothing to have overwritten. One lookup per
    // poll of the collect loop and not one more.
    const polls = sleep.mock.calls.filter(([milliseconds]) => milliseconds === 15_000).length;
    expect(repo.findBookFileByAbsolutePath.mock.calls.filter((call) => call[0] === sharedPath)).toHaveLength(polls);
    expect(warned.some((line) => line.startsWith('[storyteller.read_along.overwrite]'))).toBe(false);
  });

  it('takes the upload fallback when a resumed api-transfer row answers 409 at process', async () => {
    const { service, session, repo } = await setup({
      settings: {
        transport: 'auto',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    // The collect phase rewrites `transport` with how the read-along was fetched, so a row whose
    // sources Storyteller holds by reference can end up recorded as api-transfer.
    repo.findBuildByPair.mockResolvedValue({ storytellerBookUuid: 'referenced-uuid', transport: 'api-transfer' });
    session.uploadBook.mockResolvedValue({ uuid: 'uploaded-uuid' });
    session.getBook.mockResolvedValue(remoteBook({ processing: IDLE }));
    session.process.mockRejectedValueOnce(new StorytellerClientError('Storyteller answered 409: both ebook and audiobook must be present.', 409));

    await runBuild(service, 1, PAIR, USER);

    // Without this the row is a permanent dead end: retry sends no force, and Rebuild only renders
    // on a ready row.
    expect(session.uploadBook).toHaveBeenCalledOnce();
    expect(session.process).toHaveBeenCalledTimes(2);
  });

  it('does not take the reference fallback for a book this build uploaded itself', async () => {
    const { service, session } = await setup();
    session.getBook.mockResolvedValue(remoteBook({ processing: IDLE }));
    session.process.mockRejectedValue(new StorytellerClientError('Storyteller answered 409: both ebook and audiobook must be present.', 409));

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow('409');

    expect(session.uploadBook).toHaveBeenCalledOnce();
  });

  it('does not take the reference fallback for a resumed row on an instance that cannot share paths', async () => {
    const { service, session, repo } = await setup({ settings: { transport: 'api-transfer' } });
    repo.findBuildByPair.mockResolvedValue({ storytellerBookUuid: 'uploaded-uuid', transport: 'api-transfer' });
    session.getBook.mockResolvedValue(remoteBook({ processing: IDLE }));
    session.process.mockRejectedValue(new StorytellerClientError('Storyteller answered 409: both ebook and audiobook must be present.', 409));

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow('409');

    // Nothing here could have been imported by reference, so a second upload would only orphan the
    // gigabytes the first one pushed.
    expect(session.uploadBook).not.toHaveBeenCalled();
  });

  it('holds the slot its caller took for the whole build and frees it at the end', async () => {
    const { service, session } = await setup();
    const gate = deferred<{ version: string; capabilities: string[] }>();
    session.getServerInfo.mockReturnValue(gate.promise);

    const inFlight = runBuild(service, 1, PAIR, USER);
    // The pair's own slot is held too: a second run for it could only claim the row out from under
    // this one and strip the uuid that is its only handle on a Storyteller job.
    expect(service.tryReserve(PAIR)).toBeNull();
    expect(service.tryReserve(OTHER_PAIR)).toBeNull();

    gate.resolve({ version: '1', capabilities: ['books'] });
    await inFlight;

    expect(service.tryReserve(OTHER_PAIR)).not.toBeNull();
  });

  it('ignores a second release of a slot another reservation has since taken', async () => {
    const { service } = await setup();
    const first = service.tryReserve(PAIR);
    first?.release();
    expect(service.tryReserve(PAIR)).not.toBeNull();

    first?.release();

    // The slot belongs to the reservation that took it second: a stale release frees nothing.
    expect(service.tryReserve(OTHER_PAIR)).toBeNull();
  });

  it('reads the edition link before the attach, so a force rebuild still removes what it replaced', async () => {
    const { service, repo, editionLinks, bookService } = await setup();
    let attached = false;
    editionLinks.setReadAlongBook.mockImplementation(() => {
      attached = true;
      return Promise.resolve(linkNaming(99));
    });
    editionLinks.findLinkForBook.mockImplementation(() => Promise.resolve(linkNaming(attached ? 99 : 88)));
    const previousOutput = join(libraryDir, 'Remote Title (read-along 1).epub');
    await writeFile(previousOutput, Buffer.from('PK\u0003\u0004'));
    repo.findBookFileByAbsolutePath.mockImplementation((path: string) =>
      Promise.resolve(path === previousOutput ? located(88, 40) : located(99, 50)),
    );

    await runBuild(service, 1, pairWithPreviousOutput(88), USER, { force: true, oldOutputBookId: 88 });

    // Reading the link after attachToLink has overwritten it makes every force rebuild refuse the
    // removal as "the link does not name this book", with all the other tests still green.
    expect(bookService.deleteBooks).toHaveBeenCalledWith([88], USER);
  });

  it('reclaims the remote book when Storyteller reports a read-along path no mapping covers', async () => {
    const { service, session } = await setup({
      settings: {
        transport: 'api-transfer',
        deleteRemoteAfterImport: true,
        pathMappings: [{ localPrefix: libraryDir, remotePrefix: '/remote/output' }],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    session.uploadBook.mockResolvedValue({ uuid: 'uploaded-uuid' });
    session.getBook.mockResolvedValue(remoteBook({ aligned: true, readaloudPath: '/data/assets/aligned.epub' }));

    await runBuild(service, 1, PAIR, USER);

    // Answering an unmappable path with the configured readaloudLocation would read as "inside a
    // library folder" and switch the cleanup off for every uploaded build.
    expect(session.deleteBook).toHaveBeenCalledWith('uploaded-uuid', { preventReImport: true });
  });

  it('never deletes the Storyteller book for a shared-paths build, wherever its read-along landed', async () => {
    const { service, session } = await setup({
      settings: {
        transport: 'auto',
        deleteRemoteAfterImport: true,
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: libraryDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    // Outside every mapping, so source ownership is the only thing left between this build and a
    // delete that would take the user's own ebook and audio files with it.
    session.getBook.mockResolvedValue(remoteBook({ aligned: true, readaloudPath: '/data/assets/aligned.epub' }));

    await runBuild(service, 1, PAIR, USER);

    expect(session.deleteBook).not.toHaveBeenCalled();
    expect(session.deleteCache).toHaveBeenCalledWith('story-uuid');
  });
});

describe('StorytellerReadAlongBuildService cancellation', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** A sleep that never wakes on its own, only when the build it belongs to is cancelled. */
  function sleepUntilAborted(sleep: ReturnType<typeof vi.fn<(milliseconds: number, signal?: AbortSignal) => Promise<void>>>) {
    const asleep = deferred<void>();
    sleep.mockImplementation((_milliseconds: number, signal?: AbortSignal) => {
      asleep.resolve();
      return new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
    });
    return asleep.promise;
  }

  function failedWrites(repo: { updateBuild: ReturnType<typeof vi.fn> }): unknown[] {
    return repo.updateBuild.mock.calls.filter(([, values]) => (values as { status?: string }).status === 'failed');
  }

  it('answers false when the pair has no build in flight', async () => {
    const { service } = await setup();

    expect(service.cancel(PAIR)).toBe(false);
  });

  it('stops a build sleeping in the wait loop, writes no failure and frees the slot', async () => {
    const { service, session, repo, sleep } = await setup();
    const logs = captureLogs('log');
    session.readaloudAvailable.mockResolvedValue(false);
    const asleep = sleepUntilAborted(sleep);

    const run = runBuild(service, 1, PAIR, USER);
    await asleep;
    expect(service.cancel(PAIR)).toBe(true);

    await expect(run).resolves.toBeUndefined();
    expect(failedWrites(repo)).toEqual([]);
    expect(session.downloadReadaloud).not.toHaveBeenCalled();
    expect(logs.some((line) => line.startsWith('[storyteller.read_along.build] [end]') && line.includes('outcome=cancelled'))).toBe(true);
    expect(logs.some((line) => line.startsWith('[storyteller.read_along.wait] [end]') && line.includes('outcome=cancelled'))).toBe(true);
    const next = service.tryReserve(OTHER_PAIR);
    expect(next).not.toBeNull();
    next?.release();
  });

  it('writes nothing further once cancelled during prepare', async () => {
    const { service, repo, settingsService } = await setup();
    const connection = deferred<{ serverUrl: string; username: string; password: string }>();
    settingsService.getConnection.mockReturnValue(connection.promise);

    const run = runBuild(service, 1, PAIR, USER);
    await vi.waitFor(() => expect(settingsService.getConnection).toHaveBeenCalled());
    service.cancel(PAIR);
    connection.resolve({ serverUrl: 'http://storyteller', username: 'u', password: 'p' });

    await expect(run).resolves.toBeUndefined();
    expect(repo.updateBuild.mock.calls).toEqual([[1, { phase: 'prepare' }]]);
  });

  it('still records an ordinary failure as failed', async () => {
    const { service, repo, settingsService } = await setup();
    settingsService.getConnection.mockResolvedValue(null);

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow('Storyteller is not configured');
    expect(failedWrites(repo)).toHaveLength(1);
  });

  it('records where the build landed, folder included', async () => {
    const { service, repo } = await setup();

    await runBuild(service, 1, PAIR, USER);

    expect(repo.updateBuild).toHaveBeenCalledWith(1, { phase: 'prepare', targetLibraryId: TARGET_LIBRARY_ID, targetFolderId: 30 });
  });

  it('stamps the link the read-along was attached to after the ready write', async () => {
    const { service, repo } = await setup();

    await runBuild(service, 1, PAIR, USER);

    const readyCall = repo.updateBuild.mock.calls.findIndex(([, values]) => (values as { status?: string }).status === 'ready');
    const stampCall = repo.updateBuild.mock.calls.findIndex(([, values]) => 'attachedLinkId' in (values as object));
    expect(readyCall).toBeGreaterThanOrEqual(0);
    expect(stampCall).toBeGreaterThan(readyCall);
    expect(repo.updateBuild.mock.calls[stampCall]).toEqual([1, { attachedLinkId: PAIR.linkId }]);
    expect(repo.updateBuild.mock.calls[readyCall]![1]).not.toHaveProperty('attachedLinkId');
  });

  it('keeps an imported build ready when the link vanished before its stamp could be written', async () => {
    const { service, repo } = await setup();
    const warnings = captureLogs('warn');
    repo.updateBuild.mockImplementation((_id: number, values: Record<string, unknown>) =>
      'attachedLinkId' in values
        ? Promise.reject(Object.assign(new Error('insert or update violates foreign key constraint'), { code: '23503' }))
        : Promise.resolve({}),
    );

    await expect(runBuild(service, 1, PAIR, USER)).resolves.toBeUndefined();

    expect(repo.updateBuild).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'ready' }));
    expect(failedWrites(repo)).toEqual([]);
    expect(warnings.some((line) => line.startsWith('[storyteller.read_along.stamp_link] [fail] buildId=1 linkId=5 durationMs='))).toBe(true);
  });

  it('keeps its cancellation error to itself', () => {
    expect(buildServiceModule).not.toHaveProperty('ReadAlongCancelledError');
  });

  it('refuses a cancel once the collect has begun and finishes the import', async () => {
    const { service, repo, session } = await setup();
    const download = deferred<void>();
    const downloadStarted = deferred<void>();
    session.downloadReadaloud.mockImplementation(async (_uuid: string, destination: string) => {
      downloadStarted.resolve();
      await download.promise;
      await writeFile(destination, Buffer.from('PK\u0003\u0004'));
      return { bytes: 4, filename: null };
    });

    const run = runBuild(service, 1, PAIR, USER);
    await downloadStarted.promise;
    expect(() => service.cancel(PAIR)).toThrow(ConflictException);
    download.resolve();

    await expect(run).resolves.toBeUndefined();
    expect(repo.updateBuild).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'ready' }));
  });

  it('stops the Storyteller job its process request started when the cancel landed during that request', async () => {
    const { service, repo, session } = await setup();
    session.getBook.mockResolvedValue(remoteBook({ processing: IDLE }));
    session.process.mockImplementation(() => {
      service.cancel(PAIR);
      return Promise.resolve();
    });

    await expect(runBuild(service, 1, PAIR, USER)).resolves.toBeUndefined();

    expect(session.cancelProcessing).toHaveBeenCalledWith('story-uuid');
    expect(failedWrites(repo)).toEqual([]);
    expect(session.readaloudAvailable).not.toHaveBeenCalled();
  });

  it('still ends as cancelled when stopping the Storyteller job fails', async () => {
    const { service, repo, session } = await setup();
    session.getBook.mockResolvedValue(remoteBook({ processing: IDLE }));
    session.process.mockImplementation(() => {
      service.cancel(PAIR);
      return Promise.resolve();
    });
    session.cancelProcessing.mockRejectedValue(new StorytellerClientError('Storyteller answered 500', 500));

    await expect(runBuild(service, 1, PAIR, USER)).resolves.toBeUndefined();
    expect(failedWrites(repo)).toEqual([]);
  });

  it('logs a cancelled upload as cancelled, never as a failed registration', async () => {
    const { service, session } = await setup();
    const errors = captureLogs('error');
    const logs = captureLogs('log');
    session.uploadBook.mockImplementation(() => {
      service.cancel(PAIR);
      return Promise.reject(new StorytellerClientError('The upload was cancelled', null));
    });

    await expect(runBuild(service, 1, PAIR, USER)).resolves.toBeUndefined();

    expect(errors).toEqual([]);
    expect(logs.some((line) => line.startsWith('[storyteller.read_along.register] [end]') && line.includes('outcome=cancelled'))).toBe(true);
    expect(logs.some((line) => line.startsWith('[storyteller.read_along.upload] [end]') && line.includes('outcome=cancelled'))).toBe(true);
  });

  it('holds whenReleased until a cancelled build lets go of its slot', async () => {
    const { service } = await setup();
    const slot = service.tryReserve(PAIR)!;
    service.cancel(PAIR);
    let released = false;
    const waiting = service.whenReleased(PAIR).then(() => {
      released = true;
    });

    await Promise.resolve();
    expect(released).toBe(false);
    slot.release();
    await waiting;
    expect(released).toBe(true);
  });

  it('holds whenReleased for another pair while a cancelled build takes the only slot', async () => {
    const { service } = await setup();
    const slot = service.tryReserve(PAIR)!;
    service.cancel(PAIR);
    let released = false;
    const waiting = service.whenReleased(OTHER_PAIR).then(() => {
      released = true;
    });

    await Promise.resolve();
    expect(released).toBe(false);
    slot.release();
    await waiting;
    expect(service.tryReserve(OTHER_PAIR)).not.toBeNull();
  });

  it('does not hold another pair behind a slot whose build is still running', async () => {
    const { service } = await setup();
    const slot = service.tryReserve(PAIR)!;

    await expect(service.whenReleased(OTHER_PAIR)).resolves.toBeUndefined();
    slot.release();
  });

  it('answers whenReleased at once when no cancelled build holds the pair', async () => {
    const { service } = await setup();

    await expect(service.whenReleased(PAIR)).resolves.toBeUndefined();
    const slot = service.tryReserve(PAIR)!;
    await expect(service.whenReleased(PAIR)).resolves.toBeUndefined();
    slot.release();
  });
});

describe('StorytellerReadAlongBuildService default sleep', () => {
  afterEach(() => vi.useRealTimers());

  function defaultSleep() {
    const service = new StorytellerReadAlongBuildService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return service['sleep'];
  }

  it('waits the full delay without a signal', async () => {
    vi.useFakeTimers();
    let done = false;
    const sleeping = defaultSleep()(10_000).then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await sleeping;
    expect(done).toBe(true);
  });

  it('wakes early when the signal aborts and leaves no timer behind', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let done = false;
    const sleeping = defaultSleep()(10_000, controller.signal).then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(done).toBe(false);
    controller.abort();
    await sleeping;
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves at once when the signal has already aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();

    await defaultSleep()(10_000, controller.signal);

    expect(vi.getTimerCount()).toBe(0);
  });
});
