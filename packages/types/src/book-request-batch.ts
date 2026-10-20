import type { ReleaseUnitMediaKind } from "./indexer";

/**
 * A grab is one of two shapes: the whole of a picked release, or one release split into
 * per-unit grabs. A single grab is the pre-existing flow; a batch is created from a selection.
 */
export const BOOK_REQUEST_KINDS = ["single", "batch"] as const;
export type BookRequestKind = (typeof BOOK_REQUEST_KINDS)[number];

/** The stops a unit of a batch passes through, from queued in BookOrbit to landed in the Book Dock. */
export const BATCH_UNIT_STATUSES = ["waiting", "placing", "in_dock", "filed", "failed"] as const;
export type BatchUnitStatus = (typeof BATCH_UNIT_STATUSES)[number];

/** The largest number of units one release may be split into. */
export const MAX_BATCH_UNITS = 2_000;

/** The grab that splits one release into per-unit downloads on behalf of an existing request. */
export interface CreateBatchGrabPayload {
  sourceRequestId: number;
  indexerId: number;
  releaseGuid: string;
  downloadClientId: number;
  unitIndexes: number[];
}

/** One unit of a batch as an approver watches it land, unit by unit. */
export interface BatchUnitView {
  unitIndex: number;
  title: string | null;
  primaryPath: string;
  mediaKind: ReleaseUnitMediaKind;
  sizeBytes: number | null;
  status: BatchUnitStatus;
  bookDockFileId: number | null;
  errorMessage: string | null;
}

/** The rollup a batch request carries so a card can show progress without loading every unit. */
export interface BatchSummary {
  total: number;
  inDock: number;
  filed: number;
  failed: number;
}
