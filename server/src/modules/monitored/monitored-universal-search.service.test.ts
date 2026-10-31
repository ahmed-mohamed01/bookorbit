import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { StatsCache } from '../../common/cache/stats-cache';
import type { RequestUser } from '../../common/types/request-user';
import type { HardcoverAuthorSearchDocument, HardcoverSearchDocument } from '../metadata-fetch/providers/hardcover/hardcover.types';
import { MonitoredUniversalSearchService } from './monitored-universal-search.service';

/** Only the hardcover half is read here, and its key is nullable so an unset config can be expressed. */
type ProviderConfigurationStub = { hardcover?: { enabled: boolean; apiKey: string | null } };

const CONFIGURED = { hardcover: { enabled: true, apiKey: 'secret-key-value' } } satisfies ProviderConfigurationStub;
const UNCONFIGURED = { hardcover: { enabled: false, apiKey: null } } satisfies ProviderConfigurationStub;
const USER = { id: 7, isSuperuser: false } as RequestUser;

function bookDoc(patch: Partial<HardcoverSearchDocument> = {}): HardcoverSearchDocument {
  return {
    id: '1',
    slug: 'slug-1',
    title: 'A Fresh Title',
    author_names: ['Fresh Author'],
    release_year: 2024,
    ...patch,
  };
}

function authorHit(patch: Partial<HardcoverAuthorSearchDocument> = {}): HardcoverAuthorSearchDocument {
  return { id: 101, name: 'Fresh Author', books_count: 4, genres: ['fantasy'], ...patch };
}

function makeService() {
  const hardcover = {
    searchBooks: vi.fn().mockResolvedValue([]),
    searchAuthors: vi.fn().mockResolvedValue([]),
    queueDelayMs: vi.fn().mockReturnValue(0),
    // The service makes one combined request; the per-kind mocks above let each test shape either half.
    searchBooksAndAuthors: vi.fn(async (q: string, apiKey: string, signal?: AbortSignal) => {
      const [books, authors] = await Promise.all([hardcover.searchBooks(q, apiKey, signal), hardcover.searchAuthors(q, apiKey, signal)]);
      return { books, authors };
    }),
  };
  const store = {
    searchCatalogWorks: vi.fn(),
    accessibleLibraryIds: vi.fn().mockResolvedValue([2, 3]),
    findLibraryHardcoverIds: vi.fn().mockResolvedValue(new Set<string>()),
    findCatalogHardcoverIds: vi.fn().mockResolvedValue(new Set<string>()),
    findLibraryTitleAuthorKeys: vi.fn().mockResolvedValue(new Set<string>()),
    findCatalogTitleAuthorKeys: vi.fn().mockResolvedValue(new Set<string>()),
    findMonitoredIdsByNames: vi.fn().mockResolvedValue(new Map<string, string>()),
    findMonitoredHardcoverProviderIds: vi.fn().mockResolvedValue(new Set<string>()),
    findLocalAuthorNameKeys: vi.fn().mockResolvedValue(new Set<string>()),
  };
  const providerConfigs = { forUser: vi.fn().mockResolvedValue(CONFIGURED) };
  const service = new MonitoredUniversalSearchService(store as never, hardcover as never, providerConfigs as never);
  const cache = (service as unknown as { hardcoverCache: StatsCache }).hardcoverCache;
  const logger = (service as unknown as { logger: Logger }).logger;
  const startEndLog = vi.spyOn(logger, 'log').mockImplementation(() => undefined);
  const failLog = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  return { service, hardcover, store, providerConfigs, cache, startEndLog, failLog };
}

