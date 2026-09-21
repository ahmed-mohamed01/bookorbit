import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetadataProviderKey, type MonitoredFormat, type ProviderConfigurations } from '@bookorbit/types';

import { ProviderThrottleError } from '../metadata-fetch/provider-throttle.error';
import {
  LOOKUP_AMAZON_PAGES,
  LOOKUP_CACHE_TTL_MS,
  MonitoredReleaseDateLookupService,
  type ReleaseDateLookupTarget,
} from './monitored-release-date-lookup.service';

const TODAY = '2026-09-18T00:00:00.000Z';

function config(patch: Partial<ProviderConfigurations> = {}): ProviderConfigurations {
  return {
    hardcover: { enabled: true, apiKey: 'hc-key' },
    amazon: { enabled: false, domain: 'amazon.com', cookie: '' },
    audible: { enabled: true, domain: 'com' },
    audnexus: { enabled: false },
    librofm: { enabled: false },
    ...patch,
  } as ProviderConfigurations;
}

function target(patch: Partial<ReleaseDateLookupTarget> = {}): ReleaseDateLookupTarget {
  return {
    workId: 'work-1',
    title: 'The Infinite Extent',
    authorName: 'James S. A. Corey',
    hardcoverSlug: 'the-infinite-extent',
    audibleAsin: 'B012345678',
    format: 'ebook' as MonitoredFormat,
    userId: 7,
    ...patch,
  };
}

function edition(values: Record<string, unknown>) {
  return {
    reading_format_id: 4,
    release_date: null,
    asin: null,
    isbn_13: null,
    isbn_10: null,
    users_count: 0,
    language: { code2: 'en' },
    ...values,
  };
}

function harness(options: { config?: ProviderConfigurations } = {}) {
  // Hardcover answering with the requested book and nothing to date is the ordinary case; a batch
  // that answers without the book at all is a provider failure, so it is never the default.
  const hardcover = { fetchEditionsBySlugs: vi.fn().mockResolvedValue([{ slug: 'the-infinite-extent', release_date: null, editions: [] }]) };
  const apple = { searchEbookCandidates: vi.fn().mockResolvedValue([]) };
  const audible = { searchProducts: vi.fn().mockResolvedValue([]) };
  const amazon = { fetchProductPage: vi.fn(), fetchSearchPage: vi.fn() };
  const providerConfigs = { forUser: vi.fn().mockResolvedValue(options.config ?? config()) };
  const audnexusProvider = { search: vi.fn().mockResolvedValue([]) };
  const librofmProvider = { search: vi.fn().mockResolvedValue([]) };
  const registry = {
    find: vi.fn((key: string) => {
      if (key === MetadataProviderKey.AUDNEXUS) return audnexusProvider;
      if (key === MetadataProviderKey.LIBROFM) return librofmProvider;
      return undefined;
    }),
  };
  const service = new MonitoredReleaseDateLookupService(
    hardcover as never,
    apple as never,
    audible as never,
    amazon as never,
    providerConfigs as never,
    registry as never,
  );
  return { service, hardcover, apple, audible, amazon, providerConfigs, registry, audnexusProvider, librofmProvider };
}

