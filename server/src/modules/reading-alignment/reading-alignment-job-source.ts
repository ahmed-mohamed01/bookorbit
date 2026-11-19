import { ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { Permission, type JobActionKind, type JobCounts, type JobStatus, type JobSubject } from '@bookorbit/types';

import { LibraryScopeService } from '../../common/library-scope/library-scope.service';
import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { BookJobSubjects } from '../book/book-job-subjects.service';
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
import { describeError } from './reading-alignment-error.util';
import { INTERRUPTED_BUILD_ERROR } from './reading-alignment.repository';
import {
  ReadingAlignmentJobPageRepository,
  type WhisperAlignmentJobActionRow,
  type WhisperAlignmentJobPageRow,
  type WhisperAlignmentJobScope,
} from './reading-alignment-job-page.repository';
import { ReadingAlignmentStatusService } from './reading-alignment-status.service';

export const WHISPER_ALIGNMENT_FAILED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const NO_COUNTS: JobCounts = { queue: 0, needsYou: 0, failed: 0, running: 0, queued: 0, paused: 0 };
const MAX_SERIAL = 2_147_483_647;

export interface WhisperAlignmentJobRow extends SourceRow {
  job: WhisperAlignmentJobPageRow;
}

/** The build and cancel routes ask for `LibraryEditMetadata` and editor access to the book. */
function mayBuild(user: RequestUser): boolean {
  return user.active && (user.isSuperuser || user.permissions.includes(Permission.LibraryEditMetadata));
}

function coversOwnerless(owner: JobOwnerFilter): boolean {
  return owner === null || owner.ownerless;
}

/**
 * `unalignable` is a finished build that found too little to align: it reads as failed with its own
 * reason, but in History, since rebuilding the same files gives the same answer.
 */
function status(value: string): JobStatus {
  switch (value) {
    case 'building':
      return 'running';
    case 'ready':
      return 'completed';
    case 'failed':
    case 'unalignable':
      return 'failed';
    default:
      return 'queued';
  }
}

function reason(job: Pick<WhisperAlignmentJobPageRow, 'status' | 'error'>): string | null {
  if (job.status === 'unalignable') return 'unalignable';
  if (job.status !== 'failed') return null;
  return job.error === INTERRUPTED_BUILD_ERROR ? 'interrupted' : 'error';
}

function serialId(id: string): number | null {
  if (!/^[1-9][0-9]{0,9}$/.test(id)) return null;
  const value = Number(id);
  return value <= MAX_SERIAL ? value : null;
}

/**
 * Fork: whisper alignment builds in the Jobs area. A build belongs to its book, not to whoever asked
 * for it (the table records no requester), so rows are ownerless and shown to everyone who may build,
 * in the libraries they may edit, as the build routes allow. Cancel and retry are those routes' own
 * service calls; a cancelled build deletes its row, so it leaves no History entry.
 */
@Injectable()
export class ReadingAlignmentJobSource implements JobSource<WhisperAlignmentJobRow>, OnModuleInit {
  readonly type = 'whisper-alignment' as const;
  readonly failedWindowMs = WHISPER_ALIGNMENT_FAILED_WINDOW_MS;
  private readonly logger = new Logger(ReadingAlignmentJobSource.name);

  constructor(
    private readonly registry: JobSourceRegistry,
    private readonly jobs: ReadingAlignmentJobPageRepository,
    private readonly statusService: ReadingAlignmentStatusService,
    private readonly subjects: BookJobSubjects,
    private readonly scope: LibraryScopeService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  access(user: RequestUser): JobAccess {
    return { own: false, all: mayBuild(user) };
  }

  async list(query: SourceListQuery, viewer: JobViewer): Promise<WhisperAlignmentJobRow[]> {
    if (!viewer.access.all || !coversOwnerless(query.owner)) return [];
    const rows = await this.jobs.pageForJobs({
      view: query.view,
      ...(await this.readScope(viewer.user)),
      cutoffAt: query.cutoffAt,
      after: query.after,
      typeIndex: query.typeIndex,
      limit: query.limit,
    });
    return rows.map((job) => ({ nativeId: String(job.id), key: job.key, job, item: this.item(job) }));
  }

  async counts(query: SourceCountQuery, viewer: JobViewer): Promise<JobCounts> {
    if (!viewer.access.all || !coversOwnerless(query.owner)) return { ...NO_COUNTS };
    return await this.jobs.countForJobs(await this.readScope(viewer.user), query.cutoffAt);
  }

  async describe(rows: WhisperAlignmentJobRow[], viewer: JobViewer): Promise<Map<string, JobSubject>> {
    const books = await this.subjects.describe(
      rows.map((row) => row.job.bookId),
      { user: viewer.user, manages: this.scope.seesAllLibraries(viewer.user) },
    );
    const subjects = new Map<string, JobSubject>();
    for (const row of rows) {
      const book = books.get(row.job.bookId);
      if (book) subjects.set(row.nativeId, book);
    }
    return subjects;
  }

  actions(row: WhisperAlignmentJobRow): { actions: JobActionKind[]; note: string | null } {
    if (row.job.status === 'building' || row.job.status === 'pending') return { actions: ['cancel'], note: null };
    if (row.job.status === 'failed' || row.job.status === 'unalignable') return { actions: ['retry'], note: null };
    return { actions: [], note: null };
  }

  async act(action: JobActionKind, nativeIds: string[], viewer: JobViewer): Promise<SourceActionResult[]> {
    const startedAt = Date.now();
    const unique = [...new Set(nativeIds)];
    const ids = unique.map(serialId).filter((id): id is number => id !== null);
    const found = viewer.access.all ? await this.jobs.findActionRows(ids, await this.readScope(viewer.user)) : [];
    const rows = new Map(found.map((row) => [String(row.id), row]));
    const results = new Map<string, SourceActionResult>();
    for (const id of unique) results.set(id, await this.actOn(action, id, rows.get(id) ?? null, viewer.user));
    const done = [...results.values()].filter((result) => result.outcome === 'done').length;
    this.logger.log(
      `[reading_alignment.jobs_action] [end] userId=${viewer.user.id} action=${action} jobs=${unique.length} done=${done} durationMs=${Date.now() - startedAt} - alignment job action taken`,
    );
    return nativeIds.map((id) => results.get(id)!);
  }

  /**
   * A build outside the libraries the viewer may edit, or hidden by their content filter, reads as
   * missing. Retrying an unalignable build is skipped unless its files or build settings changed.
   */
  private async actOn(action: JobActionKind, id: string, row: WhisperAlignmentJobActionRow | null, user: RequestUser): Promise<SourceActionResult> {
    const startedAt = Date.now();
    if (!row) return { id, outcome: 'not-found', status: null };
    const current = status(row.status);
    const applies =
      (action === 'cancel' && (row.status === 'building' || row.status === 'pending')) ||
      (action === 'retry' && (row.status === 'failed' || row.status === 'unalignable'));
    if (!applies) return { id, outcome: 'skipped', status: current };
    try {
      if (action === 'retry' && row.status === 'unalignable' && !(await this.statusService.rebuildCouldChange({ ...row, textBookId: row.bookId }))) {
        return { id, outcome: 'skipped', status: current };
      }
      if (action === 'cancel') {
        await this.statusService.cancelBuild(row.bookId, user);
        return { id, outcome: 'done', status: 'cancelled' };
      }
      const started = await this.statusService.requestBuild(row.bookId, user, false);
      // `busy`, `disabled`, `unavailable` and `none` start nothing; any other answer is the row's status as the build begins.
      if (started.status === 'busy' || started.status === 'disabled' || started.status === 'unavailable' || started.status === 'none') {
        return { id, outcome: 'skipped', status: current };
      }
      return { id, outcome: 'done', status: null };
    } catch (error) {
      if (error instanceof NotFoundException) return { id, outcome: 'not-found', status: null };
      if (error instanceof ForbiddenException) return { id, outcome: 'refused', status: current };
      const { errorClass, message } = describeError(error);
      this.logger.warn(
        `[reading_alignment.jobs_action] [fail] alignmentId=${row.id} bookId=${row.bookId} userId=${user.id} action=${action} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - alignment job action failed`,
      );
      return { id, outcome: 'error', status: current };
    }
  }

  /** Superusers skip the content filter, as the books list does. */
  private async readScope(user: RequestUser): Promise<WhisperAlignmentJobScope> {
    return {
      libraryIds: this.scope.seesAllLibraries(user) ? null : await this.scope.editableIds(user),
      contentFilters: !user.isSuperuser && user.contentFilters ? user.contentFilters : null,
    };
  }

  private item(job: WhisperAlignmentJobPageRow): WhisperAlignmentJobRow['item'] {
    const current = status(job.status);
    const running = current === 'running';
    const finished = current === 'completed' || current === 'failed';
    return {
      kind: null,
      shape: 'job',
      status: current,
      reason: reason(job),
      phase: null,
      done: running ? job.samplesDone : null,
      total: running ? job.samplesTotal : null,
      percent: null,
      position: null,
      requester: null,
      cost: null,
      createdAt: job.createdAt.toISOString(),
      startedAt: null,
      pausedAt: null,
      finishedAt: finished ? job.updatedAt.toISOString() : null,
      extra: null,
    };
  }
}
