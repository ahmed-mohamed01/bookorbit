export type AudiobookshelfSyncDisabledReason = "permission_denied" | "missing_config" | "user_disabled";

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
  lastSyncedAt: string | null;
  lastSyncError: string | null;
}

export interface UpsertAudiobookshelfSettingsPayload {
  serverUrl?: string;
  apiToken?: string;
  enabled?: boolean;
  syncStatus?: boolean;
  syncPosition?: boolean;
  syncSessions?: boolean;
  excludedLibraryIds?: string[];
}

export interface AudiobookshelfLibrary {
  id: string;
  name: string;
  mediaType: string;
}

export interface AudiobookshelfLibrariesResponse {
  libraries: AudiobookshelfLibrary[];
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

export type AudiobookshelfMatchMethod = "asin" | "isbn" | "title_author_series" | "manual";

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

export interface AudiobookshelfSyncResult {
  matched: number;
  statusApplied: number;
  positionApplied: number;
  sessionsApplied: number;
  skipped: number;
  failed: number;
}
