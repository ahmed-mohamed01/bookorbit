import { Injectable, Logger } from '@nestjs/common';

import type { AudiobookshelfConnectionTestResult } from '@bookorbit/types';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { AUDIOBOOKSHELF_REQUEST_TIMEOUT_MS, AUDIOBOOKSHELF_USER_AGENT } from './audiobookshelf.constants';
import { parseAndNormalizeServerUrl } from './audiobookshelf-url.utils';

export type AudiobookshelfErrorCode = 'invalid_url' | 'timeout' | 'network' | 'redirect' | 'http' | 'invalid_response';

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

export interface AbsMeResponse {
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

export interface AbsListeningSessionsResponse {
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
  provider: string;
}

export interface AbsLibrariesResponse {
  libraries: AbsLibrary[];
}

export interface AbsLibraryItem {
  id: string;
  libraryId: string;
  mediaType: string;
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

export interface AbsLibraryItemsResponse {
  results: AbsLibraryItem[];
  total: number;
  limit: number;
  page: number;
}

type QueryParams = Record<string, string | number | undefined>;

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
    return this.request<AbsLibrariesResponse>(userId, serverUrl, token, '/api/libraries');
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

  private async request<T>(userId: number, serverUrl: string, token: string, path: string, query?: QueryParams): Promise<T> {
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

    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AUDIOBOOKSHELF_REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'User-Agent': AUDIOBOOKSHELF_USER_AGENT,
        },
      });
    } catch (err) {
      const durationMs = Date.now() - started;
      const aborted = err instanceof Error && err.name === 'AbortError';
      const code: AudiobookshelfErrorCode = aborted ? 'timeout' : 'network';
      const errorClass = err instanceof Error ? err.constructor.name : 'UnknownError';
      this.logger.error(
        `[abs.client] [fail] userId=${userId} path="${sanitizeLogValue(path)}" durationMs=${durationMs} errorClass=${errorClass} code=${code} - request failed`,
      );
      throw new AudiobookshelfApiError(aborted ? 'Audiobookshelf request timed out' : 'Could not reach the Audiobookshelf server', code);
    } finally {
      clearTimeout(timeout);
    }

    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      const durationMs = Date.now() - started;
      this.logger.error(
        `[abs.client] [fail] userId=${userId} path="${sanitizeLogValue(path)}" durationMs=${durationMs} status=${response.status} code=redirect - redirect rejected`,
      );
      throw new AudiobookshelfApiError('Audiobookshelf server returned an unexpected redirect', 'redirect', response.status);
    }

    if (!response.ok) {
      const durationMs = Date.now() - started;
      this.logger.error(
        `[abs.client] [fail] userId=${userId} path="${sanitizeLogValue(path)}" durationMs=${durationMs} status=${response.status} errorClass=HttpError${response.status} code=http - request failed`,
      );
      throw new AudiobookshelfApiError(`Audiobookshelf API returned status ${response.status}`, 'http', response.status);
    }

    try {
      return (await response.json()) as T;
    } catch {
      const durationMs = Date.now() - started;
      this.logger.error(
        `[abs.client] [fail] userId=${userId} path="${sanitizeLogValue(path)}" durationMs=${durationMs} status=${response.status} code=invalid_response - response parse failed`,
      );
      throw new AudiobookshelfApiError('Audiobookshelf returned an invalid response', 'invalid_response', response.status);
    }
  }
}
