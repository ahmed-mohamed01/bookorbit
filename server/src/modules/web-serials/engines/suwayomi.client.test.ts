/* eslint-disable @typescript-eslint/require-await */
import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { safeFetch } from '../../../common/utils/safe-fetch';
import { sequenceKey } from '../web-serials-selection.utils';
import { EngineCredentialsRejectedException } from './engine-http.utils';
import { classifyFailure } from '../web-serials-failure.utils';
import { DOWNLOADER_STOPPED_REASON, parseVolume, SuwayomiClient } from './suwayomi.client';
import type { EngineUnitSpec } from './web-serial-engine';

vi.mock('../../../common/utils/safe-fetch', () => ({ safeFetch: vi.fn() }));
vi.mock('../../../common/utils/self-hosted-service-url.utils', () => ({
  ensureSafeSelfHostedUrl: vi.fn().mockResolvedValue(undefined),
  selfHostedSafeRemoteHostOptions: vi.fn().mockReturnValue({}),
}));

import { BASIC, conn, gql, installGraphql } from '../../../../test/support/web-serials/suwayomi-test-support';

const sources = [
  { id: '0', name: 'Local source', lang: 'localsourcelang', displayName: 'Local source', isNsfw: false },
  { id: '4215511432986138970', name: 'Mangabat', lang: 'en', displayName: 'Mangabat (EN)', isNsfw: false },
  { id: '2431307934077353736', name: 'NovelCool', lang: 'pt-BR', displayName: 'NovelCool (PT-BR)', isNsfw: false },
  { id: '438359803442833644', name: 'NovelCool', lang: 'es', displayName: 'NovelCool (ES)', isNsfw: false },
];

beforeEach(() => {
  vi.mocked(safeFetch).mockReset();
});

describe('SuwayomiClient listSources', () => {
  it('lists installed sources without the local source', async () => {
    const calls = installGraphql(() => gql({ sources: { nodes: sources } }));

    const result = await new SuwayomiClient().listSources(conn);

    expect(result.map((source) => source.id)).toEqual(['4215511432986138970', '2431307934077353736', '438359803442833644']);
    expect(result[0]).toEqual({ id: '4215511432986138970', name: 'Mangabat (EN)', lang: 'en', nsfw: false });
    expect(calls[0].headers.Authorization).toBe(BASIC);
  });

  it('fails when the engine rejects the request', async () => {
    installGraphql(() => new Response('{}', { status: 401 }));
    await expect(new SuwayomiClient().listSources(conn)).rejects.toThrow();
  });
});

describe('SuwayomiClient health', () => {
  it('reports the version and counts sources in the allowed languages case-insensitively', async () => {
    const calls = installGraphql(() => gql({ aboutServer: { name: 'Suwayomi', version: 'v2.4.2366' }, sources: { nodes: sources } }));

    const health = await new SuwayomiClient().health(conn, ['EN', 'pt-br']);

    expect(health).toMatchObject({ ok: true, version: 'v2.4.2366', searchableSources: 2, error: null });
    expect(calls[0].headers.Authorization).toBe(BASIC);
    expect(calls[0].path).toBe('/api/graphql');
  });

  it('matches the base language of a regional source', async () => {
    installGraphql(() => gql({ aboutServer: { version: 'v1' }, sources: { nodes: sources } }));
    const health = await new SuwayomiClient().health(conn, ['pt']);
    expect(health.searchableSources).toBe(1);
  });

  it('never counts the local source', async () => {
    installGraphql(() => gql({ aboutServer: { version: 'v1' }, sources: { nodes: sources } }));
    const health = await new SuwayomiClient().health(conn, ['localsourcelang']);
    expect(health.searchableSources).toBe(0);
  });

  it('counts only the picked source ids, ignoring languages', async () => {
    installGraphql(() => gql({ aboutServer: { version: 'v1' }, sources: { nodes: sources } }));
    const health = await new SuwayomiClient().health(conn, ['source:4215511432986138970', 'source:0']);
    expect(health.searchableSources).toBe(1);
  });

  it('counts nothing for an empty selection', async () => {
    installGraphql(() => gql({ aboutServer: { version: 'v1' }, sources: { nodes: sources } }));
    expect((await new SuwayomiClient().health(conn, [])).searchableSources).toBe(0);
  });

  it('returns a failed health instead of throwing', async () => {
    vi.mocked(safeFetch).mockResolvedValue(new Response('', { status: 401 }));
    const health = await new SuwayomiClient().health(conn, ['en']);
    expect(health).toMatchObject({ ok: false, version: null, searchableSources: 0 });
    expect(health.error).toContain('credentials');
  });

  it('fails on GraphQL errors', async () => {
    vi.mocked(safeFetch).mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ message: 'nope' }] }), { headers: { 'content-type': 'application/json' } }),
    );
    expect((await new SuwayomiClient().health(conn, ['en'])).ok).toBe(false);
  });
});

