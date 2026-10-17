import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { novelIndexEntry, novelIndexKey, novelRemoteId, WebSerialsNovelIndexService } from './web-serials-novel-index.service';

vi.mock('./web-serials-settings.service', () => ({ WebSerialsSettingsService: class {} }));
vi.mock('./web-serials-cover.service', () => ({ WebSerialsCoverService: class {} }));

const CONN = { url: 'http://novel-sources:8282', username: null, password: 'token' };
const USER = { id: 7 } as never;

function build(options: { engine?: string; allowed?: string[]; disabled?: string[] } = {}) {
  const repo = {
    getDisabledNovelDomains: vi.fn().mockResolvedValue(options.disabled ?? []),
    listNovelIndexSources: vi.fn().mockResolvedValue([]),
    searchNovelIndex: vi.fn().mockResolvedValue([]),
    suggestNovelIndex: vi.fn().mockResolvedValue([]),
    upsertNovelIndexEntries: vi.fn().mockResolvedValue({ added: 1, updated: 0 }),
    recordNovelIndexDetails: vi.fn().mockResolvedValue(undefined),
    setNovelIndexMatch: vi.fn().mockResolvedValue(undefined),
    findUnmatchedNovelIndexByTitleKeys: vi.fn().mockResolvedValue([]),
    findImportedMatchKeys: vi.fn().mockResolvedValue(new Set<string>()),
    setNovelIndexMatches: vi.fn().mockResolvedValue(0),
    findNovelIndexCandidates: vi.fn().mockResolvedValue([]),
    findNovelIndexByTitleKeys: vi.fn().mockResolvedValue([]),
  };
  const settings = {
    catalogVersion: 1,
    getEngineConfig: vi
      .fn()
      .mockResolvedValue({ connection: CONN, allowedSources: options.allowed ?? ['a', 'b'], engine: options.engine ?? 'lnreader' }),
  };
  const client = {
    listInstalled: vi.fn().mockResolvedValue([
      { id: 'a', name: 'Source A', site: 'https://a.test' },
      { id: 'b', name: 'Source B', site: 'https://b.test' },
    ]),
  };
  const covers = { remember: vi.fn() };
  const service = new WebSerialsNovelIndexService(repo as never, repo as never, settings as never, client as never, covers as never);
  return { service, repo, settings, client, covers };
}

const row = (overrides: Record<string, unknown> = {}) => ({
  sourceId: 'a',
  path: 'novel/orv',
  url: 'https://a.test/novel/orv',
  title: "Omniscient Reader's Viewpoint",
  mtl: false,
  coverUrl: 'https://a.test/orv.jpg',
  matchId: null,
  status: null,
  chapterCount: null,
  ...overrides,
});

afterEach(() => vi.restoreAllMocks());

