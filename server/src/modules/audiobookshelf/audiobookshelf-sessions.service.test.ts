import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Shrink the session page size so multi-page pagination can be exercised with tiny arrays. Everything
// else in the constants module (overlap window, ingest chunk, backfill threshold) keeps its real value.
vi.mock('./audiobookshelf.constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./audiobookshelf.constants')>();
  return { ...actual, AUDIOBOOKSHELF_SESSIONS_PAGE_SIZE: 2 };
});

import { ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED } from '../achievement/achievement-events.service';
import { AudiobookshelfSessionsService } from './audiobookshelf-sessions.service';
import { AUDIOBOOKSHELF_SESSION_OVERLAP_MS } from './audiobookshelf.constants';
import type { AbsListeningSession } from './audiobookshelf-client.service';
import type { AudiobookshelfUserSetting } from './schema/audiobookshelf.schema';

const mockRepo = {
  updateSettings: vi.fn(),
  ingestSessions: vi.fn(),
  findSyncableBookStatesByAbsItemIds: vi.fn(),
  findLibraryIdsByBookIds: vi.fn(),
  findAudioFilesInPlayOrderForBooks: vi.fn(),
};

const mockClient = {
  getListeningSessions: vi.fn(),
};

const mockAchievements = {
  emit: vi.fn(),
};

const mockLibraryService = {
  findAccessibleLibraryIds: vi.fn(),
};

function makeService() {
  return new AudiobookshelfSessionsService(mockRepo as any, mockClient as any, mockAchievements as any, mockLibraryService as any);
}

const user = { id: 1, isSuperuser: true, contentFilters: undefined, settings: { timezone: 'UTC' } } as any;

