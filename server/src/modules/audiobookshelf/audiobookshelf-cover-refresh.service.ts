import { Injectable, Logger, Optional } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import type { RequestUser } from '../../common/types/request-user';
import { BookMetadataLockService } from '../book-metadata-lock/book-metadata-lock.service';
import { BookReadService } from '../book/book-read.service';
import type { BulkCoverRefresher, BulkCoverRunItem } from '../book/bulk-cover-refresher';
import { BookService, type BulkReExtractCoverItem } from '../book/book.service';
import { CoverSlotReconciler } from '../metadata/cover-slot-reconciler.service';
import { MetadataService } from '../metadata/metadata.service';
import { buildSidecarCoverPathByBookId, resolveCoverReadOrder, sidecarCoverRanksAboveEmbedded } from '../metadata/lib/cover-source-resolution';
import { AudiobookshelfRepository } from './audiobookshelf.repository';

const COVER_LOOKUP_BATCH_SIZE = 500;
const COVER_APPLY_CONCURRENCY = 5;

/**
 * Wraps upstream `BookService.bulkReExtractCover`. Upstream re-extracts every cover slot from embedded
 * art and its slot reconciler fills what is left from folder images, which already covers a sidecar
 * cover ranked below embedded. Only books whose library ranks the sidecar above embedded art are taken
 * out of upstream's run and applied here, sidecar first, in bounded-concurrency batches.
 */
@Injectable()
export class AudiobookshelfCoverRefreshService implements BulkCoverRefresher {
  private readonly logger = new Logger(AudiobookshelfCoverRefreshService.name);

  constructor(
    private readonly bookService: BookService,
    private readonly bookReadService: BookReadService,
    private readonly repository: AudiobookshelfRepository,
    private readonly metadataService: MetadataService,
    private readonly lockService: BookMetadataLockService,
    @Optional() private readonly coverReconciler?: CoverSlotReconciler,
  ) {}

  async bulkReExtractCover(
    bookIds: number[],
    user: RequestUser,
    onProgress?: (bookId: number) => void,
    options?: { isCancelled?: () => boolean },
  ): Promise<{ processed: number; updated: number }> {
    if (bookIds.length === 0) return this.bookService.bulkReExtractCover(bookIds, user, onProgress, options);

    await this.bookService.resolveSelectionToIds({ bookIds }, user, 'editor');
    const sidecarFirst = await this.findSidecarFirstCovers(bookIds);
    let callbackInterrupted = false;
    const trackedProgress = onProgress
      ? (bookId: number) => {
          try {
            onProgress(bookId);
          } catch (error) {
            callbackInterrupted = true;
            throw error;
          }
        }
      : undefined;

    const upstream = await this.bookService.bulkReExtractCover(
      bookIds.filter((id) => !sidecarFirst.has(id)),
      user,
      trackedProgress,
      options,
    );
    if (sidecarFirst.size === 0 || callbackInterrupted || options?.isCancelled?.()) return upstream;

    const sidecar = await this.applySidecarFirstCovers(sidecarFirst, onProgress, options);
    return { processed: upstream.processed + sidecar.processed, updated: upstream.updated + sidecar.updated };
  }

  /**
   * The bulk-run path: the sidecar-first books and their cover locks are read once per start in
   * lookup batches, then each one the run reaches is applied here, answering as upstream's
   * `reExtractCoverItem` would, and every other book is left to upstream's item.
   */
  async prepareBulkRun(bookIds: number[]): Promise<BulkCoverRunItem | null> {
    const sidecarFirst = await this.findSidecarFirstCovers(bookIds);
    if (sidecarFirst.size === 0) return null;
    const fullyLocked = await this.findFullyCoverLocked([...sidecarFirst.keys()]);
    return async (bookId, user) => {
      const sidecarCoverPath = sidecarFirst.get(bookId);
      if (!sidecarCoverPath) return null;
      const access = await this.bookService.bulkItemAccess(bookId, user);
      if (access !== 'ok') return { status: 'skipped', code: access };
      if (fullyLocked.has(bookId)) return { status: 'locked' };
      const [file] = await this.bookReadService.findPrimaryFilesByBookIds([bookId]);
      let item: Exclude<BulkReExtractCoverItem, { status: 'skipped' }>;
      try {
        item = await this.reExtractSidecarFirstItem(bookId, sidecarCoverPath, file);
      } catch (error) {
        this.logSidecarFailure(bookId, error);
        item = { status: 'attempted', updated: false };
      }
      if (item.status === 'attempted') await this.coverReconciler?.enqueue([bookId]);
      return item;
    };
  }

  /** Books whose every cover slot is locked; a sidecar image may land in either slot. */
  private async findFullyCoverLocked(bookIds: number[]): Promise<Set<number>> {
    const result = new Set<number>();
    for (let index = 0; index < bookIds.length; index += COVER_LOOKUP_BATCH_SIZE) {
      const batch = bookIds.slice(index, index + COVER_LOOKUP_BATCH_SIZE);
      const [coverLocked, audioCoverLocked] = await Promise.all([
        this.lockService.getCoverLockedBookIds(batch),
        this.lockService.getBookIdsWithLockedField(batch, 'audioCover'),
      ]);
      for (const bookId of coverLocked) if (audioCoverLocked.has(bookId)) result.add(bookId);
    }
    return result;
  }

