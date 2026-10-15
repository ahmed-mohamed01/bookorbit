import { ServiceError } from "./types.js";

export interface BudgetMember {
  oldestIdleSince(): number | undefined;
  evictOldestIdle(): void;
}

export interface BudgetWaiter {
  liveWorkers(): number;
  grant(): void;
}

export const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;

// One cap on live plugin workers across every source, because each worker costs about 30 MB.
// When the cap is reached an idle worker of any source is retired first; otherwise callers queue in order.
// A released slot is reserved for the first waiter before it is told, so nobody can take it in between.
export class WorkerBudget {
  private live = 0;
  private readonly members = new Set<BudgetMember>();
  private readonly waiters: BudgetWaiter[] = [];

  constructor(readonly limit: number) {}

  get liveCount(): number {
    return this.live;
  }

  get hasWaiters(): boolean {
    return this.waiters.length > 0;
  }

  join(member: BudgetMember): void {
    this.members.add(member);
  }

  leave(member: BudgetMember): void {
    this.members.delete(member);
  }

  tryAcquire(): boolean {
    if (this.waiters.length > 0) return false;
    if (this.live >= this.limit) this.evictIdle();
    if (this.live >= this.limit) return false;
    this.live += 1;
    return true;
  }

  acquire(timeoutMs = DEFAULT_ACQUIRE_TIMEOUT_MS): Promise<void> {
    if (this.tryAcquire()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter: BudgetWaiter = {
        liveWorkers: () => 0,
        grant: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        this.cancel(waiter);
        reject(new ServiceError("All plugin workers are busy; try again shortly", 503, "TIMEOUT"));
      }, timeoutMs);
      this.wait(waiter);
    });
  }

  release(): void {
    this.live = Math.max(0, this.live - 1);
    while (this.live < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      this.live += 1;
      queueMicrotask(() => waiter.grant());
    }
  }

  wait(waiter: BudgetWaiter): void {
    if (!this.waiters.includes(waiter)) this.waiters.push(waiter);
  }

  cancel(waiter: BudgetWaiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
  }

  // A finishing worker hands its slot over when a waiting source holds clearly fewer workers than its own source.
  // A source with no worker always gets one; otherwise the gap must be at least two so equal sources do not swap
  // a worker back and forth on every call.
  shouldYield(own: BudgetWaiter): boolean {
    const mine = own.liveWorkers();
    return this.waiters.some((waiter) => {
      if (waiter === own) return false;
      const theirs = waiter.liveWorkers();
      return theirs === 0 || theirs + 1 < mine;
    });
  }

  private evictIdle(): void {
    let oldest: BudgetMember | undefined;
    let oldestSince = Number.POSITIVE_INFINITY;
    for (const member of this.members) {
      const since = member.oldestIdleSince();
      if (since !== undefined && since < oldestSince) {
        oldest = member;
        oldestSince = since;
      }
    }
    oldest?.evictOldestIdle();
  }
}
