/* eslint-disable @typescript-eslint/require-await */
import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { WebSerialErrorCode } from '@bookorbit/types';

import { WebSerialsNovelCandidatesService } from './web-serials-novel-candidates.service';

vi.mock('./lookup/web-serials-lookup.service', async () => {
  const actual = await vi.importActual<typeof import('./lookup/web-serials-lookup.service')>('./lookup/web-serials-lookup.service');
  return { ...actual, WebSerialsLookupService: class {} };
});
vi.mock('./web-serials-catalog.service', () => ({ WebSerialsCatalogService: class {} }));
vi.mock('./web-serials-engine-registry.service', () => ({ WebSerialsEngineRegistry: class {} }));
vi.mock('./web-serials-novel-index.service', () => ({ WebSerialsNovelIndexService: class {} }));

const CONN = { url: 'http://novel-sources', username: null, password: null };
const AUTHORS: Record<string, string> = { novelfire: 'Kubou Tadashi', other: 'Someone Else', lnpub: 'Tadashi Kubou' };

const CENTRAL = {
  title: 'The Water Magician: The Central Provinces Arc',
  altTitles: ['Mizu Zokusei no Mahou Tsukai Dai Ichi-bu'],
  authors: ['Tadashi Kubou'],
  matchId: '20',
  disabledDomains: [] as string[],
};
const EASTERN = {
  title: 'Mizu Zokusei no Mahou Tsukai Dai San-bu: Touhou Shokoku-hen',
  altTitles: ['The Water Magician: The Eastern Provinces Arc'],
  authors: ['Tadashi Kubou'],
  matchId: '40',
  disabledDomains: [] as string[],
};

function hit(source: string, title: string) {
  return {
    remoteId: null,
    url: `https://${source}.test/${title.toLowerCase().replace(/\W+/g, '-')}`,
    title,
    author: null,
    remoteCoverPath: null,
    sourceName: source,
    chapterCount: null,
    status: 'unknown' as const,
  };
}

function loadedSeries(remoteId: string) {
  const source = remoteId.split(/[:-]/)[0]!;
  return {
    title: 'Water Magician',
    author: AUTHORS[source] ?? null,
    authors: AUTHORS[source] ? [AUTHORS[source]] : [],
    sourceName: source,
    chapterCount: source === 'lnpub' ? 40 : 800,
    units: [],
  };
}

function setup(engine: 'lnreader' | 'lncrawl' = 'lncrawl') {
  const client = {
    search: vi.fn().mockResolvedValue({ hits: [], failedSources: [] }),
    resolveUrl: vi.fn(async (_conn: unknown, url: string) => ({
      kind: 'novel',
      remoteId: `${new URL(url).hostname.split('.')[0]}-${url.split('/').pop()}`,
    })),
  };
  const config = { connection: CONN, allowedSources: ['novelfire', 'other', 'lnpub'], engine };
  const engines = {
    getConfig: vi.fn().mockResolvedValue(config),
    requireConfig: vi.fn().mockResolvedValue(config),
    client: vi.fn().mockReturnValue(client),
  };
  const catalog = { loadSeries: vi.fn(async (_kind: string, remoteId: string) => loadedSeries(remoteId)) };
  const lookup = { findMatch: vi.fn().mockResolvedValue(null) };
  const novelIndex = {
    candidates: vi.fn().mockResolvedValue([]),
    wholeSeriesCandidates: vi.fn().mockResolvedValue([]),
    fillStates: vi.fn().mockResolvedValue(
      new Map([
        ['novelfire', 'done'],
        ['other', 'done'],
        ['lnpub', 'done'],
      ]),
    ),
  };
  const service = new WebSerialsNovelCandidatesService(engines as never, catalog as never, lookup as never, novelIndex as never);
  return { service, client, catalog, lookup, novelIndex };
}

function indexEntry(source: string, title: string, chapterCount: number) {
  const remoteId = `${source}:${title}`;
  return {
    hit: { ...hit(source, title), remoteId },
    seriesKey: `nl:${remoteId}`,
    matched: false,
    row: { sourceId: source, path: title, url: null, title, mtl: false, coverUrl: null, matchId: null, status: null, chapterCount },
  };
}

