/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it, vi } from 'vitest';

import type { EngineSeriesRef } from './engines/web-serial-engine';
import { WebSerialsNovelCandidatesService } from './web-serials-novel-candidates.service';

vi.mock('./lookup/web-serials-lookup.service', async () => {
  const actual = await vi.importActual<typeof import('./lookup/web-serials-lookup.service')>('./lookup/web-serials-lookup.service');
  return { ...actual, WebSerialsLookupService: class {} };
});
vi.mock('./web-serials-catalog.service', () => ({ WebSerialsCatalogService: class {} }));
vi.mock('./web-serials-engine-registry.service', () => ({ WebSerialsEngineRegistry: class {} }));

const CONN = { url: 'http://lncrawl', username: null, password: null };

function hit(url: string, title: string, sourceName: string) {
  return { remoteId: null, url, title, author: null, remoteCoverPath: null, sourceName, chapterCount: null, status: 'unknown' as const };
}

function setup(allowedSources = ['royalroad.com', 'scribblehub.com'], connection: Record<string, unknown> = CONN) {
  const client = {
    search: vi.fn().mockResolvedValue({ hits: [], failedSources: [] }),
    resolveUrl: vi.fn(async (_conn: unknown, url: string): Promise<EngineSeriesRef | null> => ({
      kind: 'novel',
      remoteId: `id-${url.split('/').pop()}`,
    })),
  };
  const engines = {
    getConfig: vi.fn().mockResolvedValue({ connection, allowedSources }),
    fileIndexConfig: vi.fn().mockResolvedValue(null),
    requireConfig: vi.fn().mockResolvedValue({ connection, allowedSources }),
    client: vi.fn().mockReturnValue(client),
  };
  const catalog = {
    loadSeries: vi.fn(async (_kind: string, remoteId: string) => ({
      title: 'Mother of Learning',
      sourceName: remoteId,
      chapterCount: remoteId.endsWith('big') ? 90 : 20,
      units: [],
    })),
  };
  const lookup = { findMatch: vi.fn().mockResolvedValue(null) };
  const service = new WebSerialsNovelCandidatesService(engines as never, catalog as never, lookup as never);
  return { service, client, engines, catalog, lookup };
}

const input = {
  title: 'Mother of Learning',
  altTitles: ['Mother of Learning: Web Edition', '異世界'],
  matchId: '77',
  disabledDomains: [] as string[],
};

