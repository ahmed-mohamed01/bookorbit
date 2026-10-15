/* eslint-disable @typescript-eslint/require-await */
import { BadGatewayException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { CONN, mangaSeries, setupServices, USER } from '../../../test/support/web-serials/web-serials-test-fixtures';

vi.mock('./web-serials-engine-registry.service', () => ({ WebSerialsEngineRegistry: class {} }));
vi.mock('./web-serials-cover.service', () => ({ WebSerialsCoverService: class {} }));
vi.mock('./web-serials-settings.service', () => ({ WebSerialsSettingsService: class {} }));
vi.mock('./web-serials-job-runner.service', () => ({ WebSerialsJobRunnerService: class {} }));
vi.mock('./web-serials-import.service', () => ({ WebSerialsImportService: class {} }));
vi.mock('./lookup/web-serials-lookup.service', () => ({
  WebSerialsLookupService: class {},
}));
vi.mock('../library/library.service', () => ({ LibraryService: class {} }));

function setup(options: Parameters<typeof setupServices>[0] = {}) {
  const ctx = setupServices(options);
  return { ...ctx, service: ctx.catalog };
}

describe('WebSerialsCatalogService capabilities', () => {
  it('reports availability from saved settings and the library the user can add to', async () => {
    const { service, libraryService } = setup();
    libraryService.verifyUserAccess.mockImplementation(async (_user: number, libraryId: number) => {
      if (libraryId === 5) throw new ForbiddenException('No access');
    });

    await expect(service.getCapabilities(USER)).resolves.toEqual({
      manga: { available: true, searchable: true, defaultLibraryId: 3, targetFolderId: 30 },
      novel: { available: true, searchable: true, acceptsLinks: true, defaultLibraryId: null, targetFolderId: null },
    });
  });

  it('hides the admin folder of a library the user cannot add to', async () => {
    const { service, libraryService } = setup();
    libraryService.verifyUserAccess.mockRejectedValue(new ForbiddenException('No access'));

    await expect(service.getCapabilities(USER)).resolves.toMatchObject({
      manga: { defaultLibraryId: null, targetFolderId: null },
      novel: { defaultLibraryId: null, targetFolderId: null },
    });
  });

  it('is not searchable when no manga source is selected', async () => {
    const { service } = setup({
      settings: {
        manga: { url: 'http://m', lastCheck: { ok: true, searchableSources: 3 }, sourceIds: [], targetLibraryId: 3 },
        novel: { url: null, lastCheck: null, searchDomains: [], targetLibraryId: null },
      },
    });

    await expect(service.getCapabilities(USER)).resolves.toMatchObject({ manga: { available: true, searchable: false } });
  });

  it('is searchable when sources are selected', async () => {
    const { service } = setup({
      settings: {
        manga: { url: 'http://m', lastCheck: { ok: true, searchableSources: 1 }, sourceIds: ['1'], targetLibraryId: 3 },
        novel: { url: null, lastCheck: null, searchDomains: [], targetLibraryId: null },
      },
    });

    await expect(service.getCapabilities(USER)).resolves.toMatchObject({ manga: { searchable: true } });
  });

  it('makes novels searchable on the LNReader engine from installed sources, without lightnovel-crawler domains', async () => {
    const { service } = setup({
      settings: {
        manga: { url: null, lastCheck: null, sourceIds: [], targetLibraryId: null },
        novel: { engine: 'lnreader', url: 'http://n', lastCheck: null, searchDomains: [], sourceIds: ['novelbuddy'], targetLibraryId: null },
      },
    });

    await expect(service.getCapabilities(USER)).resolves.toMatchObject({ novel: { available: true, searchable: true } });
  });

  it('marks an engine whose last check failed as unavailable', async () => {
    const { service } = setup({
      settings: {
        manga: { url: 'http://m', lastCheck: { ok: false, searchableSources: 0 }, targetLibraryId: 3 },
        novel: { url: null, lastCheck: null, searchDomains: [], targetLibraryId: null },
      },
    });

    await expect(service.getCapabilities(USER)).resolves.toEqual({
      manga: { available: false, searchable: false, defaultLibraryId: null, targetFolderId: null },
      novel: { available: false, searchable: false, acceptsLinks: false, defaultLibraryId: null, targetFolderId: null },
    });
  });
});

describe('WebSerialsCatalogService search', () => {
  it('maps hits to same-origin cover urls and null keys for url-only hits', async () => {
    const { service, client, covers } = setup();
    client.search.mockImplementation(async () => ({
      hits: [
        { remoteId: '1', url: null, title: 'A', author: null, remoteCoverPath: '/t/1', sourceName: 'S', chapterCount: 3, status: 'ongoing' },
        {
          remoteId: null,
          url: 'https://rr/x',
          title: 'B',
          author: 'x',
          remoteCoverPath: 'https://evil/cover.jpg',
          sourceName: 'S',
          chapterCount: null,
          status: 'unknown',
        },
      ],
      failedSources: [],
    }));

    const result = await service.search('dungeon', 'manga', USER);

    expect(result.hits[0]).toMatchObject({ seriesKey: 'm:1', coverUrl: '/api/v1/web-serials/series/m:1/cover' });
    expect(result.hits[1]).toMatchObject({ seriesKey: null, url: 'https://rr/x', coverUrl: null });
    expect(covers.remember).toHaveBeenCalledWith('m:1', '/t/1');
  });

  it('ranks hits across sources and kinds by relevance with spin-offs demoted', async () => {
    const { service, client } = setup();
    const engineHit = (title: string, sourceName: string, remoteId: string) => ({
      remoteId,
      url: null,
      title,
      author: null,
      remoteCoverPath: null,
      sourceName,
      chapterCount: null,
      status: 'unknown' as const,
    });
    client.search
      .mockResolvedValueOnce({
        hits: [
          engineHit('Zzz', 'A', '1'),
          engineHit('One Piece Party', 'A', '2'),
          engineHit('The One Piece Fan Story', 'B', '3'),
          engineHit('One Piece', 'B', '4'),
        ],
        failedSources: [],
      })
      .mockResolvedValueOnce({
        hits: [engineHit('One Piece', 'novel.example', '5'), engineHit('One Piece Story', 'novel.example', '6')],
        failedSources: [],
      });

    const result = await service.search('one piece', 'all', USER);

    expect(result.hits.map((entry) => [entry.title, entry.kind])).toEqual([
      ['One Piece', 'manga'],
      ['One Piece', 'novel'],
      ['One Piece Story', 'novel'],
      ['The One Piece Fan Story', 'manga'],
      ['One Piece Party', 'manga'],
      ['Zzz', 'manga'],
    ]);
  });

  it('puts hits matching MangaBaka titles first in MangaBaka order, then the rest by text relevance', async () => {
    const { service, client, lookupService } = setup();
    const engineHit = (title: string, remoteId: string) => ({
      remoteId,
      url: null,
      title,
      author: null,
      remoteCoverPath: null,
      sourceName: 'A',
      chapterCount: null,
      status: 'unknown' as const,
    });
    client.search.mockResolvedValue({
      hits: [engineHit('One Piece', '1'), engineHit('One Pece Fuzzy', '2'), engineHit('One Piece Party', '3'), engineHit('Wan Pisu', '4')],
      failedSources: [],
    });
    lookupService.searchTitles.mockResolvedValue([
      { rank: 1, titles: ['ONE PIECE', 'Wan Pisu'] },
      { rank: 2, titles: ['One Piece Magazine'] },
      { rank: 3, titles: ['One Piece Party'] },
    ]);

    const result = await service.search('one piece', 'manga', USER);

    expect(result.hits.map((entry) => entry.title)).toEqual(['One Piece', 'Wan Pisu', 'One Piece Party', 'One Pece Fuzzy']);
    expect(lookupService.searchTitles).toHaveBeenCalledTimes(1);
    expect(lookupService.searchTitles).toHaveBeenCalledWith('one piece', 'manga');
  });

  it('ranks by text relevance when MangaBaka has nothing for the query', async () => {
    const { service, client } = setup();
    const engineHit = (title: string, remoteId: string) => ({
      remoteId,
      url: null,
      title,
      author: null,
      remoteCoverPath: null,
      sourceName: 'A',
      chapterCount: null,
      status: 'unknown' as const,
    });
    client.search.mockResolvedValue({ hits: [engineHit('One Piece Story', '1'), engineHit('One Piece', '2')], failedSources: [] });

    const result = await service.search('one piece', 'manga', USER);

    expect(result.hits.map((entry) => entry.title)).toEqual(['One Piece', 'One Piece Story']);
  });

  it('caches identical queries', async () => {
    const { service, client } = setup();

    await service.search('Dungeon', 'manga', USER);
    await service.search(' dungeon ', 'manga', USER);

    expect(client.search).toHaveBeenCalledTimes(1);
  });

  it('keeps results from the engine that answered and lists the one that failed', async () => {
    const { service, client } = setup();
    client.search.mockResolvedValueOnce({ hits: [], failedSources: ['Slow'] }).mockRejectedValueOnce(new Error('down'));

    const result = await service.search('dune', 'all', USER);

    expect(result.failedSources).toEqual(['Slow', 'novel']);
  });

  it('caches a search with some failed sources for the normal time', async () => {
    vi.useFakeTimers();
    try {
      const { service, client } = setup();
      client.search.mockResolvedValue({
        hits: [
          { remoteId: '1', url: null, title: 'Dune', author: null, remoteCoverPath: null, sourceName: 'A', chapterCount: null, status: 'unknown' },
        ],
        failedSources: ['Slow'],
      });

      const first = await service.search('dune', 'manga', USER);
      vi.advanceTimersByTime(5 * 60_000);
      const second = await service.search('dune', 'manga', USER);

      expect(second).toBe(first);
      expect(second.failedSources).toEqual(['Slow']);
      expect(client.search).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an answer with no hits and only failures for just a minute', async () => {
    vi.useFakeTimers();
    try {
      const { service, client } = setup();
      client.search.mockResolvedValue({ hits: [], failedSources: ['Slow'] });

      await service.search('dune', 'manga', USER);
      await service.search('dune', 'manga', USER);
      expect(client.search).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(61_000);
      await service.search('dune', 'manga', USER);
      expect(client.search).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the cached search on refresh and stores the new answer', async () => {
    const { service, client } = setup();

    await service.search('dune', 'manga', USER);
    await service.search('dune', 'manga', USER, true);
    await service.search('dune', 'manga', USER);

    expect(client.search).toHaveBeenCalledTimes(2);
  });

  it('skips the cached source list on refresh', async () => {
    const { service, client } = setup();

    await service.getSeriesSources('m:1');
    await service.getSeriesSources('m:1', true);

    expect(client.search).toHaveBeenCalledTimes(2);
  });

  it('fails when every searched engine failed', async () => {
    const { service, client } = setup();
    client.search.mockRejectedValue(new Error('down'));

    await expect(service.search('dune', 'manga', USER)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('rejects when no requested engine can search', async () => {
    const { service, engines } = setup();
    engines.getConfig.mockResolvedValue(null);

    await expect(service.search('dune', 'all', USER)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('WebSerialsCatalogService novel provider preferences', () => {
  const twoDomains = () => {
    const ctx = setup();
    ctx.engines.getConfig.mockImplementation(async (kind: string) =>
      kind === 'novel'
        ? { connection: CONN, allowedSources: ['royalroad.com', 'scribblehub.com'], targetLibraryId: null, targetFolderId: null }
        : null,
    );
    return ctx;
  };

  it('searches the admin domains minus the ones this user switched off', async () => {
    const { service, client, repo } = twoDomains();
    repo.getDisabledNovelDomains.mockResolvedValue(['scribblehub.com']);

    await service.search('dune', 'novel', USER);

    expect(repo.getDisabledNovelDomains).toHaveBeenCalledWith(USER.id);
    expect(client.search).toHaveBeenCalledWith(CONN, 'dune', ['royalroad.com'], expect.anything());
  });

  it('returns no hits and the all-disabled code when the user switched every site off', async () => {
    const { service, client, repo } = twoDomains();
    repo.getDisabledNovelDomains.mockResolvedValue(['royalroad.com', 'scribblehub.com']);

    const result = await service.search('dune', 'novel', USER);

    expect(result).toEqual({ query: 'dune', hits: [], failedSources: ['WEB_SERIAL_NOVEL_SOURCES_ALL_DISABLED'] });
    expect(client.search).not.toHaveBeenCalled();
  });

  it('keeps manga hits when the user switched every novel site off', async () => {
    const { service, client, repo, engines } = twoDomains();
    engines.getConfig.mockImplementation(async (kind: string) =>
      kind === 'novel'
        ? { connection: CONN, allowedSources: ['royalroad.com'], targetLibraryId: null, targetFolderId: null }
        : { connection: CONN, allowedSources: ['en'], targetLibraryId: 3, targetFolderId: 30 },
    );
    repo.getDisabledNovelDomains.mockResolvedValue(['royalroad.com']);
    client.search.mockResolvedValue({
      hits: [{ remoteId: '1', url: null, title: 'A', author: null, remoteCoverPath: null, sourceName: 'S', chapterCount: 3, status: 'ongoing' }],
      failedSources: [],
    });

    const result = await service.search('dune', 'all', USER);

    expect(result.hits).toHaveLength(1);
    expect(result.failedSources).toEqual(['WEB_SERIAL_NOVEL_SOURCES_ALL_DISABLED']);
  });

  it('leaves out a hit whose link is too long for a series key instead of failing the search', async () => {
    const { service, client } = twoDomains();
    const encoded = (path: string) => `src:${Buffer.from(path).toString('base64url')}`;
    const hit = { url: null, title: 'A', author: null, remoteCoverPath: null, sourceName: 'S', chapterCount: 3, status: 'ongoing' };
    client.search.mockResolvedValue({
      hits: [
        { ...hit, remoteId: encoded(`novel/${'very-long-light-novel-title-slug-'.repeat(12)}`) },
        { ...hit, remoteId: encoded('novel/short') },
      ],
      failedSources: [],
    });

    const result = await service.search('dune', 'novel', USER);

    expect(result.hits.map((entry) => entry.seriesKey)).toEqual([`nl:${encoded('novel/short')}`]);
  });

  it('does not share a cached search between users with different preferences', async () => {
    const { service, client, repo } = twoDomains();

    await service.search('dune', 'novel', USER);
    repo.getDisabledNovelDomains.mockResolvedValue(['royalroad.com']);
    await service.search('dune', 'novel', { ...USER, id: 8 });

    expect(client.search).toHaveBeenCalledTimes(2);
    expect(client.search).toHaveBeenLastCalledWith(CONN, 'dune', ['scribblehub.com'], expect.anything());
  });
});

describe('WebSerialsCatalogService resolve and series', () => {
  it('tells the user manga links are not supported when nothing resolves', async () => {
    const { service } = setup();

    await expect(service.resolve('https://x/y', USER)).rejects.toMatchObject({
      response: { errorCode: 'WEB_SERIAL_LINKS_NOVEL_ONLY' },
    });
  });

  it('opens the resolved novel as a series detail with imported keys', async () => {
    const { service, client, repo } = setup();
    client.resolveUrl.mockResolvedValue({ kind: 'novel', remoteId: 'abc-1' });

    const detail = await service.resolve('https://rr/x', USER);

    expect(detail.seriesKey).toBe('n:abc-1');
    expect(repo.findImportedUnitKeys).toHaveBeenCalledWith(7, 'n:abc-1', expect.any(Array), null, ['Dungeon Saga']);
  });

  it('passes the cached lookup match to the imported check without waiting on a lookup', async () => {
    const { service, repo, lookupService } = setup();
    lookupService.peekCachedLookup.mockReturnValue({ state: 'matched', match: { id: '42' }, message: null, chapterVolumes: null });

    await service.getSeriesDetail('m:1', USER);

    expect(lookupService.lookup).not.toHaveBeenCalled();
    expect(repo.findImportedUnitKeys).toHaveBeenCalledWith(7, 'm:1', expect.any(Array), 'mb:42', []);
  });

  it('describes volume ranges and positional extras to the imported check the way the runner does', async () => {
    const { service, repo, client } = setup();
    const base = (await client.getSeries()) as Record<string, unknown>;
    client.getSeries.mockResolvedValue({
      ...base,
      units: [
        { unitKey: 'volume-3:201-250', sequence: '3', label: 'Volume 3', packaging: 'volume', chapterRange: { from: 201, to: 250 } },
        { unitKey: 'extra-1', sequence: '5.001', label: 'Extra', packaging: 'chapter', positional: true },
        { unitKey: 'c6', sequence: '6', label: 'Chapter 6', packaging: 'chapter' },
      ],
    });

    const detail = await service.getSeriesDetail('m:1', USER);

    expect(detail.units.map((unit) => unit.positional === true)).toEqual([false, true, false]);
    expect(repo.findImportedUnitKeys.mock.calls[0]![2]).toEqual([
      { key: 'volume-3:201-250', sequence: '3', packaging: 'volume', range: { from: 201, to: 250 } },
      { key: 'extra-1', sequence: '5.001', packaging: 'chapter', positional: true },
      { key: 'c6', sequence: '6', packaging: 'chapter' },
    ]);
  });

  it('sends the grouped books the user already has so the client can count them exactly', async () => {
    const { service, repo } = setup();
    repo.findImportedGroupKeys.mockResolvedValue(['vol:2', 'sel:c1-c2']);

    const detail = await service.getSeriesDetail('m:1', USER);

    expect(repo.findImportedGroupKeys).toHaveBeenCalledWith(7, 'm:1');
    expect(detail.importedGroupKeys).toEqual(['vol:2', 'sel:c1-c2']);
  });

  it('returns series detail without leaking remote handles or engine urls', async () => {
    const { service } = setup();

    const detail = await service.getSeriesDetail('m:1', USER);

    expect(detail).toMatchObject({
      seriesKey: 'm:1',
      coverUrl: '/api/v1/web-serials/series/m:1/cover',
      importedUnitKeys: ['c1'],
      units: [{ key: 'c1', label: 'Chapter 1', sequence: '1', chapterCount: 1, publishedAt: null, volume: null }, expect.anything()],
    });
    expect(JSON.stringify(detail)).not.toContain('chapterId');
    expect(JSON.stringify(detail)).not.toContain('/thumb/1');
  });

  it('maps an unexpected engine error to a bad gateway', async () => {
    const { service, client } = setup();
    client.getSeries.mockRejectedValue(new Error('boom'));

    await expect(service.getSeriesDetail('m:1', USER)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('looks up the loaded series title and author', async () => {
    const { service, lookupService } = setup();

    await service.getSeriesLookup('m:1');

    expect(lookupService.lookup).toHaveBeenCalledWith('manga', 'Dungeon Saga', 'A. Writer', mangaSeries.units, 'm:1');
  });
});

describe('WebSerialsCatalogService source options', () => {
  it('orders sources by confidence and chapter count, finds the latest chapter, and marks one most complete source', async () => {
    const { service, client, lookupService } = setup();
    const units = (count: number, dates: Array<string | null>) =>
      Array.from({ length: count }, (_, index) => ({
        ...mangaSeries.units[0]!,
        unitKey: `unit-${index}`,
        sequence: String(index + 1),
        publishedAt: dates[index] ?? null,
      }));
    client.search.mockResolvedValue({
      hits: [
        { remoteId: '2', title: 'Alternate Saga', author: null, remoteCoverPath: null, sourceName: 'Same Small' },
        { remoteId: '3', title: 'Alternate Saga', author: null, remoteCoverPath: null, sourceName: 'Same Large' },
        { remoteId: '4', title: 'Dungeon Saga', author: null, remoteCoverPath: null, sourceName: 'Title Source' },
      ],
      failedSources: ['Slow Source'],
    });
    lookupService.findMatch.mockImplementation(async (_kind: string, _title: string, _author: string | null, key: string) =>
      key === 'm:1' ? { id: '1995', title: 'Canonical Saga' } : key === 'm:4' ? null : { id: '1995' },
    );
    client.getSeries.mockImplementation(async (_connection: unknown, remoteId: string) => {
      if (remoteId === '2') {
        return { ...mangaSeries, title: 'Alternate Saga', sourceName: 'Same Small', chapterCount: 3, units: units(3, ['2026-01-03T00:00:00Z']) };
      }
      if (remoteId === '3') {
        return {
          ...mangaSeries,
          title: 'Alternate Saga',
          sourceName: 'Same Large',
          chapterCount: 4,
          units: units(4, ['2026-02-01T00:00:00Z', '2026-02-04T00:00:00Z', '2026-02-02T00:00:00Z']),
        };
      }
      if (remoteId === '4') {
        return { ...mangaSeries, sourceName: 'Title Source', chapterCount: 5, units: units(5, ['2026-03-01T00:00:00Z']) };
      }
      return {
        ...mangaSeries,
        chapterCount: 2,
        units: units(2, ['2026-01-01T00:00:00Z', '2026-01-05T00:00:00Z']),
      };
    });

    await expect(service.getSeriesSources('m:1')).resolves.toEqual({
      options: [
        expect.objectContaining({
          seriesKey: 'm:1',
          confidence: 'current',
          chapterCount: 2,
          latestAt: '2026-01-05T00:00:00Z',
          mostComplete: false,
        }),
        expect.objectContaining({ seriesKey: 'm:3', confidence: 'same_series', chapterCount: 4, latestAt: '2026-02-04T00:00:00Z' }),
        expect.objectContaining({ seriesKey: 'm:2', confidence: 'same_series', chapterCount: 3 }),
        expect.objectContaining({ seriesKey: 'm:4', confidence: 'title_match', chapterCount: 5, mostComplete: true }),
      ],
      failedSources: ['Slow Source'],
    });
    expect(client.search).toHaveBeenCalledWith(CONN, 'Canonical Saga', ['en'], expect.any(AbortSignal));
  });

  it('prefers the current source for the most complete badge when chapter counts tie', async () => {
    const { service, client, lookupService } = setup();
    lookupService.findMatch.mockResolvedValue(null);
    client.search.mockResolvedValue({
      hits: [{ remoteId: '2', title: 'Dungeon Saga', author: null, remoteCoverPath: null, sourceName: 'Other Source' }],
      failedSources: [],
    });
    client.getSeries.mockImplementation(async (_connection: unknown, remoteId: string) => ({
      ...mangaSeries,
      sourceName: remoteId === '2' ? 'Other Source' : mangaSeries.sourceName,
    }));

    const result = await service.getSeriesSources('m:1');

    expect(result.options).toHaveLength(2);
    expect(result.options[0]).toMatchObject({ confidence: 'current', mostComplete: true });
    expect(result.options[1]).toMatchObject({ confidence: 'title_match', mostComplete: false });
  });

  it('returns only the current source for novels without searching other sites', async () => {
    const { service, client } = setup();
    client.getSeries.mockResolvedValue({ ...mangaSeries, kind: 'novel', sourceName: 'Royal Road', chapterCount: 12 });

    await expect(service.getSeriesSources('n:royal-road-1')).resolves.toEqual({
      options: [
        expect.objectContaining({
          seriesKey: 'n:royal-road-1',
          sourceName: 'Royal Road',
          chapterCount: 12,
          confidence: 'current',
          mostComplete: true,
        }),
      ],
      failedSources: [],
    });
    expect(client.search).not.toHaveBeenCalled();
  });

  it('serves repeated source requests from the per-series cache', async () => {
    const { service, client } = setup();

    const first = await service.getSeriesSources('m:1');
    const second = await service.getSeriesSources('m:1');

    expect(second).toBe(first);
    expect(client.search).toHaveBeenCalledTimes(1);
    expect(client.getSeries).toHaveBeenCalledTimes(1);
  });

  it('keeps the current source available when cross-source search fails', async () => {
    const { service, client } = setup();
    client.search.mockRejectedValue(new Error('engine unavailable'));

    await expect(service.getSeriesSources('m:1')).resolves.toEqual({
      options: [expect.objectContaining({ seriesKey: 'm:1', confidence: 'current', mostComplete: true })],
      failedSources: ['manga'],
    });
  });
});

describe('WebSerialsCatalogService caches and settings changes', () => {
  it('does not serve a search from before a settings or extension change', async () => {
    const { service, client, settings } = setup();

    await service.search('dungeon', 'manga', USER);
    settings.catalogVersion = 2;
    await service.search('dungeon', 'manga', USER);

    expect(client.search).toHaveBeenCalledTimes(2);
  });

  it('caches a source list with failed sources only briefly', async () => {
    vi.useFakeTimers();
    try {
      const { service, client } = setup();
      client.search.mockResolvedValue({ hits: [], failedSources: ['Slow'] });

      await service.getSeriesSources('m:1');
      await service.getSeriesSources('m:1');
      expect(client.search).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(61_000);
      await service.getSeriesSources('m:1');
      expect(client.search).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the first search by the preview deadline, not only later steps', async () => {
    const { service, client } = setup();
    client.search.mockResolvedValue({ hits: [], failedSources: [] });

    await service.findMangaSourceCandidates({ sourceTitle: 'Dungeon', sourceName: 'MangaDex', query: 'dungeon', matchId: null });

    const signal = client.search.mock.calls[0]![3] as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('does not cache the current-source-only answer given after a search error', async () => {
    const { service, client } = setup();
    client.search.mockRejectedValueOnce(new Error('hiccup')).mockResolvedValue({ hits: [], failedSources: [] });

    const failed = await service.getSeriesSources('m:1');
    const retried = await service.getSeriesSources('m:1');

    expect(failed.failedSources).toEqual(['manga']);
    expect(retried.failedSources).toEqual([]);
  });

  it('serves a complete source list after a settings change only from a fresh search', async () => {
    const { service, client, settings } = setup();

    await service.getSeriesSources('m:1');
    settings.catalogVersion = 2;
    await service.getSeriesSources('m:1');

    expect(client.search).toHaveBeenCalledTimes(2);
  });

  it('answers the lookup from the cache without scraping the series again', async () => {
    const { service, lookupService, engines } = setup();
    lookupService.peekCachedLookup.mockReturnValue({ state: 'matched', match: { id: '1995' }, message: null, chapterVolumes: null });

    await expect(service.getSeriesLookup('m:1')).resolves.toMatchObject({ state: 'matched' });

    expect(engines.loadSeries).not.toHaveBeenCalled();
    expect(lookupService.lookup).not.toHaveBeenCalled();
  });

  it('ignores a cached lookup once lookup has been turned off', async () => {
    const { service, lookupService, settings, engines } = setup();
    lookupService.peekCachedLookup.mockReturnValue({ state: 'matched', match: { id: '1995' }, message: null, chapterVolumes: null });
    settings.getSettings.mockResolvedValue({ lookup: { enabled: false } });
    lookupService.lookup.mockResolvedValue({ state: 'disabled', match: null, message: null, chapterVolumes: null });

    await expect(service.getSeriesLookup('m:1')).resolves.toMatchObject({ state: 'disabled' });
    expect(engines.loadSeries).toHaveBeenCalled();
  });
});

describe('WebSerialsCatalogService source candidate fan-out', () => {
  function manyHits(sources: number, perSource: number) {
    return Array.from({ length: sources * perSource }, (_, index) => ({
      remoteId: String(index + 2),
      title: index % 2 === 0 ? 'Dungeon Saga' : `Other title ${index}`,
      author: null,
      remoteCoverPath: null,
      sourceName: `Source ${index % sources}`,
    }));
  }

  it('bounds the matching and the series scrapes however many hits the sources return', async () => {
    const { service, client, lookupService } = setup();
    client.search.mockResolvedValue({ hits: manyHits(15, 20), failedSources: [] });
    lookupService.findMatch.mockImplementation(async (_kind: string, _title: string, _author: string | null, key: string) =>
      key === 'm:1' ? { id: '1995', title: 'Dungeon Saga' } : { id: '1995' },
    );
    client.getSeries.mockImplementation(async (_conn: unknown, remoteId: string) => ({
      ...mangaSeries,
      sourceName: `Source ${Number(remoteId) % 15}`,
    }));

    const result = await service.getSeriesSources('m:1');

    expect(lookupService.findMatch.mock.calls.length).toBeLessThanOrEqual(1 + 12);
    expect(client.getSeries.mock.calls.length).toBeLessThanOrEqual(1 + 6);
    expect(result.options.length).toBeLessThanOrEqual(1 + 6);
    expect(lookupService.lookup).not.toHaveBeenCalled();
  });

  it('never runs the full lookup with an empty chapter list for a candidate', async () => {
    const { service, client, lookupService } = setup();
    client.search.mockResolvedValue({ hits: manyHits(3, 1), failedSources: [] });

    await service.getSeriesSources('m:1');

    expect(lookupService.lookup).not.toHaveBeenCalled();
    expect(lookupService.findMatch).toHaveBeenCalled();
  });

  it('stops after the overall deadline and reports the unreached sources as failed', async () => {
    vi.useFakeTimers();
    try {
      const { service, client, lookupService } = setup();
      client.search.mockResolvedValue({ hits: manyHits(8, 1), failedSources: [] });
      lookupService.findMatch.mockImplementation(async (_kind: string, _title: string, _author: string | null, key: string) => {
        if (key !== 'm:1') vi.setSystemTime(Date.now() + 25_000);
        return { id: '1995', title: 'Dungeon Saga' };
      });

      const result = await service.getSeriesSources('m:1');

      expect(lookupService.findMatch.mock.calls.length).toBeLessThan(8);
      expect(result.failedSources.length).toBeGreaterThan(0);
      expect(result.options[0]).toMatchObject({ confidence: 'current' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a hit that MangaBaka matched to a different series even when the titles are equal', async () => {
    const { service, client, lookupService } = setup();
    client.search.mockResolvedValue({
      hits: [{ remoteId: '2', title: 'Dungeon Saga', author: null, remoteCoverPath: null, sourceName: 'Other Source' }],
      failedSources: [],
    });
    lookupService.findMatch.mockImplementation(async (_kind: string, _title: string, _author: string | null, key: string) =>
      key === 'm:1' ? { id: '1995', title: 'Dungeon Saga' } : { id: '777' },
    );
    client.getSeries.mockImplementation(async (_conn: unknown, remoteId: string) => ({
      ...mangaSeries,
      sourceName: remoteId === '2' ? 'Other Source' : mangaSeries.sourceName,
    }));

    const result = await service.getSeriesSources('m:1');

    expect(result.options.map((option) => option.seriesKey)).toEqual(['m:1']);
  });
});

describe('WebSerialsCatalogService series opened from the series database', () => {
  it('counts chapters imported from other sources of the same match id as already downloaded', async () => {
    const { service, repo } = setup();

    await service.getSeriesDetail('m:1', USER, '1995');

    expect(repo.findImportedUnitKeys).toHaveBeenCalledWith(USER.id, 'm:1', expect.any(Array), 'mb:1995', []);
  });

  it('ignores a malformed match id hint', async () => {
    const { service, repo } = setup();

    await service.getSeriesDetail('m:1', USER, '12;drop');

    expect(repo.findImportedUnitKeys).toHaveBeenCalledWith(USER.id, 'm:1', expect.any(Array), null, []);
  });

  it('presets the lookup match instead of guessing from the source title', async () => {
    const { service, lookupService } = setup();
    const preset = { state: 'matched', match: { id: '1995' }, message: null, chapterVolumes: null };
    const lookupByMatchId = vi.fn().mockResolvedValue(preset);
    Object.assign(lookupService, { lookupByMatchId });

    await expect(service.getSeriesLookup('m:1', '1995')).resolves.toBe(preset);

    expect(lookupByMatchId).toHaveBeenCalledWith('manga', '1995', mangaSeries.units, 'm:1');
    expect(lookupService.lookup).not.toHaveBeenCalled();
  });

  it('matches a source hit by any alternative title when the database does not decide', async () => {
    const { service, client, lookupService } = setup();
    lookupService.findMatch.mockResolvedValue(null);
    client.search.mockResolvedValue({
      hits: [
        {
          remoteId: '5',
          url: null,
          title: 'Sousou no Frieren',
          author: null,
          remoteCoverPath: null,
          sourceName: 'Alt Source',
          chapterCount: 9,
          status: 'ongoing',
        },
        {
          remoteId: '6',
          url: null,
          title: 'Unrelated',
          author: null,
          remoteCoverPath: null,
          sourceName: 'Other Source',
          chapterCount: 9,
          status: 'ongoing',
        },
      ],
      failedSources: [],
    });

    const found = await service.findMangaSourceCandidates({
      sourceTitle: 'Frieren: Beyond Journey’s End',
      altTitles: ['Sousou no Frieren'],
      sourceName: '',
      query: 'Frieren',
      matchId: '1995',
    });

    expect(found.candidates.map((entry) => [entry.seriesKey, entry.confidence])).toEqual([['m:5', 'title_match']]);
  });
});
