import { Inject, Injectable, InternalServerErrorException, Logger, NotFoundException, Optional } from '@nestjs/common';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { Readable } from 'stream';

import {
  EDITION_SYNC_INDEX_EXTENSION,
  isAudioFormat,
  type EditionSyncProvenance,
  type EpubBookInfo,
  type EpubMediaOverlayPlaylist,
} from '@bookorbit/types';
import { BookReadService } from '../../book/book-read.service';
import { OVERLAY_SOURCE_RESOLVER, type OverlaySourceCandidate, type OverlaySourceResolver } from '../../book/overlay-source-provider';
import type { RequestUser } from '../../../common/types/request-user';
import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import {
  buildIndexNarration,
  indexAudioFileId,
  indexAudioHref,
  indexAudioMimeType,
  provenanceSourceAudioFileIds,
  readIndexProvenance,
  type IndexNarration,
} from './epub-index-narration';
import type { ByteRange } from './epub-zip-range';

const MAX_INDEX_PLAYLISTS = 8;
export const FAILED_INDEX_BUILD_TTL_MS = 60_000;
const MISSING_FILE_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);

/** The plain EPUB a request reads: its book, the file asked for (null for the primary), its parsed copy. */
export interface IndexNarrationRequest {
  bookId: number;
  fileId: number | null;
  epub: { info: EpubBookInfo; mtime: number };
  user: RequestUser;
}

export type ByteRangeParser = (header: string | undefined, size: number) => ByteRange | 'unsatisfiable' | null;

export interface IndexAudioConditions {
  range?: string;
  ifRange?: string;
  ifNoneMatch?: string;
}

interface IndexAudioResponse {
  status: 200 | 206 | 304 | 416;
  contentType: string;
  /** The whole file's size. */
  size: number;
  /** The bytes served, or null when no body is sent. */
  served: ByteRange | null;
  contentRange: string | null;
  etag: string;
  absolutePath: string;
}

interface LocatedIndex {
  fileId: number;
  index: OverlaySourceCandidate;
  audio: OverlaySourceCandidate[];
}

interface IndexStat {
  mtimeMs: number;
  size: number;
}

interface BuildEntry {
  narration: Promise<IndexNarration | null>;
  expiresAt: number;
  /** Pending until the build settles; `none` when it read nothing along or failed. */
  state: 'pending' | 'built' | 'none';
}

/** The parts of an index's provenance the service checks, parsed once per index file version. */
interface ProvenanceEntry {
  epubFileId: number | null;
  /** The audiobook files the index's sources were cut from. */
  audioFileIds: Set<number>;
}

const isMissingFile = (err: unknown) => MISSING_FILE_CODES.has((err as NodeJS.ErrnoException)?.code ?? '');

/** Reads `key` from a bounded map, moving it to the newest end so the least recently used goes first. */
function touch<V>(map: Map<string, V>, key: string): V | undefined {
  const value = map.get(key);
  if (value !== undefined) {
    map.delete(key);
    map.set(key, value);
  }
  return value;
}

function remember<V>(map: Map<string, V>, key: string, value: V) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_INDEX_PLAYLISTS) map.delete(map.keys().next().value!);
}

const errorClass = (err: unknown) => (err instanceof Error ? err.name : 'Error');
const errorMessage = (err: unknown) => sanitizeLogValue(err instanceof Error ? err.message : String(err));

/**
 * Fork: read along for a plain EPUB from its book's edition sync timing index, for a reader the
 * index serves (edition sync on for them and the book, the index ready and current). Only for a
 * book with an audiobook and no read-along EPUB of its own among its content files. With no
 * overlay source resolver registered the feature is off.
 */
@Injectable()
export class EpubIndexNarrationService {
  private readonly logger = new Logger(EpubIndexNarrationService.name);
  /** Builds by index file, its copy, the plain EPUB and its copy, and the audiobook's files. */
  private readonly builds = new Map<string, BuildEntry>();
  /** Parsed provenance by index file, its modification time and size. */
  private readonly provenances = new Map<string, Promise<ProvenanceEntry | null>>();

  constructor(
    private readonly bookReadService: BookReadService,
    @Optional() @Inject(OVERLAY_SOURCE_RESOLVER) private readonly overlaySource?: OverlaySourceResolver,
  ) {}

  /**
   * Whether the index reads this EPUB along, from the cheap checks and the index's provenance
   * alone. The playlist is built in the background so the reader's next request finds it ready.
   */
  async readsAlong(request: IndexNarrationRequest): Promise<boolean> {
    const started = Date.now();
    try {
      const located = await this.locate(request);
      if (!located) return false;
      const indexStat = await this.statIndex(located);
      if (!indexStat) return false;
      // A build already started answers for itself: one with nothing to read along, or failed, says no.
      const existing = this.liveBuild(this.buildKey(request, located, indexStat));
      if (existing) return existing.state !== 'none';
      if (!(await this.servesEpub(request, located, indexStat))) return false;
      void this.narration(request, located, indexStat).catch((err: unknown) => this.logFail(request, located.fileId, started, err));
      return true;
    } catch (err) {
      this.logFail(request, request.fileId, started, err);
      return false;
    }
  }

