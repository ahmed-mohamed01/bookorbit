import { describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import { ACHIEVEMENT_EVENT_BACKFILL, ACHIEVEMENT_EVENT_READING_SESSION_SAVED } from '../achievement/achievement-events.service';
import type { AbsListeningSession } from './audiobookshelf-client.service';
import { AudiobookshelfSessionsService } from './audiobookshelf-sessions.service';
import type { AbsMappedSession } from './audiobookshelf-sessions.util';

const WATERMARK = 1_700_000_000_000;
const OVERLAP_MS = 24 * 60 * 60 * 1000;
const FLOOR = WATERMARK - OVERLAP_MS;

function makeUser(overrides: Partial<RequestUser> = {}): RequestUser {
  return { id: 7, isSuperuser: false, settings: {}, ...overrides } as unknown as RequestUser;
}

function makeSession(overrides: Partial<AbsListeningSession> = {}): AbsListeningSession {
  return {
    id: 'sess-1',
    userId: 'abs-user',
    libraryId: 'abs-lib',
    libraryItemId: 'abs-item-1',
    bookId: 'abs-book-1',
    episodeId: null,
    mediaType: 'book',
    displayTitle: 'A Title',
    displayAuthor: 'An Author',
    duration: 3600,
    currentTime: 1800,
    timeListening: 600,
    startedAt: 1_699_000_000_000,
    updatedAt: WATERMARK + 1000,
    ...overrides,
  };
}

function makeDeps() {
  const repo = {
    findBookStatesByAbsItemIds: vi.fn((_userId: number, ids: string[]) =>
      Promise.resolve(ids.map((id) => ({ absLibraryItemId: id, bookId: 100, needsReview: false, syncExcluded: false, matchError: null }))),
    ),
    findLibraryIdsByBookIds: vi.fn((ids: number[]) => Promise.resolve(new Map(ids.map((id) => [id, 1])))),
    ingestSessions: vi.fn((_userId: number, _tz: string, sessions: AbsMappedSession[]) =>
      Promise.resolve({ insertedSessionIds: sessions.map((s) => s.sessionId), updated: 0 }),
    ),
    upsertSettings: vi.fn().mockResolvedValue(undefined),
  };
  const client = { getListeningSessions: vi.fn() };
  const bookService = { getAudioFilesInPlayOrder: vi.fn().mockResolvedValue([{ id: 10, format: 'mp3', durationSeconds: 100_000 }]) };
  const achievementEvents = { emit: vi.fn() };
  const service = new AudiobookshelfSessionsService(repo as never, client as never, bookService as never, achievementEvents as never);
  return { service, repo, client, bookService, achievementEvents };
}

function settings(overrides: Record<string, unknown> = {}) {
  return { userId: 7, serverUrl: 'http://abs.local', apiToken: 'token', lastSessionWatermark: null, ...overrides } as never;
}

function ingestedSessionIds(repo: ReturnType<typeof makeDeps>['repo']): string[] {
  return repo.ingestSessions.mock.calls.flatMap((call) => (call[2] as AbsMappedSession[]).map((s) => s.sessionId));
}

describe('AudiobookshelfSessionsService', () => {
  it('ingests a page and advances the watermark to the max updatedAt seen', async () => {
    const { service, repo, client } = makeDeps();
    client.getListeningSessions.mockResolvedValue({
      total: 2,
      sessions: [makeSession({ id: 's1', updatedAt: WATERMARK + 5000 }), makeSession({ id: 's2', updatedAt: WATERMARK + 4000 })],
    });

    const result = await service.syncSessions(makeUser(), settings());

    expect(result).toMatchObject({ inserted: 2, updated: 0, watermark: WATERMARK + 5000 });
    expect(repo.ingestSessions).toHaveBeenCalledTimes(1);
    expect(repo.upsertSettings).toHaveBeenCalledWith(7, { lastSessionWatermark: WATERMARK + 5000 });
  });

  it('stops incrementally when a whole page predates the watermark minus overlap, without ingesting', async () => {
    const { service, repo, client } = makeDeps();
    client.getListeningSessions.mockResolvedValue({
      total: 2,
      sessions: [makeSession({ id: 'old1', updatedAt: FLOOR - 10_000 }), makeSession({ id: 'old2', updatedAt: FLOOR - 20_000 })],
    });

    const result = await service.syncSessions(makeUser(), settings({ lastSessionWatermark: WATERMARK }));

    expect(result.inserted).toBe(0);
    expect(repo.ingestSessions).not.toHaveBeenCalled();
    expect(repo.upsertSettings).not.toHaveBeenCalled();
  });

  it('re-captures a mutated session that sits behind the watermark but inside the overlap window', async () => {
    const { service, repo, client } = makeDeps();
    // updatedAt < watermark (so it "sorts behind" and cannot advance the watermark) but > floor.
    const mutated = makeSession({ id: 'mutated', updatedAt: WATERMARK - 1000, timeListening: 1200 });
    client.getListeningSessions.mockResolvedValue({ total: 1, sessions: [mutated] });

    const result = await service.syncSessions(makeUser(), settings({ lastSessionWatermark: WATERMARK }));

    expect(result.inserted).toBe(1);
    expect(ingestedSessionIds(repo)).toContain('mutated');
  });

  it('documents why an offline stale-updatedAt session is missed by incremental but caught by the deep scan', async () => {
    // Page 0: a full page of recent sessions. Page 1: a single offline session whose CLIENT updatedAt
    // is days behind the watermark, so it sorts deep in history behind page 0.
    const page0 = Array.from({ length: 500 }, (_, i) => makeSession({ id: `recent-${i}`, updatedAt: WATERMARK + 1000 + i }));
    const offline = makeSession({ id: 'offline', updatedAt: FLOOR - 5 * OVERLAP_MS });

    const incremental = makeDeps();
    incremental.client.getListeningSessions.mockImplementation((_u, _s, _t, page: number) =>
      Promise.resolve(page === 0 ? { total: 501, sessions: page0 } : { total: 501, sessions: [offline] }),
    );
    await incremental.service.syncSessions(makeUser(), settings({ lastSessionWatermark: WATERMARK }));
    // Incremental stops at page 1 (entirely older than the floor) before ingesting the offline session.
    expect(ingestedSessionIds(incremental.repo)).not.toContain('offline');

    const deep = makeDeps();
    deep.client.getListeningSessions.mockImplementation((_u, _s, _t, page: number) =>
      Promise.resolve(page === 0 ? { total: 501, sessions: page0 } : { total: 501, sessions: [offline] }),
    );
    await deep.service.deepReconciliationScan(makeUser(), settings({ lastSessionWatermark: WATERMARK }));
    // The deep scan has no watermark stop, so it re-paginates fully and ingests the offline session.
    expect(ingestedSessionIds(deep.repo)).toContain('offline');
  });

  it('ingests a large batch in bounded chunks rather than one unbounded transaction', async () => {
    const { service, repo, client } = makeDeps();
    const sessions = Array.from({ length: 450 }, (_, i) => makeSession({ id: `s-${i}`, updatedAt: WATERMARK + 1000 + i }));
    client.getListeningSessions.mockResolvedValue({ total: 450, sessions });

    const result = await service.syncSessions(makeUser(), settings());

    expect(result.inserted).toBe(450);
    // 450 rows at an ingest chunk of 200 -> 200 + 200 + 50, three bounded transactions.
    expect(repo.ingestSessions).toHaveBeenCalledTimes(3);
    for (const call of repo.ingestSessions.mock.calls) {
      expect((call[2] as AbsMappedSession[]).length).toBeLessThanOrEqual(200);
    }
  });

  it('emits per-session achievement events below the backfill threshold', async () => {
    const { service, client, achievementEvents } = makeDeps();
    client.getListeningSessions.mockResolvedValue({
      total: 3,
      sessions: [makeSession({ id: 'a' }), makeSession({ id: 'b' }), makeSession({ id: 'c' })],
    });

    await service.syncSessions(makeUser(), settings());

    const events = achievementEvents.emit.mock.calls.map((call) => call[0]);
    expect(events.filter((e) => e === ACHIEVEMENT_EVENT_READING_SESSION_SAVED)).toHaveLength(3);
    expect(events).not.toContain(ACHIEVEMENT_EVENT_BACKFILL);
  });

  it('emits a single backfill achievement event above the threshold', async () => {
    const { service, client, achievementEvents } = makeDeps();
    const sessions = Array.from({ length: 25 }, (_, i) => makeSession({ id: `s-${i}`, updatedAt: WATERMARK + 1000 + i }));
    client.getListeningSessions.mockResolvedValue({ total: 25, sessions });

    await service.syncSessions(makeUser(), settings());

    const events = achievementEvents.emit.mock.calls.map((call) => call[0]);
    expect(events.filter((e) => e === ACHIEVEMENT_EVENT_BACKFILL)).toHaveLength(1);
    expect(events).not.toContain(ACHIEVEMENT_EVENT_READING_SESSION_SAVED);
  });

  it('skips sessions for unlinked, needs-review, excluded, or errored items', async () => {
    const { service, repo, client } = makeDeps();
    repo.findBookStatesByAbsItemIds.mockResolvedValue([
      { absLibraryItemId: 'abs-item-1', bookId: null, needsReview: false, syncExcluded: false, matchError: null },
    ]);
    client.getListeningSessions.mockResolvedValue({ total: 1, sessions: [makeSession({ libraryItemId: 'abs-item-1' })] });

    const result = await service.syncSessions(makeUser(), settings());

    expect(result).toMatchObject({ inserted: 0, updated: 0, skipped: 1 });
    expect(repo.ingestSessions).not.toHaveBeenCalled();
  });
});