describe('WebSerialsNovelCandidatesService', () => {
  it('keeps hits whose title resolves to the same series and resolves them to loaded series', async () => {
    const { service, client, lookup } = setup();
    client.search.mockResolvedValue({
      hits: [hit('https://rr/big', 'Mother of Learning', 'royalroad.com'), hit('https://sh/other', 'Mother of Learning: Fanfic', 'scribblehub.com')],
      failedSources: [],
    });
    lookup.findMatch.mockImplementation(async (_kind: string, title: string) => ({ id: title.endsWith('Fanfic') ? '999' : '77' }));

    const result = await service.find(input);

    expect(result.candidates.map((entry) => [entry.seriesKey, entry.confidence])).toEqual([['n:id-big', 'same_series']]);
    expect(client.resolveUrl).toHaveBeenCalledTimes(1);
    expect(result.failedSources).toEqual([]);
  });

  it('gives opening the novel its own budget after a slow site search', async () => {
    vi.useFakeTimers();
    try {
      const { service, client } = setup();
      client.search.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 12_000));
        return { hits: [hit('https://rr/big', 'Mother of Learning', 'royalroad.com')], failedSources: [] };
      });
      client.resolveUrl.mockImplementation(async (_conn: unknown, url: string) => {
        await new Promise((resolve) => setTimeout(resolve, 15_000));
        return { kind: 'novel', remoteId: `id-${url.split('/').pop()}` };
      });

      const pending = service.find(input);
      await vi.advanceTimersByTimeAsync(28_000);
      const result = await pending;

      expect(result.candidates.map((entry) => entry.seriesKey)).toEqual(['n:id-big']);
      expect(result.failedSources).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to an exact normalized title when the database has no answer', async () => {
    const { service, client } = setup();
    client.search.mockResolvedValue({
      hits: [hit('https://rr/a', 'mother of learning', 'royalroad.com'), hit('https://sh/b', 'Something Else', 'scribblehub.com')],
      failedSources: [],
    });

    const result = await service.find(input);

    expect(result.candidates.map((entry) => [entry.seriesKey, entry.confidence])).toEqual([['n:id-a', 'title_match']]);
  });

  it("finds Omniscient Reader's Viewpoint on a site that tags its titles, preferring the non-MTL hit", async () => {
    const { service, client, lookup } = setup(['novelbuddy.com']);
    client.search.mockResolvedValue({
      hits: [
        hit('https://nb/mtl', 'MTL-Omniscient Reader’s Viewpoint', 'novelbuddy.com'),
        hit('https://nb/webnovel', 'Omniscient Reader’s Viewpoint (Web Novel KR)', 'novelbuddy.com'),
      ],
      failedSources: [],
    });
    lookup.findMatch.mockResolvedValue(null);

    const result = await service.find({
      title: "Omniscient Reader's Viewpoint",
      altTitles: [],
      matchId: '5',
      disabledDomains: [],
    });

    expect(result.candidates.map((entry) => [entry.seriesKey, entry.confidence])).toEqual([['n:id-webnovel', 'title_match']]);
    expect(client.search).toHaveBeenCalledTimes(1);
  });

  it('offers an MTL hit when it is the only copy of the series', async () => {
    const { service, client } = setup(['novelbuddy.com']);
    client.search.mockResolvedValue({ hits: [hit('https://nb/mtl', 'MTL-Omniscient Reader’s Viewpoint', 'novelbuddy.com')], failedSources: [] });

    const result = await service.find({ title: "Omniscient Reader's Viewpoint", altTitles: [], matchId: '5', disabledDomains: [] });

    expect(result.candidates.map((entry) => entry.seriesKey)).toEqual(['n:id-mtl']);
  });

  it('keeps one hit per site, the closest match first, and searches by an alternative title only when the official one finds nothing', async () => {
    const { service, client, lookup } = setup();
    client.search.mockResolvedValueOnce({ hits: [], failedSources: [] }).mockResolvedValueOnce({
      hits: [hit('https://rr/a', 'Mother of Learning: Web Edition', 'royalroad.com'), hit('https://rr/b', 'Mother of Learning', 'royalroad.com')],
      failedSources: [],
    });
    lookup.findMatch.mockImplementation(async (_kind: string, title: string) => (title.includes('Web Edition') ? null : { id: '77' }));

    const result = await service.find(input);

    expect(client.search.mock.calls.map((call) => call[1])).toEqual(['Mother of Learning', 'Mother of Learning: Web Edition']);
    expect(result.candidates.map((entry) => [entry.seriesKey, entry.confidence])).toEqual([['n:id-b', 'same_series']]);
  });

  it('searches only the domains the admin enabled and the user has not switched off', async () => {
    const { service, client } = setup();

    await service.find({ ...input, disabledDomains: ['ScribbleHub.com'] });

    expect(client.search).toHaveBeenCalledWith(CONN, 'Mother of Learning', ['royalroad.com'], expect.any(AbortSignal));
  });

  it('reports all-disabled without searching', async () => {
    const { service, client } = setup();

    const result = await service.find({ ...input, disabledDomains: ['royalroad.com', 'scribblehub.com'] });

    expect(result).toEqual({ candidates: [], failedSources: ['WEB_SERIAL_NOVEL_SOURCES_ALL_DISABLED'] });
    expect(client.search).not.toHaveBeenCalled();
  });

  it('reports the sites that failed and drops a hit that cannot be resolved', async () => {
    const { service, client } = setup();
    client.search.mockResolvedValue({ hits: [hit('https://rr/a', 'Mother of Learning', 'royalroad.com')], failedSources: ['scribblehub.com'] });
    client.resolveUrl.mockResolvedValue(null);

    const result = await service.find(input);

    expect(result.candidates).toEqual([]);
    expect(result.failedSources.sort()).toEqual(['royalroad.com', 'scribblehub.com']);
  });

  it('reports the engine as failed when the search throws', async () => {
    const { service, client } = setup();
    client.search.mockRejectedValue(new Error('down'));

    await expect(service.find(input)).resolves.toEqual({ candidates: [], failedSources: ['novel'] });
  });

  describe('budgets', () => {
    async function slowFind(connection: Record<string, unknown>, searchMs: number) {
      vi.useFakeTimers();
      try {
        const { service, client } = setup(['royalroad.com'], connection);
        client.search.mockImplementation(async (_conn: unknown, _query: string, _allowed: string[], signal: AbortSignal) => {
          await new Promise((resolve) => setTimeout(resolve, searchMs));
          if (signal.aborted) throw new Error('aborted');
          return { hits: [hit('https://rr/big', 'Mother of Learning', 'royalroad.com')], failedSources: [] };
        });
        const pending = service.find(input);
        await vi.advanceTimersByTimeAsync(searchMs + 5_000);
        return await pending;
      } finally {
        vi.useRealTimers();
      }
    }

    it('keeps a 20 s search when the service has a solver', async () => {
      const result = await slowFind({ ...CONN, solver: true }, 20_000);
      expect(result.candidates).toHaveLength(1);
    });

    it('drops a 20 s search without a solver', async () => {
      const result = await slowFind(CONN, 20_000);
      expect(result.candidates).toHaveLength(0);
    });

    it('treats solver: undefined as false', async () => {
      const result = await slowFind({ ...CONN, solver: undefined }, 20_000);
      expect(result.candidates).toHaveLength(0);
    });
  });
});