function makeSettings(overrides: Partial<AudiobookshelfUserSetting> = {}): AudiobookshelfUserSetting {
  return {
    id: 1,
    userId: 1,
    serverUrl: 'https://abs.example',
    apiToken: 'token',
    enabled: true,
    syncStatus: true,
    syncPosition: true,
    syncSessions: true,
    excludedLibraryIds: [],
    lastSyncedAt: null,
    lastSyncError: null,
    lastSessionWatermark: null,
    sessionBackfillCursorPage: null,
    sessionBackfillMaxUpdated: null,
    initialReconcileCompletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as AudiobookshelfUserSetting;
}

function makeSession(overrides: Partial<AbsListeningSession> = {}): AbsListeningSession {
  return {
    id: 's1',
    userId: 'abs-user',
    libraryId: null,
    libraryItemId: 'item-1',
    bookId: null,
    episodeId: null,
    mediaType: 'book',
    displayTitle: 'A Book',
    displayAuthor: 'An Author',
    duration: 3600,
    currentTime: 100,
    timeListening: 60,
    startedAt: 1_000_000,
    updatedAt: 1000,
    ...overrides,
  };
}

/** Returns a paginated client response envelope. */
function page(sessions: AbsListeningSession[], total: number) {
  return { total, numPages: Math.ceil(total / 2), page: 0, itemsPerPage: 2, sessions };
}

/** Wires the repo so a session's libraryItemId resolves to a linked book, letting ingestSessions run. */
function wireLinked() {
  mockRepo.findSyncableBookStatesByAbsItemIds.mockResolvedValue([{ absLibraryItemId: 'item-1', bookId: 100 } as any]);
  mockRepo.findLibraryIdsByBookIds.mockResolvedValue(new Map([[100, 1]]));
  mockRepo.findAudioFilesInPlayOrderForBooks.mockResolvedValue(new Map());
}

/** All updateSettings(userId, patch) patches, in call order. */
function settingsPatches(): any[] {
  return mockRepo.updateSettings.mock.calls.map((call) => call[1]);
}

describe('AudiobookshelfSessionsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLibraryService.findAccessibleLibraryIds.mockResolvedValue([1]);
    mockRepo.updateSettings.mockResolvedValue(undefined);
    mockRepo.findSyncableBookStatesByAbsItemIds.mockResolvedValue([]);
    mockRepo.findLibraryIdsByBookIds.mockResolvedValue(new Map());
    mockRepo.findAudioFilesInPlayOrderForBooks.mockResolvedValue(new Map());
    mockRepo.ingestSessions.mockResolvedValue({ insertedSessionIds: [], updated: 0, affectedSessionIds: [], progressDeltaBySessionId: new Map() });
  });

  describe('syncSessions - fresh (watermark 0) treated as backfill', () => {
    it('paginates fully, checkpoints per page, then promotes the watermark and clears the cursor', async () => {
      const settings = makeSettings({ lastSessionWatermark: null });
      mockClient.getListeningSessions
        .mockResolvedValueOnce(page([makeSession({ id: 'a', updatedAt: 1000 }), makeSession({ id: 'b', updatedAt: 2000 })], 3))
        .mockResolvedValueOnce(page([makeSession({ id: 'c', updatedAt: 3000 })], 3));

      await makeService().syncSessions(user, settings);

      // Both pages fetched (full pagination), page 0 then page 1.
      expect(mockClient.getListeningSessions).toHaveBeenCalledTimes(2);
      expect(mockClient.getListeningSessions).toHaveBeenNthCalledWith(1, 1, 'https://abs.example', 'token', 0, 2);
      expect(mockClient.getListeningSessions).toHaveBeenNthCalledWith(2, 1, 'https://abs.example', 'token', 1, 2);

      // Per-page checkpoint after each page commits, then a final promote+clear patch.
      const patches = settingsPatches();
      expect(patches[0]).toEqual({ sessionBackfillCursorPage: 1, sessionBackfillMaxUpdated: 2000 });
      expect(patches[1]).toEqual({ sessionBackfillCursorPage: 2, sessionBackfillMaxUpdated: 3000 });
      expect(patches[2]).toEqual({ lastSessionWatermark: 3000, sessionBackfillCursorPage: null, sessionBackfillMaxUpdated: null });
    });
  });

  describe('syncSessions - routine incremental (watermark set)', () => {
    it('stops at pageEntirelyOlderThan(floor) without paginating further and does not regress the watermark', async () => {
      const watermark = 500_000_000;
      const settings = makeSettings({ lastSessionWatermark: watermark });
      // Whole page predates (watermark - overlap): the incremental stop signal.
      const floor = watermark - AUDIOBOOKSHELF_SESSION_OVERLAP_MS;
      const old = floor - 1000;
      mockClient.getListeningSessions.mockResolvedValueOnce(
        page([makeSession({ id: 'a', updatedAt: old }), makeSession({ id: 'b', updatedAt: old })], 10),
      );

      const result = await makeService().syncSessions(user, settings);

      // Only the first page fetched, then stopped - no second page despite total=10.
      expect(mockClient.getListeningSessions).toHaveBeenCalledTimes(1);
      // No checkpoint and no watermark write: nothing newer than the existing watermark.
      expect(mockRepo.updateSettings).not.toHaveBeenCalled();
      expect(mockRepo.ingestSessions).not.toHaveBeenCalled();
      expect(result).toEqual({ inserted: 0, updated: 0 });
    });

    it('promotes the watermark forward when a page carries newer sessions', async () => {
      const watermark = 500_000_000;
      const settings = makeSettings({ lastSessionWatermark: watermark });
      mockClient.getListeningSessions.mockResolvedValueOnce(page([makeSession({ id: 'a', updatedAt: watermark + 5000 })], 1));

      await makeService().syncSessions(user, settings);

      // Not a backfill (watermark set), so only the promote patch, no cursor fields.
      expect(settingsPatches()).toEqual([{ lastSessionWatermark: watermark + 5000 }]);
    });
  });

  describe('syncSessions - resume from a pre-set cursor', () => {
    it('starts ingest from sessionBackfillCursorPage and seeds maxUpdated from the checkpoint', async () => {
      const settings = makeSettings({ lastSessionWatermark: 0, sessionBackfillCursorPage: 5, sessionBackfillMaxUpdated: 500 });
      mockClient.getListeningSessions.mockResolvedValueOnce(page([makeSession({ id: 'a', updatedAt: 600 })], 11));

      await makeService().syncSessions(user, settings);

      // First (and only) fetch resumes at page 5, not page 0.
      expect(mockClient.getListeningSessions).toHaveBeenNthCalledWith(1, 1, 'https://abs.example', 'token', 5, 2);
      const patches = settingsPatches();
      expect(patches[0]).toEqual({ sessionBackfillCursorPage: 6, sessionBackfillMaxUpdated: 600 });
      expect(patches[1]).toEqual({ lastSessionWatermark: 600, sessionBackfillCursorPage: null, sessionBackfillMaxUpdated: null });
    });
  });

  describe('syncSessions - idempotent re-ingest', () => {
    it('does not regress the watermark when a re-seen page inserts and updates nothing', async () => {
      const watermark = 500_000_000;
      const settings = makeSettings({ lastSessionWatermark: watermark });
      wireLinked();
      // Session at exactly the watermark: newer than the floor (so processed), not newer than the
      // watermark (so no promotion).
      mockClient.getListeningSessions.mockResolvedValueOnce(page([makeSession({ id: 's1', updatedAt: watermark })], 1));

      const result = await makeService().syncSessions(user, settings);

      expect(mockRepo.ingestSessions).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ inserted: 0, updated: 0 });
      // No watermark write at all - the existing value stands, no regression.
      expect(mockRepo.updateSettings).not.toHaveBeenCalled();
      expect(mockAchievements.emit).not.toHaveBeenCalled();
    });
  });

  describe('deepReconciliationScan - deep mode', () => {
    it('re-paginates fully with no early stop even when every session predates the watermark, and clears the cursor', async () => {
      const watermark = 500_000_000;
      const settings = makeSettings({ lastSessionWatermark: watermark });
      wireLinked();
      // These would trip the incremental stop, but deep uses a -Infinity floor and never early-stops.
      mockClient.getListeningSessions
        .mockResolvedValueOnce(page([makeSession({ id: 'a', updatedAt: 100 }), makeSession({ id: 'b', updatedAt: 100 })], 3))
        .mockResolvedValueOnce(page([makeSession({ id: 'c', updatedAt: 100 })], 3));

      const result = await makeService().deepReconciliationScan(user, settings);

      // Both pages fetched despite the old sessions: no early stop in deep mode.
      expect(mockClient.getListeningSessions).toHaveBeenCalledTimes(2);
      // Sessions are processed (not skipped by a stop), so ingest runs per page.
      expect(mockRepo.ingestSessions).toHaveBeenCalled();
      expect(result).toEqual({ inserted: 0, updated: 0 });

      // Deep is a backfill: per-page checkpoints, then a final clear. Watermark stays (nothing newer),
      // so the final patch carries no lastSessionWatermark key - only the cursor clear.
      const patches = settingsPatches();
      expect(patches[0]).toEqual({ sessionBackfillCursorPage: 1, sessionBackfillMaxUpdated: watermark });
      expect(patches[1]).toEqual({ sessionBackfillCursorPage: 2, sessionBackfillMaxUpdated: watermark });
      expect(patches[patches.length - 1]).toEqual({ sessionBackfillCursorPage: null, sessionBackfillMaxUpdated: null });
    });
  });

  describe('exclusions and skips', () => {
    it('skips sessions in excluded libraries and does not ingest them', async () => {
      const settings = makeSettings({ lastSessionWatermark: null, excludedLibraryIds: ['lib-x'] });
      wireLinked();
      mockClient.getListeningSessions.mockResolvedValueOnce(page([makeSession({ id: 'a', libraryId: 'lib-x', updatedAt: 1000 })], 1));

      await makeService().syncSessions(user, settings);

      expect(mockRepo.ingestSessions).not.toHaveBeenCalled();
      // Watermark still advances from the (excluded) session's updatedAt - it was observed.
      expect(settingsPatches().at(-1)).toEqual({ lastSessionWatermark: 1000, sessionBackfillCursorPage: null, sessionBackfillMaxUpdated: null });
    });

    it('breaks immediately on an empty first page and writes nothing', async () => {
      const settings = makeSettings({ lastSessionWatermark: 500_000_000 });
      mockClient.getListeningSessions.mockResolvedValueOnce(page([], 0));

      const result = await makeService().syncSessions(user, settings);

      expect(mockClient.getListeningSessions).toHaveBeenCalledTimes(1);
      expect(mockRepo.updateSettings).not.toHaveBeenCalled();
      expect(result).toEqual({ inserted: 0, updated: 0 });
    });

    it("passes the user's excludedLibraryIds through to the linked-row selection", async () => {
      const settings = makeSettings({ lastSessionWatermark: null, excludedLibraryIds: ['lib-graphicaudio'] });
      wireLinked();
      mockClient.getListeningSessions.mockResolvedValueOnce(page([makeSession({ id: 'a', updatedAt: 1000 })], 1));

      await makeService().syncSessions(user, settings);

      expect(mockRepo.findSyncableBookStatesByAbsItemIds).toHaveBeenCalledWith(user.id, expect.anything(), ['item-1'], ['lib-graphicaudio']);
    });
  });

  describe('achievements', () => {
    it('emits a per-session achievement event for a small number of inserts', async () => {
      const settings = makeSettings({ lastSessionWatermark: null });
      wireLinked();
      // A resolvable audio file so the mapped session carries a bookFileId (required to emit).
      mockRepo.findAudioFilesInPlayOrderForBooks.mockResolvedValue(new Map([[100, [{ id: 9, format: 'm4b', durationSeconds: 3600 }]]]));
      mockClient.getListeningSessions.mockResolvedValueOnce(page([makeSession({ id: 's1', updatedAt: 1000 })], 1));
      mockRepo.ingestSessions.mockResolvedValueOnce({
        insertedSessionIds: ['s1'],
        updated: 0,
        progressDeltaBySessionId: new Map([['s1', 5]]),
      });

      const result = await makeService().syncSessions(user, settings);

      expect(result.inserted).toBe(1);
      expect(mockAchievements.emit).toHaveBeenCalledTimes(1);
    });
  });

  describe('live-refresh progress event', () => {
    it('emits BOOK_PROGRESS_CHANGED for a book whose session changed this run', async () => {
      const settings = makeSettings({ lastSessionWatermark: null });
      wireLinked();
      // Resolvable audio file so the mapped session carries a bookFileId; currentTime/duration -> 50%.
      mockRepo.findAudioFilesInPlayOrderForBooks.mockResolvedValue(new Map([[100, [{ id: 9, format: 'm4b', durationSeconds: 3600 }]]]));
      mockClient.getListeningSessions.mockResolvedValueOnce(page([makeSession({ id: 's1', updatedAt: 1000, currentTime: 1800, duration: 3600 })], 1));
      mockRepo.ingestSessions.mockResolvedValueOnce({
        insertedSessionIds: ['s1'],
        updated: 0,
        affectedSessionIds: ['s1'],
        progressDeltaBySessionId: new Map(),
      });

      await makeService().syncSessions(user, settings);

      expect(mockAchievements.emit).toHaveBeenCalledWith(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, {
        userId: 1,
        bookId: 100,
        bookFileId: 9,
        progress: 50,
        source: 'audiobookshelf',
      });
    });

    it('emits BOOK_PROGRESS_CHANGED when a session was only updated (grown open session)', async () => {
      const settings = makeSettings({ lastSessionWatermark: 500_000_000 });
      wireLinked();
      mockClient.getListeningSessions.mockResolvedValueOnce(
        page([makeSession({ id: 's1', updatedAt: 500_000_000, currentTime: 1800, duration: 3600 })], 1),
      );
      // Nothing inserted, but the existing row was updated - the warm-tier case for an active listen.
      mockRepo.ingestSessions.mockResolvedValueOnce({
        insertedSessionIds: [],
        updated: 1,
        affectedSessionIds: ['s1'],
        progressDeltaBySessionId: new Map(),
      });

      await makeService().syncSessions(user, settings);

      expect(mockAchievements.emit).toHaveBeenCalledWith(
        ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED,
        expect.objectContaining({ userId: 1, bookId: 100, progress: 50, source: 'audiobookshelf' }),
      );
    });

    it('does not emit BOOK_PROGRESS_CHANGED on a no-op re-ingest (inserted:0/updated:0)', async () => {
      const settings = makeSettings({ lastSessionWatermark: 500_000_000 });
      wireLinked();
      mockClient.getListeningSessions.mockResolvedValueOnce(page([makeSession({ id: 's1', updatedAt: 500_000_000 })], 1));
      mockRepo.ingestSessions.mockResolvedValueOnce({
        insertedSessionIds: [],
        updated: 0,
        affectedSessionIds: [],
        progressDeltaBySessionId: new Map(),
      });

      await makeService().syncSessions(user, settings);

      expect(mockAchievements.emit).not.toHaveBeenCalledWith(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, expect.anything());
    });
  });

  describe('quiet mode (warm hot ticks)', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
      logSpy.mockRestore();
    });

    function sessionLines(): string[] {
      return logSpy.mock.calls.map(([message]) => String(message)).filter((message) => message.startsWith('[abs.sessions]'));
    }

    it('logs start and end by default', async () => {
      const settings = makeSettings({ lastSessionWatermark: 5000 });
      mockClient.getListeningSessions.mockResolvedValueOnce(page([], 0));

      await makeService().syncSessions(user, settings);

      expect(sessionLines()).toEqual([expect.stringContaining('[abs.sessions] [start]'), expect.stringContaining('[abs.sessions] [end]')]);
    });

    it('logs nothing when quiet and no session was inserted or updated', async () => {
      const settings = makeSettings({ lastSessionWatermark: 5000 });
      mockClient.getListeningSessions.mockResolvedValueOnce(page([], 0));

      await makeService().syncSessions(user, settings, { quiet: true });

      expect(sessionLines()).toEqual([]);
    });

    it('logs the end line when quiet and a session was inserted', async () => {
      const settings = makeSettings({ lastSessionWatermark: 5000 });
      wireLinked();
      mockClient.getListeningSessions.mockResolvedValueOnce(page([makeSession({ id: 'a', updatedAt: 6000 })], 1));
      mockRepo.ingestSessions.mockResolvedValueOnce({
        insertedSessionIds: ['a'],
        updated: 0,
        affectedSessionIds: ['a'],
        progressDeltaBySessionId: new Map(),
      });

      await makeService().syncSessions(user, settings, { quiet: true });

      expect(sessionLines()).toEqual([expect.stringContaining('[abs.sessions] [end]')]);
      expect(sessionLines()[0]).toContain('inserted=1');
    });
  });
});
