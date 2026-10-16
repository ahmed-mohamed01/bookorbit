/* eslint-disable @typescript-eslint/require-await */
import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import { WebSerialsDiscoverService } from './web-serials-discover.service';

vi.mock('./lookup/web-serials-lookup.service', async () => {
  const actual = await vi.importActual<typeof import('./lookup/web-serials-lookup.service')>('./lookup/web-serials-lookup.service');
  return { ...actual, WebSerialsLookupService: class {} };
});
vi.mock('./web-serials-catalog.service', () => ({ WebSerialsCatalogService: class {} }));
vi.mock('./web-serials-novel-candidates.service', () => ({ WebSerialsNovelCandidatesService: class {} }));
vi.mock('./web-serials-cover.service', () => ({ WebSerialsCoverService: class {} }));
vi.mock('./web-serials-engine-registry.service', () => ({ WebSerialsEngineRegistry: class {} }));
vi.mock('./web-serials-settings.service', () => ({ WebSerialsSettingsService: class {} }));
vi.mock('./web-serials.repository', () => ({ WebSerialsRepository: class {} }));

const USER = { id: 7, isSuperuser: false, permissions: [] } as unknown as RequestUser;

const frieren = {
  id: 1995,
  state: 'active',
  merged_with: null,
  title: 'Frieren: Beyond Journey’s End',
  native_title: '葬送のフリーレン',
  romanized_title: 'Sousou no Frieren',
  secondary_titles: { en: [{ title: "Frieren: Beyond Journey's End" }] },
  authors: ['Kanehito Yamada'],
  artists: ['Tsukasa Abe'],
  status: 'releasing',
  year: 2020,
  genres: ['slice_of_life'],
  type: 'manga',
  content_rating: 'safe',
  is_licensed: true,
  final_volume: '13',
  publishers: [{ name: 'VIZ Media', type: 'English', language: 'en' }],
  description: '<p>An elf <b>outlives</b> her party.</p>',
  cover: {
    raw: { url: 'https://images.example/raw/1995' },
    x150: { x1: 'https://cdn.example/x150/1995.jpg', x2: null },
    x250: { x1: 'https://cdn.example/x250/1995.jpg', x2: 'https://cdn.example/covers/1995.jpg' },
    x350: null,
  },
};

const mother = {
  ...frieren,
  id: 77,
  title: 'Mother of Learning',
  native_title: null,
  romanized_title: null,
  secondary_titles: null,
  type: 'novel',
  cover: null,
  description: null,
};

function candidate(seriesKey: string, sourceName: string, chapterCount: number, confidence: 'same_series' | 'title_match' = 'same_series') {
  return {
    hit: {
      remoteId: seriesKey.slice(2),
      url: null,
      title: 'Frieren',
      author: null,
      remoteCoverPath: null,
      sourceName,
      chapterCount,
      status: 'ongoing',
    },
    seriesKey,
    confidence,
    series: { title: 'Frieren', sourceName, chapterCount, units: [] },
  };
}

