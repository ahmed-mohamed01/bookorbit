import { describe, expect, it } from 'vitest';

import type { AbsListeningSession } from './audiobookshelf-client.service';
import { chunkSessions, mapAbsSession, maxSessionUpdatedAt, pageEntirelyOlderThan } from './audiobookshelf-sessions.util';

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
    startedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_600_000,
    ...overrides,
  };
}

const files = [
  { id: 10, durationSeconds: 1000 },
  { id: 11, durationSeconds: 3000 },
];

describe('mapAbsSession', () => {
  it('caps endedAt at startedAt + timeListening and mirrors durationSeconds', () => {
    const row = mapAbsSession(makeSession({ startedAt: 1_000_000, timeListening: 600 }), { bookId: 5, libraryId: 2, audioFiles: files });
    expect(row).not.toBeNull();
    expect(row!.startedAt).toEqual(new Date(1_000_000));
    expect(row!.endedAt).toEqual(new Date(1_000_000 + 600_000));
    expect(row!.durationSeconds).toBe(600);
    expect(row!.progressDelta).toBeNull();
  });

  it('computes endProgress from currentTime/duration and resolves the book file', () => {
    const row = mapAbsSession(makeSession({ currentTime: 1800, duration: 3600 }), { bookId: 5, libraryId: 2, audioFiles: files });
    expect(row!.endProgress).toBe(50);
    // 1800s lands inside the second file (first file is 1000s long).
    expect(row!.bookFileId).toBe(11);
  });

  it('leaves endProgress null and bookFileId null when duration is zero and no files exist', () => {
    const row = mapAbsSession(makeSession({ duration: 0 }), { bookId: 5, libraryId: 2, audioFiles: [] });
    expect(row!.endProgress).toBeNull();
    expect(row!.bookFileId).toBeNull();
  });

  it('clamps endProgress to 100 when currentTime exceeds duration', () => {
    const row = mapAbsSession(makeSession({ currentTime: 5000, duration: 3600 }), { bookId: 5, libraryId: 2, audioFiles: files });
    expect(row!.endProgress).toBe(100);
  });

  it('skips episodes and zero/negative timeListening sessions', () => {
    expect(mapAbsSession(makeSession({ episodeId: 'ep-1' }), { bookId: 5, libraryId: 2, audioFiles: files })).toBeNull();
    expect(mapAbsSession(makeSession({ timeListening: 0 }), { bookId: 5, libraryId: 2, audioFiles: files })).toBeNull();
    expect(mapAbsSession(makeSession({ timeListening: -10 }), { bookId: 5, libraryId: 2, audioFiles: files })).toBeNull();
  });

  it('grows the row (duration + endedAt) when ABS re-reports the session with more timeListening', () => {
    const base = makeSession({ id: 'sess-x', startedAt: 2_000_000, timeListening: 300 });
    const grown = makeSession({ id: 'sess-x', startedAt: 2_000_000, timeListening: 900 });
    const first = mapAbsSession(base, { bookId: 5, libraryId: 2, audioFiles: files })!;
    const second = mapAbsSession(grown, { bookId: 5, libraryId: 2, audioFiles: files })!;
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.durationSeconds).toBeGreaterThan(first.durationSeconds);
    expect(second.endedAt.getTime()).toBeGreaterThan(first.endedAt.getTime());
  });
});

describe('pageEntirelyOlderThan', () => {
  it('is false for an empty page (end of list, not "older")', () => {
    expect(pageEntirelyOlderThan([], 1000)).toBe(false);
  });

  it('is true only when every session predates the floor', () => {
    const page = [makeSession({ updatedAt: 500 }), makeSession({ updatedAt: 900 })];
    expect(pageEntirelyOlderThan(page, 1000)).toBe(true);
    expect(pageEntirelyOlderThan([...page, makeSession({ updatedAt: 1500 })], 1000)).toBe(false);
  });
});

describe('maxSessionUpdatedAt', () => {
  it('returns the greatest updatedAt including the running baseline', () => {
    const page = [makeSession({ updatedAt: 500 }), makeSession({ updatedAt: 3000 })];
    expect(maxSessionUpdatedAt(page, 1000)).toBe(3000);
    expect(maxSessionUpdatedAt(page, 5000)).toBe(5000);
  });
});

describe('chunkSessions', () => {
  it('splits into bounded chunks', () => {
    expect(chunkSessions([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkSessions([], 2)).toEqual([]);
  });
});
