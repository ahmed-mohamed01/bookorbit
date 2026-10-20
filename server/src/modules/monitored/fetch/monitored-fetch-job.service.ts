import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { MonitoredFetchErrorKind } from '@bookorbit/types';
import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import { UserService } from '../../user/user.service';
import { MonitoredCatalogService } from '../monitored-catalog.service';
import { CatalogFetchError, classifyCatalogFetchError } from '../monitored-fetch-error';
import { MonitoredGateway } from '../monitored.gateway';
import { MonitoredProviderConfigService } from '../monitored-provider-config.service';
import { MonitoredService } from '../monitored.service';
import { MonitoredStoreService } from '../monitored-store.service';
import { isHardcoverConfigured } from '../providers/hardcover-bibliography.provider';
import { nextRetryAt } from './monitored-fetch-retry';

export type MonitoredFetchTrigger = 'create' | 'refresh' | 'sync' | 'retry';
type FetchOutcome = { outcome: 'succeeded' | 'failed' | 'skipped'; retryAt: Date | null };

@Injectable()
export class MonitoredFetchJobService {
  private readonly logger = new Logger(MonitoredFetchJobService.name);
  constructor(
    private readonly store: MonitoredStoreService,
    private readonly catalog: MonitoredCatalogService,
    private readonly moduleRef: ModuleRef,
    private readonly gateway: MonitoredGateway,
    private readonly configs: MonitoredProviderConfigService,
    private readonly users: UserService,
  ) {}

  // Resolved at call time: MonitoredService also depends on this provider, so a constructor
  // dependency on it would be a DI cycle.
  private monitored(): MonitoredService {
    return this.moduleRef.get(MonitoredService, { strict: false });
  }

  async run(monitorId: string, trigger: MonitoredFetchTrigger, signal: AbortSignal): Promise<FetchOutcome> {
    const skipped: FetchOutcome = { outcome: 'skipped', retryAt: null };
    if (signal.aborted || !(await this.store.claimFetch(monitorId))) return skipped;
    const startedAt = Date.now();
    let attempts = 0;
    try {
      const monitor = await this.store.getMonitorForFetch(monitorId);
      if (!monitor || signal.aborted) return skipped;
      attempts = monitor.fetchAttempts;
      const owner = await this.users.findByIdWithPermissions(monitor.ownerUserId);
      if (signal.aborted) return skipped;
      if (!owner) {
        await this.store.releaseFetch(monitorId);
        return skipped;
      }
      return await this.runClaimed(monitorId, trigger, signal, monitor, owner.id, startedAt);
    } catch (error) {
      if (signal.aborted) return skipped;
      const now = new Date();
      const failureAttempts = Math.min(attempts + 1, 3);
      const retryAt = nextRetryAt('unavailable', failureAttempts, null, now);
      const written = await this.writeFailure(
        monitorId,
        {
          kind: 'unavailable',
          at: now.toISOString(),
          retryAt: retryAt?.toISOString() ?? null,
          attempts: failureAttempts,
        },
        signal,
        startedAt,
      );
      if (written.written === false || signal.aborted) return skipped;
      this.logger.warn(
        `[monitored.author.fetch] [fail] monitorId=${monitorId} trigger=${trigger} durationMs=${Date.now() - startedAt} errorKind=unavailable errorClass=${error instanceof Error ? error.name : 'Error'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - author fetch failed`,
      );
      return { outcome: 'failed', retryAt: written.retryAt };
    }
  }

