import { Injectable, Logger } from '@nestjs/common';
import { isAudioFormat, type UserSettings } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { resolveTimeZone } from '../../common/utils/timezone.utils';
import { BookService } from '../book/book.service';
import { LibraryService } from '../library/library.service';
import {
  ACHIEVEMENT_EVENT_BACKFILL,
  ACHIEVEMENT_EVENT_READING_SESSION_SAVED,
  AchievementEventsService,
} from '../achievement/achievement-events.service';
import type { AudiobookshelfUserSetting } from '../../db/schema';
import { AudiobookshelfClientService, type AbsListeningSession } from './audiobookshelf-client.service';
import { AudiobookshelfRepository, type AbsBookAccessScope } from './audiobookshelf.repository';
import {
  AUDIOBOOKSHELF_BACKFILL_EVENT_THRESHOLD,
  AUDIOBOOKSHELF_SESSION_OVERLAP_MS,
  AUDIOBOOKSHELF_SESSIONS_INGEST_CHUNK,
  AUDIOBOOKSHELF_SESSIONS_PAGE_SIZE,
} from './audiobookshelf.constants';
import { chunkSessions, mapAbsSession, maxSessionUpdatedAt, pageEntirelyOlderThan, type AbsMappedSession } from './audiobookshelf-sessions.util';

export interface AudiobookshelfSessionsResult {
  inserted: number;
  updated: number;
  skipped: number;
  watermark: number | null;
}

type SyncMode = 'incremental' | 'deep';

interface IngestAccumulator {
  inserted: number;
  updated: number;
  skipped: number;
  // Capped sample of inserted rows, used to emit per-session achievement events below the backfill
  // threshold. Never grows past the threshold, so a years-long backfill stays memory-bounded.
  sampleInserted: AbsMappedSession[];
}

interface ResolveCaches {
  libraryIdByBook: Map<number, number>;
  audioFilesByBook: Map<number, { id: number; durationSeconds: number | null }[]>;
}

@Injectable()
export class AudiobookshelfSessionsService {
  private readonly logger = new Logger(AudiobookshelfSessionsService.name);

  constructor(
    private readonly repo: AudiobookshelfRepository,
    private readonly client: AudiobookshelfClientService,
    private readonly bookService: BookService,
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

    const timeZone = resolveTimeZone((user.settings as unknown as UserSettings | undefined)?.timezone, 'UTC');
    const existingWatermark = settings.lastSessionWatermark ?? 0;
    const floor = mode === 'incremental' ? existingWatermark - AUDIOBOOKSHELF_SESSION_OVERLAP_MS : Number.NEGATIVE_INFINITY;

    const acc: IngestAccumulator = { inserted: 0, updated: 0, skipped: 0, sampleInserted: [] };
    const caches: ResolveCaches = { libraryIdByBook: new Map(), audioFilesByBook: new Map() };
    const excludedLibraryIds = new Set(settings.excludedLibraryIds ?? []);
    const scope = {
      libraryIds: await this.libraryService.findAccessibleLibraryIds(user),
      contentFilters: user.isSuperuser ? undefined : user.contentFilters,
    };
    let maxUpdated = existingWatermark;

    try {
      let page = 0;
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
        await this.processPage(user.id, scope, timeZone, includedSessions, caches, acc);

        const fetched = (page + 1) * AUDIOBOOKSHELF_SESSIONS_PAGE_SIZE;
        if (sessions.length < AUDIOBOOKSHELF_SESSIONS_PAGE_SIZE || fetched >= response.total) break;
        page++;
      }

      let watermark: number | null = settings.lastSessionWatermark ?? null;
      if (maxUpdated > existingWatermark) {
        await this.repo.updateSettings(user.id, { lastSessionWatermark: maxUpdated });
        watermark = maxUpdated;
      }

      this.emitAchievements(user, acc);

      this.logger.log(
        `[abs.sessions] [end] userId=${user.id} mode=${mode} durationMs=${Date.now() - startedAt} inserted=${acc.inserted} updated=${acc.updated} skipped=${acc.skipped} - session ingest completed`,
      );
      return { inserted: acc.inserted, updated: acc.updated, skipped: acc.skipped, watermark };
    } catch (err) {
      const errorClass = err instanceof Error ? err.constructor.name : 'Error';
      const error = sanitizeLogValue(err instanceof Error ? err.message : String(err));
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
    caches: ResolveCaches,
    acc: IngestAccumulator,
  ): Promise<void> {
    const itemIds = [...new Set(sessions.filter((session) => session.libraryItemId && !session.episodeId).map((session) => session.libraryItemId!))];
    const states = await this.repo.findSyncableBookStatesByAbsItemIds(userId, scope, itemIds);
    const stateByItem = new Map(states.map((state) => [state.absLibraryItemId, state]));

    const linkedBookIds = states.filter((state) => state.bookId != null).map((state) => state.bookId!);
    const missingLibraryBookIds = linkedBookIds.filter((bookId) => !caches.libraryIdByBook.has(bookId));
    if (missingLibraryBookIds.length > 0) {
      const resolved = await this.repo.findLibraryIdsByBookIds(missingLibraryBookIds);
      for (const [bookId, libraryId] of resolved) caches.libraryIdByBook.set(bookId, libraryId);
    }

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
      const libraryId = caches.libraryIdByBook.get(state.bookId);
      if (libraryId == null) {
        acc.skipped++;
        continue;
      }
      const audioFiles = await this.resolveAudioFiles(state.bookId, caches);
      const row = mapAbsSession(session, { bookId: state.bookId, libraryId, audioFiles });
      if (!row) {
        acc.skipped++;
        continue;
      }
      mapped.push(row);
    }

    for (const group of chunkSessions(mapped, AUDIOBOOKSHELF_SESSIONS_INGEST_CHUNK)) {
      const { insertedSessionIds, updated } = await this.repo.ingestSessions(userId, timeZone, group);
      const insertedSet = new Set(insertedSessionIds);
      acc.inserted += insertedSessionIds.length;
      acc.updated += updated;
      for (const row of group) {
        if (insertedSet.has(row.sessionId) && acc.sampleInserted.length <= AUDIOBOOKSHELF_BACKFILL_EVENT_THRESHOLD) {
          acc.sampleInserted.push(row);
        }
      }
    }
  }

  private async resolveAudioFiles(bookId: number, caches: ResolveCaches): Promise<{ id: number; durationSeconds: number | null }[]> {
    const cached = caches.audioFilesByBook.get(bookId);
    if (cached) return cached;
    const files = (await this.bookService.getAudioFilesInPlayOrder(bookId))
      .filter((file) => file.format && isAudioFormat(file.format))
      .map((file) => ({ id: file.id, durationSeconds: file.durationSeconds }));
    caches.audioFilesByBook.set(bookId, files);
    return files;
  }

  private emitAchievements(user: RequestUser, acc: IngestAccumulator): void {
    if (acc.inserted === 0) return;

    if (acc.inserted > AUDIOBOOKSHELF_BACKFILL_EVENT_THRESHOLD) {
      this.achievementEvents.emit(ACHIEVEMENT_EVENT_BACKFILL, { userId: user.id });
      return;
    }

    const timezone = resolveTimeZone((user.settings as unknown as UserSettings | undefined)?.timezone, 'UTC');
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
}
