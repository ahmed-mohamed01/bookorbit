import { randomUUID } from 'crypto';

import { Injectable, Logger } from '@nestjs/common';
import type { EditionSyncClearUnusedResult } from '@bookorbit/types';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { ReadAloudWorkspace } from '../read-aloud/read-aloud-workspace.service';
import { EDITION_SYNC_CLEAR_BATCH_SIZE, EDITION_SYNC_FILE_CHANGE_REASONS } from './edition-sync.constants';
import { EditionSyncIndexStoreService } from './edition-sync-index-store.service';
import { EditionSyncOverlaySourceService } from './edition-sync-overlay-source.service';
import { checkEditionSyncSources } from './edition-sync-source-check';
import type { EditionSyncClaim } from './edition-sync.types';
import { EditionSyncRepository } from './edition-sync.repository';

/** Rows whose earlier worker job folder may still hold cached stages worth resuming from. */
const RESUMABLE_STATUSES = new Set(['stale', 'failed']);

/** Picks the next wanted book, checks indexes against the current files and clears unused ones. */
@Injectable()
export class EditionSyncQueueService {
  private readonly logger = new Logger(EditionSyncQueueService.name);

  constructor(
    private readonly repo: EditionSyncRepository,
    private readonly indexStore: EditionSyncIndexStoreService,
    private readonly workspace: ReadAloudWorkspace,
    private readonly overlaySource: EditionSyncOverlaySourceService,
  ) {}

  /**
   * Marks the next book `running` and returns it; pinned books only when `pinnedOnly`. Reuses the
   * previous worker job id while its folder exists, so the worker resumes from its cached stages.
   */
  async claimNext(options: { pinnedOnly: boolean; excludeBookIds?: readonly number[] }): Promise<EditionSyncClaim | null> {
    const next = await this.repo.findNextQueuedBook(options);
    if (!next) return null;
    const existing = await this.repo.findIndexRow(next.bookId);
    const filesChanged =
      !!existing &&
      (EDITION_SYNC_FILE_CHANGE_REASONS.includes(existing.invalidatedReason ?? '') ||
        (!!existing.filesChangedAt && (!existing.lastAttemptAt || existing.filesChangedAt > existing.lastAttemptAt)));
    if (filesChanged && existing?.workerJobId) await this.workspace.remove(existing.workerJobId);
    const resumable =
      !filesChanged && existing?.workerJobId && RESUMABLE_STATUSES.has(existing.status) && (await this.hasWorkFolder(existing.workerJobId));
    const workerJobId = resumable && existing?.workerJobId ? existing.workerJobId : randomUUID();
    const claimed = await this.repo.claimIndexRow(next.bookId, workerJobId, new Date(), existing?.filesChangedAt ?? null);
    if (!claimed) return null;
    this.overlaySource.invalidateBook(next.bookId);
    return { bookId: next.bookId, workerJobId, pinned: next.pinned };
  }

  /** True when the book has a ready index that still matches its files; marks it stale otherwise. */
  async ensureValid(bookId: number): Promise<boolean> {
    const row = await this.repo.findIndexRow(bookId);
    if (row?.status !== 'ready') return false;
    const verification = await checkEditionSyncSources(this.repo, bookId, row);
    if (verification.valid) {
      if (row.invalidatedAt) await this.repo.clearRecheck(bookId);
      return true;
    }
    await this.repo.markStale(bookId, verification.reason);
    this.overlaySource.invalidateBook(bookId);
    this.logger.log(`[edition_sync.invalidate] [end] bookId=${bookId} reason=${verification.reason} - timing index no longer matches the book files`);
    return false;
  }

  /**
   * Deletes every index no user wants (ready, failed or stale rows; failed rows hold no file but lose
   * their Whisper fallback). Batches advance by book id, so a row that fails to delete is skipped.
   */
  async clearUnused(): Promise<EditionSyncClearUnusedResult> {
    const event = 'edition_sync.clear_unused';
    const startedAt = Date.now();
    this.logger.log(`[${event}] [start] batchSize=${EDITION_SYNC_CLEAR_BATCH_SIZE} - clearing unused timing data`);
    let deleted = 0;
    let freedBytes = 0;
    let failed = 0;
    let afterBookId = 0;
    try {
      for (;;) {
        const batch = await this.repo.findUnused(EDITION_SYNC_CLEAR_BATCH_SIZE, afterBookId);
        for (const row of batch) {
          afterBookId = row.bookId;
          try {
            if (!(await this.repo.deleteUnusedIndexRow(row.bookId, { status: row.status, indexPath: row.indexPath }))) {
              this.logger.log(`[edition_sync.clear_unused] [end] bookId=${row.bookId} skipped=row_changed - timing data retained`);
              continue;
            }
            this.overlaySource.invalidateBook(row.bookId);
            if (row.indexPath) freedBytes += await this.indexStore.removeIndexFile(row.bookId, row.indexPath);
            deleted++;
          } catch (err) {
            failed++;
            const errorClass = err instanceof Error ? err.name : 'Error';
            this.logger.warn(
              `[${event}] [fail] bookId=${row.bookId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(err instanceof Error ? err.message : String(err))}" - timing data not cleared`,
            );
          }
        }
        if (batch.length < EDITION_SYNC_CLEAR_BATCH_SIZE) break;
      }
      this.logger.log(
        `[${event}] [end] durationMs=${Date.now() - startedAt} deleted=${deleted} failed=${failed} freedBytes=${freedBytes} - unused timing data cleared`,
      );
      return { deleted, freedBytes };
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : 'Error';
      this.logger.error(
        `[${event}] [fail] durationMs=${Date.now() - startedAt} deleted=${deleted} errorClass=${errorClass} error="${sanitizeLogValue(err instanceof Error ? err.message : String(err))}" - clearing unused timing data failed`,
      );
      throw err;
    }
  }

  private async hasWorkFolder(workerJobId: string): Promise<boolean> {
    const stats = await this.workspace.inspect(workerJobId, this.workspace.dir(workerJobId));
    return stats?.isDirectory() === true;
  }
}