  private async runClaimed(
    monitorId: string,
    trigger: MonitoredFetchTrigger,
    signal: AbortSignal,
    monitor: NonNullable<Awaited<ReturnType<MonitoredStoreService['getMonitorForFetch']>>>,
    ownerId: number,
    startedAt: number,
  ): Promise<FetchOutcome> {
    const skipped: FetchOutcome = { outcome: 'skipped', retryAt: null };
    const fields = `monitorId=${monitorId} userId=${ownerId} trigger=${trigger}`;
    this.logger.log(`[monitored.author.fetch] [start] ${fields} - author fetch started`);
    let kind: MonitoredFetchErrorKind | null = null;
    let hint: number | null = null;
    let failure: unknown;
    let works = 0;
    try {
      const config = await this.configs.forUser(ownerId);
      if (signal.aborted) return skipped;
      if (!isHardcoverConfigured(config)) kind = 'not_configured';
      else {
        await this.emit(monitorId, ownerId, signal);
        const result = await this.catalog.fetchCatalog(monitor, config, signal);
        if (signal.aborted) return skipped;
        works = result.catalog.works.length;
        if (
          !(await this.store.finishFetchSucceeded(monitorId, {
            lastRefreshedAt: result.catalog.fetchedAt,
            hardcoverAuthorId: result.hardcoverAuthorId,
            localAuthorId: null,
          }))
        )
          return skipped;
      }
    } catch (error) {
      if (signal.aborted) return skipped;
      failure = error;
      const classified = error instanceof CatalogFetchError ? error : classifyCatalogFetchError(error, signal);
      if (classified === 'aborted') return skipped;
      kind = classified.kind;
      hint = classified.retryAfterSeconds;
    }
    if (kind) {
      if (signal.aborted) return skipped;
      const now = new Date();
      const attempts = Math.min(monitor.fetchAttempts + 1, 3);
      const retryAt = nextRetryAt(kind, attempts, hint, now);
      const written = await this.writeFailure(
        monitorId,
        { kind, at: now.toISOString(), retryAt: retryAt?.toISOString() ?? null, attempts },
        signal,
        startedAt,
      );
      if (written.written === false || signal.aborted) return skipped;
      await this.emit(monitorId, ownerId, signal);
      this.logger.warn(
        `[monitored.author.fetch] [fail] ${fields} durationMs=${Date.now() - startedAt} works=0 errorKind=${kind} errorClass=${failure instanceof Error ? failure.name : 'ServiceUnavailableException'} error="${sanitizeLogValue(failure instanceof Error ? failure.message : 'Hardcover is not configured')}" - author fetch failed`,
      );
      return { outcome: 'failed', retryAt: signal.aborted ? null : written.retryAt };
    }
    await this.emit(monitorId, ownerId, signal);
    if (!signal.aborted) {
      try {
        await this.monitored().runFetchFollowUps(monitorId, trigger);
      } catch (error) {
        this.logger.warn(
          `[monitored.author.fetch_followup] [fail] monitorId=${monitorId} step=followups durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.name : 'Error'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - fetch follow-up failed`,
        );
      }
    }
    this.logger.log(`[monitored.author.fetch] [end] ${fields} durationMs=${Date.now() - startedAt} works=${works} - author fetch completed`);
    return { outcome: 'succeeded', retryAt: null };
  }

  private async writeFailure(
    monitorId: string,
    failure: Parameters<MonitoredStoreService['finishFetchFailed']>[1],
    signal: AbortSignal,
    startedAt: number,
  ): Promise<{ written: boolean | null; retryAt: Date | null }> {
    let retryAt = failure.retryAt ? new Date(failure.retryAt) : null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal.aborted) return { written: false, retryAt: null };
      try {
        const written = await this.store.finishFetchFailed(monitorId, failure);
        return { written, retryAt };
      } catch (error) {
        if (signal.aborted) return { written: false, retryAt: null };
        const now = new Date();
        retryAt = nextRetryAt('unavailable', failure.attempts, null, now);
        failure = { ...failure, kind: 'unavailable', at: now.toISOString(), retryAt: retryAt?.toISOString() ?? null };
        if (attempt === 1) {
          this.logger.warn(
            `[monitored.author.fetch] [fail] monitorId=${monitorId} durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.name : 'Error'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - fetch state write failed`,
          );
        }
      }
    }
    return { written: null, retryAt };
  }

  private async emit(id: string, ownerUserId: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    try {
      const item = await this.monitored().toFetchEventItem(id);
      if (item && !signal.aborted) this.gateway.emitFetch(ownerUserId, item);
    } catch (error) {
      this.logger.warn(
        `[monitored.author.fetch_followup] [fail] monitorId=${id} step=emit durationMs=0 errorClass=${error instanceof Error ? error.name : 'Error'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - fetch event failed`,
      );
    }
  }
}
