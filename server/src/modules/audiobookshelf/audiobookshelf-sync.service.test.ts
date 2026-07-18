import { BadRequestException, ConflictException } from '@nestjs/common';
import type { ReadingAttemptOrigin, ReadingAttemptOutcome, ReadStatus } from '@bookorbit/types';
import { describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import { ReadingAttemptService } from '../user-book-status/reading-attempt.service';
import { UserBookStatusService } from '../user-book-status/user-book-status.service';
import { AudiobookshelfSyncService, resolveAbsPosition, resolveAbsTargetStatus } from './audiobookshelf-sync.service';
import type { AbsMediaProgress } from './audiobookshelf-client.service';

function makeUser(overrides: Partial<RequestUser> = {}): RequestUser {
  return { id: 7, isSuperuser: false, ...overrides } as unknown as RequestUser;
}

function makeMp(overrides: Partial<AbsMediaProgress> = {}): AbsMediaProgress {
  return {
    id: 'mp-1',
    libraryItemId: 'abs-1',
    episodeId: null,
    mediaItemId: 'media-1',
    duration: 300,
    progress: 0.5,
    currentTime: 150,
    isFinished: false,
    lastUpdate: 2000,
    startedAt: 1000,
    finishedAt: null,
    ...overrides,
  };
}

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    userId: 7,
    absLibraryItemId: 'abs-1',
    bookId: 100,
    needsReview: false,
    syncExcluded: false,
    matchError: null,
    lastSyncedAbsUpdate: null,
    ...overrides,
  };
}

function makeMatchSummary(selectedAbsItemIds: string[] = ['abs-1', 'abs-a', 'abs-b', 'abs-c', 'abs-d']) {
  return { autoLinked: 0, selectedAbsItemIds };
}

function makeDeps() {
  const repo = {
    findSettings: vi.fn(),
    findSyncableBookStatesByAbsItemIds: vi.fn().mockResolvedValue([]),
    updateBookState: vi.fn().mockResolvedValue(undefined),
    updateSettings: vi.fn().mockResolvedValue(undefined),
  };
  const client = { getMe: vi.fn().mockResolvedValue({ mediaProgress: [] }) };
  const matchService = { matchLibrary: vi.fn().mockResolvedValue(makeMatchSummary()) };
  const attempts = { importExternalRead: vi.fn().mockResolvedValue(undefined) };
  const statusService = { findOne: vi.fn().mockResolvedValue(null), updateManual: vi.fn().mockResolvedValue(undefined) };
  const bookService = {
    getAudioFilesInPlayOrder: vi.fn().mockResolvedValue([{ id: 1, format: 'mp3', durationSeconds: 300 }]),
    getAudioProgressForSync: vi.fn().mockResolvedValue(null),
    upsertAudioProgressFromSync: vi.fn().mockResolvedValue({ updatedAt: new Date('2026-07-12T00:00:00.000Z') }),
  };
  const sessionsService = {
    syncSessions: vi.fn().mockResolvedValue({ inserted: 0, updated: 0, skipped: 0, watermark: null }),
    deepReconciliationScan: vi.fn().mockResolvedValue({ inserted: 0, updated: 0, skipped: 0, watermark: null }),
  };
  const libraryService = { findAccessibleLibraryIds: vi.fn().mockResolvedValue([1, 2]) };
  const settings = {
    userId: 7,
    serverUrl: 'http://abs.local',
    apiToken: 'token',
    enabled: true,
    syncStatus: true,
    syncPosition: true,
    syncSessions: true,
  };
  repo.findSettings.mockResolvedValue(settings);
  const service = new AudiobookshelfSyncService(
    repo as never,
    client as never,
    matchService as never,
    attempts as never,
    statusService as never,
    bookService as never,
    sessionsService as never,
    libraryService as never,
  );
  return { service, repo, client, matchService, attempts, statusService, bookService, sessionsService, settings, libraryService };
}

