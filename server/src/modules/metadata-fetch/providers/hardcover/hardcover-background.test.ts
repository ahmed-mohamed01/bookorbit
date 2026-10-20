import { afterEach, describe, expect, it, vi } from 'vitest';
import { HardcoverRequestError } from './hardcover.errors';
import { HardcoverBibliographyProvider } from '../../../monitored/providers/hardcover-bibliography.provider';
import { classifyCatalogFetchError } from '../../../monitored/monitored-fetch-error';
import type { ProviderConfigurations } from '@bookorbit/types';
import { HardcoverClient } from './hardcover.client';
import { ProviderThrottleError } from '../../provider-throttle.error';

afterEach(() => vi.unstubAllGlobals());

describe('Hardcover background request errors', () => {
  it('preserves the timeout cause through the real HTTP wrapper', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            options.signal!.addEventListener('abort', () => reject(options.signal!.reason as Error), { once: true });
          }),
      ),
    );
    const client = new HardcoverClient();
    await expect(client.fetchAuthorContributions(1, 0, 'key', undefined, { surfaceFailures: true, timeoutMs: 5 })).rejects.toMatchObject({
      cause: { name: 'TimeoutError' },
    });
  });

  it('preserves Retry-After through the real HTTP wrapper', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '120' } })));
    const client = new HardcoverClient();
    const result = client.fetchAuthorContributions(1, 0, 'key', undefined, { surfaceFailures: true });
    await expect(result).rejects.toBeInstanceOf(ProviderThrottleError);
    await expect(result).rejects.toMatchObject({ retryAfterSeconds: 120 });
  });
});

it.each([
  [{ data: {} }, 'unavailable'],
  [{ data: { authors: [] } }, 'author_gone'],
] as const)('distinguishes malformed and empty author responses: %j', async (body, kind) => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => Promise.resolve(Response.json(body))),
  );
  const client = new HardcoverClient();
  const request = client.fetchAuthorContributions(1, 0, 'key', undefined, { surfaceFailures: true });
  if (kind === 'unavailable') {
    await expect(request).rejects.toBeInstanceOf(HardcoverRequestError);
    await expect(request).rejects.toMatchObject({ status: 200 });
  } else await expect(request).resolves.toBeNull();
  const provider = new HardcoverBibliographyProvider(client);
  const error = await provider
    .fetchObservations({ id: '1', name: 'Author', bookCount: null, imageUrl: null }, {
      hardcover: { enabled: true, apiKey: 'key' },
    } as ProviderConfigurations)
    .catch((error: unknown) => error);
  expect(classifyCatalogFetchError(error)).toMatchObject({ kind });
});
