import { readFile, rm } from "node:fs/promises";
import { SourceFetcher, currentDeadline, currentPriority, currentSignal } from "./fetcher.js";
import { StorageHub } from "./libs/storage.js";
import { PluginPool } from "./plugin-pool.js";
import type { CallMethod } from "./worker-protocol.js";
import type { NovelItem, NovelPlugin, SourceNovel, SourcePage } from "./types.js";
import { WorkerBudget } from "./worker-budget.js";

const DEFAULT_CALL_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_WORKERS = 4;
export const DEFAULT_WORKER_IDLE_MS = 20_000;
export const DEFAULT_WORKER_HEAP_MB = 160;

export interface PluginHostOptions {
  dataDir: string;
  fetcher: SourceFetcher;
  logger?: Pick<Console, "log" | "warn" | "error">;
  maxWorkersPerSource?: number;
  maxWorkers?: number;
  workerIdleMs?: number;
  workerHeapMb?: number;
  acquireTimeoutMs?: number;
}

export class PluginHost {
  private readonly logger: Pick<Console, "log" | "warn" | "error">;
  private readonly hubs = new Map<string, StorageHub>();
  private readonly pools = new Set<PluginPool>();
  readonly budget: WorkerBudget;

  constructor(private readonly options: PluginHostOptions) {
    this.logger = options.logger ?? console;
    this.budget = new WorkerBudget(options.maxWorkers ?? DEFAULT_MAX_WORKERS);
  }

  async loadFile(path: string, expectedId?: string): Promise<NovelPlugin> {
    return this.loadSource(await readFile(path, "utf8"), expectedId);
  }

  async loadSource(source: string, expectedId?: string): Promise<NovelPlugin> {
    const hintedId = expectedId ?? this.readSourceId(source) ?? "unknown";
    const pool = new PluginPool({
      sourceId: hintedId,
      source,
      expectedId,
      siteHint: this.readSite(source) ?? "",
      fetcher: this.options.fetcher,
      hub: this.hubFor(hintedId),
      logger: this.logger,
      maxWorkers: this.options.maxWorkersPerSource ?? 2,
      idleMs: this.options.workerIdleMs ?? DEFAULT_WORKER_IDLE_MS,
      budget: this.budget,
      heapMb: this.options.workerHeapMb ?? DEFAULT_WORKER_HEAP_MB,
      ...(this.options.acquireTimeoutMs !== undefined ? { acquireTimeoutMs: this.options.acquireTimeoutMs } : {}),
    });
    let meta;
    try {
      meta = await pool.boot();
    } catch (error) {
      await pool.dispose();
      throw error;
    }
    this.pools.add(pool);
    const call =
      <T>(method: CallMethod) =>
      (...args: unknown[]): Promise<T> =>
        pool.call(method, args, {
          priority: currentPriority() ?? "bulk",
          timeoutMs: currentDeadline() ?? DEFAULT_CALL_TIMEOUT_MS,
          signal: currentSignal(),
        }) as Promise<T>;
    return {
      id: meta.id,
      name: meta.name,
      site: meta.site,
      version: meta.version,
      ...(meta.filters ? { filters: meta.filters } : {}),
      popularNovels: call<NovelItem[]>("popularNovels"),
      searchNovels: call<NovelItem[]>("searchNovels"),
      parseNovel: call<SourceNovel>("parseNovel"),
      parseChapter: call<string>("parseChapter"),
      ...(meta.pagedChapters ? { parsePage: call<SourcePage>("parsePage") } : {}),
      dispose: async () => {
        this.pools.delete(pool);
        await pool.dispose();
      },
    };
  }

  async close(): Promise<void> {
    await Promise.all([...this.pools].map((pool) => pool.dispose()));
    this.pools.clear();
  }

  private hubFor(sourceId: string): StorageHub {
    let hub = this.hubs.get(sourceId);
    if (!hub) {
      hub = new StorageHub(this.storagePath(sourceId), this.logger);
      this.hubs.set(sourceId, hub);
    }
    return hub;
  }

  // Storage can hold site cookies, so a removed source leaves none behind, in memory or on disk.
  async removeStorage(sourceId: string): Promise<void> {
    this.hubs.delete(sourceId);
    await rm(this.storagePath(sourceId), { recursive: true, force: true });
  }

  private storagePath(sourceId: string): string {
    return `${this.options.dataDir}/storage/${encodeURIComponent(sourceId)}`;
  }

  private readSourceId(source: string): string | undefined {
    return source.match(/\.id\s*=\s*["']([^"']+)["']/)?.[1];
  }

  private readSite(source: string): string | undefined {
    return source.match(/\.site\s*=\s*["']([^"']+)["']/)?.[1] ?? source.match(/sourceSite\s*:\s*["']([^"']+)["']/)?.[1];
  }
}
