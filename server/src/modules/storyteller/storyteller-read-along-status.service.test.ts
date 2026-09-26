import { BadGatewayException, BadRequestException, ForbiddenException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Permission } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { BookService } from '../book/book.service';
import { EditionLinkRepository } from '../edition-link/edition-link.repository';
import { LibraryService } from '../library/library.service';
import { StorytellerReadAlongBuildService } from './storyteller-read-along-build.service';
import * as epubUtils from './storyteller-epub.utils';
import { StorytellerReadAlongStatusService, type StorytellerReadAlongPair } from './storyteller-read-along-status.service';
import { StorytellerClientError, StorytellerClientService } from './storyteller-client.service';
import { StorytellerRepository } from './storyteller.repository';
import { StorytellerSettingsService } from './storyteller-settings.service';

const USER = {
  id: 42,
  isSuperuser: false,
  permissions: [Permission.LibraryUpload],
  contentFilters: {},
} as unknown as RequestUser;
const LINK = { id: 5, textBookId: 10, audioBookId: 11, readAlongBookId: null, createdBy: 42, createdAt: new Date() };
const OTHER_LINK = { id: 6, textBookId: 12, audioBookId: 13, readAlongBookId: null, createdBy: 42, createdAt: new Date() };

function buildRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    textBookId: 10,
    audioBookId: 11,
    targetLibraryId: 3,
    outputBookId: null,
    storytellerBookUuid: null,
    transport: null,
    status: 'failed',
    phase: 'wait',
    remoteTask: null,
    remoteProgress: null,
    error: null,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    builtAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Stands in for the build service's single slot rather than for its answers: the claim this guards
 * strips the row it wins, so a reservation that does not outlive the claim is exactly the defect.
 */
function createBuildServiceStub() {
  const held = new Set<string>();
  return {
    held,
    tryReserve: vi.fn((pair: StorytellerReadAlongPair) => {
      const pairKey = `${pair.textBookId}:${pair.audioBookId}`;
      if (held.size > 0) return null;
      held.add(pairKey);
      let open = true;
      return {
        release: () => {
          if (!open) return;
          open = false;
          held.delete(pairKey);
        },
      };
    }),
    runBuild: vi.fn((_buildId: number, _pair, _user, _options, slot?: { release: () => void } | null) => {
      slot?.release();
      return Promise.resolve();
    }),
  };
}

/** Peak number of tracked calls in flight at once: 1 means they were awaited one after another. */
function createConcurrencyTracker() {
  let inFlight = 0;
  const tracker = {
    peak: 0,
    pending<T>(value: T) {
      return () => {
        inFlight += 1;
        tracker.peak = Math.max(tracker.peak, inFlight);
        return new Promise<T>((resolve) =>
          setTimeout(() => {
            inFlight -= 1;
            resolve(value);
          }, 0),
        );
      };
    },
  };
  return tracker;
}

async function setup() {
  const repo = {
    findSourceEpubFile: vi.fn().mockResolvedValue({ id: 20, absolutePath: '/books/text.epub' }),
    findAudioFiles: vi.fn().mockResolvedValue([{ fileId: 21, absolutePath: '/books/audio.mp3' }]),
    findBuildByPair: vi.fn().mockResolvedValue(undefined),
    hasAudioContentFile: vi.fn().mockResolvedValue(true),
    sumContentBytes: vi.fn().mockResolvedValue(null),
    findBuildByOutputBook: vi.fn().mockResolvedValue(undefined),
    startBuild: vi.fn().mockResolvedValue(buildRow({ status: 'building' })),
    findBookTitleAndAuthors: vi.fn().mockResolvedValue({ title: 'Book', authorNames: ['Author'], isbn10: null, isbn13: null, asin: null }),
  };
  const settings = {
    serverUrl: 'http://storyteller',
    username: 'service',
    passwordConfigured: true,
    pathMappings: [],
    targetLibraryId: 3,
    targetFolderId: 30,
    transport: 'api-transfer',
    deleteRemoteAfterImport: false,
    collectionName: null,
    lastCheckedAt: null,
    lastCheck: null,
  };
  const settingsService = {
    getSettings: vi.fn().mockResolvedValue(settings),
    getConnection: vi.fn().mockResolvedValue({ serverUrl: 'http://storyteller', username: 'u', password: 'p' }),
  };
  const session = { listBooks: vi.fn().mockResolvedValue([]) };
  const client = { createSession: vi.fn().mockReturnValue(session) };
  const buildService = createBuildServiceStub();
  const bookService = { verifyBookAccess: vi.fn().mockResolvedValue(undefined) };
  const libraryService = {
    verifyUserAccess: vi.fn().mockResolvedValue(undefined),
    findOne: vi.fn().mockResolvedValue({ id: 3, name: 'Read-alongs', type: 'books', allowedFormats: ['epub'], organizationMode: 'book_per_file' }),
  };
  const editionLinks = {
    findLinkForBook: vi.fn().mockResolvedValue(LINK),
    getBookModality: vi.fn().mockResolvedValue('text'),
    findBookSummary: vi.fn().mockResolvedValue(null),
    setReadAlongBook: vi.fn().mockResolvedValue(LINK),
  };
  const module = await Test.createTestingModule({
    providers: [
      StorytellerReadAlongStatusService,
      { provide: StorytellerRepository, useValue: repo },
      { provide: StorytellerSettingsService, useValue: settingsService },
      { provide: StorytellerClientService, useValue: client },
      { provide: StorytellerReadAlongBuildService, useValue: buildService },
      { provide: BookService, useValue: bookService },
      { provide: LibraryService, useValue: libraryService },
      { provide: EditionLinkRepository, useValue: editionLinks },
    ],
  }).compile();
  return {
    service: module.get(StorytellerReadAlongStatusService),
    repo,
    settings,
    settingsService,
    session,
    buildService,
    bookService,
    libraryService,
    editionLinks,
  };
}

