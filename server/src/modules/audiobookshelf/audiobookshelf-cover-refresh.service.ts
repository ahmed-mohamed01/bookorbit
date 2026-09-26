import { Injectable, Logger } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import type { RequestUser } from '../../common/types/request-user';
import { BookReadService } from '../book/book-read.service';
import type { BulkCoverRefresher } from '../book/bulk-cover-refresher';
import { BookService } from '../book/book.service';
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
  ) {}

  async bulkReExtractCover(
    bookIds: number[],
    user: RequestUser,
    onProgress?: (bookId: number) => void,
    options?: { isCancelled?: () => boolean },
  ): Promise<{ processed: number; updated: number }> {
    if (bookIds.length === 0) return this.bookService.bulkReExtractCover(bookIds, user, onProgress, options);

    await this.bookService.resolveSelectionToIds({ bookIds }, user);
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
        batch.map((bookId) => {
          const file = primaryFiles.get(bookId);
          const readOrder = resolveCoverReadOrder({
            precedence: ['sidecar', 'embedded'],
            primaryFile: file ? { absolutePath: file.absolutePath, format: file.format } : null,
            sidecarCoverPath: sidecarCoverByBookId.get(bookId)!,
          });
          return this.metadataService.applyCoverFromSources(bookId, readOrder);
        }),
      );
      for (let resultIndex = 0; resultIndex < results.length; resultIndex++) {
        const result = results[resultIndex]!;
        const bookId = batch[resultIndex]!;
        processed++;
        if (result.status === 'rejected') {
          const errorClass = result.reason instanceof Error ? result.reason.name : 'Error';
          const errorMessage = sanitizeLogValue(result.reason instanceof Error ? result.reason.message : String(result.reason));
          this.logger.warn(`[${event}] [fail] bookId=${bookId} errorClass=${errorClass} error="${errorMessage}" - sidecar cover apply failed`);
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
}