  async playlist(request: IndexNarrationRequest): Promise<EpubMediaOverlayPlaylist | null> {
    return (await this.find(request))?.playlist ?? null;
  }

  /** An audiobook file the playlist plays, for the EPUB file route. Null for any other path. */
  async streamFile(request: IndexNarrationRequest, href: string, conditions: IndexAudioConditions, parseRange: ByteRangeParser) {
    const response = await this.audioResponse(request, href, conditions, parseRange);
    if (!response) return null;
    const { status, contentType, served, contentRange, etag, absolutePath } = response;
    return {
      openBody: (): NodeJS.ReadableStream => (served ? createReadStream(absolutePath, served) : Readable.from([])),
      contentType,
      size: served ? served.end - served.start + 1 : 0,
      status,
      contentRange,
      etag,
      acceptsRanges: true,
    };
  }

  /** An audiobook file the playlist plays, for the media-overlay file route. Null for any other path. */
  async streamMediaOverlayFile(request: IndexNarrationRequest, href: string, rangeHeader: string | undefined, parseRange: ByteRangeParser) {
    const response = await this.audioResponse(request, href, { range: rangeHeader }, parseRange);
    if (!response) return null;
    const { status, contentType, size, served, contentRange, absolutePath } = response;
    return {
      body: served ? createReadStream(absolutePath, served) : Buffer.alloc(0),
      length: served ? served.end - served.start + 1 : 0,
      contentType,
      size,
      status,
      contentRange,
    };
  }

  private async audioResponse(
    request: IndexNarrationRequest,
    href: string,
    conditions: IndexAudioConditions,
    parseRange: ByteRangeParser,
  ): Promise<IndexAudioResponse | null> {
    const id = indexAudioFileId(href);
    if (id === null) return null;
    // Authorised from the cheap checks and the cached provenance, not the built playlist, so a
    // seek never waits on a rebuild: a content audiobook file the index's sources were cut from,
    // under exactly its own href.
    const located = await this.locate(request);
    if (!located) return null;
    const indexStat = await this.statIndex(located);
    if (!indexStat) return null;
    const provenance = await this.provenance(request, located, indexStat);
    if (!provenance || provenance.epubFileId !== located.fileId) return null;
    const file = located.audio.find((item) => item.id === id);
    if (!file || !provenance.audioFileIds.has(id) || indexAudioHref(file) !== href) {
      throw new NotFoundException(`Media-overlay resource not in playlist: ${href}`);
    }

    let size: number;
    let mtimeMs: number;
    try {
      ({ size, mtimeMs } = await stat(file.absolutePath));
    } catch (err) {
      if (isMissingFile(err)) throw new NotFoundException(`Audiobook file not found: ${href}`);
      throw new InternalServerErrorException(`Audiobook file could not be read: ${href}`);
    }
    const etag = `"bo-audio-${file.id}-${size}-${Math.trunc(mtimeMs)}"`;
    const base = { contentType: indexAudioMimeType(file.absolutePath), size, etag, absolutePath: file.absolutePath };
    const parsed = parseRange(conditions.range, size);
    const range = parsed && (!conditions.ifRange || conditions.ifRange === etag) ? parsed : null;
    if (range === 'unsatisfiable') return { ...base, status: 416, served: null, contentRange: `bytes */${size}` };
    if (!range && conditions.ifNoneMatch === etag) return { ...base, status: 304, served: null, contentRange: null };
    if (!range) return { ...base, status: 200, served: size > 0 ? { start: 0, end: size - 1 } : null, contentRange: null };
    return { ...base, status: 206, served: range, contentRange: `bytes ${range.start}-${range.end}/${size}` };
  }

  /** The narration, or null when the index does not read this EPUB along or cannot be built. */
  private async find(request: IndexNarrationRequest): Promise<IndexNarration | null> {
    const started = Date.now();
    let fileId = request.fileId;
    try {
      const located = await this.locate(request);
      if (!located) return null;
      fileId = located.fileId;
      // A missing index is no build attempt, so it is not logged as a failed one.
      const indexStat = await this.statIndex(located);
      if (!indexStat) return null;
      return await this.narration(request, located, indexStat);
    } catch (err) {
      this.logFail(request, fileId, started, err);
      return null;
    }
  }

  private async locate({ bookId, fileId, epub, user }: IndexNarrationRequest): Promise<LocatedIndex | null> {
    if (!this.overlaySource) return null;
    if (epub.info.manifest.some((item) => item.mediaOverlay)) return null;
    const sync = await this.bookReadService.findAudioEbookProgressSyncFiles(bookId);
    if (!sync) return null;
    const plainFileId = fileId ?? sync.primaryFileId;
    if (plainFileId == null) return null;
    const content = sync.files.filter((file) => file.role === 'content');
    if (content.some((file) => file.format?.toLowerCase() === 'epub' && file.mediaOverlayAvailable)) return null;
    const audio = content.filter((file) => typeof file.format === 'string' && isAudioFormat(file.format));
    if (audio.length === 0) return null;
    const index = await this.overlaySource.resolveOverlaySource(user.id, bookId, sync.files);
    if (!index || index.format !== EDITION_SYNC_INDEX_EXTENSION) return null;
    return { fileId: plainFileId, index, audio };
  }

