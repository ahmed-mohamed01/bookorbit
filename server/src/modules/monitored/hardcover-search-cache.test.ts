import { describe, expect, it, vi } from 'vitest';

import { HardcoverSearchCache, type HardcoverSearchCacheEntry } from './hardcover-search-cache';

const entry = (title: string): HardcoverSearchCacheEntry => ({
  books: [{ slug: title, title, authorNames: [], seriesName: null, coverUrl: null }],
  authors: [],
});

describe('HardcoverSearchCache', () => {
  it('serves a fresh entry from the map without loading again', async () => {
    const cache = new HardcoverSearchCache();
    const load = vi.fn().mockResolvedValue(entry('mistborn'));

    await cache.fetch('mistborn', load);
    await cache.fetch('mistborn', load);

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('shares one load between concurrent misses for the same key', async () => {
    const cache = new HardcoverSearchCache();
    const load = vi.fn().mockResolvedValue(entry('mistborn'));

    await Promise.all([cache.fetch('mistborn', load), cache.fetch('mistborn', load)]);

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed load', async () => {
    const cache = new HardcoverSearchCache();
    const load = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(entry('mistborn'));

    await expect(cache.fetch('mistborn', load)).rejects.toThrow('down');
    await expect(cache.fetch('mistborn', load)).resolves.toEqual(entry('mistborn'));

    expect(load).toHaveBeenCalledTimes(2);
  });

  it('caches an empty answer, since a failed request throws instead of answering empty', async () => {
    const cache = new HardcoverSearchCache();
    const load = vi.fn().mockResolvedValue({ books: [], authors: [] });

    await cache.fetch('nothing', load);
    await cache.fetch('nothing', load);

    expect(load).toHaveBeenCalledOnce();
  });

  it('reloads once the entry is older than the TTL', async () => {
    vi.useFakeTimers();
    try {
      const cache = new HardcoverSearchCache();
      const load = vi.fn().mockResolvedValue(entry('mistborn'));

      await cache.fetch('mistborn', load);
      vi.setSystemTime(Date.now() + 15 * 60 * 1000);
      await cache.fetch('mistborn', load);

      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps at most 500 entries, evicting the least recently used', async () => {
    const cache = new HardcoverSearchCache();
    const load = vi.fn().mockResolvedValue(entry('reloaded'));

    await cache.fetch('oldest', load);
    for (let index = 0; index < 500; index += 1) await cache.fetch(`key-${index}`, load);

    // The oldest entry is the one the cap evicted, so reading it again is a reload, not a hit.
    await expect(cache.fetch('oldest', load)).resolves.toEqual(entry('reloaded'));
    expect(load).toHaveBeenCalledTimes(502);
  });
});
