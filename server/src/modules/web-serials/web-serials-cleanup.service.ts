import { Injectable, Logger } from '@nestjs/common';

import { SystemCron } from '../../common/decorators/system-cron.decorator';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { WebSerialsImportService } from './web-serials-import.service';
import { WebSerialsJobRunnerService } from './web-serials-job-runner.service';
import { describeError } from './web-serials-log.utils';
import { WebSerialsRepository } from './web-serials.repository';

const CLEANUP_EVENT = 'web_serials.job.cleanup';
const SWEEP_EVENT = 'web_serials.workdir.sweep';
const RETENTION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class WebSerialsCleanupService {
  private readonly logger = new Logger(WebSerialsCleanupService.name);

  constructor(
    private readonly repo: WebSerialsRepository,
    private readonly importer: WebSerialsImportService,
    private readonly runner: WebSerialsJobRunnerService,
  ) {}

  @SystemCron('30 3 * * *')
  async cleanupFinishedJobs(): Promise<number> {
    const startedAt = Date.now();
    this.logger.log(`[${CLEANUP_EVENT}] [start] retentionDays=${RETENTION_DAYS} - finished job cleanup started`);
    try {
      const removed = await this.repo.deleteFinishedJobsBefore(new Date(Date.now() - RETENTION_DAYS * DAY_MS));
      await this.sweepWorkDirs();
      this.logger.log(
        `[${CLEANUP_EVENT}] [end] retentionDays=${RETENTION_DAYS} durationMs=${Date.now() - startedAt} removed=${removed} - finished job cleanup completed`,
      );
      return removed;
    } catch (err) {
      const { errorClass, message } = describeError(err);
      this.logger.error(
        `[${CLEANUP_EVENT}] [fail] retentionDays=${RETENTION_DAYS} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - finished job cleanup failed`,
      );
      return 0;
    }
  }

  /**
   * Removes the work folders of jobs that completed, were cancelled, moved or removed. A job that can still resume, or a
   * failed or gapped one that Retry would resume, keeps its folder until it is removed, cleared or 14 days old.
   */
  @SystemCron('15 * * * *')
  async sweepWorkDirs(): Promise<number> {
    const startedAt = Date.now();
    try {
      const jobIds = await this.importer.listWorkJobIds();
      if (jobIds.length === 0) return 0;
      this.logger.log(`[${SWEEP_EVENT}] [start] folders=${jobIds.length} - work folder sweep started`);
      const kept = new Set(await this.repo.findJobIdsKeepingWorkDirs(jobIds));
      let removed = 0;
      for (const jobId of jobIds) {
        if (kept.has(jobId) || this.runner.isJobActive(jobId)) continue;
        await this.importer.removeJobWorkDir(jobId);
        removed += 1;
      }
      this.logger.log(
        `[${SWEEP_EVENT}] [end] folders=${jobIds.length} durationMs=${Date.now() - startedAt} removed=${removed} - work folder sweep completed`,
      );
      return removed;
    } catch (err) {
      const { errorClass, message } = describeError(err);
      this.logger.error(
        `[${SWEEP_EVENT}] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - work folder sweep failed`,
      );
      return 0;
    }
  }
}
