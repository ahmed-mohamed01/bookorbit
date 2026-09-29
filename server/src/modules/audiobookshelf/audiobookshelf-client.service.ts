import { Injectable, Logger } from '@nestjs/common';

import type { AudiobookshelfConnectionTestResult } from '@bookorbit/types';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import {
  AUDIOBOOKSHELF_COVER_CONTENT_TYPES,
  AUDIOBOOKSHELF_COVER_MAX_BYTES,
  AUDIOBOOKSHELF_REQUEST_TIMEOUT_MS,
  AUDIOBOOKSHELF_USER_AGENT,
} from './audiobookshelf.constants';
import { ensureSafeAudiobookshelfUrl, parseAndNormalizeServerUrl } from './audiobookshelf-url.utils';

type AudiobookshelfErrorCode = 'invalid_url' | 'timeout' | 'network' | 'redirect' | 'http' | 'invalid_response';

export class AudiobookshelfApiError extends Error {
  constructor(
    message: string,
    readonly code: AudiobookshelfErrorCode,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AudiobookshelfApiError';
  }
}

export interface AbsMediaProgress {
  id: string;
  libraryItemId: string | null;
  episodeId: string | null;
  mediaItemId: string;
  duration: number;
  progress: number;
  currentTime: number;
  isFinished: boolean;
  lastUpdate: number;
  startedAt: number;
  finishedAt: number | null;
}

export interface AbsItemCover {
  contentType: string;
  body: Buffer;
}

export interface AbsMediaProgressUpdate {
  currentTime: number;
  duration: number;
  progress: number;
  lastUpdate: number;
}

interface AbsMeResponse {
  id: string;
  username: string;
  email: string | null;
  type: string;
  mediaProgress: AbsMediaProgress[];
}

export interface AbsListeningSession {
  id: string;
  userId: string;
  libraryId: string | null;
  libraryItemId: string | null;
  bookId: string | null;
  episodeId: string | null;
  mediaType: string;
  displayTitle: string | null;
  displayAuthor: string | null;
  duration: number;
  currentTime: number;
  timeListening: number;
  startedAt: number;
  updatedAt: number;
}

interface AbsListeningSessionsResponse {
  total: number;
  numPages: number;
  page: number;
  itemsPerPage: number;
  sessions: AbsListeningSession[];
}

export interface AbsLibrary {
  id: string;
  name: string;
  mediaType: string;
  // Absolute paths of the library's root folders on the ABS server, from `folders[].fullPath`.
  folderPaths: string[];
}

export interface AbsLibrariesResponse {
  libraries: AbsLibrary[];
}

// Raw `/api/libraries` shape: `folders` is untyped because older ABS versions and podcast libraries
// can omit it, and a malformed entry must degrade to no paths rather than throw.
interface AbsRawLibrary {
  id: string;
  name: string;
  mediaType: string;
  folders?: unknown;
}

interface AbsRawLibrariesResponse {
  libraries?: AbsRawLibrary[];
}

function parseFolderPaths(folders: unknown): string[] {
  if (!Array.isArray(folders)) return [];
  const paths: string[] = [];
  for (const folder of folders) {
    const fullPath = (folder as { fullPath?: unknown } | null)?.fullPath;
    if (typeof fullPath === 'string' && fullPath.trim()) paths.push(fullPath.trim());
  }
  return [...new Set(paths)];
}

export interface AbsLibraryItem {
  id: string;
  libraryId: string;
  mediaType: string;
  // Absolute path on the ABS server: the item folder, or the file itself for a single-file item.
  // Present on the minified payload returned by GET /api/libraries/:id/items.
  path: string | null;
  media: {
    metadata: {
      title: string | null;
      subtitle: string | null;
      authorName: string | null;
      seriesName: string | null;
      isbn: string | null;
      asin: string | null;
    };
    duration: number | null;
  };
}

interface AbsLibraryItemsResponse {
  results: AbsLibraryItem[];
  total: number;
  limit: number;
  page: number;
}

type QueryParams = Record<string, string | number | undefined>;

interface RequestOptions {
  method?: 'GET' | 'PATCH';
  body?: unknown;
  allowNotFound?: boolean;
  response?: 'json' | 'none' | 'image';
  timeoutMs?: number;
}

@Injectable()
export class AudiobookshelfClientService {
  private readonly logger = new Logger(AudiobookshelfClientService.name);

  async getMe(userId: number, serverUrl: string, token: string): Promise<AbsMeResponse> {
    return this.request<AbsMeResponse>(userId, serverUrl, token, '/api/me');
  }