describe('WebSerialsNovelCandidatesService with file indexes', () => {
  function withFiles(engineConfig: unknown) {
    const ctx = setup();
    const fileClient = {
      candidates: vi.fn().mockResolvedValue([{ ...hit('', 'Mother of Learning', 'NAS'), url: null, remoteId: 'fi-3-42' }]),
    };
    Object.assign(ctx.engines, {
      getConfig: vi.fn().mockResolvedValue(engineConfig),
      fileIndexConfig: vi.fn().mockResolvedValue({ connection: CONN, allowedSources: ['fi-3', 'fi-4'], engine: 'fileindex' }),
      fileIndexClient: vi.fn().mockReturnValue(fileClient),
    });
    ctx.catalog.loadSeries.mockImplementation(async (_kind: string, remoteId: string) => ({
      title: 'Mother of Learning',
      sourceName: remoteId,
      chapterCount: 3,
      units: remoteId.startsWith('fi-') ? [{ unitKey: 'volume-1' }] : [],
    }));
    return { ...ctx, fileClient };
  }

  it('offers file index series on a server with no novel engine, skipping indexes the user switched off', async () => {
    const { service, fileClient } = withFiles(null);
    const result = await service.find({ ...input, disabledDomains: ['fi-4'] });
    expect(fileClient.candidates).toHaveBeenCalledWith(['Mother of Learning', ...input.altTitles], '77', ['fi-3'], expect.any(Number));
    expect(result).toEqual({ candidates: [expect.objectContaining({ seriesKey: 'nf:3-42', confidence: 'title_match' })], failedSources: [] });
  });

  it('merges file index series with the engine candidates', async () => {
    const { service, client, lookup } = withFiles({ connection: CONN, allowedSources: ['royalroad.com'] });
    client.search.mockResolvedValue({ hits: [hit('https://rr/big', 'Mother of Learning', 'royalroad.com')], failedSources: [] });
    lookup.findMatch.mockResolvedValue({ id: '77' });
    const result = await service.find(input);
    expect(result.candidates.map((entry) => entry.seriesKey).sort()).toEqual(['n:id-big', 'nf:3-42']);
  });
});
