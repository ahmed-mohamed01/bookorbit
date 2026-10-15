import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import type {
  CreateWebSerialJobInput,
  WebSerialClearFinishedResult,
  WebSerialJob,
  WebSerialJobDetail,
  WebSerialJobList,
  WebSerialJobScope,
  WebSerialJobStatus,
  WebSerialKind,
} from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { LibraryService } from '../library/library.service';
import { WebSerialsLookupService } from './lookup/web-serials-lookup.service';
import { WebSerialsCatalogService } from './web-serials-catalog.service';
import { WebSerialsEngineRegistry } from './web-serials-engine-registry.service';
import { isWebSerialsAdmin, toWebSerialJob } from './web-serials-job-view.utils';
import { WebSerialsImportService } from './web-serials-import.service';
import { WebSerialsJobRunnerService } from './web-serials-job-runner.service';
import { resolveWebSerialAuthors, type WebSerialJobMetadataSnapshot } from './web-serials-metadata.utils';
import {
  assertValidSelection,
  packagingAllowedFor,
  type RawWebSerialSelection,
  selectUnits,
  toWebSerialSelection,
} from './web-serials-selection.utils';
import { parseSeriesKey } from './web-serials-series-key.utils';
import { WebSerialsSettingsService } from './web-serials-settings.service';
import { FINISHED_STATUSES, WebSerialsRepository, type WebSerialJobWithLibrary } from './web-serials.repository';
import { WEB_SERIAL_SERIES_KEY_MAX_LENGTH } from './schema/web-serials.schema';
import { WebSerialErrorCode } from '@bookorbit/types';
import { codedError } from './web-serials-error.utils';

const CREATE_EVENT = 'web_serials.job.create';
const QUEUE_EVENT = 'web_serials.job.queue';
const REMOVE_EVENT = 'web_serials.job.remove';
const CLEAR_EVENT = 'web_serials.job.clear_finished';
const CANCEL_SETTLE_TIMEOUT_MS = 10_000;
const MAX_ACTIVE_JOBS_PER_USER = 25;
const REQUEUED_ON_RETRY = new Set<WebSerialJobStatus>(['completed', 'completed_with_gaps', 'failed']);
const LIBRARY_FORMAT: Record<WebSerialKind, string> = { manga: 'cbz', novel: 'epub' };

function tooManyJobs(): BadRequestException {
  return new BadRequestException(
    codedError('You have too many downloads waiting, running or paused. Wait for some to finish, or cancel one.', WebSerialErrorCode.TooManyJobs, {
      limit: MAX_ACTIVE_JOBS_PER_USER,
    }),
  );
}

export type CreateWebSerialJobRequest = Omit<CreateWebSerialJobInput, 'selection'> & { selection: RawWebSerialSelection };

@Injectable()
export class WebSerialJobsService {
  private readonly logger = new Logger(WebSerialJobsService.name);

  constructor(
    private readonly repo: WebSerialsRepository,
    private readonly settings: WebSerialsSettingsService,
    private readonly engines: WebSerialsEngineRegistry,
    private readonly catalog: WebSerialsCatalogService,
    private readonly libraryService: LibraryService,
    private readonly lookupService: WebSerialsLookupService,
    private readonly runner: WebSerialsJobRunnerService,
    private readonly importer: WebSerialsImportService,
  ) {}

