import { Injectable } from '@nestjs/common';

interface ActivePush {
  done: Promise<void>;
  finish: () => void;
}

@Injectable()
export class AudiobookshelfSyncCoordinatorService {
  private readonly syncUsers = new Set<number>();
  private readonly pushUsers = new Map<number, ActivePush>();
  private readonly syncWaiters = new Map<number, number>();

  /**
   * Takes the user's sync lock. A position push is short, so a sync waits for it (up to `maxWaitMs`)
   * instead of failing; only another running sync is a real conflict. While a sync waits, no new push
   * can start, so a steady stream of pushes cannot starve it.
   */
  async acquireSync(userId: number, maxWaitMs: number): Promise<boolean> {
    if (this.syncUsers.has(userId)) return false;
    if (!this.pushUsers.has(userId)) {
      this.syncUsers.add(userId);
      return true;
    }

    const deadline = Date.now() + maxWaitMs;
    this.syncWaiters.set(userId, (this.syncWaiters.get(userId) ?? 0) + 1);
    try {
      for (;;) {
        if (this.syncUsers.has(userId)) return false;
        const push = this.pushUsers.get(userId);
        if (!push) {
          this.syncUsers.add(userId);
          return true;
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) return false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([push.done, new Promise<void>((resolve) => (timer = setTimeout(resolve, remainingMs)))]);
        clearTimeout(timer);
      }
    } finally {
      const waiting = (this.syncWaiters.get(userId) ?? 1) - 1;
      if (waiting > 0) this.syncWaiters.set(userId, waiting);
      else this.syncWaiters.delete(userId);
    }
  }

  endSync(userId: number): void {
    this.syncUsers.delete(userId);
  }

  isSyncRunning(userId: number): boolean {
    return this.syncUsers.has(userId) || this.syncWaiters.has(userId);
  }

  tryStartPush(userId: number): boolean {
    if (this.syncUsers.has(userId) || this.syncWaiters.has(userId) || this.pushUsers.has(userId)) return false;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    this.pushUsers.set(userId, { done, finish });
    return true;
  }

  endPush(userId: number): void {
    const push = this.pushUsers.get(userId);
    this.pushUsers.delete(userId);
    push?.finish();
  }
}
