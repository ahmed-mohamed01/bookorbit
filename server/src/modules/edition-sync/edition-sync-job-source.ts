import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { Permission, type JobActionKind, type JobCounts, type JobStatus, type JobSubject } from '@bookorbit/types';

import { LibraryScopeService } from '../../common/library-scope/library-scope.service';
import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { BookJobSubjects } from '../book/book-job-subjects.service';
import { compareJobPositions, type JobKey } from '../jobs/job-keyset';
import type {
  JobAccess,
  JobOwnerFilter,
  JobSource,
  JobViewer,
  SourceActionResult,
  SourceCountQuery,
  SourceItem,
  SourceListQuery,
  SourceRow,
} from '../jobs/job-source';
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
const BACKLOG_ID = 'backlog';
const BOOK_ID = /^[1-9][0-9]{0,9}$/;
const MAX_SERIAL = 2_147_483_647;
const FORK_SETTINGS_URL = '/settings/fork';
/** The backlog count is a whole-queue count; a page refreshes on every push, so it is reused briefly. */
const BACKLOG_CACHE_MS = 15_000;
const MAX_BACKLOG_CACHE_ENTRIES = 200;
const NO_COUNTS: JobCounts = { queue: 0, needsYou: 0, failed: 0, running: 0, queued: 0, paused: 0 };

type EditionSyncJobBucket = { kind: 'book'; job: EditionSyncJobPageRow } | { kind: 'backlog'; count: number };

export interface EditionSyncJobSourceRow extends SourceRow {
  bucket: EditionSyncJobBucket;
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

function bookId(nativeId: string): number | null {
  if (!BOOK_ID.test(nativeId)) return null;
  const value = Number(nativeId);
  return value <= MAX_SERIAL ? value : null;
}

/**
 * Fork: edition sync index builds in the Jobs area. One worker builds one book at a time, so every
 * build is a row about its book: the one building now (with the run that took it as its kind), the
 * pinned books next in claim order, failures, and finished indexes in History. Books no run has
 * pinned yet are the scheduled backlog, which can be most of a library, so they show as one summary
 * row that opens the settings page's Queue list, where they are listed in run order. Runs are not rows
 * of their own: a run is the window that takes books, its book is already the running row, and the
 * index rows do not record which run built them.
 *
 * Scope is the module's own: someone with `edition_sync` sees what its books list shows (visible
 * libraries, content filter); someone who only manages the server sees what the admin status shows,
 * the book being built and the backlog. Retry goes through `EditionSyncBookStateService`,
 * which checks the book again; Cancel is the admin Stop.
 */
@Injectable()
export class EditionSyncJobSource implements JobSource<EditionSyncJobSourceRow>, OnModuleInit {
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
    const afterBacklog = query.after?.typeIndex === query.typeIndex && query.after.id === BACKLOG_ID;
    const jobs = afterBacklog
      ? []
      : await this.jobs.pageForJobs({
          ...scope,
          view: query.view,
          cutoffAt: query.cutoffAt,
          after: query.after,
          typeIndex: query.typeIndex,
          limit: query.limit,
        });
    const serverEnabled = await this.repo.isServerEnabled();
    const rows: EditionSyncJobSourceRow[] = jobs.map((job) => ({
      nativeId: String(job.bookId),
      key: job.key,
      bucket: { kind: 'book', job },
      item: this.bookItem(job, serverEnabled),
    }));
    if (query.view === 'queue' && serverEnabled) {
      const backlog = await this.backlogRow(scope);
      const after = query.after;
      if (backlog && (after === null || compareJobPositions('queue', { ...backlog.key, typeIndex: query.typeIndex }, after) > 0)) rows.push(backlog);
    }
    return rows.slice(0, query.limit);
  }

