import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  languageSubtagOf,
  READ_ALOUD_QUARTZNET_LANGUAGES,
  type ReadAloudErrorCode,
  type ReadAloudWorkerJob,
  type ReadAloudWorkerRequest,
} from '@bookorbit/types';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { readAloudConfig } from '../../config/config';
import { AudioPlayOrderService } from '../audiobook-chapters/audio-play-order.service';
import {
  ReadAloudWorkerClientService,
  WorkerJobNotFoundError,
  WorkerRejectedError,
  WorkerUnreachableError,
} from '../read-aloud/read-aloud-worker-client.service';
import { ReadAloudWorkspace } from '../read-aloud/read-aloud-workspace.service';
import {
  READ_ALOUD_CANCEL_WAIT_MS,
  READ_ALOUD_MAX_RESUBMITS,
  READ_ALOUD_POLL_INTERVAL_MS,
  READ_ALOUD_UNREACHABLE_BACKOFF_MS,
  READ_ALOUD_UNREACHABLE_WINDOW_MS,
} from '../read-aloud/read-aloud.constants';
import { buildEpubMediaOverlayPlaylistFromFile } from '../reader/epub/epub-media-overlay';
import { EDITION_SYNC_MAX_ATTEMPTS, EDITION_SYNC_PROGRESS_WRITE_MS } from './edition-sync.constants';
import { EditionSyncIndexStoreService } from './edition-sync-index-store.service';
import { EditionSyncSourcesChangedError } from './edition-sync-provenance';
import { EditionSyncOverlaySourceService } from './edition-sync-overlay-source.service';
import { EditionSyncRepository } from './edition-sync.repository';
import type { EditionSyncClaim, EditionSyncIndexJobOptions, EditionSyncIndexOutcome } from './edition-sync.types';

@Injectable()
export class EditionSyncIndexerService {
  private readonly logger = new Logger(EditionSyncIndexerService.name);
  private active: string | null = null;
  private cancelled = false;

  constructor(
    private readonly repo: EditionSyncRepository,
    private readonly worker: ReadAloudWorkerClientService,
    private readonly workspace: ReadAloudWorkspace,
    private readonly store: EditionSyncIndexStoreService,
    private readonly playOrder: AudioPlayOrderService,
    private readonly overlaySource: EditionSyncOverlaySourceService,
    @Inject(readAloudConfig.KEY) private readonly config: ConfigType<typeof readAloudConfig>,
  ) {}

  get currentWorkerJobId(): string | null {
    return this.active;
  }

