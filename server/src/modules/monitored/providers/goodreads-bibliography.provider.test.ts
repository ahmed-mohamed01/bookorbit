import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfigurations } from '@bookorbit/types';

import { ProviderThrottleError } from '../../metadata-fetch/provider-throttle.error';
import type { GoodreadsProvider } from '../../metadata-fetch/providers/goodreads/goodreads.provider';
import { GoodreadsBibliographyProvider } from './goodreads-bibliography.provider';

const config = { goodreads: { enabled: true } } as ProviderConfigurations;
const fetchHtml = vi.fn();
const goodreads = { fetchHtml } as unknown as GoodreadsProvider;

describe('GoodreadsBibliographyProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the upstream HTML fetcher for author-list pages', async () => {
    fetchHtml.mockResolvedValue({
      html: '<a class="bookTitle"><span itemprop="name">A Book</span></a>',
      outcome: 'ok',
    });
    const provider = new GoodreadsBibliographyProvider(goodreads);

    await expect(provider.fetchObservations({ id: '42', name: 'Author', bookCount: null, imageUrl: null }, config)).resolves.toEqual([
      expect.objectContaining({ title: 'A Book', source: 'goodreads' }),
    ]);
    expect(fetchHtml).toHaveBeenCalledWith(expect.stringContaining('/author/list/42'), 'lookup', expect.objectContaining({ providerId: '42' }));
  });

  it('surfaces a durable block as a provider throttle failure', async () => {
    fetchHtml.mockResolvedValue({ html: null, outcome: 'blocked' });
    const provider = new GoodreadsBibliographyProvider(goodreads);

    await expect(provider.fetchObservations({ id: '42', name: 'Author', bookCount: null, imageUrl: null }, config)).rejects.toBeInstanceOf(
      ProviderThrottleError,
    );
  });
});
