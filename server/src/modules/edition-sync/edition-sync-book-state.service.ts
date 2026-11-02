import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type {
  EditionSyncBookState,
  EditionSyncIndexState,
  EditionSyncRetryFailedResult,
  ReadAloudErrorCode,
  ReadAloudWorkerStage,
} from '@bookorbit/types';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import type { RequestUser } from '../../common/types/request-user';
import { BookService } from '../book/book.service';
import { ReadingAlignmentStatusService } from '../reading-alignment/reading-alignment-status.service';
import { EDITION_SYNC_SERVER_DISABLED_MESSAGE } from './edition-sync.constants';
import { EditionSyncOverlaySourceService } from './edition-sync-overlay-source.service';
import { resolveEditionSyncDecision, resolveEditionSyncIndexStatus, resolveEditionSyncOverrideForToggle } from './edition-sync-policy';
import { EditionSyncQueueService } from './edition-sync-queue.service';
import { EditionSyncSchedulerService } from './edition-sync-scheduler.service';
import { EditionSyncSettingsService } from './edition-sync-settings.service';
import { EditionSyncRepository } from './edition-sync.repository';
import type { EditionSyncBookIndexRow } from './schema/edition-sync.schema';

/** Queue positions are a full-queue window query; the card polls, so they are cached briefly. */
const QUEUE_POSITION_CACHE_MS = 30_000;
const MAX_POSITION_CACHE_ENTRIES = 2_000;

/** One book's edition-sync state for one user. Every method checks book access first. */
@Injectable()
export class EditionSyncBookStateService {
  private readonly logger = new Logger(EditionSyncBookStateService.name);
  private readonly positionCache = new Map<number, { expiresAt: number; position: number | null }>();

  constructor(
    private readonly repo: EditionSyncRepository,
    private readonly books: BookService,
    private readonly settings: EditionSyncSettingsService,
    private readonly queue: EditionSyncQueueService,
    private readonly scheduler: EditionSyncSchedulerService,
    private readonly overlaySource: EditionSyncOverlaySourceService,
    @Optional() private readonly alignmentStatus?: ReadingAlignmentStatusService,
  ) {}

  async getState(user: RequestUser, bookId: number): Promise<EditionSyncBookState> {
    await this.books.verifyBookAccess(bookId, user);
    return this.buildState(user, bookId);
  }

  /** Turning sync on for a book with no index pins it, so it starts outside the window. */
  async setSyncEnabled(user: RequestUser, bookId: number, syncEnabled: boolean): Promise<EditionSyncBookState> {
    await this.books.verifyBookAccess(bookId, user);
    const settings = await this.settings.getSettings(user);
    await this.repo.setOverride(user.id, bookId, resolveEditionSyncOverrideForToggle(settings.bookSyncMode, syncEnabled));
    this.overlaySource.invalidate(user.id, bookId);
    this.positionCache.clear();
    if (syncEnabled && settings.effectiveEnabled) {
      const [eligibility, row] = await Promise.all([this.repo.findEligibility(bookId), this.repo.findIndexRow(bookId)]);
      if (eligibility?.eligible && (row === null || row.status === 'stale')) await this.pin(bookId, false);
    }
    return this.buildState(user, bookId);
  }

  async runNow(user: RequestUser, bookId: number): Promise<EditionSyncBookState> {
    await this.books.verifyBookAccess(bookId, user);
    const state = await this.buildState(user, bookId);
    if (state.effectiveReason === 'server_disabled') throw new BadRequestException(EDITION_SYNC_SERVER_DISABLED_MESSAGE);
    if (!state.canRunNow) throw new BadRequestException('This book cannot be indexed now');
    await this.pin(bookId, false);
    return this.buildState(user, bookId);
  }

  async retry(user: RequestUser, bookId: number): Promise<EditionSyncBookState> {
    await this.books.verifyBookAccess(bookId, user);
    const state = await this.buildState(user, bookId);
    if (state.effectiveReason === 'server_disabled') throw new BadRequestException(EDITION_SYNC_SERVER_DISABLED_MESSAGE);
    if (!state.canRetry) throw new BadRequestException('This book has no failed index to retry');
    await this.pin(bookId, true);
    return this.buildState(user, bookId);
  }

  async retryFailed(user: RequestUser): Promise<EditionSyncRetryFailedResult> {
    const startedAt = Date.now();
    this.logger.log(`[edition_sync.retry_failed] [start] userId=${user.id} - retry failed books started`);
    let retried = 0;
    try {
      const settings = await this.settings.getSettings(user);
      if (settings.disabledReason === 'server_disabled') throw new BadRequestException(EDITION_SYNC_SERVER_DISABLED_MESSAGE);
      retried = await this.repo.retryFailedBooks(user, settings, new Date());
      this.positionCache.clear();
      this.scheduler.poke();
      this.logger.log(
        `[edition_sync.retry_failed] [end] userId=${user.id} durationMs=${Date.now() - startedAt} retried=${retried} - retry failed books completed`,
      );
      return { retried };
    } catch (error) {
      const errorClass = error instanceof Error ? error.name : 'Unknown';
      const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
      this.logger.error(
        `[edition_sync.retry_failed] [fail] userId=${user.id} durationMs=${Date.now() - startedAt} retried=${retried} errorClass=${errorClass} error="${message}" - retry failed books failed`,
      );
      throw error;
    }
  }