  async getListeningSessions(
    userId: number,
    serverUrl: string,
    token: string,
    page: number,
    itemsPerPage: number,
  ): Promise<AbsListeningSessionsResponse> {
    return this.request<AbsListeningSessionsResponse>(userId, serverUrl, token, '/api/me/listening-sessions', { page, itemsPerPage });
  }

  async getLibraries(userId: number, serverUrl: string, token: string): Promise<AbsLibrariesResponse> {
    const response = await this.request<AbsRawLibrariesResponse>(userId, serverUrl, token, '/api/libraries');
    const libraries = Array.isArray(response?.libraries) ? response.libraries : [];
    return {
      libraries: libraries.map((library) => ({
        id: library.id,
        name: library.name,
        mediaType: library.mediaType,
        folderPaths: parseFolderPaths(library.folders),
      })),
    };
  }

  async getLibraryItems(
    userId: number,
    serverUrl: string,
    token: string,
    libraryId: string,
    params: { limit?: number; page?: number } = {},
  ): Promise<AbsLibraryItemsResponse> {
    const path = `/api/libraries/${encodeURIComponent(libraryId)}/items`;
    return this.request<AbsLibraryItemsResponse>(userId, serverUrl, token, path, { limit: params.limit, page: params.page });
  }

  async getMediaProgress(
    userId: number,
    serverUrl: string,
    token: string,
    libraryItemId: string,
    timeoutMs?: number,
  ): Promise<AbsMediaProgress | null> {
    const path = `/api/me/progress/${encodeURIComponent(libraryItemId)}`;
    return this.request<AbsMediaProgress | null>(userId, serverUrl, token, path, undefined, { allowNotFound: true, timeoutMs });
  }

  async updateMediaProgress(userId: number, serverUrl: string, token: string, libraryItemId: string, payload: AbsMediaProgressUpdate): Promise<void> {
    const path = `/api/me/progress/${encodeURIComponent(libraryItemId)}`;
    // ABS acknowledges this write with a bare "OK" (sendStatus), not JSON.
    await this.request<void>(userId, serverUrl, token, path, undefined, { method: 'PATCH', body: payload, response: 'none' });
  }

  async getItemCover(userId: number, serverUrl: string, token: string, libraryItemId: string, width: number): Promise<AbsItemCover | null> {
    const path = `/api/items/${encodeURIComponent(libraryItemId)}/cover`;
    return this.request<AbsItemCover | null>(userId, serverUrl, token, path, { width }, { allowNotFound: true, response: 'image' });
  }

  async testConnection(userId: number, serverUrl: string, token: string): Promise<AudiobookshelfConnectionTestResult> {
    const started = Date.now();
    this.logger.log(`[abs.client] [start] userId=${userId} - connection test started`);
    try {
      const me = await this.getMe(userId, serverUrl, token);
      const durationMs = Date.now() - started;
      this.logger.log(`[abs.client] [end] userId=${userId} durationMs=${durationMs} success=true - connection test completed`);
      return { success: true, username: me.username };
    } catch (err) {
      const durationMs = Date.now() - started;
      if (err instanceof AudiobookshelfApiError) {
        this.logger.warn(`[abs.client] [fail] userId=${userId} durationMs=${durationMs} code=${err.code} - connection test failed`);
        return { success: false, error: this.friendlyError(err) };
      }
      const errorClass = err instanceof Error ? err.constructor.name : 'UnknownError';
      this.logger.error(`[abs.client] [fail] userId=${userId} durationMs=${durationMs} errorClass=${errorClass} - connection test failed`);
      return { success: false, error: 'Could not connect to the Audiobookshelf server' };
    }
  }

  private friendlyError(err: AudiobookshelfApiError): string {
    switch (err.code) {
      case 'invalid_url':
        return 'The Audiobookshelf server URL is invalid';
      case 'timeout':
        return 'The Audiobookshelf server did not respond in time';
      case 'network':
        return 'Could not reach the Audiobookshelf server';
      case 'redirect':
        return 'The Audiobookshelf server returned an unexpected redirect';
      case 'invalid_response':
        return 'The Audiobookshelf server returned an unexpected response';
      case 'http':
        if (err.status === 401 || err.status === 403) {
          return 'Audiobookshelf rejected the API token';
        }
        return 'The Audiobookshelf server returned an error';
      default:
        return 'Could not connect to the Audiobookshelf server';
    }
  }

