import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import {
  Permission,
  type JobActionKind,
  type JobCounts,
  type JobStatus,
  type JobSubject,
  type WebSerialJobStatus,
  type JobReorderRequest,
  type JobReorderResult,
} from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import type { JobAccess, JobViewer, SourceActionResult, SourceCountQuery, SourceItem, SourceListQuery, SourceRow } from '../jobs/job-source';
import type { ReorderableJobSource } from '../fork-job-reorder/reorderable-job-source';
import { JobSourceRegistry } from '../jobs/job-source.registry';
import { isWebSerialsAdmin } from './web-serials-job-view.utils';
import { WebSerialsJobPageRepository, type WebSerialJobActionRow, type WebSerialJobPageRow } from './web-serials-job-page.repository';
import { WebSerialJobsService } from './web-serials-jobs.service';
import { seriesCoverPath } from './web-serials-series-key.utils';

/** Finished downloads are removed after 14 days; a failed one shows under Failed for the first seven. */
const FAILED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const NATIVE_ID = /^[1-9][0-9]{0,9}$/;
const QUEUE_URL = '/web-serials?tab=queue';
const RUNNING = new Set<WebSerialJobStatus>(['running', 'importing']);
const FINISHED = new Set<WebSerialJobStatus>(['completed', 'completed_with_gaps', 'failed', 'cancelled']);
const PAUSABLE = new Set<WebSerialJobStatus>(['queued', 'running', 'importing']);
const CANCELLABLE = new Set<WebSerialJobStatus>(['queued', 'running', 'importing', 'paused']);
const RETRYABLE = new Set<WebSerialJobStatus>(['failed', 'completed_with_gaps']);

export interface WebSerialJobSourceRow extends SourceRow {
  job: WebSerialJobPageRow;
}

/** Every web serial route answers to `WebSerialAccess` first; the admin view needs it as well. */
function mayUse(user: RequestUser): boolean {
  return user.active && (user.isSuperuser || user.permissions.includes(Permission.WebSerialAccess));
}

function status(value: WebSerialJobStatus): JobStatus {
  switch (value) {
    case 'running':
    case 'importing':
      return 'running';
    case 'completed':
    case 'completed_with_gaps':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'paused':
      return 'paused';
    default:
      return 'queued';
  }
}

function phase(job: WebSerialJobPageRow): string | null {
  if (!RUNNING.has(job.status)) return null;
  if (job.status === 'importing') return 'importing';
  return job.currentUnit?.stage ?? null;
}

/**
 * Admins reorder the whole queue, everyone else only their own jobs (`moveJobToTop`'s own rule), so an
 * admin's move is a prioritize and anyone else's a move to the top of their own line.
 */
function moveAction(user: RequestUser): JobActionKind {
  return isWebSerialsAdmin(user) ? 'prioritize' : 'move-to-top';
}

function offered(job: Pick<WebSerialJobPageRow, 'status' | 'rank' | 'ownRank' | 'laneSize' | 'ownLaneSize'>, user: RequestUser): JobActionKind[] {
  const actions: JobActionKind[] = [];
  if (RETRYABLE.has(job.status)) actions.push('retry');
  if (job.status === 'paused') actions.push('resume');
  if (PAUSABLE.has(job.status)) actions.push('pause');
  if (job.status === 'queued') {
    const admin = isWebSerialsAdmin(user);
    const rank = admin ? job.rank : job.ownRank;
    if (rank > 1) actions.push(moveAction(user), 'move-up');
    if (rank < (admin ? job.laneSize : job.ownLaneSize)) actions.push('move-down');
  }
  if (CANCELLABLE.has(job.status)) actions.push('cancel');
  return actions;
}

/** Whether an action applies to a job in this state; the service decides the rest. */
function applies(action: JobActionKind, row: WebSerialJobActionRow, user: RequestUser): boolean {
  switch (action) {
    case 'cancel':
      return CANCELLABLE.has(row.status);
    case 'pause':
      return PAUSABLE.has(row.status);
    case 'resume':
      return row.status === 'paused';
    case 'retry':
      return RETRYABLE.has(row.status);
    case 'move-to-top':
    case 'prioritize':
      return row.status === 'queued' && action === moveAction(user);
    default:
      return false;
  }
}