  /** The backlog counts once in Queue, however many books it stands for. */
  async counts(query: SourceCountQuery, viewer: JobViewer): Promise<JobCounts> {
    if (!viewer.access.all || !coversOwnerless(query.owner)) return { ...NO_COUNTS };
    const scope = await this.scopeOf(viewer.user);
    const [counts, serverEnabled] = await Promise.all([this.jobs.countForJobs(scope, query.cutoffAt), this.repo.isServerEnabled()]);
    const backlog = serverEnabled && (await this.backlogCount(scope)) > 0 ? 1 : 0;
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

  async describe(rows: EditionSyncJobSourceRow[], viewer: JobViewer): Promise<Map<string, JobSubject>> {
    const books = rows.flatMap((row) => (row.bucket.kind === 'book' ? [row.bucket.job.bookId] : []));
    // A book in a library the viewer lost, or hidden by their content filter, is not named.
    const named =
      books.length > 0 ? await this.subjects.describe(books, { user: viewer.user, manages: this.scope.seesAllLibraries(viewer.user) }) : new Map();
    const subjects = new Map<string, JobSubject>();
    for (const row of rows) {
      if (row.bucket.kind === 'backlog') {
        subjects.set(row.nativeId, { label: null, byline: null, url: FORK_SETTINGS_URL, image: null });
        continue;
      }
      const book = named.get(row.bucket.job.bookId);
      if (book) subjects.set(row.nativeId, book);
    }
    return subjects;
  }

  actions(row: EditionSyncJobSourceRow, viewer: JobViewer): { actions: JobActionKind[]; note: string | null } {
    if (row.bucket.kind === 'backlog') return { actions: [], note: null };
    switch (row.bucket.job.status) {
      case 'running':
        return administers(viewer.user) ? { actions: ['cancel'], note: null } : { actions: [], note: 'edition-sync-admin' };
      case 'failed':
        return usesEditionSync(viewer.user) ? { actions: ['retry'], note: null } : { actions: [], note: null };
      default:
        return { actions: [], note: null };
    }
  }

  async act(action: JobActionKind, nativeIds: string[], viewer: JobViewer): Promise<SourceActionResult[]> {
    const startedAt = Date.now();
    const unique = [...new Set(nativeIds)];
    const ids = unique.map(bookId).filter((id): id is number => id !== null);
    const found = viewer.access.all ? await this.jobs.findActionRows(ids, await this.scopeOf(viewer.user)) : [];
    const rows = new Map(found.map((row) => [String(row.bookId), row]));
    const results = new Map<string, SourceActionResult>();
    for (const id of unique) {
      if (id === BACKLOG_ID && viewer.access.all) results.set(id, { id, outcome: 'skipped', status: null });
      else results.set(id, await this.actOn(action, id, rows.get(id) ?? null, viewer.user));
    }
    const done = [...results.values()].filter((result) => result.outcome === 'done').length;
    this.logger.log(
      `[edition_sync.jobs_action] [end] userId=${viewer.user.id} action=${action} jobs=${unique.length} done=${done} durationMs=${Date.now() - startedAt} - index build action taken`,
    );
    return nativeIds.map((id) => results.get(id)!);
  }

  /** A build outside the viewer's books, or one an admin-only viewer is not shown, reads as missing. */
  private async actOn(action: JobActionKind, id: string, row: EditionSyncJobActionRow | null, user: RequestUser): Promise<SourceActionResult> {
    const startedAt = Date.now();
    if (!row || (row.status !== 'running' && !usesEditionSync(user))) return { id, outcome: 'not-found', status: null };
    const current = this.actionStatus(row);
    const result = (outcome: SourceActionResult['outcome'], status: JobStatus | null = current): SourceActionResult => ({ id, outcome, status });
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

  private actionStatus(row: EditionSyncJobActionRow): JobStatus {
    switch (row.status) {
      case 'running':
        return 'running';
      case 'ready':
        return 'completed';
      case 'failed':
        return row.retryRequested ? 'queued' : 'failed';
      default:
        return 'queued';
    }
  }

  private async scopeOf(user: RequestUser): Promise<EditionSyncJobScope> {
    return {
      libraryIds: await this.scope.visibleIdsOrAll(user),
      contentFilters: !user.isSuperuser && user.contentFilters ? user.contentFilters : null,
      runningOnly: !usesEditionSync(user),
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
      if (this.backlogCache.size >= MAX_BACKLOG_CACHE_ENTRIES) this.backlogCache.clear();
      this.backlogCache.set(cacheKey, { expiresAt: now + BACKLOG_CACHE_MS, count });
      return count;
    } finally {
      this.pendingBacklogCounts.delete(cacheKey);
    }
  }

  /** After every pinned book: a run takes pinned books first. */
  private async backlogRow(scope: EditionSyncJobScope): Promise<EditionSyncJobSourceRow | null> {
    const count = await this.backlogCount(scope);
    if (count === 0) return null;
    const key: JobKey = { prefix: [1, MAX_SERIAL], suffix: [0], id: BACKLOG_ID };
    return {
      nativeId: BACKLOG_ID,
      key,
      bucket: { kind: 'backlog', count },
      item: {
        kind: 'backlog',
        shape: 'queue',
        status: 'queued',
        reason: null,
        phase: null,
        done: null,
        total: count,
        percent: null,
        position: null,
        requester: null,
        cost: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        pausedAt: null,
        finishedAt: null,
        extra: null,
      },
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
      case 'queued':
        return {
          ...base,
          kind: null,
          status: serverEnabled ? 'queued' : 'paused',
          reason: serverEnabled ? null : 'server_disabled',
          phase: null,
          percent: null,
          position: serverEnabled && job.rank > 0 ? job.rank : null,
          createdAt: (job.pinnedAt ?? job.createdAt).toISOString(),
          startedAt: null,
          finishedAt: null,
        };
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
