import { Injectable, Logger } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import type { RequestUser } from '../../common/types/request-user';
import { BookMetadataLockService } from '../book-metadata-lock/book-metadata-lock.service';
import { BookReadService } from '../book/book-read.service';
import type { BulkCoverRefresher } from '../book/bulk-cover-refresher';
import { BookService } from '../book/book.service';
import { MetadataService } from '../metadata/metadata.service';
import { buildSidecarCoverPathByBookId, resolveCoverReadOrder } from '../metadata/lib/cover-source-resolution';
import { AudiobookshelfRepository } from './audiobookshelf.repository';

const COVER_LOOKUP_BATCH_SIZE = 500;
const COVER_APPLY_CONCURRENCY = 5;

@Injectable()
export class AudiobookshelfCoverRefreshService implements BulkCoverRefresher {
  private readonly logger = new Logger(AudiobookshelfCoverRefreshService.name);

  constructor(
    private readonly bookService: BookService,
    private readonly bookReadService: BookReadService,
    private readonly repository: AudiobookshelfRepository,
    private readonly bookMetadataLockService: BookMetadataLockService,
    private readonly metadataService: MetadataService,
  ) {}

  async bulkReExtractCover(
    bookIds: number[],
    user: RequestUser,
    onProgress?: (bookId: number) => void,
    options?: { isCancelled?: () => boolean },
  ): Promise<{ processed: number; updated: number }> {
    const event = 'book.bulk_reextract_cover';
    const startedAt = Date.now();
    this.logger.log(`[${event}] [start] count=${bookIds.length} userId=${user.id} - bulk re-extract cover started`);
    try {
      if (bookIds.length === 0) {
        this.logger.log(`[${event}] [end] count=0 durationMs=${Date.now() - startedAt} processed=0 updated=0 - bulk re-extract cover completed`);
        return { processed: 0, updated: 0 };
      }
      await this.bookService.resolveSelectionToIds({ bookIds }, user);

      let processed = 0;
      let updated = 0;
      let skipped = 0;
      let callbackInterrupted = false;
      let cancelled = false;
      let firstCandidateApplied = false;

      for (let outerIndex = 0; outerIndex < bookIds.length && !cancelled && !callbackInterrupted; outerIndex += COVER_LOOKUP_BATCH_SIZE) {
        const bookBatch = bookIds.slice(outerIndex, outerIndex + COVER_LOOKUP_BATCH_SIZE);
        const [files, sidecarCoverRows, coverLockedBookIds] = await Promise.all([
          this.bookReadService.findPrimaryFilesByBookIds(bookBatch),
          this.repository.findSidecarCoverCandidatesByBookIds(bookBatch),
          this.bookMetadataLockService.getCoverLockedBookIds(bookBatch),
        ]);
        const filesByBookId = new Map(files.map((file) => [file.bookId, file]));
        const applicableSidecarRows = sidecarCoverRows.filter((row) => row.organizationMode !== 'book_per_file');
        const sidecarCoverByBookId = buildSidecarCoverPathByBookId(applicableSidecarRows);
        const precedenceByBookId = new Map(applicableSidecarRows.map((row) => [row.bookId, row.metadataPrecedence]));

        for (let batchIndex = 0; batchIndex < bookBatch.length && !cancelled && !callbackInterrupted;) {
          const candidates: { bookId: number; readOrder: ReturnType<typeof resolveCoverReadOrder> }[] = [];
          while (batchIndex < bookBatch.length && candidates.length < COVER_APPLY_CONCURRENCY) {
            const id = bookBatch[batchIndex++]!;
            if (options?.isCancelled?.()) {
              cancelled = true;
              break;
            }
            const file = filesByBookId.get(id);
            const sidecarCoverPath = sidecarCoverByBookId.get(id) ?? null;
            if (!file && !sidecarCoverPath) continue;
            if (coverLockedBookIds.has(id)) {
              skipped++;
              continue;
            }
            candidates.push({
              bookId: id,
              readOrder: resolveCoverReadOrder({
                precedence: precedenceByBookId.get(id) ?? null,
                primaryFile: file ? { absolutePath: file.absolutePath, format: file.format } : null,
                sidecarCoverPath,
              }),
            });
          }

          if (!firstCandidateApplied && candidates.length > 0) {
            const first = candidates.shift()!;
            processed++;
            if (await this.metadataService.applyCoverFromSources(first.bookId, first.readOrder)) updated++;
            firstCandidateApplied = true;
            try {
              onProgress?.(first.bookId);
            } catch {
              callbackInterrupted = true;
            }
          }
          if (cancelled || callbackInterrupted || candidates.length === 0) continue;

          processed += candidates.length;
          const results = await Promise.allSettled(
            candidates.map(async (candidate) => ({
              bookId: candidate.bookId,
              refreshed: await this.metadataService.applyCoverFromSources(candidate.bookId, candidate.readOrder),
            })),
          );
          for (const result of results) {
            if (result.status === 'rejected') throw result.reason;
            if (result.value.refreshed) updated++;
            try {
              onProgress?.(result.value.bookId);
            } catch {
              callbackInterrupted = true;
              break;
            }
          }
        }
      }
      this.logger.log(
        `[${event}] [end] count=${bookIds.length} durationMs=${Date.now() - startedAt} processed=${processed} updated=${updated} skippedLocked=${skipped} callbackInterrupted=${callbackInterrupted} cancelled=${cancelled} - bulk re-extract cover completed`,
      );
      return { processed, updated };
    } catch (error) {
      const errorClass = error instanceof Error ? error.name : 'Error';
      const errorMessage = sanitizeLogValue(error instanceof Error ? error.message : String(error));
      this.logger.warn(
        `[${event}] [fail] count=${bookIds.length} userId=${user.id} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${errorMessage}" - bulk re-extract cover failed`,
      );
      throw error;
    }
  }
}
