import { randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import { constants, copyFile, link, open, stat, unlink } from 'fs/promises';
import { basename, extname } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as WebReadableStream } from 'stream/web';
import { Inject, Injectable, Logger } from '@nestjs/common';

import type { StorytellerReadaloudLocationType } from '@bookorbit/types';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import {
  asRecord,
  normalizeBook,
  readArray,
  readBookList,
  readBoolean,
  readCapabilityKeys,
  readCapabilityList,
  readNumber,
  readString,
} from './storyteller-book-normalize.utils';
import type {
  StorytellerBookSummary,
  StorytellerClient,
  StorytellerClientTimeouts,
  StorytellerConnection,
  StorytellerImportByReferenceInput,
  StorytellerImportResult,
  StorytellerRemoteSettings,
  StorytellerServerInfo,
  StorytellerSession,
  StorytellerBookListOptions,
  StorytellerUploadInput,
} from './storyteller-client.types';
import { describeError } from './storyteller-log.utils';
import { ensureSafeStorytellerUrl } from './storyteller-url.utils';
import { storytellerConfig } from './storyteller.config';

const LOGGER_CONTEXT = 'StorytellerClientService';
const REQUEST_EVENT = 'storyteller.client';
const TOKEN_EVENT = 'storyteller.client.token';
const IMPORT_EVENT = 'storyteller.client.import';
const UPLOAD_EVENT = 'storyteller.client.upload';
const DOWNLOAD_EVENT = 'storyteller.client.download';
const RECLAIM_EVENT = 'storyteller.client.upload_reclaim';
const COLLECTION_EVENT = 'storyteller.client.collection';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TRANSFER_TIMEOUT_MS = 120 * 60_000;
/** Storyteller reports `expires_in` in milliseconds; a server that omits it is treated as hourly. */
const FALLBACK_TOKEN_TTL_MS = 60 * 60_000;
const TOKEN_EXPIRY_SKEW_MS = 30_000;
const MIN_TOKEN_TTL_MS = 60_000;
const UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024;
const UPLOAD_BODY_CHUNK_BYTES = 64 * 1024;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 200;
const MAX_ERROR_BODY_CHARS = 200;
/** Only `MAX_ERROR_BODY_CHARS` ever survive `redact`, and a reverse proxy's slow, large 502 must not be buffered. */
const MAX_ERROR_BODY_BYTES = 8 * 1024;
const ERROR_CHAIN_MAX_LINKS = 4;
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const REDACTED = '[redacted]';
const DECIMAL_INTEGER = /^\d+$/;
/** Ceiling on one catalogue page, so no caller can turn a bounded read back into a whole-library one. */
const MAX_BOOK_PAGE_SIZE = 500;

// Fixed messages: a failure explains itself without quoting a local path, a URL or a provider body.
const UPLOAD_PATH = '/api/v2/books/upload';
const UPLOAD_LOCATION_MESSAGE = 'Storyteller returned an upload location outside its own server URL';
const UPLOAD_OFFSET_MESSAGE = 'Storyteller acknowledged an unexpected upload offset';
const UPLOAD_INCOMPLETE_MESSAGE = 'The upload ended before the whole file was accepted';
const UPLOAD_CANCELLED_MESSAGE = 'The upload was cancelled';
const UPLOAD_STALLED_MESSAGE = 'The upload stalled';
const UPLOAD_CEILING_MESSAGE = 'The upload exceeded the transfer ceiling';
const LOCAL_FILE_MESSAGE = 'A file for the Storyteller upload could not be read';
const LOCAL_FILE_SHORT_MESSAGE = 'A file for the Storyteller upload ended before its expected size';
const DOWNLOAD_STALLED_MESSAGE = 'The read-along download stalled';
const DOWNLOAD_CEILING_MESSAGE = 'The read-along download exceeded the transfer ceiling';
const DOWNLOAD_PARTIAL_MESSAGE = 'Storyteller answered the read-along download with a partial body';
const DOWNLOAD_TRUNCATED_MESSAGE = 'The read-along download ended before the whole file arrived';
const DOWNLOAD_EXISTS_MESSAGE = 'A read-along file already sits at the download destination';
const DOWNLOAD_PUBLISH_MESSAGE = 'The read-along download could not be published to its destination';
const NOT_AN_ARCHIVE_MESSAGE = 'The read-along download was not an EPUB archive';
const REDIRECT_MESSAGE = 'The Storyteller server answered with an unexpected redirect';
const UNSAFE_TARGET_MESSAGE = 'The Storyteller server URL is not an allowed request target';
const RESPONSE_BODY_TIMEOUT_MESSAGE = 'The request to Storyteller timed out while reading the response body';
/** Shared with `mintToken`, so a body that cannot be read or parsed is described the same way everywhere. */
const RESPONSE_NOT_JSON_MESSAGE = 'Storyteller returned a response that is not JSON';

const READALOUD_LOCATION_TYPES: StorytellerReadaloudLocationType[] = ['SUFFIX', 'SIBLING_FOLDER', 'INTERNAL', 'CUSTOM_FOLDER'];

/** Content types a file endpoint never answers with: a login page or an error envelope, not an EPUB. */
const NON_FILE_CONTENT_TYPES = ['text/html', 'application/json'];

/**
 * The client-wide default is `application/json`, and against anything that negotiates - a gateway, a
 * CDN - asking a file route for JSON is answered with JSON (which reads as "not a file" and polls to
 * the ceiling) or refused 406. The low-q wildcard keeps an oddly labelled file offerable.
 */
const FILE_ACCEPT = 'application/epub+zip, application/zip;q=0.9, application/octet-stream;q=0.8, */*;q=0.1';

const AUDIO_MIME_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.wav': 'audio/wav',
  '.zip': 'application/zip',
  '.epub': 'application/epub+zip',
};

export class StorytellerClientError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'StorytellerClientError';
  }
}

/**
 * The reason `deadline()`'s own `AbortController` aborts with. A body read that fails for this reason
 * is a stalled or slow server, never a malformed payload or a field the server genuinely omitted, so
 * callers reading a response body after headers arrived check for this type before assuming either.
 */
class RequestDeadlineExceededError extends Error {
  constructor() {
    super('the request deadline was exceeded');
    this.name = 'RequestDeadlineExceededError';
  }
}

