import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CoverService } from '../cover/cover.service';
import { MonitoredCoverService, selectCacheEvictions } from './monitored-cover.service';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, utimes: vi.fn(actual.utimes) };
});

describe('MonitoredCoverService', () => {
  let dir: string;
  let proxyImage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = await mkdtemp(join(tmpdir(), 'monitored-covers-test-'));
    proxyImage = vi.fn();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeService(): MonitoredCoverService {
    const coverService = { proxyImage } as unknown as CoverService;
    return new MonitoredCoverService(coverService, { appDataPath: dir, bookDockPath: join(dir, 'book-dock'), libraryBrowseRoot: '/' });
  }

  function pngFixture(): Promise<Buffer> {
    return sharp({ create: { width: 20, height: 30, channels: 3, background: '#336699' } })
      .png()
      .toBuffer();
  }

  async function cachedFiles(): Promise<string[]> {
    return readdir(join(dir, 'monitored-covers')).catch(() => []);
  }

  it('fetches, resizes to jpeg, and caches on first request; serves from disk afterwards', async () => {
    proxyImage.mockResolvedValue({ buffer: await pngFixture(), contentType: 'image/png' });
    const service = makeService();

    const first = await service.getCover('https://assets.hardcover.app/a.png', 1);
    expect(first.contentType).toBe('image/jpeg');
    expect(proxyImage).toHaveBeenCalledTimes(1);
    expect(await cachedFiles()).toHaveLength(1);

    const second = await service.getCover('https://assets.hardcover.app/a.png', 1);
    expect(second.contentType).toBe('image/jpeg');
    expect(second.buffer.equals(first.buffer)).toBe(true);
    expect(proxyImage).toHaveBeenCalledTimes(1);
  });

  it('updates the cache file timestamps after a cache hit', async () => {
    proxyImage.mockResolvedValue({ buffer: await pngFixture(), contentType: 'image/png' });
    const service = makeService();
    await service.getCover('https://assets.hardcover.app/touched.png', 1);
    vi.mocked(utimes).mockClear();

    await service.getCover('https://assets.hardcover.app/touched.png', 1);

    expect(utimes).toHaveBeenCalledOnce();
    expect(utimes).toHaveBeenCalledWith(expect.stringMatching(/\.jpg$/), expect.any(Date), expect.any(Date));
  });

  it('serves a cache hit when updating its timestamps fails', async () => {
    proxyImage.mockResolvedValue({ buffer: await pngFixture(), contentType: 'image/png' });
    const service = makeService();
    const first = await service.getCover('https://assets.hardcover.app/touch-failure.png', 1);
    const warn = vi.spyOn(Reflect.get(service, 'logger') as { warn: (message: string) => void }, 'warn');
    vi.mocked(utimes).mockRejectedValueOnce(new Error('touch failed'));

    const second = await service.getCover('https://assets.hardcover.app/touch-failure.png', 1);

    expect(second.buffer.equals(first.buffer)).toBe(true);
    expect(second.contentType).toBe('image/jpeg');
    expect(proxyImage).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[monitored.cover_cache.touch] [fail]'));
  });

  it('dedupes concurrent requests for the same url into one upstream fetch', async () => {
    let release!: (value: { buffer: Buffer; contentType: string }) => void;
    proxyImage.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const service = makeService();

    const a = service.getCover('https://assets.hardcover.app/b.png', 1);
    const b = service.getCover('https://assets.hardcover.app/b.png', 1);
    release({ buffer: await pngFixture(), contentType: 'image/png' });

    const [resultA, resultB] = await Promise.all([a, b]);
    expect(proxyImage).toHaveBeenCalledTimes(1);
    expect(resultA.buffer.equals(resultB.buffer)).toBe(true);
  });

  it('caches distinct urls under distinct keys', async () => {
    proxyImage.mockResolvedValue({ buffer: await pngFixture(), contentType: 'image/png' });
    const service = makeService();

    await service.getCover('https://assets.hardcover.app/one.png', 1);
    await service.getCover('https://assets.hardcover.app/two.png', 1);
    expect(proxyImage).toHaveBeenCalledTimes(2);
    expect(await cachedFiles()).toHaveLength(2);
  });

  it('serves the original bytes uncached when the image cannot be decoded', async () => {
    const junk = Buffer.from('not an image');
    proxyImage.mockResolvedValue({ buffer: junk, contentType: 'image/png' });
    const service = makeService();

    const result = await service.getCover('https://assets.hardcover.app/c.png', 1);
    expect(result.buffer.equals(junk)).toBe(true);
    expect(result.contentType).toBe('image/png');
    expect(await cachedFiles()).toHaveLength(0);

    // Not pinned: the next request retries the fetch.
    await service.getCover('https://assets.hardcover.app/c.png', 1);
    expect(proxyImage).toHaveBeenCalledTimes(2);
  });

  it('propagates upstream fetch failures', async () => {
    proxyImage.mockRejectedValue(new Error('boom'));
    const service = makeService();

    await expect(service.getCover('https://assets.hardcover.app/d.png', 1)).rejects.toThrow('boom');
    expect(await cachedFiles()).toHaveLength(0);
  });

  it('evicts the least recently touched files down to 4500 with a stable path tiebreak', () => {
    const entries = Array.from({ length: 5001 }, (_, index) => ({
      path: String(index).padStart(4, '0'),
      mtimeMs: index + 2,
    }));
    entries[0].mtimeMs = 1;
    entries[1].mtimeMs = 1;

    const removals = selectCacheEvictions(entries);

    expect(removals).toHaveLength(501);
    expect(removals.slice(0, 2).map((entry) => entry.path)).toEqual(['0000', '0001']);
  });

  it('rejects cover URLs from hosts outside the provider allowlist before fetching', async () => {
    const service = makeService();

    await expect(service.getCover('https://attacker.example/cover.jpg', 1)).rejects.toMatchObject({ status: 400 });
    expect(proxyImage).not.toHaveBeenCalled();
  });

  it('removes stale temporary cache files while preserving recent ones', async () => {
    const cacheDir = join(dir, 'monitored-covers');
    await mkdir(cacheDir, { recursive: true });
    const stale = join(cacheDir, 'stale.tmp');
    const recent = join(cacheDir, 'recent.tmp');
    await Promise.all([writeFile(stale, 'stale'), writeFile(recent, 'recent')]);
    const old = new Date(Date.now() - 61 * 60 * 1000);
    await utimes(stale, old, old);
    const service = makeService();

    await Reflect.apply((service as unknown as { sweepCache: () => Promise<void> }).sweepCache, service, []);

    expect(await cachedFiles()).toEqual(['recent.tmp']);
  });

  it('limits each user to 30 upstream cover cache misses per minute while keeping cache hits free', async () => {
    proxyImage.mockResolvedValue({ buffer: await pngFixture(), contentType: 'image/png' });
    const service = makeService();

    for (let index = 0; index < 30; index += 1) {
      await service.getCover(`https://assets.hardcover.app/${index}.jpg`, 1);
    }

    await expect(service.getCover('https://assets.hardcover.app/0.jpg', 1)).resolves.toMatchObject({ contentType: 'image/jpeg' });
    await expect(service.getCover('https://assets.hardcover.app/blocked.jpg', 1)).rejects.toMatchObject({ status: 429 });
    expect(proxyImage).toHaveBeenCalledTimes(30);
  });
});
