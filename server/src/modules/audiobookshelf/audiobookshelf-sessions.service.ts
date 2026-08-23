import { Injectable, Logger } from '@nestjs/common';
import { isAudioFormat } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { LibraryService } from '../library/library.service';
import {
  ACHIEVEMENT_EVENT_BACKFILL,
  ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED,
  ACHIEVEMENT_EVENT_READING_SESSION_SAVED,
  AchievementEventsService,
} from '../achievement/achievement-events.service';
import { chunk } from '../../common/utils/batch.utils';
import { AudiobookshelfClientService, type AbsListeningSession } from './audiobookshelf-client.service';
import { AudiobookshelfRepository, type AbsBookAccessScope } from './audiobookshelf.repository';
import type { AudiobookshelfUserSetting } from './schema/audiobookshelf.schema';
import {
  AUDIOBOOKSHELF_BACKFILL_EVENT_THRESHOLD,
  AUDIOBOOKSHELF_SESSION_OVERLAP_MS,
  AUDIOBOOKSHELF_SESSIONS_INGEST_CHUNK,
  AUDIOBOOKSHELF_SESSIONS_PAGE_SIZE,
} from './audiobookshelf.constants';
import { mapAbsSession, maxSessionUpdatedAt, pageEntirelyOlderThan, type AbsMappedSession } from './audiobookshelf-sessions.util';
import { buildBookAccessScope, describeError, resolveUserTimeZone } from './audiobookshelf-user.utils';

export interface AudiobookshelfSessionsResult {
  inserted: number;
  updated: number;
}

type SyncMode = 'incremental' | 'deep';

// An inserted row carrying the `progress_delta` the repository derived for it, which the mapper
// cannot know (it depends on the preceding session for the same book).
type IngestedSession = AbsMappedSession & { progressDelta: number | null };

interface IngestAccumulator {
  inserted: number;
  updated: number;
  skipped: number;
  // Capped sample of inserted rows, used to emit per-session achievement events below the backfill
  // threshold. Never grows past the threshold, so a years-long backfill stays memory-bounded.
  sampleInserted: IngestedSession[];
  // Books whose sessions were inserted or updated this run, to the latest such session's progress and
  // file. Drives one live-refresh event per changed book; empty on a pure no-op re-ingest. Bounded by
  // the number of distinct in-progress books in the run (tiny on the warm path).
  changedBooks: Map<number, { progress: number; bookFileId: number | null }>;
}

type SessionsSettingsPatch = Partial<
  Pick<AudiobookshelfUserSetting, 'lastSessionWatermark' | 'sessionBackfillCursorPage' | 'sessionBackfillMaxUpdated'>
>;

@Injectable()
export class AudiobookshelfSessionsService {
  private readonly logger = new Logger(AudiobookshelfSessionsService.name);

  constructor(
    private readonly repo: AudiobookshelfRepository,
    private readonly client: AudiobookshelfClientService,
    private readonly achievementEvents: AchievementEventsService,
    private readonly libraryService: LibraryService,
  ) {}

  /**
   * Incremental session sync: paginate newest-first and stop once a whole page predates the
   * watermark minus the overlap window, then advance the watermark. Called from the main pipeline.
   */
  async syncSessions(user: RequestUser, settings: AudiobookshelfUserSetting): Promise<AudiobookshelfSessionsResult> {
    return this.ingest(user, settings, 'incremental');
  }

  /**
   * Deep reconciliation scan: full re-pagination with no watermark stop condition. Required because
   * ABS preserves the client `updatedAt` for offline-synced sessions, so they can sort behind the
   * watermark and be missed by the incremental path. Exposed for ticket 06 (scheduled + "Full
   * resync"); this class does not schedule it.
   */
  async deepReconciliationScan(user: RequestUser, settings: AudiobookshelfUserSetting): Promise<AudiobookshelfSessionsResult> {
    return this.ingest(user, settings, 'deep');
  }

