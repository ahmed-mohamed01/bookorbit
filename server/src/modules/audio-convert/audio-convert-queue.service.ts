import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { LibraryOperationGate } from '../../common/services/library-operation-gate.service';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { appConfig } from '../../config/config';
import { FfmpegCancelledError } from './audio-convert-ffmpeg';
import { AudioConvertConverterService, ConvertCancelledError, ConvertDeferredError, ConvertError } from './audio-convert-converter.service';
import { AudioConvertRepository } from './audio-convert.repository';
import { errorClass, errorMessage } from './audio-convert.utils';
import type { AudioConvertJobRow, AudioConvertSettingsRow } from './schema/audio-convert.schema';

const TICK_MS = 2_000;
/** A book someone played this recently is left alone, so a listener never has the file swapped under them. */
const RECENT_PLAY_MS = 5 * 60_000;
const GATE_RETRY_MS = 2 * 60_000;
const PROGRESS_WRITE_MS = 2_000;
const HOUSEKEEPING_MS = 60 * 60_000;
const EVENT = 'audio_convert.job';
/** How long a shutdown waits for the running job to stop or finish its swap. */
const SHUTDOWN_WAIT_MS = 15_000;
const SHUTDOWN = 'shutdown';
const USER_CANCEL = 'user_cancel';