describe('SuwayomiClient search', () => {
  it('searches exactly the picked source ids regardless of language', async () => {
    const searched: string[] = [];
    installGraphql((query) => {
      if (query.includes('BookOrbitSources')) return gql({ sources: { nodes: sources } });
      searched.push(/source: "(\d+)"/.exec(query)![1]);
      return gql({ fetchSourceManga: { hasNextPage: false, mangas: [] } });
    });

    await new SuwayomiClient().search(conn, 'x', ['source:438359803442833644']);

    expect(searched).toEqual(['438359803442833644']);
  });

  it('searches only allowed sources and reports failing ones', async () => {
    const searched: string[] = [];
    installGraphql((query) => {
      if (query.includes('BookOrbitSources')) return gql({ sources: { nodes: sources } });
      const source = /source: "(\d+)"/.exec(query)![1];
      searched.push(source);
      if (source === '2431307934077353736') return new Response('', { status: 500 });
      return gql({
        fetchSourceManga: {
          hasNextPage: false,
          mangas: [
            { id: 56, title: 'One Piece', author: null, thumbnailUrl: '/api/v1/manga/56/thumbnail', status: 'UNKNOWN', url: '/manga/one-piece' },
            { id: 57, title: 'One Piece Party', author: 'Oda', thumbnailUrl: null, status: 'ONGOING', url: '/x' },
          ],
        },
      });
    });

    const result = await new SuwayomiClient().search(conn, 'one "piece"', ['en', 'pt-BR']);

    expect(searched.sort()).toEqual(['2431307934077353736', '4215511432986138970']);
    expect(result.failedSources).toEqual(['NovelCool (PT-BR)']);
    expect(result.hits).toEqual([
      {
        remoteId: '56',
        url: null,
        title: 'One Piece',
        author: null,
        remoteCoverPath: '/api/v1/manga/56/thumbnail',
        sourceName: 'Mangabat (EN)',
        chapterCount: null,
        status: 'unknown',
      },
      {
        remoteId: '57',
        url: null,
        title: 'One Piece Party',
        author: 'Oda',
        remoteCoverPath: null,
        sourceName: 'Mangabat (EN)',
        chapterCount: null,
        status: 'ongoing',
      },
    ]);
  });

  it('escapes the query so it cannot break out of the GraphQL string', async () => {
    const queries: string[] = [];
    installGraphql((query) => {
      if (query.includes('BookOrbitSources')) return gql({ sources: { nodes: sources } });
      queries.push(query);
      return gql({ fetchSourceManga: { mangas: [], hasNextPage: false } });
    });
    await new SuwayomiClient().search(conn, 'a" } mutation { x', ['en']);
    expect(queries[0]).toContain('query: "a\\" } mutation { x"');
  });

  it('runs at most four sources at once', async () => {
    const many = Array.from({ length: 10 }, (_, index) => ({ ...sources[1], id: String(index + 1), displayName: `S${index}` }));
    let active = 0;
    let peak = 0;
    vi.mocked(safeFetch).mockImplementation(async (_url, init) => {
      const query = JSON.parse(init?.body as string).query as string;
      if (query.includes('BookOrbitSources')) return gql({ sources: { nodes: many } });
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return gql({ fetchSourceManga: { mangas: [], hasNextPage: false } });
    });
    await new SuwayomiClient().search(conn, 'x', ['en']);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });
});

describe('SuwayomiClient resolveUrl', () => {
  it('does not resolve links', async () => {
    await expect(new SuwayomiClient().resolveUrl()).resolves.toBeNull();
  });
});

