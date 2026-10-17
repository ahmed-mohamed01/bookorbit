import { Injectable } from '@nestjs/common';

import type { HardcoverSearchBook } from '@bookorbit/types';

/** The per-author fields the palette dedupe reads, kept in the shape the cache holds them. */
export interface HardcoverCachedSearchAuthor {
  id: string;
  name: string;
  booksCount: number | null;
  imageUrl: string | null;
  genres: string[];
}

export interface HardcoverSearchCacheEntry {
  books: HardcoverSearchBook[];
  authors: HardcoverCachedSearchAuthor[];
}

const MAX_ENTRIES = 500;
const TTL_MS = 15 * 60 * 1000;

/**
 * A small bounded LRU over the compacted Hardcover search answer, keyed on the normalized query. It
 * is only a rate-limit shield for a hot palette path, so it stays in memory rather than in the
 * metadata cache. Dedupe is per user and runs after the cache read, so what is cached is what
 * Hardcover said, compacted and deduped by name, never what any one user was shown.
 */
@Injectable()
export class HardcoverSearchCache {
  private readonly entries = new Map<string, { at: number; value: HardcoverSearchCacheEntry }>();
  private readonly inFlight = new Map<string, Promise<HardcoverSearchCacheEntry>>();

  async fetch(key: string, load: () => Promise<HardcoverSearchCacheEntry>): Promise<HardcoverSearchCacheEntry> {
    const cached = this.entries.get(key);
    if (cached) {
      if (Date.now() - cached.at < TTL_MS) {
        // Re-inserting on a hit is what makes the map order track recency for the eviction below.
        this.entries.delete(key);
        this.entries.set(key, cached);
        return cached.value;
      }
      this.entries.delete(key);
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const promise = load()
      .then((value) => {
        this.inFlight.delete(key);
        this.entries.set(key, { at: Date.now(), value });
        this.evict();
        return value;
      })
      .catch((error: unknown) => {
        // A failure is never cached: the next query for it pays for a fresh provider call.
        this.inFlight.delete(key);
        throw error;
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  private evict(): void {
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.entries.delete(oldest.value);
    }
  }
}