/** Runs queued conversions one at a time. Jobs live in Postgres, so a restart loses nothing but the running one. */
@Injectable()
export class AudioConvertQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AudioConvertQueueService.name);
  private timer: NodeJS.Timeout | null = null;
  private housekeepingTimer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private current: { jobId: string; controller: AbortController; cancellable: boolean } | null = null;

  constructor(
    private readonly repo: AudioConvertRepository,
    private readonly converter: AudioConvertConverterService,
    private readonly gate: LibraryOperationGate,
    @Inject(appConfig.KEY) private readonly app: ConfigType<typeof appConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.recover();
    if (this.app.nodeEnv === 'test') return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    this.housekeepingTimer = setInterval(() => void this.housekeeping(), HOUSEKEEPING_MS);
    this.housekeepingTimer.unref();
    setTimeout(() => void this.housekeeping(), 60_000).unref();
  }

  /** A shutdown puts the running job back in the queue (it was not the user's cancel) and lets a swap finish. */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.housekeepingTimer) clearInterval(this.housekeepingTimer);
    if (this.current?.cancellable) this.current.controller.abort(SHUTDOWN);
    if (this.running) await Promise.race([this.running, new Promise((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS).unref())]);
  }

  /**
   * A job still `running` at boot was cut off by a restart. The converter finishes a swap that was
   * committed and undoes one that was not, using what the job recorded before each step.
   */
  async recover(): Promise<void> {
    for (const job of await this.repo.interruptedJobs()) {
      const startedAt = Date.now();
      try {
        const outcome = await this.converter.recoverInterrupted(job);
        if (outcome.status === 'success') {
          await this.repo.updateJob(job.id, {
            status: 'success',
            stage: null,
            progress: 100,
            codecUsed: outcome.result.codec ?? null,
            result: { ...(job.result ?? {}), ...outcome.result },
            backupPath: outcome.backupPath,
            finishedAt: new Date(),
          });
        } else {
          await this.repo.updateJob(job.id, {
            status: 'failed',
            stage: null,
            progress: null,
            errorCode: 'interrupted',
            errorMessage: outcome.message,
            finishedAt: new Date(),
          });
        }
        this.logger.log(
          `[audio_convert.recover] [end] jobId=${job.id} bookId=${job.bookId} durationMs=${Date.now() - startedAt} outcome=${outcome.status} - interrupted conversion recovered`,
        );
      } catch (error) {
        this.logger.error(
          `[audio_convert.recover] [fail] jobId=${job.id} bookId=${job.bookId} durationMs=${Date.now() - startedAt} errorClass=${errorClass(error)} error="${sanitizeLogValue(errorMessage(error))}" - interrupted conversion not recovered`,
        );
      }
    }
  }

  /** Stops the running job if it has not reached the swap. Returns whether it was stopped. */
  cancelRunning(jobId: string): boolean {
    if (this.current?.jobId !== jobId || !this.current.cancellable) return false;
    this.current.controller.abort(USER_CANCEL);
    return true;
  }

  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    const startedAt = Date.now();
    this.running = (async () => {
      try {
        const settings = await this.repo.getSettings();
        if (!settings.enabled) return;
        const job = await this.repo.claim();
        if (!job) return;
        await this.run(job, settings);
      } catch (error) {
        this.logger.error(
          `[${EVENT}] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass(error)} error="${sanitizeLogValue(errorMessage(error))}" - queue tick failed`,
        );
      }
    })();
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }

  /** When the job may swap now, or the time to try again: nobody played the book lately and the library is not busy. */
  private async deferUntil(job: AudioConvertJobRow): Promise<Date | null> {
    if (this.gate.isHeld(job.libraryId)) return new Date(Date.now() + GATE_RETRY_MS);
    const lastPlayed = await this.repo.lastPlayedAt(job.bookId);
    if (lastPlayed && Date.now() - lastPlayed.getTime() < RECENT_PLAY_MS) return new Date(lastPlayed.getTime() + RECENT_PLAY_MS);
    return null;
  }

  private async run(job: AudioConvertJobRow, settings: AudioConvertSettingsRow): Promise<void> {
    const early = await this.deferUntil(job);
    if (early) {
      await this.repo.defer(job.id, early);
      return;
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const current = { jobId: job.id, controller, cancellable: true };
    this.current = current;
    this.logger.log(`[${EVENT}] [start] jobId=${job.id} bookId=${job.bookId} trigger=${job.trigger} - conversion started`);
    let lastWrite = 0;
    try {
      const { result, backupPath } = await this.converter.convert(job, settings, controller.signal, {
        onProgress: (progress) => {
          if (Date.now() - lastWrite < PROGRESS_WRITE_MS) return;
          lastWrite = Date.now();
          void this.repo.updateJob(job.id, { progress }).catch(() => undefined);
        },
        readyToSwap: () => this.deferUntil(job),
        enterSwap: () => {
          if (controller.signal.aborted) return false;
          current.cancellable = false;
          return true;
        },
        onSwapping: async () => {
          await this.repo.updateJob(job.id, { stage: 'swapping', progress: 100 });
        },
      });
      await this.repo.updateJob(job.id, {
        status: 'success',
        stage: null,
        progress: 100,
        codecUsed: result.codec,
        result: { ...(job.result ?? {}), ...result },
        backupPath,
        finishedAt: new Date(),
      });
      this.logger.log(
        `[${EVENT}] [end] jobId=${job.id} bookId=${job.bookId} durationMs=${Date.now() - startedAt} files=${result.filesMerged} codec=${result.codec} outcome=success - conversion finished`,
      );
    } catch (error) {
      await this.settleFailure(job, controller.signal, error, startedAt);
    } finally {
      this.current = null;
    }
  }

  private async settleFailure(job: AudioConvertJobRow, signal: AbortSignal, error: unknown, startedAt: number): Promise<void> {
    const durationMs = Date.now() - startedAt;
    const aborted = signal.aborted && (error instanceof FfmpegCancelledError || error instanceof ConvertCancelledError);
    if (error instanceof ConvertDeferredError || (aborted && signal.reason === SHUTDOWN)) {
      const until = error instanceof ConvertDeferredError ? error.until : new Date();
      await this.repo.defer(job.id, until);
      const outcome = error instanceof ConvertDeferredError ? 'deferred' : 'requeued_on_shutdown';
      this.logger.log(
        `[${EVENT}] [end] jobId=${job.id} bookId=${job.bookId} durationMs=${durationMs} outcome=${outcome} - conversion put back in the queue`,
      );
      return;
    }
    if (aborted) {
      await this.repo.updateJob(job.id, {
        status: 'cancelled',
        stage: null,
        progress: null,
        errorCode: null,
        errorMessage: null,
        finishedAt: new Date(),
      });
      this.logger.log(`[${EVENT}] [end] jobId=${job.id} bookId=${job.bookId} durationMs=${durationMs} outcome=cancelled - conversion cancelled`);
      return;
    }
    const code = error instanceof ConvertError ? error.code : 'ffmpeg_failed';
    const message = errorMessage(error);
    await this.repo.updateJob(job.id, {
      status: 'failed',
      stage: null,
      progress: null,
      errorCode: code,
      errorMessage: message.slice(0, 2000),
      finishedAt: new Date(),
    });
    this.logger.error(
      `[${EVENT}] [fail] jobId=${job.id} bookId=${job.bookId} durationMs=${durationMs} errorClass=${errorClass(error)} errorCode=${code} error="${sanitizeLogValue(message)}" - conversion failed`,
    );
  }

  /** Deletes backups past their keep time and forgets old jobs. */
  async housekeeping(): Promise<void> {
    const startedAt = Date.now();
    try {
      const settings = await this.repo.getSettings();
      for (const job of await this.repo.expiredBackups(settings.backupDays)) {
        if (job.backupPath) await this.converter.deleteBackup(job.backupPath);
        await this.repo.updateJob(job.id, { backupDeletedAt: new Date() });
      }
      await this.repo.pruneOldJobs();
    } catch (error) {
      this.logger.error(
        `[audio_convert.housekeeping] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass(error)} error="${sanitizeLogValue(errorMessage(error))}" - housekeeping failed`,
      );
    }
  }
}
