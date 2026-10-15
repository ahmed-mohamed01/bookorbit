import { Logger } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { TooManyMissingChaptersError } from './engines/web-serial-engine';
import type { WebSerialJobItemRow } from './schema/web-serials.schema';
import { classifyFailure, failureText, isRetryableFailure, type FailureReason } from './web-serials-failure.utils';
import { isGroupedMangaUnit } from './web-serials-grouped-chapters.utils';
import { ImportStageError } from './web-serials-import.errors';
import { WebSerialsImportService } from './web-serials-import.service';
import { describeError } from './web-serials-log.utils';
import {
  ERROR_MAX_LENGTH,
  ITEM_EVENT,
  ItemFailure,
  JobStopped,
  type ItemRemoteRef,
  type JobContext,
  type RunnerOps,
  unitNoun,
} from './web-serials-runner.shared';
import { WebSerialsRepository } from './web-serials.repository';

const RETRY_DELAYS_MS = [2 * 60_000, 10 * 60_000];
const WAIT_CHECK_MS = 5000;

/** Decides whether a failed unit is retried or failed for good, and waits out the retry delays. Plain class, built by the job runner. */
export class WebSerialItemRetryPolicy {
  private readonly logger = new Logger(WebSerialItemRetryPolicy.name);

  constructor(
    private readonly repo: WebSerialsRepository,
    private readonly importer: WebSerialsImportService,
    private readonly ops: RunnerOps,
  ) {}

  /** True on the unit's last try, when no retry is left whatever the failure. */
  isFinalAttempt(attempts: number): boolean {
    return attempts >= RETRY_DELAYS_MS.length;
  }

  /** Milliseconds until the next try, or null when the failure is final or the attempts are used up. */
  nextDelay(attempts: number, reason: FailureReason): number | null {
    const delay = RETRY_DELAYS_MS[attempts];
    return delay === undefined || !isRetryableFailure(reason) ? null : delay;
  }

  /** A job's setup: like a unit, except that a job with items already made waits out the delays whatever the failure. */
  nextSetupDelay(attempts: number, reason: FailureReason, hasItems: boolean): number | null {
    if (!hasItems || reason === 'engine_credentials') return this.nextDelay(attempts, reason);
    return RETRY_DELAYS_MS[attempts] ?? null;
  }

  async handleFailure(context: JobContext, item: WebSerialJobItemRow, err: unknown, startedAt: number): Promise<void> {
    const { job } = context;
    const reason = failureReasonOf(err);
    if (reason === 'engine_credentials') {
      await this.repo.releaseItem(item.id);
      throw err;
    }
    const stored = (await this.repo.findItem(item.id)) ?? item;
    const attempts = (stored.remoteRef as ItemRemoteRef).attempts ?? 0;
    const delay = this.nextDelay(attempts, reason);
    if (delay === null) return await this.failItem(context, stored, err, reason, startedAt);
    const { errorClass, message } = describeError(err);
    this.logger.warn(
      `[${ITEM_EVENT}] [fail] jobId=${job.id} itemId=${item.id} unitKey="${sanitizeLogValue(item.unitKey)}" durationMs=${Date.now() - startedAt} reason=${reason} errorClass=${errorClass} error="${sanitizeLogValue(message.slice(0, ERROR_MAX_LENGTH))}" retryScheduled=true attempt=${attempts + 1} delayMs=${delay} - unit will be retried`,
    );
    await this.scheduleRetry(context, stored, reason, attempts + 1, delay);
  }

  private async failItem(context: JobContext, item: WebSerialJobItemRow, err: unknown, reason: FailureReason, startedAt: number): Promise<void> {
    const { job } = context;
    const { errorClass, message } = describeError(err);
    const detail = (err instanceof ItemFailure ? err.message : message).slice(0, ERROR_MAX_LENGTH);
    const text = err instanceof TooManyMissingChaptersError ? detail : (failureText(reason, job.sourceName, unitNoun(job)) ?? detail);
    this.logger.warn(
      `[${ITEM_EVENT}] [fail] jobId=${job.id} itemId=${item.id} unitKey="${sanitizeLogValue(item.unitKey)}" durationMs=${Date.now() - startedAt} reason=${reason} errorClass=${errorClass} error="${sanitizeLogValue(detail)}" - unit failed`,
    );
    const ref = item.remoteRef as ItemRemoteRef;
    await this.repo.updateItem(item.id, {
      status: 'failed',
      error: `${item.label}: ${text}`.slice(0, ERROR_MAX_LENGTH),
      remoteRef: { ...withoutRetrySchedule({ ...ref, handle: null }), failureReason: reason },
    });
    if (isGroupedMangaUnit(job.kind, ref.unit)) await this.importer.cleanupUnitWorkDir(job.id, item.id);
  }

