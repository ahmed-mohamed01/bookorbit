import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { MonitoredAuthorConfig } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { AppSettingsService } from '../app-settings/app-settings.service';
import { UserService } from '../user/user.service';
import { MonitoredReleaseWatcher } from './monitored-release-watcher.service';
import { MonitoredService } from './monitored.service';
import { MonitoredStoreService } from './monitored-store.service';

/**
 * Monitors refreshed per tick. Each one is three provider fetches for the owner, so this is the
 * dial that keeps a large instance from spending its whole Hardcover budget in one minute.
 */
const MONITORS_PER_TICK = 10;

/** Half past, so a sync tick and the release watcher's own hourly sweep never start together. */
const SYNC_CRON = '0 30 * * * *';

/**
 * Keeps monitored catalogs current so the release watcher has something to watch.
 *
 * Without this the catalog only changes when somebody opens the page and clicks Refresh, which
 * means a book announced after that click is invisible and a date the publisher moves is never
 * picked up. Modelled on the Audiobookshelf sync scheduler: page through owners, isolate every
 * failure to one monitor, and never let a slow provider wedge the next tick.
 *
 * The release check runs immediately after each refresh rather than waiting for the watcher's own
 * hourly tick, so a date that arrives with a sync is announced in the same pass.
 */
@Injectable()
export class MonitoredSyncSchedulerService {
  private readonly logger = new Logger(MonitoredSyncSchedulerService.name);
  private running = false;

  constructor(
    private readonly store: MonitoredStoreService,
    private readonly monitored: MonitoredService,
    private readonly watcher: MonitoredReleaseWatcher,
    private readonly users: UserService,
    private readonly appSettings: AppSettingsService,
  ) {}

  @Cron(SYNC_CRON)
  async runScheduledSync(): Promise<void> {
    if (this.running) {
      this.logger.log('[monitored.sync] skipped=true - previous run still in flight');
      return;
    }
    this.running = true;
    const startedAt = Date.now();
    let refreshed = 0;
    let skipped = 0;
    let failed = 0;
    try {
      const { syncEnabled, syncIntervalHours } = await this.appSettings.getMonitoredSettings();
      if (!syncEnabled) return;

      const staleBefore = new Date(Date.now() - syncIntervalHours * 60 * 60 * 1000);
      const [monitors, due] = await Promise.all([
        this.store.findMonitorsDueForSync(staleBefore, MONITORS_PER_TICK),
        this.store.countMonitorsDueForSync(staleBefore),
      ]);
      if (monitors.length === 0) return;
      this.logger.log(`[monitored.sync] [start] monitors=${monitors.length} due=${due} intervalHours=${syncIntervalHours} - catalog sync started`);

      for (const monitor of monitors) {
        const monitorStartedAt = Date.now();
        let outcome: 'refreshed' | 'skipped' | null = null;
        try {
          outcome = await this.syncMonitor(monitor);
        } catch (error) {
          failed++;
          this.logMonitorFailure('monitored.sync.monitor', monitor, monitorStartedAt, error);
        }

        try {
          await this.store.stampSyncAttempt(monitor.id, new Date());
        } catch (stampError) {
          this.logMonitorFailure('monitored.sync.stamp', monitor, monitorStartedAt, stampError);
        }

        if (outcome === null) continue;
        if (outcome === 'skipped') {
          skipped++;
          continue;
        }
        refreshed++;
        await this.checkReleases(monitor);
      }

      this.logger.log(
        `[monitored.sync] [end] durationMs=${Date.now() - startedAt} due=${due} refreshed=${refreshed} skipped=${skipped} failed=${failed} - catalog sync completed`,
      );
    } catch (error) {
      const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError';
      const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
      this.logger.warn(
        `[monitored.sync] [fail] durationMs=${Date.now() - startedAt} refreshed=${refreshed} errorClass=${errorClass} error="${message}" - catalog sync failed`,
      );
    } finally {
      this.running = false;
    }
  }

  private async syncMonitor(monitor: MonitoredAuthorConfig): Promise<'refreshed' | 'skipped'> {
    const owner: RequestUser | null = await this.users.findByIdWithPermissions(monitor.ownerUserId);
    if (!owner) return 'skipped';

    const didRefresh = await this.monitored.refreshForSchedule(monitor, owner);
    if (!didRefresh) return 'skipped';

    return 'refreshed';
  }

  private async checkReleases(monitor: MonitoredAuthorConfig): Promise<void> {
    // A refresh that threw leaves the catalog as it was, so the check only runs on a clean pass.
    // Its own failures are already contained; they must not turn a good refresh into a failure.
    const releaseCheckStartedAt = Date.now();
    try {
      await this.watcher.checkMonitor(monitor);
    } catch (error) {
      const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError';
      const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
      this.logger.warn(
        `[monitored.sync.release_check] [fail] monitorId="${sanitizeLogValue(monitor.id)}" userId=${monitor.ownerUserId} durationMs=${Date.now() - releaseCheckStartedAt} errorClass=${errorClass} error="${message}" - post-sync release check failed`,
      );
    }
  }

  private logMonitorFailure(event: string, monitor: MonitoredAuthorConfig, startedAt: number, error: unknown): void {
    const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError';
    const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
    this.logger.warn(
      `[${event}] [fail] monitorId="${sanitizeLogValue(monitor.id)}" userId=${monitor.ownerUserId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${message}" - scheduled monitor sync failed`,
    );
  }
}
