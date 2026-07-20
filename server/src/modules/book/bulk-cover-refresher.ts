import type { RequestUser } from '../../common/types/request-user';

export const BULK_COVER_REFRESHER = Symbol('BULK_COVER_REFRESHER');

export interface BulkCoverRefresher {
  bulkReExtractCover(
    bookIds: number[],
    user: RequestUser,
    onProgress?: (bookId: number) => void,
    options?: { isCancelled?: () => boolean },
  ): Promise<{ processed: number; updated: number }>;
}
