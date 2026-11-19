import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  Permission,
  type CoverThumbnailBackfillRun,
  type CoverThumbnailBackfillState,
  type JobActionKind,
  type JobCounts,
  type JobStatus,
  type JobSubject,
  type JobView,
} from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { compareJobPositions, type JobKey } from '../jobs/job-keyset';
import type {
  JobAccess,
  JobOwnerFilter,
  JobSource,
  JobViewer,
  SourceActionResult,
  SourceCountQuery,
  SourceListQuery,
  SourceRow,
} from '../jobs/job-source';
import { JobSourceRegistry } from '../jobs/job-source.registry';
import { CoverThumbnailBackfillService } from './cover-thumbnail-backfill.service';

export const COVER_THUMBNAIL_BACKFILL_FAILED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const SUBJECT: JobSubject = { label: null, byline: null, url: '/settings/fork', image: null };
const NO_COUNTS: JobCounts = { queue: 0, needsYou: 0, failed: 0, running: 0, queued: 0, paused: 0 };
const NATIVE_ID = /^run-[0-9]{1,16}$/;

export interface CoverThumbnailBackfillJobRow extends SourceRow {
  running: boolean;
}

/** The backfill routes ask for `ManageAppSettings`. */
function manages(user: RequestUser): boolean {
  return user.active && (user.isSuperuser || user.permissions.includes(Permission.ManageAppSettings));
}

function coversOwnerless(owner: JobOwnerFilter): boolean {
  return owner === null || owner.ownerless;
}

function micros(iso: string): number {
  return Date.parse(iso) * 1000;
}

function nativeIdOf(startedAt: string): string {
  return `run-${Date.parse(startedAt)}`;
}

function finishedStatus(run: CoverThumbnailBackfillRun): JobStatus {
  if (run.outcome === 'completed') return 'completed';
  return run.outcome === 'stopped' ? 'cancelled' : 'failed';
}

/**
 * Fork: the cover thumbnail backfill in the Jobs area. One run at a time for the whole server, kept
 * in memory, and the last finished run in app settings, so it shows as at most one ownerless row per
 * view. Cancel stops the run without touching the start-up and daily switch.
 */
@Injectable()
export class CoverThumbnailBackfillJobSource implements JobSource<CoverThumbnailBackfillJobRow>, OnModuleInit {
  readonly type = 'cover-thumbnail-backfill' as const;
  readonly failedWindowMs = COVER_THUMBNAIL_BACKFILL_FAILED_WINDOW_MS;
  private readonly logger = new Logger(CoverThumbnailBackfillJobSource.name);

  constructor(
    private readonly registry: JobSourceRegistry,
    private readonly backfill: CoverThumbnailBackfillService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  access(user: RequestUser): JobAccess {
    return { own: false, all: manages(user) };
  }

  async list(query: SourceListQuery, viewer: JobViewer): Promise<CoverThumbnailBackfillJobRow[]> {
    if (!viewer.access.all || !coversOwnerless(query.owner) || query.view === 'needs-you' || query.limit <= 0) return [];
    const row = this.row(query.view, await this.backfill.getState(), query.cutoffAt);
    if (!row) return [];
    if (query.after && compareJobPositions(query.view, { ...row.key, typeIndex: query.typeIndex }, query.after) <= 0) return [];
    return [row];
  }

  async counts(query: SourceCountQuery, viewer: JobViewer): Promise<JobCounts> {
    if (!viewer.access.all || !coversOwnerless(query.owner)) return { ...NO_COUNTS };
    const state = await this.backfill.getState();
    const running = state.running ? 1 : 0;
    const failed = this.row('failed', state, query.cutoffAt) ? 1 : 0;
    return { ...NO_COUNTS, queue: running, running, failed };
  }

  describe(rows: CoverThumbnailBackfillJobRow[]): Promise<Map<string, JobSubject>> {
    return Promise.resolve(new Map(rows.map((row) => [row.nativeId, SUBJECT])));
  }

  actions(row: CoverThumbnailBackfillJobRow): { actions: JobActionKind[]; note: string | null } {
    return { actions: row.running ? ['cancel'] : [], note: null };
  }

  async act(action: JobActionKind, nativeIds: string[], viewer: JobViewer): Promise<SourceActionResult[]> {
    const startedAt = Date.now();
    const state = viewer.access.all ? await this.backfill.getState() : null;
    const runningId = state?.running ? nativeIdOf(state.running.startedAt) : null;
    const lastId = state?.lastRun ? nativeIdOf(state.lastRun.startedAt) : null;
    const results = nativeIds.map((id): SourceActionResult => {
      if (!state || !NATIVE_ID.test(id)) return { id, outcome: 'not-found', status: null };
      if (id === runningId) {
        if (action !== 'cancel') return { id, outcome: 'skipped', status: 'running' };
        // The run stops after the cover it is on and records itself as stopped.
        return { id, outcome: this.backfill.stopRun(viewer.user) ? 'done' : 'skipped', status: null };
      }
      if (id === lastId && state.lastRun) return { id, outcome: 'skipped', status: finishedStatus(state.lastRun) };
      return { id, outcome: 'not-found', status: null };
    });
    const done = results.filter((result) => result.outcome === 'done').length;
    this.logger.log(
      `[cover.thumbnail_backfill.jobs_action] [end] userId=${viewer.user.id} action=${action} rows=${nativeIds.length} done=${done} durationMs=${Date.now() - startedAt} - thumbnail backfill job action taken`,
    );
    return results;
  }

  private row(view: JobView, state: CoverThumbnailBackfillState, cutoffAt: Date): CoverThumbnailBackfillJobRow | null {
    if (view === 'queue') {
      const running = state.running;
      if (!running) return null;
      const nativeId = nativeIdOf(running.startedAt);
      const key: JobKey = { prefix: [0, 0], suffix: [micros(running.startedAt)], id: nativeId };
      return {
        nativeId,
        key,
        running: true,
        item: {
          kind: running.trigger,
          shape: 'job',
          status: 'running',
          reason: null,
          phase: null,
          done: running.scanned,
          total: running.total,
          percent: null,
          position: null,
          requester: null,
          cost: null,
          createdAt: running.startedAt,
          startedAt: running.startedAt,
          pausedAt: null,
          finishedAt: null,
          extra: null,
        },
      };
    }
    const run = state.lastRun;
    if (!run || view === 'needs-you') return null;
    const status = finishedStatus(run);
    const recentFailure = status === 'failed' && Date.parse(run.finishedAt) > cutoffAt.getTime();
    if ((view === 'failed') !== recentFailure) return null;
    const nativeId = nativeIdOf(run.startedAt);
    return {
      nativeId,
      key: { prefix: [micros(run.finishedAt)], suffix: [], id: nativeId },
      running: false,
      item: {
        kind: run.trigger,
        shape: 'job',
        status,
        reason: status === 'cancelled' ? 'stopped' : status === 'failed' ? 'error' : null,
        phase: null,
        done: run.scanned,
        total: null,
        percent: null,
        position: null,
        requester: null,
        cost: null,
        createdAt: run.startedAt,
        startedAt: null,
        pausedAt: null,
        finishedAt: run.finishedAt,
        extra: status === 'completed' && run.unresolved > 0 ? { failed: run.unresolved } : null,
      },
    };
  }
}