/** A 404 from an optional route reads as "not reported"; anything else is a real failure. */
function missingRouteToNull(err: unknown): null {
  if (err instanceof StorytellerClientError && err.status === 404) return null;
  throw err;
}

interface RequestOptions {
  method: string;
  /** Server-relative path; `url` takes precedence for the absolute upload URLs TUS hands back. */
  path?: string;
  url?: string;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  body?: BodyInit;
  duplex?: 'half';
  timeoutMs?: number;
  /** Bounded retries on network failures and 5xx. Only ever set for idempotent calls. */
  retry?: boolean;
  /** A caller-owned deadline, for a response whose body outlives the request timeout. */
  signal?: AbortSignal;
}

interface SentRequest {
  response: Response;
  method: string;
  path: string;
  durationMs: number;
}

function encodeTusMetadata(pairs: Record<string, string | undefined>): string {
  return Object.entries(pairs)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
    .map(([key, value]) => `${key} ${Buffer.from(value, 'utf8').toString('base64')}`)
    .join(',');
}

function guessFiletype(filePath: string): string {
  return AUDIO_MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** The only place a server URL is parsed. Credentials in the URL are refused, not carried along. */
function normalizeServerUrl(serverUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl.trim());
  } catch {
    throw new StorytellerClientError('The Storyteller server URL is invalid', null);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new StorytellerClientError('The Storyteller server URL must be http or https', null);
  }
  if (parsed.username || parsed.password) {
    throw new StorytellerClientError('The Storyteller server URL must not carry credentials', null);
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

function isFileResponse(response: Response): boolean {
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType) return true;
  return !NON_FILE_CONTENT_TYPES.some((type) => contentType.startsWith(type));
}

/**
 * `Content-Length` and `Upload-Offset` are both defined as decimal digits and nothing else, so the
 * parse has to be that strict: `Number` would read `0x10` as 16 and `1e3` as 1000, and those feed an
 * upload's acknowledged-offset check and a download's truncation check respectively. A header that
 * is not a plain integer is no answer at all, which is what null means to every caller here.
 */