  private async ingest(user: RequestUser, settings: AudiobookshelfUserSetting, mode: SyncMode): Promise<AudiobookshelfSessionsResult> {
    const startedAt = Date.now();
    this.logger.log(`[abs.sessions] [start] userId=${user.id} mode=${mode} - session ingest started`);

    const timeZone = resolveUserTimeZone(user);
    const existingWatermark = settings.lastSessionWatermark ?? 0;
    const floor = mode === 'incremental' ? existingWatermark - AUDIOBOOKSHELF_SESSION_OVERLAP_MS : Number.NEGATIVE_INFINITY;
    // A deep scan and a first-ever sync both fully re-paginate years of history, so they checkpoint
    // per page and can resume after a late-page failure. A routine incremental sync stops at the
    // overlap floor and needs no checkpoint.
    const isBackfill = mode === 'deep' || existingWatermark === 0;

    const acc: IngestAccumulator = { inserted: 0, updated: 0, skipped: 0, sampleInserted: [], changedBooks: new Map() };
    const excludedLibraryIds = new Set(settings.excludedLibraryIds ?? []);
    const scope = await buildBookAccessScope(user, this.libraryService);
    let maxUpdated = existingWatermark;
    if (isBackfill && settings.sessionBackfillMaxUpdated != null && settings.sessionBackfillMaxUpdated > maxUpdated) {
      maxUpdated = settings.sessionBackfillMaxUpdated;
    }

    try {
      let page = isBackfill ? (settings.sessionBackfillCursorPage ?? 0) : 0;
      while (true) {
        const response = await this.client.getListeningSessions(
          user.id,
          settings.serverUrl,
          settings.apiToken,
          page,
          AUDIOBOOKSHELF_SESSIONS_PAGE_SIZE,
        );
        const sessions = response.sessions;
        if (sessions.length === 0) break;

        maxUpdated = maxSessionUpdatedAt(sessions, maxUpdated);

        // Incremental stops before processing a page that is wholly behind the overlap floor - those
        // sessions are already ingested. A deep scan uses -Infinity as the floor and never stops here.
        if (mode === 'incremental' && pageEntirelyOlderThan(sessions, floor)) break;

        const includedSessions = sessions.filter((session) => !session.libraryId || !excludedLibraryIds.has(session.libraryId));
        acc.skipped += sessions.length - includedSessions.length;
        await this.processPage(user.id, scope, timeZone, includedSessions, acc);

        // Checkpoint after the page's transactions commit: persist the next page to resume from and
        // the accumulated max updatedAt, without promoting the real watermark until the run completes.
        if (isBackfill) {
          await this.repo.updateSettings(user.id, { sessionBackfillCursorPage: page + 1, sessionBackfillMaxUpdated: maxUpdated });
        }

        const fetched = (page + 1) * AUDIOBOOKSHELF_SESSIONS_PAGE_SIZE;
        if (sessions.length < AUDIOBOOKSHELF_SESSIONS_PAGE_SIZE || fetched >= response.total) break;
        page++;
      }

      const patch: SessionsSettingsPatch = {};
      if (maxUpdated > existingWatermark) {
        patch.lastSessionWatermark = maxUpdated;
      }
      // Backfill completed: promote the accumulated watermark and clear the resume cursor so the next
      // run starts fresh from page 0.
      if (isBackfill) {
        patch.sessionBackfillCursorPage = null;
        patch.sessionBackfillMaxUpdated = null;
      }
      if (Object.keys(patch).length > 0) {
        await this.repo.updateSettings(user.id, patch);
      }

      this.emitAchievements(user, acc);
      this.emitProgressChanged(user, acc);

      this.logger.log(
        `[abs.sessions] [end] userId=${user.id} mode=${mode} durationMs=${Date.now() - startedAt} inserted=${acc.inserted} updated=${acc.updated} skipped=${acc.skipped} - session ingest completed`,
      );
      return { inserted: acc.inserted, updated: acc.updated };
    } catch (err) {
      const { errorClass, error } = describeError(err);
      this.logger.error(
        `[abs.sessions] [fail] userId=${user.id} mode=${mode} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${error}" - session ingest failed`,
      );
      throw err;
    }
  }

