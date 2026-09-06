import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderConfigurations } from '@bookorbit/types';
import { AudibleBibliographyProvider } from './audible-bibliography.provider';

vi.mock('../../metadata-fetch/providers/provider-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../metadata-fetch/providers/provider-utils')>()),
  sleep: vi.fn(() => Promise.resolve()),
}));

const AUTHOR = 'Brandon Sanderson';

function product(index: number): Record<string, unknown> {
  return { asin: `ASIN${index}`, title: `Book ${index}`, authors: [{ name: AUTHOR }] };
}

function providerConfig(): ProviderConfigurations {
  return { audible: { enabled: true, domain: 'com' } } as ProviderConfigurations;
}

/** One fetch stub serving `total` products in pages of 50, recording the pages it was asked for. */
function stubCatalog(total: number, reportedTotal: number | null = total): { pages: number[] } {
  const pages: number[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const page = Number(new URL(url).searchParams.get('page'));
      pages.push(page);
      const slice = Array.from({ length: Math.max(0, Math.min(50, total - page * 50)) }, (_, offset) => product(page * 50 + offset));
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve(reportedTotal == null ? { products: slice } : { products: slice, total_results: reportedTotal }),
      } as unknown as Response);
    }),
  );
  return { pages };
}

describe('AudibleBibliographyProvider pagination', () => {
  let provider: AudibleBibliographyProvider;

  beforeEach(() => {
    vi.unstubAllGlobals();
    provider = new AudibleBibliographyProvider();
  });

  it('pages past the old three-page cap up to the provider-reported total', async () => {
    const catalog = stubCatalog(201);
    const author = await provider.resolveAuthor(AUTHOR, providerConfig());

    expect(author?.bookCount).toBe(201);
    expect(catalog.pages).toEqual([0, 1, 2, 3, 4]);
  });

  it('stops on the empty page after an exact multiple of the page size', async () => {
    const catalog = stubCatalog(100);
    const author = await provider.resolveAuthor(AUTHOR, providerConfig());

    expect(author?.bookCount).toBe(100);
    expect(catalog.pages).toEqual([0, 1, 2]);
  });

  it('keeps paging past an understated total_results rather than truncating the catalog', async () => {
    const catalog = stubCatalog(201, 60);
    const author = await provider.resolveAuthor(AUTHOR, providerConfig());

    expect(author?.bookCount).toBe(201);
    expect(catalog.pages).toEqual([0, 1, 2, 3, 4]);
  });

  it('stops on a short page when the provider reports no total', async () => {
    const catalog = stubCatalog(70, null);
    const author = await provider.resolveAuthor(AUTHOR, providerConfig());

    expect(author?.bookCount).toBe(70);
    expect(catalog.pages).toEqual([0, 1]);
  });

  it('caps at ten pages and warns when the author has more than the cap holds', async () => {
    const catalog = stubCatalog(900);
    const warn = vi.spyOn(provider['logger'], 'warn').mockImplementation(() => {});
    const author = await provider.resolveAuthor(AUTHOR, providerConfig());

    expect(author?.bookCount).toBe(500);
    expect(catalog.pages).toHaveLength(10);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('capped=true'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fetched=500 total=900'));
  });
});
