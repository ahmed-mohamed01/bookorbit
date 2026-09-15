import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { MonitoredAuthorConfig } from '@bookorbit/types';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { UserService } from '../user/user.service';
import { MonitoredReleaseNotifier } from './monitored-release-notifier.service';
import { MonitoredStoreService, type MonitoredDueRelease } from './monitored-store.service';
import { releaseDueDay } from './release-window';

/**
 * On the hour. Deliberately not the same minute as the catalog sync, which runs its own release
 * check after each refresh: the ledger lease decides who announces when they do overlap, but not
 * overlapping in the first place is cheaper than resolving it.
 */
const RELEASE_SWEEP_CRON = '0 0 * * * *';

/** Monitors looked at per tick. One tick is cheap; starving the tail for an hour is not. */
const MONITORS_PER_TICK = 50;

/**
 * Releases announced per monitor per tick. A ceiling rather than a budget: on a healthy instance a
 * monitor produces nought or one, and a monitor that somehow produces two hundred is a data problem
 * that should not arrive as two hundred notifications in one minute.
 */
const RELEASES_PER_MONITOR = 25;
const SEED_LIMIT = 2000;

/** Sibling format rows of one work, in first-seen order, the same fold the Releases tab applies. */
function groupByWork(releases: MonitoredDueRelease[]): MonitoredDueRelease[][] {
  const groups = new Map<string, MonitoredDueRelease[]>();
  for (const release of releases) {
    const group = groups.get(release.workId);
    if (group) group.push(release);
    else groups.set(release.workId, [release]);
  }
  return [...groups.values()];
}

interface ReleaseSweepResult {
  monitorsChecked: number;
  monitorsFailed: number;
  seeded: number;
  announced: number;
  failed: number;
}

export interface ReleaseCheckResult {
  seeded: number;
  announced: number;
  failed: number;
  releases: MonitoredDueRelease[];
}

/**
 * Watches stored release dates and tells the owner when one arrives.
 *
 * This is the piece that made `notify` mode mean something: every mode but `off` was previously
 * read only to decide whether a work appeared in a list, so a user who asked to be told about new
 * releases was never told anything. The sweep is pure SQL over dates the catalog already holds, so
 * it costs no provider call and runs on the hour regardless of whether a catalog sync is enabled.
 *
 * It deliberately stops at the notification. `checkMonitor` returns what it announced so the
 * auto-request path can consume the same list without the detection rules being written twice.
 */
@Injectable()
export class MonitoredReleaseWatcher {
  private readonly logger = new Logger(MonitoredReleaseWatcher.name);
  private sweeping = false;

  constructor(
    private readonly store: MonitoredStoreService,
    private readonly notifier: MonitoredReleaseNotifier,
    private readonly users: UserService,
  ) {}

