import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { JobActionKind, JobCounts, JobStatus, JobSubject, JobView } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { compareJobPositions, type JobKey } from '../jobs/job-keyset';
import type {
  JobAccess,
  JobSource,
  JobViewer,
  SourceActionResult,
  SourceCountQuery,
  SourceItem,
  SourceListQuery,
  SourceRow,
} from '../jobs/job-source';
import { JobSourceRegistry } from '../jobs/job-source.registry';
import { AudiobookshelfSyncCoordinatorService } from './audiobookshelf-sync-coordinator.service';
import { AudiobookshelfSyncService, type AudiobookshelfActiveSync, type AudiobookshelfSyncKind } from './audiobookshelf-sync.service';
import { describeError, isAbsSyncConfigured, isEligibleSyncUser } from './audiobookshelf-user.utils';
import { AudiobookshelfRepository } from './audiobookshelf.repository';
import type { AudiobookshelfUserSetting } from './schema/audiobookshelf.schema';

export const AUDIOBOOKSHELF_SYNC_FAILED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const SUBJECT: JobSubject = { label: null, byline: null, url: '/settings/audiobookshelf', image: null };
const NO_COUNTS: JobCounts = { queue: 0, needsYou: 0, failed: 0, running: 0, queued: 0, paused: 0 };

/** `running`: the sync going now. `last`: how the last finished sync ended. */
type Bucket = 'running' | 'last';

type SettingsState = Pick<AudiobookshelfUserSetting, 'enabled' | 'serverUrl' | 'apiToken' | 'lastRunFinishedAt' | 'lastRunKind' | 'lastRunError'>;

export interface AudiobookshelfSyncJobRow extends SourceRow {
  bucket: Bucket;
  /** Whether a retry could start a sync now. */
  configured: boolean;
}

function isBucket(id: string): id is Bucket {
  return id === 'running' || id === 'last';
}

function micros(at: Date): number {
  return at.getTime() * 1000;
}

const SYNC_KINDS: readonly string[] = ['full', 'reconcile', 'poll'] satisfies AudiobookshelfSyncKind[];

/** How the last full, reconcile or poll run ended. The 30s hot tier never writes it, so the time holds still between runs. */
function lastRun(settings: SettingsState | undefined): { status: JobStatus; at: Date; kind: AudiobookshelfSyncKind | null } | null {
  if (!settings?.lastRunFinishedAt) return null;
  const kind = settings.lastRunKind && SYNC_KINDS.includes(settings.lastRunKind) ? (settings.lastRunKind as AudiobookshelfSyncKind) : null;
  return { status: settings.lastRunError ? 'failed' : 'completed', at: settings.lastRunFinishedAt, kind };
}

function base(owner: RequestUser): Omit<SourceItem, 'kind' | 'status' | 'reason' | 'createdAt' | 'startedAt' | 'finishedAt'> {
  return {
    shape: 'job',
    phase: null,
    done: null,
    total: null,
    percent: null,
    position: null,
    requester: { id: owner.id, name: owner.name },
    cost: null,
    pausedAt: null,
    extra: null,
  };
}

/**
 * Fork: Audiobookshelf sync in the Jobs area. Each account syncs only itself and no route shows
 * another account's sync, so every viewer sees their own rows only: the sync going now, and how the
 * last full, reconcile or poll run ended. The 30-second position tier is neither shown running nor
 * recorded as the last run. Retry is the settings page's Sync now, started in the background.
 */
@Injectable()
export class AudiobookshelfSyncJobSource implements JobSource<AudiobookshelfSyncJobRow>, OnModuleInit {
  readonly type = 'audiobookshelf-sync' as const;
  readonly failedWindowMs = AUDIOBOOKSHELF_SYNC_FAILED_WINDOW_MS;
  private readonly logger = new Logger(AudiobookshelfSyncJobSource.name);

