import { runWithPriority, runWithSignal, type Priority } from "./fetcher.js";
import type { ServiceError } from "./types.js";

export interface NovelLoadsOptions {
  cacheTtlMs: number;
  failureTtlMs: number;
  maxEntries: number;
  mapError: (error: unknown) => ServiceError;
  now?: () => number;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: ServiceError };

interface Flight<T> {
  promise: Promise<Outcome<T>>;
  detached: boolean;
}

export type NovelLoadResult<T> = { status: "done"; value: T } | { status: "pending" };

export type BackgroundSettled<T> = (outcome: Outcome<T>, durationMs: number) => void;

// A long chapter list can take longer than any HTTP client should wait. A load runs to its own deadline whether or
// not the caller stays, concurrent callers share it, and the finished result (or a background failure) is kept so
// the caller's next attempt gets it at once.
export class NovelLoads<T> {
  private readonly cache = new Map<string, { outcome: Outcome<T>; expiresAt: number }>();
  private readonly flights = new Map<string, Flight<T>>();
  private readonly now: () => number;

  constructor(private readonly options: NovelLoadsOptions) {
    this.now = options.now ?? Date.now;
  }

  async get(
    key: string,
    priority: Priority,
    waitMs: number,
    load: () => Promise<T>,
    onBackgroundSettled?: BackgroundSettled<T>,
  ): Promise<NovelLoadResult<T>> {
    const cached = this.cached(key);
    if (cached) return unwrap(cached);
    const flight = this.flights.get(key) ?? this.start(key, priority, load, onBackgroundSettled);
    const outcome = await withinWait(flight.promise, waitMs);
    if (!outcome) {
      flight.detached = true;
      return { status: "pending" };
    }
    return unwrap(outcome);
  }

  private start(key: string, priority: Priority, load: () => Promise<T>, onBackgroundSettled?: BackgroundSettled<T>): Flight<T> {
    const startedAt = this.now();
    // A fresh signal detaches the load from the request that started it, so a client disconnect does not abort it.
    const promise = runWithSignal(new AbortController().signal, () => runWithPriority(priority, load)).then(
      (value): Outcome<T> => ({ ok: true, value }),
      (error: unknown): Outcome<T> => ({ ok: false, error: this.options.mapError(error) }),
    );
    const flight: Flight<T> = { promise, detached: false };
    this.flights.set(key, flight);
    void promise.then((outcome) => {
      this.flights.delete(key);
      if (outcome.ok) this.store(key, outcome, this.options.cacheTtlMs);
      else if (flight.detached) this.store(key, outcome, this.options.failureTtlMs);
      if (flight.detached) onBackgroundSettled?.(outcome, this.now() - startedAt);
    });
    return flight;
  }

  private cached(key: string): Outcome<T> | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    this.cache.delete(key);
    if (entry.expiresAt <= this.now()) return undefined;
    this.cache.set(key, entry);
    return entry.outcome;
  }

  private store(key: string, outcome: Outcome<T>, ttlMs: number): void {
    this.cache.delete(key);
    this.cache.set(key, { outcome, expiresAt: this.now() + ttlMs });
    for (const oldest of this.cache.keys()) {
      if (this.cache.size <= this.options.maxEntries) break;
      this.cache.delete(oldest);
    }
  }
}

const unwrap = <T>(outcome: Outcome<T>): NovelLoadResult<T> => {
  if (!outcome.ok) throw outcome.error;
  return { status: "done", value: outcome.value };
};

const withinWait = <T>(promise: Promise<T>, waitMs: number): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), waitMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};
