import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { SourceFetcher, Priority } from "./fetcher.js";
import { runWithPriority } from "./fetcher.js";
import { errorFromWire, FetchTimeoutError } from "./libs/errors.js";
import { readCapped } from "./libs/read-capped.js";
import type { StorageHub } from "./libs/storage.js";
import type { BudgetMember, BudgetWaiter, WorkerBudget } from "./worker-budget.js";
import type { CallMethod, PluginMeta, ToMain, ToWorker, WireInit, WorkerData } from "./worker-protocol.js";

type Logger = Pick<Console, "log" | "warn" | "error">;

export interface PoolOptions {
  sourceId: string;
  source: string;
  expectedId: string | undefined;
  siteHint: string;
  fetcher: SourceFetcher;
  hub: StorageHub;
  logger: Logger;
  maxWorkers: number;
  idleMs: number;
  budget: WorkerBudget;
  heapMb: number;
  acquireTimeoutMs?: number;
}

export interface CallOptions {
  priority: Priority;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

interface PendingCall {
  id: number;
  method: CallMethod;
  args: unknown[];
  priority: Priority;
  abort: AbortController;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  worker?: PooledWorker | undefined;
  timer?: ReturnType<typeof setTimeout>;
  detachSignal?: () => void;
  settled: boolean;
}

interface PooledWorker {
  worker: Worker;
  current: PendingCall | undefined;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  idleSince: number | undefined;
  dead: boolean;
}

const INTERACTIVE_STREAK_LIMIT = 3;

const workerUrl = (): URL => {
  const compiled = new URL("./plugin-worker.js", import.meta.url);
  return existsSync(fileURLToPath(compiled)) ? compiled : new URL("./plugin-worker.ts", import.meta.url);
};

// Young generation is capped too, so each worker's heap stays within heapMb + 16 MB.
const WORKER_YOUNG_GENERATION_MB = 16;
export const MAX_UPSTREAM_BYTES = 20_000_000;
const MAX_LOG_CHARS = 500;

const sanitizeLogText = (value: unknown): string =>
  String(value)
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .slice(0, MAX_LOG_CHARS);

let nextCallId = 1;

const decodeInit = (wire: WireInit, signal: AbortSignal): RequestInit => {
  const init: RequestInit = { headers: wire.headers, signal };
  if (wire.method) init.method = wire.method;
  const body = wire.body;
  if (body?.kind === "text") init.body = body.value;
  else if (body?.kind === "bytes") init.body = body.value as Uint8Array<ArrayBuffer>;
  else if (body?.kind === "form") {
    const form = new FormData();
    for (const [name, value] of body.entries) {
      if (typeof value === "string") form.append(name, value);
      else form.append(name, new Blob([value.bytes as Uint8Array<ArrayBuffer>], { type: value.type }), value.name);
    }
    init.body = form;
  }
  return init;
};

export class PluginPool implements BudgetMember {
  private readonly workers: PooledWorker[] = [];
  private readonly waiting: Record<Priority, PendingCall[]> = { interactive: [], bulk: [] };
  private interactiveStreak = 0;
  private site: string;
  private disposed = false;
  private granted = 0;
  private readonly slotWaiter: BudgetWaiter = {
    liveWorkers: () => this.workers.length,
    grant: () => {
      this.granted += 1;
      this.pump();
    },
  };

  constructor(private readonly options: PoolOptions) {
    this.site = options.siteHint;
    options.budget.join(this);
  }

  async boot(): Promise<PluginMeta> {
    await this.options.budget.acquire(this.options.acquireTimeoutMs);
    const worker = this.spawn();
    try {
      const meta = await new Promise<PluginMeta>((resolve, reject) => {
        worker.worker.on("message", (message: ToMain) => {
          if (message.type !== "boot") return;
          if (message.ok) resolve(message.meta);
          else reject(new Error(message.message));
        });
        worker.worker.once("error", reject);
        worker.worker.once("exit", () => reject(new Error("Plugin worker exited while loading")));
      });
      this.site = meta.site;
      return meta;
    } finally {
      this.retire(worker);
    }
  }