  async createJob(request: CreateWebSerialJobRequest, user: RequestUser): Promise<WebSerialJob> {
    const startedAt = Date.now();
    const input: CreateWebSerialJobInput = { ...request, selection: toWebSerialSelection(request.selection) };
    if (input.seriesKey.length > WEB_SERIAL_SERIES_KEY_MAX_LENGTH) {
      throw new BadRequestException(codedError('The series address is too long to download', WebSerialErrorCode.SeriesKeyTooLong));
    }
    const { kind, remoteId } = parseSeriesKey(input.seriesKey);
    if (!packagingAllowedFor(kind, input.packaging))
      throw new BadRequestException(codedError('That packaging is not available for this series', WebSerialErrorCode.PackagingUnavailable));
    assertValidSelection(input.selection);
    if (kind === 'novel' && input.packaging === 'series' && input.selection.mode === 'range') {
      throw new BadRequestException(
        codedError(
          'A range works with one book per volume. Choose all volumes to get one book for the series.',
          WebSerialErrorCode.RangeNeedsVolumes,
        ),
      );
    }

    await this.libraryService.verifyUserAccess(user.id, input.libraryId, user.isSuperuser);
    await this.assertLibraryAcceptsKind(kind, input.libraryId);
    const config = await this.engines.requireConfig(kind);
    // lightnovel-crawler builds one book from every volume it has fetched, so a part of the novel cannot be one book.
    if (input.seriesKey.startsWith('n:') && input.packaging === 'series' && input.selection.mode !== 'all') {
      throw new BadRequestException(
        codedError(
          'A range works with one book per volume. Choose all volumes to get one book for the series.',
          WebSerialErrorCode.RangeNeedsVolumes,
        ),
      );
    }
    const folderId = await this.resolveFolder(input.libraryId, input.folderId ?? null, config.targetLibraryId, config.targetFolderId);

    if ((await this.repo.countCappedJobsForUser(user.id)) >= MAX_ACTIVE_JOBS_PER_USER) throw tooManyJobs();

    const series = await this.catalog.loadSeries(kind, remoteId, input.seriesKey);
    const lookup =
      kind === 'manga' && input.packaging === 'volume'
        ? await this.lookupService.lookup(kind, series.title, series.author, series.units, input.seriesKey)
        : null;
    const selectedUnits = selectUnits(series, input.packaging, input.selection, lookup?.chapterVolumes ?? null);
    if (selectedUnits.length === 0) {
      throw new BadRequestException(codedError('Nothing to download in that selection', WebSerialErrorCode.NothingToDownload));
    }
    if (kind === 'manga' && input.packaging === 'volume' && !selectedUnits.some((unit) => unit.packaging === 'volume')) {
      throw new BadRequestException(codedError("Volume information isn't available for this series.", WebSerialErrorCode.VolumesUnavailable));
    }

    const match = input.metadata?.matchId ? await this.lookupService.getMatch(input.metadata.matchId, kind) : null;
    const metadata: WebSerialJobMetadataSnapshot = {
      ...(input.metadata ? { override: input.metadata } : {}),
      ...(match ? { match } : {}),
    };
    const finalAuthors = resolveWebSerialAuthors(series, metadata);

    const created = await this.repo.createJob({
      userId: user.id,
      kind,
      seriesKey: input.seriesKey,
      seriesUrl: series.sourceUrl,
      title: series.title.slice(0, 1000),
      author: finalAuthors.join(', ').slice(0, 1000) || null,
      sourceName: series.sourceName.slice(0, 255),
      packaging: input.packaging,
      selection: input.selection,
      skipImported: input.skipImported ?? true,
      targetLibraryId: input.libraryId,
      targetFolderId: folderId,
      status: 'queued',
      engineState: { hasCover: series.remoteCoverPath !== null, units: selectedUnits },
      metadata,
    });
    this.logger.log(
      `[${CREATE_EVENT}] [end] jobId=${created.id} userId=${user.id} kind=${kind} packaging=${input.packaging} libraryId=${input.libraryId} durationMs=${Date.now() - startedAt} title="${sanitizeLogValue(created.title)}" - job queued`,
    );
    return this.requireJob(created.id, user);
  }

  async listJobs(user: RequestUser, scope: WebSerialJobScope = 'mine', limit = 50, offset = 0): Promise<WebSerialJobList> {
    const userId = this.scopeUserId(user, scope);
    const [rows, activeCount, counts, queuePaused] = await Promise.all([
      this.repo.listJobs(userId, limit, offset),
      this.repo.countActiveJobs(userId),
      this.repo.countJobs(userId),
      this.settings.isQueuePaused(),
    ]);
    return {
      items: rows.map((row) => toWebSerialJob(row, scope === 'all')),
      activeCount,
      total: counts.total,
      finishedCount: counts.finishedCount,
      queuePaused,
    };
  }

  async getJobDetail(id: number, user: RequestUser): Promise<WebSerialJobDetail> {
    const job = await this.getAccessibleJob(id, user);
    const items = await this.repo.findItemsForDetail(id);
    return {
      job: toWebSerialJob(job, this.showsOwner(job, user)),
      items: items.map((item) => ({
        id: item.id,
        label: item.label,
        sequence: item.sequence,
        status: item.status,
        error: item.error,
        bookId: item.bookId,
        updatedAt: item.updatedAt.toISOString(),
      })),
    };
  }

  async cancelJob(id: number, user: RequestUser): Promise<WebSerialJob> {
    await this.getAccessibleJob(id, user);
    await this.repo.cancelJob(id);
    this.runner.abortJob(id);
    if (await this.runner.waitForJobToSettle(id, CANCEL_SETTLE_TIMEOUT_MS)) await this.discardWorkDir(id);
    return this.requireJob(id, user);
  }

