import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as fetchWithThrottleModule from '../../fetch-with-throttle';
import { HardcoverClient } from './hardcover.client';
import { HardcoverRequestError } from './hardcover.errors';

vi.mock('../../fetch-with-throttle', () => ({
  fetchWithThrottle: vi.fn(),
}));

describe('HardcoverClient', () => {
  let client: HardcoverClient;
  const apiKey = 'test-api-key';

  beforeEach(() => {
    client = new HardcoverClient();
    vi.clearAllMocks();
  });

  it('sends a Bearer Authorization header', async () => {
    const mockFetch = vi.mocked(fetchWithThrottleModule.fetchWithThrottle);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { books: [] } }),
    } as Response);

    await client.searchByIsbn('1234567890', apiKey);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${apiKey}`,
        }),
      }),
    );
  });

  it('does not duplicate Bearer prefix when already provided', async () => {
    const mockFetch = vi.mocked(fetchWithThrottleModule.fetchWithThrottle);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { books: [] } }),
    } as Response);

    await client.searchByIsbn('1234567890', 'Bearer test-api-key');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-api-key',
        }),
      }),
    );
  });

  it('accepts quoted bearer token input', async () => {
    const mockFetch = vi.mocked(fetchWithThrottleModule.fetchWithThrottle);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { books: [] } }),
    } as Response);

    await client.searchByIsbn('1234567890', '"Bearer test-api-key"');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-api-key',
        }),
      }),
    );
  });

  it.each([
    ['ISBN search', () => client.searchByIsbn('9780756404079', apiKey)],
    ['stored ID lookup', () => client.lookupBySlug('the-name-of-the-wind', apiKey)],
  ])('requests cached tags for %s', async (_label, request) => {
    const mockFetch = vi.mocked(fetchWithThrottleModule.fetchWithThrottle);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { books: [] } }),
    } as Response);

    await request();

    const options = mockFetch.mock.calls[0][1];
    expect(typeof options?.body).toBe('string');
    if (typeof options?.body !== 'string') throw new TypeError('Expected a JSON request body');
    const body = JSON.parse(options.body) as { query: string };
    expect(body.query).toMatch(/\bcached_tags\b/);
  });

  it('returns empty array when API returns non-ok status', async () => {
    const mockFetch = vi.mocked(fetchWithThrottleModule.fetchWithThrottle);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
    } as Response);

    const result = await client.searchByIsbn('123', 'key');
    expect(result).toEqual([]);
  });

  it('returns empty array when fetch fails', async () => {
    const mockFetch = vi.mocked(fetchWithThrottleModule.fetchWithThrottle);
    mockFetch.mockRejectedValue(new Error('Network error'));

    const result = await client.searchBooks('query', 'key');
    expect(result).toEqual([]);
  });

  it('unwraps author search hit documents', async () => {
    const mockFetch = vi.mocked(fetchWithThrottleModule.fetchWithThrottle);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          data: { search: { results: { hits: [{ document: { id: 42, name: 'Arcane Cadence', books_count: 12 } }, {}] } } },
        }),
    } as Response);

    const result = await client.searchAuthors('Arcane Cadence', apiKey);

    expect(result).toEqual([{ id: 42, name: 'Arcane Cadence', books_count: 12 }]);
    const body = vi.mocked(mockFetch).mock.calls[0][1]?.body;
    expect(typeof body).toBe('string');
    expect(JSON.parse(body as string)).toMatchObject({
      variables: { q: 'Arcane Cadence' },
    });
  });

  it('fetches one page of author contributions', async () => {
    const mockFetch = vi.mocked(fetchWithThrottleModule.fetchWithThrottle);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { authors: [{ id: 42, name: 'Author', contributions: [] }] } }),
    } as Response);

    const result = await client.fetchAuthorContributions(42, 100, apiKey);

    expect(result).toEqual({ id: 42, name: 'Author', contributions: [] });
    const body = vi.mocked(mockFetch).mock.calls[0][1]?.body;
    expect(typeof body).toBe('string');
    expect(JSON.parse(body as string)).toMatchObject({
      variables: { id: 42, off: 100 },
    });
  });

  it('rethrows ProviderThrottleError on 429', async () => {
    const { ProviderThrottleError } = await import('../../provider-throttle.error.js');
    const mockFetch = vi.mocked(fetchWithThrottleModule.fetchWithThrottle);
    mockFetch.mockRejectedValue(new ProviderThrottleError(100, 'google'));

    await expect(client.searchByIsbn('123', 'key')).rejects.toThrow(ProviderThrottleError);
  });

  it('fetches one edition window per format for a bounded slug batch', async () => {
    const ebook = { reading_format_id: 4, release_date: '2026-09-10', asin: null, isbn_13: null, isbn_10: null, users_count: 0, language: null };
    const audio = { ...ebook, reading_format_id: 2, asin: 'B012345678', users_count: 120 };
    const print = { ...ebook, reading_format_id: 1, isbn_10: '123456789X' };
    const books = [{ slug: 'book-one', release_date: null, ebook_editions: [ebook], audio_editions: [audio], print_editions: [print] }];
    const mockFetch = vi.mocked(fetchWithThrottleModule.fetchWithThrottle);
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ data: { books } }) } as Response);

    await expect(client.fetchEditionsBySlugs(['book-one'], apiKey)).resolves.toEqual([
      { slug: 'book-one', release_date: null, editions: [ebook, audio, print] },
    ]);
    const request = JSON.parse(mockFetch.mock.calls[0][1]?.body as string) as { query: string; variables: unknown };
    expect(request.variables).toEqual({ slugs: ['book-one'] });
    expect(request.query).toContain('slug: { _in: $slugs }');
    expect(request.query).toContain('ebook_editions: editions(where: { reading_format_id: { _eq: 4 } }, order_by: { users_count: desc }, limit: 15)');
    expect(request.query).toContain('audio_editions: editions(where: { reading_format_id: { _eq: 2 } }, order_by: { users_count: desc }, limit: 15)');
    expect(request.query).toContain('print_editions: editions(where: { reading_format_id: { _eq: 1 } }, order_by: { users_count: desc }, limit: 15)');
    expect(request.query).not.toContain('limit: 40');
  });

  it('keeps a book whose format windows are absent', async () => {
    const mockFetch = vi.mocked(fetchWithThrottleModule.fetchWithThrottle);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { books: [{ slug: 'book-one', release_date: '2026-09-10' }] } }),
    } as Response);

    await expect(client.fetchEditionsBySlugs(['book-one'], apiKey)).resolves.toEqual([
      { slug: 'book-one', release_date: '2026-09-10', editions: [] },
    ]);
  });

  it('returns immediately for an empty slug batch', async () => {
    await expect(client.fetchEditionsBySlugs([], apiKey)).resolves.toEqual([]);
    expect(fetchWithThrottleModule.fetchWithThrottle).not.toHaveBeenCalled();
  });
});

// A failed request used to be indistinguishable from an empty answer. The metadata providers still
// want it that way; the bibliography path cannot afford it, because its caller decides from the
// outcome whether to overwrite a stored catalog.
describe('HardcoverClient failure surfacing', () => {
  const apiKey = 'test-api-key';
  let client: HardcoverClient;

  beforeEach(() => {
    client = new HardcoverClient();
    vi.clearAllMocks();
  });

  it('throws with the status when a caller opted in and the response is not ok', async () => {
    vi.mocked(fetchWithThrottleModule.fetchWithThrottle).mockResolvedValue({ ok: false, status: 503 } as Response);

    await expect(client.searchAuthors('Alexander Olson', apiKey, undefined, { surfaceFailures: true })).rejects.toMatchObject({
      name: 'HardcoverRequestError',
      status: 503,
    });
  });

  it('throws without a status when the request never reached a response', async () => {
    vi.mocked(fetchWithThrottleModule.fetchWithThrottle).mockRejectedValue(new Error('socket hang up'));

    const failure = await client.searchAuthors('Alexander Olson', apiKey, undefined, { surfaceFailures: true }).catch((error) => error);

    expect(failure).toBeInstanceOf(HardcoverRequestError);
    expect(failure.status).toBeNull();
    expect((failure.cause as Error).message).toBe('socket hang up');
  });

  it('treats a 200 carrying GraphQL errors as a failed request', async () => {
    vi.mocked(fetchWithThrottleModule.fetchWithThrottle).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ errors: [{ message: 'rate limited' }], data: null }),
    } as Response);

    await expect(client.searchAuthors('Alexander Olson', apiKey, undefined, { surfaceFailures: true })).rejects.toMatchObject({
      name: 'HardcoverRequestError',
      status: 200,
    });
  });

  // Half-served pages are the dangerous shape: the author is there, so nothing looks wrong, and the
  // short page ends pagination and quietly shortens the catalog.
  it('treats a partly served contributions page as a failed request', async () => {
    vi.mocked(fetchWithThrottleModule.fetchWithThrottle).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ errors: [{ message: 'timeout' }], data: { authors: [{ id: 1, contributions: null }] } }),
    } as Response);

    await expect(client.fetchAuthorContributions(1, 100, apiKey, undefined, { surfaceFailures: true })).rejects.toBeInstanceOf(HardcoverRequestError);
  });

  it('surfaces failures from an editions batch when requested', async () => {
    vi.mocked(fetchWithThrottleModule.fetchWithThrottle).mockResolvedValue({ ok: false, status: 503 } as Response);

    await expect(client.fetchEditionsBySlugs(['book'], apiKey, undefined, { surfaceFailures: true })).rejects.toMatchObject({
      name: 'HardcoverRequestError',
      status: 503,
    });
  });

  it('leaves GraphQL errors alone for a caller that did not opt in', async () => {
    vi.mocked(fetchWithThrottleModule.fetchWithThrottle).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ errors: [{ message: 'rate limited' }], data: null }),
    } as Response);

    await expect(client.searchAuthors('Alexander Olson', apiKey)).resolves.toEqual([]);
  });

  it('keeps an internal timeout a failure even once the caller aborts a moment later', async () => {
    const controller = new AbortController();
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    vi.mocked(fetchWithThrottleModule.fetchWithThrottle).mockImplementation(() => {
      controller.abort();
      return Promise.reject(timeout);
    });

    const failure = await client.searchAuthors('Alexander Olson', apiKey, controller.signal, { surfaceFailures: true }).catch((error) => error);

    expect(failure).toBeInstanceOf(HardcoverRequestError);
    expect(failure.cause).toBe(timeout);
  });

  it('hands back the abort of a caller that cancelled its own request', async () => {
    const controller = new AbortController();
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    // fetch rejects with the signal's own reason, so the mock has to abort with it to be faithful.
    vi.mocked(fetchWithThrottleModule.fetchWithThrottle).mockImplementation(() => {
      controller.abort(abort);
      return Promise.reject(abort);
    });

    await expect(client.searchAuthors('Alexander Olson', apiKey, controller.signal, { surfaceFailures: true })).rejects.toBe(abort);
  });

  it('leaves a caller that did not opt in with the empty answer it has always had', async () => {
    vi.mocked(fetchWithThrottleModule.fetchWithThrottle).mockResolvedValue({ ok: false, status: 503 } as Response);

    await expect(client.searchAuthors('Alexander Olson', apiKey)).resolves.toEqual([]);
    await expect(client.searchByIsbn('1234567890', apiKey)).resolves.toEqual([]);
    await expect(client.lookupBySlug('some-slug', apiKey)).resolves.toBeNull();
  });
});
