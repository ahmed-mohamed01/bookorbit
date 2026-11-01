import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { stat } from 'node:fs/promises';
import type { ReadAloudRebuildRequest, ReadAloudWorkerRebuildRequest, ReadAloudWorkerRequest } from '@bookorbit/types';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import type { ReadAloudJobRow } from '../../db/schema';
import type { ReadAloudHooks } from '../read-aloud/read-aloud-hooks';
import { ReadAloudWorkerClientService } from '../read-aloud/read-aloud-worker-client.service';
import { ReadAloudWorkspace } from '../read-aloud/read-aloud-workspace.service';
import {
  EDITION_SYNC_FAILED_WORK_TTL_MS,
  EDITION_SYNC_REBUILD_INDEX_ENTRY,
  EDITION_SYNC_REPORT_ENTRY,
  EDITION_SYNC_SWEEP_INTERVAL_MS,
} from './edition-sync.constants';
import { EditionSyncIndexStoreService } from './edition-sync-index-store.service';
import { isWorkerRebuildValid, matchesRebuildRequest } from './edition-sync-provenance';
import type { EditionSyncCaptureInput } from './edition-sync.types';
import { EditionSyncRepository } from './edition-sync.repository';

@Injectable()
export class EditionSyncReadAloudHooksService implements ReadAloudHooks {
  private readonly logger = new Logger(EditionSyncReadAloudHooksService.name);
  private readonly captureSources = new Map<string, { sources: EditionSyncCaptureInput['sources']; changedSince: Date }>();
  constructor(
    private readonly repo: EditionSyncRepository,
    private readonly store: EditionSyncIndexStoreService,
    private readonly workspace: ReadAloudWorkspace,
    private readonly worker: ReadAloudWorkerClientService,
  ) {}

  async ownsWorkerJob(jobId: string): Promise<boolean> {
    return (await this.repo.findIndexRowByWorkerJobId(jobId))?.status === 'running';
  }

  keepWorkFolders(): Promise<Iterable<string>> {
    return this.repo.findWorkerJobIdsKeepingWork(new Date(Date.now() - EDITION_SYNC_FAILED_WORK_TTL_MS));
  }

  async prepareRequest(job: ReadAloudJobRow, request: ReadAloudWorkerRequest): Promise<ReadAloudWorkerRequest> {
    const started = Date.now();
    try {
      this.captureSources.delete(job.id);
      const sources = await this.store.resolveCaptureSources(job.bookId, request);
      if (sources) {
        this.captureSources.set(job.id, { sources, changedSince: new Date(started) });
        if (this.captureSources.size > 50) this.captureSources.delete(this.captureSources.keys().next().value!);
      }
      const row = await this.repo.findIndexRow(job.bookId);
      if (row?.status !== 'ready' || !row.provenance || Object.keys(job.decisions.chapters).length || job.decisions.audio.length) return request;
      if (!(await this.store.verifyProvenance(job.bookId)).valid) return request;
      const files = await this.repo.findBookFilesByIds([row.provenance.epub.bookFileId, ...row.provenance.audio.map((file) => file.bookFileId)]);
      if (!matchesRebuildRequest(row.provenance, request, files)) return request;
      this.logger.log(`[edition_sync.rebuild] [start] bookId=${job.bookId} workerJobId=${job.id} - preparing rebuild`);
      const rebuild: ReadAloudRebuildRequest = {
        indexEntry: EDITION_SYNC_REBUILD_INDEX_ENTRY,
        reportEntry: EDITION_SYNC_REPORT_ENTRY,
        chunks: row.provenance.chunks,
        sourceEntries: row.provenance.sourceEntries ?? [],
        audioEntries: row.provenance.audioEntries.map(({ href, chunk }) => ({ href, chunk })),
      };
      // The catalog rows can lag an in-place edit of the EPUB until the next rescan.
      // The catalog keeps whole milliseconds while the filesystem reports fractions (and stat().mtime rounds them).
      const epub = await stat(request.epubPath);
      const skipped =
        epub.size !== row.provenance.epub.sizeBytes || Math.abs(epub.mtimeMs - row.provenance.epub.mtimeMs) >= 1
          ? 'epub_changed'
          : !isWorkerRebuildValid(rebuild)
            ? 'worker_incompatible'
            : null;
      if (skipped) {
        this.logger.log(
          `[edition_sync.rebuild] [end] bookId=${job.bookId} workerJobId=${job.id} durationMs=${Date.now() - started} skipped=${skipped} - full alignment instead`,
        );
        return request;
      }
      await this.workspace.ensure(job.id);
      await this.store.copyIndex(job.bookId, `${request.workDir}/${EDITION_SYNC_REBUILD_INDEX_ENTRY}`);
      const rebuilt: ReadAloudWorkerRebuildRequest = { ...request, rebuild };
      this.logger.log(
        `[edition_sync.rebuild] [end] bookId=${job.bookId} workerJobId=${job.id} durationMs=${Date.now() - started} chunks=${row.provenance.chunks.length} - rebuild prepared`,
      );
      return rebuilt;
    } catch (error) {
      this.logFailure('rebuild', job, started, error);
      return request;
    }
  }