  async retryJob(id: number, user: RequestUser): Promise<WebSerialJob> {
    const job = await this.getAccessibleJob(id, user);
    await this.assertRoomToRequeue(job);
    const requeued = await this.repo.requeueForRetry(id);
    if (!requeued)
      throw new ConflictException(
        codedError('Only downloads that failed or finished with gaps can be retried', WebSerialErrorCode.JobRetryNotAllowed),
      );
    return this.requireJob(id, user);
  }

  /** A finished job that goes back to the queue counts towards the owner's cap again. */
  private async assertRoomToRequeue(job: WebSerialJobWithLibrary): Promise<void> {
    if (!REQUEUED_ON_RETRY.has(job.status)) return;
    if ((await this.repo.countCappedJobsForUser(job.userId)) >= MAX_ACTIVE_JOBS_PER_USER) throw tooManyJobs();
  }

  async pauseJob(id: number, user: RequestUser): Promise<WebSerialJob> {
    const startedAt = Date.now();
    await this.getAccessibleJob(id, user);
    const paused = await this.repo.pauseJob(id);
    if (!paused) throw new ConflictException(codedError('Only waiting or running downloads can be paused', WebSerialErrorCode.JobPauseNotAllowed));
    this.runner.interruptChapterFetch(id);
    this.logger.log(`[${QUEUE_EVENT}] [end] jobId=${id} userId=${user.id} durationMs=${Date.now() - startedAt} action=pause - job paused`);
    return this.requireJob(id, user);
  }

  /** Jobs paused before paused ones counted towards the cap can exceed it; such a job waits until others finish. */
  async resumeJob(id: number, user: RequestUser): Promise<WebSerialJob> {
    const startedAt = Date.now();
    const job = await this.getAccessibleJob(id, user);
    if (job.status === 'paused' && (await this.repo.countActiveJobs(job.userId)) >= MAX_ACTIVE_JOBS_PER_USER) throw tooManyJobs();
    const resumed = await this.repo.resumeJob(id);
    if (!resumed) throw new ConflictException(codedError('Only paused downloads can be resumed', WebSerialErrorCode.JobResumeNotAllowed));
    this.logger.log(`[${QUEUE_EVENT}] [end] jobId=${id} userId=${user.id} durationMs=${Date.now() - startedAt} action=resume - job resumed`);
    return this.requireJob(id, user);
  }

  async moveJobToTop(id: number, user: RequestUser): Promise<WebSerialJob> {
    const startedAt = Date.now();
    await this.getAccessibleJob(id, user);
    const moved = await this.repo.moveJobToTop(id);
    if (!moved) throw new ConflictException(codedError('Only waiting downloads can be moved up the queue', WebSerialErrorCode.JobMoveUpNotAllowed));
    this.logger.log(
      `[${QUEUE_EVENT}] [end] jobId=${id} userId=${user.id} durationMs=${Date.now() - startedAt} action=move_to_top - job moved to the front`,
    );
    return this.requireJob(id, user);
  }

  async removeJob(id: number, user: RequestUser): Promise<void> {
    const job = await this.getAccessibleJob(id, user);
    if (!FINISHED_STATUSES.includes(job.status)) throw new ConflictException(codedError('Cancel it first.', WebSerialErrorCode.JobCancelFirst));
    const startedAt = Date.now();
    const removed = await this.repo.deleteFinishedJob(id);
    if (!removed) throw new ConflictException(codedError('Cancel it first.', WebSerialErrorCode.JobCancelFirst));
    await this.discardWorkDir(id);
    this.logger.log(`[${REMOVE_EVENT}] [end] jobId=${id} userId=${user.id} durationMs=${Date.now() - startedAt} - finished job removed`);
  }

  async clearFinished(user: RequestUser, scope: WebSerialJobScope = 'mine'): Promise<WebSerialClearFinishedResult> {
    const userId = this.scopeUserId(user, scope);
    const startedAt = Date.now();
    this.logger.log(`[${CLEAR_EVENT}] [start] userId=${user.id} scope=${scope} - clearing finished jobs`);
    const removedIds = await this.repo.clearFinishedJobs(userId);
    for (const jobId of removedIds) await this.discardWorkDir(jobId);
    this.logger.log(
      `[${CLEAR_EVENT}] [end] userId=${user.id} scope=${scope} durationMs=${Date.now() - startedAt} removed=${removedIds.length} - finished jobs cleared`,
    );
    return { removed: removedIds.length };
  }

