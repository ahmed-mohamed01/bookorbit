import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureSafeUrl } from '../../common/utils/ssrf.utils';
import { AudiobookshelfApiError, AudiobookshelfClientService } from './audiobookshelf-client.service';

vi.mock('../../common/utils/ssrf.utils', () => ({
  ensureSafeUrl: vi.fn().mockResolvedValue(undefined),
}));

const mockedEnsureSafeUrl = vi.mocked(ensureSafeUrl);

const mockConfig = {
  get: vi.fn().mockReturnValue(undefined),
};

const SERVER_URL = 'https://abs.example.com';
const TOKEN = 'super-secret-token';

interface ResponseInput {
  status: number;
  type?: ResponseType;
  json?: unknown;
  jsonThrows?: boolean;
}

function makeResponse(input: ResponseInput): Response {
  const { status, type = 'basic', json, jsonThrows } = input;
  return {
    ok: status >= 200 && status < 300,
    status,
    type,
    json: jsonThrows ? vi.fn().mockRejectedValue(new Error('bad json')) : vi.fn().mockResolvedValue(json),
  } as unknown as Response;
}

function makeService() {
  return new AudiobookshelfClientService(mockConfig as any);
}

describe('AudiobookshelfClientService', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedEnsureSafeUrl.mockResolvedValue(undefined as never);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('getMe', () => {
    it('parses JSON on a successful response', async () => {
      const me = { id: 'u1', username: 'alice', email: null, type: 'user', mediaProgress: [] };
      fetchMock.mockResolvedValueOnce(makeResponse({ status: 200, json: me }));

      const result = await makeService().getMe(1, SERVER_URL, TOKEN);

      expect(result).toEqual(me);
    });

    it('sends the token as an Authorization Bearer header (not a query param)', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse({ status: 200, json: {} }));

      await makeService().getMe(1, SERVER_URL, TOKEN);

      const [calledUrl, init] = fetchMock.mock.calls[0];
      expect((init as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
      expect(String(calledUrl)).toBe('https://abs.example.com/api/me');
      expect(String(calledUrl)).not.toContain(TOKEN);
      expect((init as RequestInit).method).toBe('GET');
      expect((init as RequestInit).redirect).toBe('manual');
    });

    it('invokes the SSRF guard on every outbound call', async () => {
      fetchMock.mockResolvedValue(makeResponse({ status: 200, json: {} }));
      const service = makeService();

      await service.getMe(1, SERVER_URL, TOKEN);
      await service.getLibraries(1, SERVER_URL, TOKEN);

      expect(mockedEnsureSafeUrl).toHaveBeenCalledTimes(2);
      expect(mockedEnsureSafeUrl).toHaveBeenCalledWith('https://abs.example.com/api/me', expect.any(Object));
      expect(mockedEnsureSafeUrl).toHaveBeenCalledWith('https://abs.example.com/api/libraries', expect.any(Object));
    });

    it('throws invalid_url when the SSRF guard rejects the target', async () => {
      mockedEnsureSafeUrl.mockRejectedValueOnce(new Error('private address'));

      await expect(makeService().getMe(1, SERVER_URL, TOKEN)).rejects.toMatchObject({
        name: 'AudiobookshelfApiError',
        code: 'invalid_url',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws invalid_url for an unparseable server URL without calling fetch', async () => {
      await expect(makeService().getMe(1, 'not a url', TOKEN)).rejects.toMatchObject({ code: 'invalid_url' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('getListeningSessions', () => {
    it('parses JSON and passes paging query params', async () => {
      const sessions = { total: 0, numPages: 1, page: 0, itemsPerPage: 10, sessions: [] };
      fetchMock.mockResolvedValueOnce(makeResponse({ status: 200, json: sessions }));

      const result = await makeService().getListeningSessions(1, SERVER_URL, TOKEN, 2, 10);

      expect(result).toEqual(sessions);
      const [calledUrl] = fetchMock.mock.calls[0];
      const url = new URL(String(calledUrl));
      expect(url.pathname).toBe('/api/me/listening-sessions');
      expect(url.searchParams.get('page')).toBe('2');
      expect(url.searchParams.get('itemsPerPage')).toBe('10');
    });
  });

  describe('error mapping', () => {
    it('maps a non-2xx response to an http AudiobookshelfApiError carrying the status', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse({ status: 500 }));

      await expect(makeService().getMe(1, SERVER_URL, TOKEN)).rejects.toMatchObject({
        name: 'AudiobookshelfApiError',
        code: 'http',
        status: 500,
      });
    });

    it.each([401, 403])('surfaces status %d so the sync layer can auto-disable', async (status) => {
      fetchMock.mockResolvedValueOnce(makeResponse({ status }));

      const error = await makeService()
        .getMe(1, SERVER_URL, TOKEN)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AudiobookshelfApiError);
      expect((error as AudiobookshelfApiError).code).toBe('http');
      expect((error as AudiobookshelfApiError).status).toBe(status);
    });

    it('rejects a 3xx redirect response with code redirect', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse({ status: 302 }));

      await expect(makeService().getMe(1, SERVER_URL, TOKEN)).rejects.toMatchObject({
        code: 'redirect',
        status: 302,
      });
    });

    it('rejects an opaqueredirect (redirect:manual) response with code redirect', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse({ status: 0, type: 'opaqueredirect' }));

      await expect(makeService().getMe(1, SERVER_URL, TOKEN)).rejects.toMatchObject({ code: 'redirect' });
    });

    it('maps an aborted request (timeout) to code timeout', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      fetchMock.mockRejectedValueOnce(abortError);

      await expect(makeService().getMe(1, SERVER_URL, TOKEN)).rejects.toMatchObject({ code: 'timeout' });
    });

    it('maps a generic fetch failure to code network', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

      await expect(makeService().getMe(1, SERVER_URL, TOKEN)).rejects.toMatchObject({ code: 'network' });
    });

    it('maps unparseable JSON to code invalid_response', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse({ status: 200, jsonThrows: true }));

      await expect(makeService().getMe(1, SERVER_URL, TOKEN)).rejects.toMatchObject({ code: 'invalid_response' });
    });

    it('never writes the token into a failure log line', async () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      fetchMock.mockResolvedValueOnce(makeResponse({ status: 500 }));

      await makeService()
        .getMe(1, SERVER_URL, TOKEN)
        .catch(() => undefined);

      expect(errorSpy).toHaveBeenCalled();
      for (const call of errorSpy.mock.calls) {
        expect(String(call[0])).not.toContain(TOKEN);
      }
    });
  });

  describe('testConnection', () => {
    it('returns success and username on a good getMe response', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse({ status: 200, json: { username: 'alice' } }));

      const result = await makeService().testConnection(1, SERVER_URL, TOKEN);

      expect(result).toEqual({ success: true, username: 'alice' });
    });

    it('maps a 401 to a friendly token-rejected message', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse({ status: 401 }));

      const result = await makeService().testConnection(1, SERVER_URL, TOKEN);

      expect(result).toEqual({ success: false, error: 'Audiobookshelf rejected the API token' });
    });

    it('maps a timeout to a friendly did-not-respond message', async () => {
      const abortError = new Error('aborted');
      abortError.name = 'AbortError';
      fetchMock.mockRejectedValueOnce(abortError);

      const result = await makeService().testConnection(1, SERVER_URL, TOKEN);

      expect(result).toEqual({ success: false, error: 'The Audiobookshelf server did not respond in time' });
    });
  });
});