  async onOutputValidated(job: ReadAloudJobRow, request: ReadAloudWorkerRequest): Promise<void> {
    const started = Date.now();
    const snapshot = this.captureSources.get(job.id);
    const sources = snapshot?.sources;
    this.captureSources.delete(job.id);
    if (Object.keys(request.decisions.chapters).length || request.decisions.audio.length) {
      this.logger.log(`[edition_sync.capture_hook] [end] bookId=${job.bookId} workerJobId=${job.id} skipped=decisions - capture skipped`);
      return;
    }
    if (!sources) {
      this.logger.log(`[edition_sync.capture_hook] [end] bookId=${job.bookId} workerJobId=${job.id} skipped=sources_unknown - capture skipped`);
      return;
    }
    try {
      const health = await this.worker.healthState();
      const capture = await this.store.capture({
        bookId: job.bookId,
        workDir: request.workDir,
        request,
        sources,
        workerVersion: health.state === 'ok' ? health.health.version : null,
      });
      const previous = await this.repo.findIndexRow(job.bookId);
      await this.repo.upsertIndexRow(
        job.bookId,
        {
          status: 'ready',
          attemptCount: 0,
          indexFileId: previous?.indexPath === capture.indexPath ? previous.indexFileId : null,
          report: { jobId: job.id, totals: capture.provenance.report, coverage: null, chapters: [] },
          indexPath: capture.indexPath,
          indexBytes: capture.indexBytes,
          provenance: capture.provenance,
          workerVersion: capture.provenance.workerVersion,
          indexedAt: new Date(),
          stage: null,
          progress: null,
          invalidatedAt: null,
          invalidatedReason: null,
          failedAt: null,
          errorCode: null,
          lastError: null,
          retryRequested: false,
          pinnedAt: null,
        },
        snapshot!.changedSince,
      );
      if (previous?.indexPath && previous.indexPath !== capture.indexPath)
        await this.store.removeSupersededIndex(job.bookId, previous.indexPath, capture.indexPath);
    } catch (error) {
      this.logFailure('capture_hook', job, started, error);
    }
  }

  @Interval(EDITION_SYNC_SWEEP_INTERVAL_MS)
  async sweepExpiredWork(): Promise<void> {
    const started = Date.now();
    try {
      let folders = 0;
      const before = new Date(Date.now() - EDITION_SYNC_FAILED_WORK_TTL_MS);
      for (;;) {
        const ids = await this.repo.findExpiredWorkerJobIds(before, 200);
        if (!ids.length) break;
        if (!folders) this.logger.log(`[edition_sync.sweep] [start] folders=${ids.length} - removing expired work`);
        for (const id of ids) {
          try {
            await this.workspace.remove(id);
          } catch (error) {
            this.logger.warn(
              `[edition_sync.sweep] [fail] workerJobId=${id} durationMs=${Date.now() - started} errorClass=${error instanceof Error ? error.name : 'Unknown'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - folder removal failed`,
            );
          }
        }
        await this.repo.clearWorkerJobIds(ids);
        folders += ids.length;
        if (ids.length < 200) break;
      }
      if (folders) this.logger.log(`[edition_sync.sweep] [end] durationMs=${Date.now() - started} folders=${folders} - expired work removed`);
    } catch (error) {
      this.logger.warn(
        `[edition_sync.sweep] [fail] durationMs=${Date.now() - started} errorClass=${error instanceof Error ? error.name : 'Unknown'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - sweep failed`,
      );
    }
  }

  private logFailure(event: string, job: ReadAloudJobRow, started: number, error: unknown): void {
    this.logger.warn(
      `[edition_sync.${event}] [fail] bookId=${job.bookId} workerJobId=${job.id} durationMs=${Date.now() - started} errorClass=${error instanceof Error ? error.name : 'Unknown'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - index hook failed`,
    );
  }
}