  /**
   * Sidecar first, then embedded art, as `applyCoverFromSources` reads them. Like upstream, a book is
   * attempted once it has something to read, and has no source only when the sidecar gave nothing
   * and there is no embedded file to fall back to.
   */
  private async reExtractSidecarFirstItem(
    bookId: number,
    sidecarCoverPath: string,
    file: { absolutePath: string; format: string | null } | undefined,
  ): Promise<Exclude<BulkReExtractCoverItem, { status: 'skipped' | 'locked' }>> {
    const readOrder = resolveCoverReadOrder({
      precedence: ['sidecar', 'embedded'],
      primaryFile: file ? { absolutePath: file.absolutePath, format: file.format } : null,
      sidecarCoverPath,
    });
    let readable = false;
    for (const source of readOrder) {
      if (source.kind === 'embedded') {
        readable = true;
        if (await this.metadataService.refreshCoverForBook(bookId, source.absolutePath, source.format)) return { status: 'attempted', updated: true };
        continue;
      }
      const outcome = await this.metadataService.applyCoverSource(bookId, source);
      if (outcome === 'saved') return { status: 'attempted', updated: true };
      if (outcome === 'locked') return { status: 'attempted', updated: false };
    }
    return readable ? { status: 'attempted', updated: false } : { status: 'no-source' };
  }

  private async findSidecarFirstCovers(bookIds: number[]): Promise<Map<number, string>> {
    const result = new Map<number, string>();
    for (let index = 0; index < bookIds.length; index += COVER_LOOKUP_BATCH_SIZE) {
      const rows = await this.repository.findSidecarCoverCandidatesByBookIds(bookIds.slice(index, index + COVER_LOOKUP_BATCH_SIZE));
      const applicable = rows.filter((row) => row.organizationMode !== 'book_per_file' && sidecarCoverRanksAboveEmbedded(row.metadataPrecedence));
      for (const [bookId, path] of buildSidecarCoverPathByBookId(applicable)) result.set(bookId, path);
    }
    return result;
  }

  private async applySidecarFirstCovers(
    sidecarCoverByBookId: Map<number, string>,
    onProgress: ((bookId: number) => void) | undefined,
    options: { isCancelled?: () => boolean } | undefined,
  ): Promise<{ processed: number; updated: number }> {
    const event = 'audiobookshelf.sidecar_cover_refresh';
    const startedAt = Date.now();
    const bookIds = [...sidecarCoverByBookId.keys()];
    this.logger.log(`[${event}] [start] count=${bookIds.length} - sidecar cover refresh started`);
    let processed = 0;
    let updated = 0;
    let stopped = false;

    for (let index = 0; index < bookIds.length && !stopped; index += COVER_APPLY_CONCURRENCY) {
      if (options?.isCancelled?.()) break;
      const batch = bookIds.slice(index, index + COVER_APPLY_CONCURRENCY);
      const primaryFiles = new Map((await this.bookReadService.findPrimaryFilesByBookIds(batch)).map((file) => [file.bookId, file]));
      const results = await Promise.allSettled(
        batch.map((bookId) => this.applySidecarFirstCover(bookId, sidecarCoverByBookId.get(bookId)!, primaryFiles.get(bookId))),
      );
      for (let resultIndex = 0; resultIndex < results.length; resultIndex++) {
        const result = results[resultIndex]!;
        const bookId = batch[resultIndex]!;
        processed++;
        if (result.status === 'rejected') {
          this.logSidecarFailure(bookId, result.reason);
        } else if (result.value) {
          updated++;
        }
        try {
          onProgress?.(bookId);
        } catch {
          stopped = true;
          break;
        }
      }
    }

    this.logger.log(
      `[${event}] [end] count=${bookIds.length} durationMs=${Date.now() - startedAt} processed=${processed} updated=${updated} callbackInterrupted=${stopped} - sidecar cover refresh completed`,
    );
    return { processed, updated };
  }

  private applySidecarFirstCover(
    bookId: number,
    sidecarCoverPath: string,
    file: { absolutePath: string; format: string | null } | undefined,
  ): Promise<boolean> {
    const readOrder = resolveCoverReadOrder({
      precedence: ['sidecar', 'embedded'],
      primaryFile: file ? { absolutePath: file.absolutePath, format: file.format } : null,
      sidecarCoverPath,
    });
    return this.metadataService.applyCoverFromSources(bookId, readOrder);
  }

  private logSidecarFailure(bookId: number, error: unknown): void {
    const errorClass = error instanceof Error ? error.name : 'Error';
    const errorMessage = sanitizeLogValue(error instanceof Error ? error.message : String(error));
    this.logger.warn(
      `[audiobookshelf.sidecar_cover_refresh] [fail] bookId=${bookId} errorClass=${errorClass} error="${errorMessage}" - sidecar cover apply failed`,
    );
  }
}
