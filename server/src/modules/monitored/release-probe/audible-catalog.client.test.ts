import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderThrottleError } from '../../metadata-fetch/provider-throttle.error';
import { AudibleCatalogClient } from './audible-catalog.client';

describe('AudibleCatalogClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks the owner regional catalog for one keyword page', async () => {
    const products = [{ asin: 'B0AUDIO0001', title: 'The Infinite Extent' }];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ products }), { status: 200 }));

    await expect(new AudibleCatalogClient().searchProducts('The Infinite Extent James S. A. Corey', 'co.uk')).resolves.toEqual(products);

    const url = new URL(fetchSpy.mock.calls[0]?.[0] as string);
    expect(url.origin).toBe('https://api.audible.co.uk');
    expect(url.pathname).toBe('/1.0/catalog/products');
    expect(url.searchParams.get('keywords')).toBe('The Infinite Extent James S. A. Corey');
    expect(url.searchParams.get('num_results')).toBe('10');
    expect(url.searchParams.get('response_groups')).toBe('product_attrs,product_desc,contributors');
  });

  it('reads an answer without products as an empty result', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await expect(new AudibleCatalogClient().searchProducts('Book Author', 'com')).resolves.toEqual([]);
  });

  it('turns a non-ok response into a gateway exception', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));

    await expect(new AudibleCatalogClient().searchProducts('Book Author', 'com')).rejects.toMatchObject({ status: 502 });
  });

  it('turns HTTP 429 into a provider throttle', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 429 }));

    await expect(new AudibleCatalogClient().searchProducts('Book Author', 'com')).rejects.toBeInstanceOf(ProviderThrottleError);
  });
});