describe('WebSerialsNovelCandidatesService whole series filed in parts', () => {
  it('offers a site carrying the whole series when no site has the part, only where the author agrees', async () => {
    const { service, client } = setup();
    client.search.mockImplementation(async (_conn: unknown, query: string) =>
      query === 'water magician'
        ? { hits: [hit('novelfire', 'Water Magician'), hit('other', 'Water Magician')], failedSources: [] }
        : { hits: [], failedSources: [] },
    );

    const result = await service.find(CENTRAL);

    expect(client.search.mock.calls.map((call) => call[1])).toEqual([CENTRAL.title, CENTRAL.altTitles[0], 'water magician']);
    expect(result.candidates.map((entry) => [entry.hit.sourceName, entry.confidence])).toEqual([['novelfire', 'whole_series']]);
    expect(result.failedSources).toEqual([]);
  });

  it('keeps only the exact matches when a site has the part under its own title', async () => {
    const { service, client } = setup();
    client.search.mockResolvedValue({
      hits: [hit('lnpub', 'The Water Magician: The Central Provinces Arc'), hit('novelfire', 'Water Magician')],
      failedSources: [],
    });

    const result = await service.find(CENTRAL);

    expect(result.candidates.map((entry) => [entry.hit.sourceName, entry.confidence])).toEqual([['lnpub', 'title_match']]);
  });

  it('does not let a part match on the hit decide the series', async () => {
    const { service, client, lookup } = setup();
    client.search.mockResolvedValue({ hits: [hit('novelfire', 'Water Magician')], failedSources: [] });
    lookup.findMatch.mockResolvedValue({ id: '20', scope: 'part' });

    const result = await service.find(CENTRAL);

    expect(result.candidates.map((entry) => entry.confidence)).toEqual(['whole_series']);
  });

  it('never offers a whole-series copy without the database authors', async () => {
    const { service, client, catalog } = setup();
    client.search.mockResolvedValue({ hits: [hit('novelfire', 'Water Magician')], failedSources: [] });

    const result = await service.find({ ...CENTRAL, authors: [] });

    expect(result.candidates).toEqual([]);
    expect(catalog.loadSeries).not.toHaveBeenCalled();
  });

  it('answers from the index by base title, confirming the author on the opened page', async () => {
    const { service, client, novelIndex, catalog } = setup('lnreader');
    novelIndex.wholeSeriesCandidates.mockResolvedValue([indexEntry('novelfire', 'Water Magician', 800), indexEntry('other', 'Water Magician', 300)]);

    const result = await service.find(EASTERN);

    expect(novelIndex.wholeSeriesCandidates).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(['water magician', 'mizu zokusei no mahou tsukai']),
      ['novelfire', 'other', 'lnpub'],
    );
    expect(client.search).not.toHaveBeenCalled();
    expect(catalog.loadSeries).toHaveBeenCalledTimes(2);
    expect(result.candidates.map((entry) => [entry.hit.sourceName, entry.confidence, entry.series.chapterCount])).toEqual([
      ['novelfire', 'whole_series', 800],
    ]);
  });

  it('prefers exact index candidates and never looks for the whole series then', async () => {
    const { service, novelIndex, catalog } = setup('lnreader');
    novelIndex.candidates.mockResolvedValue([{ ...indexEntry('lnpub', 'The Water Magician: The Central Provinces Arc', 40), matched: true }]);

    const result = await service.find(CENTRAL);

    expect(novelIndex.wholeSeriesCandidates).not.toHaveBeenCalled();
    expect(catalog.loadSeries).toHaveBeenCalledTimes(1);
    expect(result.candidates.map((entry) => entry.confidence)).toEqual(['same_series']);
  });

  it('lets the index weigh credited artists as well as authors before dropping a same-titled entry', async () => {
    const { service, novelIndex } = setup('lnreader');

    await service.find({ ...CENTRAL, artists: ['Kakao Illustrator'] });

    expect(novelIndex.candidates.mock.calls[0]![4]).toEqual(['Tadashi Kubou', 'Kakao Illustrator']);
  });

  it('keeps the index series of a preselected candidate whose chapter list is still loading, without a failed site', async () => {
    const { service, novelIndex, catalog } = setup('lnreader');
    novelIndex.candidates.mockResolvedValue([{ ...indexEntry('lnpub', 'The Water Magician: The Central Provinces Arc', 40), matched: true }]);
    catalog.loadSeries.mockRejectedValue(
      new ServiceUnavailableException({ message: 'still loading', errorCode: WebSerialErrorCode.SeriesLoading, errorMeta: { retryAfterMs: 5000 } }),
    );

    const result = await service.find(CENTRAL);

    expect(result.failedSources).toEqual([]);
    expect(result.candidates.map((entry) => [entry.hit.sourceName, entry.series.chapterCount])).toEqual([['lnpub', 40]]);
  });

  it('does not hold the sources answer past the interactive wait for the preselected candidate', async () => {
    vi.useFakeTimers();
    try {
      const { service, novelIndex, catalog } = setup('lnreader');
      novelIndex.candidates.mockResolvedValue([{ ...indexEntry('lnpub', 'The Water Magician: The Central Provinces Arc', 40), matched: true }]);
      catalog.loadSeries.mockImplementation(() => new Promise(() => undefined));

      const pending = service.find(CENTRAL);
      await vi.advanceTimersByTimeAsync(45_000);
      const result = await pending;

      expect(result.failedSources).toEqual([]);
      expect(result.candidates.map((entry) => entry.series.chapterCount)).toEqual([40]);
    } finally {
      vi.useRealTimers();
    }
  });
});
