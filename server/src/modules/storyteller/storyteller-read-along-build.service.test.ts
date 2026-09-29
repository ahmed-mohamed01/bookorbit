import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConflictException, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import { BookService } from '../book/book.service';
import { EditionLinkRepository } from '../edition-link/edition-link.repository';
import { LibraryService } from '../library/library.service';
import { EpubService } from '../reader/epub/epub.service';
import * as buildServiceModule from './storyteller-read-along-build.service';
import { STORYTELLER_SLEEP, StorytellerReadAlongBuildService, type StorytellerRunBuildOptions } from './storyteller-read-along-build.service';
import type { StorytellerReadAlongPair } from './storyteller-read-along-status.service';
import { StorytellerClientError, StorytellerClientService } from './storyteller-client.service';
import { storytellerConfig } from './storyteller.config';
import { StorytellerRepository } from './storyteller.repository';
import { StorytellerSettingsService } from './storyteller-settings.service';
import { StorytellerReadAlongNotifierService } from './storyteller-read-along-notifier.service';
import { StorytellerReadAlongImportService } from './storyteller-read-along-import.service';

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

const TARGET_LIBRARY_ID = 3;

// What the import step is handed for a build that downloads its read-along rather than taking it
// from Storyteller's staging folder.
function downloadImport(overrides: Record<string, unknown> = {}) {
  return expect.objectContaining({ stagedPath: null, storytellerBookUuid: 'story-uuid', ...overrides });
}

// The staging folder is a temp directory made per test, so table-driven cases name it with a
// placeholder the case resolves once the directory exists.
function resolveMappings(mappings: { localPrefix: string; remotePrefix: string }[]) {
  return mappings.map((mapping) => (mapping.localPrefix === '@staging' ? { ...mapping, localPrefix: stagingDir } : mapping));
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
    audiobookPaths: [],
    processing: { state: 'running', task: 'align', progress: 0.5, error: null },
    ...overrides,
  };
}

let libraryDir = '';
// Storyteller's custom read-along folder, which a usable shared-paths setup keeps outside every library.
let stagingDir = '';

beforeEach(async () => {
  // Real paths, as the build compares them: macOS keeps the temp dir behind a /var symlink.
  libraryDir = await realpath(await mkdtemp(join(tmpdir(), 'storyteller-library-')));
  stagingDir = await realpath(await mkdtemp(join(tmpdir(), 'storyteller-staging-')));
});

afterEach(async () => {
  await rm(libraryDir, { recursive: true, force: true });
  await rm(stagingDir, { recursive: true, force: true });
});

