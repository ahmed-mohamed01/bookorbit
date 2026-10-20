import type { BatchUnitView, ReleaseUnitMediaKind } from '@bookorbit/types';

import type { BatchUnitRow } from '../schema/book-request-batch.schema';

export function toUnitView(row: BatchUnitRow): BatchUnitView {
  return {
    unitIndex: row.unitIndex,
    title: row.title,
    primaryPath: row.primaryPath,
    mediaKind: row.mediaKind as ReleaseUnitMediaKind,
    sizeBytes: row.sizeBytes,
    status: row.status as BatchUnitView['status'],
    bookDockFileId: row.bookDockFileId,
    errorMessage: row.errorMessage,
  };
}