describe('SuwayomiClient getSeries', () => {
  const manga = {
    id: 56,
    title: 'One Piece',
    author: 'Oda',
    artist: 'Oda',
    description: 'Pirates',
    genre: ['Action'],
    status: 'ONGOING',
    thumbnailUrl: '/api/v1/manga/56/thumbnail',
    realUrl: 'https://src.example/one-piece',
    source: { id: '4215511432986138970', displayName: 'Mangabat (EN)', lang: 'en' },
  };
  const chapter = (id: number, chapterNumber: number, sourceOrder: number, uploadDate = '1741288583000', name = `Chapter ${chapterNumber}`) => ({
    id,
    name,
    chapterNumber,
    uploadDate,
    sourceOrder,
    scanlator: null as string | null,
    isDownloaded: false,
    pageCount: 0,
  });
  const seriesOf = async (chapters: ReturnType<typeof chapter>[]) => {
    installGraphql(() => gql({ fetchMangaAndChapters: { manga, chapters } }));
    return new SuwayomiClient().getSeries(conn, '56');
  };

  it('maps the manga and orders chapters oldest first by number', async () => {
    const calls = installGraphql(() =>
      gql({
        fetchMangaAndChapters: {
          manga,
          chapters: [chapter(3, 2, 3, '1741288583000'), chapter(1, 0, 1, '0'), chapter(2, 1.5, 2, '1782461580000'), chapter(4, 0.1, 9, 'bad')],
        },
      }),
    );

    const series = await new SuwayomiClient().getSeries(conn, '56');

    expect(calls[0].query).toContain('id: 56');
    expect(series).toMatchObject({
      kind: 'manga',
      title: 'One Piece',
      author: 'Oda',
      authors: ['Oda'],
      artists: ['Oda'],
      sourceId: '4215511432986138970',
      synopsis: 'Pirates',
      tags: ['Action'],
      language: 'en',
      sourceName: 'Mangabat (EN)',
      sourceUrl: 'https://src.example/one-piece',
      status: 'ongoing',
      chapterCount: 4,
      remoteCoverPath: '/api/v1/manga/56/thumbnail',
      packagingOptions: ['chapter', 'volume', 'series'],
      defaultPackaging: 'chapter',
    });
    expect(series.units.map((unit) => unit.sequence)).toEqual(['0', '0.1', '1.5', '2']);
    expect(series.units.map((unit) => unit.unitKey)).toEqual(['1', '4', '2', '3']);
    expect(series.units[3]).toMatchObject({
      label: 'Chapter 2',
      chapterCount: 1,
      packaging: 'chapter',
      publishedAt: new Date(1741288583000).toISOString(),
      remote: { chapterId: '3', mangaId: '56', scanlator: null },
    });
    expect(series.units[0].publishedAt).toBeNull();
    expect(series.units[1].publishedAt).toBeNull();
  });

  it('keeps the artist out of the authors', async () => {
    installGraphql(() => gql({ fetchMangaAndChapters: { manga: { ...manga, author: 'Writer', artist: 'Drawer' }, chapters: [chapter(1, 1, 1)] } }));
    const series = await new SuwayomiClient().getSeries(conn, '56');
    expect(series.authors).toEqual(['Writer']);
    expect(series.artists).toEqual(['Drawer']);
  });

  it('gives chapters without a number a sequence that cannot equal a real chapter number', async () => {
    const series = await seriesOf([
      chapter(1, 10, 1),
      chapter(2, 11, 2),
      chapter(3, -1, 3, '1741288583000', 'Extra'),
      chapter(4, 12, 4),
      chapter(5, -1, 5, '1741288583000', 'Oneshot'),
    ]);
    const sequences = series.units.map((unit) => unit.sequence);
    expect(sequences).toEqual(['10', '11', '11.001', '12', '12.001']);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(series.units.find((unit) => unit.label === 'Extra')?.remote['sequence']).toBe('11.001');
  });

  it('orders the same way whichever direction the source numbers its chapters', async () => {
    const series = await seriesOf([
      chapter(1, 10, 5),
      chapter(2, 11, 4),
      chapter(3, -1, 3, '1741288583000', 'Extra'),
      chapter(4, 12, 2),
      chapter(5, 13, 1),
    ]);
    expect(series.units.map((unit) => unit.sequence)).toEqual(['10', '11', '11.001', '12', '13']);
  });

  it('keeps unnumbered chapters unique when the source lists several next to one number', async () => {
    const series = await seriesOf([
      chapter(1, -1, 1, '1', 'Prologue'),
      chapter(2, 0, 2),
      chapter(3, -1, 3, '1', 'Omake A'),
      chapter(4, -1, 4, '1', 'Omake B'),
    ]);
    expect(series.units.map((unit) => unit.sequence)).toEqual(['0', '0.001', '0.002', '0.003']);
    expect(series.units.map((unit) => unit.label)).toEqual(['Chapter 0', 'Prologue', 'Omake A', 'Omake B']);
  });

  it('never gives an unnumbered chapter a sequence another chapter already has', async () => {
    const extras = Array.from({ length: 1001 }, (_, index) => chapter(100 + index, -1, 2 + index, '1', 'Extra'));
    const series = await seriesOf([chapter(1, 10, 0), chapter(2, 10.1, 1), ...extras]);
    const keys = series.units.map((unit) => sequenceKey(unit.sequence));
    expect(new Set(keys).size).toBe(keys.length);
    expect(series.units.filter((unit) => sequenceKey(unit.sequence) === '10.1')).toHaveLength(1);
  });

  describe('misnumbered extras', () => {
    const volumeChapters = (count: number, perVolume = 5) =>
      Array.from({ length: count }, (_, index) => {
        const number = index + 1;
        return chapter(number, number, number, '1', `Vol.${Math.ceil(number / perVolume)} Ch.${String(number).padStart(3, '0')}`);
      });
    const unitsOf = async (chapters: ReturnType<typeof chapter>[]) => (await seriesOf(chapters)).units;

    it('files extras whose volume contradicts their number by source order, without a volume', async () => {
      const units = await unitsOf([
        ...volumeChapters(12),
        chapter(101, 1.1, 13, '1', 'Vol.69 Ch.001.1'),
        chapter(102, 1.2, 14, '1', 'Vol.69 Ch.001.2'),
        chapter(103, 2.3, 15, '1', 'Vol.98 Ch.002.3'),
      ]);
      expect(units.map((unit) => unit.sequence)).toEqual([
        '1',
        '2',
        '3',
        '4',
        '5',
        '6',
        '7',
        '8',
        '9',
        '10',
        '11',
        '12',
        '12.001',
        '12.002',
        '12.003',
      ]);
      expect(units.slice(-3).map((unit) => unit.label)).toEqual(['Vol.69 Ch.001.1', 'Vol.69 Ch.001.2', 'Vol.98 Ch.002.3']);
      expect(units.slice(-3).map((unit) => unit.volume)).toEqual([null, null, null]);
      expect(units[0]?.volume).toBe('1');
    });

    it('keeps the volume when the source posted the extra among that volume', async () => {
      const units = await unitsOf([
        ...volumeChapters(25),
        chapter(101, 20.5, 7.5, '1', 'Vol.2 Ch.020.5'),
        chapter(102, 12.5, 20.5, '1', 'Vol.9 Ch.012.5'),
      ]);
      expect(units.find((unit) => unit.unitKey === '101')).toMatchObject({ sequence: '7.001', volume: '2' });
      expect(units.find((unit) => unit.unitKey === '102')).toMatchObject({ sequence: '20.001', volume: null });
    });

    it('leaves an honest fractional chapter inside its volume alone', async () => {
      const units = await unitsOf([...volumeChapters(12), chapter(101, 2.5, 13, '1', 'Vol.1 Ch.002.5')]);
      const half = units.find((unit) => unit.unitKey === '101');
      expect(half).toMatchObject({ sequence: '2.5', volume: '1' });
      expect(units.map((unit) => unit.unitKey).slice(0, 4)).toEqual(['1', '2', '101', '3']);
    });

    it('changes nothing when too few chapters carry volume labels', async () => {
      const units = await unitsOf([...volumeChapters(5), chapter(101, 1.1, 6, '1', 'Vol.69 Ch.001.1'), chapter(102, 2.3, 7, '1', 'Vol.98 Ch.002.3')]);
      expect(units.map((unit) => unit.sequence)).toEqual(['1', '1.1', '2', '2.3', '3', '4', '5']);
      expect(units.find((unit) => unit.unitKey === '101')?.volume).toBe('69');
    });

    it('never produces colliding sequences', async () => {
      const units = await unitsOf([
        ...volumeChapters(20),
        ...Array.from({ length: 30 }, (_, index) => chapter(200 + index, 1 + index / 10, 21 + index, '1', `Vol.${90 + (index % 3)} Ch.${index}`)),
      ]);
      const keys = units.map((unit) => sequenceKey(unit.sequence));
      expect(new Set(keys).size).toBe(keys.length);
    });
  });

  it('collapses duplicate scanlator releases of one chapter to the newest', async () => {
    const series = await seriesOf([
      { ...chapter(1, 5, 1, '1000'), scanlator: 'Old Group' },
      { ...chapter(2, 5, 2, '9000'), scanlator: 'New Group' },
      chapter(3, 6, 3),
    ]);
    expect(series.units.map((unit) => unit.unitKey)).toEqual(['2', '3']);
    expect(series.chapterCount).toBe(2);
  });

  it('rejects a non-numeric id before touching the engine', async () => {
    const calls = installGraphql(() => gql({}));
    await expect(new SuwayomiClient().getSeries(conn, '1) { x } #')).rejects.toBeInstanceOf(BadRequestException);
    expect(calls).toHaveLength(0);
  });
});