  async retryItem(jobId: number, itemId: number, user: RequestUser): Promise<WebSerialJobDetail> {
    const startedAt = Date.now();
    const job = await this.getAccessibleJob(jobId, user);
    if (job.status === 'cancelled')
      throw new ConflictException(
        codedError('This download was cancelled. Start it again to download the chapters.', WebSerialErrorCode.JobCancelled),
      );
    await this.assertRoomToRequeue(job);
    const rearmed = await this.repo.retryItem(jobId, itemId);
    if (!rearmed) throw new ConflictException(codedError('Only failed items can be retried', WebSerialErrorCode.ItemRetryNotAllowed));
    this.logger.log(
      `[${QUEUE_EVENT}] [end] jobId=${jobId} itemId=${itemId} userId=${user.id} durationMs=${Date.now() - startedAt} action=retry_item - item set to retry`,
    );
    return this.getJobDetail(jobId, user);
  }

  async pauseQueue(user: RequestUser): Promise<{ queuePaused: boolean }> {
    await this.settings.setQueuePaused(true, user);
    return { queuePaused: true };
  }

  async resumeQueue(user: RequestUser): Promise<{ queuePaused: boolean }> {
    await this.settings.setQueuePaused(false, user);
    return { queuePaused: false };
  }

  async discardWorkDir(jobId: number): Promise<void> {
    await this.importer.removeJobWorkDir(jobId);
  }

  private async assertLibraryAcceptsKind(kind: WebSerialKind, libraryId: number): Promise<void> {
    let library: { allowedFormats: string[] };
    try {
      library = await this.libraryService.findOne(libraryId);
    } catch (err) {
      if (err instanceof NotFoundException) throw new BadRequestException(codedError('Library not found', WebSerialErrorCode.LibraryNotFound));
      throw err;
    }
    const format = LIBRARY_FORMAT[kind];
    if (library.allowedFormats.length > 0 && !library.allowedFormats.includes(format)) {
      throw new BadRequestException(codedError(`This library does not accept ${format} files`, WebSerialErrorCode.LibraryFormatRefused, { format }));
    }
  }

  private async resolveFolder(
    libraryId: number,
    requestedFolderId: number | null,
    defaultLibraryId: number | null,
    defaultFolderId: number | null,
  ): Promise<number> {
    const folders = await this.repo.findLibraryFolders(libraryId);
    if (requestedFolderId !== null) {
      if (!folders.some((folder) => folder.id === requestedFolderId))
        throw new BadRequestException(codedError('Folder does not belong to this library', WebSerialErrorCode.FolderNotInLibrary));
      return requestedFolderId;
    }
    if (defaultLibraryId === libraryId && defaultFolderId !== null && folders.some((folder) => folder.id === defaultFolderId)) {
      return defaultFolderId;
    }
    const first = folders[0];
    if (!first) throw new BadRequestException(codedError('This library has no folder to add books to', WebSerialErrorCode.LibraryHasNoFolder));
    return first.id;
  }

  /** Null means every user's jobs, which only an admin may ask for. */
  private scopeUserId(user: RequestUser, scope: WebSerialJobScope): number | null {
    if (scope !== 'all') return user.id;
    if (!isWebSerialsAdmin(user)) throw new ForbiddenException(codedError('Only an admin can see every download', WebSerialErrorCode.AdminOnly));
    return null;
  }

  private showsOwner(job: WebSerialJobWithLibrary, user: RequestUser): boolean {
    return job.userId !== user.id && isWebSerialsAdmin(user);
  }

  async getAccessibleJob(id: number, user: RequestUser): Promise<WebSerialJobWithLibrary> {
    const job = await this.repo.findJobById(id);
    if (!job) throw new NotFoundException(codedError('Download not found', WebSerialErrorCode.JobNotFound));
    if (job.userId !== user.id && !isWebSerialsAdmin(user))
      throw new ForbiddenException(codedError('This download belongs to another user', WebSerialErrorCode.JobForbidden));
    return job;
  }

  async requireJob(id: number, user: RequestUser): Promise<WebSerialJob> {
    const job = await this.repo.findJobById(id);
    if (!job) throw new NotFoundException(codedError('Download not found', WebSerialErrorCode.JobNotFound));
    return toWebSerialJob(job, this.showsOwner(job, user));
  }
}