describe('WebSerialsNovelIndexService', () => {
  it('keys titles like series matching does and encodes paths like the engine', () => {
    expect(novelIndexKey("Omniscient Reader's Viewpoint (MTL)")).toBe('omniscient reader s viewpoint');
    expect(novelRemoteId('a', '/novel/x')).toBe(`a:${Buffer.from('/novel/x').toString('base64url')}`);
  });

  it('only exists for the LNReader engine', async () => {
    await expect(build({ engine: 'lncrawl' }).service.scope()).resolves.toBeNull();
    await expect(build().service.scope()).resolves.toEqual({ connection: CONN, enabledSourceIds: ['a', 'b'] });
  });

  it('maps index rows to engine hits with source names and remembers their covers', async () => {
    const { service, repo, covers } = build();
    repo.searchNovelIndex.mockResolvedValue([row({ mtl: true, status: 'ongoing', chapterCount: 12 })]);

    const hits = await service.search({ connection: CONN, enabledSourceIds: ['a'] }, 'Omniscient', ['a']);

    expect(repo.searchNovelIndex).toHaveBeenCalledWith('omniscient', ['a']);
    expect(hits).toEqual([
      {
        remoteId: novelRemoteId('a', 'novel/orv'),
        url: 'https://a.test/novel/orv',
        title: "Omniscient Reader's Viewpoint",
        author: null,
        remoteCoverPath: 'https://a.test/orv.jpg',
        sourceName: 'Source A',
        chapterCount: 12,
        status: 'ongoing',
        mtl: true,
      },
    ]);
    expect(covers.remember).toHaveBeenCalledWith(`nl:${novelRemoteId('a', 'novel/orv')}`, 'https://a.test/orv.jpg');
  });

  it('records live hits and opened novels, skipping what it cannot decode, and never throws', async () => {
    const { service, repo } = build();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await service.recordHits([
      { remoteId: novelRemoteId('a', 'novel/x'), url: null, title: 'X [MTL]', remoteCoverPath: null } as never,
      { remoteId: 'legacy-id', url: null, title: 'Y', remoteCoverPath: null } as never,
    ]);
    expect(repo.upsertNovelIndexEntries).toHaveBeenCalledWith([
      { sourceId: 'a', path: 'novel/x', url: null, title: 'X [MTL]', titleKey: 'x', mtl: true, coverUrl: null, author: null },
    ]);

    repo.recordNovelIndexDetails.mockRejectedValue(new Error('db down'));
    await expect(
      service.recordSeries(novelRemoteId('b', 'n/1'), {
        title: 'Y',
        author: ' Sing Shong ',
        sourceUrl: 'u',
        remoteCoverPath: null,
        status: 'completed',
        chapterCount: 4,
      } as never),
    ).resolves.toBeUndefined();
    expect(repo.recordNovelIndexDetails).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 'b', path: 'n/1', status: 'completed', chapterCount: 4, author: 'Sing Shong' }),
    );

    await service.recordMatch(novelRemoteId('b', 'n/1'), '55');
    expect(repo.setNovelIndexMatch).toHaveBeenCalledWith('b', 'n/1', '55');
  });

  it('matches catalog titles lazily only where the entry credits one of the authors, and drops a title two series share', async () => {
    const { service, repo } = build();
    repo.findUnmatchedNovelIndexByTitleKeys.mockResolvedValue([
      { sourceId: 'a', path: 'n/solo', titleKey: 'solo leveling', author: 'Chugong' },
      { sourceId: 'b', path: 'n/other', titleKey: 'only i level up', author: 'Someone Else' },
      { sourceId: 'c', path: 'n/kubo', titleKey: 'water magician', author: 'Kubō Tadashi' },
    ]);

    await service.matchCatalog([
      { id: '1', titles: ['Solo Leveling', 'Only I Level Up', 'Shared'], authors: ['Chugong'] },
      { id: '2', titles: ['Shared!'], authors: ['Someone'] },
      { id: '3', titles: ['Water Magician'], authors: ['Tadashi Kubou'] },
      { id: '4', titles: ['Untitled'], authors: [] },
    ]);

    expect(repo.findUnmatchedNovelIndexByTitleKeys).toHaveBeenCalledWith(['solo leveling', 'only i level up', 'water magician']);
    expect(repo.setNovelIndexMatches).toHaveBeenCalledWith([
      { sourceId: 'a', path: 'n/solo', matchId: '1' },
      { sourceId: 'c', path: 'n/kubo', matchId: '3' },
    ]);
  });

  it('keeps one candidate per source, preferring the matched, non machine translated copy', async () => {
    const { service, repo } = build();
    repo.findNovelIndexCandidates.mockResolvedValue([
      row({ path: 'mtl', mtl: true, matchId: '9' }),
      row({ path: 'good', matchId: '9' }),
      row({ sourceId: 'b', path: 'b1' }),
    ]);

    const found = await service.candidates({ connection: CONN, enabledSourceIds: ['a', 'b'] }, '9', ['ORV', 'orv'], ['a', 'b']);

    expect(repo.findNovelIndexCandidates).toHaveBeenCalledWith('9', ['orv'], ['a', 'b']);
    expect(found.map((entry) => [entry.row.path, entry.matched, entry.hit.sourceName])).toEqual([
      ['good', true, 'Source A'],
      ['b1', false, 'Source B'],
    ]);
    expect(found[0]!.seriesKey).toBe(`nl:${novelRemoteId('a', 'good')}`);
  });

  it('drops a title-only entry whose stored author contradicts the series, keeping matched and authorless ones', async () => {
    const { service, repo } = build();
    repo.findNovelIndexCandidates.mockResolvedValue([
      row({ path: 'ours', matchId: '9', author: 'Someone Else' }),
      row({ sourceId: 'b', path: 'other', author: 'Kim Webtoon', chapterCount: 300 }),
      row({ sourceId: 'c', path: 'same-author', author: 'Sing Shong' }),
      row({ sourceId: 'd', path: 'no-author', author: null }),
    ]);

    const found = await service.candidates(
      { connection: CONN, enabledSourceIds: ['a', 'b', 'c', 'd'] },
      '9',
      ['ORV'],
      ['a', 'b', 'c', 'd'],
      ['singNsong', 'Sing Shong'],
    );

    expect(found.map((entry) => entry.row.path)).toEqual(['ours', 'same-author', 'no-author']);
  });

  it('looks up whole-series entries by base title with and without "the", matched or not, one per source', async () => {
    const { service, repo } = build();
    repo.findNovelIndexByTitleKeys.mockResolvedValue([
      row({ path: 'wm', title: 'Water Magician', matchId: '20' }),
      row({ path: 'wm-mtl', title: 'Water Magician', mtl: true }),
      row({ sourceId: 'b', path: 'the-wm', title: 'The Water Magician' }),
    ]);

    const found = await service.wholeSeriesCandidates({ connection: CONN, enabledSourceIds: ['a', 'b'] }, ['water magician'], ['a', 'b']);

    expect(repo.findNovelIndexByTitleKeys).toHaveBeenCalledWith(['water magician', 'the water magician'], ['a', 'b']);
    expect(found.map((entry) => [entry.row.path, entry.matched, entry.hit.sourceName])).toEqual([
      ['wm', false, 'Source A'],
      ['the-wm', false, 'Source B'],
    ]);
  });

  it('suggests only for two characters or more on the caller’s enabled sources, with a proxied cover', async () => {
    const { service, repo, covers } = build({ disabled: ['b'] });
    repo.suggestNovelIndex.mockResolvedValue([
      {
        matchId: '9',
        title: 'Omniscient Reader',
        mtlOnly: false,
        sourcesCount: 2,
        entries: [
          { sourceId: 'a', path: 'p1', coverUrl: null, mtl: false },
          { sourceId: 'a', path: 'p2', coverUrl: 'https://a.test/c.jpg', mtl: true },
        ],
      },
      { matchId: null, title: 'Omni MTL', mtlOnly: true, sourcesCount: 1, entries: [{ sourceId: 'a', path: 'p3', coverUrl: null, mtl: true }] },
    ]);

    await expect(service.suggest(' o ', USER)).resolves.toEqual({ query: 'o', suggestions: [] });
    expect(repo.suggestNovelIndex).not.toHaveBeenCalled();

    const result = await service.suggest('Omni', USER);
    expect(repo.suggestNovelIndex).toHaveBeenCalledWith('omni', ['a'], 8);
    const p2 = `nl:${novelRemoteId('a', 'p2')}`;
    expect(result.suggestions[0]).toEqual({
      kind: 'novel',
      title: 'Omniscient Reader',
      cover: `/api/v1/web-serials/series/${p2}/cover`,
      sourcesCount: 2,
      mtlOnly: false,
      matchId: '9',
      inLibrary: false,
      entries: [
        { sourceId: 'a', sourceName: 'Source A', path: 'p1', mtl: false, seriesKey: `nl:${novelRemoteId('a', 'p1')}` },
        { sourceId: 'a', sourceName: 'Source A', path: 'p2', mtl: true, seriesKey: p2 },
      ],
    });
    expect(covers.remember).toHaveBeenCalledWith(p2, 'https://a.test/c.jpg');
    expect(result.suggestions[1]).not.toHaveProperty('matchId');
    expect(result.suggestions[1]!.inLibrary).toBe(false);
    expect(result.suggestions[1]!.cover).toBeNull();
  });

  it('marks suggestions this user already imported, in one batched lookup over the match ids', async () => {
    const { service, repo } = build();
    const suggestion = (title: string, matchId: string | null) => ({
      matchId,
      title,
      mtlOnly: false,
      sourcesCount: 1,
      entries: [{ sourceId: 'a', path: title, coverUrl: null, mtl: false }],
    });
    repo.suggestNovelIndex.mockResolvedValue([suggestion('Ours', '9'), suggestion('Also Ours', '9'), suggestion('Unknown', null)]);
    repo.findImportedMatchKeys.mockImplementation((userId: number) =>
      userId === 42 ? Promise.resolve(new Set(['mb:9'])) : Promise.resolve(new Set<string>()),
    );

    const mine = await service.suggest('omni', { id: 42 } as never);

    expect(repo.findImportedMatchKeys).toHaveBeenCalledTimes(1);
    expect(repo.findImportedMatchKeys).toHaveBeenCalledWith(42, ['mb:9']);
    expect(mine.suggestions.map((entry) => [entry.title, entry.inLibrary])).toEqual([
      ['Ours', true],
      ['Also Ours', true],
      ['Unknown', false],
    ]);

    const theirs = await service.suggest('omni', USER);
    expect(repo.findImportedMatchKeys).toHaveBeenLastCalledWith(7, ['mb:9']);
    expect(theirs.suggestions.map((entry) => [entry.title, entry.inLibrary])).toEqual([
      ['Ours', false],
      ['Also Ours', false],
      ['Unknown', false],
    ]);
  });

  it('keeps at most twelve copies per suggestion', async () => {
    const { service, repo } = build();
    const entries = Array.from({ length: 20 }, (_, index) => ({ sourceId: 'a', path: `p${index}`, coverUrl: null, mtl: false }));
    repo.suggestNovelIndex.mockResolvedValue([{ matchId: null, title: 'Many', mtlOnly: false, sourcesCount: 1, entries }]);

    const result = await service.suggest('many', USER);

    expect(result.suggestions[0]!.entries).toHaveLength(12);
  });

  it('searches and suggests only sources the service still has installed', async () => {
    const { service, repo, client } = build({ allowed: ['a', 'b', 'gone'] });
    client.listInstalled.mockResolvedValue([{ id: 'a', name: 'Source A', site: 'https://a.test' }]);

    await service.search({ connection: CONN, enabledSourceIds: ['a', 'b', 'gone'] }, 'Omniscient', ['a', 'gone']);
    await service.suggest('omni', USER);

    expect(repo.searchNovelIndex).toHaveBeenCalledWith('omniscient', ['a']);
    expect(repo.suggestNovelIndex).toHaveBeenCalledWith('omni', ['a'], 8);
  });

  it('skips entries whose link is too long for a series key instead of failing search and suggestions', async () => {
    const { service, repo } = build();
    const long = `novel/${'very-long-light-novel-title-slug-'.repeat(12)}`;
    repo.searchNovelIndex.mockResolvedValue([row({ path: long }), row({ path: 'short' })]);
    repo.suggestNovelIndex.mockResolvedValue([
      { matchId: null, title: 'Long Only', mtlOnly: false, sourcesCount: 1, entries: [{ sourceId: 'a', path: long, coverUrl: null, mtl: false }] },
      {
        matchId: null,
        title: 'Mixed',
        mtlOnly: false,
        sourcesCount: 1,
        entries: [
          { sourceId: 'a', path: long, coverUrl: 'https://a.test/c.jpg', mtl: false },
          { sourceId: 'a', path: 'ok', coverUrl: null, mtl: false },
        ],
      },
    ]);
    repo.findNovelIndexCandidates.mockResolvedValue([row({ path: long, matchId: '9' })]);

    const hits = await service.search({ connection: CONN, enabledSourceIds: ['a'] }, 'Omniscient', ['a']);
    const suggested = await service.suggest('omni', USER);
    const candidates = await service.candidates({ connection: CONN, enabledSourceIds: ['a'] }, '9', ['ORV'], ['a']);

    expect(hits.map((hit) => hit.remoteId)).toEqual([novelRemoteId('a', 'short')]);
    expect(suggested.suggestions.map((entry) => [entry.title, entry.entries.map((copy) => copy.path), entry.cover])).toEqual([
      ['Mixed', ['ok'], null],
    ]);
    expect(candidates).toEqual([]);
    expect(novelIndexEntry('a', long, 'Some Title', null, null)).toBeNull();
  });

  it('suggests nothing on the lightnovel-crawler engine', async () => {
    const { service, repo } = build({ engine: 'lncrawl' });
    await expect(service.suggest('omni', USER)).resolves.toEqual({ query: 'omni', suggestions: [] });
    expect(repo.suggestNovelIndex).not.toHaveBeenCalled();
  });
});
