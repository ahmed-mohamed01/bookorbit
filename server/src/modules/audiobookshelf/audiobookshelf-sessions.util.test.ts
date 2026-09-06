import { describe, it, expect } from 'vitest';

import type { AbsListeningSession } from './audiobookshelf-client.service';
import { mapAbsSession, maxSessionUpdatedAt, pageEntirelyOlderThan, type AbsSessionMapContext } from './audiobookshelf-sessions.util';

function makeSession(overrides: Partial<AbsListeningSession> = {}): AbsListeningSession {
  return {
    id: 'sess-1',
    userId: 'user-1',
    libraryId: 'lib-abs',
    libraryItemId: 'item-1',
    bookId: 'abs-book-1',
    episodeId: null,
    mediaType: 'book',
    displayTitle: 'A Book',
    displayAuthor: 'An Author',
    duration: 3600,
    currentTime: 1800,
    timeListening: 600,
    startedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_600_000,
    ...overrides,
  };
}

const ctx: AbsSessionMapContext = {
  bookId: 77,
  libraryId: 5,
  audioFiles: [
    { id: 10, durationSeconds: 1000 },
    { id: 11, durationSeconds: 2000 },
  ],
};

describe('mapAbsSession', () => {
  it('returns null for a podcast episode session', () => {
    expect(mapAbsSession(makeSession({ episodeId: 'ep-1' }), ctx)).toBeNull();
  });

  it('returns null for zero or negative timeListening', () => {
    expect(mapAbsSession(makeSession({ timeListening: 0 }), ctx)).toBeNull();
    expect(mapAbsSession(makeSession({ timeListening: -5 }), ctx)).toBeNull();
  });

  it('returns null for a non-finite startedAt', () => {
    expect(mapAbsSession(makeSession({ startedAt: NaN }), ctx)).toBeNull();
    expect(mapAbsSession(makeSession({ startedAt: Infinity }), ctx)).toBeNull();
  });

  it('rounds timeListening and reports it as durationSeconds', () => {
    const result = mapAbsSession(makeSession({ timeListening: 59.6 }), ctx);
    expect(result?.durationSeconds).toBe(60);
  });

  it('caps endedAt at startedAt + timeListening*1000 (paused wall-clock never smears)', () => {
    const startedAt = 1_700_000_000_000;
    // updatedAt is hours later, but endedAt must track listening time only, not wall-clock.
    const session = makeSession({ startedAt, timeListening: 600, updatedAt: startedAt + 10 * 3600 * 1000 });
    const result = mapAbsSession(session, ctx);
    expect(result?.startedAt.getTime()).toBe(startedAt);
    expect(result?.endedAt.getTime()).toBe(startedAt + 600 * 1000);
  });

  it('computes endProgress from currentTime/duration', () => {
    const result = mapAbsSession(makeSession({ currentTime: 1800, duration: 3600 }), ctx);
    expect(result?.endProgress).toBe(50);
  });

  it('clamps endProgress to a maximum of 100 when currentTime exceeds duration', () => {
    const result = mapAbsSession(makeSession({ currentTime: 5000, duration: 3600 }), ctx);
    expect(result?.endProgress).toBe(100);
  });

  it('yields a null endProgress when duration is zero or non-positive', () => {
    expect(mapAbsSession(makeSession({ duration: 0 }), ctx)?.endProgress).toBeNull();
  });

  it('does not populate progressDelta (repo-owned, derived after upsert)', () => {
    const result = mapAbsSession(makeSession(), ctx);
    expect(result).not.toBeNull();
    expect('progressDelta' in (result as object)).toBe(false);
  });

  it('resolves bookFileId from the passed audio files context', () => {
    // currentTime 500s falls inside the first file (0-1000s)
    const first = mapAbsSession(makeSession({ currentTime: 500 }), ctx);
    expect(first?.bookFileId).toBe(10);
    // currentTime 1500s falls inside the second file (1000-3000s)
    const second = mapAbsSession(makeSession({ currentTime: 1500 }), ctx);
    expect(second?.bookFileId).toBe(11);
  });

  it('resolves bookFileId to null when no audio files are known', () => {
    const result = mapAbsSession(makeSession(), { ...ctx, audioFiles: [] });
    expect(result?.bookFileId).toBeNull();
  });

  it('carries the context bookId and libraryId through', () => {
    const result = mapAbsSession(makeSession({ id: 'the-session' }), ctx);
    expect(result?.sessionId).toBe('the-session');
    expect(result?.bookId).toBe(77);
    expect(result?.libraryId).toBe(5);
  });
});

describe('pageEntirelyOlderThan', () => {
  it('returns false for an empty page (ran off the end, not "older")', () => {
    expect(pageEntirelyOlderThan([], 1000)).toBe(false);
  });

  it('returns true when every session predates the floor', () => {
    const page = [makeSession({ updatedAt: 100 }), makeSession({ updatedAt: 200 })];
    expect(pageEntirelyOlderThan(page, 1000)).toBe(true);
  });

  it('returns false when at least one session is at or after the floor', () => {
    const page = [makeSession({ updatedAt: 100 }), makeSession({ updatedAt: 1500 })];
    expect(pageEntirelyOlderThan(page, 1000)).toBe(false);
  });
});

describe('maxSessionUpdatedAt', () => {
  it('returns the max updatedAt across the page', () => {
    const page = [makeSession({ updatedAt: 300 }), makeSession({ updatedAt: 900 }), makeSession({ updatedAt: 500 })];
    expect(maxSessionUpdatedAt(page, 0)).toBe(900);
  });

  it('never drops below the provided current watermark', () => {
    const page = [makeSession({ updatedAt: 100 })];
    expect(maxSessionUpdatedAt(page, 500)).toBe(500);
  });

  it('ignores non-finite updatedAt values', () => {
    const page = [makeSession({ updatedAt: NaN }), makeSession({ updatedAt: 400 })];
    expect(maxSessionUpdatedAt(page, 0)).toBe(400);
  });
});