/** Only its owner or an admin pauses a download, so a paused one waits for someone to resume it. */
function reason(job: WebSerialJobPageRow): string | null {
  if (job.status === 'paused') return 'user';
  return job.status === 'completed_with_gaps' && job.unitsFailed === 0 ? 'warnings' : null;
}

/**
 * Fork: web serial downloads in the Jobs area. A user sees their own downloads, an admin everyone's,
 * exactly as the Web Serials queue's `mine` and `all` scopes do. Every action goes through
 * `WebSerialJobsService`, which checks ownership again. Removing a finished job stays on the queue page.
 */
@Injectable()
export class WebSerialsJobSource implements ReorderableJobSource<WebSerialJobSourceRow>, OnModuleInit {
  readonly type = 'web-serial' as const;
  readonly failedWindowMs = FAILED_WINDOW_MS;
  private readonly logger = new Logger(WebSerialsJobSource.name);

  constructor(
    private readonly registry: JobSourceRegistry,
    private readonly jobs: WebSerialsJobPageRepository,
    private readonly service: WebSerialJobsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  access(user: RequestUser): JobAccess {
    const own = mayUse(user);
    return { own, all: own && isWebSerialsAdmin(user) };
  }

  async list(query: SourceListQuery, viewer: JobViewer): Promise<WebSerialJobSourceRow[]> {
    const rows = await this.jobs.pageForJobs({
      view: query.view,
      owner: query.owner === null ? null : { id: query.owner.id },
      cutoffAt: query.cutoffAt,
      after: query.after,
      typeIndex: query.typeIndex,
      limit: query.limit,
    });
    return rows.map((job) => ({ nativeId: String(job.id), key: job.key, job, item: this.item(job, isWebSerialsAdmin(viewer.user)) }));
  }

  async counts(query: SourceCountQuery): Promise<JobCounts> {
    return await this.jobs.countForJobs(query.owner === null ? null : { id: query.owner.id }, query.cutoffAt);
  }

  /** Named from the job itself, which carries the series title, author and cover. */
  describe(rows: WebSerialJobSourceRow[]): Promise<Map<string, JobSubject>> {
    return Promise.resolve(
      new Map(
        rows.map((row) => [
          row.nativeId,
          {
            label: row.job.title,
            byline: row.job.author,
            url: QUEUE_URL,
            image: row.job.hasCover ? seriesCoverPath(row.job.seriesKey) : null,
          },
        ]),
      ),
    );
  }

  actions(row: WebSerialJobSourceRow, viewer: JobViewer): { actions: JobActionKind[]; note: string | null } {
    if (!mayUse(viewer.user) || !(viewer.access.all || row.job.userId === viewer.user.id)) return { actions: [], note: null };
    return { actions: offered(row.job, viewer.user), note: null };
  }

  async reorderTo(id: string, targetId: string, place: JobReorderRequest['place'], viewer: JobViewer): Promise<JobReorderResult> {
    if (!mayUse(viewer.user)) return { outcome: 'refused', status: null };
    if (![id, targetId].every((value) => NATIVE_ID.test(value) && Number(value) <= 2_147_483_647)) {
      return { outcome: 'skipped', status: null };
    }
    const outcome = await this.service.reorderTo(Number(id), Number(targetId), place, viewer.user);
    return { outcome, status: outcome === 'done' ? 'queued' : null };
  }

  async act(action: JobActionKind, nativeIds: string[], viewer: JobViewer): Promise<SourceActionResult[]> {
    const startedAt = Date.now();
    const unique = [...new Set(nativeIds)];
    const ids = unique.filter((id) => NATIVE_ID.test(id)).map(Number);
    const rows = new Map((await this.jobs.findActionRows(ids)).map((row) => [String(row.id), row]));
    const results = new Map<string, SourceActionResult>();
    for (const id of unique) results.set(id, await this.actOn(action, id, rows.get(id) ?? null, viewer));
    const done = [...results.values()].filter((result) => result.outcome === 'done').length;
    this.logger.log(
      `[web_serials.jobs_action] [end] userId=${viewer.user.id} action=${action} jobs=${unique.length} done=${done} durationMs=${Date.now() - startedAt} - web serial job action taken`,
    );
    return nativeIds.map((id) => results.get(id)!);
  }

  private async actOn(action: JobActionKind, id: string, row: WebSerialJobActionRow | null, viewer: JobViewer): Promise<SourceActionResult> {
    const startedAt = Date.now();
    // A viewer who neither administers web serials nor owns the job cannot tell it from a missing one.
    if (!mayUse(viewer.user) || !row || !(viewer.access.all || row.userId === viewer.user.id)) return { id, outcome: 'not-found', status: null };
    const result = (outcome: SourceActionResult['outcome'], current: WebSerialJobStatus = row.status): SourceActionResult => ({
      id,
      outcome,
      status: status(current),
    });
    if (action === 'move-up' || action === 'move-down') {
      const fields = `jobId=${row.id} userId=${viewer.user.id} direction=${action}`;
      try {
        const outcome = row.status === 'queued' && (await this.service.reorderJob(row.id, viewer.user, action)) ? 'done' : 'skipped';
        this.logger.log(
          `[web_serial.jobs_reorder] [end] ${fields} durationMs=${Date.now() - startedAt} outcome=${outcome} - download queue reordered`,
        );
        return result(outcome);
      } catch (error) {
        if (error instanceof NotFoundException) return result('skipped');
        if (error instanceof ForbiddenException) return result('refused');
        this.logger.warn(
          `[web_serial.jobs_reorder] [fail] ${fields} durationMs=${Date.now() - startedAt} outcome=error errorClass=${error instanceof Error ? error.name : 'Error'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - download reorder failed`,
        );
        return result('error');
      }
    }
    if (!applies(action, row, viewer.user)) return result('skipped');
    try {
      const job = await this.run(action, row.id, viewer.user);
      return result('done', job.status);
    } catch (error) {
      if (error instanceof NotFoundException) return { id, outcome: 'not-found', status: null };
      // Forbidden: no longer the owner or an admin. Bad request: the owner's download limit is full.
      if (error instanceof ForbiddenException || error instanceof BadRequestException) return result('refused');
      if (error instanceof ConflictException) return result('skipped');
      this.logger.warn(
        `[web_serials.jobs_action] [fail] jobId=${row.id} userId=${viewer.user.id} action=${action} durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.name : 'Error'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - web serial job action failed`,
      );
      return result('error');
    }
  }

  private run(action: JobActionKind, id: number, user: RequestUser) {
    switch (action) {
      case 'cancel':
        return this.service.cancelJob(id, user);
      case 'pause':
        return this.service.pauseJob(id, user);
      case 'resume':
        return this.service.resumeJob(id, user);
      case 'retry':
        return this.service.retryJob(id, user);
      default:
        return this.service.moveJobToTop(id, user);
    }
  }

  private item(job: WebSerialJobPageRow, admin: boolean): SourceItem {
    const running = RUNNING.has(job.status);
    const counted = job.unitsTotal > 0;
    return {
      kind: job.kind,
      shape: 'job',
      status: status(job.status),
      reason: reason(job),
      phase: phase(job),
      done: counted ? job.unitsDone + job.unitsSkipped + job.unitsFailed : null,
      total: counted ? job.unitsTotal : null,
      percent: null,
      position: job.status === 'queued' && job.rank > 0 ? (admin ? job.rank : job.ownRank) : null,
      requester: { id: job.userId, name: job.ownerName ?? '' },
      cost: null,
      createdAt: job.createdAt.toISOString(),
      startedAt: running ? (job.startedAt ?? job.createdAt).toISOString() : null,
      pausedAt: null,
      finishedAt: FINISHED.has(job.status) ? (job.finishedAt ?? job.updatedAt).toISOString() : null,
      extra: job.unitsFailed > 0 ? { failed: job.unitsFailed } : null,
    };
  }
}