function setup(configs: Record<string, unknown> = { manga: { allowedSources: ['en'] }, novel: { allowedSources: ['royalroad.com'] } }) {
  const repo = {
    findImportedMatchKeys: vi.fn().mockResolvedValue(new Set<string>()),
    getDisabledNovelDomains: vi.fn().mockResolvedValue([]),
  };
  const settings = { catalogVersion: 1 };
  const engines = { getConfig: vi.fn(async (kind: string) => configs[kind] ?? null), fileIndexConfig: vi.fn(async () => null) };
  const catalog = { findMangaSourceCandidates: vi.fn().mockResolvedValue({ candidates: [], failedSources: [] }) };
  const novels = { find: vi.fn().mockResolvedValue({ candidates: [], failedSources: [] }) };
  const lookup = {
    searchCatalog: vi.fn<(query: string, kind: string, refresh?: boolean) => Promise<unknown>>(async (_query: string, kind: string) => ({
      state: 'ok',
      series: kind === 'manga' ? [frieren] : [mother],
    })),
    getCatalogSeries: vi.fn().mockResolvedValue(frieren),
  };
  const covers = { getRemoteCover: vi.fn().mockResolvedValue({ body: Buffer.from('img'), contentType: 'image/jpeg' }) };
  const service = new WebSerialsDiscoverService(
    repo as never,
    settings as never,
    engines as never,
    catalog as never,
    novels as never,
    lookup as never,
    covers as never,
  );
  return { service, repo, settings, engines, catalog, novels, lookup, covers };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('WebSerialsDiscoverService discover', () => {
  it('returns one entry per series with details, a same-origin cover and no engine call', async () => {
    const { service, engines, catalog, novels, lookup } = setup();

    const result = await service.discover(' frieren ', 'manga', USER);

    expect(lookup.searchCatalog).toHaveBeenCalledWith('frieren', 'manga', false);
    expect(result.fallback).toBeNull();
    expect(result.results).toEqual([
      {
        matchId: '1995',
        kind: 'manga',
        title: 'Frieren: Beyond Journey’s End',
        authors: ['Kanehito Yamada'],
        artists: ['Tsukasa Abe'],
        year: 2020,
        status: 'ongoing',
        genres: ['Slice Of Life'],
        synopsis: 'An elf outlives her party.',
        coverUrl: '/api/v1/web-serials/discover/manga/1995/cover',
        url: 'https://mangabaka.org/1995',
        inLibrary: false,
        publication: { licensed: true, finalVolume: 13, publishers: [{ name: 'VIZ Media', type: 'English', language: 'en' }] },
      },
    ]);
    expect(catalog.findMangaSourceCandidates).not.toHaveBeenCalled();
    expect(novels.find).not.toHaveBeenCalled();
    expect(engines.getConfig).toHaveBeenCalled();
  });

  it('never exposes the third-party cover url or the alternative titles', async () => {
    const { service } = setup();

    const [entry] = (await service.discover('frieren', 'manga', USER)).results;

    expect(JSON.stringify(entry)).not.toContain('cdn.example');
    expect(JSON.stringify(entry)).not.toContain('Sousou');
  });

  it('marks entries already in the library by one bounded ledger lookup over the result ids', async () => {
    const { service, repo } = setup();
    repo.findImportedMatchKeys.mockResolvedValue(new Set(['mb:77']));

    const result = await service.discover('learning', 'all', USER);

    expect(repo.findImportedMatchKeys).toHaveBeenCalledTimes(1);
    expect(repo.findImportedMatchKeys).toHaveBeenCalledWith(7, ['mb:77', 'mb:1995']);
    expect(result.results.map((entry) => [entry.matchId, entry.inLibrary])).toEqual([
      ['77', true],
      ['1995', false],
    ]);
  });

  it('merges kinds by how well each head matches the query, keeping each kind in MangaBaka order', async () => {
    const { service, lookup } = setup();
    lookup.searchCatalog.mockImplementation(async (_query: string, kind: string) => ({
      state: 'ok',
      series:
        kind === 'manga'
          ? [
              { ...frieren, id: 1, title: 'What Subaru Sarashina Says Goes!', secondary_titles: null, native_title: null, romanized_title: null },
              { ...frieren, id: 2, title: 'Overgeared', secondary_titles: null, native_title: null, romanized_title: null },
            ]
          : [{ ...mother, id: 3, title: 'Overgeared' }],
    }));

    const result = await service.discover('overgeared', 'all', USER);

    expect(result.results.map((entry) => entry.matchId)).toEqual(['3', '1', '2']);
  });

  it('searches only kinds whose engine has sources', async () => {
    const { service, lookup } = setup({ manga: { allowedSources: ['en'] }, novel: { allowedSources: [] } });

    await service.discover('frieren', 'all', USER);

    expect(lookup.searchCatalog).toHaveBeenCalledTimes(1);
    expect(lookup.searchCatalog).toHaveBeenCalledWith('frieren', 'manga', false);
  });

  it('refuses when no kind can be searched', async () => {
    const { service } = setup({});

    await expect(service.discover('frieren', 'all', USER)).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each(['disabled', 'unavailable'] as const)('falls back with "%s" when the series database says so', async (state) => {
    const { service, lookup, repo } = setup();
    lookup.searchCatalog.mockResolvedValue({ state } as never);

    await expect(service.discover('frieren', 'manga', USER)).resolves.toEqual({ results: [], fallback: state });
    expect(repo.findImportedMatchKeys).not.toHaveBeenCalled();
  });

  it('leaves out the placeholder rows MangaBaka keeps for unidentified series', async () => {
    const { service, lookup } = setup();
    lookup.searchCatalog.mockResolvedValue({
      state: 'ok',
      series: [frieren, { ...frieren, id: 599314, title: 'unknown title (please report on Discord)' }],
    });
    const result = await service.discover('frieren', 'manga', USER);
    expect(result.results.map((entry) => entry.title)).toEqual([frieren.title]);
  });

  it('falls back with "empty" when nothing matches', async () => {
    const { service, lookup } = setup();
    lookup.searchCatalog.mockResolvedValue({ state: 'ok', series: [] } as never);

    await expect(service.discover('zzzz', 'manga', USER)).resolves.toEqual({ results: [], fallback: 'empty' });
  });

  it('falls back when one kind of a mixed search is unavailable', async () => {
    const { service, lookup } = setup();
    lookup.searchCatalog.mockImplementation(async (_query: string, kind: string) =>
      kind === 'manga' ? { state: 'ok', series: [frieren] } : { state: 'unavailable' },
    );

    await expect(service.discover('frieren', 'all', USER)).resolves.toEqual({ results: [], fallback: 'unavailable' });
  });
});

describe('WebSerialsDiscoverService sources', () => {
  it('searches the manga sources with the match id and every alternative title, and ranks confirmed copies first, most complete first', async () => {
    const { service, catalog } = setup();
    catalog.findMangaSourceCandidates.mockResolvedValue({
      candidates: [
        candidate('m:1', 'Small', 10, 'same_series'),
        candidate('m:2', 'Big', 120, 'title_match'),
        candidate('m:3', 'Mid', 120, 'same_series'),
      ],
      failedSources: ['Slow'],
    });

    const result = await service.getSources('manga', '1995', USER);

    expect(catalog.findMangaSourceCandidates).toHaveBeenCalledWith({
      sourceTitle: 'Frieren: Beyond Journey’s End',
      sourceName: '',
      query: 'Frieren: Beyond Journey’s End',
      matchId: '1995',
      altTitles: expect.arrayContaining(["Frieren: Beyond Journey's End", 'Sousou no Frieren', '葬送のフリーレン']),
    });
    expect(result.options.map((option) => [option.seriesKey, option.mostComplete])).toEqual([
      ['m:3', true],
      ['m:1', false],
      ['m:2', false],
    ]);
    expect(result.failedSources).toEqual(['Slow']);
  });

  it('passes the user novel preferences to the novel search and keys the cache by them', async () => {
    const { service, novels, repo, lookup } = setup();
    lookup.getCatalogSeries.mockResolvedValue(mother);
    repo.getDisabledNovelDomains.mockResolvedValueOnce(['b.com', 'a.com']).mockResolvedValueOnce([]);
    novels.find.mockResolvedValue({ candidates: [candidate('n:x', 'royalroad.com', 40)], failedSources: [] });

    const first = await service.getSources('novel', '77', USER);
    await service.getSources('novel', '77', USER);

    expect(novels.find).toHaveBeenNthCalledWith(1, {
      title: 'Mother of Learning',
      altTitles: expect.any(Array),
      authors: ['Kanehito Yamada'],
      artists: ['Tsukasa Abe'],
      matchId: '77',
      disabledDomains: ['a.com', 'b.com'],
    });
    expect(novels.find).toHaveBeenCalledTimes(2);
    expect(first.options[0]).toMatchObject({ seriesKey: 'n:x', mostComplete: true });
  });

  it('serves a repeated request from the cache', async () => {
    const { service, catalog } = setup();

    const first = await service.getSources('manga', '1995', USER);
    const second = await service.getSources('manga', '1995', USER);

    expect(second).toBe(first);
    expect(catalog.findMangaSourceCandidates).toHaveBeenCalledTimes(1);
  });

  it('bypasses the cache on refresh', async () => {
    const { service, catalog } = setup();

    await service.getSources('manga', '1995', USER);
    await service.getSources('manga', '1995', USER, true);

    expect(catalog.findMangaSourceCandidates).toHaveBeenCalledTimes(2);
  });

  it('caches a source list that found options even when a site failed, but not one that found nothing', async () => {
    vi.useFakeTimers();
    try {
      const { service, catalog } = setup();
      catalog.findMangaSourceCandidates.mockResolvedValue({ candidates: [candidate('m:1', 'Small', 10, 'same_series')], failedSources: ['Slow'] });
      await service.getSources('manga', '1995', USER);
      vi.advanceTimersByTime(5 * 60_000);
      await service.getSources('manga', '1995', USER);
      expect(catalog.findMangaSourceCandidates).toHaveBeenCalledTimes(1);

      catalog.findMangaSourceCandidates.mockResolvedValue({ candidates: [], failedSources: ['Slow'] });
      await service.getSources('manga', '2000', USER);
      vi.advanceTimersByTime(61_000);
      await service.getSources('manga', '2000', USER);
      expect(catalog.findMangaSourceCandidates).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not cache after a settings change', async () => {
    const { service, catalog, settings } = setup();

    await service.getSources('manga', '1995', USER);
    settings.catalogVersion = 2;
    await service.getSources('manga', '1995', USER);

    expect(catalog.findMangaSourceCandidates).toHaveBeenCalledTimes(2);
  });

  it('answers with no options and the kind as failed when the engine search throws', async () => {
    const { service, catalog } = setup();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    catalog.findMangaSourceCandidates.mockRejectedValue(new Error('engine down'));

    await expect(service.getSources('manga', '1995', USER)).resolves.toEqual({ options: [], failedSources: ['manga'] });
  });

  it('rejects a bad kind or id and a series the database cannot give', async () => {
    const { service, lookup } = setup();

    await expect(service.getSources('comic' as never, '1', USER)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.getSources('manga', 'abc', USER)).rejects.toBeInstanceOf(BadRequestException);
    lookup.getCatalogSeries.mockResolvedValue(null);
    await expect(service.getSources('manga', '5', USER)).rejects.toBeInstanceOf(BadGatewayException);
    lookup.getCatalogSeries.mockResolvedValue(mother);
    await expect(service.getSources('manga', '77', USER)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('WebSerialsDiscoverService cover', () => {
  it('proxies the remembered third-party cover through the cover service', async () => {
    const { service, covers } = setup();
    await service.discover('frieren', 'manga', USER);

    await expect(service.getCover('manga', '1995')).resolves.toEqual({ body: Buffer.from('img'), contentType: 'image/jpeg' });
    expect(covers.getRemoteCover).toHaveBeenCalledWith('manga:1995', 'https://cdn.example/covers/1995.jpg');
  });

  it('refuses a non-https cover url and answers 404 for a series without a cover', async () => {
    const { service, lookup, covers } = setup();
    lookup.getCatalogSeries.mockResolvedValue({ ...frieren, cover: { x250: { x2: 'http://cdn.example/a.jpg' } } });
    await expect(service.getCover('manga', '1995')).rejects.toBeInstanceOf(NotFoundException);
    expect(covers.getRemoteCover).not.toHaveBeenCalled();
  });

  it('rejects a malformed id before any lookup', async () => {
    const { service, lookup } = setup();

    await expect(service.getCover('manga', '../x')).rejects.toBeInstanceOf(BadRequestException);
    expect(lookup.getCatalogSeries).not.toHaveBeenCalled();
  });
});