describe('resolveAbsTargetStatus', () => {
  const cases: Array<{ current: ReadStatus; finished: ReadStatus | null; inProgress: ReadStatus | null }> = [
    { current: 'unread', finished: 'read', inProgress: 'reading' },
    { current: 'want_to_read', finished: 'read', inProgress: 'reading' },
    { current: 'reading', finished: 'read', inProgress: null },
    { current: 'on_hold', finished: 'read', inProgress: null },
    { current: 'rereading', finished: 'read', inProgress: null },
    { current: 'skimmed', finished: 'read', inProgress: null },
    { current: 'read', finished: null, inProgress: null },
    { current: 'abandoned', finished: 'read', inProgress: null },
  ];

  for (const c of cases) {
    it(`${c.current}: finished -> ${c.finished}, in-progress -> ${c.inProgress}`, () => {
      expect(resolveAbsTargetStatus(c.current, true)).toBe(c.finished);
      expect(resolveAbsTargetStatus(c.current, false)).toBe(c.inProgress);
    });
  }
});

describe('resolveAbsPosition', () => {
  const files = [
    { id: 1, durationSeconds: 100 },
    { id: 2, durationSeconds: 200 },
    { id: 3, durationSeconds: 150 },
  ];

  it('returns null for no files', () => {
    expect(resolveAbsPosition([], 42)).toBeNull();
  });

  it('resolves within the first file', () => {
    expect(resolveAbsPosition(files, 50)).toEqual({ currentFileId: 1, positionSeconds: 50 });
  });

  it('maps an exact file boundary to the start of the next file', () => {
    expect(resolveAbsPosition(files, 100)).toEqual({ currentFileId: 2, positionSeconds: 0 });
    expect(resolveAbsPosition(files, 300)).toEqual({ currentFileId: 3, positionSeconds: 0 });
  });

  it('resolves a middle-file offset', () => {
    expect(resolveAbsPosition(files, 250)).toEqual({ currentFileId: 2, positionSeconds: 150 });
  });

  it('clamps a position at or beyond the total to the end of the last file', () => {
    expect(resolveAbsPosition(files, 450)).toEqual({ currentFileId: 3, positionSeconds: 150 });
    expect(resolveAbsPosition(files, 600)).toEqual({ currentFileId: 3, positionSeconds: 150 });
  });

  it('treats null durations as zero', () => {
    expect(resolveAbsPosition([{ id: 9, durationSeconds: null }], 30)).toEqual({ currentFileId: 9, positionSeconds: 0 });
  });
});

