import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as fetchWithThrottleModule from '../../fetch-with-throttle';
import { HardcoverClient } from './hardcover.client';

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
});