describe('MonitoredUniversalSearchService hardcover search', () => {
  it('asks Hardcover for books and authors in one request that surfaces failures', async () => {
    const { service, hardcover } = makeService();

    await service.searchHardcover(USER, 'mistborn');

    expect(hardcover.searchBooksAndAuthors).toHaveBeenCalledExactlyOnceWith('mistborn', 'secret-key-value', expect.any(AbortSignal), {
      surfaceFailures: true,
    });
  });

  it('returns an unavailable answer without calling the client when no key resolves', async () => {
    const { service, hardcover, providerConfigs } = makeService();
    providerConfigs.forUser.mockResolvedValue(UNCONFIGURED);

    await expect(service.searchHardcover(USER, 'mistborn')).resolves.toEqual({ available: false, books: [], authors: [] });
    expect(hardcover.searchBooks).not.toHaveBeenCalled();
    expect(hardcover.searchAuthors).not.toHaveBeenCalled();
  });

  it('lets a provider config failure propagate instead of reporting an empty search', async () => {
    const { service, providerConfigs, hardcover } = makeService();
    providerConfigs.forUser.mockRejectedValue(new Error('config store down'));

    await expect(service.searchHardcover(USER, 'mistborn')).rejects.toThrow('config store down');
    expect(hardcover.searchBooks).not.toHaveBeenCalled();
  });

  it('serves a cache hit without a second client call', async () => {
    const { service, hardcover } = makeService();
    hardcover.searchBooks.mockResolvedValue([bookDoc()]);

    await service.searchHardcover(USER, 'mistborn');
    await service.searchHardcover(USER, 'mistborn');

    expect(hardcover.searchBooks).toHaveBeenCalledTimes(1);
    expect(hardcover.searchAuthors).toHaveBeenCalledTimes(1);
  });

  it('caches the compacted book shape, never the provider description', async () => {
    const { service, hardcover, cache } = makeService();
    hardcover.searchBooks.mockResolvedValue([bookDoc({ description: 'A very long description. '.repeat(50) })]);
    const load = vi.fn();

    await service.searchHardcover(USER, 'mistborn');
    const cached = await cache.get<{ books: unknown[] }>('hardcover', 'mistborn', load);

    expect(load).not.toHaveBeenCalled();
    expect(cached.books[0]).toEqual({
      slug: 'slug-1',
      title: 'A Fresh Title',
      authorNames: ['Fresh Author'],
      seriesName: null,
      coverUrl: null,
    });
  });

  it('separates cache entries that only differ by word boundaries', async () => {
    const { service, hardcover } = makeService();
    hardcover.searchBooks.mockResolvedValue([bookDoc()]);

    await service.searchHardcover(USER, 'red rising');
    await service.searchHardcover(USER, 'redrising');

    expect(hardcover.searchBooks).toHaveBeenCalledTimes(2);
  });

  it('answers a punctuation-only query without calling hardcover or the cache', async () => {
    const { service, hardcover, cache } = makeService();
    const fetchSpy = vi.spyOn(cache, 'get');

    await expect(service.searchHardcover(USER, '...!?')).resolves.toEqual({ available: true, books: [], authors: [] });

    expect(hardcover.searchBooks).not.toHaveBeenCalled();
    expect(hardcover.searchAuthors).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shares one client call between concurrent misses for the same query', async () => {
    const { service, hardcover } = makeService();
    let resolveBooks: (value: HardcoverSearchDocument[]) => void = () => undefined;
    hardcover.searchBooks.mockImplementation(
      () =>
        new Promise<HardcoverSearchDocument[]>((resolve) => {
          resolveBooks = resolve;
        }),
    );

    const first = service.searchHardcover(USER, 'mistborn');
    const second = service.searchHardcover(USER, 'mistborn');
    await vi.waitFor(() => expect(hardcover.searchBooks).toHaveBeenCalledTimes(1));
    resolveBooks([]);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(hardcover.searchBooks).toHaveBeenCalledTimes(1);
    expect(firstResult).toEqual(secondResult);
  });

  it('returns empty, logs a fail, and does not cache a failed search', async () => {
    const { service, hardcover, failLog } = makeService();
    hardcover.searchBooks.mockRejectedValueOnce(new Error('provider down'));

    await expect(service.searchHardcover(USER, 'mistborn')).resolves.toEqual({ available: true, books: [], authors: [] });
    expect(failLog).toHaveBeenCalledTimes(1);
    expect(failLog.mock.calls[0][0]).toMatch(
      /\[monitored\.hardcover_search\] \[fail\] userId=7 durationMs=\d+ errorClass=Error error="provider down"/,
    );

    await service.searchHardcover(USER, 'mistborn');
    expect(hardcover.searchBooks).toHaveBeenCalledTimes(2);
  });

  it('logs a timeout as an AbortError and returns empty', async () => {
    vi.useFakeTimers();
    try {
      const { service, hardcover, failLog } = makeService();
      hardcover.searchBooks.mockImplementation(
        (_q: string, _key: string, signal?: AbortSignal) =>
          new Promise<HardcoverSearchDocument[]>((_, reject) => {
            signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
          }),
      );

      const pending = service.searchHardcover(USER, 'mistborn');
      await vi.advanceTimersByTimeAsync(4000);
      await expect(pending).resolves.toEqual({ available: true, books: [], authors: [] });
      expect(failLog.mock.calls[0][0]).toMatch(/errorClass=AbortError/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips hardcover when the backlog plus one request would exceed the search budget', async () => {
    const { service, hardcover, startEndLog, failLog } = makeService();
    hardcover.queueDelayMs.mockReturnValue(2600);

    await expect(service.searchHardcover(USER, 'mistborn')).resolves.toEqual({ available: true, books: [], authors: [] });

    expect(hardcover.searchBooksAndAuthors).not.toHaveBeenCalled();
    expect(startEndLog).toHaveBeenCalledTimes(1);
    expect(startEndLog.mock.calls[0][0]).toMatch(/\[monitored\.hardcover_search\] \[end\] userId=7 busy=true durationMs=\d+/);
    expect(failLog).not.toHaveBeenCalled();
  });

  it('lets a dedupe store error propagate instead of answering an empty search', async () => {
    const { service, hardcover, store, failLog } = makeService();
    hardcover.searchBooks.mockResolvedValue([bookDoc()]);
    store.findLibraryTitleAuthorKeys.mockRejectedValue(new Error('db down'));

    await expect(service.searchHardcover(USER, 'mistborn')).rejects.toThrow('db down');
    expect(failLog).not.toHaveBeenCalled();
  });

  it('skips the accessible-library read when the provider answer holds no candidates', async () => {
    const { service, store } = makeService();

    await service.searchHardcover(USER, 'mistborn');

    expect(store.accessibleLibraryIds).not.toHaveBeenCalled();
  });

  it('dedupes every raw book the provider returns, never a page-sized slice', async () => {
    const { service, hardcover, store } = makeService();
    hardcover.searchBooks.mockResolvedValue(Array.from({ length: 12 }, (_, index) => bookDoc({ slug: `slug-${index}`, id: String(index) })));

    await service.searchHardcover(USER, 'mistborn');

    expect(store.findLibraryTitleAuthorKeys).toHaveBeenCalledWith(
      [2, 3],
      Array.from({ length: 12 }, () => 'A Fresh Title'),
    );
  });

  it('still searches when the backlog leaves room for its one request', async () => {
    const { service, hardcover } = makeService();
    hardcover.queueDelayMs.mockReturnValue(2000);

    await service.searchHardcover(USER, 'mistborn');

    expect(hardcover.searchBooksAndAuthors).toHaveBeenCalledOnce();
  });

  it('lists each book author once even when Hardcover repeats a name', async () => {
    const { service, hardcover } = makeService();
    hardcover.searchBooks.mockResolvedValue([bookDoc({ author_names: ['Eiichiro Oda', 'Andy Nakatani', 'Eiichiro Oda'] })]);

    const result = await service.searchHardcover(USER, 'one piece');

    expect(result.books[0]?.authorNames).toEqual(['Eiichiro Oda', 'Andy Nakatani']);
  });

  it('drops candidates the library or the catalog already hold by slug', async () => {
    const { service, hardcover, store } = makeService();
    hardcover.searchBooks.mockResolvedValue([
      bookDoc({ slug: 'library-slug', title: 'Library Book' }),
      bookDoc({ slug: 'catalog-slug', title: 'Watched Book' }),
      bookDoc({ slug: 'fresh-slug', title: 'Fresh Book' }),
    ]);
    store.findLibraryHardcoverIds.mockResolvedValue(new Set(['library-slug']));
    store.findCatalogHardcoverIds.mockResolvedValue(new Set(['catalog-slug']));

    const result = await service.searchHardcover(USER, 'mistborn');

    expect(result.available).toBe(true);
    expect(result.books).toHaveLength(1);
    expect(result.books[0]).toMatchObject({ slug: 'fresh-slug', title: 'Fresh Book' });
  });

  it('drops candidates matching a library or catalog title and first author', async () => {
    const { service, hardcover, store } = makeService();
    hardcover.searchBooks.mockResolvedValue([
      bookDoc({ slug: 'titled-slug', title: 'The Final Empire', author_names: ['Brandon Sanderson'] }),
      bookDoc({ slug: 'catalog-titled-slug', title: 'The Well of Ascension', author_names: ['Brandon Sanderson'] }),
      bookDoc({ slug: 'fresh-slug', title: 'The Hero of Ages', author_names: ['Brandon Sanderson'] }),
    ]);
    store.findLibraryTitleAuthorKeys.mockResolvedValue(new Set(['thefinalempire|brandonsanderson']));
    store.findCatalogTitleAuthorKeys.mockResolvedValue(new Set(['thewellofascension|brandonsanderson']));

    const result = await service.searchHardcover(USER, 'mistborn');

    expect(result.books).toHaveLength(1);
    expect(result.books[0]).toMatchObject({ slug: 'fresh-slug' });
  });

  it('drops a candidate when any of its authors, not only the first, matches an owned title key', async () => {
    const { service, hardcover, store } = makeService();
    hardcover.searchBooks.mockResolvedValue([bookDoc({ slug: 'good-omens', title: 'Good Omens', author_names: ['Terry Pratchett', 'Neil Gaiman'] })]);
    // The library book lists Gaiman first, so only his key is owned; the candidate lists Pratchett first.
    store.findLibraryTitleAuthorKeys.mockResolvedValue(new Set(['goodomens|neilgaiman']));

    const result = await service.searchHardcover(USER, 'good omens');

    expect(result.books).toEqual([]);
  });

  it('keeps at most five books from the raw candidate list', async () => {
    const { service, hardcover } = makeService();
    hardcover.searchBooks.mockResolvedValue(
      Array.from({ length: 10 }, (_, index) => bookDoc({ slug: `slug-${index}`, title: `Title ${index}`, id: String(index) })),
    );

    const result = await service.searchHardcover(USER, 'mistborn');

    expect(result.books).toHaveLength(5);
  });

  it('maps a hit onto the trimmed book shape, without a series position or release year', async () => {
    const { service, hardcover } = makeService();
    hardcover.searchBooks.mockResolvedValue([
      bookDoc({
        slug: 'series-slug',
        featured_series: { series: { name: 'A Series' }, position: 2 },
      }),
    ]);

    const result = await service.searchHardcover(USER, 'fresh');

    expect(result.books[0]).toEqual({
      slug: 'series-slug',
      title: 'A Fresh Title',
      authorNames: ['Fresh Author'],
      seriesName: 'A Series',
      coverUrl: null,
    });
  });

  it('drops monitored and local authors and keeps at most three', async () => {
    const { service, hardcover, store } = makeService();
    hardcover.searchAuthors.mockResolvedValue([
      authorHit({ id: 1, name: 'Monitored Name Smith' }),
      authorHit({ id: 2, name: 'Monitored By Id Smith' }),
      authorHit({ id: 3, name: 'Local Author Smith' }),
      authorHit({ id: 4, name: 'Kept One Smith' }),
      authorHit({ id: 5, name: 'Kept Two Smith' }),
      authorHit({ id: 6, name: 'Kept Three Smith' }),
      authorHit({ id: 7, name: 'Kept Four Smith' }),
    ]);
    store.findMonitoredIdsByNames.mockResolvedValue(new Map([['monitorednamesmith', 'monitor-1']]));
    store.findMonitoredHardcoverProviderIds.mockResolvedValue(new Set(['2']));
    store.findLocalAuthorNameKeys.mockResolvedValue(new Set(['localauthorsmith']));

    const result = await service.searchHardcover(USER, 'smith');

    expect(store.findLocalAuthorNameKeys).toHaveBeenCalledTimes(1);
    expect(store.findLocalAuthorNameKeys).toHaveBeenCalledWith(
      [2, 3],
      expect.arrayContaining(['Monitored Name Smith', 'Local Author Smith', 'Kept One Smith']),
    );
    expect(result.authors.map((author) => author.name)).toEqual(['Kept One Smith', 'Kept Two Smith', 'Kept Three Smith']);
    expect(result.authors[0]).toMatchObject({
      providerIds: { hardcover: '4' },
      localAuthorId: null,
      bookCount: 4,
      alreadyMonitoredId: null,
    });
  });

  it('only offers authors whose name starts with every query word', async () => {
    const { service, hardcover } = makeService();
    hardcover.searchAuthors.mockResolvedValue([
      authorHit({ id: 1, name: 'Wes Craven' }),
      authorHit({ id: 2, name: 'Brandon Sanderson' }),
      authorHit({ id: 3, name: 'Sandé Brandt' }),
    ]);

    const result = await service.searchHardcover(USER, 'brand sande');

    expect(result.authors.map((author) => author.name)).toEqual(['Brandon Sanderson', 'Sandé Brandt']);
  });

  it('never logs the resolved API key', async () => {
    const { service, hardcover, startEndLog, failLog } = makeService();
    hardcover.searchBooks.mockRejectedValue(new Error('provider exploded'));

    await service.searchHardcover(USER, 'mistborn');

    const lines = [...startEndLog.mock.calls, ...failLog.mock.calls].flat().map(String);
    expect(lines).toHaveLength(2);
    expect(lines.join(' ')).not.toContain('secret-key-value');
  });

  it('resolves the accessible libraries once per search and shares them with every library lookup', async () => {
    const { service, hardcover, store } = makeService();
    hardcover.searchBooks.mockResolvedValue([bookDoc()]);
    hardcover.searchAuthors.mockResolvedValue([authorHit()]);

    await service.searchHardcover(USER, 'fresh');

    expect(store.accessibleLibraryIds).toHaveBeenCalledTimes(1);
    expect(store.accessibleLibraryIds).toHaveBeenCalledWith(USER);
    expect(store.findLibraryHardcoverIds).toHaveBeenCalledWith([2, 3], ['slug-1']);
    expect(store.findLibraryTitleAuthorKeys).toHaveBeenCalledWith([2, 3], ['A Fresh Title']);
    expect(store.findLocalAuthorNameKeys).toHaveBeenCalledWith([2, 3], ['Fresh Author']);
  });

  it('delegates the watchlist search to the store with the caller and limit', async () => {
    const { service, store } = makeService();
    store.searchCatalogWorks.mockResolvedValue([]);

    await service.searchCatalogWorks(USER, 'mist', 5);

    expect(store.searchCatalogWorks).toHaveBeenCalledWith(USER, 'mist', 5);
  });
});
