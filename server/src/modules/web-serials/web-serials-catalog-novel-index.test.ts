import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WebSerialsCatalogService } from './web-serials-catalog.service';
import { WebSerialsNovelCandidatesService } from './web-serials-novel-candidates.service';

vi.mock('./web-serials-engine-registry.service', () => ({ WebSerialsEngineRegistry: class {} }));
vi.mock('./web-serials-cover.service', () => ({ WebSerialsCoverService: class {} }));
vi.mock('./web-serials-settings.service', () => ({ WebSerialsSettingsService: class {} }));
vi.mock('./web-serials-novel-index.service', () => ({ WebSerialsNovelIndexService: class {} }));
vi.mock('./lookup/web-serials-lookup.service', () => ({
  WebSerialsLookupService: class {},
}));
vi.mock('../library/library.service', () => ({ LibraryService: class {} }));

const CONN = { url: 'http://novel-sources:8282', username: null, password: 'token' };
const USER = { id: 7, isSuperuser: false } as never;

const hit = (sourceName: string, path: string, title = 'Omniscient Reader') => ({
  remoteId: `${sourceName.toLowerCase()}:${Buffer.from(path).toString('base64url')}`,
  url: `https://${sourceName}.test/${path}`,
  title,
  author: null,
  remoteCoverPath: null,
  sourceName,
  chapterCount: null,
  status: 'unknown' as const,
});

