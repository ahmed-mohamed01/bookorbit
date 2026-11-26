import type { XrayBuildProgress } from '../../book-knowledge/book-knowledge-xray.service';

export const BK_PROGRESS_EVERY_MS = 1_000;
export const BK_MINUTES_MIN_UNITS = 3;
export const BK_MINUTES_WINDOW = 4;

type Write = (phase: string, done: number, total: number) => Promise<void>;
type Written = { phase: string; done: number; total: number };

function same(a: Written, b: Written | null): boolean {
  return !!b && a.phase === b.phase && a.done === b.done && a.total === b.total;
}

/** Upstream's story guide phase names, so its card, Jobs page and phase copy read BK builds unchanged. */
const STAGE_PHASE = { kinds: 'review', alias: 'review', dense: 'lines', finish: 'assemble' } as const;

function count(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Throttles, orders and maps a BK build's stages onto upstream's story guide phases. */
export class BkStoryGuideProgress {
  private phase: string | null = null;
  private done = 0;
  private total = 0;
  private lastWrite = Number.NEGATIVE_INFINITY;
  private chain: Promise<void> = Promise.resolve();
  private readonly finished: number[] = [];
  private written: Written | null = null;
  private pending: Written | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly write: Write | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /** The index wait: reading while the index is queued or absent, finding names once it runs or is ready. */
  index(status: string | undefined): void {
    this.report(status === 'running' || status === 'ready' ? 'names' : 'text', 0, 0);
  }

  readonly stage: XrayBuildProgress = (stage, done, total) => {
    if (stage === 'dense' && done > 0) {
      this.finished.push(this.now());
      if (this.finished.length > BK_MINUTES_WINDOW) this.finished.shift();
    }
    this.report(STAGE_PHASE[stage], done, total);
  };

  /** Whole minutes the descriptions pass has left, or null before enough chunks finished in this run. */
  minutesLeft(): number | null {
    if (this.phase !== 'lines' || this.finished.length < BK_MINUTES_MIN_UNITS || this.done >= this.total) return null;
    const msPerUnit = (this.finished.at(-1)! - this.finished[0]) / (this.finished.length - 1);
    return Math.max(1, Math.ceil(((this.total - this.done) * msPerUnit) / 60_000));
  }

  /** Lands the newest dropped write, then resolves once every write has landed. */
  settled(): Promise<void> {
    this.flush();
    return this.chain;
  }

  private report(phase: string, rawDone: number, rawTotal: number): void {
    const total = count(rawTotal);
    const done = Math.min(count(rawDone), total);
    const changed = phase !== this.phase;
    if (phase === 'lines' && changed) this.finished.length = 0;
    this.phase = phase;
    this.done = done;
    this.total = total;
    if (!this.write) return;
    const next: Written = { phase, done, total };
    if (same(next, this.written)) {
      this.cancelPending();
      return;
    }
    const at = this.now();
    if (changed || (total > 0 && done === total) || at - this.lastWrite >= BK_PROGRESS_EVERY_MS) {
      this.send(next, at);
      return;
    }
    this.pending = next;
    if (this.timer) return;
    const wait = Math.min(BK_PROGRESS_EVERY_MS, Math.max(0, this.lastWrite + BK_PROGRESS_EVERY_MS - at));
    this.timer = setTimeout(() => this.flush(), wait);
    this.timer.unref?.();
  }

  private flush(): void {
    const pending = this.pending;
    if (pending) this.send(pending, this.now());
    else this.cancelPending();
  }

  private send(next: Written, at: number): void {
    this.cancelPending();
    this.lastWrite = at;
    this.written = next;
    const write = this.write!;
    this.chain = this.chain.then(() =>
      Promise.resolve()
        .then(() => write(next.phase, next.done, next.total))
        .catch(() => undefined),
    );
  }

  private cancelPending(): void {
    this.pending = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
