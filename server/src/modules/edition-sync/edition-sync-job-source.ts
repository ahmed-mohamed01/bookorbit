import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import {
  Permission,
  type JobActionKind,
  type JobCounts,
  type JobStatus,
  type JobSubject,
  type JobReorderRequest,
  type JobReorderResult,
} from '@bookorbit/types';

import { LibraryScopeService } from '../../common/library-scope/library-scope.service';
import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { BookJobSubjects } from '../book/book-job-subjects.service';
import type {
  JobAccess,
  JobOwnerFilter,
  JobViewer,
  SourceActionResult,
  SourceCountQuery,
  SourceItem,
  SourceListQuery,
  SourceRow,
} from '../jobs/job-source';
import type { ReorderableJobSource } from '../fork-job-reorder/reorderable-job-source';
import { JobSourceRegistry } from '../jobs/job-source.registry';
import { EditionSyncBookStateService } from './edition-sync-book-state.service';
import {
  EditionSyncJobPageRepository,
  type EditionSyncJobActionRow,
  type EditionSyncJobPageRow,
  type EditionSyncJobScope,
} from './edition-sync-job-page.repository';
import { EditionSyncSchedulerService } from './edition-sync-scheduler.service';
import { EditionSyncRepository } from './edition-sync.repository';

/** Same window as the module's failed work folders (`EDITION_SYNC_FAILED_WORK_TTL_MS`). */
const FAILED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const BOOK_ID = /^[1-9][0-9]{0,9}$/;
const MAX_SERIAL = 2_147_483_647;
const FORK_SETTINGS_URL = '/settings/fork';
const BACKLOG_CACHE_MS = 15_000;
const MAX_BACKLOG_CACHE_ENTRIES = 200;
const NO_COUNTS: JobCounts = { queue: 0, needsYou: 0, failed: 0, running: 0, queued: 0, paused: 0 };

export interface EditionSyncJobSourceRow extends SourceRow {
  job: EditionSyncJobPageRow;
  startsRun: boolean;
}

/** The module's user routes, `GET /edition-sync/books` among them, answer to `edition_sync`. */
function usesEditionSync(user: RequestUser): boolean {
  return user.active && (user.isSuperuser || user.permissions.includes(Permission.EditionSync));
}

/** The admin routes (status, run, stop) answer to `manage_app_settings`. */
function administers(user: RequestUser): boolean {
  return user.active && (user.isSuperuser || user.permissions.includes(Permission.ManageAppSettings));
}

/** Index builds belong to no account; a read of one account's own rows that leaves out the ownerless ones holds none. */
function coversOwnerless(owner: JobOwnerFilter): boolean {
  return owner === null || owner.ownerless;
}

/** A pinned book waits on the server switch rather than its turn while edition sync is off for the server. */
function heldByServerSwitch(job: EditionSyncJobPageRow, serverEnabled: boolean): boolean {
  return job.status === 'queued' && !serverEnabled;
}

function bookId(nativeId: string): number | null {
  if (!BOOK_ID.test(nativeId)) return null;
  const value = Number(nativeId);
  return value <= MAX_SERIAL ? value : null;
}

/**
 * Fork: edition sync index builds in the Jobs area. One worker builds one book at a time, so every
 * build is a row about its book: the one building now (with the run that took it as its kind), the
 * pinned books next in claim order, then eligible backlog books in run order. Failed builds and
 * finished indexes keep their own views. Waiting actions use the same visible libraries and content
 * filter as the book list; run controls use the administrator permission.
 */
@Injectable()
export class EditionSyncJobSource implements ReorderableJobSource<EditionSyncJobSourceRow>, OnModuleInit {
  readonly type = 'edition-sync' as const;
  readonly failedWindowMs = FAILED_WINDOW_MS;
  private readonly logger = new Logger(EditionSyncJobSource.name);
  private readonly backlogCache = new Map<string, { expiresAt: number; count: number }>();
  private readonly pendingBacklogCounts = new Map<string, Promise<number>>();