describe('parseVolume', () => {
  it.each([
    ['Vol.3 Ch.25', '3'],
    ['Vol. 3 Chapter 25', '3'],
    ['Volume 3 - Chapter 25', '3'],
    ['Volume 3.5: Ch. 25', '3.5'],
    ['Chapter 25', null],
    ['Vol.0 Ch.134', null],
    ['Vol.2, Ch.10', '2'],
    ['Vol.2_Ch.10', '2'],
    ['Vol.2|Ch.10', '2'],
    ['Vol.2.Ch.10', '2'],
    ['(Vol.4)', '4'],
    ['Vol.12', '12'],
  ])('parses %s', (name, expected) => {
    expect(parseVolume(name)).toBe(expected);
  });
});

describe('SuwayomiClient units', () => {
  const unit: EngineUnitSpec = {
    unitKey: '3',
    label: 'Chapter 2',
    sequence: '2',
    chapterCount: 1,
    publishedAt: null,
    packaging: 'chapter',
    remote: { chapterId: '3', mangaId: '56' },
  };

  it('enqueues the chapter and starts the downloader', async () => {
    const calls = installGraphql(() => gql({ enqueue: { downloadStatus: { state: 'STARTED' } }, start: { downloadStatus: { state: 'STARTED' } } }));
    const handle = await new SuwayomiClient().startUnit(conn, '56', unit);
    expect(calls[0].query).toContain('enqueueChapterDownloads(input: { ids: [3] })');
    expect(calls[0].query).toContain('startDownloader');
    expect(handle).toEqual({ unitKey: '3', remote: { mangaId: '56', chapterId: '3' } });
  });

  it('refuses non-chapter packaging', async () => {
    await expect(new SuwayomiClient().startUnit(conn, '56', { ...unit, packaging: 'volume' })).rejects.toBeInstanceOf(BadRequestException);
  });

  const handle = { unitKey: '3', remote: { mangaId: '56', chapterId: '3' } };
  const status = (chapter: unknown, queue: unknown[]) => gql({ chapter, downloadStatus: { state: 'STARTED', queue } });

  it.each([
    ['downloaded', status({ id: '3', isDownloaded: true }, []), { state: 'done' }],
    ['not in the queue yet', status({ id: '3', isDownloaded: false }, []), { state: 'pending', progress: null }],
    [
      'queued',
      status({ id: '3', isDownloaded: false }, [{ state: 'QUEUED', progress: 0, tries: 0, chapter: { id: 3 } }]),
      { state: 'pending', progress: 0 },
    ],
    [
      'downloading',
      status({ id: '3', isDownloaded: false }, [{ state: 'DOWNLOADING', progress: 0.4, tries: 0, chapter: { id: 3 } }]),
      { state: 'running', progress: 0.4 },
    ],
    [
      'errored',
      status({ id: '3', isDownloaded: false }, [{ state: 'ERROR', progress: 0, tries: 3, chapter: { id: 3 } }]),
      { state: 'failed', reason: 'The chapter download failed' },
    ],
    [
      'other chapters in the queue',
      status({ id: '3', isDownloaded: false }, [{ state: 'DOWNLOADING', progress: 0.9, tries: 0, chapter: { id: 4 } }]),
      { state: 'pending', progress: null },
    ],
  ])('polls a chapter that is %s', async (_name, response, expected) => {
    const calls = installGraphql((query) =>
      query.includes('enqueueChapterDownloads')
        ? gql({ enqueue: { downloadStatus: { state: 'STARTED' } }, start: { downloadStatus: { state: 'STARTED' } } })
        : response,
    );
    await expect(new SuwayomiClient().pollUnit(conn, handle)).resolves.toEqual(expected);
    const requeued = calls.some((call) => call.query.includes('enqueueChapterDownloads'));
    expect(requeued).toBe(expected.state === 'pending' && 'progress' in expected && expected.progress === null);
  });

  it('starts a stopped downloader again while the chapter waits, and gives up after about two minutes', async () => {
    const stopped = () =>
      gql({
        chapter: { id: '3', isDownloaded: false },
        downloadStatus: { state: 'STOPPED', queue: [{ state: 'QUEUED', progress: 0, tries: 0, chapter: { id: 3 } }] },
      });
    const calls = installGraphql((query) =>
      query.includes('startDownloader') ? gql({ startDownloader: { downloadStatus: { state: 'STARTED' } } }) : stopped(),
    );
    const waiting = { unitKey: '3', remote: { mangaId: '56', chapterId: '3' } as Record<string, unknown> };
    const client = new SuwayomiClient();

    await expect(client.pollUnit(conn, waiting)).resolves.toEqual({ state: 'pending', progress: 0 });
    expect(calls.filter((call) => call.query.includes('BookOrbitStartDownloader'))).toHaveLength(1);
    for (let poll = 1; poll < 24; poll += 1) await client.pollUnit(conn, waiting);
    const last = await client.pollUnit(conn, waiting);

    expect(last).toEqual({ state: 'failed', reason: DOWNLOADER_STOPPED_REASON });
    expect(classifyFailure(DOWNLOADER_STOPPED_REASON)).toBe('engine_unreachable');
  });

  it('counts stopped polls afresh for a handle loaded again on resume, and never stores the count in the handle', async () => {
    const stopped = () =>
      gql({
        chapter: { id: '3', isDownloaded: false },
        downloadStatus: { state: 'STOPPED', queue: [{ state: 'QUEUED', progress: 0, tries: 0, chapter: { id: 3 } }] },
      });
    installGraphql((query) => (query.includes('startDownloader') ? gql({ startDownloader: { downloadStatus: { state: 'STARTED' } } }) : stopped()));
    const waiting = { unitKey: '3', remote: { mangaId: '56', chapterId: '3' } as Record<string, unknown> };
    const client = new SuwayomiClient();
    for (let poll = 0; poll < 24; poll += 1) await client.pollUnit(conn, waiting);

    const resumed = { unitKey: '3', remote: JSON.parse(JSON.stringify(waiting.remote)) as Record<string, unknown> };

    expect(resumed.remote).toEqual({ mangaId: '56', chapterId: '3' });
    await expect(client.pollUnit(conn, resumed)).resolves.toEqual({ state: 'pending', progress: 0 });
  });

  it('dequeues on cancel and swallows errors', async () => {
    const calls = installGraphql(() => gql({ dequeueChapterDownloads: { downloadStatus: { state: 'STARTED' } } }));
    await new SuwayomiClient().cancelUnit(conn, handle);
    expect(calls[0].query).toContain('dequeueChapterDownloads(input: { ids: [3] })');

    vi.mocked(safeFetch).mockResolvedValue(new Response('', { status: 500 }));
    await expect(new SuwayomiClient().cancelUnit(conn, handle)).resolves.toBeUndefined();
    await expect(new SuwayomiClient().cancelUnit(conn, { unitKey: 'x', remote: {} })).resolves.toBeUndefined();
  });
});