describe('AudiobookshelfSyncService.sync', () => {
  it('rejects when the integration is not configured', async () => {
    const { service, repo } = makeDeps();
    repo.findSettings.mockResolvedValue({ enabled: false, serverUrl: 'http://abs', apiToken: 't' });
    await expect(service.sync(makeUser())).rejects.toBeInstanceOf(BadRequestException);
  });

  it('imports the attempt before applying status and writes position for a finished book', async () => {
    const { service, client, attempts, statusService, bookService, repo } = makeDeps();
    const order: string[] = [];
    attempts.importExternalRead.mockImplementation(() => {
      order.push('attempt');
      return Promise.resolve();
    });
    statusService.updateManual.mockImplementation(() => {
      order.push('status');
      return Promise.resolve();
    });
    const mp = makeMp({ isFinished: true, progress: 1, currentTime: 300, finishedAt: 1_700_000_000_000, lastUpdate: 1_700_000_000_000 });
    client.getMe.mockResolvedValue({ mediaProgress: [mp] });
    repo.findSyncableBookStatesByAbsItemIds.mockResolvedValue([makeState()]);

    const result = await service.sync(makeUser());

    expect(order).toEqual(['attempt', 'status']);
    expect(attempts.importExternalRead).toHaveBeenCalledWith(7, 100, {
      provider: 'audiobookshelf',
      externalId: 'mp-1',
      startedOn: expect.any(String),
      endedOn: '2023-11-14',
    });
    expect(statusService.updateManual).toHaveBeenCalledWith(7, 100, { status: 'read' });
    expect(bookService.upsertAudioProgressFromSync).toHaveBeenCalledWith(7, 100, 1, 300, 100);
    expect(result).toMatchObject({ statusApplied: 1, positionApplied: 1, sessionsApplied: 0, skipped: 0, failed: 0 });
    expect(repo.updateBookState).toHaveBeenCalledWith(
      7,
      'abs-1',
      expect.objectContaining({ lastSyncedAbsUpdate: 1_700_000_000_000, syncError: null, lastSyncedStatus: 'read' }),
    );
    expect(repo.updateSettings).toHaveBeenCalledWith(7, expect.objectContaining({ lastSyncError: null }));
  });

  it('short-circuits unchanged items without any writes', async () => {
    const { service, client, attempts, statusService, bookService, repo } = makeDeps();
    client.getMe.mockResolvedValue({ mediaProgress: [makeMp({ lastUpdate: 2000 })] });
    repo.findSyncableBookStatesByAbsItemIds.mockResolvedValue([makeState({ lastSyncedAbsUpdate: 2000 })]);

    const result = await service.sync(makeUser());

    expect(result.skipped).toBe(1);
    expect(attempts.importExternalRead).not.toHaveBeenCalled();
    expect(statusService.updateManual).not.toHaveBeenCalled();
    expect(bookService.upsertAudioProgressFromSync).not.toHaveBeenCalled();
    expect(repo.updateBookState).not.toHaveBeenCalled();
  });

  it('skips items that are unlinked, need review, excluded, or errored', async () => {
    const { service, client, repo, attempts } = makeDeps();
    client.getMe.mockResolvedValue({
      mediaProgress: [
        makeMp({ id: 'mp-a', libraryItemId: 'abs-a' }),
        makeMp({ id: 'mp-b', libraryItemId: 'abs-b' }),
        makeMp({ id: 'mp-c', libraryItemId: 'abs-c' }),
        makeMp({ id: 'mp-d', libraryItemId: 'abs-d' }),
      ],
    });
    repo.findSyncableBookStatesByAbsItemIds.mockResolvedValue([]);

    const result = await service.sync(makeUser());

    expect(result.skipped).toBe(4);
    expect(attempts.importExternalRead).not.toHaveBeenCalled();
  });

  it('scopes progress sync through current library access and content filters', async () => {
    const { service, client, repo, attempts, statusService, bookService, libraryService } = makeDeps();
    const contentFilters = { includeTagIds: [5], excludeTagIds: [9], includeGenreIds: [], excludeGenreIds: [] };
    libraryService.findAccessibleLibraryIds.mockResolvedValue([77]);
    client.getMe.mockResolvedValue({ mediaProgress: [makeMp({ libraryItemId: 'abs-1' })] });
    repo.findSyncableBookStatesByAbsItemIds.mockResolvedValue([]);

    const result = await service.sync(makeUser({ contentFilters }));

    expect(repo.findSyncableBookStatesByAbsItemIds).toHaveBeenCalledWith(7, { libraryIds: [77], contentFilters }, ['abs-1']);
    expect(result.skipped).toBe(1);
    expect(attempts.importExternalRead).not.toHaveBeenCalled();
    expect(statusService.updateManual).not.toHaveBeenCalled();
    expect(bookService.upsertAudioProgressFromSync).not.toHaveBeenCalled();
    expect(repo.updateBookState).not.toHaveBeenCalled();
  });

  it('does not sync preserved excluded-library progress when the selected inventory is empty', async () => {
    const { service, client, repo, matchService, attempts, statusService, bookService } = makeDeps();
    matchService.matchLibrary.mockResolvedValue(makeMatchSummary([]));
    client.getMe.mockResolvedValue({ mediaProgress: [makeMp({ libraryItemId: 'abs-1' })] });
    repo.findSyncableBookStatesByAbsItemIds.mockResolvedValue([makeState()]);

    const result = await service.sync(makeUser());

    expect(result.skipped).toBe(1);
    expect(repo.findSyncableBookStatesByAbsItemIds).not.toHaveBeenCalled();
    expect(attempts.importExternalRead).not.toHaveBeenCalled();
    expect(statusService.updateManual).not.toHaveBeenCalled();
    expect(bookService.upsertAudioProgressFromSync).not.toHaveBeenCalled();
    expect(repo.updateBookState).not.toHaveBeenCalled();
  });

  it('skips the position write when local and ABS durations disagree beyond tolerance', async () => {
    const { service, client, bookService, repo, statusService } = makeDeps();
    statusService.findOne.mockResolvedValue({ status: 'unread' });
    client.getMe.mockResolvedValue({ mediaProgress: [makeMp({ duration: 1000, currentTime: 100 })] });
    repo.findSyncableBookStatesByAbsItemIds.mockResolvedValue([makeState()]);
    bookService.getAudioFilesInPlayOrder.mockResolvedValue([{ id: 1, format: 'mp3', durationSeconds: 300 }]);

    const result = await service.sync(makeUser());

    expect(bookService.upsertAudioProgressFromSync).not.toHaveBeenCalled();
    expect(result.positionApplied).toBe(0);
    expect(result.statusApplied).toBe(1);
  });

  it('skips the position write when the book has no audio files but still syncs status', async () => {
    const { service, client, bookService, repo, statusService } = makeDeps();
    statusService.findOne.mockResolvedValue({ status: 'unread' });
    client.getMe.mockResolvedValue({ mediaProgress: [makeMp()] });
    repo.findSyncableBookStatesByAbsItemIds.mockResolvedValue([makeState()]);
    bookService.getAudioFilesInPlayOrder.mockResolvedValue([]);

    const result = await service.sync(makeUser());

    expect(bookService.upsertAudioProgressFromSync).not.toHaveBeenCalled();
    expect(result.positionApplied).toBe(0);
    expect(result.statusApplied).toBe(1);
  });

  it('flows a re-listen through even when progress dropped, since ABS lastUpdate advanced', async () => {
    const { service, client, bookService, repo, statusService } = makeDeps();
    statusService.findOne.mockResolvedValue({ status: 'read' });
    client.getMe.mockResolvedValue({ mediaProgress: [makeMp({ progress: 0.03, currentTime: 9, duration: 300, lastUpdate: 5000 })] });
    repo.findSyncableBookStatesByAbsItemIds.mockResolvedValue([makeState({ lastSyncedAbsUpdate: 4000 })]);

    const result = await service.sync(makeUser());

    expect(bookService.upsertAudioProgressFromSync).toHaveBeenCalledWith(7, 100, 1, 9, 3);
    expect(result.positionApplied).toBe(1);
    expect(result.statusApplied).toBe(0);
  });

  it('does not overwrite local playback that advanced since our last ABS write', async () => {
    const { service, client, bookService, repo, statusService } = makeDeps();
    statusService.findOne.mockResolvedValue({ status: 'reading' });
    client.getMe.mockResolvedValue({ mediaProgress: [makeMp({ progress: 0.5, currentTime: 150, lastUpdate: 5000 })] });
    repo.findSyncableBookStatesByAbsItemIds.mockResolvedValue([
      makeState({ lastSyncedAbsUpdate: 4000, lastSyncedPositionAbsUpdate: 4000, lastSyncedProgressAt: new Date('2026-07-10T00:00:00.000Z') }),
    ]);
    // The progress row's updatedAt no longer matches our snapshot -> local playback moved it.
    bookService.getAudioProgressForSync.mockResolvedValue({ percentage: 80, updatedAt: new Date('2026-07-11T00:00:00.000Z') });

    const result = await service.sync(makeUser());

    expect(bookService.upsertAudioProgressFromSync).not.toHaveBeenCalled();
    expect(result.positionApplied).toBe(0);
  });

  it('applies an ABS re-listen backward when the local row is unchanged since our write', async () => {
    const { service, client, bookService, repo, statusService } = makeDeps();
    const snapshot = new Date('2026-07-10T00:00:00.000Z');
    statusService.findOne.mockResolvedValue({ status: 'read' });
    client.getMe.mockResolvedValue({ mediaProgress: [makeMp({ progress: 0.03, currentTime: 9, duration: 300, lastUpdate: 5000 })] });
    repo.findSyncableBookStatesByAbsItemIds.mockResolvedValue([
      makeState({ lastSyncedAbsUpdate: 4000, lastSyncedPositionAbsUpdate: 4000, lastSyncedProgressAt: snapshot }),
    ]);
    bookService.getAudioProgressForSync.mockResolvedValue({ percentage: 90, updatedAt: snapshot });

    const result = await service.sync(makeUser());

    expect(bookService.upsertAudioProgressFromSync).toHaveBeenCalledWith(7, 100, 1, 9, 3);
    expect(result.positionApplied).toBe(1);
  });

  it('retries a due position phase even when the status watermark is already current', async () => {
    const { service, client, bookService, repo, statusService } = makeDeps();
    statusService.findOne.mockResolvedValue({ status: 'reading' });
    client.getMe.mockResolvedValue({ mediaProgress: [makeMp({ lastUpdate: 2000, currentTime: 150, duration: 300 })] });
    repo.findSyncableBookStatesByAbsItemIds.mockResolvedValue([makeState({ lastSyncedAbsUpdate: 2000, lastSyncedPositionAbsUpdate: 1000 })]);

    const result = await service.sync(makeUser());

    expect(result.statusApplied).toBe(0);
    expect(bookService.upsertAudioProgressFromSync).toHaveBeenCalled();
    expect(result.positionApplied).toBe(1);
  });

  it('isolates a per-book failure and continues with the next book', async () => {
    const { service, client, attempts, repo } = makeDeps();
    client.getMe.mockResolvedValue({
      mediaProgress: [makeMp({ id: 'mp-a', libraryItemId: 'abs-a' }), makeMp({ id: 'mp-b', libraryItemId: 'abs-b' })],
    });
    repo.findSyncableBookStatesByAbsItemIds.mockResolvedValue([
      makeState({ absLibraryItemId: 'abs-a', bookId: 100 }),
      makeState({ absLibraryItemId: 'abs-b', bookId: 200 }),
    ]);
    attempts.importExternalRead.mockRejectedValueOnce(new Error('boom "quoted"'));

    const result = await service.sync(makeUser());

    expect(result.failed).toBe(1);
    expect(repo.updateBookState).toHaveBeenCalledWith(7, 'abs-a', { syncError: expect.stringContaining('boom') });
    expect(repo.updateBookState).toHaveBeenCalledWith(7, 'abs-b', expect.objectContaining({ lastSyncedAbsUpdate: 2000, syncError: null }));
  });

  it('reports matched from the match step', async () => {
    const { service, matchService } = makeDeps();
    matchService.matchLibrary.mockResolvedValue({ ...makeMatchSummary(), autoLinked: 4 });

    const result = await service.sync(makeUser());

    expect(matchService.matchLibrary).toHaveBeenCalledWith(makeUser(), 'http://abs.local', 'token', {
      force: false,
      excludedLibraryIds: [],
    });
    expect(result.matched).toBe(4);
  });

  it('reports sessionsApplied as inserted + updated from the session ingest', async () => {
    const { service, sessionsService, repo } = makeDeps();
    sessionsService.syncSessions.mockResolvedValue({ inserted: 5, updated: 3, skipped: 1, watermark: 123 });

    const result = await service.sync(makeUser());

    expect(sessionsService.syncSessions).toHaveBeenCalledWith(makeUser(), expect.objectContaining({ syncSessions: true }));
    expect(result.sessionsApplied).toBe(8);
    expect(repo.updateSettings).toHaveBeenCalledWith(7, expect.objectContaining({ lastSyncError: null }));
  });

  it('does not ingest sessions when the syncSessions toggle is off', async () => {
    const { service, sessionsService, repo } = makeDeps();
    repo.findSettings.mockResolvedValue({
      userId: 7,
      serverUrl: 'http://abs.local',
      apiToken: 'token',
      enabled: true,
      syncStatus: true,
      syncPosition: true,
      syncSessions: false,
    });

    const result = await service.sync(makeUser());

    expect(sessionsService.syncSessions).not.toHaveBeenCalled();
    expect(result.sessionsApplied).toBe(0);
  });

  it('isolates a session-ingest failure: still completes and records the error on settings', async () => {
    const { service, sessionsService, repo } = makeDeps();
    sessionsService.syncSessions.mockRejectedValue(new Error('sessions "boom"'));

    const result = await service.sync(makeUser());

    expect(result.sessionsApplied).toBe(0);
    expect(repo.updateSettings).toHaveBeenCalledWith(7, expect.objectContaining({ lastSyncError: expect.stringContaining('sessions') }));
  });

  it('skips items entirely when both status and position sync are disabled', async () => {
    const { service, client, repo, attempts, bookService } = makeDeps();
    repo.findSettings.mockResolvedValue({
      userId: 7,
      serverUrl: 'http://abs.local',
      apiToken: 'token',
      enabled: true,
      syncStatus: false,
      syncPosition: false,
    });
    client.getMe.mockResolvedValue({ mediaProgress: [makeMp()] });
    repo.findSyncableBookStatesByAbsItemIds.mockResolvedValue([makeState()]);

    const result = await service.sync(makeUser());

    expect(result.skipped).toBe(1);
    expect(attempts.importExternalRead).not.toHaveBeenCalled();
    expect(bookService.upsertAudioProgressFromSync).not.toHaveBeenCalled();
    expect(repo.updateBookState).not.toHaveBeenCalled();
  });

  it('records a run-level failure on settings and rethrows', async () => {
    const { service, client, repo } = makeDeps();
    client.getMe.mockRejectedValue(new Error('abs unreachable'));

    await expect(service.sync(makeUser())).rejects.toThrow('abs unreachable');
    expect(repo.updateSettings).toHaveBeenCalledWith(7, expect.objectContaining({ lastSyncError: expect.stringContaining('abs unreachable') }));
  });

  it('fullResync re-applies an unchanged item (force bypasses the watermark short-circuit) and runs the deep scan', async () => {
    const { service, client, attempts, statusService, repo, sessionsService, matchService } = makeDeps();
    statusService.findOne.mockResolvedValue({ status: 'unread' });
    client.getMe.mockResolvedValue({ mediaProgress: [makeMp({ lastUpdate: 2000 })] });
    repo.findSyncableBookStatesByAbsItemIds.mockResolvedValue([makeState({ lastSyncedAbsUpdate: 2000 })]);

    const result = await service.fullResync(makeUser());

    expect(matchService.matchLibrary).toHaveBeenCalledWith(makeUser(), 'http://abs.local', 'token', {
      force: true,
      excludedLibraryIds: [],
    });
    expect(attempts.importExternalRead).toHaveBeenCalledTimes(1);
    expect(result.skipped).toBe(0);
    expect(sessionsService.deepReconciliationScan).toHaveBeenCalledWith(makeUser(), expect.objectContaining({ syncSessions: true }));
    expect(sessionsService.syncSessions).not.toHaveBeenCalled();
  });

  it('rejects a second concurrent run for the same user', async () => {
    const { service, matchService, client } = makeDeps();
    let release: (() => void) | undefined;
    matchService.matchLibrary.mockReturnValueOnce(
      new Promise((resolve) => {
        release = () => resolve(makeMatchSummary());
      }),
    );
    client.getMe.mockResolvedValue({ mediaProgress: [] });

    const first = service.sync(makeUser());
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(service.sync(makeUser())).rejects.toBeInstanceOf(ConflictException);
    release?.();
    await first;
  });
});

