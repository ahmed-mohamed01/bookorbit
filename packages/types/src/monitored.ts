import type { ReleaseSearchResult } from "./indexer";

export const MONITORED_FORMATS = ["ebook", "audiobook"] as const;
export type MonitoredFormat = (typeof MONITORED_FORMATS)[number];

export const MONITOR_MODES = ["notify", "auto-upcoming", "auto-all", "off"] as const;
export type MonitorMode = (typeof MONITOR_MODES)[number];

export const MONITORED_WORK_VERDICTS = ["verified", "probable", "suspect"] as const;
export type MonitoredWorkVerdict = (typeof MONITORED_WORK_VERDICTS)[number];

export const MONITORED_WORK_FLAGS = ["compilation", "placeholder", "adaptation_split", "foreign_language", "wrong_contributor"] as const;
export type MonitoredWorkFlag = (typeof MONITORED_WORK_FLAGS)[number];

export const MONITORED_WORK_STATES = ["monitoring", "paused", "stopped"] as const;
export type MonitoredWorkState = (typeof MONITORED_WORK_STATES)[number];

export const MONITORED_RELEASE_STATUSES = ["upcoming", "available", "queued", "grabbed"] as const;
export type MonitoredReleaseStatus = (typeof MONITORED_RELEASE_STATUSES)[number];

export const MONITORED_GROUPINGS = ["none", "series", "year", "status"] as const;
export type MonitoredGrouping = (typeof MONITORED_GROUPINGS)[number];

export const MONITORED_SORTS = ["releaseDate", "title"] as const;
export type MonitoredSort = (typeof MONITORED_SORTS)[number];

export const MONITORED_LIST_ORDERS = ["asc", "desc"] as const;
export type MonitoredListOrder = (typeof MONITORED_LIST_ORDERS)[number];

export const MONITORED_AUTHOR_LIST_SORTS = ["name", "added", "books", "progress"] as const;
export type MonitoredAuthorListSort = (typeof MONITORED_AUTHOR_LIST_SORTS)[number];

export const MONITORED_BOOK_LIST_SORTS = ["added", "title", "author"] as const;
export type MonitoredBookListSort = (typeof MONITORED_BOOK_LIST_SORTS)[number];

export const MONITORED_RELEASE_LIST_SORTS = ["date", "title", "author"] as const;
export type MonitoredReleaseListSort = (typeof MONITORED_RELEASE_LIST_SORTS)[number];

export const MONITORED_RELEASE_FILTERS = ["all", "recent", "soon", "year"] as const;
export type MonitoredReleaseFilter = (typeof MONITORED_RELEASE_FILTERS)[number];

export type MonitoredDatePrecision = "day" | "month" | "year";

export interface MonitorFormatConfig {
  mode: MonitorMode;
  libraryId: number | null;
  folderId: number | null;
}

export interface MonitoredAuthorProviderIds {
  hardcover?: string;
  goodreads?: string;
  /** Audible has no stable author id; this is the confirmed query name. */
  audible?: string;
}

export interface MonitoredAuthorConfig {
  id: string;
  ownerUserId: number;
  isShared: boolean;
  authorName: string;
  /** Link to the local authors table when the author exists in the library. */
  localAuthorId: number | null;
  providerIds: MonitoredAuthorProviderIds;
  formats: Record<MonitoredFormat, MonitorFormatConfig>;
  paused: boolean;
  addedAt: string;
  lastRefreshedAt: string | null;
}

export interface MonitoredSeriesMembership {
  name: string;
  index: string | null;
}

