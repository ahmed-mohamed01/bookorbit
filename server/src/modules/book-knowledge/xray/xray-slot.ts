export class XraySlot {
  private held = false;
  private readonly waiting = new Set<() => void>();

  busy(): boolean {
    return this.held;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (!this.held) {
      this.held = true;
      return this.releaseHandle();
    }
    return new Promise((resolve, reject) => {
      const admit = () => {
        this.waiting.delete(admit);
        signal?.removeEventListener('abort', cancel);
        resolve(this.releaseHandle());
      };
      const cancel = () => {
        this.waiting.delete(admit);
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- AbortSignal permits any value as its reason.
        reject(signal?.reason);
      };
      this.waiting.add(admit);
      signal?.addEventListener('abort', cancel, { once: true });
    });
  }

  private releaseHandle(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.values().next().value;
      if (next) next();
      else this.held = false;
    };
  }
}