// The load-bearing ordering guarantee, proven end-to-end against the real attempt/status services:
// importExternalRead first, then updateManual, must yield exactly one attempt carrying the ABS finish date.
describe('AudiobookshelfSyncService ordering against real reading-attempt/status services', () => {
  type Row = {
    id: number;
    userId: number;
    bookId: number;
    startedOn: string | null;
    endedOn: string | null;
    outcome: ReadingAttemptOutcome | null;
    origin: ReadingAttemptOrigin;
    externalProvider: string | null;
    externalId: string | null;
    deletedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };

  function makeFakeAttemptRepo() {
    const rows: Row[] = [];
    let nextId = 1;
    const projections: Array<{ status: ReadStatus; finishedAt: Date | null }> = [];
    const now = new Date('2026-07-12T12:00:00.000Z');
    const repo = {
      transaction: vi.fn((cb: (tx: object) => Promise<unknown>) => cb({})),
      findActive: vi.fn((_tx: object, userId: number, bookId: number) =>
        Promise.resolve(rows.find((r) => r.userId === userId && r.bookId === bookId && r.outcome === null && r.deletedAt === null)),
      ),
      findLatest: vi.fn((_tx: object, userId: number, bookId: number) =>
        Promise.resolve([...rows].reverse().find((r) => r.userId === userId && r.bookId === bookId && r.deletedAt === null)),
      ),
      hasCompleted: vi.fn((_tx: object, userId: number, bookId: number) =>
        Promise.resolve(rows.some((r) => r.userId === userId && r.bookId === bookId && r.outcome === 'completed' && r.deletedAt === null)),
      ),
      create: vi.fn((_tx: object, values: Omit<Row, 'id' | 'deletedAt' | 'createdAt' | 'updatedAt'>) => {
        const row: Row = { ...values, id: nextId++, deletedAt: null, createdAt: now, updatedAt: now } as Row;
        rows.push(row);
        return Promise.resolve(row);
      }),
      createActive: vi.fn((_tx: object, values: Record<string, unknown>) => {
        const existing = rows.find((r) => r.userId === values.userId && r.bookId === values.bookId && r.outcome === null && r.deletedAt === null);
        if (existing) return Promise.resolve(existing);
        return repo.create(_tx, { ...(values as never), endedOn: null, outcome: null });
      }),
      update: vi.fn((_tx: object, userId: number, bookId: number, id: number, patch: Partial<Row>) => {
        const row = rows.find((r) => r.id === id && r.userId === userId && r.bookId === bookId && r.deletedAt === null);
        if (!row) return Promise.resolve(null);
        Object.assign(row, patch, { updatedAt: now });
        return Promise.resolve(row);
      }),
      project: vi.fn((_tx: object, _userId: number, _bookId: number, projection: { status: ReadStatus; finishedAt: Date | null }) => {
        projections.push(projection);
        return Promise.resolve();
      }),
      findStatus: vi.fn(() => Promise.resolve(null)),
      findByExternal: vi.fn((_tx: object, userId: number, provider: string, externalId: string) =>
        Promise.resolve(rows.find((r) => r.userId === userId && r.externalProvider === provider && r.externalId === externalId)),
      ),
    };
    return { repo, rows, projections };
  }

  it('creates exactly one attempt with the ABS finish date and projects read', async () => {
    const fake = makeFakeAttemptRepo();
    const attemptService = new ReadingAttemptService(fake.repo as never);
    const ubsRepo = { findOne: vi.fn().mockResolvedValue(null) };
    const statusService = new UserBookStatusService(ubsRepo as never, { emit: vi.fn() } as never, attemptService);

    const repo = {
      findSettings: vi.fn().mockResolvedValue({
        userId: 7,
        serverUrl: 'http://abs.local',
        apiToken: 'token',
        enabled: true,
        syncStatus: true,
        syncPosition: false,
      }),
      findSyncableBookStatesByAbsItemIds: vi.fn().mockResolvedValue([makeState()]),
      updateBookState: vi.fn().mockResolvedValue(undefined),
      updateSettings: vi.fn().mockResolvedValue(undefined),
    };
    const client = {
      getMe: vi.fn().mockResolvedValue({
        mediaProgress: [makeMp({ isFinished: true, progress: 1, currentTime: 300, startedAt: 1_699_900_000_000, finishedAt: 1_700_000_000_000 })],
      }),
    };
    const matchService = { matchLibrary: vi.fn().mockResolvedValue(makeMatchSummary()) };
    const bookService = { getAudioFilesInPlayOrder: vi.fn(), upsertAudioProgressFromSync: vi.fn() };
    const sessionsService = { syncSessions: vi.fn().mockResolvedValue({ inserted: 0, updated: 0, skipped: 0, watermark: null }) };
    const libraryService = { findAccessibleLibraryIds: vi.fn().mockResolvedValue([1, 2]) };

    const service = new AudiobookshelfSyncService(
      repo as never,
      client as never,
      matchService as never,
      attemptService as never,
      statusService as never,
      bookService as never,
      sessionsService as never,
      libraryService as never,
    );

    const result = await service.sync(makeUser());

    const live = fake.rows.filter((r) => r.deletedAt === null);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ origin: 'audiobookshelf', externalId: 'mp-1', outcome: 'completed', endedOn: '2023-11-14' });
    expect(fake.projections.at(-1)).toMatchObject({ status: 'read' });
    expect(fake.projections.at(-1)?.finishedAt).toEqual(new Date('2023-11-14T00:00:00.000Z'));
    expect(result.statusApplied).toBe(1);
  });

  it('adopts a pre-existing local active attempt on ABS finish instead of duplicating it', async () => {
    const fake = makeFakeAttemptRepo();
    fake.rows.push({
      id: 1,
      userId: 7,
      bookId: 100,
      startedOn: '2023-11-01',
      endedOn: null,
      outcome: null,
      origin: 'manual',
      externalProvider: null,
      externalId: null,
      deletedAt: null,
      createdAt: new Date('2026-07-10T00:00:00.000Z'),
      updatedAt: new Date('2026-07-10T00:00:00.000Z'),
    });
    const attemptService = new ReadingAttemptService(fake.repo as never);
    const ubsRepo = { findOne: vi.fn().mockResolvedValue(null) };
    const statusService = new UserBookStatusService(ubsRepo as never, { emit: vi.fn() } as never, attemptService);

    const repo = {
      findSettings: vi.fn().mockResolvedValue({
        userId: 7,
        serverUrl: 'http://abs.local',
        apiToken: 'token',
        enabled: true,
        syncStatus: true,
        syncPosition: false,
      }),
      findSyncableBookStatesByAbsItemIds: vi.fn().mockResolvedValue([makeState()]),
      updateBookState: vi.fn().mockResolvedValue(undefined),
      updateSettings: vi.fn().mockResolvedValue(undefined),
    };
    const client = {
      getMe: vi.fn().mockResolvedValue({
        mediaProgress: [makeMp({ isFinished: true, progress: 1, currentTime: 300, startedAt: 1_699_900_000_000, finishedAt: 1_700_000_000_000 })],
      }),
    };
    const matchService = { matchLibrary: vi.fn().mockResolvedValue(makeMatchSummary()) };
    const bookService = { getAudioFilesInPlayOrder: vi.fn(), getAudioProgressForSync: vi.fn(), upsertAudioProgressFromSync: vi.fn() };
    const sessionsService = { syncSessions: vi.fn().mockResolvedValue({ inserted: 0, updated: 0, skipped: 0, watermark: null }) };
    const libraryService = { findAccessibleLibraryIds: vi.fn().mockResolvedValue([1, 2]) };

    const service = new AudiobookshelfSyncService(
      repo as never,
      client as never,
      matchService as never,
      attemptService as never,
      statusService as never,
      bookService as never,
      sessionsService as never,
      libraryService as never,
    );

    await service.sync(makeUser());

    const live = fake.rows.filter((r) => r.deletedAt === null);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ id: 1, externalProvider: 'audiobookshelf', externalId: 'mp-1', outcome: 'completed', endedOn: '2023-11-14' });
    expect(fake.projections.at(-1)).toMatchObject({ status: 'read' });
  });
});
