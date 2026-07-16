import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AudiobookshelfApiError, AudiobookshelfClientService } from './audiobookshelf-client.service';

const SERVER_URL = 'https://abs.example.com';
const TOKEN = 'secret-token';

function makeFetchResponse(status: number, body: unknown, type: ResponseType = 'basic'): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    type,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('AudiobookshelfClientService', () => {
  let service: AudiobookshelfClientService;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    service = new AudiobookshelfClientService();
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the bearer token and requests /api/me', async () => {
    fetchSpy.mockResolvedValueOnce(makeFetchResponse(200, { id: 'u1', username: 'ada', mediaProgress: [] }));

    const result = await service.getMe(1, SERVER_URL, TOKEN);

    expect(result.username).toBe('ada');
    const [calledUrl, init] = fetchSpy.mock.calls[0];
    expect((calledUrl as URL).toString()).toBe('https://abs.example.com/api/me');
    expect(init).toMatchObject({
      method: 'GET',
      redirect: 'manual',
      headers: expect.objectContaining({
        Authorization: `Bearer ${TOKEN}`,
        'User-Agent': expect.stringContaining('BookOrbit'),
      }),
    });
    expect(init?.signal).toBeDefined();
  });

  it('passes pagination params to listening-sessions', async () => {
    fetchSpy.mockResolvedValueOnce(makeFetchResponse(200, { total: 0, numPages: 0, page: 2, itemsPerPage: 500, sessions: [] }));

    await service.getListeningSessions(1, SERVER_URL, TOKEN, 2, 500);

    const calledUrl = fetchSpy.mock.calls[0][0] as URL;
    expect(calledUrl.pathname).toBe('/api/me/listening-sessions');
    expect(calledUrl.searchParams.get('page')).toBe('2');
    expect(calledUrl.searchParams.get('itemsPerPage')).toBe('500');
  });

  it('encodes the library id in the items path', async () => {
    fetchSpy.mockResolvedValueOnce(makeFetchResponse(200, { results: [], total: 0, limit: 10, page: 0 }));

    await service.getLibraryItems(1, SERVER_URL, TOKEN, 'lib/1 a', { limit: 10, page: 0 });

    const calledUrl = fetchSpy.mock.calls[0][0] as URL;
    expect(calledUrl.pathname).toBe('/api/libraries/lib%2F1%20a/items');
    expect(calledUrl.searchParams.get('limit')).toBe('10');
  });

  it('preserves a subpath-mounted base URL', async () => {
    fetchSpy.mockResolvedValueOnce(makeFetchResponse(200, { libraries: [] }));

    await service.getLibraries(1, 'https://host.example.com/audiobookshelf/', TOKEN);

    const calledUrl = fetchSpy.mock.calls[0][0] as URL;
    expect(calledUrl.toString()).toBe('https://host.example.com/audiobookshelf/api/libraries');
  });

  it('rejects a non-http(s) server URL without fetching', async () => {
    await expect(service.getMe(1, 'ftp://abs.example.com', TOKEN)).rejects.toMatchObject({
      code: 'invalid_url',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an unparseable server URL without fetching', async () => {
    await expect(service.getMe(1, 'not a url', TOKEN)).rejects.toBeInstanceOf(AudiobookshelfApiError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a redirect response (opaqueredirect)', async () => {
    fetchSpy.mockResolvedValueOnce(makeFetchResponse(0, {}, 'opaqueredirect'));
    await expect(service.getMe(1, SERVER_URL, TOKEN)).rejects.toMatchObject({ code: 'redirect' });
  });

  it('rejects a 3xx redirect status', async () => {
    fetchSpy.mockResolvedValueOnce(makeFetchResponse(302, {}));
    await expect(service.getMe(1, SERVER_URL, TOKEN)).rejects.toMatchObject({ code: 'redirect', status: 302 });
  });

  it('maps a non-OK HTTP status to an http error carrying the status', async () => {
    fetchSpy.mockResolvedValueOnce(makeFetchResponse(401, {}));
    await expect(service.getMe(1, SERVER_URL, TOKEN)).rejects.toMatchObject({ code: 'http', status: 401 });
  });

  it('maps an abort to a timeout error', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    fetchSpy.mockRejectedValueOnce(abortError);
    await expect(service.getMe(1, SERVER_URL, TOKEN)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('maps a network failure to a network error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(service.getMe(1, SERVER_URL, TOKEN)).rejects.toMatchObject({ code: 'network' });
  });

  it('does not leak the token or raw body in thrown error messages', async () => {
    fetchSpy.mockResolvedValueOnce(makeFetchResponse(500, { secret: 'do-not-echo', token: TOKEN }));
    let caught: unknown;
    try {
      await service.getMe(1, SERVER_URL, TOKEN);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AudiobookshelfApiError);
    expect((caught as Error).message).not.toContain(TOKEN);
    expect((caught as Error).message).not.toContain('do-not-echo');
  });

  describe('testConnection', () => {
    it('returns success with the username on a valid connection', async () => {
      fetchSpy.mockResolvedValueOnce(makeFetchResponse(200, { id: 'u1', username: 'ada', mediaProgress: [] }));
      const result = await service.testConnection(1, SERVER_URL, TOKEN);
      expect(result).toEqual({ success: true, username: 'ada' });
    });

    it('returns a clean token error on 401 without leaking the token', async () => {
      fetchSpy.mockResolvedValueOnce(makeFetchResponse(401, {}));
      const result = await service.testConnection(1, SERVER_URL, TOKEN);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Audiobookshelf rejected the API token');
      expect(result.error).not.toContain(TOKEN);
    });

    it('returns a clean error on an invalid URL', async () => {
      const result = await service.testConnection(1, 'ftp://abs.example.com', TOKEN);
      expect(result).toEqual({ success: false, error: 'The Audiobookshelf server URL is invalid' });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
