import type {
  ReadAloudDecisions,
  ReadAloudErrorCode,
  ReadAloudGranularity,
  ReadAloudReportSummary,
  ReadAloudWorkerHealth,
  ReadAloudWorkerRequest,
  ReadAloudWorkerStage,
} from "./read-aloud";

/** File extension (no leading dot) of a book's timing index, stored next to the book as a zip. */
export const EDITION_SYNC_INDEX_EXTENSION = "bookorbit-timings";
/** Daily at 02:00 in the server's time zone. */
export const EDITION_SYNC_DEFAULT_CRON = "0 2 * * *";
export const EDITION_SYNC_DEFAULT_RUN_HOURS = 8;
export const EDITION_SYNC_RUN_HOURS_MIN = 1;
export const EDITION_SYNC_RUN_HOURS_MAX = 24;

export type EditionSyncBookSyncMode = "all_eligible" | "selected_only";
export const EDITION_SYNC_BOOK_SYNC_MODES = ["all_eligible", "selected_only"] as const satisfies readonly EditionSyncBookSyncMode[];
export type EditionSyncOverride = "included" | "excluded" | null;
export type EditionSyncDisabledReason = "permission_denied" | "user_disabled";
export type EditionSyncEffectiveReason = EditionSyncDisabledReason | "not_selected" | "excluded" | "not_eligible";

export interface EditionSyncSettings {
  enabled: boolean;
  effectiveEnabled: boolean;
  disabledReason: EditionSyncDisabledReason | null;
  bookSyncMode: EditionSyncBookSyncMode;
}

export interface UpsertEditionSyncSettingsPayload {
  enabled?: boolean;
  bookSyncMode?: EditionSyncBookSyncMode;
}

/** `queued` is derived (eligible, wanted, no usable row); the other states are stored. */
export type EditionSyncIndexStatus = "none" | "queued" | "running" | "ready" | "failed" | "stale";
/** Values of `edition_sync_book_index.status`. */
export type EditionSyncStoredIndexStatus = "running" | "ready" | "failed" | "stale";
export type EditionSyncInvalidatedReason =
  "audio_changed" | "epub_changed" | "file_missing" | "files_changed" | "index_missing" | "yielded" | "interrupted";

/** When a book's files change: queue it for the next scheduled run, or re-index once the files stop changing. */
export const EDITION_SYNC_FILES_CHANGED_MODES = ["next_run", "immediate"] as const;
export type EditionSyncFilesChangedMode = (typeof EDITION_SYNC_FILES_CHANGED_MODES)[number];

export interface EditionSyncIndexState {
  status: EditionSyncIndexStatus;
  /** Set while running. */
  stage: ReadAloudWorkerStage | null;
  progress: number | null;
  /** Set while queued: 1-based position and when the next scheduled run starts. */
  queuePosition: number | null;
  nextRunAt: string | null;
  indexedAt: string | null;
  indexFileId: number | null;
  sentences: number | null;
  matchedSentences: number | null;
  failedAt: string | null;
  errorCode: ReadAloudErrorCode | null;
  error: string | null;
  attemptCount: number;
  /** Failed, and the Whisper alignment is used instead. */
  whisperFallback: boolean;
  workerVersion: string | null;
}

export interface EditionSyncBookState {
  bookId: number;
  eligible: boolean;
  /** Content editions of the book: 2 (ebook + audiobook) or 3 with a read-aloud EPUB. */
  editionCount: number;
  hasReadAlong: boolean;
  hasAudio: boolean;
  pinned: boolean;
  runActive: boolean;
  syncOverride: EditionSyncOverride;
  syncEnabled: boolean;
  effectiveReason: EditionSyncEffectiveReason | null;
  /** Some permitted, enabled user wants this book's index. */
  wanted: boolean;
  index: EditionSyncIndexState;
  canRunNow: boolean;
  canRetry: boolean;
}

export interface UpdateEditionSyncBookStatePayload {
  syncEnabled: boolean;
}

export interface EditionSyncAdminSettings {
  /** Five-field cron in the server time zone; null means Never (manual runs only). */
  cronExpression: string | null;
  runHours: number;
  onFilesChanged: EditionSyncFilesChangedMode;
  updatedAt: string | null;
}