describe('MonitoredReleaseDateLookupService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(TODAY));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns one candidate per dated Hardcover edition of the format, marking placeholders weak', async () => {
    const { service, hardcover } = harness();
    hardcover.fetchEditionsBySlugs.mockResolvedValue([
      {
        slug: 'the-infinite-extent',
        release_date: '2026-09-10',
        editions: [
          edition({ release_date: '2026-11-02', asin: 'B012345678', users_count: 40 }),
          edition({ release_date: '2027-01-10' }),
          edition({ release_date: null, isbn_10: '123456789X' }),
          edition({ reading_format_id: 2, release_date: '2026-10-01', asin: 'B0AUDIO0001' }),
        ],
      },
    ]);

    const result = await service.lookup(target());

    expect(hardcover.fetchEditionsBySlugs).toHaveBeenCalledWith(['the-infinite-extent'], 'hc-key', expect.any(AbortSignal), {
      surfaceFailures: true,
    });
    expect(result).toEqual({
      format: 'ebook',
      candidates: [
        {
          source: 'hardcover_edition',
          releaseDate: '2026-11-02',
          precision: 'day',
          label: 'B012345678',
          weak: false,
          url: 'https://hardcover.app/books/the-infinite-extent',
        },
        {
          source: 'hardcover_edition',
          releaseDate: '2027-01-10',
          precision: 'day',
          label: null,
          weak: true,
          url: 'https://hardcover.app/books/the-infinite-extent',
        },
      ],
      unavailable: [{ source: 'amazon', reason: 'not_configured' }],
      empty: ['apple'],
    });
  });

  it('drops a translation of an English work the way the probe does', async () => {
    const { service, hardcover } = harness();
    hardcover.fetchEditionsBySlugs.mockResolvedValue([
      {
        slug: 'the-infinite-extent',
        release_date: '2026-09-10',
        editions: [
          edition({ release_date: '2026-11-02', users_count: 400, language: { code2: 'en' } }),
          edition({ release_date: '2027-02-03', users_count: 8, language: { code2: 'fr' } }),
        ],
      },
    ]);

    const result = await service.lookup(target());

    expect(result.candidates.map((candidate) => candidate.releaseDate)).toEqual(['2026-11-02']);
  });

  it('reports Hardcover as unasked when the owner has no token', async () => {
    const unconfigured = config();
    unconfigured.hardcover = { enabled: false, apiKey: '' };
    const { service, hardcover } = harness({ config: unconfigured });

    const result = await service.lookup(target());

    expect(hardcover.fetchEditionsBySlugs).not.toHaveBeenCalled();
    expect(result.unavailable).toContainEqual({ source: 'hardcover_edition', reason: 'not_configured' });
  });

  it('asks nothing of Hardcover for a work it has no slug for', async () => {
    const { service, hardcover } = harness();

    const result = await service.lookup(target({ hardcoverSlug: null }));

    expect(hardcover.fetchEditionsBySlugs).not.toHaveBeenCalled();
    expect(result.unavailable).not.toContainEqual({ source: 'hardcover_edition', reason: 'not_configured' });
    expect(result.empty).not.toContain('hardcover_edition');
  });

  it('reports a Hardcover batch that answers without the requested book as failed', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, hardcover } = harness();
    hardcover.fetchEditionsBySlugs.mockResolvedValue([]);

    const result = await service.lookup(target());

    expect(result.unavailable).toContainEqual({ source: 'hardcover_edition', reason: 'failed' });
    expect(result.empty).not.toContain('hardcover_edition');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('source=hardcover_edition durationMs='));
  });

  it('keeps a Hardcover book with no dated edition of the format in empty', async () => {
    const { service, hardcover } = harness();
    hardcover.fetchEditionsBySlugs.mockResolvedValue([
      {
        slug: 'the-infinite-extent',
        release_date: '2026-09-10',
        editions: [edition({ reading_format_id: 2, release_date: '2026-10-01', asin: 'B0AUDIO0001' })],
      },
    ]);

    const result = await service.lookup(target());

    expect(result.empty).toContain('hardcover_edition');
    expect(result.unavailable).not.toContainEqual({ source: 'hardcover_edition', reason: 'failed' });
  });

  it('encodes the Hardcover slug into the listing url', async () => {
    const { service, hardcover } = harness();
    hardcover.fetchEditionsBySlugs.mockResolvedValue([
      {
        slug: 'the infinite extent?a=b',
        release_date: null,
        editions: [edition({ release_date: '2026-11-02', asin: 'B012345678', users_count: 40 })],
      },
    ]);

    const result = await service.lookup(target({ hardcoverSlug: 'the infinite extent?a=b' }));

    expect(result.candidates.map((candidate) => candidate.url)).toEqual(['https://hardcover.app/books/the%20infinite%20extent%3Fa%3Db']);
  });

  it('asks Apple for an ebook and never for an audiobook', async () => {
    const { service, apple, audible } = harness();
    apple.searchEbookCandidates.mockResolvedValue([
      { trackId: 1, trackName: 'The Infinite Extent', releaseDate: '2026-11-02', trackViewUrl: 'https://books.apple.com/us/book/1' },
      { trackId: 2, trackName: 'The Infinite Extent (Unabridged)', releaseDate: '2026-11-03', trackViewUrl: null },
    ]);

    const ebook = await service.lookup(target());
    const audiobook = await service.lookup(target({ format: 'audiobook' }));

    expect(apple.searchEbookCandidates).toHaveBeenCalledOnce();
    expect(apple.searchEbookCandidates).toHaveBeenCalledWith('The Infinite Extent', 'James S. A. Corey', 'us', expect.any(AbortSignal));
    expect(ebook.candidates).toEqual([
      {
        source: 'apple',
        releaseDate: '2026-11-02',
        precision: 'day',
        label: 'The Infinite Extent',
        weak: false,
        url: 'https://books.apple.com/us/book/1',
      },
      { source: 'apple', releaseDate: '2026-11-03', precision: 'day', label: 'The Infinite Extent (Unabridged)', weak: false, url: null },
    ]);
    expect(audiobook.candidates).toEqual([]);
    expect(audible.searchProducts).toHaveBeenCalledOnce();
  });

  it('drops an Apple listing url that is not an https address', async () => {
    const { service, apple } = harness();
    apple.searchEbookCandidates.mockResolvedValue([
      { trackId: 1, trackName: 'The Infinite Extent', releaseDate: '2026-11-02', trackViewUrl: 'javascript:alert(1)' },
      { trackId: 2, trackName: 'The Infinite Extent', releaseDate: '2026-11-03', trackViewUrl: 'http://books.apple.com/us/book/2' },
      { trackId: 3, trackName: 'The Infinite Extent', releaseDate: '2026-11-04', trackViewUrl: 'books.apple.com/us/book/3' },
    ]);

    const result = await service.lookup(target());

    expect(result.candidates.map((candidate) => candidate.url)).toEqual([null, null, null]);
  });

  it('never asks Libro.fm or AudNexus for an ebook even when both are enabled', async () => {
    const providerConfig = config({ audnexus: { enabled: true }, librofm: { enabled: true } } as Partial<ProviderConfigurations>);
    const { service, registry, audnexusProvider, librofmProvider } = harness({ config: providerConfig });

    await service.lookup(target());

    expect(audnexusProvider.search).not.toHaveBeenCalled();
    expect(librofmProvider.search).not.toHaveBeenCalled();
    expect(registry.find).not.toHaveBeenCalled();
  });

  it('keeps only Audible products whose title and author match, dated by either field', async () => {
    const { service, audible } = harness();
    audible.searchProducts.mockResolvedValue([
      { asin: 'B0AUDIO0001', title: 'The Infinite Extent', authors: [{ name: 'James S. A. Corey' }], release_date: '2026-10-01' },
      { asin: 'B0AUDIO0002', title: 'The Infinite Extent: Bonus', authors: [{ name: 'James S. A. Corey' }], issue_date: '2026-10-05' },
      { asin: 'B0AUDIO0003', title: 'A Different Book', authors: [{ name: 'James S. A. Corey' }], release_date: '2026-10-02' },
      { asin: 'B0AUDIO0004', title: 'The Infinite Extent', authors: [{ name: 'Somebody Else' }], release_date: '2026-10-03' },
      { asin: 'B0AUDIO0005', title: 'The Infinite Extent', authors: [{ name: 'James S. A. Corey' }] },
      {
        asin: 'B0AUDIO0006',
        title: 'The Infinite Extent',
        authors: [{ name: 'James S. A. Corey' }],
        release_date: '2026-10-06',
        format_type: 'AbRiDgEd',
      },
    ]);

    const result = await service.lookup(target({ format: 'audiobook' }));

    expect(audible.searchProducts).toHaveBeenCalledWith('The Infinite Extent James S. A. Corey', 'com', expect.any(AbortSignal));
    expect(result.candidates).toEqual([
      {
        source: 'audible',
        releaseDate: '2026-10-01',
        precision: 'day',
        label: 'The Infinite Extent',
        weak: false,
        url: 'https://www.audible.com/pd/B0AUDIO0001',
      },
      {
        source: 'audible',
        releaseDate: '2026-10-05',
        precision: 'day',
        label: 'The Infinite Extent: Bonus',
        weak: false,
        url: 'https://www.audible.com/pd/B0AUDIO0002',
      },
    ]);
  });

  it('matches an Audible author within one structured author entry instead of across contributors', async () => {
    const { service, audible } = harness();
    audible.searchProducts.mockResolvedValue([
      {
        asin: 'B0SPLIT0001',
        title: 'The Infinite Extent',
        authors: [{ name: 'James Smith' }, { name: 'Alice Corey' }],
        release_date: '2026-10-01',
      },
      {
        asin: 'B0MATCH0001',
        title: 'The Infinite Extent',
        authors: [{ name: 'Alice Smith' }, { name: 'James S. A. Corey' }],
        release_date: '2026-10-02',
      },
    ]);

    const result = await service.lookup(target({ format: 'audiobook' }));

    expect(result.candidates.filter((candidate) => candidate.source === 'audible').map((candidate) => candidate.label)).toEqual([
      'The Infinite Extent',
    ]);
    expect(result.candidates.find((candidate) => candidate.source === 'audible')?.releaseDate).toBe('2026-10-02');
  });

  it('does not request Audible when neither Audible nor AudNexus needs the shared catalog search', async () => {
    const providerConfig = config({ audible: { enabled: false, domain: 'co.uk' } } as Partial<ProviderConfigurations>);
    const { service, audible } = harness({ config: providerConfig });

    const result = await service.lookup(target({ format: 'audiobook' }));

    expect(audible.searchProducts).not.toHaveBeenCalled();
    expect(result.unavailable).toContainEqual({ source: 'audible', reason: 'not_configured' });
  });

  it('uses the shared Audible search to find an ASIN without asking AudNexus by title', async () => {
    const providerConfig = config({
      audible: { enabled: false, domain: 'co.uk' },
      audnexus: { enabled: true },
    } as Partial<ProviderConfigurations>);
    const { service, audible, audnexusProvider } = harness({ config: providerConfig });
    audible.searchProducts.mockResolvedValue([]);

    await service.lookup(target({ format: 'audiobook', audibleAsin: null }));

    expect(audible.searchProducts).toHaveBeenCalledOnce();
    expect(audnexusProvider.search).not.toHaveBeenCalled();
  });

  it('maps matching Libro.fm dates at day, month, and year precision', async () => {
    const providerConfig = config({ librofm: { enabled: true } } as Partial<ProviderConfigurations>);
    const { service, librofmProvider } = harness({ config: providerConfig });
    librofmProvider.search.mockResolvedValue([
      {
        provider: MetadataProviderKey.LIBROFM,
        providerId: '9780000000001',
        title: 'The Infinite Extent',
        subtitle: 'Bonus',
        authors: ['James S. A. Corey'],
        publishedDate: '2027-02-03',
        sourceUrl: 'https://libro.fm/audiobooks/9780000000001',
      },
      {
        provider: MetadataProviderKey.LIBROFM,
        providerId: '9780000000002',
        title: 'The Infinite Extent',
        subtitle: 'Bonus',
        authors: ['James S. A. Corey'],
        publishedDate: '2027-02',
      },
      {
        provider: MetadataProviderKey.LIBROFM,
        providerId: '9780000000003',
        title: 'The Infinite Extent',
        subtitle: 'Bonus',
        authors: ['James S. A. Corey'],
        publishedDate: '2027',
      },
      {
        provider: MetadataProviderKey.LIBROFM,
        providerId: '9780000000004',
        title: 'Another Book',
        authors: ['James S. A. Corey'],
        publishedDate: '2027-02-04',
      },
      {
        provider: MetadataProviderKey.LIBROFM,
        providerId: '9780000000005',
        title: 'The Infinite Extent',
        subtitle: 'Bonus',
        authors: ['Another Author'],
        publishedDate: '2027-02-05',
      },
      {
        provider: MetadataProviderKey.LIBROFM,
        providerId: '9780000000006',
        title: 'The Infinite Extent',
        subtitle: 'Bonus',
        authors: ['James S. A. Corey'],
        publishedDate: '2027-02-03T00:00:00Z',
      },
    ]);

    const result = await service.lookup(target({ title: 'The Infinite Extent: Bonus', format: 'audiobook' }));

    expect(librofmProvider.search).toHaveBeenCalledWith({
      title: 'The Infinite Extent: Bonus',
      author: 'James S. A. Corey',
      isAudiobook: true,
      signal: expect.any(AbortSignal),
    });
    expect(result.candidates.filter((candidate) => candidate.source === 'librofm')).toEqual([
      {
        source: 'librofm',
        releaseDate: '2027',
        precision: 'year',
        label: 'The Infinite Extent',
        weak: false,
        url: null,
      },
      {
        source: 'librofm',
        releaseDate: '2027-02',
        precision: 'month',
        label: 'The Infinite Extent',
        weak: false,
        url: null,
      },
      {
        source: 'librofm',
        releaseDate: '2027-02-03',
        precision: 'day',
        label: 'The Infinite Extent',
        weak: false,
        url: 'https://libro.fm/audiobooks/9780000000001',
      },
    ]);
  });

  it('drops a Libro.fm source url that is not an https address', async () => {
    const providerConfig = config({ librofm: { enabled: true } } as Partial<ProviderConfigurations>);
    const { service, librofmProvider } = harness({ config: providerConfig });
    librofmProvider.search.mockResolvedValue([
      {
        provider: MetadataProviderKey.LIBROFM,
        providerId: '9780000000001',
        title: 'The Infinite Extent',
        authors: ['James S. A. Corey'],
        publishedDate: '2027-02-03',
        sourceUrl: 'http://libro.fm/audiobooks/9780000000001',
      },
    ]);

    const result = await service.lookup(target({ format: 'audiobook' }));

    expect(result.candidates.filter((candidate) => candidate.source === 'librofm').map((candidate) => candidate.url)).toEqual([null]);
  });

  it('matches metadata authors one at a time and drops abridged editions', async () => {
    const providerConfig = config({ librofm: { enabled: true } } as Partial<ProviderConfigurations>);
    const { service, librofmProvider } = harness({ config: providerConfig });
    librofmProvider.search.mockResolvedValue([
      {
        provider: MetadataProviderKey.LIBROFM,
        providerId: 'split-author',
        title: 'The Infinite Extent',
        authors: ['James Smith', 'Alice Corey'],
        publishedDate: '2027-01-01',
      },
      {
        provider: MetadataProviderKey.LIBROFM,
        providerId: 'abridged',
        title: 'The Infinite Extent',
        authors: ['James S. A. Corey'],
        publishedDate: '2027-01-02',
        abridged: true,
      },
      {
        provider: MetadataProviderKey.LIBROFM,
        providerId: 'matching',
        title: 'The Infinite Extent',
        authors: ['Alice Smith', 'James S. A. Corey'],
        publishedDate: '2027-01-03',
      },
    ]);

    const result = await service.lookup(target({ format: 'audiobook' }));

    expect(result.candidates.filter((candidate) => candidate.source === 'librofm').map((candidate) => candidate.releaseDate)).toEqual(['2027-01-03']);
  });

  it('reports disabled Libro.fm as not configured without searching', async () => {
    const { service, librofmProvider } = harness();

    const result = await service.lookup(target({ format: 'audiobook' }));

    expect(librofmProvider.search).not.toHaveBeenCalled();
    expect(result.unavailable).toContainEqual({ source: 'librofm', reason: 'not_configured' });
  });

  it('reports Libro.fm throttling without failing the lookup', async () => {
    const providerConfig = config({ librofm: { enabled: true } } as Partial<ProviderConfigurations>);
    const { service, librofmProvider } = harness({ config: providerConfig });
    librofmProvider.search.mockRejectedValue(new ProviderThrottleError(undefined, 'HTTP 429'));

    const result = await service.lookup(target({ format: 'audiobook' }));

    expect(result.unavailable).toContainEqual({ source: 'librofm', reason: 'throttled' });
  });

  it('asks AudNexus by the target ASIN first, then unique matched Audible ASINs, capped at two', async () => {
    const providerConfig = config({ audnexus: { enabled: true } } as Partial<ProviderConfigurations>);
    const { service, audible, audnexusProvider } = harness({ config: providerConfig });
    audible.searchProducts.mockResolvedValue([
      { asin: 'B0TARGET001', title: 'The Infinite Extent', authors: [{ name: 'James S. A. Corey' }] },
      { asin: 'B0MATCH0001', title: 'The Infinite Extent: Bonus', authors: [{ name: 'James S. A. Corey' }] },
      { asin: 'B0MATCH0002', title: 'The Infinite Extent', authors: [{ name: 'James S. A. Corey' }] },
      { asin: 'B0WRONG0001', title: 'Another Book', authors: [{ name: 'James S. A. Corey' }] },
    ]);
    audnexusProvider.search.mockImplementation((params) => {
      const asin = params.existingProviderIds?.[MetadataProviderKey.AUDIBLE];
      return [
        {
          provider: MetadataProviderKey.AUDNEXUS,
          providerId: asin,
          title: 'The Infinite Extent',
          authors: ['James S. A. Corey'],
          publishedDate: asin === 'B0TARGET001' ? '2027-03-04' : '2027-03',
        },
      ];
    });

    const result = await service.lookup(target({ format: 'audiobook', audibleAsin: 'B0TARGET001' }));

    expect(audible.searchProducts).toHaveBeenCalledOnce();
    expect(audnexusProvider.search).toHaveBeenCalledTimes(2);
    expect(audnexusProvider.search).toHaveBeenNthCalledWith(1, {
      title: 'The Infinite Extent',
      author: 'James S. A. Corey',
      isAudiobook: true,
      existingProviderIds: { [MetadataProviderKey.AUDIBLE]: 'B0TARGET001' },
      signal: expect.any(AbortSignal),
    });
    expect(audnexusProvider.search).toHaveBeenNthCalledWith(2, {
      title: 'The Infinite Extent',
      author: 'James S. A. Corey',
      isAudiobook: true,
      existingProviderIds: { [MetadataProviderKey.AUDIBLE]: 'B0MATCH0001' },
      signal: expect.any(AbortSignal),
    });
    expect(result.candidates.filter((candidate) => candidate.source === 'audnexus')).toEqual([
      {
        source: 'audnexus',
        releaseDate: '2027-03',
        precision: 'month',
        label: 'The Infinite Extent',
        weak: false,
        url: 'https://www.audible.com/pd/B0MATCH0001',
      },
      {
        source: 'audnexus',
        releaseDate: '2027-03-04',
        precision: 'day',
        label: 'The Infinite Extent',
        weak: false,
        url: 'https://www.audible.com/pd/B0TARGET001',
      },
    ]);
  });

  it('does not ask AudNexus when neither the target nor matched Audible products supply an ASIN', async () => {
    const providerConfig = config({ audnexus: { enabled: true } } as Partial<ProviderConfigurations>);
    const { service, audible, audnexusProvider } = harness({ config: providerConfig });
    audible.searchProducts.mockResolvedValue([]);

    await service.lookup(target({ format: 'audiobook', audibleAsin: null }));

    expect(audnexusProvider.search).not.toHaveBeenCalled();
  });

  it('accepts an authorless AudNexus result whose provider id is the requested ASIN', async () => {
    const providerConfig = config({ audnexus: { enabled: true } } as Partial<ProviderConfigurations>);
    const { service, audnexusProvider } = harness({ config: providerConfig });
    audnexusProvider.search.mockResolvedValue([
      {
        provider: MetadataProviderKey.AUDNEXUS,
        providerId: 'B012345678',
        title: 'The Infinite Extent',
        publishedDate: '2027-04-05',
      },
      {
        provider: MetadataProviderKey.AUDNEXUS,
        providerId: 'B012345678',
        title: 'Another Book',
        publishedDate: '2027-04-06',
      },
    ]);

    const result = await service.lookup(target({ format: 'audiobook' }));

    expect(result.candidates.filter((candidate) => candidate.source === 'audnexus')).toEqual([
      {
        source: 'audnexus',
        releaseDate: '2027-04-05',
        precision: 'day',
        label: 'The Infinite Extent',
        weak: false,
        url: 'https://www.audible.com/pd/B012345678',
      },
    ]);
  });

  it('still requires an author match when an ASIN-addressed AudNexus result has authors', async () => {
    const providerConfig = config({ audnexus: { enabled: true } } as Partial<ProviderConfigurations>);
    const { service, audnexusProvider } = harness({ config: providerConfig });
    audnexusProvider.search.mockResolvedValue([
      {
        provider: MetadataProviderKey.AUDNEXUS,
        providerId: 'B012345678',
        title: 'The Infinite Extent',
        authors: ['Somebody Else'],
        publishedDate: '2027-04-05',
      },
    ]);

    const result = await service.lookup(target({ format: 'audiobook' }));

    expect(result.candidates.filter((candidate) => candidate.source === 'audnexus')).toEqual([]);
  });

  it('uses the target ASIN for AudNexus when the shared Audible search fails', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const providerConfig = config({ audnexus: { enabled: true } } as Partial<ProviderConfigurations>);
    const { service, audible, audnexusProvider } = harness({ config: providerConfig });
    audible.searchProducts.mockRejectedValue(new TypeError('audible exploded'));
    audnexusProvider.search.mockResolvedValue([
      {
        provider: MetadataProviderKey.AUDNEXUS,
        providerId: 'B012345678',
        title: 'The Infinite Extent',
        authors: ['James S. A. Corey'],
        publishedDate: '2027-04-05',
      },
    ]);

    const result = await service.lookup(target({ format: 'audiobook' }));

    expect(audible.searchProducts).toHaveBeenCalledOnce();
    expect(audnexusProvider.search).toHaveBeenCalledWith({
      title: 'The Infinite Extent',
      author: 'James S. A. Corey',
      isAudiobook: true,
      existingProviderIds: { [MetadataProviderKey.AUDIBLE]: 'B012345678' },
      signal: expect.any(AbortSignal),
    });
    expect(result.unavailable.filter(({ source, reason }) => source === 'audible' && reason === 'failed')).toHaveLength(1);
    expect(result.candidates).toContainEqual({
      source: 'audnexus',
      releaseDate: '2027-04-05',
      precision: 'day',
      label: 'The Infinite Extent',
      weak: false,
      url: 'https://www.audible.com/pd/B012345678',
    });
  });

  it('does not let AudNexus retry Audible title resolution when the shared search fails without an ASIN', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const providerConfig = config({ audnexus: { enabled: true } } as Partial<ProviderConfigurations>);
    const { service, audible, audnexusProvider } = harness({ config: providerConfig });
    audible.searchProducts.mockRejectedValue(new TypeError('audible exploded'));

    const result = await service.lookup(target({ format: 'audiobook', audibleAsin: null }));

    expect(audnexusProvider.search).not.toHaveBeenCalled();
    expect(result.unavailable).toContainEqual({ source: 'audible', reason: 'failed' });
    expect(result.unavailable).toContainEqual({ source: 'audnexus', reason: 'failed' });
  });

  it('reports the shared Audible throttle for both consumers without asking AudNexus again', async () => {
    const providerConfig = config({ audnexus: { enabled: true } } as Partial<ProviderConfigurations>);
    const { service, audible, audnexusProvider } = harness({ config: providerConfig });
    audible.searchProducts.mockRejectedValue(new ProviderThrottleError(undefined, 'HTTP 429'));

    const result = await service.lookup(target({ format: 'audiobook', audibleAsin: null }));

    expect(audnexusProvider.search).not.toHaveBeenCalled();
    expect(result.unavailable).toContainEqual({ source: 'audible', reason: 'throttled' });
    expect(result.unavailable).toContainEqual({ source: 'audnexus', reason: 'throttled' });
  });

  it('uses the configured Audible marketplace for Audible and AudNexus links and omits a blank id', async () => {
    const providerConfig = config({
      audible: { enabled: true, domain: 'audible.co.uk' },
      audnexus: { enabled: true },
    } as Partial<ProviderConfigurations>);
    const { service, audible, audnexusProvider } = harness({ config: providerConfig });
    audible.searchProducts.mockResolvedValue([
      {
        asin: 'B0 ID/ONE',
        title: 'The Infinite Extent',
        authors: [{ name: 'James S. A. Corey' }],
        release_date: '2027-04-01',
      },
    ]);
    audnexusProvider.search.mockResolvedValue([
      {
        provider: MetadataProviderKey.AUDNEXUS,
        providerId: '   ',
        title: 'The Infinite Extent',
        authors: ['James S. A. Corey'],
        publishedDate: '2027-04-02',
      },
    ]);

    const result = await service.lookup(target({ format: 'audiobook', audibleAsin: null }));

    expect(result.candidates).toContainEqual(expect.objectContaining({ source: 'audible', url: 'https://www.audible.co.uk/pd/B0%20ID%2FONE' }));
    expect(result.candidates).toContainEqual(expect.objectContaining({ source: 'audnexus', url: null }));
  });

  it('reports disabled AudNexus as not configured without searching', async () => {
    const { service, audnexusProvider } = harness();

    const result = await service.lookup(target({ format: 'audiobook' }));

    expect(audnexusProvider.search).not.toHaveBeenCalled();
    expect(result.unavailable).toContainEqual({ source: 'audnexus', reason: 'not_configured' });
  });

  it('reports empty providers in ask order without candidates or unavailable providers', async () => {
    const providerConfig = config({ audnexus: { enabled: true }, librofm: { enabled: true } } as Partial<ProviderConfigurations>);
    const { service, librofmProvider } = harness({ config: providerConfig });
    librofmProvider.search.mockResolvedValue([
      {
        provider: MetadataProviderKey.LIBROFM,
        providerId: '9780000000001',
        title: 'The Infinite Extent',
        authors: ['James S. A. Corey'],
        publishedDate: '2027-05-06',
      },
    ]);

    const result = await service.lookup(target({ format: 'audiobook', hardcoverSlug: null }));

    expect(result.empty).toEqual(['audible', 'audnexus']);
    expect(result.empty).not.toContain('librofm');
    expect(result.empty).not.toContain('amazon');
    expect(result.unavailable).toContainEqual({ source: 'amazon', reason: 'not_configured' });
  });

  it('reports Amazon as unasked when the provider is switched off', async () => {
    const amazon = { enabled: false, domain: 'amazon.com', cookie: 'cookie' };
    const { service, amazon: client } = harness({ config: config({ amazon } as Partial<ProviderConfigurations>) });

    const result = await service.lookup(target());

    expect(client.fetchProductPage).not.toHaveBeenCalled();
    expect(client.fetchSearchPage).not.toHaveBeenCalled();
    expect(result.unavailable).toContainEqual({ source: 'amazon', reason: 'not_configured' });
  });

  it('asks Amazon whenever the provider is enabled, with or without a cookie', async () => {
    const amazon = { enabled: true, domain: 'amazon.com', cookie: '' };
    const { service, amazon: client } = harness({ config: config({ amazon } as Partial<ProviderConfigurations>) });
    client.fetchProductPage.mockResolvedValue({ notFound: true });
    client.fetchSearchPage.mockResolvedValue({ html: '<main>No matching books</main>' });

    const result = await service.lookup(target());

    expect(client.fetchProductPage.mock.calls.length + client.fetchSearchPage.mock.calls.length).toBeGreaterThan(0);
    expect(result.unavailable).not.toContainEqual({ source: 'amazon', reason: 'not_configured' });
  });

  it('reports Amazon rate limiting as throttled', async () => {
    const amazon = { enabled: true, domain: 'amazon.com', cookie: '' };
    const { service, amazon: client } = harness({ config: config({ amazon } as Partial<ProviderConfigurations>) });
    client.fetchProductPage.mockRejectedValue(new ProviderThrottleError(undefined, 'Amazon bot challenge'));
    client.fetchSearchPage.mockRejectedValue(new ProviderThrottleError(undefined, 'HTTP 503'));

    const result = await service.lookup(target());

    expect(result.unavailable).toContainEqual({ source: 'amazon', reason: 'throttled' });
  });

  it('walks the Amazon seed into a family page and dates the requested format', async () => {
    const amazonConfig = config({ amazon: { enabled: true, domain: 'amazon.com', cookie: 'cookie' } } as Partial<ProviderConfigurations>);
    const { service, amazon } = harness({ config: amazonConfig });
    amazon.fetchProductPage.mockResolvedValue({
      html: `<input id="ASIN" value="B012345678"><span id="productTitle">The Infinite Extent</span><div id="bylineInfo">James S. A. Corey</div><div id="availability">Released on October 1, 2026.</div><ul id="tmmSwatches"><li class="swatchElement selected"><span class="a-button-text">Kindle</span></li></ul>`,
    });

    const result = await service.lookup(target());

    expect(amazon.fetchProductPage).toHaveBeenCalledWith('B012345678', amazonConfig.amazon, expect.any(AbortSignal));
    expect(amazon.fetchSearchPage).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([
      {
        source: 'amazon',
        releaseDate: '2026-10-01',
        precision: 'day',
        label: 'Kindle',
        weak: false,
        url: 'https://www.amazon.com/dp/B012345678',
      },
    ]);
  });

  it('falls back to an Amazon search when no seed matches', async () => {
    const amazonConfig = config({ amazon: { enabled: true, domain: 'amazon.com', cookie: 'cookie' } } as Partial<ProviderConfigurations>);
    const { service, amazon } = harness({ config: amazonConfig });
    amazon.fetchSearchPage.mockResolvedValue({ html: '<main>No matching books</main>' });

    const result = await service.lookup(target({ audibleAsin: null }));

    expect(amazon.fetchSearchPage).toHaveBeenCalledOnce();
    expect(result.candidates).toEqual([]);
    expect(result.unavailable).toEqual([]);
    expect(result.empty).toContain('amazon');
  });

  it('reports an unverifiable Amazon family as failed instead of empty', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const amazonConfig = config({ amazon: { enabled: true, domain: 'amazon.com', cookie: '' } } as Partial<ProviderConfigurations>);
    const { service, amazon } = harness({ config: amazonConfig });
    amazon.fetchSearchPage.mockResolvedValue({
      html: `<div data-component-type="s-search-result" data-asin="B0SEARCH01"><div data-cy="title-recipe">The Infinite Extent | by James S. A. Corey</div><a href="/dp/B0SEARCH01">Kindle</a></div>`,
    });
    amazon.fetchProductPage.mockResolvedValue({
      html: `<input id="ASIN" value="B0SEARCH01"><span id="productTitle">A Different Book</span><div id="bylineInfo">James S. A. Corey</div>`,
    });

    const result = await service.lookup(target({ audibleAsin: null }));

    expect(result.unavailable).toContainEqual({ source: 'amazon', reason: 'failed' });
    expect(result.empty).not.toContain('amazon');
    expect(warn.mock.calls.filter(([message]) => String(message).includes('source=amazon'))).toHaveLength(1);
  });

  it('keeps a verified Amazon family without the requested format in empty', async () => {
    const amazonConfig = config({ amazon: { enabled: true, domain: 'amazon.com', cookie: '' } } as Partial<ProviderConfigurations>);
    const { service, amazon } = harness({ config: amazonConfig });
    amazon.fetchProductPage.mockResolvedValue({
      html: `<input id="ASIN" value="B012345678"><span id="productTitle">The Infinite Extent</span><div id="bylineInfo">James S. A. Corey</div><div id="tmmSwatches"><li class="swatchElement selected"><span class="a-button-text">Paperback</span></li></div>`,
    });

    const result = await service.lookup(target());

    expect(result.empty).toContain('amazon');
    expect(result.unavailable).not.toContainEqual({ source: 'amazon', reason: 'failed' });
  });

  it('keeps a fetched Amazon format page with no date in empty', async () => {
    const amazonConfig = config({ amazon: { enabled: true, domain: 'amazon.com', cookie: '' } } as Partial<ProviderConfigurations>);
    const { service, amazon } = harness({ config: amazonConfig });
    amazon.fetchProductPage
      .mockResolvedValueOnce({
        html: `<input id="ASIN" value="B012345678"><span id="productTitle">The Infinite Extent</span><div id="bylineInfo">James S. A. Corey</div><div id="tmmSwatches"><li class="swatchElement selected"><span class="a-button-text">Kindle</span></li><li class="swatchElement"><a href="/dp/B0AUDIO001"><span class="a-button-text">Audible Audiobook</span></a></li></div>`,
      })
      .mockResolvedValueOnce({
        html: `<input id="ASIN" value="B0AUDIO001"><span id="productTitle">The Infinite Extent</span><div id="bylineInfo">James S. A. Corey</div>`,
      });

    const result = await service.lookup(target({ format: 'audiobook' }));

    expect(amazon.fetchProductPage).toHaveBeenCalledTimes(2);
    expect(result.empty).toContain('amazon');
    expect(result.unavailable).not.toContainEqual({ source: 'amazon', reason: 'failed' });
  });

  it('does not refetch a selected Amazon swatch whose page has no date', async () => {
    const amazonConfig = config({ amazon: { enabled: true, domain: 'amazon.com', cookie: '' } } as Partial<ProviderConfigurations>);
    const { service, amazon } = harness({ config: amazonConfig });
    amazon.fetchProductPage.mockResolvedValue({
      html: `<input id="ASIN" value="B012345678"><span id="productTitle">The Infinite Extent</span><div id="bylineInfo">James S. A. Corey</div><div id="tmmSwatches"><li class="swatchElement selected"><span class="a-button-text">Kindle</span></li></div>`,
    });

    const result = await service.lookup(target());

    expect(amazon.fetchProductPage).toHaveBeenCalledOnce();
    expect(result.empty).toContain('amazon');
    expect(result.unavailable).not.toContainEqual({ source: 'amazon', reason: 'failed' });
  });

  it('spends no more Amazon pages on one lookup than the page budget allows', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const amazonConfig = config({ amazon: { enabled: true, domain: 'amazon.com', cookie: '' } } as Partial<ProviderConfigurations>);
    const { service, amazon } = harness({ config: amazonConfig });
    amazon.fetchProductPage
      .mockResolvedValueOnce({
        html: `<input id="ASIN" value="B012345678"><span id="productTitle">A Different Book</span><div id="bylineInfo">James S. A. Corey</div>`,
      })
      .mockResolvedValueOnce({
        html: `<input id="ASIN" value="B0SEARCH01"><span id="productTitle">The Infinite Extent</span><div id="bylineInfo">James S. A. Corey</div><div id="tmmSwatches"><li class="swatchElement selected"><span class="a-button-text">Kindle</span></li><li class="swatchElement"><a href="/dp/B0AUDIO001"><span class="a-button-text">Audible Audiobook</span></a></li></div>`,
      });
    amazon.fetchSearchPage.mockResolvedValue({
      html: `<div data-component-type="s-search-result" data-asin="B0SEARCH01"><div data-cy="title-recipe">The Infinite Extent | by James S. A. Corey</div><a href="/dp/B0SEARCH01">Kindle</a></div>`,
    });

    const result = await service.lookup(target({ format: 'audiobook' }));

    expect(amazon.fetchProductPage.mock.calls.length + amazon.fetchSearchPage.mock.calls.length).toBe(LOOKUP_AMAZON_PAGES);
    expect(amazon.fetchProductPage).not.toHaveBeenCalledWith('B0AUDIO001', expect.anything(), expect.anything());
    expect(result.unavailable).toContainEqual({ source: 'amazon', reason: 'failed' });
  });

  it('reports a throttled provider without failing the request', async () => {
    const { service, hardcover, apple } = harness();
    hardcover.fetchEditionsBySlugs.mockRejectedValue(new ProviderThrottleError(undefined, 'HTTP 429'));
    apple.searchEbookCandidates.mockResolvedValue([{ trackId: 1, trackName: 'The Infinite Extent', releaseDate: '2026-11-02', trackViewUrl: null }]);

    const result = await service.lookup(target());

    expect(result.unavailable).toContainEqual({ source: 'hardcover_edition', reason: 'throttled' });
    expect(result.candidates).toHaveLength(1);
  });

  it('names a throttled provider in its own failure line and in the completion line', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { service, hardcover } = harness();
    hardcover.fetchEditionsBySlugs.mockRejectedValue(new ProviderThrottleError(undefined, 'HTTP 429'));

    await service.lookup(target());

    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[monitored\.release_dates\.lookup\] \[fail\] workId="work-1" userId=7 format=ebook source=hardcover_edition durationMs=\d+ errorClass=ProviderThrottleError error="Provider throttled \(HTTP 429\)" - release date lookup provider throttled$/,
      ),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('empty=1 throttled=hardcover_edition - release date lookup completed'));
  });

  it('completes with no throttled provider named when none was paused', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { service } = harness();

    await service.lookup(target());

    expect(log).toHaveBeenCalledWith(expect.stringContaining('throttled=none - release date lookup completed'));
  });

  it('isolates one failing provider and names it in the failure line', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, hardcover, apple } = harness();
    hardcover.fetchEditionsBySlugs.mockRejectedValue(new TypeError('hardcover exploded'));
    apple.searchEbookCandidates.mockResolvedValue([{ trackId: 1, trackName: 'The Infinite Extent', releaseDate: '2026-11-02', trackViewUrl: null }]);

    const result = await service.lookup(target());

    expect(result.candidates).toHaveLength(1);
    expect(result.unavailable).toContainEqual({ source: 'hardcover_edition', reason: 'failed' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[monitored\.release_dates\.lookup\] \[fail\] workId="work-1" userId=7 format=ebook source=hardcover_edition durationMs=\d+ errorClass=TypeError error="hardcover exploded" - release date lookup provider failed$/,
      ),
    );
  });

  it('de-duplicates identical listings and sorts weak records last', async () => {
    const { service, hardcover, apple } = harness();
    hardcover.fetchEditionsBySlugs.mockResolvedValue([
      {
        slug: 'the-infinite-extent',
        release_date: '2026-09-10',
        editions: [
          edition({ release_date: '2027-05-01' }),
          edition({ release_date: '2027-05-01' }),
          edition({ release_date: '2026-12-01', asin: 'B012345678', users_count: 40 }),
        ],
      },
    ]);
    apple.searchEbookCandidates.mockResolvedValue([
      { trackId: 1, trackName: 'The Infinite Extent', releaseDate: '2026-11-02', trackViewUrl: null },
      { trackId: 1, trackName: 'The Infinite Extent', releaseDate: '2026-11-02', trackViewUrl: null },
    ]);

    const result = await service.lookup(target());

    expect(result.candidates.map((candidate) => [candidate.source, candidate.releaseDate, candidate.weak])).toEqual([
      ['apple', '2026-11-02', false],
      ['hardcover_edition', '2026-12-01', false],
      ['hardcover_edition', '2027-05-01', true],
    ]);
  });

  it('passes one lookup deadline signal to every provider used by an ebook lookup', async () => {
    const amazonConfig = config({ amazon: { enabled: true, domain: 'amazon.com', cookie: '' } } as Partial<ProviderConfigurations>);
    const { service, hardcover, apple, amazon } = harness({ config: amazonConfig });
    amazon.fetchSearchPage.mockResolvedValue({ html: '<main>No matching books</main>' });

    await service.lookup(target({ audibleAsin: null }));

    const signal = hardcover.fetchEditionsBySlugs.mock.calls[0]?.[2];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(apple.searchEbookCandidates.mock.calls[0]?.[3]).toBe(signal);
    expect(amazon.fetchSearchPage.mock.calls[0]?.[2]).toBe(signal);
  });

  it('passes one lookup deadline signal to Audible and both metadata providers', async () => {
    const providerConfig = config({ audnexus: { enabled: true }, librofm: { enabled: true } } as Partial<ProviderConfigurations>);
    const { service, hardcover, audible, audnexusProvider, librofmProvider } = harness({ config: providerConfig });

    await service.lookup(target({ format: 'audiobook' }));

    const signal = hardcover.fetchEditionsBySlugs.mock.calls[0]?.[2];
    expect(audible.searchProducts.mock.calls[0]?.[2]).toBe(signal);
    expect(audnexusProvider.search.mock.calls[0]?.[0].signal).toBe(signal);
    expect(librofmProvider.search.mock.calls[0]?.[0].signal).toBe(signal);
  });

  it('shares one in-flight lookup and reuses its result until the cache expires', async () => {
    const { service, apple, providerConfigs } = harness();
    let resolveApple: (() => void) | undefined;
    apple.searchEbookCandidates.mockImplementation(
      () =>
        new Promise<never[]>((resolve) => {
          resolveApple = () => resolve([]);
        }),
    );

    const first = service.lookup(target());
    const second = service.lookup(target());

    expect(second).toBe(first);
    await Promise.resolve();
    resolveApple?.();
    await first;
    await service.lookup(target());
    expect(providerConfigs.forUser).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(LOOKUP_CACHE_TTL_MS);
    apple.searchEbookCandidates.mockResolvedValue([]);
    await service.lookup(target());
    expect(providerConfigs.forUser).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest lookup when the cache reaches 200 entries', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { service, providerConfigs } = harness();

    for (let index = 0; index <= 200; index++) {
      await service.lookup(target({ workId: `work-${index}` }));
    }
    await service.lookup(target({ workId: 'work-0' }));

    expect(providerConfigs.forUser).toHaveBeenCalledTimes(202);
  });

  it('does not cache a rejected lookup and logs its outer failure', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, providerConfigs } = harness();
    providerConfigs.forUser.mockRejectedValueOnce(new TypeError('config exploded')).mockResolvedValue(config());

    await expect(service.lookup(target())).rejects.toThrow('config exploded');
    await expect(service.lookup(target())).resolves.toMatchObject({ format: 'ebook' });

    expect(providerConfigs.forUser).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[monitored\.release_dates\.lookup\] \[fail\] workId="work-1" userId=7 format=ebook durationMs=\d+ errorClass=TypeError error="config exploded" - release date lookup failed$/,
      ),
    );
  });
});
