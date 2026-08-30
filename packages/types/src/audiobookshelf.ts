export type AudiobookshelfSyncDisabledReason = "permission_denied" | "missing_config" | "user_disabled";

/**
 * One prefix rewrite from an Audiobookshelf absolute path to the BookOrbit absolute path for the same
 * folder on disk. Both servers usually scan the same storage behind different mount points.
 */
export interface AudiobookshelfPathMapping {
  absPrefix: string;
  localPrefix: string;
}

export interface AudiobookshelfSettings {
  serverUrl: string | null;
  tokenConfigured: boolean;
  enabled: boolean;
  effectiveEnabled: boolean;
  disabledReason: AudiobookshelfSyncDisabledReason | null;
  syncStatus: boolean;
  syncPosition: boolean;
  syncSessions: boolean;
  excludedLibraryIds: string[];
  pathMappings: AudiobookshelfPathMapping[];
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  /**
   * Removable stale entries counted during the last successful full inventory walk: rows whose
   * Audiobookshelf item was gone and that carry neither a link nor an exclusion, so a cleanup would
   * delete them. Zero until such a walk has run.
   */
  staleCount: number;
}

export interface UpsertAudiobookshelfSettingsPayload {
  serverUrl?: string;
  apiToken?: string;
  enabled?: boolean;
  syncStatus?: boolean;
  syncPosition?: boolean;
  syncSessions?: boolean;
  excludedLibraryIds?: string[];
  pathMappings?: AudiobookshelfPathMapping[];
}

/**
 * One inferred prefix rewrite, with the number of Audiobookshelf items whose folder resolved to a
 * single BookOrbit folder under it. Suggestions are never saved by the server: the user reviews them
 * in the mapping editor and saves them with the rest of the sync options.
 */
export interface AudiobookshelfPathMappingSuggestion extends AudiobookshelfPathMapping {
  supportCount: number;
}

export interface AudiobookshelfMappingSuggestions {
  suggestions: AudiobookshelfPathMappingSuggestion[];
  /** Audiobookshelf items walked during the inference, whether or not they carried a usable path. */
  scannedItems: number;
}

export interface AudiobookshelfLibrary {
  id: string;
  name: string;
  mediaType: string;
  /** Absolute root folders the Audiobookshelf server scans for this library. */
  folderPaths: string[];
}

export interface AudiobookshelfLibrariesResponse {
  libraries: AudiobookshelfLibrary[];
  /** Absolute root folders of the BookOrbit libraries this user can access. */
  localFolderPaths: string[];
}

export interface AudiobookshelfConnectionTestPayload {
  serverUrl?: string;
  apiToken?: string;
}

export interface AudiobookshelfConnectionTestResult {
  success: boolean;
  username?: string;
  error?: string;
}

export type AudiobookshelfMatchMethod = "asin" | "isbn" | "path" | "title_author_series" | "manual";

export type AudiobookshelfBookStateBucket = "linked" | "needs-review" | "unmatched";

export interface AudiobookshelfBookState {
  absLibraryItemId: string;
  absTitle: string;
  absAuthorName: string | null;
  bookId: number | null;
  bookTitle: string | null;
  bookAuthorName: string | null;
  matchMethod: AudiobookshelfMatchMethod | null;
  matchConfidence: number | null;
  needsReview: boolean;
  matchError: string | null;
  syncExcluded: boolean;
  syncError: string | null;
  lastSyncedAt: string | null;
}

export interface AudiobookshelfBookStatePage {
  items: AudiobookshelfBookState[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AudiobookshelfLinkBookPayload {
  bookId: number;
}

export interface AudiobookshelfExclusionPayload {
  syncExcluded: boolean;
}

export interface AudiobookshelfRescanResult {
  queued: number;
}

/**
 * Options for an explicit stale-entry cleanup. A row the user manually unlinked is a deliberate
 * decision, so it is kept unless the caller opts in to removing it.
 */
export interface AudiobookshelfCleanupPayload {
  includeManuallyUnlinked?: boolean;
}

/**
 * Outcome of an explicit stale-entry cleanup. `removed` covers only pure unmatched rows whose
 * Audiobookshelf item is gone; stale rows that still carry a link, an exclusion, or (unless opted
 * in) a manual unlink are counted and kept.
 */
export interface AudiobookshelfCleanupResult {
  removed: number;
  staleLinked: number;
  staleExcluded: number;
  staleManuallyUnlinked: number;
  seenItems: number;
}

export interface AudiobookshelfSyncResult {
  matched: number;
  statusApplied: number;
  positionApplied: number;
  sessionsApplied: number;
  skipped: number;
  failed: number;
}