  constructor(
    private readonly registry: JobSourceRegistry,
    private readonly jobs: EditionSyncJobPageRepository,
    private readonly repo: EditionSyncRepository,
    private readonly bookState: EditionSyncBookStateService,
    private readonly scheduler: EditionSyncSchedulerService,
    private readonly subjects: BookJobSubjects,
    private readonly scope: LibraryScopeService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  access(user: RequestUser): JobAccess {
    return { own: false, all: usesEditionSync(user) || administers(user) };
  }

  async list(query: SourceListQuery, viewer: JobViewer): Promise<EditionSyncJobSourceRow[]> {
    if (!viewer.access.all || !coversOwnerless(query.owner)) return [];
    const scope = await this.scopeOf(viewer.user);
    const serverEnabled = await this.repo.isServerEnabled();
    const jobs = await this.jobs.pageForJobs({ ...query, ...scope, includeBacklog: serverEnabled });
    const canStart = query.view === 'queue' && serverEnabled && administers(viewer.user) && !this.scheduler.activeTrigger();
    return jobs.map((job) => ({
      nativeId: String(job.bookId),
      key: job.key,
      job,
      startsRun: canStart && job.rank === 1,
      item: this.bookItem(job, serverEnabled),
    }));
  }

  async counts(query: SourceCountQuery, viewer: JobViewer): Promise<JobCounts> {
    if (!viewer.access.all || !coversOwnerless(query.owner)) return { ...NO_COUNTS };
    const scope = await this.scopeOf(viewer.user);
    const serverEnabled = await this.repo.isServerEnabled();
    const [counts, backlog] = await Promise.all([
      this.jobs.countForJobs(scope, query.cutoffAt, serverEnabled),
      serverEnabled ? this.backlogCount(scope) : 0,
    ]);
    const waiting = counts.pinned + backlog;
    return {
      queue: counts.running + waiting,
      needsYou: 0,
      failed: counts.failed,
      running: counts.running,
      queued: serverEnabled ? waiting : 0,
      paused: serverEnabled ? 0 : waiting,
    };
  }

  private async backlogCount(scope: EditionSyncJobScope): Promise<number> {
    const cacheKey = JSON.stringify([scope.libraryIds, scope.contentFilters]);
    const pending = this.pendingBacklogCounts.get(cacheKey);
    if (pending) return pending;
    const now = Date.now();
    const cached = this.backlogCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.count;
    this.backlogCache.delete(cacheKey);
    const request = this.jobs.countBacklog(scope);
    this.pendingBacklogCounts.set(cacheKey, request);
    try {
      const count = await request;
      if (this.pendingBacklogCounts.get(cacheKey) === request) {
        if (this.backlogCache.size >= MAX_BACKLOG_CACHE_ENTRIES) this.backlogCache.clear();
        this.backlogCache.set(cacheKey, { expiresAt: now + BACKLOG_CACHE_MS, count });
      }
      return count;
    } finally {
      if (this.pendingBacklogCounts.get(cacheKey) === request) this.pendingBacklogCounts.delete(cacheKey);
    }
  }

  async describe(rows: EditionSyncJobSourceRow[], viewer: JobViewer): Promise<Map<string, JobSubject>> {
    const named = await this.subjects.describe(
      rows.map((row) => row.job.bookId),
      { user: viewer.user, manages: this.scope.seesAllLibraries(viewer.user) },
    );
    const subjects = new Map<string, JobSubject>();
    for (const row of rows) {
      const book = named.get(row.job.bookId);
      if (book) subjects.set(row.nativeId, row.item.status === 'paused' ? { ...book, url: FORK_SETTINGS_URL } : book);
    }
    return subjects;
  }

  actions(row: EditionSyncJobSourceRow, viewer: JobViewer): { actions: JobActionKind[]; note: string | null } {
    const user = viewer.user;
    const actions: JobActionKind[] = [];
    switch (row.item.status) {
      case 'running':
        return administers(user) ? { actions: ['cancel'], note: null } : { actions, note: 'edition-sync-admin' };
      case 'failed':
        if (usesEditionSync(user)) actions.push('retry');
        break;
      case 'queued':
        if (row.startsRun && administers(user)) actions.push('start');
        if (usesEditionSync(user)) {
          if (row.job.rank > 1) actions.push('move-to-top', 'move-up');
          if (row.job.pinnedAt && row.job.rank < row.job.pinnedCount) actions.push('move-down');
          actions.push('cancel');
        }
        break;
    }
    return { actions, note: null };
  }

  async reorderTo(id: string, targetId: string, place: JobReorderRequest['place'], viewer: JobViewer): Promise<JobReorderResult> {
    const { user } = viewer;
    if (!viewer.access.all || !usesEditionSync(user)) return { outcome: 'refused', status: null };
    const own = bookId(id);
    const target = bookId(targetId);
    if (own === null || target === null) return { outcome: 'skipped', status: null };
    const outcome = await this.bookState.reorderTo(user, own, target, place, this.jobs.scoped(await this.scopeOf(user)));
    if (outcome === 'done') this.invalidateBacklogCount();
    return { outcome, status: outcome === 'done' ? 'queued' : null };
  }

  private invalidateBacklogCount(): void {
    this.backlogCache.clear();
    this.pendingBacklogCounts.clear();
  }

  async act(action: JobActionKind, nativeIds: string[], viewer: JobViewer): Promise<SourceActionResult[]> {
    const startedAt = Date.now();
    const unique = [...new Set(nativeIds)];
    const ids = unique.map(bookId).filter((id): id is number => id !== null);
    const scope = await this.scopeOf(viewer.user);
    const found = viewer.access.all ? await this.jobs.findActionRows(ids, scope) : [];
    const enabled = found.some((row) => row.status === 'queued') && (await this.repo.isServerEnabled());
    const rows = new Map(found.map((row) => [String(row.bookId), row]));
    const results = new Map<string, SourceActionResult>();
    for (const id of unique) results.set(id, await this.actOn(action, id, rows.get(id), viewer.user, scope, enabled));
    const done = [...results.values()].filter((result) => result.outcome === 'done').length;
    this.logger.log(
      `[edition_sync.jobs_action] [end] userId=${viewer.user.id} action=${action} jobs=${unique.length} done=${done} durationMs=${Date.now() - startedAt} - index build action taken`,
    );
    return nativeIds.map((id) => results.get(id)!);
  }

  /** A build outside the viewer's books, or one an admin-only viewer is not shown, reads as missing. */
  private async actOn(
    action: JobActionKind,
    id: string,
    row: EditionSyncJobActionRow | undefined,
    user: RequestUser,
    scope: EditionSyncJobScope,
    enabled: boolean,
  ): Promise<SourceActionResult> {
    const startedAt = Date.now();
    if (!row || (row.status !== 'running' && row.status !== 'queued' && !usesEditionSync(user))) return { id, outcome: 'not-found', status: null };
    const current = row.status === 'queued' && !enabled ? 'paused' : this.actionStatus(row);
    const result = (outcome: SourceActionResult['outcome'], status: JobStatus | null = current): SourceActionResult => ({ id, outcome, status });
    if (row.status === 'queued' && enabled) {
      const queued = await this.actOnQueued(action, row, user, scope);
      if (queued.outcome === 'done') this.invalidateBacklogCount();
      return queued;
    }
    const applies = action === 'cancel' ? row.status === 'running' : action === 'retry' && row.status === 'failed' && !row.retryRequested;
    if (!applies) return result('skipped');
    try {
      if (action === 'cancel') {
        if (!administers(user)) return result('refused');
        if (this.scheduler.currentBookId() !== row.bookId) return result('skipped');
        await this.scheduler.stop();
        // The book goes back to the backlog once the worker lets go of it.
        return result('done', null);
      }
      await this.bookState.retry(user, row.bookId);
      return result('done', 'queued');
    } catch (error) {
      if (error instanceof NotFoundException) return { id, outcome: 'not-found', status: null };
      // Forbidden, or bad request: sync is off for this book or the server, or it no longer qualifies.
      if (error instanceof ForbiddenException || error instanceof BadRequestException) return result('refused');
      if (error instanceof ConflictException) return result('skipped');
      this.logger.warn(
        `[edition_sync.jobs_action] [fail] bookId=${row.bookId} userId=${user.id} action=${action} durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.name : 'Error'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - index build action failed`,
      );
      return result('error');
    }
  }

  private async actOnQueued(
    action: JobActionKind,
    row: EditionSyncJobActionRow,
    user: RequestUser,
    scope: EditionSyncJobScope,
  ): Promise<SourceActionResult> {
    const { bookId } = row;
    const startedAt = Date.now();
    const result = (outcome: SourceActionResult['outcome'], status: JobStatus | null = 'queued'): SourceActionResult => ({
      id: String(bookId),
      outcome,
      status,
    });
    const ordering = action === 'move-up' || action === 'move-down' || action === 'move-to-top';
    const event = ordering ? 'edition_sync.jobs_reorder' : 'edition_sync.jobs_action';
    const fields = `bookId=${bookId} userId=${user.id} ${ordering ? 'direction' : 'action'}=${action}`;
    try {
      if (action === 'start') {
        if (!administers(user)) return result('refused');
        if (this.scheduler.activeTrigger()) return result('skipped');
        await this.scheduler.startManualRun(bookId);
        return result('done', 'running');
      }
      if (!usesEditionSync(user)) return result('refused');
      if (action === 'cancel') {
        if (await this.repo.isWantedByAnotherUser(bookId, user.id)) return result('refused');
        await this.bookState.setSyncEnabled(user, bookId, false);
        return result('done', 'cancelled');
      }
      if (!ordering) return result('skipped');
      const moved = await this.bookState.reorderQueuedBook(user, bookId, row.pinned, action, this.jobs.scoped(scope));
      const outcome = moved ? 'done' : 'skipped';
      this.logger.log(`[${event}] [end] ${fields} durationMs=${Date.now() - startedAt} outcome=${outcome} - edition sync queue reordered`);
      return result(outcome);
    } catch (error) {
      if (error instanceof ConflictException) return result('skipped');
      if (error instanceof NotFoundException) return result(ordering ? 'skipped' : 'not-found', ordering ? 'queued' : null);
      if (error instanceof ForbiddenException || error instanceof BadRequestException) return result('refused');
      this.logger.warn(
        `[${event}] [fail] ${fields} durationMs=${Date.now() - startedAt} outcome=error errorClass=${error instanceof Error ? error.name : 'Error'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - edition sync queue action failed`,
      );
      return result('error');
    }
  }

  private actionStatus(row: EditionSyncJobActionRow): JobStatus | null {
    switch (row.status) {
      case 'running':
        return 'running';
      case 'ready':
        return 'completed';
      case 'failed':
        return row.retryRequested ? 'queued' : 'failed';
      case 'queued':
        return 'queued';
      default:
        return null;
    }
  }

  private async scopeOf(user: RequestUser): Promise<EditionSyncJobScope> {
    return {
      libraryIds: await this.scope.visibleIdsOrAll(user),
      contentFilters: !user.isSuperuser && user.contentFilters ? user.contentFilters : null,
      runningOnly: !usesEditionSync(user),
    };
  }

  private bookItem(job: EditionSyncJobPageRow, serverEnabled: boolean): SourceItem {
    const base = {
      shape: 'job' as const,
      done: null,
      total: null,
      requester: null,
      cost: null,
      pausedAt: null,
      extra: null,
    };
    const attemptedAt = (job.lastAttemptAt ?? job.createdAt).toISOString();
    switch (job.status) {
      case 'running':
        return {
          ...base,
          kind: this.scheduler.activeTrigger(),
          status: 'running',
          reason: null,
          phase: job.stage,
          percent: job.progress ?? 0,
          position: null,
          createdAt: attemptedAt,
          startedAt: attemptedAt,
          finishedAt: null,
        };
      case 'queued': {
        const held = heldByServerSwitch(job, serverEnabled);
        return {
          ...base,
          kind: held || job.pinnedAt ? null : job.rank === job.pinnedCount + 1 ? 'backlog-head' : 'backlog',
          status: held ? 'paused' : 'queued',
          reason: held ? 'server_disabled' : null,
          phase: null,
          percent: null,
          position: !held && job.rank > 0 ? job.rank : null,
          createdAt: (job.pinnedAt ?? job.createdAt).toISOString(),
          startedAt: null,
          finishedAt: null,
        };
      }
      case 'failed':
        return {
          ...base,
          kind: null,
          status: 'failed',
          reason: job.errorCode ?? 'error',
          phase: null,
          percent: null,
          position: null,
          createdAt: attemptedAt,
          startedAt: null,
          finishedAt: (job.failedAt ?? job.createdAt).toISOString(),
        };
      default:
        return {
          ...base,
          kind: null,
          status: 'completed',
          reason: null,
          phase: null,
          percent: null,
          position: null,
          createdAt: attemptedAt,
          startedAt: null,
          finishedAt: (job.indexedAt ?? job.createdAt).toISOString(),
        };
    }
  }
}
