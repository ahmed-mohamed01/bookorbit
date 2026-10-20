import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import { isDueForAutomaticFetch } from '../monitored-fetch-due';
import { MonitoredGateway } from '../monitored.gateway';
import { MonitoredService } from '../monitored.service';
import { MonitoredSettingsService } from '../monitored-settings.service';
import { MonitoredStoreService } from '../monitored-store.service';
import { MonitoredFetchJobService, type MonitoredFetchTrigger } from './monitored-fetch-job.service';
import { MonitoredFetchQueue } from './monitored-fetch-queue';

@Injectable()
export class MonitoredFetchCoordinator implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MonitoredFetchCoordinator.name);
  private readonly triggers = new Map<string, MonitoredFetchTrigger>();
  private queue: MonitoredFetchQueue | undefined;
  private cursor: { addedAt: string; id: string } | null = null;
  private stopped = false;

  constructor(
    private readonly store: MonitoredStoreService,
    private readonly job: MonitoredFetchJobService,
    private readonly moduleRef: ModuleRef,
    private readonly gateway: MonitoredGateway,
    private readonly settings: MonitoredSettingsService,
  ) {}

  // Resolved at call time: MonitoredService also depends on this provider, so a constructor
  // dependency on it would be a DI cycle.
  private monitored(): MonitoredService {
    return this.moduleRef.get(MonitoredService, { strict: false });
  }

  // Bind callbacks after Nest resolves the circular provider so they share its lifecycle state.
  private get fetchQueue(): MonitoredFetchQueue {
    return (this.queue ??= new MonitoredFetchQueue({
      concurrency: 2,
      pendingCap: 500,
      run: (id, signal) => this.run(id, signal),
      refill: () => this.refill(),
      onError: (id, error) => this.logFailure(id, error),
    }));
  }

  async request(monitorId: string, trigger: MonitoredFetchTrigger): Promise<boolean> {
    if (this.stopped || !(await this.store.markFetchQueued(monitorId))) return false;
    this.fetchQueue.clearRetry(monitorId);
    this.triggers.set(monitorId, trigger);
    try {
      const item = await this.monitored().toFetchEventItem(monitorId);
      if (item && !this.stopped) this.gateway.emitFetch(item.ownerUserId, item);
    } catch (error) {
      this.logFailure(monitorId, error);
    }
    this.fetchQueue.enqueue(monitorId);
    return true;
  }

  enqueueInserted(monitorId: string): void {
    if (this.stopped) return;
    this.triggers.set(monitorId, 'create');
    this.fetchQueue.enqueue(monitorId);
  }

  cancel(monitorId: string): void {
    this.triggers.delete(monitorId);
    this.fetchQueue.cancel(monitorId);
  }

  clearRetry(monitorId: string): void {
    this.fetchQueue.clearRetry(monitorId);
  }

  async onApplicationBootstrap(): Promise<void> {
    const startedAt = Date.now();
    this.logger.log('[monitored.fetch_recovery] [start] - fetch recovery started');
    // Recovery is best effort: a failure here must not stop the server from starting. Rows left
    // queued are picked up by the next refill, and overdue retries by the hourly sync.
    try {
      const reset = await this.store.resetInterruptedFetches();
      const ids = await this.refill();
      for (const id of ids) this.fetchQueue.enqueue(id);
      const retries = await this.store.findPendingRetries();
      for (const { id, retryAt } of retries) {
        const at = new Date(retryAt);
        if (at.getTime() > Date.now()) this.fetchQueue.scheduleRetry(id, at);
        else await this.requestRetry(id);
      }
      this.logger.log(
        `[monitored.fetch_recovery] [end] durationMs=${Date.now() - startedAt} reset=${reset} queued=${ids.length} retries=${retries.length} - fetch recovery completed`,
      );
    } catch (error) {
      this.logger.warn(
        `[monitored.fetch_recovery] [fail] durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.name : 'Error'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - fetch recovery failed`,
      );
    }
  }

  onModuleDestroy(): void {
    this.stopped = true;
    this.fetchQueue.stop();
    this.triggers.clear();
  }

  private async run(id: string, signal: AbortSignal): Promise<void> {
    const monitor = await this.store.getMonitorForFetch(id);
    if (!monitor || signal.aborted) {
      this.triggers.delete(id);
      return;
    }
    // Retry timers enter the same bounded queue; transition only after checking fresh eligibility.
    if (monitor.fetch.state === 'failed' && !(await this.requestRetry(id))) return;
    const trigger = this.triggers.get(id) ?? 'retry';
    this.triggers.delete(id);
    if (signal.aborted) return;
    const result = await this.job.run(id, trigger, signal);
    if (result.retryAt && !signal.aborted) this.fetchQueue.scheduleRetry(id, result.retryAt);
  }

  private async requestRetry(id: string): Promise<boolean> {
    const monitor = await this.store.getMonitorForFetch(id);
    if (!monitor || this.stopped) return false;
    const { syncIntervalHours } = await this.settings.getMonitoredSettings();
    const date = (value: string | null | undefined) => (value ? new Date(value) : null);
    if (
      !isDueForAutomaticFetch(
        {
          paused: monitor.paused,
          anyFormatOn: Object.values(monitor.formats).some((format) => format?.mode !== 'off'),
          fetchState: monitor.fetch.state,
          fetchErrorKind: monitor.fetch.errorKind,
          fetchRetryAt: date(monitor.fetch.retryAt),
          lastSyncAttemptedAt: null,
          lastRefreshedAt: date(monitor.lastRefreshedAt),
        },
        new Date(),
        syncIntervalHours,
      )
    )
      return false;
    return this.request(id, 'retry');
  }

  private async refill(): Promise<string[]> {
    if (this.stopped) return [];
    let rows = await this.store.findQueuedFetches(this.cursor, 100);
    if (!rows.length && this.cursor) rows = await this.store.findQueuedFetches(null, 100);
    this.cursor = rows.length === 100 ? rows[rows.length - 1] : null;
    return rows.map((row) => row.id);
  }

  private logFailure(id: string, error: unknown): void {
    this.logger.warn(
      `[monitored.fetch_queue] [fail] monitorId=${id} durationMs=0 errorClass=${error instanceof Error ? error.name : 'Error'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - fetch queue operation failed`,
    );
  }
}