  private async processPage(
    userId: number,
    scope: AbsBookAccessScope,
    timeZone: string,
    sessions: AbsListeningSession[],
    acc: IngestAccumulator,
  ): Promise<void> {
    const itemIds = [...new Set(sessions.filter((session) => session.libraryItemId && !session.episodeId).map((session) => session.libraryItemId!))];
    const states = await this.repo.findSyncableBookStatesByAbsItemIds(userId, scope, itemIds);
    const stateByItem = new Map(states.map((state) => [state.absLibraryItemId, state]));

    // Per-page caches: resolve library ids and ordered audio files for every linked book in this page
    // with two batched queries. These maps are scoped to the page (not the whole run), so a multi-year
    // backfill never accumulates one entry per book across every page.
    const linkedBookIds = [...new Set(states.filter((state) => state.bookId != null).map((state) => state.bookId!))];
    const libraryIdByBook = await this.repo.findLibraryIdsByBookIds(linkedBookIds);
    const audioFilesByBook = await this.resolveAudioFiles(linkedBookIds);

    const mapped: AbsMappedSession[] = [];
    for (const session of sessions) {
      if (!session.libraryItemId || session.episodeId) {
        acc.skipped++;
        continue;
      }
      const state = stateByItem.get(session.libraryItemId);
      if (!state || state.bookId == null) {
        acc.skipped++;
        continue;
      }
      const libraryId = libraryIdByBook.get(state.bookId);
      if (libraryId == null) {
        acc.skipped++;
        continue;
      }
      const audioFiles = audioFilesByBook.get(state.bookId) ?? [];
      const row = mapAbsSession(session, { bookId: state.bookId, libraryId, audioFiles });
      if (!row) {
        acc.skipped++;
        continue;
      }
      mapped.push(row);
    }

    for (const group of chunk(mapped, AUDIOBOOKSHELF_SESSIONS_INGEST_CHUNK)) {
      const { insertedSessionIds, updated, affectedSessionIds, progressDeltaBySessionId } = await this.repo.ingestSessions(userId, timeZone, group);
      const insertedSet = new Set(insertedSessionIds);
      const affectedSet = new Set(affectedSessionIds);
      acc.inserted += insertedSessionIds.length;
      acc.updated += updated;
      for (const row of group) {
        if (insertedSet.has(row.sessionId) && acc.sampleInserted.length <= AUDIOBOOKSHELF_BACKFILL_EVENT_THRESHOLD) {
          acc.sampleInserted.push({ ...row, progressDelta: progressDeltaBySessionId.get(row.sessionId) ?? null });
        }
        // Pages arrive newest-first, so the first affected session seen for a book carries its latest
        // progress; keep that one for the live-refresh event.
        if (affectedSet.has(row.sessionId) && !acc.changedBooks.has(row.bookId)) {
          acc.changedBooks.set(row.bookId, { progress: row.endProgress ?? 0, bookFileId: row.bookFileId });
        }
      }
    }
  }

  private async resolveAudioFiles(bookIds: number[]): Promise<Map<number, { id: number; durationSeconds: number | null }[]>> {
    const byBook = await this.repo.findAudioFilesInPlayOrderForBooks(bookIds);
    const filtered = new Map<number, { id: number; durationSeconds: number | null }[]>();
    for (const [bookId, files] of byBook) {
      filtered.set(
        bookId,
        files.filter((file) => file.format && isAudioFormat(file.format)).map((file) => ({ id: file.id, durationSeconds: file.durationSeconds })),
      );
    }
    return filtered;
  }

  private emitAchievements(user: RequestUser, acc: IngestAccumulator): void {
    if (acc.inserted === 0) return;

    if (acc.inserted > AUDIOBOOKSHELF_BACKFILL_EVENT_THRESHOLD) {
      this.achievementEvents.emit(ACHIEVEMENT_EVENT_BACKFILL, { userId: user.id });
      return;
    }

    const timezone = resolveUserTimeZone(user);
    for (const session of acc.sampleInserted) {
      if (session.bookFileId == null) continue;
      this.achievementEvents.emit(ACHIEVEMENT_EVENT_READING_SESSION_SAVED, {
        userId: user.id,
        bookFileId: session.bookFileId,
        durationSeconds: session.durationSeconds,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        progressDelta: session.progressDelta,
        endProgress: session.endProgress,
        timezone,
      });
    }
  }

  // One live-refresh event per book whose sessions actually changed this run, so a client viewing that
  // book reloads its reading log. Never fires on a no-op re-ingest (changedBooks stays empty).
  private emitProgressChanged(user: RequestUser, acc: IngestAccumulator): void {
    for (const [bookId, changed] of acc.changedBooks) {
      this.achievementEvents.emit(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, {
        userId: user.id,
        bookId,
        ...(changed.bookFileId != null ? { bookFileId: changed.bookFileId } : {}),
        progress: changed.progress,
        source: 'audiobookshelf',
      });
    }
  }
}
