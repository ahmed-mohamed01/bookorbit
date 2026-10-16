/* eslint-disable @typescript-eslint/require-await */
import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ListingReadResult } from './file-index/file-index-reader';
import type { WebSerialFileIndexRow } from './schema/web-serials.schema';
import { WebSerialsFileIndexService } from './web-serials-file-index.service';

const readListing = vi.hoisted(() => vi.fn());
vi.mock('./file-index/file-index-reader', () => ({ readListing }));
vi.mock('./web-serials-url.utils', () => ({ ensureSafeEngineUrl: vi.fn().mockResolvedValue(undefined) }));

const USER = { id: 7 } as never;

function row(overrides: Partial<WebSerialFileIndexRow> = {}): WebSerialFileIndexRow {
  return {
    id: 1,
    name: 'NAS',
    listingUrl: 'https://files.example/books/index.json',
    baseUrl: 'https://files.example/books/',
    format: 'json',
    keyMap: {},
    username: null,
    passwordEnc: null,
    enabled: true,
    refreshHours: 24,
    lastRefreshAt: null,
    lastEtag: null,
    lastModified: null,
    seriesCount: 0,
    fileCount: 0,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function listing(files: Array<{ path: string; name: string; size?: number }>): ListingReadResult {
  return {
    notModified: false,
    format: 'json',
    pages: 1,
    etag: '"v2"',
    lastModified: null,
    listing: { files: files.map((file) => ({ size: null, ...file })), truncated: false },
  };
}

function build(rows: WebSerialFileIndexRow[] = [row()]) {
  const store = new Map(rows.map((entry) => [entry.id, { ...entry }]));
  const repo = {
    listIndexes: vi.fn(async () => [...store.values()]),
    findIndex: vi.fn(async (id: number) => store.get(id) ?? null),
    createIndex: vi.fn(async (values: Partial<WebSerialFileIndexRow>) => {
      const created = row({ ...values, id: 99 });
      store.set(99, created);
      return created;
    }),
    updateIndex: vi.fn(async (id: number, patch: Partial<WebSerialFileIndexRow>) => {
      const existing = store.get(id);
      if (!existing) return null;
      Object.assign(existing, patch);
      return existing;
    }),
    deleteIndex: vi.fn(async (id: number) => store.delete(id)),
    dueIndexIds: vi.fn(async () =>
      [...store.values()].filter((entry) => entry.enabled && entry.lastRefreshAt === null).map((entry) => ({ id: entry.id })),
    ),
    writeListing: vi.fn(async (_id: number, series: Array<{ files: unknown[] }>) => ({
      series: series.length,
      files: series.reduce((sum, entry) => sum + entry.files.length, 0),
      removedSeries: 0,
      removedFiles: 0,
    })),
  };
  const secrets = { encrypt: vi.fn((value: string) => `enc:${value}`), decrypt: vi.fn((value: string) => value.replace(/^enc:/, '')) };
  const service = new WebSerialsFileIndexService(repo as never, secrets as never);
  return { service, repo, secrets, store };
}

describe('WebSerialsFileIndexService', () => {
  beforeEach(() => {
    readListing.mockReset();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('creates an index with a derived base URL, a detected format and an encrypted password, then refreshes it', async () => {
    const { service, repo } = build([]);
    readListing
      .mockResolvedValueOnce(listing([]))
      .mockResolvedValueOnce(listing([{ path: 'S/S Volume 01.epub', name: 'S Volume 01.epub', size: 5 }]));

    const created = await service.create({ name: ' NAS ', listingUrl: 'https://files.example/books/index.json', password: 'secret ' }, USER);
    await service.tick();

    expect(repo.createIndex).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'NAS', baseUrl: 'https://files.example/books/', format: 'json', passwordEnc: 'enc:secret ' }),
    );
    expect(created).toEqual(expect.objectContaining({ id: 99, hasPassword: true }));
    expect(created).not.toHaveProperty('passwordEnc');
    expect(repo.writeListing).toHaveBeenCalledWith(99, [expect.objectContaining({ folderPath: 'S', title: 'S' })], expect.any(Date));
    expect(repo.updateIndex).toHaveBeenLastCalledWith(
      99,
      expect.objectContaining({ seriesCount: 1, fileCount: 1, lastEtag: '"v2"', lastError: null }),
    );
  });

  it('uses a directory page as its own base URL', async () => {
    const { service, repo } = build([]);
    readListing.mockResolvedValue(listing([]));
    await service.create({ name: 'Dir', listingUrl: 'https://files.example/books', format: 'html' }, USER);
    expect(repo.createIndex).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'https://files.example/books/', format: 'html' }));
  });

  it('records an unchanged listing without rewriting it', async () => {
    const { service, repo } = build([row({ lastEtag: '"v1"' })]);
    readListing.mockResolvedValueOnce({ notModified: true });
    await service.tick();
    expect(readListing.mock.calls[0]![1].validators).toEqual({ etag: '"v1"', lastModified: null });
    expect(repo.writeListing).not.toHaveBeenCalled();
    expect(repo.updateIndex).toHaveBeenCalledWith(1, { lastRefreshAt: expect.any(Date), lastError: null });
  });

  it('keeps the previous listing and records the error when a refresh fails', async () => {
    const { service, repo, store } = build();
    readListing.mockRejectedValueOnce(new BadRequestException('The file index answered with status 404'));
    await service.tick();
    expect(repo.writeListing).not.toHaveBeenCalled();
    expect(store.get(1)!.lastError).toBe('The file index answered with status 404');
    expect(store.get(1)!.lastRefreshAt).toBeInstanceOf(Date);
  });

  it('does not retry an index in the same run when its failure cannot be recorded', async () => {
    const { service, repo } = build();
    readListing.mockRejectedValue(new Error('boom'));
    repo.updateIndex.mockRejectedValue(new Error('db down'));
    await service.tick();
    expect(readListing).toHaveBeenCalledTimes(1);
  });

  it('forgets the validators and refreshes again when the source changes', async () => {
    const { service, repo } = build([row({ lastEtag: '"v1"', lastRefreshAt: new Date() })]);
    readListing.mockResolvedValue(listing([]));
    await service.update(1, { listingUrl: 'https://mirror.example/index.json' }, USER);
    expect(repo.updateIndex).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        listingUrl: 'https://mirror.example/index.json',
        baseUrl: 'https://mirror.example/',
        lastEtag: null,
        lastRefreshAt: null,
      }),
    );
    await service.tick();
    expect(readListing).toHaveBeenCalledTimes(1);
  });

  it('only renames without touching the refresh state', async () => {
    const { service, repo } = build([row({ lastEtag: '"v1"' })]);
    await service.update(1, { name: 'Renamed' }, USER);
    expect(repo.updateIndex).toHaveBeenCalledWith(1, { name: 'Renamed' });
  });

  it('refuses unknown, disabled and busy indexes', async () => {
    const { service } = build([row({ enabled: false })]);
    await expect(service.remove(5, USER)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.refreshNow(1, USER)).rejects.toBeInstanceOf(BadRequestException);

    const busy = build();
    let release!: () => void;
    readListing.mockReturnValueOnce(new Promise((resolve) => (release = () => resolve({ notModified: true }))));
    const running = busy.service.tick();
    await vi.waitFor(() => expect(readListing).toHaveBeenCalled());
    await expect(busy.service.refreshNow(1, USER)).rejects.toBeInstanceOf(ConflictException);
    release();
    await running;
  });

  it('previews a saved index with its stored password and without storing anything', async () => {
    const { service, repo } = build([row({ username: 'reader', passwordEnc: 'enc:pw' })]);
    readListing.mockResolvedValueOnce(
      listing([
        { path: 'Series A/Series A Vol 1.epub', name: 'Series A Vol 1.epub' },
        { path: 'Series A/Series A Vol 1.pdf', name: 'Series A Vol 1.pdf' },
      ]),
    );
    const preview = await service.test({ id: 1 }, USER);
    expect(readListing.mock.calls[0]![0].authorization).toBe(`Basic ${Buffer.from('reader:pw').toString('base64')}`);
    expect(preview).toEqual({
      format: 'json',
      series: 1,
      files: 1,
      skippedFiles: 1,
      truncated: false,
      sample: [{ folderPath: 'Series A', title: 'Series A', volumes: [{ name: 'Series A Vol 1.epub', volume: 1 }] }],
    });
    expect(repo.writeListing).not.toHaveBeenCalled();
  });
});
