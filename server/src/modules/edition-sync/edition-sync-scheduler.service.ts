import { ConflictException, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Interval, SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import type {
  EditionSyncAdminStatus,
  EditionSyncRunStopReason,
  EditionSyncRunTrigger,
  ReadAloudWorkerForkHealth,
  ReadAloudWorkerStage,
} from '@bookorbit/types';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { SYSTEM_TIME_ZONE } from '../../common/utils/timezone.utils';
import { ReadAloudWorkerClientService } from '../read-aloud/read-aloud-worker-client.service';
import { ReadAloudWorkerService } from '../read-aloud/read-aloud-worker.service';
import {
  EDITION_SYNC_CRON_JOB_NAME,
  EDITION_SYNC_CONTENT_CHECK_BUDGET_MS,
  EDITION_SYNC_FILES_SETTLE_MS,
  EDITION_SYNC_FILES_CHANGED_PIN_BATCH_SIZE,
  EDITION_SYNC_POKE_INTERVAL_MS,
  EDITION_SYNC_UPSTREAM_WAIT_MS,
} from './edition-sync.constants';
import { EditionSyncIndexerService } from './edition-sync-indexer.service';
import { computeWindowUntil, isWindowOpen } from './edition-sync-policy';
import { EditionSyncQueueService } from './edition-sync-queue.service';
import type { EditionSyncIndexOutcome } from './edition-sync.types';
import { EditionSyncRepository } from './edition-sync.repository';

/** Ready rows re-verified per poke after a catalog change; bounds file stats per interval. */
const RECHECK_BATCH_SIZE = 50;

interface ActiveRun {
  id: number;
  trigger: EditionSyncRunTrigger;
  startedAt: Date;
  windowUntil: Date | null;
  /** Toggle runs only take pinned books until a cron tick widens them into a scheduled run. */
  pinnedOnly: boolean;
  currentBookId: number | null;
  stopRequested: boolean;
  booksIndexed: number;
  booksFailed: number;
  secondsIndexed: number;
}

type UpstreamState = 'idle' | 'busy' | 'unavailable';

/**
 * Runs index batches one book at a time: the cron window, manual runs, pinned books and yielding to
 * upstream read-aloud jobs. Every book claimed is a `running` row, so a restart resumes it.
 */
@Injectable()
export class EditionSyncSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(EditionSyncSchedulerService.name);
  private readonly timeZone = SYSTEM_TIME_ZONE;
  private run: ActiveRun | null = null;
  private starting = false;
  private lastSkippedWorkerState: string | null = null;
  private rechecking = false;
  private destroyed = false;
  private wake: (() => void) | null = null;

  constructor(
    private readonly repo: EditionSyncRepository,
    private readonly queue: EditionSyncQueueService,
    private readonly indexer: EditionSyncIndexerService,
    private readonly workerClient: ReadAloudWorkerClientService,
    private readonly upstreamWorker: ReadAloudWorkerService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const event = 'edition_sync.bootstrap';
    const startedAt = Date.now();
    try {
      const [runsClosed, rowsInterrupted, settings] = await Promise.all([
        this.repo.endInterruptedRuns(),
        this.repo.markInterruptedRows(),
        this.repo.findAdminSettings(),
      ]);
      const registered = this.syncSchedule(settings.cronExpression);
      this.logger.log(
        `[${event}] [end] durationMs=${Date.now() - startedAt} runsClosed=${runsClosed} rowsInterrupted=${rowsInterrupted} scheduleRegistered=${registered} - edition sync scheduler ready`,
      );
    } catch (err) {
      this.logFailure(event, startedAt, err, 'edition sync scheduler bootstrap failed');
    }
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.run) this.run.stopRequested = true;
    this.wake?.();
    this.deleteCronJob();
  }

  /** Re-registers the cron job; null removes it (manual mode). Returns false when registration failed. */
  syncSchedule(cronExpression: string | null): boolean {
    const event = 'edition_sync.schedule';
    const startedAt = Date.now();
    try {
      this.deleteCronJob();
      if (cronExpression === null) {
        this.logger.log(`[${event}] [end] durationMs=${Date.now() - startedAt} enabled=false - scheduled indexing disabled`);
        return true;
      }
      const job = CronJob.from({ cronTime: cronExpression, timeZone: this.timeZone, onTick: () => this.onCronTick(), start: false });
      this.schedulerRegistry.addCronJob(EDITION_SYNC_CRON_JOB_NAME, job);
      job.start();
      this.logger.log(
        `[${event}] [end] durationMs=${Date.now() - startedAt} enabled=true timeZone=${this.timeZone} nextRunAt=${job.nextDate().toISO()} - scheduled indexing registered`,
      );
      return true;
    } catch (err) {
      this.deleteCronJob();
      this.logFailure(event, startedAt, err, 'scheduled indexing registration failed');
      return false;
    }
  }

  nextRunAt(): Date | null {
    if (!this.schedulerRegistry.doesExist('cron', EDITION_SYNC_CRON_JOB_NAME)) return null;
    return this.schedulerRegistry.getCronJob(EDITION_SYNC_CRON_JOB_NAME).nextDate().toJSDate();
  }

  /** Picks up pinned books now instead of at the next interval. */
  poke(): void {
    void this.tick();
  }

  @Interval(EDITION_SYNC_POKE_INTERVAL_MS)
  async tick(): Promise<void> {
    if (this.destroyed) return;
    await this.recheckFlaggedIndexes();
    if (this.run || this.starting) return;
    try {
      const pinned = await this.repo.findNextQueuedBook({ pinnedOnly: true });
      if (pinned) {
        const { state } = await this.workerClient.healthState();
        if (state !== 'ok') {
          if (state !== this.lastSkippedWorkerState)
            this.logger.log(`[edition_sync.poke] [end] workerState=${state} pinned=true skipped=worker_unavailable - pinned run deferred`);
          this.lastSkippedWorkerState = state;
          return;
        }
        await this.startRun('toggle');
      }
    } catch (err) {
      this.logFailure('edition_sync.poke', Date.now(), err, 'pinned book check failed');
    }
  }

  /** Starts an unscheduled run with no window; 409 when a run is active. */
  async startManualRun(): Promise<EditionSyncAdminStatus> {
    if (this.run || this.starting) throw new ConflictException('An edition sync run is already active');
    await this.startRun('manual');
    return this.getAdminStatus();
  }

  /** Cancels the current worker job (its folder is kept) and ends the run. */
  async stop(): Promise<EditionSyncAdminStatus> {
    const run = this.run;
    if (run) {
      this.logger.log(`[edition_sync.stop] [start] runId=${run.id} bookId=${run.currentBookId ?? 'none'} - stopping run`);
      run.stopRequested = true;
      this.wake?.();
      if (run.currentBookId !== null) await this.repo.clearPin(run.currentBookId);
      await this.indexer.cancelCurrent();
    }
    return this.getAdminStatus();
  }

  async getAdminStatus(): Promise<EditionSyncAdminStatus> {
    const run = this.run;
    const [health, settings, counts, unused, throughput, current] = await Promise.all([
      this.workerClient.healthState(),
      this.repo.findAdminSettings(),
      this.repo.countIndexStates(),
      this.repo.countUnused(),
      this.repo.findRecentThroughput(),
      run?.currentBookId ? this.describeCurrent(run.currentBookId) : Promise.resolve(null),
    ]);
    const forkHealth = health.state === 'ok' || health.state === 'incompatible' ? (health.health as ReadAloudWorkerForkHealth) : null;
    return {
      worker: {
        configured: health.state !== 'not_configured',
        state: health.state,
        version: forkHealth?.version ?? null,
        device: health.state === 'ok' ? health.health.device : null,
        rebuildSupported: forkHealth?.rebuild === true,
      },
      schedule: {
        cronExpression: settings.cronExpression,
        runHours: settings.runHours,
        onFilesChanged: settings.onFilesChanged,
        updatedAt: settings.updatedAt.getTime() > 0 ? settings.updatedAt.toISOString() : null,
        nextRunAt: this.nextRunAt()?.toISOString() ?? null,
      },
      run: {
        active: run !== null,
        trigger: run?.trigger ?? null,
        startedAt: run?.startedAt.toISOString() ?? null,
        windowUntil: run?.windowUntil?.toISOString() ?? null,
        current,
      },
      counts: { ...counts, unusedIndexes: unused.count, unusedBytes: unused.bytes },
      backlogEstimate: {
        books: counts.queued,
        hoursAtRecentRate: throughput ? Math.round(((counts.queued * throughput.seconds) / throughput.books / 3600) * 10) / 10 : null,
      },
    };
  }

  private onCronTick(): void {
    const run = this.run;
    if (run) {
      if (run.trigger === 'toggle' && run.pinnedOnly) {
        // A pinned book is indexing at the scheduled time: widen that run instead of skipping tonight.
        void this.repo
          .findAdminSettings()
          .then(async (settings) => {
            if (this.run !== run || run.stopRequested) return;
            const windowUntil = computeWindowUntil('scheduled', new Date(), settings.runHours);
            await this.repo.widenRun(run.id, windowUntil);
            run.trigger = 'scheduled';
            run.pinnedOnly = false;
            run.windowUntil = windowUntil;
            this.logger.log(
              `[edition_sync.run] [start] runId=${run.id} trigger=scheduled windowUntil=${run.windowUntil?.toISOString()} widened=true - scheduled run joined the active run`,
            );
          })
          .catch((err: unknown) => this.logFailure('edition_sync.run', Date.now(), err, 'scheduled run could not join the active run'));
        return;
      }
      this.logger.log(`[edition_sync.run] [end] runId=${run.id} trigger=scheduled outcome=skipped reason=run_active - scheduled run skipped`);
      return;
    }
    void this.startRun('scheduled').catch((err: unknown) => this.logFailure('edition_sync.run', Date.now(), err, 'scheduled run failed to start'));
  }

  private async startRun(trigger: EditionSyncRunTrigger): Promise<void> {
    if (this.run || this.starting) return;
    this.starting = true;
    try {
      const startedAt = new Date();
      const settings = await this.repo.findAdminSettings();
      const windowUntil = computeWindowUntil(trigger, startedAt, settings.runHours);
      const row = await this.repo.createRun(trigger, windowUntil);
      const run: ActiveRun = {
        id: row.id,
        trigger,
        startedAt: row.startedAt,
        windowUntil,
        pinnedOnly: trigger === 'toggle',
        currentBookId: null,
        stopRequested: false,
        booksIndexed: 0,
        booksFailed: 0,
        secondsIndexed: 0,
      };
      this.run = run;
      this.lastSkippedWorkerState = null;
      this.logger.log(
        `[edition_sync.run] [start] runId=${run.id} trigger=${trigger} windowUntil=${windowUntil?.toISOString() ?? 'none'} - indexing run started`,
      );
      void this.execute(run);
    } finally {
      this.starting = false;
    }
  }

  private async execute(run: ActiveRun): Promise<void> {
    const startedAt = run.startedAt.getTime();
    let stopReason: EditionSyncRunStopReason = 'error';
    try {
      stopReason = await this.loop(run);
      this.logger.log(
        `[edition_sync.run] [end] runId=${run.id} trigger=${run.trigger} durationMs=${Date.now() - startedAt} stopReason=${stopReason} booksIndexed=${run.booksIndexed} booksFailed=${run.booksFailed} secondsIndexed=${Math.round(run.secondsIndexed)} - indexing run ended`,
      );
    } catch (err) {
      stopReason = 'error';
      this.logFailure(`edition_sync.run`, startedAt, err, 'indexing run failed', `runId=${run.id} trigger=${run.trigger} `);
    } finally {
      run.currentBookId = null;
      await this.repo
        .finishRun(run.id, { stopReason, booksIndexed: run.booksIndexed, booksFailed: run.booksFailed, secondsIndexed: run.secondsIndexed })
        .catch((err: unknown) => this.logFailure('edition_sync.run', startedAt, err, 'run record not closed', `runId=${run.id} `));
      if (this.run === run) this.run = null;
    }
  }

  /**
   * One book at a time until the queue is empty, the window closes, the run is stopped or the worker
   * goes away. The window only stops new unpinned books; the book being indexed always finishes.
   */
  private async loop(run: ActiveRun): Promise<EditionSyncRunStopReason> {
    // Books whose outcome would requeue them at once (failed with a retry flag, cancelled) are not
    // claimed again in the same run, so a flapping book cannot spin the loop.
    const skip = new Set<number>();
    for (;;) {
      if (run.stopRequested) return 'stopped';
      const upstream = await this.upstreamState();
      if (upstream === 'unavailable') return 'worker_unavailable';
      if (upstream === 'busy') {
        if (!run.pinnedOnly && !isWindowOpen(run.windowUntil, new Date()) && !(await this.repo.findNextQueuedBook({ pinnedOnly: true }))) {
          return 'window_closed';
        }
        await this.sleep(EDITION_SYNC_UPSTREAM_WAIT_MS);
        continue;
      }

      const windowOpen = isWindowOpen(run.windowUntil, new Date());
      const claim = await this.queue.claimNext({ pinnedOnly: run.pinnedOnly || !windowOpen, excludeBookIds: [...skip] });
      if (!claim) return run.pinnedOnly || windowOpen ? 'empty' : 'window_closed';

      run.currentBookId = claim.bookId;
      if (run.stopRequested) await this.repo.clearPin(claim.bookId);
      const outcome = await this.indexer.indexBook(claim, {
        shouldYield: () => this.repo.hasUpstreamActiveJobs(),
        shouldStop: () => run.stopRequested,
      });
      run.currentBookId = null;
      this.record(run, outcome);
      if (outcome.status === 'cancelled' && run.stopRequested) return 'stopped';
      if (outcome.status !== 'ready' && outcome.status !== 'yielded') skip.add(outcome.bookId);
    }
  }

  private record(run: ActiveRun, outcome: EditionSyncIndexOutcome): void {
    if (outcome.status === 'ready') {
      run.booksIndexed++;
      run.secondsIndexed += outcome.audioSeconds ?? 0;
    } else if (outcome.status === 'failed') {
      run.booksFailed++;
    } else if (outcome.status === 'yielded') {
      this.logger.log(
        `[edition_sync.yield] [end] runId=${run.id} bookId=${outcome.bookId} workerJobId=${outcome.workerJobId} durationMs=${outcome.durationMs} - index job yielded to a read-aloud job`,
      );
    }
  }

  /**
   * Busy while upstream's dispatcher holds the worker, has queued work, or the worker is full. A job
   * of ours left running by a restart is cancelled (its folder is kept, so it resumes later).
   */
  private async upstreamState(): Promise<UpstreamState> {
    if (this.upstreamWorker.currentJobId !== null || (await this.repo.hasUpstreamActiveJobs())) return 'busy';
    const health = await this.workerClient.healthState(true);
    if (health.state !== 'ok') return 'unavailable';
    const activeJobId = health.health.activeJobId;
    if (activeJobId && activeJobId !== this.indexer.currentWorkerJobId && (await this.repo.findIndexRowByWorkerJobId(activeJobId))) {
      await this.workerClient.cancel(activeJobId).catch(() => undefined);
      this.logger.log(
        `[edition_sync.adopt] [end] workerJobId=${activeJobId} action=cancelled - leftover index job cancelled, it resumes when claimed`,
      );
      return 'busy';
    }
    return health.health.activeJobs >= health.health.capacity ? 'busy' : 'idle';
  }

  private async recheckFlaggedIndexes(): Promise<void> {
    if (this.rechecking) return;
    this.rechecking = true;
    const recheckStarted = Date.now();
    try {
      try {
        const bookIds = await this.repo.findBooksNeedingRecheck(RECHECK_BATCH_SIZE);
        const budget = { deadline: recheckStarted + EDITION_SYNC_CONTENT_CHECK_BUDGET_MS };
        for (const bookId of bookIds) await this.queue.ensureValid(bookId, budget);
      } catch (err) {
        this.logFailure('edition_sync.recheck', recheckStarted, err, 'index re-verification failed');
      }
      const pinStarted = Date.now();
      try {
        const settings = await this.repo.findAdminSettings();
        if (settings.onFilesChanged === 'immediate') {
          const pinned = await this.repo.pinFilesChangedBooks(
            new Date(Date.now() - EDITION_SYNC_FILES_SETTLE_MS),
            EDITION_SYNC_FILES_CHANGED_PIN_BATCH_SIZE,
          );
          if (pinned > 0)
            this.logger.log(
              `[edition_sync.files_changed] [end] durationMs=${Date.now() - pinStarted} pinned=${pinned} - changed books queued for re-index`,
            );
        }
      } catch (err) {
        this.logFailure('edition_sync.files_changed', pinStarted, err, 'changed books could not be queued');
      }
    } finally {
      this.rechecking = false;
    }
  }

  private async describeCurrent(
    bookId: number,
  ): Promise<{ bookId: number; title: string; stage: ReadAloudWorkerStage | null; progress: number } | null> {
    const [row, title] = await Promise.all([this.repo.findIndexRow(bookId), this.repo.findBookTitle(bookId)]);
    return { bookId, title: title ?? `#${bookId}`, stage: (row?.stage as ReadAloudWorkerStage | null) ?? null, progress: row?.progress ?? 0 };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  private deleteCronJob(): void {
    if (this.schedulerRegistry.doesExist('cron', EDITION_SYNC_CRON_JOB_NAME)) this.schedulerRegistry.deleteCronJob(EDITION_SYNC_CRON_JOB_NAME);
  }

  private logFailure(event: string, startedAt: number, err: unknown, message: string, ids = ''): void {
    const errorClass = err instanceof Error ? err.name : 'Error';
    this.logger.error(
      `[${event}] [fail] ${ids}durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(err instanceof Error ? err.message : String(err))}" - ${message}`,
    );
  }
}