describe('SuwayomiClient discardUnit', () => {
  it('deletes the downloaded chapters in one batched mutation', async () => {
    const calls = installGraphql(() => gql({ deleteDownloadedChapters: { chapters: [] } }));

    await new SuwayomiClient().discardUnit(conn, [
      { unitKey: '3', remote: { chapterId: '3' } },
      { unitKey: '4', remote: { chapterId: 4 } },
      { unitKey: '3', remote: { chapterId: '3' } },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain('deleteDownloadedChapters(input: { ids: [3, 4] })');
    expect(calls[0].headers.Authorization).toBe(BASIC);
  });

  it('sends nothing when there are no chapters', async () => {
    const calls = installGraphql(() => gql({}));
    await new SuwayomiClient().discardUnit(conn, []);
    expect(calls).toHaveLength(0);
  });

  it('rejects an invalid chapter id and surfaces an engine failure', async () => {
    installGraphql(() => gql({}));
    await expect(new SuwayomiClient().discardUnit(conn, [{ unitKey: 'x', remote: { chapterId: '1; drop' } }])).rejects.toBeInstanceOf(
      BadRequestException,
    );

    vi.mocked(safeFetch).mockResolvedValue(new Response('', { status: 500 }));
    await expect(new SuwayomiClient().discardUnit(conn, [{ unitKey: '3', remote: { chapterId: '3' } }])).rejects.toBeDefined();
  });
});

describe('SuwayomiClient download', () => {
  const handle = { unitKey: '3', remote: { mangaId: '56', chapterId: '3' } };

  it('streams the CBZ', async () => {
    const calls = installGraphql(() => gql({}));
    vi.mocked(safeFetch).mockImplementationOnce(
      async () =>
        new Response('PK-cbz', {
          status: 200,
          headers: {
            'content-type': 'application/zip',
            'content-length': '6',
            'content-disposition': 'attachment; filename="Chapter 2.cbz"',
          },
        }),
    );
    const download = await new SuwayomiClient().download(conn, handle);
    expect(download).toMatchObject({ fileName: 'Chapter 2.cbz', format: 'cbz', size: 6 });
    expect(await new Response(download.stream as ReadableStream).text()).toBe('PK-cbz');
    expect(calls).toHaveLength(0);
  });

  it('sends basic auth to the chapter route', async () => {
    const calls = installGraphql(() => gql({}));
    vi.mocked(safeFetch).mockImplementationOnce(async (rawUrl, init) => {
      calls.push({ method: 'GET', path: new URL(String(rawUrl)).pathname, headers: (init?.headers ?? {}) as Record<string, string>, query: '' });
      return new Response('x', { headers: { 'content-type': 'application/octet-stream' } });
    });
    const download = await new SuwayomiClient().download(conn, handle);
    expect(download.fileName).toBe('3.cbz');
    expect(calls[0].path).toBe('/api/v1/chapter/3/download');
    expect(calls[0].headers.Authorization).toBe(BASIC);
  });

  it('rejects the web UI HTML that unknown routes return with status 200', async () => {
    installGraphql(() => gql({}));
    await expect(new SuwayomiClient().download(conn, handle)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it.each([401, 403])('maps a rejected login (%i) to a credentials error, never a 401 for the BookOrbit user', async (status) => {
    vi.mocked(safeFetch).mockResolvedValue(new Response('', { status }));
    const error = await new SuwayomiClient().download(conn, handle).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EngineCredentialsRejectedException);
    expect((error as EngineCredentialsRejectedException).getStatus()).toBe(502);
  });
});

describe('SuwayomiClient fetchCover', () => {
  it('fetches a relative thumbnail path with basic auth', async () => {
    const calls = installGraphql(() => gql({}));
    vi.mocked(safeFetch).mockImplementationOnce(async (rawUrl, init) => {
      calls.push({ method: 'GET', path: new URL(String(rawUrl)).pathname, headers: (init?.headers ?? {}) as Record<string, string>, query: '' });
      return new Response(Buffer.from('img'), { headers: { 'content-type': 'image/png' } });
    });
    const cover = await new SuwayomiClient().fetchCover(conn, '/api/v1/manga/56/thumbnail');
    expect(cover).toEqual({ body: Buffer.from('img'), contentType: 'image/png' });
    expect(calls[0].path).toBe('/api/v1/manga/56/thumbnail');
    expect(calls[0].headers.Authorization).toBe(BASIC);
  });

  it('accepts an absolute URL on the same origin and refuses other origins', async () => {
    installGraphql(() => gql({}));
    vi.mocked(safeFetch).mockImplementation(async () => new Response('i', { headers: { 'content-type': 'image/png' } }));
    await expect(new SuwayomiClient().fetchCover(conn, 'http://suwayomi:4567/api/v1/manga/1/thumbnail')).resolves.toBeDefined();
    await expect(new SuwayomiClient().fetchCover(conn, 'http://evil.example/x.png')).rejects.toBeInstanceOf(BadRequestException);
    await expect(new SuwayomiClient().fetchCover(conn, 'relative/path')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects non-image responses', async () => {
    vi.mocked(safeFetch).mockResolvedValue(new Response('<html>', { headers: { 'content-type': 'text/html' } }));
    await expect(new SuwayomiClient().fetchCover(conn, '/x')).rejects.toBeInstanceOf(BadGatewayException);
  });
});
