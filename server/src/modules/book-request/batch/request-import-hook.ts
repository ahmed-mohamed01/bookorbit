import type { BookRequestDownloadRow, BookRequestRow } from '../../../db/schema';
import type { ReleasePlan } from '../../scanner/lib/release-plan';
import type { RequestImportService } from '../fulfillment/request-import.service';

export const REQUEST_IMPORT_HOOK = Symbol('REQUEST_IMPORT_HOOK');

export type BatchUnitPlacer = Pick<RequestImportService, 'claimDestination' | 'placeUnit'>;

/** Optional fork steps inside `RequestImportService.runImportFromDisk`; absent, the import is upstream's. */
export interface RequestImportHook {
  /** Where the release actually is when the client named only its first file. Null when the import was held. */
  contentPath(download: BookRequestDownloadRow, request: BookRequestRow, localPath: string): Promise<string | null>;
  /** True when the download belonged to a batch and was imported as one, so the single-book path must not run. */
  importBatch(
    importer: BatchUnitPlacer,
    download: BookRequestDownloadRow,
    request: BookRequestRow,
    root: string,
    plan: ReleasePlan,
    containmentRoot: string,
  ): Promise<boolean>;
}