function readIntegerHeader(response: Response, name: string): number | null {
  const raw = response.headers.get(name)?.trim();
  if (!raw || !DECIMAL_INTEGER.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function boundedLimit(limit: number | undefined): number | null {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) return null;
  return Math.min(Math.floor(limit), MAX_BOOK_PAGE_SIZE);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

class StorytellerHttpSession implements StorytellerSession {
  private readonly logger = new Logger(LOGGER_CONTEXT);
  private readonly serverUrl: string;
  private token: { value: string; expiresAt: number } | null = null;
  private readonly responseDeadlines = new WeakMap<Response, { signal: AbortSignal; clear: () => void }>();
  /** The in-flight mint, so a burst of parallel calls on a cold session asks for one token. */
  private pendingMint: Promise<string> | null = null;

  constructor(
    private readonly connection: StorytellerConnection,
    private readonly timeouts: StorytellerClientTimeouts,
  ) {
    this.serverUrl = normalizeServerUrl(connection.serverUrl);
  }

  async getServerInfo(): Promise<StorytellerServerInfo> {
    // Neither route exists on every Storyteller build, so this is best-effort reporting: the
    // connection is proved by the authenticated /api/v2/settings read that follows.
    const details = await this.getJson({ method: 'GET', path: '/api/v2/server/details' }).catch(missingRouteToNull);
    const capabilities = new Set(readCapabilityList(details));

    const features = await this.getJson({ method: 'GET', path: '/api/v2/server/capabilities' }).catch(missingRouteToNull);
    const declared = readCapabilityList(features);
    for (const capability of declared.length > 0 ? declared : readCapabilityKeys(features)) capabilities.add(capability);

    return {
      version: readString(asRecord(details) ?? {}, 'version', 'serverVersion', 'server_version'),
      capabilities: [...capabilities].sort(),
    };
  }

  async getSettings(): Promise<StorytellerRemoteSettings> {
    const payload = await this.getJson({ method: 'GET', path: '/api/v2/settings' });
    const settings = asRecord(asRecord(payload)?.settings) ?? asRecord(payload) ?? {};
    const locationType = readString(settings, 'readaloudLocationType', 'readaloud_location_type');
    const matched = READALOUD_LOCATION_TYPES.find((value) => value === (locationType ?? '').toUpperCase()) ?? null;

    return {
      readaloudLocationType: matched,
      readaloudLocation: readString(settings, 'readaloudLocation', 'readaloud_location'),
      importMode: readString(settings, 'importMode', 'import_mode'),
      aligner: readString(settings, 'aligner'),
    };
  }

  /**
   * A page of the remote catalogue, never the whole of it. `limit` is applied to the normalized
   * result as well as sent as a query parameter: only `alignedOnly` is documented on Storyteller's
   * own route, the rest are read off the `GetBooksOptions` its book query takes, so a build that
   * ignores one of them still returns a bounded list instead of a library.
   */
  async listBooks(options: StorytellerBookListOptions = {}): Promise<StorytellerBookSummary[]> {
    const limit = boundedLimit(options.limit);
    const payload = await this.getJson({
      method: 'GET',
      path: '/api/v2/books',
      query: {
        alignedOnly: options.alignedOnly ? 'true' : undefined,
        search: options.search?.trim() || undefined,
        limit: limit === null ? undefined : String(limit),
      },
    });
    const books = readBookList(payload);
    return limit === null ? books : books.slice(0, limit);
  }

  /** Null means Storyteller said the book is gone; an unreadable 200 fails rather than buying a duplicate import. */
  async getBook(uuid: string): Promise<StorytellerBookSummary | null> {
    const sent = await this.send({ method: 'GET', path: this.bookPath(uuid) });
    if (sent.response.status === 404) {
      await this.discard(sent.response);
      return null;
    }
    const book = normalizeBook(await this.readJson(sent));
    if (!book) throw new StorytellerClientError('Storyteller returned a book response that could not be read', sent.response.status);
    return book;
  }

  async importByReference(input: StorytellerImportByReferenceInput): Promise<StorytellerImportResult> {
    const startedAt = Date.now();
    this.logger.log(`[${IMPORT_EVENT}] [start] paths=${input.paths.length} importMode=${input.importMode} - import started`);

    const payload = await this.getJson({
      method: 'POST',
      path: '/api/v2/books',
      body: JSON.stringify({
        paths: input.paths,
        importMode: input.importMode,
        ...(input.collectionUuid ? { collection: input.collectionUuid } : {}),
        ...(input.epub2Strategy ? { epub2Strategy: input.epub2Strategy } : {}),
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const record = asRecord(payload) ?? {};
    if (readBoolean(record, 'epub2Detected', 'epub2_detected') === true) {
      const paths = readArray(record.paths).filter((path): path is string => typeof path === 'string');
      this.logger.log(`[${IMPORT_EVENT}] [end] durationMs=${Date.now() - startedAt} epub2Detected=true - import needs a strategy`);
      return { kind: 'epub2_detected', paths };
    }

    const book = normalizeBook(payload);
    if (!book) {
      this.logger.warn(
        `[${IMPORT_EVENT}] [fail] durationMs=${Date.now() - startedAt} errorClass=StorytellerClientError error="no book in response" - import failed`,
      );
      throw new StorytellerClientError('Storyteller did not return a book for the imported paths', null);
    }
    this.logger.log(`[${IMPORT_EVENT}] [end] durationMs=${Date.now() - startedAt} uuid=${book.uuid} - import completed`);
    return { kind: 'created', uuid: book.uuid };
  }

  async uploadBook(input: StorytellerUploadInput): Promise<{ uuid: string }> {
    // Storyteller's upload flow keys every file to a client-chosen uuid and only materializes the
    // book when `finalize` scans that folder, so the uuid is generated here rather than returned.
    const bookUuid = randomUUID();
    const files = [input.epubPath, ...input.audioPaths];
    // Every TUS upload this call creates, so a failure can hand the bytes back: the book row only
    // exists once `finalize` succeeds, so nothing else can reach an interrupted upload.
    const createdUploads: string[] = [];
    const startedAt = Date.now();
    // One ceiling for the whole upload. A per-chunk deadline bounds each request but not the run,
    // and one instance builds one read-along at a time.
    const ceilingAt = startedAt + this.timeouts.transferTimeoutMs;

    try {
      const sizes = await Promise.all(files.map((file) => this.localFileSize(file)));
      const totalBytes = sizes.reduce((total, size) => total + size, 0);
      this.logger.log(`[${UPLOAD_EVENT}] [start] bookUuid=${bookUuid} files=${files.length} totalBytes=${totalBytes} - upload started`);

      let completedBytes = 0;
      for (const [index, file] of files.entries()) {
        await this.uploadFile(
          file,
          sizes[index],
          bookUuid,
          ceilingAt,
          createdUploads,
          (offset) => input.onProgress?.(completedBytes + offset, totalBytes),
          input.signal,
        );
        completedBytes += sizes[index];
      }

      await this.finalizeUpload({ bookUuid, collectionUuid: input.collectionUuid }, this.remainingUploadMs(ceilingAt));
      this.logger.log(
        `[${UPLOAD_EVENT}] [end] bookUuid=${bookUuid} durationMs=${Date.now() - startedAt} totalBytes=${totalBytes} - upload completed`,
      );
      return { uuid: bookUuid };
    } catch (error) {
      if (input.signal?.aborted) {
        this.logger.log(`[${UPLOAD_EVENT}] [end] bookUuid=${bookUuid} durationMs=${Date.now() - startedAt} outcome=cancelled - upload cancelled`);
      } else {
        const { errorClass, message } = this.describe(error);
        this.logger.error(
          `[${UPLOAD_EVENT}] [fail] bookUuid=${bookUuid} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - upload failed`,
        );
      }
      await this.reclaimUploads(bookUuid, createdUploads);
      throw error;
    }
  }

  /**
   * Hands back what this call transferred: a 12 GB audiobook that fails near the end otherwise
   * strands its bytes under a uuid no book row will ever name. TUS terminates with a DELETE on the
   * same URL, and a server that refuses leaves bytes behind, so that outcome is counted. Never
   * throws - the failure that got here is the one worth reporting.
   */
  private async reclaimUploads(bookUuid: string, uploadUrls: string[]): Promise<void> {
    if (uploadUrls.length === 0) return;
    const startedAt = Date.now();
    this.logger.log(`[${RECLAIM_EVENT}] [start] bookUuid=${bookUuid} uploads=${uploadUrls.length} - reclaiming interrupted uploads`);

    let reclaimed = 0;
    for (const uploadUrl of uploadUrls) {
      try {
        const sent = await this.send({ method: 'DELETE', url: uploadUrl, headers: { 'Tus-Resumable': '1.0.0' } });
        await this.discard(sent.response);
        // A 404 is the same outcome as a 204: the server is not holding those bytes any more.
        if (sent.response.ok || sent.response.status === 404) reclaimed += 1;
      } catch {
        // Counted as stranded below.
      }
    }

    const stranded = uploadUrls.length - reclaimed;
    const line = `[${RECLAIM_EVENT}] [end] bookUuid=${bookUuid} durationMs=${Date.now() - startedAt} reclaimed=${reclaimed} stranded=${stranded} - interrupted uploads reclaimed`;
    if (stranded > 0) this.logger.warn(line);
    else this.logger.log(line);
  }

  /**
   * Turns the uploaded files into a book. The captured `api/v2/books/upload/finalize` route scans
   * that uuid's upload folder as a single candidate hard-coded to `format: "audiobook"`, so it
   * registers no ebook: whether the EPUB uploaded alongside becomes one depends on the per-file TUS
   * completion hook, whose source is not in the captured set.
   */
  private async finalizeUpload(payload: { bookUuid: string; collectionUuid?: string }, timeoutMs: number): Promise<void> {
    const sent = await this.send({
      method: 'POST',
      path: '/api/v2/books/upload/finalize',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bookUuid: payload.bookUuid,
        ...(payload.collectionUuid ? { collectionUuid: payload.collectionUuid } : {}),
      }),
      timeoutMs,
    });
    await this.expectSuccess(sent);
    await this.discard(sent.response);
  }

  async process(uuid: string): Promise<void> {
    const sent = await this.send({
      method: 'POST',
      path: `${this.bookPath(uuid)}/process`,
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    await this.expectSuccess(sent);
    await this.discard(sent.response);
  }

  /**
   * The status alone is not enough: a Storyteller behind an authenticating proxy answers 200 with a
   * login page, and taking that for a finished read-along downloads HTML as an EPUB.
   */
  async readaloudAvailable(uuid: string): Promise<boolean> {
    const path = `${this.bookPath(uuid)}/files`;
    const head = await this.send({ method: 'HEAD', path, query: { format: 'readaloud' }, headers: { Accept: FILE_ACCEPT }, retry: true });
    await this.discard(head.response);
    if (head.response.status === 200 || head.response.status === 206) return isFileResponse(head.response);
    if (head.response.status === 404) return false;

    const ranged = await this.send({
      method: 'GET',
      path,
      query: { format: 'readaloud' },
      headers: { Accept: FILE_ACCEPT, Range: 'bytes=0-0' },
      retry: true,
    });
    await this.discard(ranged.response);
    if (ranged.response.status === 206) return true;
    if (ranged.response.status === 200) return isFileResponse(ranged.response);
    if (ranged.response.status === 404) return false;
    throw new StorytellerClientError(`Storyteller answered ${ranged.response.status} for the read-along file`, ranged.response.status);
  }

  /**
   * Two deadlines rather than one: a whole transfer can legitimately take much longer than a
   * request, but a connection that has stopped delivering bytes is dead however long the ceiling is.
   */
  async downloadReadaloud(uuid: string, destinationPath: string): Promise<void> {
    const startedAt = Date.now();
    this.logger.log(`[${DOWNLOAD_EVENT}] [start] uuid=${uuid} - read-along download started`);

    const controller = new AbortController();
    const idleMs = this.timeouts.requestTimeoutMs;
    const ceiling = setTimeout(() => controller.abort(new Error(DOWNLOAD_CEILING_MESSAGE)), this.timeouts.transferTimeoutMs);
    let idleTimer = setTimeout(() => controller.abort(new Error(DOWNLOAD_STALLED_MESSAGE)), idleMs);
    const touch = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(new Error(DOWNLOAD_STALLED_MESSAGE)), idleMs);
    };

    const partPath = `${destinationPath}.part`;
    try {
      const sent = await this.send({
        method: 'GET',
        path: `${this.bookPath(uuid)}/files`,
        query: { format: 'readaloud' },
        headers: { Accept: FILE_ACCEPT, 'Accept-Encoding': 'identity' },
        signal: controller.signal,
      });
      await this.expectSuccess(sent);
      // `expectSuccess` accepts any 2xx, and a 206 slice still opens with a zip signature, so
      // nothing downstream would notice the missing tail.
      if (sent.response.status !== 200) {
        await this.discard(sent.response);
        throw new StorytellerClientError(DOWNLOAD_PARTIAL_MESSAGE, sent.response.status);
      }
      if (!sent.response.body) throw new StorytellerClientError('Storyteller returned an empty read-along response', sent.response.status);

      // The request asks for `identity`, so a declared length is the file's real length.
      const declaredBytes = readIntegerHeader(sent.response, 'content-length');
      const bytes = await this.streamToPart(sent.response.body, partPath, controller, touch);
      if (declaredBytes !== null && declaredBytes !== bytes) throw new StorytellerClientError(DOWNLOAD_TRUNCATED_MESSAGE, null);

      await publishDownload(partPath, destinationPath);
      this.logger.log(`[${DOWNLOAD_EVENT}] [end] uuid=${uuid} durationMs=${Date.now() - startedAt} bytes=${bytes} - read-along downloaded`);
    } catch (error) {
      const { errorClass, message } = this.describe(error);
      this.logger.error(
        `[${DOWNLOAD_EVENT}] [fail] uuid=${uuid} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - read-along download failed`,
      );
      throw error instanceof StorytellerClientError ? error : new StorytellerClientError(message, null);
    } finally {
      await unlink(partPath).catch(() => undefined);
      clearTimeout(idleTimer);
      clearTimeout(ceiling);
    }
  }

  /**
   * The collection route is the only book DELETE in Storyteller's captured source, and it reads
   * `{ books, preventReImport }` from the JSON body - so a `preventReImport` sent as a query
   * parameter on `/api/v2/books/<uuid>` is read by nothing and the re-import ignore rule is never
   * written. A single-element list is the request the route's own UI makes.
   */
  async deleteBook(uuid: string, options: { preventReImport?: boolean } = {}): Promise<void> {
    const sent = await this.send({
      method: 'DELETE',
      path: '/api/v2/books',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ books: [uuid], preventReImport: options.preventReImport === true }),
    });
    await this.expectSuccess(sent);
    await this.discard(sent.response);
  }

  /**
   * Importing an ebook and its audio in a single request races: both candidates carry the same uuid
   * hint and the loser's half of the pair is dropped. Storyteller pairs automatically only for files
   * uploaded together or in one folder, so two libraries means importing each side alone.
   */
  async mergeBooks(uuids: string[]): Promise<{ uuid: string }> {
    const payload = await this.getJson({
      method: 'POST',
      path: '/api/v2/books/merge',
      body: JSON.stringify({ update: {}, relations: {}, from: uuids }),
      headers: { 'Content-Type': 'application/json' },
    });
    const book = normalizeBook(payload);
    if (!book) throw new StorytellerClientError('Storyteller did not return the merged book', null);
    return { uuid: book.uuid };
  }

  /**
   * Only the processing cache. The `originals` query flag is deliberately never sent: for a
   * reference-imported book those "originals" are the user's own library files.
   */
  async deleteCache(uuid: string): Promise<void> {
    const sent = await this.send({ method: 'DELETE', path: `${this.bookPath(uuid)}/cache` });
    await this.expectSuccess(sent);
    await this.discard(sent.response);
  }

  async cancelProcessing(uuid: string): Promise<void> {
    const sent = await this.send({ method: 'DELETE', path: `${this.bookPath(uuid)}/process` });
    if (sent.response.status === 404 || sent.response.status === 409) {
      await this.discard(sent.response);
      return;
    }
    await this.expectSuccess(sent);
    await this.discard(sent.response);
  }

  /** Housekeeping: a Storyteller that refuses collections must not fail a build, so the caller gets null. */
  async ensureCollection(name: string): Promise<string | null> {
    const wanted = name.trim();
    if (!wanted) return null;
    const startedAt = Date.now();

    try {
      const existing = readArray(await this.getJson({ method: 'GET', path: '/api/v2/collections' }));
      for (const entry of existing) {
        const record = asRecord(entry);
        if (!record) continue;
        if ((readString(record, 'name') ?? '').toLowerCase() !== wanted.toLowerCase()) continue;
        const uuid = readString(record, 'uuid', 'id');
        if (uuid) return uuid;
      }

      const created = await this.getJson({
        method: 'POST',
        path: '/api/v2/collections',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: wanted, public: true }),
      });
      return readString(asRecord(created) ?? {}, 'uuid', 'id');
    } catch (error) {
      if (error instanceof StorytellerClientError) {
        this.logCollectionFailure(error, startedAt);
        return null;
      }
      throw error;
    }
  }

  private logCollectionFailure(error: StorytellerClientError, startedAt: number): void {
    this.logger.warn(
      `[${COLLECTION_EVENT}] [fail] durationMs=${Date.now() - startedAt} status=${error.status ?? 'none'} errorClass=${error.name} error="${sanitizeLogValue(this.redact(error.message))}" - collection skipped`,
    );
  }

  private bookPath(uuid: string): string {
    return `/api/v2/books/${encodeURIComponent(uuid)}`;
  }

  private async uploadFile(
    filePath: string,
    size: number,
    bookUuid: string,
    ceilingAt: number,
    createdUploads: string[],
    onOffset: (offset: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const metadata = encodeTusMetadata({ bookUuid, filename: basename(filePath), filetype: guessFiletype(filePath) });
    const create = await this.send({
      method: 'POST',
      path: '/api/v2/books/upload',
      // No explicit Content-Length: undici refused this request when one was set by hand, and a
      // bodyless POST already carries `content-length: 0`.
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(size),
        'Upload-Metadata': metadata,
      },
    });
    await this.expectSuccess(create);
    await this.discard(create.response);

    const uploadUrl = this.resolveUploadUrl(create.response);
    createdUploads.push(uploadUrl);
    const handle = await this.openLocalFile(filePath);
    try {
      let offset = 0;
      let failures = 0;
      while (offset < size) {
        const length = Math.min(UPLOAD_CHUNK_BYTES, size - offset);
        const chunk = new Uint8Array(length);
        await this.readLocalChunk(handle, chunk, offset);

        try {
          offset = await this.patchChunk(uploadUrl, offset, chunk, ceilingAt);
          failures = 0;
        } catch (error) {
          failures += 1;
          if (failures >= MAX_ATTEMPTS) throw error;
          const resumed = await this.readUploadOffset(uploadUrl, offset + length);
          if (resumed === null) throw error;
          if (resumed > offset) failures = 0;
          offset = resumed;
          if (failures > 0) await delay(RETRY_BASE_DELAY_MS * failures);
        }
        onOffset(offset);
        if (signal?.aborted) throw new StorytellerClientError(UPLOAD_CANCELLED_MESSAGE, null);
      }

      if (offset !== size) throw new StorytellerClientError(UPLOAD_INCOMPLETE_MESSAGE, null);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /**
   * The upload URL TUS hands back carries the service account's token, so a `Location` pointing
   * anywhere else would send that token, and the book, to whoever answered.
   */
  private resolveUploadUrl(response: Response): string {
    const location = response.headers.get('location');
    if (!location) throw new StorytellerClientError('Storyteller did not return an upload location', response.status);

    let resolved: URL;
    try {
      resolved = new URL(location, `${this.serverUrl}/`);
    } catch {
      throw new StorytellerClientError(UPLOAD_LOCATION_MESSAGE, response.status);
    }
    if (resolved.username || resolved.password) throw new StorytellerClientError(UPLOAD_LOCATION_MESSAGE, response.status);
    if (!resolved.toString().startsWith(`${this.serverUrl}/`)) throw new StorytellerClientError(UPLOAD_LOCATION_MESSAGE, response.status);
    // Same origin is not enough: this URL is later given a DELETE with the token, so the remote
    // must not be able to point it at a different route. `deleteCache` refuses to send `originals`
    // precisely because those are the user's library files, and a Location naming that route with a
    // query string would make this client issue the request the module declines to make itself.
    if (!resolved.toString().startsWith(`${this.serverUrl}${UPLOAD_PATH}`) || resolved.search !== '') {
      throw new StorytellerClientError(UPLOAD_LOCATION_MESSAGE, response.status);
    }
    return resolved.toString();
  }

  /**
   * A TUS server acknowledges every accepted byte, so anything but the exact end of the chunk means
   * the two sides disagree about the file and the caller must resume from what the server holds.
   */
  private async patchChunk(uploadUrl: string, offset: number, chunk: Uint8Array<ArrayBuffer>, ceilingAt: number): Promise<number> {
    const controller = new AbortController();
    const ceiling = setTimeout(() => controller.abort(new Error(UPLOAD_CEILING_MESSAGE)), this.remainingUploadMs(ceilingAt));
    let idleTimer = setTimeout(() => controller.abort(new Error(UPLOAD_STALLED_MESSAGE)), this.timeouts.requestTimeoutMs);
    const touch = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(new Error(UPLOAD_STALLED_MESSAGE)), this.timeouts.requestTimeoutMs);
    };

    try {
      const sent = await this.send({
        method: 'PATCH',
        url: uploadUrl,
        headers: {
          'Tus-Resumable': '1.0.0',
          'Upload-Offset': String(offset),
          'Content-Type': 'application/offset+octet-stream',
        },
        body: streamingUploadBody(chunk, touch),
        duplex: 'half',
        signal: controller.signal,
      });
      await this.expectSuccess(sent);
      await this.discard(sent.response);

      const expected = offset + chunk.length;
      const acknowledged = readIntegerHeader(sent.response, 'upload-offset');
      if (acknowledged !== expected) throw new StorytellerClientError(UPLOAD_OFFSET_MESSAGE, sent.response.status);
      return expected;
    } finally {
      clearTimeout(idleTimer);
      clearTimeout(ceiling);
    }
  }

  /**
   * `sentBytes` is everything the client can possibly have put on the wire for this file, and an
   * answer beyond it is a server or proxy claiming bytes that were never sent. Trusting one ends the
   * send loop early, passes the completeness check and finalizes a truncated file.
   */
  private async readUploadOffset(uploadUrl: string, sentBytes: number): Promise<number | null> {
    try {
      const sent = await this.send({ method: 'HEAD', url: uploadUrl, headers: { 'Tus-Resumable': '1.0.0' } });
      await this.discard(sent.response);
      if (!sent.response.ok) return null;
      const offset = readIntegerHeader(sent.response, 'upload-offset');
      return offset !== null && offset <= sentBytes ? offset : null;
    } catch {
      return null;
    }
  }

  private async localFileSize(filePath: string): Promise<number> {
    try {
      return (await stat(filePath)).size;
    } catch {
      throw new StorytellerClientError(LOCAL_FILE_MESSAGE, null);
    }
  }

  private async openLocalFile(filePath: string): Promise<Awaited<ReturnType<typeof open>>> {
    try {
      return await open(filePath, 'r');
    } catch {
      throw new StorytellerClientError(LOCAL_FILE_MESSAGE, null);
    }
  }

  /**
   * A single `read` may return fewer bytes than asked for, and the buffer is zero-filled: an
   * unnoticed short read sends zeros and leaves a silently corrupted audiobook on the server.
   */
  private async readLocalChunk(handle: Awaited<ReturnType<typeof open>>, chunk: Uint8Array, offset: number): Promise<void> {
    let filled = 0;
    while (filled < chunk.length) {
      let bytesRead: number;
      try {
        ({ bytesRead } = await handle.read(chunk, filled, chunk.length - filled, offset + filled));
      } catch {
        throw new StorytellerClientError(LOCAL_FILE_MESSAGE, null);
      }
      if (bytesRead === 0) throw new StorytellerClientError(LOCAL_FILE_SHORT_MESSAGE, null);
      filled += bytesRead;
    }
  }

  /** What is left of the upload ceiling, refused once it is spent. */
  private remainingUploadMs(ceilingAt: number): number {
    const remaining = ceilingAt - Date.now();
    if (remaining <= 0) throw new StorytellerClientError(UPLOAD_CEILING_MESSAGE, null);
    return remaining;
  }

  private async streamToPart(body: NonNullable<Response['body']>, partPath: string, controller: AbortController, touch: () => void): Promise<number> {
    const source = Readable.fromWeb(body as WebReadableStream);
    if (controller.signal.aborted) {
      source.destroy();
      throw abortReason(controller.signal);
    }

    // A body that ignores the abort would hang forever, so the deadline is raced against the write.
    const stalled = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          source.destroy();
          reject(abortReason(controller.signal));
        },
        { once: true },
      );
    });

    return Promise.race([writeZipStream(source, partPath, touch), stalled]);
  }

  private async ensureToken(): Promise<string> {
    const cached = this.token;
    if (cached && Date.now() < cached.expiresAt) return cached.value;

    this.pendingMint ??= this.mintToken().finally(() => {
      this.pendingMint = null;
    });
    return this.pendingMint;
  }

  /** A network failure is rethrown as it came; a Storyteller that answered and said no is a credential problem. */
  private async mintToken(): Promise<string> {
    const startedAt = Date.now();
    const body = new URLSearchParams({ usernameOrEmail: this.connection.username, password: this.connection.password });

    const tokenUrl = `${this.serverUrl}/api/v2/token`;
    await this.assertSafeTarget(tokenUrl);

    let response: Response;
    const deadline = this.deadline(this.timeouts.requestTimeoutMs);
    try {
      response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
        redirect: 'manual',
        signal: deadline.signal,
      });
    } catch (error) {
      deadline.clear();
      const { errorClass, message } = this.describe(error);
      this.logger.warn(
        `[${TOKEN_EVENT}] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - token request failed`,
      );
      throw error;
    }

    try {
      if (!response.ok) {
        this.logger.warn(
          `[${TOKEN_EVENT}] [fail] durationMs=${Date.now() - startedAt} status=${response.status} errorClass=StorytellerClientError error="token rejected" - token request rejected`,
        );
        await this.discard(response);
        throw new StorytellerClientError(`Storyteller rejected the service account (HTTP ${response.status})`, response.status);
      }

      let text: string;
      try {
        text = await readResponseText(response, Number.POSITIVE_INFINITY, deadline.signal);
      } catch (error) {
        if (error instanceof RequestDeadlineExceededError) {
          this.logger.warn(
            `[${TOKEN_EVENT}] [fail] durationMs=${Date.now() - startedAt} status=${response.status} errorClass=StorytellerClientError error="response deadline exceeded" - token response timed out`,
          );
          throw new StorytellerClientError(RESPONSE_BODY_TIMEOUT_MESSAGE, response.status);
        }
        const { errorClass, message } = this.describe(error);
        this.logger.warn(
          `[${TOKEN_EVENT}] [fail] durationMs=${Date.now() - startedAt} status=${response.status} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - token response body could not be read`,
        );
        throw new StorytellerClientError(RESPONSE_NOT_JSON_MESSAGE, response.status);
      }
      let parsed: unknown;
      try {
        parsed = text.trim() ? (JSON.parse(text) as unknown) : null;
      } catch (error) {
        const { errorClass, message } = this.describe(error);
        this.logger.warn(
          `[${TOKEN_EVENT}] [fail] durationMs=${Date.now() - startedAt} status=${response.status} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - token response was not JSON`,
        );
        throw new StorytellerClientError(RESPONSE_NOT_JSON_MESSAGE, response.status);
      }
      const payload = asRecord(parsed);
      const value = payload ? readString(payload, 'access_token', 'accessToken') : null;
      if (!value) {
        this.logger.warn(
          `[${TOKEN_EVENT}] [fail] durationMs=${Date.now() - startedAt} status=${response.status} errorClass=StorytellerClientError error="no access token" - token response unusable`,
        );
        throw new StorytellerClientError('Storyteller did not return an access token', response.status);
      }

      const ttlMs = payload ? readNumber(payload, 'expires_in', 'expiresIn') : null;
      const lifetime = ttlMs !== null && ttlMs > 0 ? ttlMs : FALLBACK_TOKEN_TTL_MS;
      this.token = { value, expiresAt: Date.now() + Math.max(lifetime - TOKEN_EXPIRY_SKEW_MS, MIN_TOKEN_TTL_MS) };
      this.logger.log(`[${TOKEN_EVENT}] [end] durationMs=${Date.now() - startedAt} ttlMs=${lifetime} - token minted`);
      return value;
    } finally {
      deadline.clear();
    }
  }

  /** One retry with a freshly minted token: a 401 twice in a row is a credential problem, not an expiry. */
  private async authorizedFetch(options: RequestOptions): Promise<Response> {
    const response = await this.rawFetch(options, await this.ensureToken());
    if (response.status !== 401) return response;

    await this.discard(response);
    this.token = null;
    return this.rawFetch(options, await this.ensureToken());
  }

  private async rawFetch(options: RequestOptions, token: string): Promise<Response> {
    const url = this.buildUrl(options);
    const startedAt = Date.now();
    await this.assertSafeTarget(url.toString());
    const deadline = options.signal ? null : this.deadline(options.timeoutMs ?? this.timeouts.requestTimeoutMs);
    this.logger.debug(`[${REQUEST_EVENT}] [start] method=${options.method} path="${sanitizeLogValue(url.pathname)}" - request started`);

    try {
      const request: RequestInit & { duplex?: 'half' } = {
        method: options.method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(options.headers ?? {}) },
        body: options.body,
        // Manual, not followed: a redirect decides where the service account's token goes next.
        redirect: 'manual',
        signal: options.signal ?? deadline?.signal,
      };
      if (options.duplex) request.duplex = options.duplex;
      const response = await fetch(url, request);
      if (deadline) this.responseDeadlines.set(response, deadline);
      this.logger.debug(
        `[${REQUEST_EVENT}] [end] method=${options.method} path="${sanitizeLogValue(url.pathname)}" status=${response.status} durationMs=${Date.now() - startedAt} - request completed`,
      );
      return response;
    } catch (error) {
      deadline?.clear();
      const { errorClass, message } = this.describe(error);
      this.logger.warn(
        `[${REQUEST_EVENT}] [fail] method=${options.method} path="${sanitizeLogValue(url.pathname)}" durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - request failed`,
      );
      throw error;
    }
  }

  /** Every outbound request, including URLs Storyteller handed back: the gate is only a guarantee if nothing skips it. */
  private async assertSafeTarget(url: string): Promise<void> {
    try {
      await ensureSafeStorytellerUrl(url);
    } catch {
      throw new StorytellerClientError(UNSAFE_TARGET_MESSAGE, null);
    }
  }

  private deadline(timeoutMs: number): { signal: AbortSignal; clear: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new RequestDeadlineExceededError()), timeoutMs);
    return { signal: controller.signal, clear: () => clearTimeout(timer) };
  }

  private buildUrl(options: RequestOptions): URL {
    const url = new URL(options.url ?? `${this.serverUrl}${options.path ?? ''}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    return url;
  }

  private async send(options: RequestOptions): Promise<SentRequest> {
    const attempts = options.retry ? MAX_ATTEMPTS : 1;
    const startedAt = Date.now();
    const path = options.path ?? (options.url ? safePathOf(options.url) : '');
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await this.authorizedFetch(options);
        if (isRedirectResponse(response)) {
          await this.discard(response);
          this.logger.warn(
            `[${REQUEST_EVENT}] [fail] method=${options.method} path="${sanitizeLogValue(path)}" status=${response.status} durationMs=${Date.now() - startedAt} errorClass=StorytellerClientError error="redirect refused" - redirect rejected`,
          );
          throw new StorytellerClientError(REDIRECT_MESSAGE, response.status);
        }
        if (response.status < 500 || attempt === attempts) {
          return { response, method: options.method, path, durationMs: Date.now() - startedAt };
        }
        await this.discard(response);
        lastError = new StorytellerClientError(`Storyteller answered ${response.status}`, response.status);
      } catch (error) {
        if (error instanceof StorytellerClientError) throw error;
        lastError = error;
        if (attempt === attempts) break;
      }
      await delay(RETRY_BASE_DELAY_MS * attempt);
    }

    if (lastError instanceof StorytellerClientError) throw lastError;
    const { errorClass, message } = this.describe(lastError);
    this.logger.warn(
      `[${REQUEST_EVENT}] [fail] method=${options.method} path="${sanitizeLogValue(path)}" durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - request gave up`,
    );
    throw new StorytellerClientError(`Could not reach the Storyteller server: ${message}`, null);
  }

  private async expectSuccess(sent: SentRequest): Promise<void> {
    if (sent.response.ok) return;

    const deadline = this.responseDeadlines.get(sent.response);
    const raw = await readResponseText(sent.response, MAX_ERROR_BODY_BYTES, deadline?.signal).catch(() => '');
    deadline?.clear();
    this.responseDeadlines.delete(sent.response);
    // An HTML error page is a framework's own 404/502 screen: quoting its markup in a log line and
    // in the settings panel adds nothing the status code does not already say.
    const contentType = sent.response.headers.get('content-type') ?? '';
    const detail = contentType.includes('text/html') || raw.trimStart().startsWith('<') ? '' : this.redact(raw);
    this.logger.warn(
      `[${REQUEST_EVENT}] [fail] method=${sent.method} path="${sanitizeLogValue(sent.path)}" status=${sent.response.status} durationMs=${sent.durationMs} errorClass=HttpError${sent.response.status} error="${sanitizeLogValue(detail)}" - request rejected`,
    );
    throw new StorytellerClientError(
      detail ? `Storyteller answered ${sent.response.status}: ${detail}` : `Storyteller answered ${sent.response.status}`,
      sent.response.status,
    );
  }

  private async getJson(options: RequestOptions): Promise<unknown> {
    return this.readJson(await this.send(options));
  }

  private async readJson(sent: SentRequest): Promise<unknown> {
    try {
      await this.expectSuccess(sent);
      const deadline = this.responseDeadlines.get(sent.response);
      const text = await readResponseText(sent.response, Number.POSITIVE_INFINITY, deadline?.signal);
      if (!text.trim()) return null;
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof StorytellerClientError) throw error;
      if (error instanceof RequestDeadlineExceededError) throw new StorytellerClientError(RESPONSE_BODY_TIMEOUT_MESSAGE, sent.response.status);
      throw new StorytellerClientError(RESPONSE_NOT_JSON_MESSAGE, sent.response.status);
    } finally {
      this.clearResponseDeadline(sent.response);
    }
  }

  private async discard(response: Response): Promise<void> {
    try {
      if (!response.body || response.bodyUsed) return;
      await response.body.cancel().catch(() => undefined);
    } finally {
      this.clearResponseDeadline(response);
    }
  }

  private clearResponseDeadline(response: Response): void {
    this.responseDeadlines.get(response)?.clear();
    this.responseDeadlines.delete(response);
  }

  private describe(error: unknown): { errorClass: string; message: string } {
    const { errorClass, message } = describeError(error);
    return { errorClass, message: this.redact(error instanceof Error ? describeErrorChain(error) : message) };
  }

  /**
   * A provider that echoes the request - a proxy error page quoting `Authorization`, a validation
   * error quoting the form it was posted - would carry this session's credentials into a log line, a
   * thrown message or the settings page.
   */
  private redact(value: unknown): string {
    let text = String(value).replace(/bearer\s+\S+/gi, `Bearer ${REDACTED}`);
    if (this.token?.value) text = text.split(this.token.value).join(REDACTED);
    if (this.connection.password) text = text.split(this.connection.password).join(REDACTED);
    return text.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_BODY_CHARS);
  }
}

/**
 * `fetch` reports every transport failure as the same bare "fetch failed"; what actually happened is
 * only ever on `cause`, so the chain is flattened for the settings page to name.
 */
function describeErrorChain(error: Error): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current instanceof Error && !seen.has(current) && parts.length < ERROR_CHAIN_MAX_LINKS) {
    seen.add(current);
    const code = (current as NodeJS.ErrnoException).code;
    const text = code && !current.message.includes(code) ? `${current.message} (${code})` : current.message;
    if (text && !parts.includes(text)) parts.push(text);
    current = current.cause;
  }

  return parts.join(': ');
}

/**
 * `Response.text()` buffers whatever the other side chooses to send, and on the download path that
 * body carries the transfer ceiling - two hours for a provider to fill this process's heap.
 */
async function readResponseText(response: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
  if (!response.body || response.bodyUsed) return '';

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let read = 0;
  let rejectAbort: ((reason: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => rejectAbort?.(abortReason(signal!));
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal?.aborted) throw abortReason(signal);
    while (read < maxBytes) {
      const { done, value } = await (signal ? Promise.race([reader.read(), aborted]) : reader.read());
      if (done) break;
      if (!value?.length) continue;
      const slice = value.length > maxBytes - read ? value.subarray(0, maxBytes - read) : value;
      chunks.push(Buffer.from(slice));
      read += slice.length;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function streamingUploadBody(chunk: Uint8Array<ArrayBuffer>, onChunk: () => void): ReadableStream<Uint8Array<ArrayBuffer>> {
  let offset = 0;
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      if (offset >= chunk.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + UPLOAD_BODY_CHUNK_BYTES, chunk.length);
      controller.enqueue(chunk.subarray(offset, end));
      offset = end;
      onChunk();
    },
  });
}

function safePathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(DOWNLOAD_STALLED_MESSAGE);
}

function isRedirectResponse(response: Response): boolean {
  return response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
}

function isExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST';
}

/**
 * A create, never a replace: two books whose titles sanitize to the same filename would otherwise
 * destroy each other's read-along, and `link` fails EEXIST atomically.
 *
 * `link(2)` is refused outright (EPERM, EOPNOTSUPP) on SMB/CIFS, exFAT and several FUSE mounts -
 * ordinary for a self-hosted library bind-mounted into a container - so `copyFile` with
 * `COPYFILE_EXCL` gives the same create-or-EEXIST at the cost of a copy. No fs error reaches the
 * caller: they name the local path, which this file's messages never do.
 */
async function publishDownload(partPath: string, destinationPath: string): Promise<void> {
  try {
    await link(partPath, destinationPath);
  } catch (error) {
    if (isExistsError(error)) throw new StorytellerClientError(DOWNLOAD_EXISTS_MESSAGE, null);
    await copyExclusive(partPath, destinationPath);
  }
  await unlink(partPath);
}

async function copyExclusive(partPath: string, destinationPath: string): Promise<void> {
  try {
    await copyFile(partPath, destinationPath, constants.COPYFILE_EXCL);
  } catch (error) {
    if (isExistsError(error)) throw new StorytellerClientError(DOWNLOAD_EXISTS_MESSAGE, null);
    // A copy that failed part-way owns what it wrote; the EEXIST above is somebody else's file.
    await unlink(destinationPath).catch(() => undefined);
    throw new StorytellerClientError(DOWNLOAD_PUBLISH_MESSAGE, null);
  }
}

/**
 * Refuses anything that does not start with a zip local-file header: Storyteller answers a
 * not-yet-aligned book with an HTML or JSON error page, which must never reach the importer.
 */
async function writeZipStream(source: Readable, partPath: string, onChunk: () => void): Promise<number> {
  let bytes = 0;
  let header = Buffer.alloc(0);
  let verified = false;

  async function* validate(): AsyncGenerator<Buffer> {
    for await (const chunk of source) {
      const buffer = Buffer.from(chunk as Uint8Array);
      bytes += buffer.length;
      onChunk();
      if (!verified) {
        header = Buffer.concat([header, buffer.subarray(0, ZIP_SIGNATURE.length)]);
        if (header.length >= ZIP_SIGNATURE.length) {
          if (!header.subarray(0, ZIP_SIGNATURE.length).equals(ZIP_SIGNATURE)) {
            throw new StorytellerClientError(NOT_AN_ARCHIVE_MESSAGE, null);
          }
          verified = true;
        }
      }
      yield buffer;
    }
    if (!verified) throw new StorytellerClientError(NOT_AN_ARCHIVE_MESSAGE, null);
  }

  await pipeline(validate(), createWriteStream(partPath));
  return bytes;
}

@Injectable()
export class StorytellerClientService implements StorytellerClient {
  private readonly timeouts: StorytellerClientTimeouts;

  constructor(@Inject(storytellerConfig.KEY) config: StorytellerClientTimeouts) {
    this.timeouts = {
      requestTimeoutMs: timeoutOr(config?.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
      transferTimeoutMs: timeoutOr(config?.transferTimeoutMs, DEFAULT_TRANSFER_TIMEOUT_MS),
    };
  }

  createSession(connection: StorytellerConnection): StorytellerSession {
    return new StorytellerHttpSession(connection, this.timeouts);
  }
}
