interface CacheEntry<V> {
  value: V;
  expiresAt: number;
  weight: number;
}

/** Insertion-ordered LRU with a TTL and an optional total-weight budget (bytes, for cover images). */
export class BoundedTtlCache<K, V> {
  private readonly entries = new Map<K, CacheEntry<V>>();
  private totalWeight = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly maxWeight = Number.POSITIVE_INFINITY,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.remove(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, weight = 1, ttlMs = this.ttlMs): void {
    if (weight > this.maxWeight) return;
    this.remove(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs, weight });
    this.totalWeight += weight;
    while (this.entries.size > this.maxEntries || this.totalWeight > this.maxWeight) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.remove(oldest.value);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  private remove(key: K): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.totalWeight -= entry.weight;
    this.entries.delete(key);
  }
}
