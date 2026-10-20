type QueueOptions = {
  concurrency: number;
  pendingCap: number;
  run: (monitorId: string, signal: AbortSignal) => Promise<void>;
  refill: () => Promise<string[]>;
  onError: (monitorId: string, error: unknown) => void;
};

export class MonitoredFetchQueue {
  private readonly pending = new Set<string>();
  private readonly dueRetries = new Set<string>();
  private readonly running = new Map<string, AbortController>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly idleResolvers: Array<() => void> = [];
  private stopped = false;
  private refilling = false;

  constructor(private readonly options: QueueOptions) {}

  enqueue(monitorId: string): boolean {
    if (this.stopped || this.pending.has(monitorId) || this.running.has(monitorId) || this.pending.size >= this.options.pendingCap) return false;
    this.clearRetry(monitorId);
    this.pending.add(monitorId);
    this.drain();
    return true;
  }

  cancel(monitorId: string): void {
    this.pending.delete(monitorId);
    this.running.get(monitorId)?.abort();
    this.clearRetry(monitorId);
    this.resolveIdle();
  }

  scheduleRetry(monitorId: string, at: Date): void {
    this.clearRetry(monitorId);
    if (this.stopped) return;
    const timer = setTimeout(
      () => {
        this.timers.delete(monitorId);
        if (!this.enqueue(monitorId) && !this.stopped && !this.pending.has(monitorId) && !this.running.has(monitorId)) {
          this.dueRetries.add(monitorId);
        }
      },
      Math.max(0, at.getTime() - Date.now()),
    );
    timer.unref?.();
    this.timers.set(monitorId, timer);
  }

  clearRetry(monitorId: string): void {
    this.dueRetries.delete(monitorId);
    const timer = this.timers.get(monitorId);
    if (timer) clearTimeout(timer);
    this.timers.delete(monitorId);
  }

  stop(): void {
    this.stopped = true;
    this.pending.clear();
    this.dueRetries.clear();
    for (const controller of this.running.values()) controller.abort();
    for (const id of this.timers.keys()) this.clearRetry(id);
    this.resolveIdle();
  }

  waitForIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  private drain(): void {
    for (const id of this.dueRetries) {
      if (this.stopped || this.pending.size >= this.options.pendingCap) break;
      this.dueRetries.delete(id);
      this.pending.add(id);
    }
    while (!this.stopped && this.running.size < this.options.concurrency && this.pending.size) {
      const id = this.pending.values().next().value!;
      this.pending.delete(id);
      const controller = new AbortController();
      this.running.set(id, controller);
      void this.options
        .run(id, controller.signal)
        .catch((error: unknown) => this.options.onError(id, error))
        .finally(() => {
          this.running.delete(id);
          this.drain();
        });
    }
    if (!this.stopped && !this.refilling && this.running.size === 0 && this.pending.size === 0) {
      this.refilling = true;
      let found = false;
      void this.options
        .refill()
        .then((ids) => {
          found = ids.length > 0;
          for (const id of ids.slice(0, this.options.pendingCap)) this.enqueue(id);
        })
        .catch((error: unknown) => this.options.onError('refill', error))
        .finally(() => {
          this.refilling = false;
          if (found) this.drain();
          else this.resolveIdle();
        });
    }
    this.resolveIdle();
  }

  private isIdle(): boolean {
    return this.pending.size === 0 && this.running.size === 0 && !this.refilling;
  }

  private resolveIdle(): void {
    if (this.isIdle()) for (const resolve of this.idleResolvers.splice(0)) resolve();
  }
}
