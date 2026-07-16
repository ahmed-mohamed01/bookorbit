import type { BookQuery, SortField, SortSpec } from "./query";

export type JumpBucketKind = "letter" | "temporal";

export type TemporalJumpBucketUnit = "day" | "month" | "year";

export type TemporalJumpBucketGranularity = {
  unit: TemporalJumpBucketUnit;
  step: number;
};

/**
 * One jump target on the rail. `index` is the absolute 0-based row index of the
 * first book in this bucket under the listing's exact sort order, so a jump is
 * just scroll-to-index. Buckets are returned in display order (already reversed
 * for descending sorts).
 */
export type JumpBucket = {
  key: string;
  label: string;
  index: number;
  isUnknown?: boolean;
};

export type JumpBucketsResponse = {
  buckets: JumpBucket[];
  total: number;
  kind: JumpBucketKind;
  granularity: TemporalJumpBucketGranularity | null;
};

export type JumpBucketsQuery = BookQuery & {
  maxBuckets: number;
};

const KIND_BY_PRIMARY_SORT_FIELD: Partial<Record<SortField, JumpBucketKind>> = {
  title: "letter",
  author: "letter",
  addedAt: "temporal",
  updatedAt: "temporal",
  publishedDate: "temporal",
  publishedYear: "temporal",
  lastReadAt: "temporal",
  startedAt: "temporal",
  finishedAt: "temporal",
};

export type TemporalJumpBucketPrecision = "date" | "year";

const TEMPORAL_PRECISION_BY_SORT_FIELD: Partial<Record<SortField, TemporalJumpBucketPrecision>> = {
  addedAt: "date",
  updatedAt: "date",
  publishedDate: "year",
  publishedYear: "year",
  lastReadAt: "date",
  startedAt: "date",
  finishedAt: "date",
};

/**
 * Single source of truth for rail eligibility, shared by the client (gate the
 * rail and bucket fetches) and the server (validate + pick bucket expression).
 * Only the primary sort field matters: secondary sorts reorder rows within
 * equal primary values and cannot move bucket boundaries. An empty sort means
 * title ascending, mirroring the server's default.
 */
export function jumpBucketKindForSort(sort: SortSpec[]): JumpBucketKind | null {
  const primary = sort[0] ?? { field: "title", dir: "asc" };
  return KIND_BY_PRIMARY_SORT_FIELD[primary.field] ?? null;
}

export function temporalJumpBucketPrecisionForSort(sort: SortSpec[]): TemporalJumpBucketPrecision | null {
  const primary = sort[0] ?? { field: "title", dir: "asc" };
  return TEMPORAL_PRECISION_BY_SORT_FIELD[primary.field] ?? null;
}
