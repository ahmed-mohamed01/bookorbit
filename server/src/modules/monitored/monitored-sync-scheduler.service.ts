import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { MonitoredAuthorConfig } from '@bookorbit/types';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { MonitoredFetchCoordinator } from './fetch/monitored-fetch-coordinator.service';
import { MonitoredStoreService } from './monitored-store.service';
import { MonitoredSettingsService } from './monitored-settings.service';

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
 * Without this the catalog only changes when somebody clicks Refresh, so a book announced after that
 * click is invisible and a date the publisher moves is never picked up. Each tick only queues the due
 * monitors on the fetch coordinator; the fetch, its retries and the release check that follows it run
 * there, so a slow provider never wedges the next tick.
 */
@Injectable()
export class MonitoredSyncSchedulerService {
  private readonly logger = new Logger(MonitoredSyncSchedulerService.name);
  private running = false;

  constructor(
    private readonly store: MonitoredStoreService,
    private readonly coordinator: MonitoredFetchCoordinator,
    private readonly settings: MonitoredSettingsService,
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
      const { syncEnabled, syncIntervalHours } = await this.settings.getMonitoredSettings();
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
        try {
          await this.store.stampSyncAttempt(monitor.id, new Date());
          if (await this.coordinator.request(monitor.id, 'sync')) refreshed++;
          else skipped++;
        } catch (error) {
          failed++;
          this.logMonitorFailure('monitored.sync.monitor', monitor, monitorStartedAt, error);
        }
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

  private logMonitorFailure(event: string, monitor: MonitoredAuthorConfig, startedAt: number, error: unknown): void {
    const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError';
    const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
    this.logger.warn(
      `[${event}] [fail] monitorId="${sanitizeLogValue(monitor.id)}" userId=${monitor.ownerUserId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${message}" - scheduled monitor sync failed`,
    );
  }
}