  call(method: CallMethod, args: unknown[], options: CallOptions): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("Source is no longer installed"));
    if (options.signal?.aborted) return Promise.reject(abortError());
    return new Promise<unknown>((resolve, reject) => {
      const call: PendingCall = {
        id: nextCallId++,
        method,
        args,
        priority: options.priority,
        abort: new AbortController(),
        resolve,
        reject,
        settled: false,
      };
      call.timer = setTimeout(() => this.expire(call, new FetchTimeoutError("Plugin call timed out")), options.timeoutMs);
      const signal = options.signal;
      if (signal) {
        const onAbort = (): void => this.expire(call, abortError());
        signal.addEventListener("abort", onAbort, { once: true });
        call.detachSignal = () => signal.removeEventListener("abort", onAbort);
      }
      this.waiting[call.priority].push(call);
      this.pump();
    });
  }

  oldestIdleSince(): number | undefined {
    return this.oldestIdle()?.idleSince;
  }

  evictOldestIdle(): void {
    const idle = this.oldestIdle();
    if (idle) this.retire(idle);
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.options.budget.leave(this);
    this.options.budget.cancel(this.slotWaiter);
    for (const lane of Object.values(this.waiting)) {
      for (const call of lane.splice(0)) this.settle(call, new Error("Source is no longer installed"));
    }
    for (const pooled of [...this.workers]) {
      if (pooled.current) this.settle(pooled.current, new Error("Source is no longer installed"));
      this.retire(pooled);
    }
    this.returnGranted();
    return Promise.resolve();
  }

  private spawn(): PooledWorker {
    const data: WorkerData = {
      source: this.options.source,
      filename: `${this.options.sourceId}.js`,
      expectedId: this.options.expectedId,
      siteHint: this.options.siteHint,
    };
    const worker = new Worker(workerUrl(), {
      workerData: data,
      resourceLimits: { maxOldGenerationSizeMb: this.options.heapMb, maxYoungGenerationSizeMb: WORKER_YOUNG_GENERATION_MB },
      env: {},
    });
    worker.unref();
    const pooled: PooledWorker = { worker, current: undefined, idleTimer: undefined, idleSince: undefined, dead: false };
    this.workers.push(pooled);
    worker.on("message", (message: ToMain) => this.onMessage(pooled, message));
    worker.on("error", (error: Error) => this.onCrash(pooled, error));
    worker.on("exit", () => this.onCrash(pooled, new Error("Plugin worker exited unexpectedly")));
    return pooled;
  }

  private dispatch(pooled: PooledWorker, call: PendingCall): void {
    clearTimeout(pooled.idleTimer);
    pooled.idleTimer = undefined;
    pooled.idleSince = undefined;
    pooled.current = call;
    call.worker = pooled;
    const message: ToWorker = {
      type: "call",
      callId: call.id,
      method: call.method,
      args: call.args,
      storage: this.options.hub.snapshot(),
    };
    try {
      pooled.worker.postMessage(message);
    } catch (error) {
      this.settle(call, new Error("Plugin call arguments cannot be transferred", { cause: error }));
      this.release(pooled);
    }
  }

  private onMessage(pooled: PooledWorker, message: ToMain): void {
    const call = pooled.current;
    if (message.type === "storage") {
      if (!this.options.hub.apply(message.op)) {
        this.options.logger.warn(
          `[novel_sources.storage] [fail] source=${this.options.sourceId} durationMs=0 errorClass=StorageRejected - storage op rejected`,
        );
      }
    } else if (message.type === "log") {
      const level = message.level === "warn" || message.level === "error" ? message.level : "log";
      this.options.logger[level](`[source:${this.options.sourceId}]`, sanitizeLogText(message.text));
    } else if (message.type === "fetch") {
      void this.handleFetch(pooled, call, message);
    } else if (message.type === "result" && call?.id === message.callId) {
      this.settle(call, undefined, message.value);
      this.release(pooled);
    } else if (message.type === "error" && call?.id === message.callId) {
      this.settle(call, errorFromWire(message.name, message.message));
      this.release(pooled);
    }
  }

  private async handleFetch(pooled: PooledWorker, call: PendingCall | undefined, message: Extract<ToMain, { type: "fetch" }>): Promise<void> {
    const reply = (value: ToWorker, transfer: ArrayBuffer[] = []): void => {
      if (!pooled.dead) pooled.worker.postMessage(value, transfer);
    };
    try {
      if (!call || call.id !== message.callId) throw new FetchTimeoutError("Plugin call is no longer active");
      const init = decodeInit(message.init, call.abort.signal);
      const response = await runWithPriority(call.priority, () => this.options.fetcher.request(this.options.sourceId, this.site, message.url, init));
      const body = await readCapped(response, MAX_UPSTREAM_BYTES);
      reply(
        {
          type: "fetchResult",
          requestId: message.requestId,
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers.entries()],
          body,
        },
        [body],
      );
    } catch (error) {
      const candidate = error as { name?: unknown; message?: unknown };
      reply({
        type: "fetchError",
        requestId: message.requestId,
        name: typeof candidate?.name === "string" ? candidate.name : "Error",
        message: typeof candidate?.message === "string" ? candidate.message : "Upstream request failed",
      });
    }
  }

  private expire(call: PendingCall, error: Error): void {
    if (call.settled) return;
    const pooled = call.worker;
    this.removeWaiting(call);
    this.settle(call, error);
    if (pooled) this.retire(pooled);
  }

  private onCrash(pooled: PooledWorker, error: Error): void {
    if (pooled.dead) return;
    const call = pooled.current;
    this.retire(pooled);
    if (call) this.settle(call, new Error(`Plugin worker crashed: ${error.message}`, { cause: error }));
  }

  private settle(call: PendingCall, error?: Error, value?: unknown): void {
    if (call.settled) return;
    call.settled = true;
    clearTimeout(call.timer);
    call.detachSignal?.();
    if (error) {
      call.abort.abort();
      call.reject(error);
    } else {
      call.resolve(value);
    }
  }

  // A finishing worker serves its own queue unless another source is waiting with clearly fewer workers;
  // then it retires so that source gets the slot, and this source queues for its next one.
  private release(pooled: PooledWorker): void {
    pooled.current = undefined;
    if (this.hasWaitingCalls()) {
      if (this.options.budget.shouldYield(this.slotWaiter)) {
        this.retire(pooled);
        return;
      }
      this.dispatch(pooled, this.nextWaiting()!);
      return;
    }
    this.options.budget.cancel(this.slotWaiter);
    if (this.options.budget.hasWaiters) {
      this.retire(pooled);
      return;
    }
    pooled.idleSince = Date.now();
    pooled.idleTimer = setTimeout(() => this.retire(pooled), this.options.idleMs);
    pooled.idleTimer.unref();
  }

  private retire(pooled: PooledWorker): void {
    if (pooled.dead) return;
    pooled.dead = true;
    clearTimeout(pooled.idleTimer);
    const index = this.workers.indexOf(pooled);
    if (index >= 0) this.workers.splice(index, 1);
    void pooled.worker.terminate();
    this.options.budget.release();
    if (pooled.current) pooled.current.worker = undefined;
    pooled.current = undefined;
    this.pump();
  }

  private readonly pump = (): void => {
    while (!this.disposed && this.hasWaitingCalls()) {
      const idle = this.workers.find((candidate) => !candidate.current && !candidate.dead);
      if (idle) {
        this.dispatch(idle, this.nextWaiting()!);
        continue;
      }
      if (this.workers.length >= this.options.maxWorkers) break;
      if (this.granted > 0) this.granted -= 1;
      else if (!this.options.budget.tryAcquire()) {
        this.options.budget.wait(this.slotWaiter);
        break;
      }
      this.dispatch(this.spawn(), this.nextWaiting()!);
    }
    if (this.disposed || !this.hasWaitingCalls()) this.options.budget.cancel(this.slotWaiter);
    this.returnGranted();
  };

  private returnGranted(): void {
    while (this.granted > 0) {
      this.granted -= 1;
      this.options.budget.release();
    }
  }

  private hasWaitingCalls(): boolean {
    return this.waiting.interactive.length + this.waiting.bulk.length > 0;
  }

  private oldestIdle(): PooledWorker | undefined {
    let oldest: PooledWorker | undefined;
    for (const pooled of this.workers) {
      if (pooled.dead || pooled.current || pooled.idleSince === undefined) continue;
      if (!oldest || pooled.idleSince < oldest.idleSince!) oldest = pooled;
    }
    return oldest;
  }

  private removeWaiting(call: PendingCall): void {
    const lane = this.waiting[call.priority];
    const index = lane.indexOf(call);
    if (index >= 0) lane.splice(index, 1);
    if (!this.hasWaitingCalls()) this.options.budget.cancel(this.slotWaiter);
  }

  private nextWaiting(): PendingCall | undefined {
    const { interactive, bulk } = this.waiting;
    if (interactive.length > 0 && !(bulk.length > 0 && this.interactiveStreak >= INTERACTIVE_STREAK_LIMIT)) {
      if (bulk.length > 0) this.interactiveStreak += 1;
      return interactive.shift();
    }
    this.interactiveStreak = 0;
    return bulk.shift();
  }
}

const abortError = (): Error => {
  const error = new Error("Request was aborted");
  error.name = "AbortError";
  return error;
};