  constructor(
    private readonly registry: JobSourceRegistry,
    private readonly repo: AudiobookshelfRepository,
    private readonly sync: AudiobookshelfSyncService,
    private readonly coordinator: AudiobookshelfSyncCoordinatorService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  access(user: RequestUser): JobAccess {
    return { own: isEligibleSyncUser(user), all: false };
  }

  async list(query: SourceListQuery, viewer: JobViewer): Promise<AudiobookshelfSyncJobRow[]> {
    if (!this.reads(viewer, query.owner) || query.view === 'needs-you' || query.limit <= 0) return [];
    const row = this.row(query.view, viewer.user, await this.repo.findSettings(viewer.user.id), query.cutoffAt);
    if (!row) return [];
    if (query.after && compareJobPositions(query.view, { ...row.key, typeIndex: query.typeIndex }, query.after) <= 0) return [];
    return [row];
  }

  async counts(query: SourceCountQuery, viewer: JobViewer): Promise<JobCounts> {
    if (!this.reads(viewer, query.owner)) return { ...NO_COUNTS };
    const running = this.sync.activeRun(viewer.user.id) ? 1 : 0;
    const failed = this.row('failed', viewer.user, await this.repo.findSettings(viewer.user.id), query.cutoffAt) ? 1 : 0;
    return { ...NO_COUNTS, queue: running, running, failed };
  }

  describe(rows: AudiobookshelfSyncJobRow[]): Promise<Map<string, JobSubject>> {
    return Promise.resolve(new Map(rows.map((row) => [row.nativeId, SUBJECT])));
  }

  actions(row: AudiobookshelfSyncJobRow): { actions: JobActionKind[]; note: string | null } {
    const retryable = row.bucket === 'last' && row.item.status === 'failed' && row.configured;
    return { actions: retryable ? ['retry'] : [], note: null };
  }

  async act(action: JobActionKind, nativeIds: string[], viewer: JobViewer): Promise<SourceActionResult[]> {
    const startedAt = Date.now();
    const user = viewer.user;
    const settings = viewer.access.own && nativeIds.some(isBucket) ? await this.repo.findSettings(user.id) : undefined;
    const results = new Map<string, SourceActionResult>();
    for (const id of new Set(nativeIds)) results.set(id, this.actOn(action, id, settings, user));
    const done = [...results.values()].filter((result) => result.outcome === 'done').length;
    this.logger.log(
      `[abs.sync.jobs_action] [end] userId=${user.id} action=${action} rows=${results.size} done=${done} durationMs=${Date.now() - startedAt} - audiobookshelf sync job action taken`,
    );
    return nativeIds.map((id) => results.get(id)!);
  }

  private actOn(action: JobActionKind, id: string, settings: SettingsState | undefined, user: RequestUser): SourceActionResult {
    const active = isBucket(id) ? this.sync.activeRun(user.id) : null;
    const last = lastRun(settings);
    const exists = id === 'running' ? active !== null : id === 'last' && last !== null;
    if (!exists) return { id, outcome: 'not-found', status: null };
    const status: JobStatus = id === 'running' ? 'running' : last!.status;
    if (action !== 'retry' || status !== 'failed' || !isAbsSyncConfigured(settings)) return { id, outcome: 'skipped', status };
    if (this.coordinator.isSyncRunning(user.id)) return { id, outcome: 'skipped', status };
    void this.sync.sync(user).catch((error: unknown) => {
      // `sync` already logs its own failure and records it on the settings row.
      const { errorClass, error: message } = describeError(error);
      this.logger.warn(
        `[abs.sync.jobs_action] [fail] userId=${user.id} action=retry errorClass=${errorClass} error="${message}" - audiobookshelf sync retry did not finish`,
      );
    });
    return { id, outcome: 'done', status: 'running' };
  }

  /** Only the viewer's own sync, so a read of another account's rows or of everyone's holds none of theirs. */
  private reads(viewer: JobViewer, owner: SourceListQuery['owner']): boolean {
    return viewer.access.own && (owner === null || owner.id === viewer.user.id);
  }

  private row(view: JobView, user: RequestUser, settings: SettingsState | undefined, cutoffAt: Date): AudiobookshelfSyncJobRow | null {
    const configured = isAbsSyncConfigured(settings);
    if (view === 'queue') {
      const active: AudiobookshelfActiveSync | null = this.sync.activeRun(user.id);
      if (!active) return null;
      const key: JobKey = { prefix: [0, 0], suffix: [micros(active.startedAt)], id: 'running' };
      const at = active.startedAt.toISOString();
      return {
        nativeId: 'running',
        key,
        bucket: 'running',
        configured,
        item: { ...base(user), kind: active.kind, status: 'running', reason: null, createdAt: at, startedAt: at, finishedAt: null },
      };
    }
    const last = lastRun(settings);
    if (!last || view === 'needs-you') return null;
    const recentFailure = last.status === 'failed' && last.at.getTime() > cutoffAt.getTime();
    if ((view === 'failed') !== recentFailure) return null;
    const at = last.at.toISOString();
    return {
      nativeId: 'last',
      key: { prefix: [micros(last.at)], suffix: [], id: 'last' },
      bucket: 'last',
      configured,
      item: {
        ...base(user),
        kind: last.kind,
        status: last.status,
        reason: last.status === 'failed' ? (configured ? 'error' : 'sync-off') : null,
        createdAt: at,
        startedAt: null,
        finishedAt: at,
      },
    };
  }
}
