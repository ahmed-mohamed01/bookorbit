// Contract between the Storyteller HTTP client and its consumers (settings test, read-along build).
// Verified against Storyteller's v2 API (`applications/web/src/app/api/v2` on main, 2026-09-22) and
// BookBridge's client. Shapes that Storyteller does not pin (book JSON, processing status) are
// normalized here so consumers never read raw Storyteller fields.

import type { StorytellerReadaloudLocationType } from '@bookorbit/types';

export interface StorytellerConnection {
  serverUrl: string;
  username: string;
  password: string;
}

export interface StorytellerServerInfo {
  version: string | null;
  capabilities: string[];
}

export interface StorytellerRemoteSettings {
  readaloudLocationType: StorytellerReadaloudLocationType | null;
  readaloudLocation: string | null;
  importMode: string | null;
  aligner: string | null;
}

export type StorytellerProcessingState = 'idle' | 'running' | 'completed' | 'failed' | 'unknown';

export interface StorytellerProcessingStatus {
  state: StorytellerProcessingState;
  task: string | null;
  /** 0..1 when Storyteller reports a fraction, else null. */
  progress: number | null;
  error: string | null;
}

export interface StorytellerBookSummary {
  uuid: string;
  title: string;
  authors: string[];
  /** ISBN/ASIN style identifiers as Storyteller reports them, lowercased, without separators. */
  identifiers: string[];
  aligned: boolean;
  /** A linked media file with a path, not flagged missing - presence of the link alone is not enough. */
  hasEbook: boolean;
  hasAudiobook: boolean;
  /** In Storyteller's own path space, so callers map it back with `toLocalPath`. */
  readaloudPath: string | null;
  processing: StorytellerProcessingStatus;
}

export type StorytellerImportMode = 'reference' | 'copy' | 'move' | 'hardlink';

export interface StorytellerImportByReferenceInput {
  /** Paths as the Storyteller server sees them. Audio files must sit directly under one directory. */
  paths: string[];
  importMode: StorytellerImportMode;
  collectionUuid?: string;
  epub2Strategy?: string;
}

export type StorytellerImportResult = { kind: 'created'; uuid: string } | { kind: 'epub2_detected'; paths: string[] };

export interface StorytellerUploadInput {
  epubPath: string;
  audioPaths: string[];
  collectionUuid?: string;
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
}

export interface StorytellerBookListOptions {
  alignedOnly?: boolean;
  /** Title/author text, matched by Storyteller rather than by pulling the library over and filtering here. */
  search?: string;
  limit?: number;
}

/**
 * Bound to one connection and owning its token cache: minted lazily, refreshed once on a 401, never
 * logged. Every method throws `StorytellerClientError` on a non-success response.
 */
export interface StorytellerSession {
  getServerInfo(): Promise<StorytellerServerInfo>;
  getSettings(): Promise<StorytellerRemoteSettings>;
  listBooks(options?: StorytellerBookListOptions): Promise<StorytellerBookSummary[]>;
  getBook(uuid: string): Promise<StorytellerBookSummary | null>;
  importByReference(input: StorytellerImportByReferenceInput): Promise<StorytellerImportResult>;
  uploadBook(input: StorytellerUploadInput): Promise<{ uuid: string }>;
  process(uuid: string): Promise<void>;
  readaloudAvailable(uuid: string): Promise<boolean>;
  downloadReadaloud(uuid: string, destinationPath: string): Promise<void>;
  /** Pairs separately imported books into one. Storyteller allows 2-3, at most one of each format. */
  mergeBooks(uuids: string[]): Promise<{ uuid: string }>;
  deleteBook(uuid: string, options?: { preventReImport?: boolean }): Promise<void>;
  /** Drops Storyteller's processing cache (transcoded audio, transcriptions). Never the originals. */
  deleteCache(uuid: string): Promise<void>;
  ensureCollection(name: string): Promise<string | null>;
}

export interface StorytellerClientTimeouts {
  /** One request, and the idle gap a streaming transfer may have between chunks. */
  requestTimeoutMs: number;
  /** Ceiling for one whole upload or download. */
  transferTimeoutMs: number;
}

export interface StorytellerClient {
  createSession(connection: StorytellerConnection): StorytellerSession;
}