  /**
   * Drops the failed engine handle so the next attempt starts the unit afresh (members already saved to disk are kept),
   * then parks the unit as pending until its retry is due. The schedule lives in remote_ref so it survives a restart.
   */
  private async scheduleRetry(
    context: JobContext,
    item: WebSerialJobItemRow,
    reason: FailureReason,
    attempts: number,
    delayMs: number,
  ): Promise<void> {
    const { client, connection } = context;
    const ref = item.remoteRef as ItemRemoteRef;
    const stale = ref.member?.handle ?? ref.handle;
    if (stale) await client.cancelUnit?.(connection, { unitKey: item.unitKey, remote: stale }).catch(() => undefined);
    const retryAt = new Date(this.ops.now().getTime() + delayMs).toISOString();
    await this.repo.updateItem(item.id, {
      status: 'pending',
      remoteRef: { ...ref, handle: null, member: null, attempts, retryAt, retryReason: reason },
    });
  }

  /** Nothing else is due: sleeps in short slices until the earliest retry, noticing a cancel, pause, shutdown or a manual retry promptly. */
  async waitForRetries(context: JobContext, count: number, next: WebSerialJobItemRow): Promise<void> {
    const { job } = context;
    const ref = next.remoteRef as ItemRemoteRef;
    const dueAt = ref.retryAt ? Date.parse(ref.retryAt) : Number.NaN;
    const remaining = Number.isNaN(dueAt) ? 0 : Math.max(0, dueAt - this.ops.now().getTime());
    const noun = unitNoun(job);
    const text = failureText(ref.retryReason ?? 'unknown', job.sourceName, noun) ?? 'The download failed.';
    await this.ops.writeCurrentUnit(job.id, null);
    try {
      await this.waitOut(
        job.id,
        remaining,
        (minutes) => `Waiting to retry ${count} ${noun}${count === 1 ? '' : 's'}: ${text} Next try in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        async () => Boolean(await this.repo.findNextItem(job.id, this.ops.now())),
      );
    } finally {
      await this.ops.writeCurrentUnit(job.id, null);
    }
  }

  /** Sleeps in 5 s slices, announcing the minutes left; ends early when `due` reports there is work to do. */
  async waitOut(jobId: number, durationMs: number, messageFor: (minutes: number) => string, due?: () => Promise<boolean>): Promise<void> {
    let remaining = durationMs;
    let lastMessage = '';
    while (remaining > 0) {
      if (this.ops.isStopping()) throw new JobStopped();
      if (await this.ops.shouldStop(jobId)) throw new JobStopped();
      if (due && (await due())) break;
      const message = messageFor(Math.max(1, Math.ceil(remaining / 60_000)));
      if (message !== lastMessage) {
        lastMessage = message;
        await this.repo.transitionJob(jobId, ['running', 'importing'], { status: 'running', message });
      }
      const step = Math.min(WAIT_CHECK_MS, remaining);
      await this.ops.sleep(step);
      remaining -= step;
      await this.repo.heartbeat(jobId);
    }
    if (this.ops.isStopping()) throw new JobStopped();
    if (await this.ops.shouldStop(jobId)) throw new JobStopped();
    await this.repo.transitionJob(jobId, ['running', 'importing'], { message: null });
  }
}

export function failureReasonOf(err: unknown): FailureReason {
  if (err instanceof ItemFailure && err.reason) return err.reason;
  if (err instanceof ImportStageError) return 'unknown';
  return classifyFailure(err);
}

function withoutRetrySchedule(ref: ItemRemoteRef): Record<string, unknown> {
  const rest = { ...ref };
  delete rest.retryAt;
  delete rest.retryReason;
  return rest;
}
