import type { RequestUser } from '../../common/types/request-user';
import type { BulkReExtractCoverItem } from './book.service';

export const BULK_COVER_REFRESHER = Symbol('BULK_COVER_REFRESHER');

/** Re-extracts one book of a bulk run when the refresher owns it; null leaves the book to the default path. */
export type BulkCoverRunItem = (bookId: number, user: RequestUser) => Promise<BulkReExtractCoverItem | null>;

export interface BulkCoverRefresher {
  bulkReExtractCover(
    bookIds: number[],
    user: RequestUser,
    onProgress?: (bookId: number) => void,
    options?: { isCancelled?: () => boolean },
  ): Promise<{ processed: number; updated: number }>;

  /** Called once per start of a `book-re-extract-cover` bulk run with the books still to do. */
  prepareBulkRun?(bookIds: number[]): Promise<BulkCoverRunItem | null>;
}
