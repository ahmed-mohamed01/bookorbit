import type { WebSerialChapterRange, WebSerialEngineHealth, WebSerialKind, WebSerialPackaging, WebSerialSeriesStatus } from '@bookorbit/types';

/** Manga `allowedSources` entries with this prefix are Suwayomi source ids; bare entries are language codes. */
export const SOURCE_ID_PREFIX = 'source:';

export interface EngineConnection {
  url: string;
  username: string | null;
  password: string | null;
  /** Optional lncrawl profile used only when LNReader cannot resolve a pasted link. */
  fallback?: EngineConnection;
  /** The LNReader service has a Cloudflare solver, so its sources can take much longer to answer. Unknown counts as false. */
  solver?: boolean;
}

export interface EngineSeriesRef {
  kind: WebSerialKind;
  remoteId: string;
}

export interface EngineSearchHit {
  remoteId: string | null;
  url: string | null;
  title: string;
  author: string | null;
  remoteCoverPath: string | null;
  sourceName: string;
  chapterCount: number | null;
  status: WebSerialSeriesStatus;
  mtl?: boolean;
}

export interface EngineUnitSpec {
  unitKey: string;
  label: string;
  sequence: string;
  chapterCount: number;
  publishedAt: string | null;
  volume?: string | null;
  packaging: WebSerialPackaging;
  remote: Record<string, unknown>;
  /** First and last chapter the unit holds: chapter numbers for manga, positions in the chapter list for novels. */
  chapterRange?: WebSerialChapterRange | null;
  /** A manga extra without a chapter number; its sequence only places it, so it never identifies the chapter. */
  positional?: boolean;
}

export interface EngineSeries {
  kind: WebSerialKind;
  title: string;
  author: string | null;
  authors: string[];
  /** Credited artists, kept apart from authors so the importer can fill the penciller field. */
  artists?: string[];
  synopsis: string | null;
  tags: string[];
  language: string | null;
  remoteCoverPath: string | null;
  sourceName: string;
  /** The engine's id for the source site, when it has one; used to enforce the admin source selection. */
  sourceId?: string | null;
  sourceUrl: string | null;
  status: WebSerialSeriesStatus;
  chapterCount: number;
  units: EngineUnitSpec[];
  packagingOptions: WebSerialPackaging[];
  defaultPackaging: WebSerialPackaging;
}

export interface EngineUnitHandle {
  unitKey: string;
  remote: Record<string, unknown>;
}

export interface EngineUnitRunningProgress {
  state: 'pending' | 'running';
  progress: number | null;
  chaptersDone?: number;
  chaptersTotal?: number;
  stage?: 'fetching' | 'building';
}

export type EngineUnitProgress = EngineUnitRunningProgress | { state: 'done' } | { state: 'failed'; reason: string };

export interface EngineDownload {
  stream: NodeJS.ReadableStream | ReadableStream;
  fileName: string;
  format: 'cbz' | 'epub';
  size: number | null;
  /** Titles of chapters the source never delivered; the book carries a notice in their place. */
  missingChapters?: string[];
}

export interface EngineSeriesOptions {
  /** Which of the engine's queues the call waits in: a person waiting on it, or background work. */
  priority?: 'interactive' | 'bulk';
  /** Ends the load early: a job paused, cancelled or shut down while its series still loads. */
  signal?: AbortSignal;
}

export interface EngineDownloadOptions {
  /** Checked between chapters; true ends the download with UnitDownloadStopped, keeping what is already fetched. */
  shouldStop?: () => Promise<boolean>;
  /** The unit's last attempt: chapters the source never delivers become a notice in the book instead of failing it. */
  allowMissingChapters?: boolean;
}

/** The job was paused or moved while a chapter-by-chapter download was running. */
export class UnitDownloadStopped extends Error {}

/** Some chapters could not be fetched; the ones that were stay on disk for the next attempt. */
export class MissingChaptersError extends Error {
  constructor(
    readonly chapters: string[],
    message = `${chapters.length} chapter${chapters.length === 1 ? '' : 's'} could not be fetched`,
  ) {
    super(message);
  }
}

/** So many chapters failed that the book would be mostly notice pages; it is never filed, whatever the attempt. */
export class TooManyMissingChaptersError extends MissingChaptersError {
  constructor(chapters: string[], total: number) {
    super(chapters, `${chapters.length} of ${total} chapters could not be fetched, too many to file this volume`);
  }
}

export type EngineDownloadProgress = (progress: {
  chaptersDone: number;
  chaptersTotal: number;
  stage: 'fetching' | 'building';
}) => void | Promise<void>;

export interface WebSerialEngineClient {
  readonly kind: WebSerialKind;
  readonly requiresUnitWorkDir?: boolean;
  health(conn: EngineConnection, allowedSources: string[]): Promise<WebSerialEngineHealth>;
  search(
    conn: EngineConnection,
    query: string,
    allowedSources: string[],
    signal?: AbortSignal,
  ): Promise<{ hits: EngineSearchHit[]; failedSources: string[] }>;
  resolveUrl(conn: EngineConnection, url: string): Promise<EngineSeriesRef | null>;
  getSeries(conn: EngineConnection, remoteId: string, options?: EngineSeriesOptions): Promise<EngineSeries>;
  startUnit(conn: EngineConnection, remoteId: string, unit: EngineUnitSpec): Promise<EngineUnitHandle>;
  pollUnit(conn: EngineConnection, handle: EngineUnitHandle): Promise<EngineUnitProgress>;
  download(
    conn: EngineConnection,
    handle: EngineUnitHandle,
    signal?: AbortSignal,
    onProgress?: EngineDownloadProgress,
    options?: EngineDownloadOptions,
  ): Promise<EngineDownload>;
  /** Best effort: stops the engine work behind a handle and never throws. */
  cancelUnit?(conn: EngineConnection, handle: EngineUnitHandle): Promise<void>;
  /** Best effort: removes the engine's own downloaded copy of units BookOrbit has finished with. Throws when the engine refuses. */
  discardUnit?(conn: EngineConnection, handles: EngineUnitHandle[]): Promise<void>;
  fetchCover(conn: EngineConnection, remoteCoverPath: string): Promise<{ body: Buffer; contentType: string }>;
}
