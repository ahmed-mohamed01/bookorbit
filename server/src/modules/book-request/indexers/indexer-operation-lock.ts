import { Injectable } from '@nestjs/common';

/** Thrown to a caller whose signal ended while it was still queued for a slot. */
export class SlotWaitAbortedError extends Error {}

@Injectable()
export class IndexerOperationLock {
  private readonly tails = new Map<number, Promise<void>>();
  private readonly shared = new Map<number, { active: number; waiting: Array<() => void> }>();

  async run<T>(indexerId: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(indexerId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(indexerId, tail);

    try {
      return await current;
    } finally {
      if (this.tails.get(indexerId) === tail) this.tails.delete(indexerId);
    }
  }

  /**
   * At most `limit` operations on one indexer at a time. Not exclusive with `run`: an indexer
   * either needs exclusive access for every operation or for none, so one never takes both.
   */
  async runShared<T>(indexerId: number, limit: number, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let slots = this.shared.get(indexerId);
    if (!slots) {
      slots = { active: 0, waiting: [] };
      this.shared.set(indexerId, slots);
    }
    if (slots.active < limit) {
      slots.active++;
    } else {
      // The finishing operation hands its slot straight over, so `active` already counts this one.
      // A waiter that gives up leaves the queue, so the slot never passes to someone gone.
      const queue = slots.waiting;
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new SlotWaitAbortedError());
        const onAbort = () => {
          queue.splice(queue.indexOf(admit), 1);
          reject(new SlotWaitAbortedError());
        };
        const admit = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        queue.push(admit);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }

    try {
      return await operation();
    } finally {
      const next = slots.waiting.shift();
      if (next) {
        next();
      } else if (--slots.active === 0) {
        this.shared.delete(indexerId);
      }
    }
  }
}