  @Cron(RELEASE_SWEEP_CRON)
  async sweepReleases(): Promise<void> {
    if (this.sweeping) {
      this.logger.log('[monitored.release.sweep] skipped=true - previous sweep still in flight');
      return;
    }
    this.sweeping = true;
    const startedAt = Date.now();
    const totals: ReleaseSweepResult = { monitorsChecked: 0, monitorsFailed: 0, seeded: 0, announced: 0, failed: 0 };
    try {
      const monitors = await this.store.findMonitorsDueForReleaseCheck(MONITORS_PER_TICK);
      if (monitors.length === 0) return;
      this.logger.log(`[monitored.release.sweep] [start] monitors=${monitors.length} - release sweep started`);

      for (const { monitor, lastReleaseCheckAt } of monitors) {
        const checkStartedAt = Date.now();
        totals.monitorsChecked++;
        try {
          const result = await this.checkMonitor(monitor, lastReleaseCheckAt);
          totals.seeded += result.seeded;
          totals.announced += result.announced;
          totals.failed += result.failed;
        } catch (error) {
          totals.monitorsFailed++;
          const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError';
          const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
          this.logger.warn(
            `[monitored.release.check] [fail] monitorId="${sanitizeLogValue(monitor.id)}" userId=${monitor.ownerUserId} durationMs=${Date.now() - checkStartedAt} errorClass=${errorClass} error="${message}" - monitor release check failed`,
          );
          if (lastReleaseCheckAt !== null) {
            // Failed seed passes stay unstamped so the next tick cannot announce the back catalog.
            try {
              await this.store.stampReleaseCheck(monitor.id, new Date());
            } catch (stampError) {
              this.logLeaseReleaseFailure('monitored.release.check_stamp', monitor, null, checkStartedAt, stampError);
            }
          }
        }
      }

      this.logger.log(
        `[monitored.release.sweep] [end] durationMs=${Date.now() - startedAt} monitorsChecked=${totals.monitorsChecked} monitorsFailed=${totals.monitorsFailed} seeded=${totals.seeded} announced=${totals.announced} failed=${totals.failed} - release sweep completed`,
      );
    } catch (error) {
      const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError';
      const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
      this.logger.warn(
        `[monitored.release.sweep] [fail] durationMs=${Date.now() - startedAt} monitorsChecked=${totals.monitorsChecked} errorClass=${errorClass} error="${message}" - release sweep failed`,
      );
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * One monitor's worth of detection.
   *
   * The first pass over a monitor records its qualifying works as already announced and dispatches
   * nothing, because otherwise switching this feature on would fire one notification for every book
   * that came out since the monitor was added. Whether a pass is that first one is decided here and
   * nowhere else, from the stamp rather than from the presence of ledger rows: a monitor created
   * yesterday also has no rows, and reading that as "seed me" would swallow its first real release.
   *
   * Returns the releases it announced so a caller can act on them further; the sweep ignores them.
   */
  async checkMonitor(monitor: MonitoredAuthorConfig, suppliedStamp?: Date | null): Promise<ReleaseCheckResult> {
    const startedAt = Date.now();
    const empty: ReleaseCheckResult = { seeded: 0, announced: 0, failed: 0, releases: [] };
    const owner = await this.users.findByIdWithPermissions(monitor.ownerUserId);
    if (!owner) {
      await this.store.stampReleaseCheck(monitor.id, new Date());
      return empty;
    }
    const stamp = suppliedStamp === undefined ? await this.store.findReleaseCheckStamp(monitor.id) : suppliedStamp;
    const seed = stamp === null;

    const today = new Date().toISOString().slice(0, 10);
    if (seed) {
      this.logger.log(
        `[monitored.release.seed] [start] monitorId="${sanitizeLogValue(monitor.id)}" userId=${monitor.ownerUserId} - release seed started`,
      );
    }
    const due = await this.store.findDueReleases({ owner, monitor, today, limit: seed ? SEED_LIMIT : RELEASES_PER_MONITOR });
    if (seed) {
      const silent = due.filter((release) => releaseDueDay(release.storedDate) !== today);
      const inserted = await this.store.claimReleaseEvents(monitor, silent, false);
      const truncated = due.length === SEED_LIMIT;
      this.logger.log(
        `[monitored.release.seed] [end] monitorId="${sanitizeLogValue(monitor.id)}" userId=${monitor.ownerUserId} durationMs=${Date.now() - startedAt} seeded=${inserted.size} truncated=${truncated} - existing releases recorded without announcing`,
      );
      if (truncated) return { ...empty, seeded: inserted.size };
      await this.store.stampReleaseCheck(monitor.id, new Date());
      return { ...empty, seeded: inserted.size };
    }

    if (due.length === 0) {
      await this.store.stampReleaseCheck(monitor.id, new Date());
      return empty;
    }

    let candidates = due;
    if (due.length === RELEASES_PER_MONITOR) {
      const trailingWorkId = due[due.length - 1].workId;
      let trailingStart = due.length - 1;
      while (trailingStart > 0 && due[trailingStart - 1].workId === trailingWorkId) trailingStart--;
      if (trailingStart > 0) candidates = due.slice(0, trailingStart);
    }

    await this.store.claimReleaseEvents(monitor, candidates, true);

    // The ledger and the lease stay per format: that is the unit of "told once" and what the
    // auto-request path consumes. Only the announcement folds a work's formats into one message.
    let announced = 0;
    let failed = 0;
    const releases: MonitoredDueRelease[] = [];
    for (const group of groupByWork(candidates)) {
      const leased: MonitoredDueRelease[] = [];
      for (const release of group) {
        if (await this.store.leaseReleaseEvent(release.workId, release.format, monitor.ownerUserId)) leased.push(release);
      }
      if (leased.length === 0) continue;
      const dispatchStartedAt = Date.now();
      try {
        await this.notifier.notifyRelease(monitor, leased);
        announced += leased.length;
        releases.push(...leased);
      } catch (error) {
        failed += leased.length;
        for (const release of leased) {
          try {
            await this.store.releaseReleaseEventLease(release.workId, release.format, monitor.ownerUserId);
          } catch (leaseError) {
            this.logLeaseReleaseFailure('monitored.release.lease_release', monitor, release, dispatchStartedAt, leaseError);
          }
        }
        this.notifier.logDispatchFailure(monitor, leased, dispatchStartedAt, error);
      }
    }

    // Stamped whatever happened: the stamp only says "the watcher has seen this monitor", and the
    // unnotified ledger rows are what carry a failure forward to the next tick.
    await this.store.stampReleaseCheck(monitor.id, new Date());
    return { seeded: 0, announced, failed, releases };
  }

  private logLeaseReleaseFailure(
    event: string,
    monitor: MonitoredAuthorConfig,
    release: MonitoredDueRelease | null,
    startedAt: number,
    error: unknown,
  ): void {
    const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError';
    const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
    const releaseFields = release ? ` workId="${sanitizeLogValue(release.workId)}" format=${release.format}` : '';
    this.logger.warn(
      `[${event}] [fail] monitorId="${sanitizeLogValue(monitor.id)}" userId=${monitor.ownerUserId}${releaseFields} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${message}" - release watcher state update failed`,
    );
  }
}
