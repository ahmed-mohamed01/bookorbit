// Fork: Convert to M4B. Joins a book's MP3 (or other audio) files into one M4B with exact seeking,
// embedded chapters, tags and cover. See server/src/modules/audio-convert.

/** `auto` copies the audio when every file shares codec, sample rate and channels, otherwise encodes AAC. */
export const AUDIO_CONVERT_CODECS = ["auto", "copy", "aac"] as const;
export type AudioConvertCodec = (typeof AUDIO_CONVERT_CODECS)[number];
export type AudioConvertResolvedCodec = "copy" | "aac";

export const AUDIO_CONVERT_BITRATES = ["32k", "64k", "96k", "128k", "160k", "192k"] as const;
export type AudioConvertBitrate = (typeof AUDIO_CONVERT_BITRATES)[number];
/** `null` keeps the source channel count. */
export type AudioConvertChannels = 1 | 2 | null;

export const AUDIO_CONVERT_BACKUP_DAYS_MIN = 0;
export const AUDIO_CONVERT_BACKUP_DAYS_MAX = 365;
export const AUDIO_CONVERT_DEFAULT_BACKUP_DAYS = 14;
/** New books wait this long after their last file appears before the pipeline starts. */
export const AUDIO_CONVERT_NEW_BOOK_QUIET_MINUTES = 10;

export interface AudioConvertEncoderOptions {
  codec: AudioConvertCodec;
  bitrate: AudioConvertBitrate;
  channels: AudioConvertChannels;
}

/** `GET audio-convert/enabled`: any signed-in user. `encoder` is the saved default, so a manager without settings access sees the real one. */
export interface AudioConvertEnabledResponse {
  enabled: boolean;
  encoder: AudioConvertEncoderOptions;
}

export interface AudioConvertSettings extends AudioConvertEncoderOptions {
  /** Tool on/off. Off hides the Tools tab and book button and stops new jobs. */
  enabled: boolean;
  /** New MP3 books: fill metadata, fetch chapters, then convert. */
  autoConvert: boolean;
  embedChapters: boolean;
  /** Title, authors, series, narrators, description and cover. */
  embedMetadata: boolean;
  /** Originals are kept this many days, then deleted. 0 deletes them once the conversion is verified. */
  backupDays: number;
  updatedAt: string | null;
}

export type UpdateAudioConvertSettingsPayload = Partial<Omit<AudioConvertSettings, "updatedAt">>;

export type AudioConvertJobTrigger = "manual" | "book_page" | "auto";
export type AudioConvertJobStatus = "waiting" | "queued" | "running" | "success" | "failed" | "skipped" | "cancelled";
export const AUDIO_CONVERT_ACTIVE_STATUSES = ["waiting", "queued", "running"] as const satisfies readonly AudioConvertJobStatus[];
/** `metadata` and `chapters` only run for new books (trigger `auto`). */
export type AudioConvertJobStage = "metadata" | "chapters" | "ready" | "converting" | "swapping";

export type AudioConvertChapterOutcome = "applied" | "review" | "not_found" | "skipped" | "failed";
export type AudioConvertMetadataOutcome = "fetched" | "already_fetched" | "failed" | "timed_out";

export type AudioConvertErrorCode =
  | "book_missing"
  | "no_audio"
  | "already_converted"
  | "mixed_formats_with_m4b"
  | "folder_not_writable"
  | "low_disk"
  | "probe_failed"
  | "ffmpeg_failed"
  | "verify_failed"
  | "backup_failed"
  | "swap_failed"
  | "files_changed"
  | "interrupted"
  | "disabled";

export interface AudioConvertJobResult {
  filesMerged: number;
  sourceBytes: number;
  outputBytes: number;
  sourceDurationMs: number;
  outputDurationMs: number;
  chapters: number;
  codec: AudioConvertResolvedCodec;
  outputPath: string;
  metadata?: AudioConvertMetadataOutcome;
  chaptersLookup?: AudioConvertChapterOutcome;
  warnings: string[];
}

export interface AudioConvertJob {
  id: string;
  bookId: number;
  libraryId: number;
  title: string;
  trigger: AudioConvertJobTrigger;
  status: AudioConvertJobStatus;
  stage: AudioConvertJobStage | null;
  /** 0–100 while converting. */
  progress: number | null;
  /** For waiting jobs: when the next pipeline step runs. */
  nextStepAt: string | null;
  codec: AudioConvertResolvedCodec | null;
  errorCode: AudioConvertErrorCode | null;
  errorMessage: string | null;
  result: Partial<AudioConvertJobResult> | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** `waiting`: a new book in the automatic pipeline. `cannot`: see `reason`. */
export type AudioConvertPlanStatus = "can_convert" | "waiting" | "converted" | "cannot";
export type AudioConvertCannotReason = "no_audio" | "mixed_formats_with_m4b" | "folder_not_writable" | "low_disk" | "probe_failed";
export type AudioConvertCodecReason = "all_match" | "mixed_codecs" | "mixed_sample_rates" | "mixed_channels" | "not_aac_compatible";

export interface AudioConvertPlanFile {
  fileId: number;
  relativePath: string;
  format: string;
  sizeBytes: number;
  durationMs: number | null;
  codec: string | null;
  sampleRate: number | null;
  channels: number | null;
  bitrateKbps: number | null;
}

export interface AudioConvertPlan {
  bookId: number;
  status: AudioConvertPlanStatus;
  reason: AudioConvertCannotReason | null;
  files: AudioConvertPlanFile[];
  /** Name the M4B will get, beside the first file. */
  outputName: string | null;
  /** Codec the default (Auto) would pick, and why. */
  autoCodec: AudioConvertResolvedCodec | null;
  autoCodecReason: AudioConvertCodecReason | null;
  totalBytes: number;
  totalDurationMs: number | null;
  chapterCount: number;
  chapterSource: "embedded" | "stored" | "per_file" | "none";
  hasCover: boolean;
  /** Users with a saved position or bookmarks in this book: they are moved to the new file. */
  listenersWithProgress: number;
  bookmarkCount: number;
  /** The read-along index is rebuilt after a merge; a single-file copy keeps it. */
  hasReadAlong: boolean;
  latestJob: AudioConvertJob | null;
}

export interface AudioConvertPreviewItem {
  bookId: number;
  title: string;
  authors: string[];
  /** Folder of the book, relative to the library root. */
  relativeFolder: string;
  status: AudioConvertPlanStatus;
  reason: AudioConvertCannotReason | null;
  fileCount: number;
  formats: string[];
  totalBytes: number;
  totalDurationSeconds: number | null;
  job: AudioConvertJob | null;
}

export interface AudioConvertPreviewPage {
  items: AudioConvertPreviewItem[];
  total: number;
  totalByStatus: Record<AudioConvertPlanStatus, number>;
}

/**
 * Narrowed the same way as BulkRenameExecuteRequest. `search` matches the same books as the preview's
 * `search`. Encoder fields override the saved defaults for this run; omitted ones use the saved defaults.
 */
export interface AudioConvertRunRequest extends Partial<AudioConvertEncoderOptions> {
  excludeBookIds?: number[];
  includeBookIds?: number[];
  search?: string;
}

export interface AudioConvertBookRunRequest extends Partial<AudioConvertEncoderOptions> {}

export interface AudioConvertRunResponse {
  queued: number;
  skipped: number;
}

export interface AudioConvertStatus {
  /** Jobs that are waiting, queued or running, plus jobs that finished in the last hour. */
  jobs: AudioConvertJob[];
  active: number;
}