function build(states: Record<string, string> = {}) {
  const client = {
    search: vi.fn().mockResolvedValue({ hits: [hit('B', 'live')], failedSources: [] }),
  };
  const engines = {
    getConfig: vi.fn().mockResolvedValue({ connection: CONN, allowedSources: ['a', 'b', 'off'], engine: 'lnreader' }),
    fileIndexConfig: vi.fn().mockResolvedValue(null),
    client: vi.fn().mockReturnValue(client),
    loadSeries: vi.fn(),
    requireEnabledSource: vi.fn().mockResolvedValue(undefined),
  };
  const repo = {
    getDisabledNovelDomains: vi.fn().mockResolvedValue(['off']),
    findImportedUnitKeys: vi.fn().mockResolvedValue([]),
    findImportedGroupKeys: vi.fn().mockResolvedValue([]),
  };
  const settings = { catalogVersion: 1, getSettings: vi.fn().mockResolvedValue({ lookup: { enabled: true } }) };
  const covers = { remember: vi.fn() };
  const lookupService = {
    searchTitles: vi.fn().mockResolvedValue([]),
    peekCachedLookup: vi.fn().mockReturnValue(undefined),
    lookup: vi.fn().mockResolvedValue({ state: 'matched', match: { id: '42', title: 'ORV' }, message: null, chapterVolumes: null }),
    lookupByMatchId: vi.fn().mockResolvedValue({ state: 'matched', match: { id: '9' }, message: null, chapterVolumes: null }),
    findMatch: vi.fn(),
  };
  const novelIndex = {
    search: vi.fn().mockResolvedValue([hit('A', 'indexed'), hit('B', 'live')]),
    fillStates: vi.fn().mockResolvedValue(new Map(Object.entries(states))),
    recordHits: vi.fn().mockResolvedValue(undefined),
    recordSeries: vi.fn().mockResolvedValue(undefined),
    recordMatch: vi.fn().mockResolvedValue(undefined),
    candidates: vi.fn().mockResolvedValue([]),
  };
  const catalog = new WebSerialsCatalogService(
    repo as never,
    settings as never,
    engines as never,
    covers as never,
    {} as never,
    lookupService as never,
    novelIndex as never,
  );
  return { catalog, client, engines, repo, novelIndex, lookupService };
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe('novel search on the light novel index', () => {
  it('answers from the index, asks only unfilled sources live, merges without duplicates and records the live hits', async () => {
    const { catalog, client, novelIndex } = build({ a: 'done', b: 'filling' });

    const result = await catalog.search('omni', 'novel', USER);

    expect(novelIndex.search).toHaveBeenCalledWith({ connection: CONN, enabledSourceIds: ['a', 'b', 'off'] }, 'omni', ['a', 'b']);
    expect(client.search).toHaveBeenCalledWith(CONN, 'omni', ['b'], expect.any(AbortSignal));
    expect(novelIndex.recordHits).toHaveBeenCalledWith([hit('B', 'live')]);
    expect(result.hits.map((entry) => entry.sourceName).sort()).toEqual(['A', 'B']);
    expect(result.hits.every((entry) => entry.seriesKey?.startsWith('nl:'))).toBe(true);
    expect(result).not.toHaveProperty('livePending');
  });

  it('runs no live search once every enabled source is filled, unless the user refreshes', async () => {
    const { catalog, client } = build({ a: 'done', b: 'done' });

    await catalog.search('omni', 'novel', USER);
    expect(client.search).not.toHaveBeenCalled();

    await catalog.search('omni', 'novel', USER, true);
    expect(client.search).toHaveBeenCalledWith(CONN, 'omni', ['a', 'b'], expect.any(AbortSignal));
  });

  it('answers the index phase at once and says whether the live half is still to come', async () => {
    const pending = build({ a: 'done' });
    const result = await pending.catalog.search('omni', 'novel', USER, false, 'index');
    expect(pending.client.search).not.toHaveBeenCalled();
    expect(result).toMatchObject({ livePending: true });
    expect(result.hits).toHaveLength(2);

    const filled = build({ a: 'done', b: 'done' });
    expect(await filled.catalog.search('omni', 'novel', USER, false, 'index')).not.toHaveProperty('livePending');
  });

  it('keeps the index hits when the live search fails', async () => {
    const { catalog, client } = build();
    client.search.mockRejectedValue(new Error('down'));

    const result = await catalog.search('omni', 'novel', USER);

    expect(result.hits).toHaveLength(2);
    expect(result.failedSources).toEqual(['novel']);
  });

  it('records an opened novel, and its match only when the lookup confirms the same title and author', async () => {
    const { catalog, engines, novelIndex, lookupService } = build();
    const series = {
      kind: 'novel',
      title: 'ORV',
      author: 'Sing Shong',
      units: [],
      remoteCoverPath: null,
      status: 'ongoing',
      chapterCount: 10,
      tags: [],
    };
    engines.loadSeries.mockResolvedValue(series);
    const remoteId = `a:${Buffer.from('novel/orv').toString('base64url')}`;
    const matched = (match: Record<string, unknown>) => ({ state: 'matched', match, message: null, chapterVolumes: null });

    lookupService.lookup.mockResolvedValueOnce(matched({ id: '42', title: 'ORV', authors: ['Shong Sing'] }));
    await catalog.getSeriesLookup(`nl:${remoteId}`);
    await catalog.getSeriesLookup(`nl:${remoteId}`, '9');
    lookupService.lookup.mockResolvedValueOnce(matched({ id: '43', title: 'ORV', authors: ['Someone Else'] }));
    await catalog.getSeriesLookup(`nl:${remoteId}`);
    lookupService.lookup.mockResolvedValueOnce(matched({ id: '44', title: 'ORV: Side Story', authors: ['Sing Shong'] }));
    await catalog.getSeriesLookup(`nl:${remoteId}`);
    lookupService.lookup.mockResolvedValueOnce(matched({ id: '45', title: 'ORV', authors: ['Sing Shong'], scope: 'part' }));
    await catalog.getSeriesLookup(`nl:${remoteId}`);

    expect(novelIndex.recordSeries).toHaveBeenCalledWith(remoteId, series);
    expect(lookupService.lookupByMatchId).toHaveBeenCalledTimes(1);
    expect(novelIndex.recordMatch.mock.calls).toEqual([[remoteId, '42']]);
  });

  it('refuses a lookup or source list for a site the admin disabled, even when the answer is cached', async () => {
    const { catalog, engines, lookupService } = build();
    const disabled = Object.assign(new Error('That site is not enabled for downloads'), { status: 404 });
    engines.requireEnabledSource.mockRejectedValue(disabled);
    lookupService.peekCachedLookup.mockReturnValue({ state: 'matched', match: { id: '1' }, message: null, chapterVolumes: null });
    const key = `nl:off:${Buffer.from('novel/x').toString('base64url')}`;

    await expect(catalog.getSeriesLookup(key)).rejects.toBe(disabled);
    await expect(catalog.getSeriesSources(key)).rejects.toBe(disabled);
    expect(engines.requireEnabledSource).toHaveBeenCalledWith('novel', key.slice(3));
    expect(engines.loadSeries).not.toHaveBeenCalled();
  });
});

describe('discover novel sources from the index', () => {
  function candidate(sourceName: string, path: string, chapterCount: number | null, matched: boolean) {
    const entry = hit(sourceName, path);
    return {
      hit: entry,
      seriesKey: `nl:${entry.remoteId}`,
      matched,
      row: {
        sourceId: sourceName.toLowerCase(),
        path,
        url: entry.url,
        title: entry.title,
        mtl: false,
        coverUrl: null,
        matchId: matched ? '9' : null,
        status: null,
        chapterCount,
      },
    };
  }

  function buildCandidates(indexed: unknown[], states: Record<string, string> = { a: 'done', b: 'done', off: 'done' }) {
    const { catalog, engines, client, novelIndex } = build(states);
    novelIndex.candidates.mockResolvedValue(indexed);
    const loadSeries = vi.spyOn(catalog, 'loadSeries');
    const lookupService = { findMatch: vi.fn() };
    const service = new WebSerialsNovelCandidatesService(engines as never, catalog, lookupService as never, novelIndex as never);
    return { service, client, engines, loadSeries, novelIndex, lookupService };
  }

  it('answers from the index and opens only the preselected candidate', async () => {
    const { service, client, loadSeries, novelIndex } = buildCandidates([candidate('A', 'a1', 40, false), candidate('B', 'b1', 120, true)]);
    loadSeries.mockResolvedValue({ title: 'Omniscient Reader', sourceName: 'B', chapterCount: 551, units: [] } as never);

    const found = await service.find({ title: 'Omniscient Reader', altTitles: ['ORV'], matchId: '9', disabledDomains: ['off'] });

    expect(novelIndex.candidates).toHaveBeenCalledWith(expect.anything(), '9', ['Omniscient Reader', 'ORV'], ['a', 'b'], []);
    expect(client.search).not.toHaveBeenCalled();
    expect(loadSeries).toHaveBeenCalledTimes(1);
    expect(loadSeries.mock.calls[0]![2]).toBe(`nl:${hit('B', 'b1').remoteId}`);
    expect(found.candidates.map((entry) => [entry.hit.sourceName, entry.confidence, entry.series.chapterCount])).toEqual([
      ['B', 'same_series', 551],
      ['A', 'title_match', 40],
    ]);
  });

  it('keeps the index answer and names the source when the preselected novel cannot be opened', async () => {
    const { service, loadSeries } = buildCandidates([candidate('A', 'a1', 3, true)]);
    loadSeries.mockRejectedValue(new Error('down'));

    const found = await service.find({ title: 'Omniscient Reader', altTitles: [], matchId: '9', disabledDomains: [] });

    expect(found.failedSources).toEqual(['A']);
    expect(found.candidates).toHaveLength(1);
  });

  it('also asks live the sources whose index is still filling, and only those', async () => {
    const { service, client, loadSeries, lookupService } = buildCandidates([candidate('A', 'a1', 40, true)], { a: 'done', b: 'filling' });
    loadSeries.mockResolvedValue({ title: 'Omniscient Reader', sourceName: 'A', chapterCount: 551, units: [] } as never);
    client.search.mockResolvedValue({ hits: [], failedSources: [] });
    lookupService.findMatch.mockResolvedValue(null);

    const found = await service.find({ title: 'Omniscient Reader', altTitles: [], matchId: '9', disabledDomains: ['off'] });

    expect(client.search).toHaveBeenCalledWith(CONN, 'Omniscient Reader', ['b'], expect.any(AbortSignal));
    expect(found.candidates.map((entry) => entry.hit.sourceName)).toEqual(['A']);
  });

  it('merges the index answer with what a still filling source finds live', async () => {
    const { service, client, engines, loadSeries, lookupService } = buildCandidates([candidate('A', 'a1', 40, true)], {
      a: 'done',
      b: 'filling',
    });
    const liveRemoteId = hit('B', 'b-live').remoteId;
    Object.assign(engines, { requireConfig: engines.getConfig });
    Object.assign(client, { resolveUrl: vi.fn().mockResolvedValue({ kind: 'novel', remoteId: liveRemoteId }) });
    loadSeries.mockImplementation((_kind, remoteId) => {
      const sourceName = remoteId === liveRemoteId ? 'B' : 'A';
      return Promise.resolve({ title: 'Omniscient Reader', sourceName, chapterCount: sourceName === 'A' ? 551 : 300, units: [] } as never);
    });
    client.search.mockResolvedValue({ hits: [hit('B', 'b-live')], failedSources: [] });
    lookupService.findMatch.mockResolvedValue(null);

    const found = await service.find({ title: 'Omniscient Reader', altTitles: [], matchId: '9', disabledDomains: ['off'] });

    expect(client.search.mock.calls.map((call) => call[2])).toEqual([['b']]);
    expect(found.candidates.map((entry) => [entry.hit.sourceName, entry.confidence, entry.series.chapterCount])).toEqual([
      ['A', 'same_series', 551],
      ['B', 'title_match', 300],
    ]);
    expect(found.failedSources).toEqual([]);
  });

  it('searches the sources live only when the index has no candidate', async () => {
    const { service, client } = buildCandidates([]);
    client.search.mockResolvedValue({ hits: [], failedSources: [] });

    await service.find({ title: 'Omniscient Reader', altTitles: [], matchId: '9', disabledDomains: [] });

    expect(client.search).toHaveBeenCalled();
  });
});
