import type { EditionSyncInvalidatedReason, EditionSyncOverride, EditionSyncProvenance, ReadAloudErrorCode } from '@bookorbit/types';

import type { EditionSyncBookIndexRow, EditionSyncUserSettingsRow } from './schema/edition-sync.schema';

/** A `book_files` row as the index store and provenance checks read it. */
export interface EditionSyncBookFileRef {
  id: number;
  bookId: number;
  absolutePath: string;
  format: string | null;
  role: string;
  sizeBytes: number | null;
  fileHash: string | null;
  mtime: Date | null;
  durationSeconds: number | null;
  mediaOverlayAvailable: boolean;
}

/** Everything an index job needs about a book, read in one go by the repository. */
export interface EditionSyncIndexSource {
  bookId: number;
  title: string;
  language: string | null;
  libraryId: number;
  /** The plain EPUB (content role, no media overlay). */
  epub: EditionSyncBookFileRef;
  /** Audio content files in storage order; play order comes from `AudioPlayOrderService`. */
  audio: EditionSyncBookFileRef[];
}

/** Book-level facts the policy and the card need: eligibility and how many content editions exist. */
export interface EditionSyncEligibility {
  bookId: number;
  eligible: boolean;
  /** Content editions: plain EPUB + audiobook = 2, plus a read-aloud EPUB = 3. */
  editionCount: number;
  hasReadAlong: boolean;
  hasAudio: boolean;
  libraryId: number;
}

/** What the overlay resolver reads for one user and book, in one indexed query. */
export interface EditionSyncResolverInputs {
  settings: EditionSyncUserSettingsRow | null;
  override: EditionSyncOverride;
  index: Pick<EditionSyncBookIndexRow, 'status' | 'indexFileId' | 'indexPath' | 'provenance' | 'invalidatedAt'> | null;
}

/** A book the queue handed to the scheduler; its row is already `running` with this worker job id. */
export interface EditionSyncClaim {
  bookId: number;
  /** Reused from the previous attempt while its work folder exists (resume), else a new UUID v4. */
  workerJobId: string;
  pinned: boolean;
}

/**
 * Result of one index job. The indexer writes the row for every outcome (ready, failed, stale with
 * reason `yielded`); the scheduler only counts outcomes into the run.
 */
export interface EditionSyncIndexOutcome {
  bookId: number;
  workerJobId: string;
  status: 'ready' | 'failed' | 'yielded' | 'cancelled';
  durationMs: number;
  /** Seconds of audio indexed, for the backlog estimate; null unless ready. */
  audioSeconds: number | null;
  errorCode: ReadAloudErrorCode | null;
  error: string | null;
}

export interface EditionSyncIndexJobOptions {
  /** Polled while the worker runs; true cancels the job, keeps its folder and marks the row stale (`yielded`). */
  shouldYield(): Promise<boolean>;
  shouldStop(): boolean;
}

export interface EditionSyncCaptureInput {
  bookId: number;
  /** The worker job folder holding output.epub, report.json and processed-audio/. */
  workDir: string;
  /** The request the job ran with (epub/audio paths, language, granularity, decisions). */
  request: {
    epubPath: string;
    audioPaths: string[];
    language: string;
    granularity: EditionSyncProvenance['granularity'];
    model: EditionSyncProvenance['model'];
    decisions: EditionSyncProvenance['decisions'];
  };
  sources: { epub: EditionSyncBookFileRef; audio: EditionSyncBookFileRef[] };
  workerVersion: string | null;
}

export interface EditionSyncCaptureResult {
  indexPath: string;
  indexBytes: number;
  provenance: EditionSyncProvenance;
}

export type EditionSyncVerification = { valid: true } | { valid: false; reason: EditionSyncInvalidatedReason; canCheckContent?: boolean };