async function setup(options: { waitCeilingMs?: number; settings?: Record<string, unknown>; remoteSettings?: Record<string, unknown> } = {}) {
  const repo = {
    updateBuild: vi.fn().mockResolvedValue({}),
    retireCancelledBuild: vi.fn().mockResolvedValue('kept'),
    findBuildByPair: vi.fn().mockResolvedValue({ storytellerBookUuid: null }),
    findSourceEpubFile: vi.fn().mockResolvedValue({ id: 20, absolutePath: '/books/text.epub', sizeBytes: 100, mediaOverlayAvailable: false }),
    findAudioFiles: vi.fn().mockResolvedValue([{ fileId: 21, absolutePath: '/books/audio.mp3', durationSeconds: 60, format: 'mp3' }]),
    findLibraryFolders: vi.fn().mockImplementation(() => Promise.resolve([{ id: 30, path: libraryDir }])),
    findAllLibraryFolderPaths: vi.fn().mockImplementation(() => Promise.resolve([libraryDir, '/books'])),
    findBuildByOutputBook: vi.fn().mockResolvedValue(undefined),
    findBookTitleAndAuthors: vi.fn().mockResolvedValue({ title: 'Local Title', authorNames: [], isbn10: null, isbn13: null, asin: null }),
    findReadAlongMetadata: vi.fn().mockResolvedValue({ title: 'Elantris', authors: ['Brandon Sanderson'], narrators: ['Jack Garrett'] }),
    findLockedMetadataFields: vi.fn().mockResolvedValue([]),
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
  const bookService = { deleteBooks: vi.fn().mockResolvedValue(undefined), updateMetadata: vi.fn().mockResolvedValue({}) };
  const libraryService = {
    verifyUserAccess: vi.fn().mockResolvedValue(undefined),
    findOne: vi.fn().mockResolvedValue({ id: TARGET_LIBRARY_ID, type: 'books', allowedFormats: ['epub'], organizationMode: 'book_per_file' }),
  };
  const importService = { importReadAlong: vi.fn().mockResolvedValue({ outputBookId: 99, replaced: false }) };
  const epubService = { findMalformedSpineItem: vi.fn().mockResolvedValue(null) };
  const sleep = vi.fn<(milliseconds: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);
  const notifier = {
    started: vi.fn().mockResolvedValue(undefined),
    progress: vi.fn().mockResolvedValue(undefined),
    ready: vi.fn().mockResolvedValue(undefined),
    failed: vi.fn().mockResolvedValue(undefined),
    cancelled: vi.fn().mockResolvedValue(undefined),
  };

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
      { provide: StorytellerReadAlongImportService, useValue: importService },
      { provide: EpubService, useValue: epubService },
      { provide: StorytellerReadAlongNotifierService, useValue: notifier },
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
    importService,
    epubService,
    sleep,
    notifier,
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
    const { service, session } = await setup({
      settings: {
        transport: 'auto',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: stagingDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });

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
      condition: 'the read-along folder is not mapped',
      settings: { pathMappings: [{ localPrefix: '/books', remotePrefix: '/remote/books' }] },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
      message: /read-along folder is not covered by a path mapping/,
    },
    {
      condition: 'the read-along location is not a custom folder',
      settings: { pathMappings: [{ localPrefix: '@staging', remotePrefix: '/remote/output' }] },
      remoteSettings: {},
      message: /custom folder/,
    },
    {
      condition: 'the read-along folder is inside a library folder',
      settings: {
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: '/books/readalongs', remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
      message: /inside a library folder/,
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

  it('takes shared paths for a pinned build whose configuration is fully viable', async () => {
    const { service, session } = await setup({
      settings: {
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: stagingDir, remotePrefix: '/remote/output' },
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
          { localPrefix: stagingDir, remotePrefix: '/remote/output' },
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
          { localPrefix: stagingDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
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
          { localPrefix: stagingDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
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
  it('never deletes the remote book when its read-along sits in a library folder', async () => {
    const { service, session } = await setup({
      settings: {
        transport: 'api-transfer',
        deleteRemoteAfterImport: true,
        pathMappings: [{ localPrefix: libraryDir, remotePrefix: '/remote/output' }],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
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

  it('refuses a source epub whose spine content does not parse before contacting Storyteller', async () => {
    const { service, session, epubService, repo } = await setup();
    epubService.findMalformedSpineItem.mockResolvedValueOnce({ href: 'OEBPS/ch1.xhtml', message: 'Pi Tag is not closed.' });

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toMatchObject({
      name: 'BadRequestException',
      message: 'text.epub has malformed content (OEBPS/ch1.xhtml: Pi Tag is not closed.), so it cannot be aligned; repair the file',
    });
    expect(epubService.findMalformedSpineItem).toHaveBeenCalledWith(expect.stringMatching(/text\.epub$/));
    expect(session.getServerInfo).not.toHaveBeenCalled();
    expect(session.importByReference).not.toHaveBeenCalled();
    expect(repo.updateBuild).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'failed' }));
  });

  it('names an epub whose package the reader cannot parse at all', async () => {
    const { service, session, epubService } = await setup();
    epubService.findMalformedSpineItem.mockRejectedValueOnce(new Error('OPF not found: OEBPS/content.opf'));

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow(
      'text.epub cannot be read as an EPUB (OPF not found: OEBPS/content.opf), so Storyteller cannot align it',
    );
    expect(session.importByReference).not.toHaveBeenCalled();
  });

  it('collects an aligned read-along even when the job record reports a failure', async () => {
    const { service, session, importService } = await setup({
      settings: { transport: 'api-transfer', pathMappings: [] },
    });
    session.uploadBook.mockResolvedValue({ uuid: 'uploaded-uuid' });
    session.getBook.mockResolvedValue(
      remoteBook({ aligned: true, readaloudPath: null, processing: { state: 'failed', task: 'align', progress: 0.7, error: 'stopped' } }),
    );

    await expect(runBuild(service, 1, PAIR, USER)).resolves.not.toThrow();
    expect(importService.importReadAlong).toHaveBeenCalledWith(downloadImport({ storytellerBookUuid: 'uploaded-uuid' }));
  });

  it('does not upload when process fails for a reason other than missing media', async () => {
    const { service, session } = await setup({
      settings: {
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: stagingDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    session.getBook.mockResolvedValue(remoteBook({ processing: { state: 'idle', task: null, progress: null, error: null } }));
    session.process.mockRejectedValueOnce(new StorytellerClientError('Storyteller answered 500', 500));

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow();

    expect(session.uploadBook).not.toHaveBeenCalled();
  });

  it('downloads when Storyteller reports a read-along path no mapping covers', async () => {
    const { service, session, importService, repo } = await setup({
      settings: {
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: stagingDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    // An uploaded book keeps its read-along inside Storyteller, nowhere near the shared folder.
    session.getBook.mockResolvedValue(remoteBook({ aligned: true, readaloudPath: '/data/assets/Book/aligned/Book.epub' }));

    await runBuild(service, 1, PAIR, USER);

    expect(importService.importReadAlong).toHaveBeenCalledWith(downloadImport());
    expect(repo.updateBuild).toHaveBeenCalledWith(1, { transport: 'api-transfer' });
  });

  it('collects a resumed build with the transport that registered the book, not the configured one', async () => {
    const { service, session, importService, repo } = await setup({
      settings: {
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: stagingDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    // A previous attempt uploaded this pair, so its read-aloud lives inside Storyteller.
    repo.findBuildByPair.mockResolvedValue({ storytellerBookUuid: 'story-uuid', transport: 'api-transfer' });

    await runBuild(service, 1, PAIR, USER);

    expect(session.importByReference).not.toHaveBeenCalled();
    expect(importService.importReadAlong).toHaveBeenCalledWith(downloadImport());
  });

  describe('when Storyteller already holds the paths', () => {
    const SHARED = {
      settings: {
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: '@staging', remotePrefix: '/remote/output' },
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
      // Nothing held the paths when checked before the import; the refusal is what reveals the book.
      session.listBooks
        .mockResolvedValueOnce([])
        .mockResolvedValue([
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

    it('adopts the matching book when an EPUB2 copy retry is refused with a 405', async () => {
      const { service, session, repo } = await setup({
        ...SHARED,
        settings: { ...SHARED.settings, pathMappings: resolveMappings(SHARED.settings.pathMappings) },
      });
      session.importByReference.mockResolvedValueOnce({ kind: 'epub2_detected', paths: ['/remote/books/text.epub'] }).mockRejectedValueOnce(REFUSED);
      session.listBooks.mockResolvedValueOnce([]).mockResolvedValue([remoteBook({ uuid: 'existing-uuid', ebookPath: '/remote/books/text.epub' })]);
      session.getBook
        .mockResolvedValueOnce(remoteBook({ uuid: 'existing-uuid', processing: IDLE }))
        .mockResolvedValue(remoteBook({ uuid: 'existing-uuid' }));

      await runBuild(service, 1, PAIR, USER);

      expect(session.importByReference).toHaveBeenNthCalledWith(2, expect.objectContaining({ importMode: 'copy' }));
      expect(session.importByReference).toHaveBeenCalledTimes(2);
      expect(repo.updateBuild).toHaveBeenCalledWith(1, { transport: 'shared-paths', storytellerBookUuid: 'existing-uuid' });
      expect(session.process).toHaveBeenCalledWith('existing-uuid');
      expect(session.mergeBooks).not.toHaveBeenCalled();
    });

    it('still registers an EPUB2 pair through a successful copy retry', async () => {
      const { service, session, repo } = await setup({
        ...SHARED,
        settings: { ...SHARED.settings, pathMappings: resolveMappings(SHARED.settings.pathMappings) },
      });
      session.importByReference
        .mockResolvedValueOnce({ kind: 'epub2_detected', paths: ['/remote/books/text.epub'] })
        .mockResolvedValueOnce({ kind: 'created', uuid: 'copy-uuid' })
        .mockResolvedValueOnce({ kind: 'created', uuid: 'audio-uuid' });

      await runBuild(service, 1, PAIR, USER);

      // Only the check before the import: nothing was refused, so nothing is looked up again.
      expect(session.listBooks).toHaveBeenCalledOnce();
      expect(session.mergeBooks).toHaveBeenCalledWith(['copy-uuid', 'audio-uuid']);
      expect(repo.updateBuild).toHaveBeenCalledWith(1, expect.objectContaining({ transport: 'api-transfer', storytellerBookUuid: 'story-uuid' }));
    });

    describe('checked before any import', () => {
      async function sharedSetup() {
        return setup({ ...SHARED, settings: { ...SHARED.settings, pathMappings: resolveMappings(SHARED.settings.pathMappings) } });
      }

      it('adopts the book already holding one of the audio files, with no import at all', async () => {
        const { service, session, repo } = await sharedSetup();
        const logs = captureLogs('log');
        session.listBooks.mockResolvedValue([
          remoteBook({ uuid: 'other-uuid', audiobookPaths: ['/remote/books/other.mp3'] }),
          remoteBook({ uuid: 'existing-uuid', ebookPath: '/data/assets/existing-uuid/text.epub', audiobookPaths: ['/remote/books/audio.mp3'] }),
        ]);
        session.getBook
          .mockResolvedValueOnce(remoteBook({ uuid: 'existing-uuid', processing: IDLE }))
          .mockResolvedValue(remoteBook({ uuid: 'existing-uuid' }));

        await runBuild(service, 1, PAIR, USER);

        expect(session.importByReference).not.toHaveBeenCalled();
        expect(session.mergeBooks).not.toHaveBeenCalled();
        expect(repo.updateBuild).toHaveBeenCalledWith(1, { transport: 'shared-paths', storytellerBookUuid: 'existing-uuid' });
        expect(session.process).toHaveBeenCalledWith('existing-uuid');
        expect(
          logs.some(
            (line) =>
              line.startsWith('[storyteller.read_along.match_existing] [end]') &&
              line.includes('matchedBy=audio') &&
              line.includes('path="/remote/books/audio.mp3"') &&
              line.includes('outcome=reused_existing'),
          ),
        ).toBe(true);
      });

      describe('by the audio folder Storyteller records for a reference import', () => {
        const DAWNSHARD_MP3S = ['01.mp3', '02.mp3', '03.mp3'].map((name, index) => ({
          fileId: 21 + index,
          absolutePath: `/books/Dawnshard/${name}`,
          durationSeconds: 60,
          format: 'mp3',
        }));
        const DAWNSHARD_M4B = [{ fileId: 21, absolutePath: '/books/Dawnshard/Dawnshard.m4b', durationSeconds: 60, format: 'm4b' }];

        async function heldSetup(audioFiles: typeof DAWNSHARD_M4B, audiobookPaths: string[]) {
          const context = await sharedSetup();
          context.repo.findAudioFiles.mockResolvedValue(audioFiles);
          context.session.listBooks.mockResolvedValue([remoteBook({ uuid: 'existing-uuid', audiobookPaths })]);
          context.session.getBook
            .mockResolvedValueOnce(remoteBook({ uuid: 'existing-uuid', processing: IDLE }))
            .mockResolvedValue(remoteBook({ uuid: 'existing-uuid' }));
          return context;
        }

        it('adopts the book whose audiobook is the folder of the single M4B, with no import at all', async () => {
          const { service, session, repo } = await heldSetup(DAWNSHARD_M4B, ['/remote/books/Dawnshard']);
          const logs = captureLogs('log');

          await runBuild(service, 1, PAIR, USER);

          expect(session.importByReference).not.toHaveBeenCalled();
          expect(session.mergeBooks).not.toHaveBeenCalled();
          expect(repo.updateBuild).toHaveBeenCalledWith(1, { transport: 'shared-paths', storytellerBookUuid: 'existing-uuid' });
          expect(
            logs.some(
              (line) =>
                line.startsWith('[storyteller.read_along.match_existing] [end]') &&
                line.includes('matchedBy=audio_directory') &&
                line.includes('path="/remote/books/Dawnshard"'),
            ),
          ).toBe(true);
        });

        it('adopts the book whose audiobook is the folder shared by several MP3s', async () => {
          const { service, session, repo } = await heldSetup(DAWNSHARD_MP3S, ['/remote/books/Dawnshard']);

          await runBuild(service, 1, PAIR, USER);

          expect(session.importByReference).not.toHaveBeenCalled();
          expect(repo.updateBuild).toHaveBeenCalledWith(1, { transport: 'shared-paths', storytellerBookUuid: 'existing-uuid' });
        });

        it('still adopts a book that recorded the audio file itself', async () => {
          const { service, session, repo } = await heldSetup(DAWNSHARD_M4B, ['/remote/books/Dawnshard/Dawnshard.m4b']);

          await runBuild(service, 1, PAIR, USER);

          expect(session.importByReference).not.toHaveBeenCalled();
          expect(repo.updateBuild).toHaveBeenCalledWith(1, { transport: 'shared-paths', storytellerBookUuid: 'existing-uuid' });
        });

        it('does not adopt a book holding a sibling folder', async () => {
          const { service, session, repo } = await heldSetup(DAWNSHARD_M4B, ['/remote/books/Dawnshard2']);

          await runBuild(service, 1, PAIR, USER);

          expect(session.importByReference).toHaveBeenCalledTimes(2);
          expect(repo.updateBuild).not.toHaveBeenCalledWith(1, { transport: 'shared-paths', storytellerBookUuid: 'existing-uuid' });
        });
      });

      it('adopts the book already holding the EPUB at its mapped path', async () => {
        const { service, session, repo } = await sharedSetup();
        session.listBooks.mockResolvedValue([remoteBook({ uuid: 'existing-uuid', ebookPath: '/remote/books/text.epub' })]);
        session.getBook
          .mockResolvedValueOnce(remoteBook({ uuid: 'existing-uuid', processing: IDLE }))
          .mockResolvedValue(remoteBook({ uuid: 'existing-uuid' }));

        await runBuild(service, 1, PAIR, USER);

        expect(session.importByReference).not.toHaveBeenCalled();
        expect(repo.updateBuild).toHaveBeenCalledWith(1, { transport: 'shared-paths', storytellerBookUuid: 'existing-uuid' });
      });

      it('refuses to guess when two books hold the files', async () => {
        const { service, session } = await sharedSetup();
        vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        session.listBooks.mockResolvedValue([
          remoteBook({ uuid: 'a-uuid', ebookPath: '/remote/books/text.epub' }),
          remoteBook({ uuid: 'b-uuid', audiobookPaths: ['/remote/books/audio.mp3'] }),
        ]);

        await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow(
          'Storyteller already has a book for these files and it could not be matched; remove or import it in Storyteller',
        );
        expect(session.importByReference).not.toHaveBeenCalled();
      });

      it('imports as before when no book holds the files', async () => {
        const { service, session } = await sharedSetup();
        session.listBooks.mockResolvedValue([
          remoteBook({ uuid: 'other-uuid', ebookPath: '/remote/books/other.epub', audiobookPaths: ['/remote/books/other.mp3'] }),
        ]);

        await runBuild(service, 1, PAIR, USER);

        expect(session.listBooks).toHaveBeenCalledOnce();
        expect(session.importByReference).toHaveBeenCalledTimes(2);
        expect(session.mergeBooks).toHaveBeenCalledOnce();
      });
    });

    describe('when the audio import is refused', () => {
      async function audioRefusedSetup() {
        const context = await setup({ ...SHARED, settings: { ...SHARED.settings, pathMappings: resolveMappings(SHARED.settings.pathMappings) } });
        context.session.importByReference
          .mockResolvedValueOnce({ kind: 'epub2_detected', paths: ['/remote/books/text.epub'] })
          .mockResolvedValueOnce({ kind: 'created', uuid: 'copy-uuid' })
          .mockRejectedValueOnce(REFUSED);
        // Held by a book the check before the import did not see.
        context.session.listBooks
          .mockResolvedValueOnce([])
          .mockResolvedValue([
            remoteBook({ uuid: 'copy-uuid', ebookPath: '/data/assets/copy-uuid/text.epub' }),
            remoteBook({ uuid: 'existing-uuid', audiobookPaths: ['/remote/books/audio.mp3'] }),
          ]);
        context.session.getBook
          .mockResolvedValueOnce(remoteBook({ uuid: 'existing-uuid', processing: IDLE }))
          .mockResolvedValue(remoteBook({ uuid: 'existing-uuid' }));
        return context;
      }

      it('adopts the book holding the audio and deletes the ebook copy this build just made', async () => {
        const { service, session, repo } = await audioRefusedSetup();

        await runBuild(service, 1, PAIR, USER);

        expect(repo.updateBuild).toHaveBeenCalledWith(1, { transport: 'shared-paths', storytellerBookUuid: 'existing-uuid' });
        expect(session.deleteBook).toHaveBeenCalledExactlyOnceWith('copy-uuid', { preventReImport: true });
        expect(session.mergeBooks).not.toHaveBeenCalled();
        expect(session.process).toHaveBeenCalledWith('existing-uuid');
      });

      it('only warns when the ebook copy cannot be deleted, and still builds', async () => {
        const { service, session, repo } = await audioRefusedSetup();
        const warnings = captureLogs('warn');
        session.deleteBook.mockRejectedValue(new Error('delete refused'));

        await runBuild(service, 1, PAIR, USER);

        expect(repo.updateBuild).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'ready' }));
        expect(warnings.some((line) => line.startsWith('[storyteller.read_along.cleanup] [fail]') && line.includes('target=copied_ebook'))).toBe(
          true,
        );
      });
    });

    it('names a duplicate only when more than one book matches the path', async () => {
      const { service, session, repo } = await refusedSetup();
      session.listBooks.mockResolvedValue([
        remoteBook({ uuid: 'a-uuid', ebookPath: '/remote/books/text.epub' }),
        remoteBook({ uuid: 'b-uuid', ebookPath: '/remote/books/text.epub' }),
      ]);

      await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow(
        'Storyteller already has a book for these files and it could not be matched; remove or import it in Storyteller',
      );

      expect(session.process).not.toHaveBeenCalled();
      expect(repo.updateBuild).not.toHaveBeenCalledWith(1, expect.objectContaining({ storytellerBookUuid: expect.any(String) }));
    });

    // Storyteller answers the same 405 for a file it cannot parse, so no match is not proof of a duplicate.
    it.each([
      ['no book matches', [remoteBook({ uuid: 'other-uuid', ebookPath: '/remote/books/other.epub' })]],
      ['the path differs only in case', [remoteBook({ uuid: 'cased-uuid', ebookPath: '/remote/books/Text.epub' })]],
    ])("relays Storyteller's own refusal as a bad gateway when %s", async (_case, books) => {
      const { service, session, repo } = await refusedSetup();
      session.listBooks.mockResolvedValue(books);

      await expect(runBuild(service, 1, PAIR, USER)).rejects.toMatchObject({
        name: 'BadGatewayException',
        message:
          'Storyteller could not create a book from these files (Unable to create book from provided paths). If the book already exists there, remove or import it in Storyteller; otherwise the EPUB may be unreadable by Storyteller, check its log',
      });

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
          { localPrefix: stagingDir, remotePrefix: '/remote/output' },
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
          { localPrefix: stagingDir, remotePrefix: '/remote/output' },
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

  // A rebuild keeps the book: reading progress, shelves and the link all hang off its id.
  it('replaces the previous output in place when the link names it', async () => {
    const { service, importService, editionLinks, bookService, repo } = await setup();
    editionLinks.findLinkForBook.mockResolvedValue(linkNaming(88));
    importService.importReadAlong.mockResolvedValue({ outputBookId: 88, replaced: true });

    await runBuild(service, 1, pairWithPreviousOutput(88), USER, { force: true, oldOutputBookId: 88, removePreviousOutput: true });

    expect(importService.importReadAlong).toHaveBeenCalledWith(downloadImport({ replaceBookId: 88 }));
    expect(editionLinks.setReadAlongBook).toHaveBeenCalledWith(5, 88, 88);
    expect(bookService.deleteBooks).not.toHaveBeenCalled();
    expect(repo.updateBuild).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'ready', outputBookId: 88 }));
  });

  it('removes the previous output only once a new book is filed and linked', async () => {
    const { service, importService, editionLinks, bookService } = await setup();
    editionLinks.findLinkForBook.mockResolvedValue(linkNaming(88));
    // The previous output was not a single EPUB, so the import filed a new book instead.
    importService.importReadAlong.mockResolvedValue({ outputBookId: 99, replaced: false });

    await runBuild(service, 1, pairWithPreviousOutput(88), USER, { force: true, oldOutputBookId: 88, removePreviousOutput: true });

    expect(bookService.deleteBooks).toHaveBeenCalledWith([88], USER);
    expect(bookService.deleteBooks.mock.invocationCallOrder[0]).toBeGreaterThan(editionLinks.setReadAlongBook.mock.invocationCallOrder[0]);
  });

  it('keeps the previous output after filing a new book when the caller may not delete it', async () => {
    const { service, importService, editionLinks, bookService } = await setup();
    editionLinks.findLinkForBook.mockResolvedValue(linkNaming(88));
    importService.importReadAlong.mockResolvedValue({ outputBookId: 99, replaced: false });

    await runBuild(service, 1, pairWithPreviousOutput(88), USER, { force: true, oldOutputBookId: 88 });

    expect(editionLinks.setReadAlongBook).toHaveBeenCalledWith(5, 99, 88);
    expect(bookService.deleteBooks).not.toHaveBeenCalled();
  });

  // A Generate after a failed rebuild is not forced, and filing a second copy next to the previous
  // read-along is refused by the dock as a destination conflict.
  it('replaces the previous output in place on a build that is not forced', async () => {
    const { service, importService, editionLinks } = await setup();
    editionLinks.findLinkForBook.mockResolvedValue(linkNaming(88));
    importService.importReadAlong.mockResolvedValue({ outputBookId: 88, replaced: true });

    await runBuild(service, 1, pairWithPreviousOutput(88), USER, { oldOutputBookId: 88 });

    expect(importService.importReadAlong).toHaveBeenCalledWith(downloadImport({ replaceBookId: 88 }));
  });

  it('keeps the previous output when the new one could not be linked in its place', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service, importService, editionLinks, bookService } = await setup();
    editionLinks.findLinkForBook.mockResolvedValue(linkNaming(88));
    importService.importReadAlong.mockResolvedValue({ outputBookId: 99, replaced: false });
    editionLinks.setReadAlongBook.mockRejectedValue({ code: '23505' });

    await runBuild(service, 1, pairWithPreviousOutput(88), USER, { force: true, oldOutputBookId: 88, removePreviousOutput: true });

    expect(bookService.deleteBooks).not.toHaveBeenCalled();
  });

  it('never replaces a previous output the edition link does not name', async () => {
    const { service, importService, editionLinks, bookService } = await setup();
    editionLinks.findLinkForBook.mockResolvedValue(linkNaming(77));

    await runBuild(service, 1, pairWithPreviousOutput(88), USER, { force: true, oldOutputBookId: 88, removePreviousOutput: true });

    expect(importService.importReadAlong).toHaveBeenCalledWith(downloadImport({ replaceBookId: null }));
    expect(bookService.deleteBooks).not.toHaveBeenCalled();
  });

  it('never replaces one of the pair own editions', async () => {
    const { service, importService, editionLinks } = await setup();
    editionLinks.findLinkForBook.mockResolvedValue(linkNaming(PAIR.textBookId));

    await runBuild(service, 1, pairWithPreviousOutput(PAIR.textBookId), USER, {
      force: true,
      oldOutputBookId: PAIR.textBookId,
      removePreviousOutput: true,
    });

    expect(importService.importReadAlong).toHaveBeenCalledWith(downloadImport({ replaceBookId: null }));
  });

  it('keeps the previous output when a force rebuild fails before a replacement exists', async () => {
    const { service, session, bookService } = await setup();
    session.uploadBook.mockRejectedValue(new Error('storyteller unreachable'));

    await expect(runBuild(service, 1, PAIR, USER, { force: true, oldOutputBookId: 88, removePreviousOutput: true })).rejects.toThrow(
      'storyteller unreachable',
    );

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
          { localPrefix: stagingDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    // Every other refusal passes, so the same-book one is the only thing that can stop the delete.
    editionLinks.findLinkForBook.mockResolvedValue(linkNaming(99));

    await runBuild(service, 1, PAIR, USER, { force: true, oldOutputBookId: 99, removePreviousOutput: true });

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

  it('fails the build at the collect phase when the import breaks', async () => {
    const { service, importService, repo, editionLinks } = await setup();
    importService.importReadAlong.mockRejectedValue(new Error('connection reset'));

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow('connection reset');
    expect(repo.updateBuild).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'failed', phase: 'collect' }));
    expect(editionLinks.setReadAlongBook).not.toHaveBeenCalled();
  });

  it('persists the collect phase for a downloaded read-along', async () => {
    const { service, repo } = await setup();

    await runBuild(service, 1, PAIR, USER);

    // Without this the UI reports the wait phase, with the Storyteller progress it stopped
    // updating, for as long as the download runs.
    expect(repo.updateBuild).toHaveBeenCalledWith(1, { phase: 'collect' });
  });

  it('clears only the processing cache for a referenced book, never the book itself', async () => {
    const { service, session } = await setup({
      settings: {
        deleteRemoteAfterImport: true,
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: stagingDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });

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
          { localPrefix: stagingDir, remotePrefix: '/remote/output' },
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

  it('ends ready when the link cannot take the imported read-along, and leaves the link to attach it later', async () => {
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service, editionLinks, repo, notifier } = await setup({ settings: { deleteRemoteAfterImport: true } });
    editionLinks.setReadAlongBook.mockRejectedValue({ code: '23505' });

    await expect(runBuild(service, 1, PAIR, USER)).resolves.toBeUndefined();

    expect(repo.updateBuild).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'ready', phase: 'link', outputBookId: 99, error: null }));
    expect(repo.updateBuild).not.toHaveBeenCalledWith(1, expect.objectContaining({ status: 'failed' }));
    // Unstamped, so the edition link's attach still reads the read-along as lost from this link.
    expect(repo.updateBuild).not.toHaveBeenCalledWith(1, expect.objectContaining({ attachedLinkId: expect.anything() }));
    expect(notifier.ready).toHaveBeenCalled();
    expect(notifier.failed).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[storyteller\.read_along\.link\] \[fail\] buildId=1 linkId=\d+ outputBookId=99 .*errorClass=ConflictException error="The read-along could not be attached to the link; the imported book was kept"/,
      ),
    );
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

  // One statement: a restart after the filing finds the row in link with its output, which the boot
  // settle turns ready, instead of a collect it would resume and file a second time.
  it('records the imported book together with the link phase before it is attached to the link', async () => {
    const { service, editionLinks, repo } = await setup();
    editionLinks.setReadAlongBook.mockRejectedValue({ code: '23505' });

    await runBuild(service, 1, PAIR, USER);

    const recorded = repo.updateBuild.mock.calls.findIndex(([, values]) => (values as { outputBookId?: number }).outputBookId === 99);
    expect(repo.updateBuild.mock.calls[recorded]).toEqual([1, { outputBookId: 99, phase: 'link' }]);
    expect(repo.updateBuild.mock.invocationCallOrder[recorded]).toBeLessThan(editionLinks.setReadAlongBook.mock.invocationCallOrder[0]!);
  });

  it('keeps the shared-paths transport when the upload that would replace it fails', async () => {
    const { service, session, repo } = await setup({
      settings: {
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: stagingDir, remotePrefix: '/remote/output' },
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

  it('takes the read-along from the staging path Storyteller reports once it exists', async () => {
    const { service, session, importService, repo } = await setup({
      settings: {
        transport: 'api-transfer',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: stagingDir, remotePrefix: '/remote/output' },
        ],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    // The snapshot the wait loop polls with predates the read-along, so it reports no path at all.
    session.getBook
      .mockResolvedValueOnce(remoteBook())
      .mockResolvedValueOnce(remoteBook())
      .mockResolvedValue(remoteBook({ aligned: true, readaloudPath: '/remote/output/Remote Title.epub' }));
    await writeFile(join(stagingDir, 'Remote Title.epub'), Buffer.from('PK\u0003\u0004'));

    await runBuild(service, 1, PAIR, USER);

    expect(importService.importReadAlong).toHaveBeenCalledWith(
      expect.objectContaining({
        stagedPath: join(stagingDir, 'Remote Title.epub'),
        consumeStaged: false,
        targetLibraryId: TARGET_LIBRARY_ID,
        targetFolderId: 30,
      }),
    );
    expect(repo.updateBuild).toHaveBeenCalledWith(1, { transport: 'shared-paths' });
  });

  it('hands the staged read-along over to be taken when the build cleans up Storyteller', async () => {
    const { service, session, importService } = await setup({
      settings: {
        transport: 'api-transfer',
        deleteRemoteAfterImport: true,
        pathMappings: [{ localPrefix: stagingDir, remotePrefix: '/remote/output' }],
      },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    session.getBook.mockResolvedValue(remoteBook({ aligned: true, readaloudPath: '/remote/output/Remote Title.epub' }));
    await writeFile(join(stagingDir, 'Remote Title.epub'), Buffer.from('PK\u0003\u0004'));

    await runBuild(service, 1, PAIR, USER);

    expect(importService.importReadAlong).toHaveBeenCalledWith(
      expect.objectContaining({ stagedPath: join(stagingDir, 'Remote Title.epub'), consumeStaged: true }),
    );
  });

  it('downloads rather than take a staged read-along a library already scanned', async () => {
    const { service, session, importService } = await setup({
      settings: { transport: 'api-transfer', pathMappings: [{ localPrefix: libraryDir, remotePrefix: '/remote/output' }] },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    session.getBook.mockResolvedValue(remoteBook({ aligned: true, readaloudPath: '/remote/output/Remote Title.epub' }));
    await writeFile(join(libraryDir, 'Remote Title.epub'), Buffer.from('PK\u0003\u0004'));

    await runBuild(service, 1, PAIR, USER);

    expect(importService.importReadAlong).toHaveBeenCalledWith(downloadImport());
  });

  it('downloads when the staged read-along Storyteller reports is not on disk', async () => {
    const { service, session, importService } = await setup({
      settings: { transport: 'api-transfer', pathMappings: [{ localPrefix: stagingDir, remotePrefix: '/remote/output' }] },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    session.getBook.mockResolvedValue(remoteBook({ aligned: true, readaloudPath: '/remote/output/Remote Title.epub' }));

    await runBuild(service, 1, PAIR, USER);

    expect(importService.importReadAlong).toHaveBeenCalledWith(downloadImport());
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
          { localPrefix: stagingDir, remotePrefix: '/remote/output' },
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

  it('keeps the Storyteller book the caller chose when it answers 409 at process', async () => {
    const { service, session, repo } = await setup({
      settings: {
        transport: 'shared-paths',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: stagingDir, remotePrefix: '/remote/output' },
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

    await runBuild(service, 1, PAIR, USER, { force: true, oldOutputBookId: PAIR.textBookId, removePreviousOutput: true });

    // deleteBooks removes every file the book owns from disk.
    expect(bookService.deleteBooks).not.toHaveBeenCalled();
  });

  it('refuses to delete a previous output the edition link never named', async () => {
    const { service, bookService, editionLinks } = await setup();
    editionLinks.findLinkForBook.mockResolvedValue(linkNaming(88));

    await runBuild(service, 1, pairWithPreviousOutput(88), USER, { force: true, oldOutputBookId: 77, removePreviousOutput: true });

    expect(bookService.deleteBooks).not.toHaveBeenCalled();
  });

  it('refuses to delete a previous output the link no longer names, however the request remembered it', async () => {
    const { service, bookService, editionLinks } = await setup();
    // The user unlinked the read-along to keep it as a book of its own. That clears the link column
    // and nothing else: the build row still remembers the book, and the pair snapshot this build
    // was handed at request time still names it.
    editionLinks.findLinkForBook.mockResolvedValue(linkNaming(null));

    await runBuild(service, 1, pairWithPreviousOutput(300), USER, { force: true, oldOutputBookId: 300, removePreviousOutput: true });

    // Nothing left says this build produced book 300, and deleteBooks takes its files with it.
    expect(bookService.deleteBooks).not.toHaveBeenCalled();
  });

  it('refuses to delete a previous output that another build owns', async () => {
    const { service, repo, bookService, editionLinks } = await setup();
    const warned = captureLogs('warn');
    editionLinks.findLinkForBook.mockResolvedValue(linkNaming(88));
    repo.findBuildByOutputBook.mockImplementation((bookId: number) => Promise.resolve(bookId === 88 ? { id: 2, outputBookId: 88 } : undefined));

    await runBuild(service, 1, pairWithPreviousOutput(88), USER, { force: true, oldOutputBookId: 88, removePreviousOutput: true });

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
          { localPrefix: stagingDir, remotePrefix: '/remote/output' },
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
          { localPrefix: stagingDir, remotePrefix: '/remote/output' },
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

  it('takes the upload fallback when a resumed api-transfer row answers 409 at process', async () => {
    const { service, session, repo } = await setup({
      settings: {
        transport: 'auto',
        pathMappings: [
          { localPrefix: '/books', remotePrefix: '/remote/books' },
          { localPrefix: stagingDir, remotePrefix: '/remote/output' },
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
    const { service, editionLinks, bookService } = await setup();
    let attached = false;
    editionLinks.setReadAlongBook.mockImplementation(() => {
      attached = true;
      return Promise.resolve(linkNaming(99));
    });
    editionLinks.findLinkForBook.mockImplementation(() => Promise.resolve(linkNaming(attached ? 99 : 88)));

    await runBuild(service, 1, pairWithPreviousOutput(88), USER, { force: true, oldOutputBookId: 88, removePreviousOutput: true });

    // Reading the link after attachToLink has overwritten it makes every force rebuild refuse the
    // removal as "the link does not name this book", with all the other tests still green.
    expect(bookService.deleteBooks).toHaveBeenCalledWith([88], USER);
  });

  it('reclaims the remote book when Storyteller reports a read-along path no mapping covers', async () => {
    const { service, session } = await setup({
      settings: {
        transport: 'api-transfer',
        deleteRemoteAfterImport: true,
        pathMappings: [{ localPrefix: stagingDir, remotePrefix: '/remote/output' }],
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
          { localPrefix: stagingDir, remotePrefix: '/remote/output' },
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
    const { service, session, repo, sleep, importService } = await setup();
    const logs = captureLogs('log');
    session.readaloudAvailable.mockResolvedValue(false);
    const asleep = sleepUntilAborted(sleep);

    const run = runBuild(service, 1, PAIR, USER);
    await asleep;
    expect(service.cancel(PAIR)).toBe(true);

    await expect(run).resolves.toBeUndefined();
    expect(failedWrites(repo)).toEqual([]);
    expect(importService.importReadAlong).not.toHaveBeenCalled();
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

  it('stamps the link the read-along was attached to in the ready write itself', async () => {
    const { service, repo } = await setup();

    await runBuild(service, 1, PAIR, USER);

    const stampCalls = repo.updateBuild.mock.calls.filter(([, values]) => 'attachedLinkId' in (values as object));
    expect(stampCalls).toEqual([[1, expect.objectContaining({ status: 'ready', outputBookId: 99, attachedLinkId: PAIR.linkId })]]);
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

    expect(repo.updateBuild).toHaveBeenLastCalledWith(1, expect.objectContaining({ status: 'ready', outputBookId: 99 }));
    expect(repo.updateBuild.mock.lastCall![1]).not.toHaveProperty('attachedLinkId');
    expect(failedWrites(repo)).toEqual([]);
    expect(warnings.some((line) => line.startsWith('[storyteller.read_along.stamp_link] [fail] buildId=1 linkId=5 durationMs='))).toBe(true);
  });

  it('keeps its cancellation error to itself', () => {
    expect(buildServiceModule).not.toHaveProperty('ReadAlongCancelledError');
  });

  it('refuses a cancel once the collect has begun and finishes the import', async () => {
    const { service, repo, importService } = await setup();
    const download = deferred<void>();
    const downloadStarted = deferred<void>();
    importService.importReadAlong.mockImplementation(async () => {
      downloadStarted.resolve();
      await download.promise;
      return { outputBookId: 99, replaced: false };
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

describe('StorytellerReadAlongBuildService slot release listeners', () => {
  it('calls a listener after the slot is free, once per release', async () => {
    const { service } = await setup();
    const freeAtCall: boolean[] = [];
    service.onSlotReleased(() => {
      freeAtCall.push(service['slots'].size === 0);
    });
    const slot = service.tryReserve(PAIR)!;

    slot.release();
    slot.release();

    expect(freeAtCall).toEqual([true]);
    service.tryReserve(OTHER_PAIR)!.release();
    expect(freeAtCall).toEqual([true, true]);
  });

  it('keeps releasing when a listener throws', async () => {
    const { service } = await setup();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const after = vi.fn();
    service.onSlotReleased(() => {
      throw new Error('boom');
    });
    service.onSlotReleased(after);

    service.tryReserve(PAIR)!.release();

    expect(after).toHaveBeenCalledOnce();
    expect(service.tryReserve(OTHER_PAIR)).not.toBeNull();
  });
});

describe('StorytellerReadAlongBuildService notifications', () => {
  beforeEach(() => vi.clearAllMocks());

  it('notifies the start, each stage boundary, the wait progress and the finished read-along', async () => {
    const { service, notifier, session } = await setup();
    session.readaloudAvailable.mockResolvedValueOnce(false).mockResolvedValue(true);
    session.getBook.mockResolvedValue(remoteBook({ processing: { state: 'running', task: 'SYNC_CHAPTERS', progress: 0.4, error: null } }));

    const attempt = { buildId: 1, textBookId: PAIR.textBookId, stamp: 1234 };

    await runBuild(service, 1, PAIR, USER, { attempt });

    expect(notifier.started).toHaveBeenCalledWith(USER.id, attempt);
    expect(notifier.progress).toHaveBeenCalledWith(USER.id, attempt, 'transcribing', null);
    expect(notifier.progress).toHaveBeenCalledWith(USER.id, attempt, 'aligning', 0.4);
    expect(notifier.progress).toHaveBeenLastCalledWith(USER.id, attempt, 'importing', null);
    expect(notifier.ready).toHaveBeenCalledWith(USER.id, attempt, 99, TARGET_LIBRARY_ID);
    expect(notifier.failed).not.toHaveBeenCalled();
  });

  it('notifies a failure with the error it persisted', async () => {
    const { service, notifier, session } = await setup();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    session.uploadBook.mockRejectedValue(new Error('upload refused'));

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow();

    expect(notifier.failed).toHaveBeenCalledWith(
      USER.id,
      expect.objectContaining({ buildId: 1, textBookId: PAIR.textBookId }),
      expect.stringContaining('upload refused'),
    );
    expect(notifier.ready).not.toHaveBeenCalled();
  });

  it('reports no wait progress for a poll that lands after a cancel', async () => {
    const { service, notifier, session, repo } = await setup();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const slot = service.tryReserve(PAIR)!;
    session.getBook.mockResolvedValue(remoteBook({ processing: { state: 'running', task: 'SYNC_CHAPTERS', progress: 0.4, error: null } }));
    // The cancel lands while the poll's own row write is in flight.
    repo.updateBuild.mockImplementation((_id: number, values: Record<string, unknown>) => {
      if (values.remoteTask === 'SYNC_CHAPTERS') service.cancel(PAIR);
      return Promise.resolve({});
    });

    await service.runBuild(1, PAIR, USER, {}, slot);

    expect(notifier.progress).not.toHaveBeenCalledWith(USER.id, expect.anything(), 'aligning', 0.4);
  });

  it('never fails a build over a notification that cannot be sent', async () => {
    const { service, notifier, repo } = await setup();
    notifier.started.mockRejectedValue(new Error('bell down'));
    notifier.ready.mockRejectedValue(new Error('bell down'));

    await expect(runBuild(service, 1, PAIR, USER)).resolves.toBeUndefined();
    expect(repo.updateBuild).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'ready' }));
  });

  describe('a job cancelled inside Storyteller', () => {
    const cancelledJob = { state: 'cancelled', task: 'SYNC_CHAPTERS', progress: 0.3, error: null };

    it('ends the build as cancelled, keeping its book, and notifies the cancel and never a failure', async () => {
      const { service, notifier, session, repo, importService } = await setup();
      const logs = captureLogs('log');
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      session.readaloudAvailable.mockResolvedValue(false);
      session.getBook.mockResolvedValue(remoteBook({ processing: cancelledJob }));
      const attempt = { buildId: 1, textBookId: PAIR.textBookId, stamp: 1234 };

      await expect(runBuild(service, 1, PAIR, USER, { attempt })).resolves.toBeUndefined();

      expect(repo.retireCancelledBuild).toHaveBeenCalledWith(1);
      expect(repo.updateBuild).not.toHaveBeenCalledWith(1, expect.objectContaining({ status: 'failed' }));
      expect(notifier.cancelled).toHaveBeenCalledWith(USER.id, attempt);
      expect(notifier.failed).not.toHaveBeenCalled();
      expect(notifier.ready).not.toHaveBeenCalled();
      expect(importService.importReadAlong).not.toHaveBeenCalled();
      expect(logs.some((line) => line.startsWith('[storyteller.read_along.build] [end]') && line.includes('outcome=cancelled_remote'))).toBe(true);
      expect(service.tryReserve(OTHER_PAIR)).not.toBeNull();
    });

    it('still fails a build whose job failed in Storyteller', async () => {
      const { service, notifier, session, repo } = await setup();
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      session.readaloudAvailable.mockResolvedValue(false);
      session.getBook.mockResolvedValue(remoteBook({ processing: { ...cancelledJob, state: 'failed', error: 'aligner crashed' } }));

      await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow('aligner crashed');

      expect(repo.retireCancelledBuild).not.toHaveBeenCalled();
      expect(repo.updateBuild).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'failed', error: 'aligner crashed' }));
      expect(notifier.failed).toHaveBeenCalled();
      expect(notifier.cancelled).not.toHaveBeenCalled();
    });
  });
});

describe('StorytellerReadAlongBuildService resuming a build a restart re-queued', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  // The claim wrote the remembered uuid and transport back to the row, which is all register reads.
  it('reuses the Storyteller book it was waiting on, skips processing once aligned, and collects', async () => {
    const { service, session, repo, notifier, importService } = await setup();
    const logs = captureLogs('log');
    repo.findBuildByPair.mockResolvedValue({ storytellerBookUuid: 'story-uuid', transport: 'api-transfer' });
    session.getBook.mockResolvedValue(remoteBook({ aligned: true, processing: { state: 'completed', task: null, progress: 1, error: null } }));

    await runBuild(service, 7, PAIR, USER);

    expect(session.uploadBook).not.toHaveBeenCalled();
    expect(session.importByReference).not.toHaveBeenCalled();
    expect(session.mergeBooks).not.toHaveBeenCalled();
    expect(repo.updateBuild).not.toHaveBeenCalledWith(7, expect.objectContaining({ storytellerBookUuid: null }));
    expect(logs.some((line) => line.startsWith('[storyteller.read_along.register] [end]') && line.includes('mode=reused '))).toBe(true);
    expect(session.process).not.toHaveBeenCalled();
    expect(importService.importReadAlong).toHaveBeenCalledWith(downloadImport({ buildId: 7 }));
    expect(repo.updateBuild).toHaveBeenCalledWith(7, expect.objectContaining({ status: 'ready', outputBookId: 99 }));
    expect(notifier.ready).toHaveBeenCalled();
  });
});

describe('StorytellerReadAlongBuildService rebuilds and staging', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function failedWrites(repo: { updateBuild: ReturnType<typeof vi.fn> }): unknown[] {
    return repo.updateBuild.mock.calls.filter(([, values]) => (values as { status?: string }).status === 'failed');
  }

  // Detach, then Rebuild: the link names nothing, but the pair's own row still records the output,
  // and filing a second book would land on the same library path and fail the whole run.
  it('replaces a detached read-along in place when the pair own build row records it, then attaches it', async () => {
    const { service, importService, editionLinks, repo } = await setup();
    editionLinks.findLinkForBook.mockResolvedValue(linkNaming(null));
    repo.findBuildByOutputBook.mockResolvedValue({ id: 1, outputBookId: 88 });
    importService.importReadAlong.mockResolvedValue({ outputBookId: 88, replaced: true });

    await runBuild(service, 1, PAIR, USER, { force: true, oldOutputBookId: 88, removePreviousOutput: true });

    expect(importService.importReadAlong).toHaveBeenCalledWith(downloadImport({ replaceBookId: 88 }));
    expect(editionLinks.setReadAlongBook).toHaveBeenCalledWith(5, 88, null);
  });

  it('still refuses to replace a detached book no build records', async () => {
    const { service, importService, editionLinks } = await setup();
    editionLinks.findLinkForBook.mockResolvedValue(linkNaming(null));

    await runBuild(service, 1, PAIR, USER, { force: true, oldOutputBookId: 88, removePreviousOutput: true });

    expect(importService.importReadAlong).toHaveBeenCalledWith(downloadImport({ replaceBookId: null }));
  });

  it('takes the link over from the previous read-along when the rebuild had to file a new book', async () => {
    const { service, importService, editionLinks, bookService } = await setup();
    editionLinks.findLinkForBook.mockResolvedValue(linkNaming(88));
    importService.importReadAlong.mockResolvedValue({ outputBookId: 99, replaced: false });

    await runBuild(service, 1, pairWithPreviousOutput(88), USER, { force: true, oldOutputBookId: 88, removePreviousOutput: true });

    expect(editionLinks.setReadAlongBook).toHaveBeenCalledWith(5, 99, 88);
    expect(bookService.deleteBooks).toHaveBeenCalledWith([88], USER);
  });

  it('never fails a build whose read-along is ready over a lookup made after the ready write', async () => {
    const { service, importService, editionLinks, repo, notifier } = await setup();
    editionLinks.findLinkForBook.mockResolvedValue(linkNaming(88));
    importService.importReadAlong.mockResolvedValue({ outputBookId: 99, replaced: false });
    repo.findBuildByOutputBook.mockResolvedValueOnce(undefined).mockRejectedValue(new Error('connection terminated'));

    await expect(
      runBuild(service, 1, pairWithPreviousOutput(88), USER, { force: true, oldOutputBookId: 88, removePreviousOutput: true }),
    ).resolves.toBeUndefined();

    expect(failedWrites(repo)).toEqual([]);
    expect(notifier.failed).not.toHaveBeenCalled();
    expect(notifier.ready).toHaveBeenCalled();
  });

  it('writes the linked editions metadata onto a read-along it replaced in place, leaving locked fields alone', async () => {
    const { service, importService, editionLinks, repo, bookService } = await setup();
    editionLinks.findLinkForBook.mockResolvedValue(linkNaming(88));
    importService.importReadAlong.mockResolvedValue({ outputBookId: 88, replaced: true });
    repo.findReadAlongMetadata.mockResolvedValue({
      title: 'Elantris',
      authors: ['Brandon Sanderson'],
      narrators: ['Jack Garrett'],
      seriesName: 'Elantris',
      seriesIndex: 1,
      publishedDate: '2005-04-21',
    });
    repo.findLockedMetadataFields.mockResolvedValue(['authors', 'seriesIndex']);

    await runBuild(service, 1, pairWithPreviousOutput(88), USER, { force: true, oldOutputBookId: 88, removePreviousOutput: true });

    expect(repo.findReadAlongMetadata).toHaveBeenCalledWith(PAIR.textBookId, PAIR.audioBookId);
    expect(bookService.updateMetadata).toHaveBeenCalledWith(
      88,
      { title: 'Elantris', publishedDate: '2005-04-21', audioMetadata: { narrators: ['Jack Garrett'] } },
      USER,
    );
  });

  it('leaves a newly filed read-along to the dock, and never fails a build over the metadata refresh', async () => {
    const newBook = await setup();
    await runBuild(newBook.service, 1, PAIR, USER);
    expect(newBook.bookService.updateMetadata).not.toHaveBeenCalled();

    const { service, importService, editionLinks, repo, bookService, notifier } = await setup();
    const warnings = captureLogs('warn');
    editionLinks.findLinkForBook.mockResolvedValue(linkNaming(88));
    importService.importReadAlong.mockResolvedValue({ outputBookId: 88, replaced: true });
    bookService.updateMetadata.mockRejectedValue(new ConflictException('Metadata fields are locked: title'));

    await expect(
      runBuild(service, 1, pairWithPreviousOutput(88), USER, { force: true, oldOutputBookId: 88, removePreviousOutput: true }),
    ).resolves.toBeUndefined();

    expect(repo.updateBuild).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'ready', outputBookId: 88 }));
    expect(notifier.failed).not.toHaveBeenCalled();
    expect(warnings.some((line) => line.startsWith('[storyteller.read_along.metadata] [fail] buildId=1 outputBookId=88 durationMs='))).toBe(true);
  });

  // A reference import keeps the aligned book after a collect with cleanup took the staged file, and
  // an aligned book is never processed on its own.
  it('processes an aligned book again when its read-along file is gone', async () => {
    const { service, session } = await setup();
    session.getBook.mockResolvedValue(remoteBook({ aligned: true, processing: { state: 'completed', task: null, progress: 1, error: null } }));
    session.readaloudAvailable.mockResolvedValueOnce(false).mockResolvedValue(true);

    await runBuild(service, 1, PAIR, USER);

    expect(session.process).toHaveBeenCalledOnce();
  });

  it('fails fast rather than wait to the ceiling when an aligned book stays without its file', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { service, session, sleep, repo } = await setup();
    advanceClock(sleep);
    session.getBook.mockResolvedValue(remoteBook({ aligned: true, processing: { state: 'completed', task: null, progress: 1, error: null } }));
    session.readaloudAvailable.mockResolvedValue(false);
    const startedAt = Date.now();

    await expect(runBuild(service, 1, PAIR, USER)).rejects.toThrow('no longer has its read-along file');

    expect(session.process).toHaveBeenCalledOnce();
    expect(Date.now() - startedAt).toBeLessThan(10 * 60_000);
    expect(repo.updateBuild).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'failed', phase: 'wait' }));
  });

  it('downloads rather than take a staged path that resolves into a library folder through a symlink', async () => {
    const { service, session, importService } = await setup({
      settings: { transport: 'api-transfer', pathMappings: [{ localPrefix: stagingDir, remotePrefix: '/remote/output' }] },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    await writeFile(join(libraryDir, 'Library Book.epub'), Buffer.from('PK\u0003\u0004'));
    await symlink(libraryDir, join(stagingDir, 'linked'));
    session.getBook.mockResolvedValue(remoteBook({ aligned: true, readaloudPath: '/remote/output/linked/Library Book.epub' }));

    await runBuild(service, 1, PAIR, USER, { cleanUpRemote: true });

    expect(importService.importReadAlong).toHaveBeenCalledWith(downloadImport());
  });

  it('downloads rather than take a staged path outside the configured read-aloud folder', async () => {
    const elsewhere = join(stagingDir, 'elsewhere');
    await mkdir(join(stagingDir, 'output'));
    await mkdir(elsewhere);
    const { service, session, importService } = await setup({
      settings: { transport: 'api-transfer', pathMappings: [{ localPrefix: stagingDir, remotePrefix: '/remote' }] },
      remoteSettings: { readaloudLocationType: 'CUSTOM_FOLDER', readaloudLocation: '/remote/output' },
    });
    await writeFile(join(elsewhere, 'Remote Title.epub'), Buffer.from('PK\u0003\u0004'));
    session.getBook.mockResolvedValue(remoteBook({ aligned: true, readaloudPath: '/remote/elsewhere/Remote Title.epub' }));

    await runBuild(service, 1, PAIR, USER, { cleanUpRemote: true });

    expect(importService.importReadAlong).toHaveBeenCalledWith(downloadImport());
  });

  it('logs the build identifiers first on completion', async () => {
    const { service } = await setup();
    const logs = captureLogs('log');

    await runBuild(service, 1, PAIR, USER);

    expect(
      logs.some((line) =>
        line.startsWith('[storyteller.read_along.build] [end] textBookId=10 audioBookId=11 buildId=1 storytellerBookUuid=story-uuid durationMs='),
      ),
    ).toBe(true);
  });
});