  private async request<T>(
    userId: number,
    serverUrl: string,
    token: string,
    path: string,
    query?: QueryParams,
    options: RequestOptions = {},
  ): Promise<T> {
    const normalized = parseAndNormalizeServerUrl(serverUrl);
    if (!normalized) {
      throw new AudiobookshelfApiError('Invalid Audiobookshelf server URL', 'invalid_url');
    }

    const url = new URL(`${normalized}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    try {
      await ensureSafeAudiobookshelfUrl(url.toString());
    } catch {
      throw new AudiobookshelfApiError('Invalid Audiobookshelf server URL', 'invalid_url');
    }

    const started = Date.now();
    const controller = new AbortController();
    // Held until the body is consumed: a server that sends headers and then stalls must still time out.
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? AUDIOBOOKSHELF_REQUEST_TIMEOUT_MS);
    try {
      return await this.send<T>(userId, url, path, token, controller.signal, started, options);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async send<T>(
    userId: number,
    url: URL,
    path: string,
    token: string,
    signal: AbortSignal,
    started: number,
    options: RequestOptions,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method ?? 'GET',
        redirect: 'manual',
        signal,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: options.response === 'image' ? 'image/*' : 'application/json',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          'User-Agent': AUDIOBOOKSHELF_USER_AGENT,
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (err) {
      throw this.transportError(userId, path, started, err);
    }

    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      await this.discardBody(response);
      const durationMs = Date.now() - started;
      this.logger.error(
        `[abs.client] [fail] userId=${userId} path="${sanitizeLogValue(path)}" durationMs=${durationMs} status=${response.status} code=redirect - redirect rejected`,
      );
      throw new AudiobookshelfApiError('Audiobookshelf server returned an unexpected redirect', 'redirect', response.status);
    }

    if (response.status === 404 && options.allowNotFound) {
      await this.discardBody(response);
      return null as T;
    }

    if (!response.ok) {
      await this.discardBody(response);
      const durationMs = Date.now() - started;
      this.logger.error(
        `[abs.client] [fail] userId=${userId} path="${sanitizeLogValue(path)}" durationMs=${durationMs} status=${response.status} errorClass=HttpError${response.status} code=http - request failed`,
      );
      throw new AudiobookshelfApiError(`Audiobookshelf API returned status ${response.status}`, 'http', response.status);
    }

    if (options.response === 'none') {
      await this.discardBody(response);
      return undefined as T;
    }
    if (options.response === 'image') return (await this.readImage(userId, path, response, started)) as T;

    try {
      return (await response.json()) as T;
    } catch (err) {
      if (err instanceof SyntaxError) throw this.invalidResponse(userId, path, started, response.status, 'response parse failed');
      throw this.transportError(userId, path, started, err);
    }
  }

  private async readImage(userId: number, path: string, response: Response, started: number): Promise<AbsItemCover> {
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (!AUDIOBOOKSHELF_COVER_CONTENT_TYPES.has(contentType) || declaredLength > AUDIOBOOKSHELF_COVER_MAX_BYTES || !response.body) {
      await this.discardBody(response);
      throw this.invalidResponse(userId, path, started, response.status, 'cover response rejected');
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > AUDIOBOOKSHELF_COVER_MAX_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw this.invalidResponse(userId, path, started, response.status, 'cover response rejected');
        }
        chunks.push(value);
      }
    } catch (err) {
      if (err instanceof AudiobookshelfApiError) throw err;
      throw this.transportError(userId, path, started, err);
    }
    return { contentType, body: Buffer.concat(chunks) };
  }

  private async discardBody(response: Response): Promise<void> {
    await response.body?.cancel().catch(() => undefined);
  }

  private transportError(userId: number, path: string, started: number, err: unknown): AudiobookshelfApiError {
    const durationMs = Date.now() - started;
    const aborted = err instanceof Error && err.name === 'AbortError';
    const code: AudiobookshelfErrorCode = aborted ? 'timeout' : 'network';
    const errorClass = err instanceof Error ? err.constructor.name : 'UnknownError';
    this.logger.error(
      `[abs.client] [fail] userId=${userId} path="${sanitizeLogValue(path)}" durationMs=${durationMs} errorClass=${errorClass} code=${code} - request failed`,
    );
    return new AudiobookshelfApiError(aborted ? 'Audiobookshelf request timed out' : 'Could not reach the Audiobookshelf server', code);
  }

  private invalidResponse(userId: number, path: string, started: number, status: number, message: string): AudiobookshelfApiError {
    this.logger.error(
      `[abs.client] [fail] userId=${userId} path="${sanitizeLogValue(path)}" durationMs=${Date.now() - started} status=${status} code=invalid_response - ${message}`,
    );
    return new AudiobookshelfApiError('Audiobookshelf returned an invalid response', 'invalid_response', status);
  }
}
