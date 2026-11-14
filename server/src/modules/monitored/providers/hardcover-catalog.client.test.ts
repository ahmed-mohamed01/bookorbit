import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fetchWithThrottleModule from '../../metadata-fetch/fetch-with-throttle';
import { HardcoverClient } from '../../metadata-fetch/providers/hardcover/hardcover.client';
import { HardcoverRequestError } from '../../metadata-fetch/providers/hardcover/hardcover.errors';
import { HardcoverCatalogClient } from './hardcover-catalog.client';

vi.mock('../../metadata-fetch/fetch-with-throttle', () => ({ fetchWithThrottle: vi.fn() }));

describe('HardcoverCatalogClient', () => {
  let client: HardcoverCatalogClient;
  const apiKey = 'test-api-key';
  beforeEach(() => {
    client = new HardcoverCatalogClient(new HardcoverClient());
    vi.clearAllMocks();
  });

  it('searches books and authors in one request', async () => {
    const mockFetch = vi.mocked(fetchWithThrottleModule.fetchWithThrottle);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            books: { results: { hits: [{ document: { id: '1', slug: 'mistborn', title: 'Mistborn' } }] } },
            authors: { results: { hits: [{ document: { id: 2, name: 'Brandon Sanderson' } }] } },
          },
        }),
    } as Response);

    const result = await client.searchBooksAndAuthors('mistborn', apiKey);

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(result.books.map((book) => book.slug)).toEqual(['mistborn']);
    expect(result.authors.map((author) => author.name)).toEqual(['Brandon Sanderson']);
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
describe('HardcoverCatalogClient failure surfacing', () => {
  const apiKey = 'test-api-key';
  let client: HardcoverCatalogClient;

  beforeEach(() => {
    client = new HardcoverCatalogClient(new HardcoverClient());
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

  it('treats a 200 without well-formed hits as a failed request', async () => {
    vi.mocked(fetchWithThrottleModule.fetchWithThrottle).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: null }),
    } as Response);

    await expect(client.searchBooksAndAuthors('Mistborn', apiKey, undefined, { surfaceFailures: true })).rejects.toMatchObject({
      name: 'HardcoverRequestError',
      status: 200,
    });
  });

  it('throws on a malformed 200 even without surfaceFailures, since the only caller opts in', async () => {
    vi.mocked(fetchWithThrottleModule.fetchWithThrottle).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { books: { results: { hits: null } } } }),
    } as Response);

    await expect(client.searchBooksAndAuthors('Mistborn', apiKey)).rejects.toBeInstanceOf(HardcoverRequestError);
  });

  it('keeps a well-formed empty combined answer, since an empty array is a real answer', async () => {
    vi.mocked(fetchWithThrottleModule.fetchWithThrottle).mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          data: { books: { results: { hits: [] } }, authors: { results: { hits: [] } } },
        }),
    } as Response);

    await expect(client.searchBooksAndAuthors('Nothing', apiKey, undefined, { surfaceFailures: true })).resolves.toEqual({
      books: [],
      authors: [],
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
  });
});
