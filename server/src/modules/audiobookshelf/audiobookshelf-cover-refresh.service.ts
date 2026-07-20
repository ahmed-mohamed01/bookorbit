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

      const [files, sidecarCoverRows, coverLockedBookIds] = await Promise.all([
        this.bookReadService.findPrimaryFilesByBookIds(bookIds),
        this.repository.findSidecarCoverCandidatesByBookIds(bookIds),
        this.bookMetadataLockService.getCoverLockedBookIds(bookIds),
      ]);
      const filesByBookId = new Map(files.map((file) => [file.bookId, file]));
      const applicableSidecarRows = sidecarCoverRows.filter((row) => row.organizationMode !== 'book_per_file');
      const sidecarCoverByBookId = buildSidecarCoverPathByBookId(applicableSidecarRows);
      const precedenceByBookId = new Map(applicableSidecarRows.map((row) => [row.bookId, row.metadataPrecedence]));

      let processed = 0;
      let updated = 0;
      let skipped = 0;
      let callbackInterrupted = false;
      let cancelled = false;
      for (const id of bookIds) {
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
        processed++;
        const readOrder = resolveCoverReadOrder({
          precedence: precedenceByBookId.get(id) ?? null,
          primaryFile: file ? { absolutePath: file.absolutePath, format: file.format } : null,
          sidecarCoverPath,
        });
        if (await this.metadataService.applyCoverFromSources(id, readOrder)) updated++;
        try {
          onProgress?.(id);
        } catch {
          callbackInterrupted = true;
          break;
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