  async indexBook(claim: EditionSyncClaim, options: EditionSyncIndexJobOptions): Promise<EditionSyncIndexOutcome> {
    if (this.active) throw new ConflictException('An edition sync job is already running');
    this.active = claim.workerJobId;
    this.cancelled = false;
    const started = Date.now();
    this.logger.log(
      `[edition_sync.index_book] [start] bookId=${claim.bookId} workerJobId=${claim.workerJobId} pinned=${claim.pinned} - indexing started`,
    );
    const outcome = (
      status: EditionSyncIndexOutcome['status'],
      errorCode: ReadAloudErrorCode | null = null,
      error: string | null = null,
      audioSeconds: number | null = null,
    ): EditionSyncIndexOutcome => ({ ...claim, status, durationMs: Date.now() - started, audioSeconds, errorCode, error });
    try {
      const row = await this.repo.findIndexRow(claim.bookId);
      await this.repo.updateIndexRow(claim.bookId, { status: 'running', attemptCount: row?.attemptCount ?? 0 });
      const source = await this.repo.findIndexSource(claim.bookId);
      if (!source) throw new NotFoundException('Index source files are missing');
      const health = await this.worker.healthState(true);
      if (health.state === 'unreachable') throw new WorkerUnreachableError('Read-aloud worker is unreachable');
      if (health.state !== 'ok') throw new WorkerRejectedError('worker_unavailable', 'Read-aloud worker is unavailable');
      if (!(await this.isMounted(dirname(source.epub.absolutePath), health.health.libraryRoots)))
        throw new WorkerRejectedError('library_not_mounted', 'The book folder is not mounted on the worker');
      const order = await this.playOrder.resolveAudioPlayOrder(claim.bookId);
      const byId = new Map(source.audio.map((file) => [file.id, file]));
      const audio = order.map((entry) => byId.get(entry.fileId)).filter((file) => file !== undefined);
      if (audio.length !== source.audio.length || !audio.length) throw new BadRequestException('Audio play order changed');
      for (const file of audio) {
        if (!(await this.isMounted(dirname(file.absolutePath), health.health.libraryRoots)))
          throw new WorkerRejectedError('library_not_mounted', 'An audio folder is not mounted on the worker');
      }
      await this.workspace.ensure(claim.workerJobId);
      const request: ReadAloudWorkerRequest = {
        jobId: claim.workerJobId,
        epubPath: source.epub.absolutePath,
        audioPaths: audio.map((file) => file.absolutePath),
        workDir: this.workspace.dir(claim.workerJobId),
        language: languageSubtagOf(source.language, READ_ALOUD_QUARTZNET_LANGUAGES) ?? 'en',
        granularity: 'sentence',
        model: 'quartznet15x5',
        sourceBytes: [source.epub, ...audio].reduce((total, file) => total + (file.sizeBytes ?? 0), 0),
        audioDurationSeconds: audio.every((file) => file.durationSeconds !== null)
          ? audio.reduce((total, file) => total + (file.durationSeconds ?? 0), 0)
          : null,
        maxOutputBytes: this.config.maxOutputBytes,
        decisions: { chapters: {}, audio: [] },
        resumeFrom: null,
      };
      const result = await this.runOnWorker(claim, request, options);
      if (result === 'yielded' || result === 'cancelled') {
        await this.repo.markRunningStale(claim.bookId, result === 'yielded' ? 'yielded' : 'interrupted');
        this.logger.log(
          `[edition_sync.index_book] [end] bookId=${claim.bookId} workerJobId=${claim.workerJobId} durationMs=${Date.now() - started} status=${result} - indexing stopped`,
        );
        return outcome(result);
      }
      if (result.status !== 'completed') {
        const code = result.errorCode ?? (result.status === 'cancelled' ? 'cancelled' : 'unknown');
        if (result.status === 'cancelled') {
          await this.repo.markRunningStale(claim.bookId, 'interrupted');
          return outcome('cancelled', code, result.error);
        }
        throw new WorkerRejectedError(code, result.error ?? 'Read-aloud worker failed');
      }
      const playlist = await buildEpubMediaOverlayPlaylistFromFile(this.workspace.outputPath(claim.workerJobId), claim.bookId, null);
      if (!playlist.items.length) throw new WorkerRejectedError('invalid_output', 'Aligned EPUB has no media overlay items');
      const captured = await this.store.capture({
        bookId: claim.bookId,
        workDir: request.workDir,
        request,
        sources: { epub: source.epub, audio },
        workerVersion: health.health.version,
      });
      await this.repo.updateIndexRow(
        claim.bookId,
        {
          status: 'ready',
          attemptCount: 0,
          indexFileId: row?.indexPath === captured.indexPath ? row.indexFileId : null,
          report: { jobId: claim.workerJobId, totals: captured.provenance.report, coverage: null, chapters: [] },
          stage: null,
          progress: null,
          indexPath: captured.indexPath,
          indexBytes: captured.indexBytes,
          provenance: captured.provenance,
          workerVersion: captured.provenance.workerVersion,
          indexedAt: new Date(),
          invalidatedAt: null,
          invalidatedReason: null,
          errorCode: null,
          lastError: null,
          failedAt: null,
          retryRequested: false,
          pinnedAt: null,
        },
        row?.lastAttemptAt ?? new Date(started),
      );
      this.overlaySource.invalidateBook(claim.bookId);
      if (row?.indexPath && row.indexPath !== captured.indexPath)
        await this.store.removeSupersededIndex(claim.bookId, row.indexPath, captured.indexPath);
      await this.workspace.remove(claim.workerJobId);
      this.logger.log(
        `[edition_sync.index_book] [end] bookId=${claim.bookId} workerJobId=${claim.workerJobId} durationMs=${Date.now() - started} sentences=${captured.provenance.report.sentences} matched=${captured.provenance.report.matchedSentences} indexBytes=${captured.indexBytes} - indexing completed`,
      );
      return outcome('ready', null, null, request.audioDurationSeconds);
    } catch (error) {
      if (error instanceof EditionSyncSourcesChangedError) {
        await this.repo.markRunningStale(claim.bookId, error.reason);
        this.logger.warn(
          `[edition_sync.index_book] [fail] bookId=${claim.bookId} workerJobId=${claim.workerJobId} durationMs=${Date.now() - started} reason=${error.reason} errorClass=${error.name} error="${sanitizeLogValue(error.message)}" - source files changed`,
        );
        return outcome('failed', null, error.message);
      }
      const code = error instanceof WorkerRejectedError ? error.code : error instanceof WorkerUnreachableError ? 'worker_unavailable' : 'unknown';
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
      const row = await this.repo.findIndexRow(claim.bookId);
      const transient = error instanceof WorkerUnreachableError && (row?.attemptCount ?? 0) + 1 < EDITION_SYNC_MAX_ATTEMPTS;
      await this.repo.updateIndexRow(claim.bookId, {
        status: 'failed',
        attemptCount: (row?.attemptCount ?? 0) + 1,
        stage: null,
        progress: null,
        failedAt: new Date(),
        errorCode: code,
        lastError: message,
        retryRequested: transient,
        pinnedAt: null,
      });
      this.logger.warn(
        `[edition_sync.index_book] [fail] bookId=${claim.bookId} workerJobId=${claim.workerJobId} durationMs=${Date.now() - started} errorClass=${error instanceof Error ? error.name : 'Unknown'} error="${sanitizeLogValue(message)}" - indexing failed`,
      );
      return outcome('failed', code, message);
    } finally {
      this.active = null;
    }
  }