  /** The build for this index and EPUB, started once; a failed one is kept briefly, then retried. */
  private narration(request: IndexNarrationRequest, located: LocatedIndex, indexStat: IndexStat): Promise<IndexNarration | null> {
    const { index, audio, fileId } = located;
    const key = this.buildKey(request, located, indexStat);
    const existing = this.liveBuild(key);
    if (existing) return existing.narration;

    const started = Date.now();
    this.logger.log(
      `[epub.index_narration] [start] bookId=${request.bookId} fileId=${fileId} userId=${request.user.id} indexFileId=${index.id} - building timing index read along`,
    );
    const entry: BuildEntry = { narration: Promise.resolve(null), expiresAt: Number.POSITIVE_INFINITY, state: 'pending' };
    entry.narration = buildIndexNarration({
      indexPath: index.absolutePath,
      plainInfo: request.epub.info,
      bookId: request.bookId,
      fileId,
      audioFiles: audio.map((file) => ({ id: file.id, absolutePath: file.absolutePath })),
    }).then(
      (narration) => {
        this.logger.log(
          `[epub.index_narration] [end] bookId=${request.bookId} fileId=${fileId} userId=${request.user.id} indexFileId=${index.id} durationMs=${Date.now() - started} built=${narration !== null} sentences=${narration?.playlist.items.length ?? 0} - ${narration ? 'timing index read along built' : 'timing index has no read along for this EPUB'}`,
        );
        entry.state = narration ? 'built' : 'none';
        return narration;
      },
      (err: unknown) => {
        this.logFail(request, fileId, started, err);
        entry.state = 'none';
        entry.expiresAt = Date.now() + FAILED_INDEX_BUILD_TTL_MS;
        return null;
      },
    );
    remember(this.builds, key, entry);
    return entry.narration;
  }

  /** The index file's version, or null when it is gone. */
  private async statIndex({ index }: LocatedIndex): Promise<IndexStat | null> {
    try {
      const { mtimeMs, size } = await stat(index.absolutePath);
      return { mtimeMs, size };
    } catch (err) {
      if (isMissingFile(err)) return null;
      throw err;
    }
  }

  /** Builds by index file version, the plain EPUB and its copy, and each audiobook file and its path. */
  private buildKey(request: IndexNarrationRequest, { index, audio, fileId }: LocatedIndex, indexStat: IndexStat): string {
    return JSON.stringify([
      index.absolutePath,
      indexStat.mtimeMs,
      indexStat.size,
      fileId,
      request.epub.mtime,
      audio.map((file) => [file.id, file.absolutePath]),
    ]);
  }

  /** The build for `key` while it is current, refreshed as the most recently used. */
  private liveBuild(key: string): BuildEntry | undefined {
    const entry = touch(this.builds, key);
    if (entry && entry.expiresAt <= Date.now()) {
      this.builds.delete(key);
      return undefined;
    }
    return entry;
  }

  private async servesEpub(request: IndexNarrationRequest, located: LocatedIndex, indexStat: IndexStat): Promise<boolean> {
    return (await this.provenance(request, located, indexStat))?.epubFileId === located.fileId;
  }

  /**
   * The index's provenance, read once per index file version. A corrupt index stays null until the
   * file changes; one removed while it was read is read again next time.
   */
  private provenance(request: IndexNarrationRequest, { index, fileId }: LocatedIndex, indexStat: IndexStat): Promise<ProvenanceEntry | null> {
    const key = JSON.stringify([index.absolutePath, indexStat.mtimeMs, indexStat.size]);
    const cached = touch(this.provenances, key);
    if (cached) return cached;
    const started = Date.now();
    const read = readIndexProvenance(index.absolutePath).then(
      (provenance: EditionSyncProvenance | null) =>
        provenance && {
          epubFileId: provenance.epub?.bookFileId ?? null,
          audioFileIds: provenanceSourceAudioFileIds(provenance),
        },
      (err: unknown) => {
        if (isMissingFile(err)) this.provenances.delete(key);
        else this.logFail(request, fileId, started, err);
        return null;
      },
    );
    remember(this.provenances, key, read);
    return read;
  }

  private logFail(request: IndexNarrationRequest, fileId: number | null, started: number, err: unknown) {
    this.logger.warn(
      `[epub.index_narration] [fail] bookId=${request.bookId} fileId=${fileId ?? 'primary'} userId=${request.user.id} durationMs=${Date.now() - started} errorClass=${errorClass(err)} error="${errorMessage(err)}" - timing index read along not built`,
    );
  }
}