  private async pin(bookId: number, retry: boolean): Promise<void> {
    await this.repo.pinBook(bookId, new Date(), retry);
    this.positionCache.clear();
    this.scheduler.poke();
  }

  private async buildState(user: RequestUser, bookId: number): Promise<EditionSyncBookState> {
    const settingsLoad = this.settings.getSettings(user);
    const [settings, eligibility, override, wanted] = await Promise.all([
      settingsLoad,
      this.repo.findEligibility(bookId),
      this.repo.findOverride(user.id, bookId),
      settingsLoad.then((loaded) => loaded.disabledReason !== 'server_disabled' && this.repo.isWanted(bookId)),
    ]);
    if (!eligibility) throw new NotFoundException(`Book ${bookId} not found`);

    let row = await this.repo.findIndexRow(bookId);
    if (row?.status === 'ready' && !(await this.queue.ensureValid(bookId))) row = await this.repo.findIndexRow(bookId);
    if (row?.status === 'ready' && row.indexFileId === null && row.indexPath) row = await this.fillIndexFileId(row, row.indexPath);

    const decision = resolveEditionSyncDecision({ settings, eligible: eligibility.eligible, override });
    const queueable = eligibility.eligible && wanted;
    const status = resolveEditionSyncIndexStatus({
      stored: row?.status ?? null,
      retryRequested: row?.retryRequested ?? false,
      everIndexed: row?.indexedAt != null,
      queueable,
    });
    const waiting = queueable && (status === 'queued' || status === 'stale');
    const queuePosition = waiting ? await this.queuePosition(bookId) : null;
    const nextRunAt = waiting ? (this.scheduler.nextRunAt()?.toISOString() ?? null) : null;
    const whisperFallback =
      status === 'failed' &&
      decision.syncEnabled &&
      (await this.repo.findReadAloudMode(user.id, bookId)) !== 'disabled' &&
      (await this.alignmentStatus?.hasReadyAlignment(bookId, user.id)) === true;

    const index: EditionSyncIndexState = {
      status,
      stage: status === 'running' ? ((row?.stage as ReadAloudWorkerStage | null) ?? null) : null,
      progress: status === 'running' ? (row?.progress ?? 0) : null,
      queuePosition,
      nextRunAt,
      indexedAt: row?.indexedAt?.toISOString() ?? null,
      indexFileId: row?.indexFileId ?? null,
      sentences: row?.report?.totals.sentences ?? null,
      matchedSentences: row?.report?.totals.matchedSentences ?? null,
      failedAt: row?.failedAt?.toISOString() ?? null,
      errorCode: (row?.errorCode as ReadAloudErrorCode | null) ?? null,
      error: row?.lastError ?? null,
      attemptCount: row?.attemptCount ?? 0,
      whisperFallback,
      workerVersion: row?.workerVersion ?? null,
    };

    return {
      bookId,
      eligible: eligibility.eligible,
      editionCount: eligibility.editionCount,
      hasReadAlong: eligibility.hasReadAlong,
      hasAudio: eligibility.hasAudio,
      pinned: row?.pinnedAt != null,
      runActive: (await this.repo.findActiveRun()) !== null,
      syncOverride: override,
      syncEnabled: decision.syncEnabled,
      effectiveReason: decision.effectiveReason,
      wanted,
      index,
      canRunNow: decision.syncEnabled && (status === 'queued' || status === 'stale'),
      canRetry: decision.syncEnabled && eligibility.eligible && status === 'failed',
    };
  }

  /** The scanner registers the index file after capture; link the row to it on first read. */
  private async fillIndexFileId(row: EditionSyncBookIndexRow, indexPath: string): Promise<EditionSyncBookIndexRow> {
    const fileId = await this.repo.findBookFileIdByPath(row.bookId, indexPath);
    if (fileId === null) return row;
    return (await this.repo.updateIndexRow(row.bookId, { indexFileId: fileId })) ?? row;
  }

  private async queuePosition(bookId: number): Promise<number | null> {
    const now = Date.now();
    const cached = this.positionCache.get(bookId);
    if (cached && cached.expiresAt > now) return cached.position;
    const position = await this.repo.findQueuePosition(bookId);
    if (this.positionCache.size >= MAX_POSITION_CACHE_ENTRIES) this.positionCache.clear();
    this.positionCache.set(bookId, { expiresAt: now + QUEUE_POSITION_CACHE_MS, position });
    return position;
  }
}
