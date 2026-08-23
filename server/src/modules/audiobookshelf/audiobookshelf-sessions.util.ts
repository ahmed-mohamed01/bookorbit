import { resolveAbsPosition } from './audiobookshelf-sync.service';
import type { AbsListeningSession } from './audiobookshelf-client.service';

// One listening session mapped to the shape a `reading_sessions` row needs. `libraryId` is the
// BookOrbit library of the linked book (NOT the ABS `libraryId`), used to group daily-stats recompute.
// `progressDelta` is absent by design: ABS reports absolute position only, so the delta is derived
// from the stored per-book session history after the upsert (see `AudiobookshelfRepository`).
export interface AbsMappedSession {
  sessionId: string;
  bookId: number;
  bookFileId: number | null;
  libraryId: number;
  startedAt: Date;
  endedAt: Date;
  durationSeconds: number;
  endProgress: number | null;
}

export interface AbsSessionMapContext {
  bookId: number;
  libraryId: number;
  audioFiles: { id: number; durationSeconds: number | null }[];
}

// Maps an ABS session to a `reading_sessions` row, or null when it should be skipped.
// endedAt is CAPPED at startedAt + timeListening so paused wall-clock hours never smear into daily
// stats. Skips episodes (podcasts) and zero-timeListening sessions.
export function mapAbsSession(session: AbsListeningSession, ctx: AbsSessionMapContext): AbsMappedSession | null {
  if (session.episodeId) return null;
  const timeListening = Math.round(session.timeListening);
  if (!Number.isFinite(timeListening) || timeListening <= 0) return null;
  if (!Number.isFinite(session.startedAt)) return null;

  const startedAt = new Date(session.startedAt);
  const endedAt = new Date(session.startedAt + timeListening * 1000);

  let endProgress: number | null = null;
  if (Number.isFinite(session.duration) && session.duration > 0 && Number.isFinite(session.currentTime)) {
    endProgress = Math.max(0, Math.min(100, (session.currentTime / session.duration) * 100));
  }

  const resolved = resolveAbsPosition(ctx.audioFiles, session.currentTime);

  return {
    sessionId: session.id,
    bookId: ctx.bookId,
    bookFileId: resolved?.currentFileId ?? null,
    libraryId: ctx.libraryId,
    startedAt,
    endedAt,
    durationSeconds: timeListening,
    endProgress,
  };
}

// True when every session in the page is older than the floor. Sessions arrive newest-first, so this
// is the incremental stop signal: once a whole page predates (watermark - overlap), older pages hold
// nothing new. An empty page is not "older" - it just means we ran off the end.
export function pageEntirelyOlderThan(sessions: AbsListeningSession[], floorMs: number): boolean {
  if (sessions.length === 0) return false;
  return sessions.every((session) => session.updatedAt < floorMs);
}

export function maxSessionUpdatedAt(sessions: AbsListeningSession[], current: number): number {
  let max = current;
  for (const session of sessions) {
    if (Number.isFinite(session.updatedAt) && session.updatedAt > max) max = session.updatedAt;
  }
  return max;
}