  async cancelCurrent(): Promise<void> {
    this.cancelled = true;
    if (this.active) await this.worker.cancel(this.active).catch(() => undefined);
  }

  private async runOnWorker(
    claim: EditionSyncClaim,
    request: ReadAloudWorkerRequest,
    options: EditionSyncIndexJobOptions,
  ): Promise<ReadAloudWorkerJob | 'yielded' | 'cancelled'> {
    let needsSubmit = true;
    let unreachableSince: number | null = null;
    let resubmits = 0;
    let lastWrite = -Infinity;
    for (;;) {
      const yielding = !this.cancelled && !options.shouldStop() && (await options.shouldYield());
      const stopped = this.cancelled || options.shouldStop();
      if (stopped || yielding) {
        await this.cancelAndWait(claim.workerJobId);
        return stopped ? 'cancelled' : 'yielded';
      }
      try {
        const state = needsSubmit ? await this.worker.start(request) : await this.worker.status(claim.workerJobId, Number.MAX_SAFE_INTEGER);
        needsSubmit = false;
        unreachableSince = null;
        if (state.status !== 'queued' && state.status !== 'running') return state;
        if (Date.now() - lastWrite >= EDITION_SYNC_PROGRESS_WRITE_MS) {
          await this.repo.updateIndexRow(claim.bookId, { stage: state.stage, progress: Math.round(state.progress) });
          lastWrite = Date.now();
        }
      } catch (error) {
        if (error instanceof WorkerJobNotFoundError) {
          if (resubmits++ >= READ_ALOUD_MAX_RESUBMITS) throw new WorkerUnreachableError('The worker kept losing the job');
          needsSubmit = true;
        } else if (error instanceof WorkerUnreachableError) {
          unreachableSince ??= Date.now();
          if (Date.now() - unreachableSince >= READ_ALOUD_UNREACHABLE_WINDOW_MS) throw error;
        } else throw error;
      }
      const elapsed = unreachableSince === null ? null : Date.now() - unreachableSince;
      const delay = elapsed === null ? READ_ALOUD_POLL_INTERVAL_MS : READ_ALOUD_UNREACHABLE_BACKOFF_MS[Math.min(3, Math.floor(elapsed / 30_000))]!;
      await sleep(delay);
    }
  }

  private async cancelAndWait(jobId: string): Promise<void> {
    let state = await this.worker.cancel(jobId).catch(() => null);
    const deadline = Date.now() + READ_ALOUD_CANCEL_WAIT_MS;
    while (state && (state.status === 'running' || state.status === 'queued') && Date.now() < deadline) {
      await sleep(READ_ALOUD_POLL_INTERVAL_MS);
      state = await this.worker.status(jobId, Number.MAX_SAFE_INTEGER).catch(() => null);
    }
  }

  // Merge hazard: mirror ReadAloudService.isMounted so symlinked library roots work identically.
  private async isMounted(folderPath: string, roots: string[]): Promise<boolean> {
    const variants = async (path: string) => [...new Set([resolve(path), await realpath(path).catch(() => resolve(path))])];
    const folders = await variants(folderPath);
    const rootVariants = (await Promise.all(roots.map(variants))).flat();
    return folders.some((folder) =>
      rootVariants.some((root) => {
        const rel = relative(root, folder);
        return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
      }),
    );
  }
}
