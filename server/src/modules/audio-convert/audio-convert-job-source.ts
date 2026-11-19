import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { Permission, type AudioConvertJobStatus, type JobActionKind, type JobCounts, type JobStatus, type JobSubject } from '@bookorbit/types';

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
  SourceItem,
  SourceListQuery,
  SourceRow,
} from '../jobs/job-source';
import { JobSourceRegistry } from '../jobs/job-source.registry';
import { AudioConvertJobPageRepository, type AudioConvertJobActionRow, type AudioConvertJobPageRow } from './audio-convert-job-page.repository';
import { AudioConvertService } from './audio-convert.service';

const FAILED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINISHED = new Set<AudioConvertJobStatus>(['success', 'failed', 'skipped', 'cancelled']);

export interface AudioConvertJobSourceRow extends SourceRow {
  job: AudioConvertJobPageRow;
}

/** Every Convert to M4B job route asks for `ManageLibraries` and editor access to the job's library. */
function mayConvert(user: RequestUser): boolean {
  return user.active && (user.isSuperuser || user.permissions.includes(Permission.ManageLibraries));
}

/** A book still waiting in the automatic pipeline is held until its metadata and chapter steps are done. */
function status(value: AudioConvertJobStatus): JobStatus {
  switch (value) {
    case 'running':
      return 'running';
    case 'waiting':
      return 'paused';
    case 'success':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'skipped':
    case 'cancelled':
      return 'cancelled';
    default:
      return 'queued';
  }
}

function reason(job: Pick<AudioConvertJobPageRow, 'status' | 'stage' | 'errorCode'>): string | null {
  switch (job.status) {
    case 'waiting':
      return job.stage;
    case 'failed':
      return job.errorCode ?? 'error';
    case 'skipped':
      return job.errorCode ?? 'skipped';
    default:
      return null;
  }
}

/** `stopBook`'s own rule: a running conversion can be stopped until it starts swapping the files. */
function cancellable(job: Pick<AudioConvertJobActionRow, 'status' | 'stage'>): boolean {
  if (job.status === 'running') return job.stage !== 'swapping';
  return job.status === 'queued' || job.status === 'waiting';
}

/**
 * Fork: Convert to M4B in the Jobs area. The tool's own status list shows a library's every job to
 * anyone who manages libraries and may edit that library, so the Jobs area shows the same: every job
 * in the libraries the viewer may edit, the viewer's own counted in the sidebar. Actions go through
 * `AudioConvertService`, which checks the book's library access again. Cancel is the book page's
 * Stop; Resume is the waiting list's Convert now.
 */
@Injectable()
export class AudioConvertJobSource implements JobSource<AudioConvertJobSourceRow>, OnModuleInit {
  readonly type = 'audio-convert' as const;
  readonly failedWindowMs = FAILED_WINDOW_MS;
  private readonly logger = new Logger(AudioConvertJobSource.name);