vi.mock('./storyteller-epub.utils', () => ({ findSourceEpubProblem: vi.fn().mockResolvedValue(null) }));

describe('StorytellerReadAlongStatusService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('blocks as not_configured without claiming a build', async () => {
    const { service, settingsService, repo } = await setup();
    settingsService.getConnection.mockResolvedValue(null);

    await expect(service.requestBuild(10, USER, {})).resolves.toEqual({ status: 'none', blocked: 'not_configured' });
    expect(repo.startBuild).not.toHaveBeenCalled();
  });

  it('treats a stored-password decrypt failure as not_configured', async () => {
    const { service, settingsService } = await setup();
    settingsService.getConnection.mockRejectedValue(new InternalServerErrorException('decrypt failed'));

    await expect(service.requestBuild(10, USER, {})).resolves.toEqual({ status: 'none', blocked: 'not_configured' });
  });

  // Clearing the stored password on a host change is exactly what puts a running build here: the
  // admin saves a new server URL, and a hardcoded 'none' then swaps the build the user is watching
  // for "nothing here" until the next poll corrects it.
  it('keeps reporting an in-flight build when the connection is no longer configured', async () => {
    const { service, settingsService, repo } = await setup();
    settingsService.getConnection.mockResolvedValue(null);
    repo.findBuildByPair.mockResolvedValue(buildRow({ status: 'building', phase: 'wait' }));

    await expect(service.requestBuild(10, USER, {})).resolves.toEqual({ status: 'building', blocked: 'not_configured' });
    expect(repo.startBuild).not.toHaveBeenCalled();
  });

  it('keeps reporting an in-flight build when the stored password cannot be decrypted', async () => {
    const { service, settingsService, repo } = await setup();
    settingsService.getConnection.mockRejectedValue(new InternalServerErrorException('decrypt failed'));
    repo.findBuildByPair.mockResolvedValue(buildRow({ status: 'building', phase: 'wait' }));

    await expect(service.requestBuild(10, USER, {})).resolves.toEqual({ status: 'building', blocked: 'not_configured' });
  });

  // The not_configured answer is given before the pair is read, so without the same masking a caller
  // who cannot open the counterpart still learns a build is running against it.
  it('reports no build when the connection is unconfigured and the paired member is hidden', async () => {
    const { service, settingsService, repo, bookService } = await setup();
    settingsService.getConnection.mockResolvedValue(null);
    repo.findBuildByPair.mockResolvedValue(buildRow({ status: 'building', phase: 'wait' }));
    bookService.verifyBookAccess.mockImplementation((bookId: number) =>
      bookId === 11 ? Promise.reject(new NotFoundException('Book 11 not found')) : Promise.resolve(undefined),
    );

    await expect(service.requestBuild(10, USER, {})).resolves.toEqual({ status: 'none', blocked: 'not_configured' });
  });

  it('blocks on a recent failed connection check', async () => {
    const { service, settings, repo } = await setup();
    settings.lastCheckedAt = new Date().toISOString();
    settings.lastCheck = { ok: false } as never;

    await expect(service.requestBuild(10, USER, {})).resolves.toEqual({ status: 'none', blocked: 'unreachable' });
    expect(repo.startBuild).not.toHaveBeenCalled();
  });

  // Every other blocked branch reports the stored build's status. Hardcoding 'none' here swapped a
  // build that is actually running for "nothing here" the moment a connection check failed.
  it('keeps reporting an in-flight build when a recent connection check failed', async () => {
    const { service, settings, repo } = await setup();
    settings.lastCheckedAt = new Date().toISOString();
    settings.lastCheck = { ok: false } as never;
    repo.findBuildByPair.mockResolvedValue(buildRow({ status: 'building', phase: 'wait' }));

    await expect(service.requestBuild(10, USER, {})).resolves.toEqual({ status: 'building', blocked: 'unreachable' });
    expect(repo.startBuild).not.toHaveBeenCalled();
  });

  it('does not block on a failed check older than ten minutes', async () => {
    const { service, settings, repo } = await setup();
    settings.lastCheckedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    settings.lastCheck = { ok: false } as never;

    await expect(service.requestBuild(10, USER, {})).resolves.toEqual({ status: 'building', blocked: null });
    expect(repo.startBuild).toHaveBeenCalledOnce();
  });

  it('blocks when no edition pair exists', async () => {
    const { service, editionLinks } = await setup();
    editionLinks.findLinkForBook.mockResolvedValue(undefined);
    editionLinks.getBookModality.mockResolvedValue('text');

    await expect(service.requestBuild(10, USER, {})).resolves.toEqual({ status: 'none', blocked: 'no_pair' });
  });

  it('blocks when the text edition has no EPUB', async () => {
    const { service, repo } = await setup();
    repo.findSourceEpubFile.mockResolvedValue(undefined);

    await expect(service.requestBuild(10, USER, {})).resolves.toEqual({ status: 'none', blocked: 'no_epub' });
  });

  it('blocks when the audio edition has no audio', async () => {
    const { service, repo } = await setup();
    repo.hasAudioContentFile.mockResolvedValue(false);

    await expect(service.requestBuild(10, USER, {})).resolves.toEqual({ status: 'none', blocked: 'no_audio' });
  });

  // Whether to block is a yes/no question, and the answer is one row. Listing every track of a
  // 300-file audiobook to read its length is the same answer at 300 times the cost.
  it('tests for audio with a bounded probe rather than listing every track', async () => {
    const { service, repo } = await setup();

    await service.requestBuild(10, USER, {});

    expect(repo.hasAudioContentFile).toHaveBeenCalledWith(11);
    expect(repo.findAudioFiles).not.toHaveBeenCalled();
  });

  it('blocks when no target library is configured', async () => {
    const { service, settings } = await setup();
    settings.targetLibraryId = null;

    await expect(service.requestBuild(10, USER, {})).resolves.toEqual({ status: 'none', blocked: 'no_target_library' });
  });

  it('blocks when the target library is inaccessible', async () => {
    const { service, libraryService } = await setup();
    libraryService.verifyUserAccess.mockRejectedValue(new ForbiddenException());

    await expect(service.requestBuild(10, USER, {})).resolves.toEqual({ status: 'none', blocked: 'target_not_allowed' });
  });

  it('blocks podcast target libraries', async () => {
    const { service, libraryService } = await setup();
    libraryService.findOne.mockResolvedValue({ id: 3, type: 'podcasts', allowedFormats: ['epub'] });

    await expect(service.requestBuild(10, USER, {})).resolves.toEqual({ status: 'none', blocked: 'target_not_allowed' });
  });

  it('blocks target libraries that disallow EPUB', async () => {
    const { service, libraryService } = await setup();
    libraryService.findOne.mockResolvedValue({ id: 3, type: 'books', allowedFormats: ['pdf'] });

    await expect(service.requestBuild(10, USER, {})).resolves.toEqual({ status: 'none', blocked: 'format_not_allowed' });
  });

  it('returns a ready build unchanged when its output still exists', async () => {
    const { service, repo, editionLinks } = await setup();
    repo.findBuildByPair.mockResolvedValue(buildRow({ status: 'ready', outputBookId: 99 }));
    editionLinks.findBookSummary.mockResolvedValue({ id: 99, title: 'Read-along', authorName: null });

    await expect(service.requestBuild(10, USER, {})).resolves.toEqual({ status: 'ready', blocked: null });
    expect(repo.startBuild).not.toHaveBeenCalled();
  });

  it('blocks force rebuild when the user lacks LibraryDeleteBooks', async () => {
    const { service, repo, editionLinks } = await setup();
    repo.findBuildByPair.mockResolvedValue(buildRow({ status: 'ready', outputBookId: 99 }));
    editionLinks.findBookSummary.mockResolvedValue({ id: 99, title: 'Read-along', authorName: null });

    await expect(service.requestBuild(10, USER, { force: true })).resolves.toEqual({ status: 'ready', blocked: 'previous_output_not_deletable' });
  });

  // `collect` writes outputBookId as soon as it knows it and the failure path leaves the column set,
  // so a 'failed' row names a book a forced build will delete. Gating the permission on 'ready' left
  // that deletion reachable for a caller holding nothing but LibraryUpload.
  it('blocks a force rebuild without LibraryDeleteBooks on a failed build that still names an output', async () => {
    const { service, repo, buildService } = await setup();
    repo.findBuildByPair.mockResolvedValue(buildRow({ status: 'failed', outputBookId: 99 }));

    await expect(service.requestBuild(10, USER, { force: true })).resolves.toEqual({ status: 'failed', blocked: 'previous_output_not_deletable' });
    expect(repo.startBuild).not.toHaveBeenCalled();
    expect(buildService.runBuild).not.toHaveBeenCalled();
  });

  // The claim clears the row's output column, so after a failed rebuild the edition link is the only
  // record of the read-along still on disk, and that book is what the next forced build deletes.
  it('blocks a force rebuild without LibraryDeleteBooks when only the edition link names the output', async () => {
    const { service, repo, editionLinks, buildService } = await setup();
    editionLinks.findLinkForBook.mockResolvedValue({ ...LINK, readAlongBookId: 99 });
    repo.findBuildByPair.mockResolvedValue(buildRow({ status: 'failed', outputBookId: null }));

    await expect(service.requestBuild(10, USER, { force: true })).resolves.toEqual({
      status: 'failed',
      blocked: 'previous_output_not_deletable',
    });
    expect(repo.startBuild).not.toHaveBeenCalled();
    expect(buildService.runBuild).not.toHaveBeenCalled();
  });

  // The summary lookup describes the book; it does not decide whether the build may delete one.
  it('blocks a force rebuild without LibraryDeleteBooks even when the output summary no longer resolves', async () => {
    const { service, repo, editionLinks } = await setup();
    repo.findBuildByPair.mockResolvedValue(buildRow({ status: 'ready', outputBookId: 99 }));
    editionLinks.findBookSummary.mockResolvedValue(null);

    await expect(service.requestBuild(10, USER, { force: true })).resolves.toEqual({ status: 'ready', blocked: 'previous_output_not_deletable' });
    expect(repo.startBuild).not.toHaveBeenCalled();
  });

  // getStatus deliberately masks an output the caller cannot open, so a POST about a different book
  // must not 404 over the same row: a content filter excluding the read-along is enough to reach it.
  it('reports a previous output the caller cannot open as a block reason, not an exception', async () => {
    const { service, repo, bookService } = await setup();
    const deletingUser = { ...USER, permissions: [...USER.permissions, Permission.LibraryDeleteBooks] };
    repo.findBuildByPair.mockResolvedValue(buildRow({ status: 'ready', outputBookId: 99 }));
    bookService.verifyBookAccess.mockImplementation((bookId: number) =>
      bookId === 99 ? Promise.reject(new NotFoundException('hidden')) : Promise.resolve(undefined),
    );

    await expect(service.requestBuild(10, deletingUser, { force: true })).resolves.toEqual({
      status: 'ready',
      blocked: 'previous_output_not_deletable',
    });
    expect(repo.startBuild).not.toHaveBeenCalled();
  });

  // Nothing is deleted without force, so an output this caller cannot open changes no answer here.
  it('answers ready for an unforced request whose previous output the caller cannot open', async () => {
    const { service, repo, bookService, editionLinks } = await setup();
    repo.findBuildByPair.mockResolvedValue(buildRow({ status: 'ready', outputBookId: 99 }));
    editionLinks.findBookSummary.mockResolvedValue({ id: 99, title: 'Read-along', authorName: null });
    bookService.verifyBookAccess.mockImplementation((bookId: number) =>
      bookId === 99 ? Promise.reject(new NotFoundException('hidden')) : Promise.resolve(undefined),
    );

    await expect(service.requestBuild(10, USER, {})).resolves.toEqual({ status: 'ready', blocked: null });
  });

  it('allows a force rebuild with LibraryDeleteBooks and passes the old output id', async () => {
    const { service, repo, editionLinks, buildService } = await setup();
    const deletingUser = { ...USER, permissions: [...USER.permissions, Permission.LibraryDeleteBooks] };
    repo.findBuildByPair.mockResolvedValue(buildRow({ status: 'ready', outputBookId: 99 }));
    editionLinks.findBookSummary.mockResolvedValue({ id: 99, title: 'Read-along', authorName: null });

    await expect(service.requestBuild(10, deletingUser, { force: true })).resolves.toEqual({ status: 'building', blocked: null });
    expect(buildService.runBuild).toHaveBeenCalledWith(
      7,
      expect.anything(),
      deletingUser,
      expect.objectContaining({ force: true, oldOutputBookId: 99 }),
      expect.anything(),
    );
  });

  it('blocks when the build service is at capacity', async () => {
    const { service, buildService, repo } = await setup();
    buildService.tryReserve.mockReturnValue(null);

    await expect(service.requestBuild(10, USER, {})).resolves.toEqual({ status: 'none', blocked: 'busy' });
    expect(repo.startBuild).not.toHaveBeenCalled();
  });

  // The slot has to be taken before the claim, not merely checked before it: the claim strips
  // storyteller_book_uuid, transport and output_book_id off the row it wins, and that uuid is the
  // only handle on a Storyteller job the first request may already have started.
  it('holds the build slot across the claim, so a second pair is refused instead of stripped', async () => {
    const { service, repo, editionLinks } = await setup();
    editionLinks.findLinkForBook.mockImplementation((bookId: number) => Promise.resolve(bookId === 12 ? OTHER_LINK : LINK));
    const claim = deferred<ReturnType<typeof buildRow>>();
    repo.startBuild.mockReturnValueOnce(claim.promise);

    const first = service.requestBuild(10, USER, {});
    await expect(service.requestBuild(12, USER, {})).resolves.toEqual({ status: 'none', blocked: 'busy' });

    claim.resolve(buildRow({ status: 'building' }));
    await expect(first).resolves.toEqual({ status: 'building', blocked: null });
    expect(repo.startBuild).toHaveBeenCalledOnce();
  });

  // The uuid check is a round trip to Storyteller, so it runs with the slot already held.
  it('releases the slot when the offered uuid is refused', async () => {
    const { service, repo } = await setup();

    await expect(service.requestBuild(10, USER, { useExistingUuid: 'not-offered' })).rejects.toBeInstanceOf(BadRequestException);

    await expect(service.requestBuild(10, USER, {})).resolves.toEqual({ status: 'building', blocked: null });
    expect(repo.startBuild).toHaveBeenCalledOnce();
  });

  it('releases the slot when the row claim is lost', async () => {
    const { service, repo } = await setup();
    repo.startBuild.mockResolvedValueOnce(undefined);

    await expect(service.requestBuild(10, USER, {})).resolves.toEqual({ status: 'none', blocked: 'busy' });
    await expect(service.requestBuild(10, USER, {})).resolves.toEqual({ status: 'building', blocked: null });
  });

  // Releasing a slot already handed to a running build is what lets two builds run at once.
  it('leaves the reserved slot with the build it handed it to', async () => {
    const { service, buildService, editionLinks } = await setup();
    editionLinks.findLinkForBook.mockImplementation((bookId: number) => Promise.resolve(bookId === 12 ? OTHER_LINK : LINK));
    const running = deferred<void>();
    buildService.runBuild.mockImplementation((_buildId, _pair, _user, _options, slot) => running.promise.then(() => slot?.release()));

    await expect(service.requestBuild(10, USER, {})).resolves.toEqual({ status: 'building', blocked: null });
    await expect(service.requestBuild(12, USER, {})).resolves.toEqual({ status: 'none', blocked: 'busy' });

    running.resolve();
  });

  it('reports busy when the repository atomic claim loses', async () => {
    const { service, repo, buildService } = await setup();
    repo.startBuild.mockResolvedValue(undefined);

    await expect(service.requestBuild(10, USER, {})).resolves.toEqual({ status: 'none', blocked: 'busy' });
    expect(buildService.runBuild).not.toHaveBeenCalled();
  });

  it('resumes a failed build with its previous Storyteller uuid', async () => {
    const { service, repo, buildService } = await setup();
    repo.findBuildByPair.mockResolvedValue(buildRow({ status: 'failed', storytellerBookUuid: 'resume-me', transport: 'api-transfer' }));

    await expect(service.requestBuild(10, USER, {})).resolves.toEqual({ status: 'building', blocked: null });
    // The transport travels with the uuid: the claim clears the column, and an uploaded book
    // collected from the shared folder would wait out the whole window for nothing.
    expect(repo.startBuild).toHaveBeenCalledWith(expect.objectContaining({ storytellerBookUuid: 'resume-me', transport: 'api-transfer' }));
    expect(buildService.runBuild).toHaveBeenCalledOnce();
  });

  it('reports none when a ready output book was deleted', async () => {
    const { service, repo, editionLinks } = await setup();
    repo.findBuildByPair.mockResolvedValue(buildRow({ status: 'ready', outputBookId: 99, builtAt: new Date() }));
    editionLinks.findBookSummary.mockResolvedValue(null);

    const result = await service.getStatus(10, USER);

    expect(result.status).toBe('none');
    expect(result.outputBook).toBeNull();
  });

  // A GET must not write. The build service already links the output on completion, so the old
  // backfill-on-read only served to undo a deliberate detach within one poll interval.
  it('never writes to the edition link while reading status', async () => {
    const { service, repo, editionLinks } = await setup();
    repo.findBuildByPair.mockResolvedValue(buildRow({ status: 'ready', outputBookId: 99, builtAt: new Date() }));
    editionLinks.findBookSummary.mockResolvedValue({ id: 99, title: 'Read-along', authorName: null });

    await expect(service.getStatus(10, USER)).resolves.toMatchObject({ status: 'ready', outputBook: { id: 99, title: 'Read-along' } });
    expect(editionLinks.setReadAlongBook).not.toHaveBeenCalled();
  });

  // The read-along lands in an admin-designated library by design, so "reader sees the pair but not
  // the read-along" is the normal deployment: it is masked, never demanded.
  it('reads status without requiring access to the read-along member', async () => {
    const { service, bookService, editionLinks } = await setup();
    editionLinks.findLinkForBook.mockResolvedValue({ ...LINK, readAlongBookId: 30 });
    bookService.verifyBookAccess.mockImplementation((bookId: number) =>
      bookId === 30 ? Promise.reject(new NotFoundException('hidden')) : Promise.resolve(undefined),
    );

    await expect(service.getStatus(10, USER)).resolves.toMatchObject({ status: 'none' });
  });

  it('keeps a ready build ready and masks the output book the reader cannot open', async () => {
    const { service, repo, bookService, editionLinks } = await setup();
    repo.findBuildByPair.mockResolvedValue(buildRow({ status: 'ready', outputBookId: 99, builtAt: new Date() }));
    bookService.verifyBookAccess.mockImplementation((bookId: number) =>
      bookId === 99 ? Promise.reject(new ForbiddenException('hidden')) : Promise.resolve(undefined),
    );

    const result = await service.getStatus(10, USER);

    // Reporting 'none' here would invite a duplicate build of a read-along that already exists.
    expect(result.status).toBe('ready');
    expect(result.outputBook).toBeNull();
    expect(editionLinks.findBookSummary).not.toHaveBeenCalled();
  });

  // The cheap block reason used to run only after the pair was resolved, so an unlinked book could
  // report nothing but 'no_pair' and the generate control stayed enabled on an unconfigured instance.
  it('reports instance-level block reasons on an unlinked book', async () => {
    const { service, settings, editionLinks } = await setup();
    settings.serverUrl = null;
    editionLinks.findLinkForBook.mockResolvedValue(undefined);
    editionLinks.getBookModality.mockResolvedValue('text');

    await expect(service.getStatus(10, USER)).resolves.toMatchObject({ status: 'none', blocked: 'not_configured' });
  });

  it('reports no_target_library on an unlinked book with no destination configured', async () => {
    const { service, settings, editionLinks } = await setup();
    settings.targetLibraryId = null;
    editionLinks.findLinkForBook.mockResolvedValue(undefined);
    editionLinks.getBookModality.mockResolvedValue('text');

    await expect(service.getStatus(10, USER)).resolves.toMatchObject({ blocked: 'no_target_library' });
  });

  // The empty status is what the popover renders before any build exists - exactly when it shows the
  // destination and the "keep the Storyteller copy" checkbox.
  it('reflects the configured destination and delete preference when no build row exists', async () => {
    const { service, settings, editionLinks } = await setup();
    settings.deleteRemoteAfterImport = true;
    editionLinks.findLinkForBook.mockResolvedValue(undefined);
    editionLinks.getBookModality.mockResolvedValue('text');

    const result = await service.getStatus(10, USER);

    expect(result.keepRemoteCopyByDefault).toBe(false);
    expect(result.targetLibraryId).toBe(3);
    expect(result.targetLibraryName).toBe('Read-alongs');
  });

  // The destination is admin-designated and requestBuild refuses this same caller with
  // target_not_allowed, so naming it here only tells a reader which library they cannot reach.
  it('masks the destination from a caller who has no access to the target library', async () => {
    const { service, libraryService, editionLinks } = await setup();
    libraryService.verifyUserAccess.mockRejectedValue(new ForbiddenException('No access to this library'));
    editionLinks.findLinkForBook.mockResolvedValue(undefined);
    editionLinks.getBookModality.mockResolvedValue('text');

    const result = await service.getStatus(10, USER);

    expect(result.targetLibraryId).toBeNull();
    expect(result.targetLibraryName).toBeNull();
    // Nothing about the library is read at all, so the poll does not pay for a name it must not send.
    expect(libraryService.findOne).not.toHaveBeenCalled();
  });

  it('masks the destination of an existing build from a caller who cannot reach that library', async () => {
    const { service, repo, libraryService } = await setup();
    repo.findBuildByPair.mockResolvedValue(buildRow({ status: 'building', targetLibraryId: 3 }));
    libraryService.verifyUserAccess.mockRejectedValue(new ForbiddenException('No access to this library'));

    const result = await service.getStatus(10, USER);

    expect(result.status).toBe('building');
    expect(result.targetLibraryId).toBeNull();
    expect(result.targetLibraryName).toBeNull();
    expect(libraryService.findOne).not.toHaveBeenCalled();
  });

  // This route is ungated by design while the Storyteller host it describes sits behind
  // ManageAppSettings. The stored error is the provider's own message - a raw 409 body, a library
  // path from a write failure, a host:port from a refused connection - and the uuid names a book on
  // that host, so both are bounded by the library the build targets, exactly like the destination.
  it('masks the stored error from a caller who cannot reach the target library', async () => {
    const { service, repo, libraryService } = await setup();
    repo.findBuildByPair.mockResolvedValue(
      buildRow({
        status: 'failed',
        error: "EACCES: permission denied, open '/mnt/library/readalouds/book.epub.part'",
      }),
    );
    libraryService.verifyUserAccess.mockRejectedValue(new ForbiddenException('No access to this library'));

    const result = await service.getStatus(10, USER);

    expect(result.status).toBe('failed');
    expect(result.error).toBeNull();
  });

  it('keeps the stored error for a caller who can reach the target library', async () => {
    const { service, repo } = await setup();
    repo.findBuildByPair.mockResolvedValue(buildRow({ status: 'failed', error: 'Storyteller answered 409' }));

    const result = await service.getStatus(10, USER);

    expect(result.error).toBe('Storyteller answered 409');
  });

  // Every other instance-level field here is gated by the build permission, and the stored error is
  // the most revealing of them: a refused connection carries the Storyteller host and port. A reader
  // who cannot build still learns the build failed from `status`.
  it('masks the stored error from a reader who cannot build, and still reports the failure', async () => {
    const { service, repo } = await setup();
    const reader = { ...USER, permissions: [] } as unknown as RequestUser;
    repo.findBuildByPair.mockResolvedValue(buildRow({ status: 'failed', error: 'connect ECONNREFUSED 10.0.0.5:8001' }));

    const result = await service.getStatus(10, reader);

    expect(result.status).toBe('failed');
    expect(result.error).toBeNull();
  });

  it('checks target library access against the caller, not the instance', async () => {
    const { service, libraryService, editionLinks } = await setup();
    editionLinks.findLinkForBook.mockResolvedValue(undefined);
    editionLinks.getBookModality.mockResolvedValue('text');

    await service.getStatus(10, USER);

    expect(libraryService.verifyUserAccess).toHaveBeenCalledWith(USER.id, 3, USER.isSuperuser);
  });

  // The popover renders the "Keep Storyteller copy" checkbox on exactly this response, and the
  // tooltip beside it exists to price hundreds of megabytes.
  it('prices the pair when no build row exists yet', async () => {
    const { service, repo } = await setup();
    repo.sumContentBytes.mockImplementation((bookId: number) => Promise.resolve(bookId === 10 ? 1_200_000 : 850_000_000));

    const result = await service.getStatus(10, USER);

    expect(result.status).toBe('none');
    expect(result.remoteCopyBytes).toEqual({ epub: 1_200_000, audio: 850_000_000, readAlong: null });
    expect(repo.sumContentBytes).toHaveBeenCalledWith(10);
    expect(repo.sumContentBytes).toHaveBeenCalledWith(11);
  });

  // Null is "not known here", never zero: the read-along has no size before the first build, and an
  // unlinked book has no pair to size at all.
  it('reports unknown sizes as null rather than zero', async () => {
    const { service, repo, editionLinks } = await setup();
    repo.sumContentBytes.mockResolvedValue(null);
    editionLinks.findLinkForBook.mockResolvedValue(undefined);
    editionLinks.getBookModality.mockResolvedValue('text');

    const result = await service.getStatus(10, USER);

    expect(result.remoteCopyBytes).toEqual({ epub: null, audio: null, readAlong: null });
    expect(repo.sumContentBytes).not.toHaveBeenCalled();
  });

  // The popover polls this every five seconds, and the only thing the block reason asks of the audio
  // edition is whether it has a single file.
  it('asks whether the audio edition has any file at all instead of listing every track', async () => {
    const { service, repo } = await setup();

    await service.getStatus(10, USER);

    expect(repo.hasAudioContentFile).toHaveBeenCalledWith(11);
    expect(repo.findAudioFiles).not.toHaveBeenCalled();
  });

  it('blocks a status read as no_audio when the probe finds no audio file', async () => {
    const { service, repo } = await setup();
    repo.hasAudioContentFile.mockResolvedValue(false);

    await expect(service.getStatus(10, USER)).resolves.toMatchObject({ blocked: 'no_audio' });
  });

  // The client polls this every five seconds against a twelve-hour build ceiling, so the tail of the
  // response goes out as one round trip instead of a chain of them.
  it('issues the destination lookup and the size aggregates concurrently', async () => {
    const { service, repo, libraryService } = await setup();
    repo.findBuildByPair.mockResolvedValue(buildRow({ status: 'ready', outputBookId: 77 }));
    const tracker = createConcurrencyTracker();
    repo.sumContentBytes.mockImplementation(tracker.pending(1_000));
    libraryService.findOne.mockImplementation(tracker.pending({ id: 3, name: 'Read-alongs', type: 'books', allowedFormats: ['epub'] }));

    await service.getStatus(10, USER);

    expect(tracker.peak).toBeGreaterThanOrEqual(4);
  });

  // Only the none-branch renders the keep-copy hint, so a poll that runs for hours against a build
  // must not pay three sum() aggregates every five seconds for a number nothing shows.
  it('does not price the Storyteller copy while a build is running', async () => {
    const { service, repo } = await setup();
    repo.findBuildByPair.mockResolvedValue(buildRow({ status: 'building' }));

    const status = await service.getStatus(10, USER);

    expect(repo.sumContentBytes).not.toHaveBeenCalled();
    expect(status.remoteCopyBytes).toEqual({ epub: null, audio: null, readAlong: null });
  });

  it('reads the settings row once per status call and never decrypts the password', async () => {
    const { service, repo, settingsService } = await setup();
    repo.findBuildByPair.mockResolvedValue(buildRow({ status: 'building' }));

    await service.getStatus(10, USER);

    expect(settingsService.getSettings).toHaveBeenCalledOnce();
    expect(settingsService.getConnection).not.toHaveBeenCalled();
  });

  // StorytellerClientError carries `status`, not `statusCode`, so the global filter cannot read it:
  // unmapped it reaches the client as a bare 500 "Internal server error".
  it('maps a Storyteller client failure to an HTTP exception', async () => {
    const { service, session } = await setup();
    session.listBooks.mockRejectedValue(new StorytellerClientError('Storyteller rejected the credentials', 401));

    await expect(service.findExisting(10, USER)).rejects.toBeInstanceOf(BadGatewayException);
  });

  // verifyBookAccess answers `Book 11 not found`, so letting it escape tells a caller who can open
  // only the text edition that book 11 exists and is linked to theirs. The link goes invisible.
  it('denies a request when the paired member is hidden, without naming it', async () => {
    const { service, bookService, repo } = await setup();
    bookService.verifyBookAccess.mockImplementation((bookId: number) =>
      bookId === 11 ? Promise.reject(new NotFoundException('Book 11 not found')) : Promise.resolve(),
    );

    await expect(service.requestBuild(10, USER, {})).resolves.toEqual({ status: 'none', blocked: 'no_pair' });
    expect(repo.startBuild).not.toHaveBeenCalled();
  });

  it('hides a link whose paired member the caller cannot open, and never names that book', async () => {
    const { service, repo, bookService, editionLinks } = await setup();
    editionLinks.findLinkForBook.mockResolvedValue({ ...LINK, audioBookId: 219 });
    repo.findBuildByPair.mockResolvedValue(buildRow({ status: 'failed', audioBookId: 219, error: 'connect ECONNREFUSED 10.0.0.5:8001' }));
    bookService.verifyBookAccess.mockImplementation((bookId: number) =>
      bookId === 219 ? Promise.reject(new NotFoundException('Book 219 not found')) : Promise.resolve(undefined),
    );

    const result = await service.getStatus(10, USER);

    expect(result).toMatchObject({ status: 'none', blocked: 'no_pair', outputBook: null, error: null });
    expect(JSON.stringify(result)).not.toContain('219');
  });

  it('answers no existing matches when the paired member is hidden, without querying Storyteller', async () => {
    const { service, bookService, editionLinks, session } = await setup();
    editionLinks.findLinkForBook.mockResolvedValue({ ...LINK, audioBookId: 219 });
    bookService.verifyBookAccess.mockImplementation((bookId: number) =>
      bookId === 219 ? Promise.reject(new NotFoundException('Book 219 not found')) : Promise.resolve(undefined),
    );

    await expect(service.findExisting(10, USER)).resolves.toEqual({ matches: [] });
    expect(session.listBooks).not.toHaveBeenCalled();
  });

  // One title's lookup must not pull Storyteller's whole aligned library: the client has taken a
  // search and a limit since round 5, and this is the only caller that can pass them.
  it('asks Storyteller to narrow the existing-read-along lookup instead of pulling the catalogue', async () => {
    const { service, repo, session } = await setup();
    repo.findBookTitleAndAuthors.mockResolvedValue({ title: 'Dune', authorNames: ['Frank Herbert'], isbn10: null, isbn13: null, asin: null });
    session.listBooks.mockResolvedValue([]);

    await service.findExisting(10, USER);

    const options = session.listBooks.mock.calls[0]![0] as { alignedOnly?: boolean; search?: string; limit?: number };
    expect(options.alignedOnly).toBe(true);
    expect(options.search).toBe('Dune');
    expect(options.limit).toBeGreaterThan(0);
  });

  // A shared-paths build gives Storyteller nothing of its own: it reads the library's ebook and
  // audio in place and writes the read-along into the library folder, so cleanup can only ever drop
  // a cache. Telling the client otherwise puts a control on screen that governs nothing.
  it('reports no reclaimable remote copy for a shared-paths build', async () => {
    const { service, repo } = await setup();
    repo.findBuildByPair.mockResolvedValue(buildRow({ status: 'ready', transport: 'shared-paths', outputBookId: 77 }));

    await expect(service.getStatus(10, USER)).resolves.toMatchObject({ remoteCopyReclaimable: false });
  });

  it('reports a reclaimable remote copy for an uploaded build', async () => {
    const { service, repo } = await setup();
    repo.findBuildByPair.mockResolvedValue(buildRow({ status: 'ready', transport: 'api-transfer', outputBookId: 77 }));

    await expect(service.getStatus(10, USER)).resolves.toMatchObject({ remoteCopyReclaimable: true });
  });

  // Before a build exists the admin's last connection test is the only evidence of which route a
  // build would take.
  it('predicts from the last connection test before any build has run', async () => {
    const { service, settingsService } = await setup();
    settingsService.getSettings.mockResolvedValue({
      ...(await settingsService.getSettings()),
      lastCheck: { effectiveTransport: 'shared-paths' },
    });

    await expect(service.getStatus(10, USER)).resolves.toMatchObject({ remoteCopyReclaimable: false });
  });

  // The tick box on Link is disabled from this reason, so it has to reach an unlinked book: a caller
  // who cannot open the read-along library can never build, and learning that after linking a pair
  // is exactly what gating the tick box was for.
  it('reports an unusable destination on an unlinked book, ahead of no_pair', async () => {
    const { service, editionLinks, libraryService } = await setup();
    editionLinks.findLinkForBook.mockResolvedValue(undefined);
    editionLinks.getBookModality.mockResolvedValue('text');
    libraryService.verifyUserAccess.mockRejectedValue(new ForbiddenException('no access'));

    await expect(service.getStatus(10, USER)).resolves.toMatchObject({ blocked: 'target_not_allowed' });
  });

  // A file Storyteller cannot parse fails every import mode, so the build is refused on the click
  // rather than after hours of alignment ending in the provider's own 500.
  it('refuses a build whose source epub cannot be read, without claiming one', async () => {
    const { service, repo } = await setup();
    vi.mocked(epubUtils.findSourceEpubProblem).mockResolvedValue('missing_container');

    await expect(service.requestBuild(10, USER, {})).resolves.toMatchObject({ blocked: 'source_epub_unreadable' });
    expect(repo.startBuild).not.toHaveBeenCalled();
  });
});