export interface UpdateEditionSyncAdminSettingsPayload {
  cronExpression?: string | null;
  runHours?: number;
  onFilesChanged?: EditionSyncFilesChangedMode;
}

export type EditionSyncWorkerState = "ok" | "unreachable" | "incompatible" | "not_configured";
export type EditionSyncRunTrigger = "scheduled" | "manual" | "toggle";
export type EditionSyncRunStopReason = "empty" | "window_closed" | "stopped" | "worker_unavailable" | "error";

export interface EditionSyncAdminStatus {
  worker: {
    configured: boolean;
    state: EditionSyncWorkerState;
    version: string | null;
    device: string | null;
    rebuildSupported: boolean;
  };
  schedule: EditionSyncAdminSettings & { nextRunAt: string | null };
  run: {
    active: boolean;
    trigger: EditionSyncRunTrigger | null;
    startedAt: string | null;
    windowUntil: string | null;
    current: { bookId: number; title: string; stage: ReadAloudWorkerStage | null; progress: number } | null;
  };
  counts: { indexed: number; queued: number; failed: number; stale: number; unusedIndexes: number; unusedBytes: number };
  backlogEstimate: { books: number; hoursAtRecentRate: number | null };
}

export interface EditionSyncClearUnusedResult {
  deleted: number;
  freedBytes: number;
}

// Worker protocol extension (fork). An upstream worker drops the unknown `rebuild` field and runs
// the full pipeline, so a fork server talking to an upstream worker degrades instead of failing.
export interface ReadAloudRebuildChunk {
  /** File name under the job's `processed-audio/` folder. */
  name: string;
  size: number;
  sha256: string;
  audioMd5?: string;
}

export interface ReadAloudRebuildAudioEntry {
  /** Zip path of the audio entry inside the EPUB. */
  href: string;
  /** `ReadAloudRebuildChunk.name` whose bytes fill that entry. */
  chunk: string;
}

export interface ReadAloudRebuildSourceEntry {
  href: string;
  size: number;
  crc32: number;
  /** How many of the index's own entries (timing files excluded) came before it in the aligned EPUB. */
  position?: number;
}

export interface ReadAloudRebuildRequest {
  /** Index EPUB inside the job's work folder, relative to it. */
  indexEntry: string;
  /** Zip path of the stored report inside the index EPUB. */
  reportEntry: string;
  chunks: ReadAloudRebuildChunk[];
  audioEntries: ReadAloudRebuildAudioEntry[];
  sourceEntries?: ReadAloudRebuildSourceEntry[];
  chapterFingerprint?: string;
}

export const READ_ALOUD_REBUILD_MAX_CHUNKS = 10_000;

export type ReadAloudWorkerRebuildRequest = ReadAloudWorkerRequest & { rebuild: ReadAloudRebuildRequest | null };
export type ReadAloudWorkerForkHealth = ReadAloudWorkerHealth & { rebuild?: boolean; rebuildMetadata?: boolean };

export interface EditionSyncProvenanceFile {
  bookFileId: number;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  fileHash: string | null;
}

export interface EditionSyncProvenanceSource {
  /** Processed chunk name the `.source.json` describes. */
  name: string;
  source: string;
  sourceSize: number;
  start: number;
  end: number;
  title: string | null;
}

export interface EditionSyncProvenance {
  version: 1;
  bookId: number;
  workerVersion: string | null;
  language: string;
  granularity: ReadAloudGranularity;
  model: "quartznet15x5";
  epub: EditionSyncProvenanceFile & { chapterFingerprint?: string };
  audio: Array<EditionSyncProvenanceFile & { order: number; audioFingerprint?: string }>;
  sources: EditionSyncProvenanceSource[];
  chunks: ReadAloudRebuildChunk[];
  audioEntries: Array<ReadAloudRebuildAudioEntry & { size: number }>;
  sourceEntries?: ReadAloudRebuildSourceEntry[];
  report: ReadAloudReportSummary;
  decisions: ReadAloudDecisions;
  createdAt: string;
}