  constructor(
    private readonly registry: JobSourceRegistry,
    private readonly jobs: AudioConvertJobPageRepository,
    private readonly service: AudioConvertService,
    private readonly subjects: BookJobSubjects,
    private readonly scope: LibraryScopeService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  access(user: RequestUser): JobAccess {
    const allowed = mayConvert(user);
    return { own: allowed, all: allowed };
  }

  async list(query: SourceListQuery, viewer: JobViewer): Promise<AudioConvertJobSourceRow[]> {
    const rows = await this.jobs.pageForJobs({
      view: query.view,
      owner: this.owner(query.owner),
      libraryIds: await this.libraries(viewer.user),
      cutoffAt: query.cutoffAt,
      after: query.after,
      typeIndex: query.typeIndex,
      limit: query.limit,
    });
    return rows.map((job) => ({ nativeId: job.id, key: job.key, job, item: this.item(job) }));
  }

  async counts(query: SourceCountQuery, viewer: JobViewer): Promise<JobCounts> {
    return await this.jobs.countForJobs({ owner: this.owner(query.owner), libraryIds: await this.libraries(viewer.user) }, query.cutoffAt);
  }

  async describe(rows: AudioConvertJobSourceRow[], viewer: JobViewer): Promise<Map<string, JobSubject>> {
    // A book moved to a library the viewer cannot reach is not named.
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

  actions(row: AudioConvertJobSourceRow): { actions: JobActionKind[]; note: string | null } {
    if (!cancellable(row.job)) return { actions: [], note: null };
    return { actions: row.job.status === 'waiting' ? ['resume', 'cancel'] : ['cancel'], note: null };
  }

  async act(action: JobActionKind, nativeIds: string[], viewer: JobViewer): Promise<SourceActionResult[]> {
    const startedAt = Date.now();
    const unique = [...new Set(nativeIds)];
    const ids = unique.filter((id) => UUID.test(id));
    const found = viewer.access.all ? await this.jobs.findActionRows(ids, await this.libraries(viewer.user)) : [];
    const rows = new Map(found.map((row) => [row.id, row]));
    const results = new Map<string, SourceActionResult>();
    for (const id of unique) results.set(id, await this.actOn(action, id, rows.get(id) ?? null, viewer.user));
    const done = [...results.values()].filter((result) => result.outcome === 'done').length;
    this.logger.log(
      `[audio_convert.jobs_action] [end] userId=${viewer.user.id} action=${action} jobs=${unique.length} done=${done} durationMs=${Date.now() - startedAt} - convert job action taken`,
    );
    return nativeIds.map((id) => results.get(id)!);
  }

  /** A job outside the libraries the viewer may edit reads as missing. */
  private async actOn(action: JobActionKind, id: string, row: AudioConvertJobActionRow | null, user: RequestUser): Promise<SourceActionResult> {
    const startedAt = Date.now();
    if (!row) return { id, outcome: 'not-found', status: null };
    const result = (outcome: SourceActionResult['outcome'], current: JobStatus | null = status(row.status)): SourceActionResult => ({
      id,
      outcome,
      status: current,
    });
    const applies = action === 'cancel' ? cancellable(row) : action === 'resume' && row.status === 'waiting';
    if (!applies) return result('skipped');
    try {
      if (action === 'resume') {
        await this.service.convertNow(row.id, user);
        return result('done', 'queued');
      }
      const { cancelled } = await this.service.stopBook(row.bookId, user);
      // A running conversion stops on its own a moment later and writes its own end state.
      if (cancelled) return result('done', row.status === 'running' ? null : 'cancelled');
      return result('skipped');
    } catch (error) {
      if (error instanceof NotFoundException) return { id, outcome: 'not-found', status: null };
      if (error instanceof ForbiddenException) return result('refused');
      // Its chapter lookup is under way, or it left the waiting list meanwhile.
      if (error instanceof ConflictException) return result('skipped');
      this.logger.warn(
        `[audio_convert.jobs_action] [fail] jobId=${row.id} bookId=${row.bookId} userId=${user.id} action=${action} durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.name : 'Error'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - convert job action failed`,
      );
      return result('error');
    }
  }

  private async libraries(user: RequestUser): Promise<number[] | null> {
    return this.scope.seesAllLibraries(user) ? null : await this.scope.editableIds(user);
  }

  private owner(owner: JobOwnerFilter): { id: number; ownerless: boolean } | null {
    return owner === null ? null : { id: owner.id, ownerless: owner.ownerless };
  }

  private item(job: AudioConvertJobPageRow): SourceItem {
    const running = job.status === 'running';
    return {
      kind: job.trigger,
      shape: 'job',
      status: status(job.status),
      reason: reason(job),
      phase: running ? job.stage : null,
      done: null,
      total: null,
      percent: running ? job.progress : null,
      position: job.status === 'queued' && job.rank > 0 ? job.rank : null,
      requester: job.userId === null || job.trigger === 'auto' ? null : { id: job.userId, name: job.ownerName ?? '' },
      cost: null,
      createdAt: job.createdAt.toISOString(),
      startedAt: running ? (job.startedAt ?? job.createdAt).toISOString() : null,
      pausedAt: null,
      finishedAt: FINISHED.has(job.status) ? (job.finishedAt ?? job.createdAt).toISOString() : null,
      extra: null,
    };
  }
}
