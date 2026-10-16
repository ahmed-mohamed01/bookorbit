/* eslint-disable @typescript-eslint/require-await */
import { BadGatewayException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WebSerialFileIndexFileRow, WebSerialFileIndexRow, WebSerialFileIndexSeriesRow } from '../schema/web-serials.schema';
import { FileIndexClient, fileIndexIds } from './file-index.client';

const fetchFileIndex = vi.hoisted(() => vi.fn());
vi.mock('../file-index/file-index-http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../file-index/file-index-http')>()),
  fetchFileIndex,
}));

const CONN = { url: '', username: null, password: null };

const index: WebSerialFileIndexRow = {
  id: 3,
  name: 'NAS',
  listingUrl: 'https://files.example/books/index.json',
  baseUrl: 'https://files.example/books/',
  format: 'json',
  keyMap: {},
  username: 'reader',
  passwordEnc: 'enc:pw',
  enabled: true,
  refreshHours: 24,
  lastRefreshAt: null,
  lastEtag: null,
  lastModified: null,
  seriesCount: 1,
  fileCount: 2,
  lastError: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const series: WebSerialFileIndexSeriesRow = {
  id: 42,
  indexId: 3,
  folderPath: 'LN/Series #1',
  title: 'Series #1',
  titleKey: 'series 1',
  volumeCount: 2,
  coverPath: 'LN/Series #1/cover.jpg',
  matchId: null,
  lastSeenAt: new Date(),
};

const files: WebSerialFileIndexFileRow[] = [
  {
    id: 8,
    seriesId: 42,
    path: 'LN/Series #1/Series #1 Volume 02.epub',
    name: 'Series #1 Volume 02.epub',
    size: 20,
    volume: 2,
    lastSeenAt: new Date(),
  },
  {
    id: 7,
    seriesId: 42,
    path: 'LN/Series #1/Series #1 Volume 01.epub',
    name: 'Series #1 Volume 01.epub',
    size: 10,
    volume: 1,
    lastSeenAt: new Date(),
  },
];

function build(overrides: Partial<WebSerialFileIndexRow> = {}) {
  const row = { ...index, ...overrides };
  const repo = {
    enabledIndexes: vi.fn(async () => (row.enabled ? [{ id: row.id, name: row.name, baseUrl: row.baseUrl }] : [])),
    searchSeries: vi.fn(async () => [{ ...series, indexName: row.name }]),
    findCandidates: vi.fn(async () => [{ ...series, indexName: row.name }]),
    findSeries: vi.fn(async (indexId: number, seriesId: number) => (indexId === 3 && seriesId === 42 ? { index: row, series } : null)),
    findSeriesIdByFolder: vi.fn(async (_indexId: number, folder: string) => (folder === 'LN/Series #1' ? 42 : null)),
    listSeriesFiles: vi.fn(async () => files),
    findFile: vi.fn(async (_seriesId: number, fileId: number) => files.find((file) => file.id === fileId) ?? null),
    findIndex: vi.fn(async () => row),
  };
  const secrets = { decrypt: vi.fn((value: string) => value.replace(/^enc:/, '')) };
  return { client: new FileIndexClient(repo as never, secrets as never), repo };
}

async function readAll(stream: ReadableStream<Uint8Array> | NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('FileIndexClient', () => {
  beforeEach(() => fetchFileIndex.mockReset());

  it('keeps only file index ids from allowed sources', () => {
    expect(fileIndexIds(['fi-3', 'royalroad.com', 'fi-x', 'fi-12'])).toEqual([3, 12]);
  });

  it('searches its own tables and keys hits by index and series', async () => {
    const { client, repo } = build();
    const result = await client.search(CONN, 'Series #1', ['fi-3', 'other']);
    expect(repo.searchSeries).toHaveBeenCalledWith('series 1', [3]);
    expect(result.hits).toEqual([
      expect.objectContaining({
        remoteId: 'fi-3-42',
        title: 'Series #1',
        sourceName: 'NAS',
        remoteCoverPath: '3|LN/Series #1/cover.jpg',
        chapterCount: null,
      }),
    ]);
  });

  it('builds a volume-only series from the stored files', async () => {
    const { client } = build();
    const loaded = await client.getSeries(CONN, 'fi-3-42');
    expect(loaded).toEqual(
      expect.objectContaining({
        title: 'Series #1',
        sourceName: 'NAS',
        sourceId: 'fi-3',
        sourceUrl: 'https://files.example/books/LN/Series%20%231/',
        packagingOptions: ['volume'],
        chapterCount: 2,
      }),
    );
    expect(loaded.units.map((unit) => unit.unitKey)).toEqual(['volume-1', 'volume-2']);
  });

  it('refuses a series that is gone or whose index is disabled', async () => {
    await expect(build().client.getSeries(CONN, 'fi-3-99')).rejects.toBeInstanceOf(NotFoundException);
    await expect(build({ enabled: false }).client.getSeries(CONN, 'fi-3-42')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('resolves links to a series folder or one of its files', async () => {
    const { client } = build();
    expect(await client.resolveUrl(CONN, 'https://files.example/books/LN/Series%20%231/')).toEqual({ kind: 'novel', remoteId: 'fi-3-42' });
    expect(await client.resolveUrl(CONN, 'https://files.example/books/LN/Series%20%231/Series%20%231%20Volume%2001.epub')).toEqual({
      kind: 'novel',
      remoteId: 'fi-3-42',
    });
    expect(await client.resolveUrl(CONN, 'https://elsewhere.example/LN/Series%20%231/')).toBeNull();
    expect(await client.resolveUrl(CONN, 'not a url')).toBeNull();
  });

  it('streams an EPUB with the index credentials', async () => {
    const { client } = build();
    const body = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('mimetypeapplication/epub+zip')]);
    fetchFileIndex.mockResolvedValueOnce(new Response(body, { status: 200, headers: { 'content-type': 'application/epub+zip' } }));
    const unit = (await client.getSeries(CONN, 'fi-3-42')).units[0]!;
    const handle = await client.startUnit(CONN, 'fi-3-42', unit);
    expect(await client.pollUnit()).toEqual({ state: 'done' });

    const download = await client.download(CONN, handle);

    expect(fetchFileIndex).toHaveBeenCalledWith(
      'https://files.example/books/LN/Series%20%231/Series%20%231%20Volume%2001.epub',
      expect.objectContaining({ authorization: `Basic ${Buffer.from('reader:pw').toString('base64')}` }),
    );
    expect(download).toEqual(expect.objectContaining({ fileName: 'Series #1 Volume 01.epub', format: 'epub' }));
    expect(await readAll(download.stream)).toEqual(body);
  });

  it('fails a download that is not a ZIP or is a web page', async () => {
    const { client } = build();
    const handle = await client.startUnit(CONN, 'fi-3-42', (await client.getSeries(CONN, 'fi-3-42')).units[0]!);

    fetchFileIndex.mockResolvedValueOnce(new Response('%PDF-1.7 not an epub', { status: 200 }));
    const pdf = await client.download(CONN, handle);
    await expect(readAll(pdf.stream)).rejects.toThrow('not an EPUB');

    fetchFileIndex.mockResolvedValueOnce(new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    await expect(client.download(CONN, handle)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('fails a download whose file left the index', async () => {
    const { client, repo } = build();
    const handle = await client.startUnit(CONN, 'fi-3-42', (await client.getSeries(CONN, 'fi-3-42')).units[0]!);
    repo.findFile.mockResolvedValueOnce(null);
    await expect(client.download(CONN, handle)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('fetches the series cover from its index', async () => {
    const { client } = build();
    fetchFileIndex.mockResolvedValueOnce(new Response(Buffer.from([0xff, 0xd8, 0xff]), { status: 200, headers: { 'content-type': 'image/jpeg' } }));
    const cover = await client.fetchCover(CONN, '3|LN/Series #1/cover.jpg');
    expect(fetchFileIndex.mock.calls[0]![0]).toBe('https://files.example/books/LN/Series%20%231/cover.jpg');
    expect(cover.contentType).toBe('image/jpeg');
  });
});
