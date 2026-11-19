import { ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import type { JobActionKind, JobCounts, JobStatus, JobSubject, MonitoredFetchState } from '@bookorbit/types';

import type { RequestUser } from '../../../common/types/request-user';
import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import type {
  JobAccess,
  JobSource,
  JobViewer,
  SourceActionResult,
  SourceCountQuery,
  SourceItem,
  SourceListQuery,
  SourceRow,
} from '../../jobs/job-source';
import { JobSourceRegistry } from '../../jobs/job-source.registry';
import { isEligibleMonitoredUser } from '../monitored-user.utils';
import { MonitoredService } from '../monitored.service';
import {
  MonitoredFetchJobPageRepository,
  type MonitoredFetchJobActionRow,
  type MonitoredFetchJobPageRow,
} from './monitored-fetch-job-page.repository';

const FAILED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const NATIVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NO_COUNTS: JobCounts = { queue: 0, needsYou: 0, failed: 0, running: 0, queued: 0, paused: 0 };

export interface MonitoredFetchJobSourceRow extends SourceRow {
  job: MonitoredFetchJobPageRow;
}

function status(state: MonitoredFetchState): JobStatus {
  switch (state) {
    case 'fetching':
      return 'running';
    case 'queued':
      return 'queued';
    case 'failed':
      return 'failed';
    default:
      return 'completed';
  }
}

/** The error kind, marked when the fetch already has its own retry scheduled. */
function reason(job: Pick<MonitoredFetchJobPageRow, 'fetchState' | 'fetchErrorKind' | 'fetchRetryAt'>): string | null {
  if (job.fetchState !== 'failed') return null;
  const kind = job.fetchErrorKind ?? 'unavailable';
  return job.fetchRetryAt ? `${kind}-retrying` : kind;
}

function authorUrl(id: string): string {
  return `/watchlist/authors/${encodeURIComponent(id)}`;
}

function portraitUrl(id: string): string {
  return `/api/v1/monitored/authors/${encodeURIComponent(id)}/portrait`;
}

/**
 * Fork: Watchlist updates in the Jobs area, one row per monitored author for its latest fetch. Rows
 * are the owner's own with no administrator view, exactly as the Watchlist routes read them. The only
 * action is Try again on a failed fetch, which is the Watchlist's own Refresh.
 */
@Injectable()
export class MonitoredFetchJobSource implements JobSource<MonitoredFetchJobSourceRow>, OnModuleInit {
  readonly type = 'watchlist-fetch' as const;
  readonly failedWindowMs = FAILED_WINDOW_MS;
  private readonly logger = new Logger(MonitoredFetchJobSource.name);

  constructor(
    private readonly registry: JobSourceRegistry,
    private readonly jobs: MonitoredFetchJobPageRepository,
    private readonly monitored: MonitoredService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** Who may hold a Watchlist: the same rule the background fetch checks before it runs for an owner. */
  access(user: RequestUser): JobAccess {
    return { own: isEligibleMonitoredUser(user), all: false };
  }

  async list(query: SourceListQuery, viewer: JobViewer): Promise<MonitoredFetchJobSourceRow[]> {
    if (query.owner === null) return [];
    const rows = await this.jobs.pageForJobs({
      view: query.view,
      ownerUserId: query.owner.id,
      cutoffAt: query.cutoffAt,
      after: query.after,
      typeIndex: query.typeIndex,
      limit: query.limit,
    });
    return rows.map((job) => ({ nativeId: job.id, key: job.key, job, item: this.item(job, viewer.user) }));
  }

  async counts(query: SourceCountQuery): Promise<JobCounts> {
    if (query.owner === null) return NO_COUNTS;
    return await this.jobs.countForJobs(query.owner.id, query.cutoffAt);
  }

  async describe(rows: MonitoredFetchJobSourceRow[]): Promise<Map<string, JobSubject>> {
    const portraits = await this.monitored.findMonitorsWithPortraits(rows.map((row) => row.job));
    return new Map(
      rows.map((row) => [
        row.nativeId,
        { label: row.job.authorName, byline: null, url: authorUrl(row.job.id), image: portraits.has(row.job.id) ? portraitUrl(row.job.id) : null },
      ]),
    );
  }

  actions(row: MonitoredFetchJobSourceRow, viewer: JobViewer): { actions: JobActionKind[]; note: string | null } {
    if (row.job.ownerUserId !== viewer.user.id || row.job.fetchState !== 'failed') return { actions: [], note: null };
    return { actions: ['retry'], note: null };
  }

  async act(action: JobActionKind, nativeIds: string[], viewer: JobViewer): Promise<SourceActionResult[]> {
    const startedAt = Date.now();
    const unique = [...new Set(nativeIds)];
    const rows = new Map((await this.jobs.findActionRows(unique.filter((id) => NATIVE_ID.test(id)))).map((row) => [row.id, row]));
    const results = new Map<string, SourceActionResult>();
    for (const id of unique) results.set(id, await this.actOn(action, id, rows.get(id) ?? null, viewer.user));
    const done = [...results.values()].filter((result) => result.outcome === 'done').length;
    this.logger.log(
      `[monitored.jobs_action] [end] userId=${viewer.user.id} action=${action} jobs=${unique.length} done=${done} durationMs=${Date.now() - startedAt} - watchlist update action taken`,
    );
    return nativeIds.map((id) => results.get(id)!);
  }

  /** Someone else's monitor cannot be told from a missing one. */
  private async actOn(action: JobActionKind, id: string, row: MonitoredFetchJobActionRow | null, user: RequestUser): Promise<SourceActionResult> {
    const startedAt = Date.now();
    if (!row || row.ownerUserId !== user.id) return { id, outcome: 'not-found', status: null };
    const result = (outcome: SourceActionResult['outcome'], current: MonitoredFetchState = row.fetchState): SourceActionResult => ({
      id,
      outcome,
      status: status(current),
    });
    if (action !== 'retry' || row.fetchState !== 'failed') return result('skipped');
    if (!isEligibleMonitoredUser(user)) return result('refused');
    try {
      const item = await this.monitored.refreshAuthor(row.id, user);
      return item.fetch.state === 'failed' ? result('skipped', item.fetch.state) : result('done', item.fetch.state);
    } catch (error) {
      if (error instanceof NotFoundException) return { id, outcome: 'not-found', status: null };
      // No longer the owner, or the Watchlist's refresh cooldown.
      if (error instanceof ForbiddenException || (error instanceof HttpException && error.getStatus() === Number(HttpStatus.TOO_MANY_REQUESTS))) {
        return result('refused');
      }
      this.logger.warn(
        `[monitored.jobs_action] [fail] monitorId=${row.id} userId=${user.id} action=${action} durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.name : 'Error'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - watchlist update action failed`,
      );
      return result('error');
    }
  }

  /** Every row is the viewer's own, so the requester is the viewer. */
  private item(job: MonitoredFetchJobPageRow, viewer: RequestUser): SourceItem {
    const queuedAt = job.fetchQueuedAt ?? job.addedAt;
    const finishedAt = job.fetchState === 'failed' ? job.fetchErrorAt : job.fetchState === 'idle' ? job.lastRefreshedAt : null;
    return {
      kind: null,
      shape: 'job',
      status: status(job.fetchState),
      reason: reason(job),
      phase: null,
      done: null,
      total: null,
      percent: null,
      position: null,
      requester: { id: job.ownerUserId, name: viewer.name },
      cost: null,
      createdAt: queuedAt.toISOString(),
      startedAt: job.fetchState === 'fetching' ? (job.fetchStartedAt ?? queuedAt).toISOString() : null,
      pausedAt: null,
      finishedAt: finishedAt?.toISOString() ?? null,
      extra: null,
    };
  }
}