export interface MonitoredWork {
  id: string;
  title: string;
  subtitle: string | null;
  seriesName: string | null;
  seriesIndex: string | null;
  seriesMemberships: MonitoredSeriesMembership[];
  releaseYear: number | null;
  ebookReleaseDate: string | null;
  ebookDatePrecision: MonitoredDatePrecision | null;
  audioReleaseDate: string | null;
  audioDatePrecision: MonitoredDatePrecision | null;
  coverUrl: string | null;
  description: string | null;
  verdict: MonitoredWorkVerdict;
  flags: MonitoredWorkFlag[];
  sources: string[];
  providerWorkIds: { hardcover?: string; goodreads?: string; audible?: string };
  monitorState: MonitoredWorkState;
  matchedBookId: number | null;
  /**
   * The library book row backing each owned format. The ebook and the audiobook of one work are
   * separate rows in separate libraries, so one id cannot name both; the Files view needs each.
   */
  matchedBookIds?: Partial<Record<MonitoredFormat, number>>;
  ownedFormats: MonitoredFormat[];
  /** Per-work monitor toggles; a missing entry means monitoring is on for that format. */
  monitorFormats?: Partial<Record<MonitoredFormat, boolean>>;
  /**
   * User visibility override. Absent = the verdict decides (verified+unflagged shows, the rest sit
   * under review). 'hidden' forces a work out of the default list; 'visible' promotes a
   * review-hidden work into the default list and into monitoring.
   */
  userVisibility?: "hidden" | "visible";
  /** Book-request ids created from this work, per format. */
  requestIds: Partial<Record<MonitoredFormat, number>>;
}

export interface MonitoredBookEntry {
  id: string;
  ownerUserId: number;
  isShared: boolean;
  monitorAuthorId: string;
  workId: string;
  formats: MonitoredFormat[];
  paused: boolean;
  addedAt: string;
}

export interface MonitoredAuthorCounts {
  total: number;
  ebookOwned: number;
  audioOwned: number;
  hidden: number;
}

export interface MonitoredAuthorItem extends MonitoredAuthorConfig {
  isOwner: boolean;
  counts: MonitoredAuthorCounts;
  nextReleaseAt: string | null;
  portraitAuthorId: number | null;
  description: string | null;
  website: string | null;
  genres: string[];
}

export interface MonitoredAuthorDetail {
  author: MonitoredAuthorItem;
  works: MonitoredWork[];
}

export interface MonitoredBookItem extends MonitoredBookEntry {
  isOwner: boolean;
  authorName: string;
  work: MonitoredWork;
}

export interface MonitoredReleaseItem {
  workId: string;
  /** The full catalog work, so release surfaces can reuse the system work card and book panel. */
  work: MonitoredWork;
  monitorAuthorId: string;
  /** Whether the viewer may act on this release (owner or superuser); shared monitors are read-only. */
  isOwner: boolean;
  title: string;
  authorName: string;
  coverUrl: string | null;
  format: MonitoredFormat;
  releaseDate: string;
  status: MonitoredReleaseStatus;
  requestId: number | null;
}

export interface MonitoredSummary {
  authors: number;
  books: number;
  releases: number;
}

export interface MonitoredPage<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

export interface MonitoredAuthorSearchResult {
  name: string;
  providerIds: MonitoredAuthorProviderIds;
  localAuthorId: number | null;
  bookCount: number | null;
  imageUrl: string | null;
  genres: string[];
  alreadyMonitoredId: string | null;
}

export interface MonitorAuthorRequest {
  authorName: string;
  localAuthorId?: number;
  providerIds?: MonitoredAuthorProviderIds;
  isShared?: boolean;
  formats: Partial<Record<MonitoredFormat, MonitorFormatConfig>>;
}

export interface UpdateMonitoredAuthorRequest {
  formats?: Partial<Record<MonitoredFormat, MonitorFormatConfig>>;
  paused?: boolean;
  isShared?: boolean;
}

export interface RequestFromWorkPayload {
  format: MonitoredFormat;
  autoDownload?: boolean;
}

/** Per-work monitor/visibility toggles accepted by PATCH /monitored/works/:workId. */
export interface MonitoredWorkPatch {
  monitorEbook?: boolean;
  monitorAudiobook?: boolean;
  hidden?: boolean;
}

/**
 * The fulfilment pipeline's release list. Searches are stateless: no book request is created or
 * named until a grab commits to a download, so exploratory searches never populate Requests.
 */
export type MonitoredWorkReleasesResponse = ReleaseSearchResult;
