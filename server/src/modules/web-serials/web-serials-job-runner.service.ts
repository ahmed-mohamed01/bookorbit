import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import type { WebSerialChapterRange, WebSerialJobCurrentUnit } from '@bookorbit/types';
import { NotificationService } from '../notification/notification.service';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { UnitDownloadStopped, type EngineDownload, type EngineSeries, type EngineUnitHandle, type EngineUnitSpec } from './engines/web-serial-engine';
import { buildWebSerialOutcomeNotification, type WebSerialOutcome } from './web-serials-notification.utils';
import { isNovelSourceAllowed, isSeriesSourceAllowed, WebSerialsEngineRegistry } from './web-serials-engine-registry.service';
import { DuplicateBookError } from './web-serials-import.errors';
import { WEB_SERIAL_CHAPTER_SIZE_CAP, WebSerialsImportService } from './web-serials-import.service';
import { classifyFailure, failedUnitsMessage, failureText, isEngineJobGone, type FailureReason } from './web-serials-failure.utils';
import { GroupedMangaFetcher } from './web-serials-grouped-manga.fetcher';
import { isGroupedMangaUnit, memberSequence, memberUnitKey, parseGroupedChapters, seriesRangeNumber } from './web-serials-grouped-chapters.utils';
import { failureReasonOf, WebSerialItemRetryPolicy } from './web-serials-item-retry-policy';
import { describeError } from './web-serials-log.utils';
import { buildDockMetadata, growingVolumeRange, volumeKeyBase } from './web-serials-metadata.utils';
import {
  ERROR_MAX_LENGTH,
  importingUnit,
  ITEM_EVENT,
  ItemFailure,
  JOB_EVENT,
  JobStopped,
  type CurrentUnitMapper,
  type ItemRemoteRef,
  type JobContext,
  type RunnerOps,
  unitNoun,
} from './web-serials-runner.shared';
import { WebSerialsSchemaBootstrapService } from './web-serials-schema-bootstrap.service';
import { selectUnits } from './web-serials-selection.utils';
import { WebSerialsSettingsService } from './web-serials-settings.service';
import { fixApostropheCase } from './web-serials-title.utils';
import type { NewWebSerialImportRow, WebSerialJobItemRow, WebSerialJobRow } from './schema/web-serials.schema';
import {
  chapterNumber,
  compactSerialTitle,
  GAPS_NOTE_PREFIX,
  positionalLedgerSequence,
  rangeFromUnitKey,
  WORK_DIR_DONE_STATUSES,
  WebSerialsRepository,
} from './web-serials.repository';

const TICK_MS = 3000;
const POLL_FIRST_MS = 250;
const POLL_INTERVAL_MS = 5000;
const HEARTBEAT_MS = 5000;
const REARMED_PAUSE_MS = 1000;
const MAX_CONSECUTIVE_POLL_ERRORS = 10;
const STALL_TIMEOUT_MS = 6 * 60 * 60_000;
const ALREADY_IMPORTED_NOTE = 'Already in your library.';

@Injectable()
export class WebSerialsJobRunnerService implements OnModuleDestroy {
  private readonly logger = new Logger(WebSerialsJobRunnerService.name);
  private readonly active = new Map<number, Promise<void>>();
  private readonly currentSignatures = new Map<number, string>();
  private readonly shutdown = new AbortController();
  private readonly cancellations = new Map<number, AbortController>();
  private readonly chapterFetches = new Map<number, AbortController>();
  private ticking = false;
  private stopping = false;

  private readonly retries: WebSerialItemRetryPolicy;
  private readonly groupedManga: GroupedMangaFetcher;

  constructor(
    private readonly repo: WebSerialsRepository,
    private readonly bootstrap: WebSerialsSchemaBootstrapService,
    private readonly settings: WebSerialsSettingsService,
    private readonly engines: WebSerialsEngineRegistry,
    private readonly importer: WebSerialsImportService,
    private readonly notifications: NotificationService,
  ) {
    const ops: RunnerOps = {
      now: () => this.now(),
      sleep: (ms) => this.sleep(ms),
      isStopping: () => this.stopping,
      shouldStop: (jobId) => this.shouldStop(jobId),
      writeCurrentUnit: (jobId, current) => this.writeCurrentUnit(jobId, current),
      waitForUnit: (context, handle, toCurrent) => this.waitForUnit(context, handle, toCurrent),
      resolveTargetFolder: (job) => this.resolveTargetFolder(job),
    };
    this.retries = new WebSerialItemRetryPolicy(repo, importer, ops);
    this.groupedManga = new GroupedMangaFetcher(repo, importer, ops);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.shutdown.abort();
    await Promise.allSettled([...this.active.values()]);
  }

  /** Stops the downloads of a running job right away; a job that is not running is unaffected. */
  abortJob(jobId: number): void {
    this.cancellations.get(jobId)?.abort();
  }

  /**
   * Stops a chapter the job is fetching itself (the LNReader EPUB) so a pause or move takes effect at once; the chapters
   * already saved stay for the resume. An engine download or an import already under way finishes undisturbed.
   */
  interruptChapterFetch(jobId: number): void {
    this.chapterFetches.get(jobId)?.abort();
  }

  isJobActive(jobId: number): boolean {
    return this.active.has(jobId);
  }

  waitForJobToSettle(jobId: number, timeoutMs: number): Promise<boolean> {
    const running = this.active.get(jobId);
    if (!running) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), timeoutMs);
      void running.then(
        () => {
          clearTimeout(timeout);
          resolve(true);
        },
        () => {
          clearTimeout(timeout);
          resolve(true);
        },
      );
    });
  }

  @Interval(TICK_MS)
  async tick(): Promise<void> {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    const startedAt = Date.now();
    try {
      await this.bootstrap.ready;
      if (await this.settings.isQueuePaused()) return;
      const free = (await this.settings.getMaxConcurrentJobs()) - this.active.size;
      if (free <= 0) return;
      for (const queued of await this.repo.findQueuedJobs(free)) {
        if (this.active.has(queued.id)) continue;
        const claimed = await this.repo.claimQueuedJob(queued.id);
        if (!claimed) continue;
        const run = this.runJob(claimed).finally(() => this.active.delete(claimed.id));
        this.active.set(claimed.id, run);
      }
    } catch (err) {
      const { errorClass, message } = describeError(err);
      this.logger.error(
        `[${JOB_EVENT}.tick] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - job scheduling failed`,
      );
    } finally {
      this.ticking = false;
    }
  }

  async runJob(job: WebSerialJobRow): Promise<void> {
    const startedAt = Date.now();
    this.logger.log(
      `[${JOB_EVENT}] [start] jobId=${job.id} userId=${job.userId} kind=${job.kind} packaging=${job.packaging} skipImported=${job.skipImported} - job started`,
    );
    const cancellation = new AbortController();
    this.cancellations.set(job.id, cancellation);
    try {
      const context = await this.prepareWithRetry(job, startedAt);
      if (!context) return;
      await this.prepareItems(context);
      for (;;) {
        await this.processItems(context);
        if (await this.finish(context, startedAt)) break;
        await this.sleep(REARMED_PAUSE_MS);
      }
    } catch (err) {
      if (err instanceof JobStopped) return;
      const { errorClass, message } = describeError(err);
      this.logger.error(
        `[${JOB_EVENT}] [fail] jobId=${job.id} userId=${job.userId} kind=${job.kind} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message.slice(0, ERROR_MAX_LENGTH))}" - job failed`,
      );
      await this.repo.refreshCounters(job.id).catch(() => undefined);
      const failureMessage =
        failureReasonOf(err) === 'engine_credentials'
          ? failureText('engine_credentials', job.sourceName)!
          : `The download from ${job.sourceName} could not be completed.`;
      const failed = await this.repo.transitionJob(job.id, ['running', 'importing'], {
        status: 'failed',
        message: failureMessage,
        currentUnit: null,
        finishedAt: new Date(),
      });
      if (failed) await this.announce(job, 'failed', failureMessage);
    } finally {
      this.cancellations.delete(job.id);
      this.currentSignatures.delete(job.id);
      await this.releasePausedItems(job.id);
      await this.removeWorkDirOfFinishedJob(job.id);
    }
  }

  /** Fetched chapters are kept while the job can still resume, Retry included; a completed or cancelled job has no use for them. */
  private async removeWorkDirOfFinishedJob(jobId: number): Promise<void> {
    try {
      const status = await this.repo.getJobStatus(jobId);
      if (status === undefined || WORK_DIR_DONE_STATUSES.includes(status)) await this.importer.removeJobWorkDir(jobId);
    } catch {
      return;
    }
  }

  /**
   * The engine can be restarting; a retryable failure here waits out the same delays a unit does before the job gives up.
   * A job that already has items (a resume or a Retry) waits them out whatever the failure, so a source blip never throws
   * away a half-done job.
   */
  private async prepareWithRetry(job: WebSerialJobRow, startedAt: number): Promise<JobContext | null> {
    let hasItems: boolean | null = null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.prepare(job);
      } catch (err) {
        if (err instanceof JobStopped) throw err;
        const reason = classifyFailure(err);
        hasItems ??= Object.keys(await this.repo.countItemsByStatus(job.id)).length > 0;
        const delay = this.retries.nextSetupDelay(attempt, reason, hasItems);
        if (delay === null) throw err;
        const { errorClass, message } = describeError(err);
        this.logger.warn(
          `[${JOB_EVENT}] [fail] jobId=${job.id} userId=${job.userId} durationMs=${Date.now() - startedAt} reason=${reason} errorClass=${errorClass} error="${sanitizeLogValue(message.slice(0, ERROR_MAX_LENGTH))}" retryScheduled=true attempt=${attempt + 1} delayMs=${delay} - job setup will be retried`,
        );
        const text = failureText(reason, job.sourceName) ?? 'The download failed.';
        await this.retries.waitOut(job.id, delay, (minutes) => `Waiting to retry: ${text} Next try in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
      }
    }
  }

  private async prepare(job: WebSerialJobRow): Promise<JobContext | null> {
    const remoteId = job.seriesKey.slice(job.seriesKey.indexOf(':') + 1);
    const config = this.engines.configForSeries ? await this.engines.configForSeries(job.kind, remoteId) : await this.engines.getConfig(job.kind);
    if (!config) {
      const message = 'This download source is not available right now.';
      const failed = await this.repo.transitionJob(job.id, ['running', 'importing'], { status: 'failed', message, finishedAt: new Date() });
      if (failed) await this.announce(job, 'failed', message);
      return null;
    }
    const client = this.engines.client(job.kind, remoteId, config.engine);
    if (job.kind === 'novel' && remoteId.includes(':') && !isNovelSourceAllowed(remoteId, config.allowedSources)) {
      await this.failDisabledSource(job);
      return null;
    }
    const signal = AbortSignal.any([this.shutdown.signal, ...(this.cancellations.has(job.id) ? [this.cancellations.get(job.id)!.signal] : [])]);
    // Pause and move interrupt a long chapter-list load the same way they interrupt a chapter fetch.
    const loading = new AbortController();
    this.chapterFetches.set(job.id, loading);
    let loaded: EngineSeries;
    try {
      loaded = await client.getSeries(config.connection, remoteId, { priority: 'bulk', signal: AbortSignal.any([signal, loading.signal]) });
    } catch (err) {
      if (signal.aborted || loading.signal.aborted) throw new JobStopped();
      throw err;
    } finally {
      this.chapterFetches.delete(job.id);
    }
    const series = { ...loaded, title: fixApostropheCase(loaded.title) };
    if (job.kind === 'manga' && !isSeriesSourceAllowed(series, config.allowedSources)) {
      await this.failDisabledSource(job);
      return null;
    }
    return { job, client, connection: config.connection, remoteId, series, signal };
  }

  private async failDisabledSource(job: WebSerialJobRow): Promise<void> {
    const message = `${job.sourceName} is no longer an enabled source. Ask an admin to enable it, then retry.`;
    const failed = await this.repo.transitionJob(job.id, ['running', 'importing'], { status: 'failed', message, finishedAt: new Date() });
    if (failed) await this.announce(job, 'failed', message);
  }

  /** Expands the selection once; a resumed or retried job keeps the items it already has. */
  private async prepareItems(context: JobContext): Promise<void> {
    const { job, series } = context;
    const existing = await this.repo.countItemsByStatus(job.id);
    if (Object.keys(existing).length === 0) {
      const savedUnits = job.engineState?.['units'];
      const units = Array.isArray(savedUnits) ? (savedUnits as EngineUnitSpec[]) : selectUnits(series, job.packaging, job.selection);
      await this.repo.insertItems(
        units.map((unit) => ({
          jobId: job.id,
          unitKey: unit.unitKey,
          label: unit.label.slice(0, 1000),
          sequence: unit.sequence,
          remoteRef: { unit, handle: null } satisfies ItemRemoteRef,
        })),
      );
      if (job.skipImported) {
        const imported = await this.repo.findImportedUnitKeys(
          job.userId,
          job.seriesKey,
          units.map((unit) => ({
            key: unit.unitKey,
            sequence: unit.sequence,
            packaging: unit.packaging,
            ...(unit.packaging === 'volume' ? { range: unitRange(job, unit) } : {}),
            ...(unit.positional ? { positional: true } : {}),
          })),
          jobMatchKey(job),
          job.kind === 'novel' ? jobSeriesTitles(job) : [],
        );
        await this.repo.skipItems(job.id, imported);
      }
    }
    await this.repo.refreshCounters(job.id);
  }

  private async processItems(context: JobContext): Promise<void> {
    const { job } = context;
    for (;;) {
      if (this.stopping) throw new JobStopped();
      if (await this.shouldStop(job.id)) return;
      const item = await this.repo.findNextItem(job.id, this.now());
      if (!item) {
        const waiting = await this.repo.findWaitingRetries(job.id);
        if (!waiting) return;
        await this.retries.waitForRetries(context, waiting.count, waiting.next);
        continue;
      }
      await this.processItem(context, item);
      await this.repo.refreshCounters(job.id);
    }
  }

  private async processItem(context: JobContext, item: WebSerialJobItemRow): Promise<void> {
    const { job } = context;
    const startedAt = Date.now();
    this.currentSignatures.delete(job.id);
    try {
      const filed = await this.fetchAndImport(context, item);
      if (filed === null) return;
      const { bookId, note } = filed;
      await this.repo.updateItem(item.id, { status: 'imported', bookId, error: note });
      await this.recordImports(job, item, bookId);
      if (context.client.requiresUnitWorkDir) await this.importer.cleanupUnitWorkDir(job.id, item.id);
      await this.discardEngineCopy(context, item);
    } catch (err) {
      if (err instanceof JobStopped) throw err;
      if (context.signal.aborted) throw new JobStopped();
      await this.repo.transitionJob(job.id, ['importing'], { status: 'running' });
      if (err instanceof DuplicateBookError) return await this.skipDuplicate(context, item, err.bookId, startedAt);
      await this.retries.handleFailure(context, item, err, startedAt);
    } finally {
      await this.writeCurrentUnit(job.id, null);
    }
  }

  /** The Book Dock already holds this unit's book (an overlapping job, or a restart after filing): count it as owned. */
  private async skipDuplicate(context: JobContext, item: WebSerialJobItemRow, bookId: number, startedAt: number): Promise<void> {
    const { job } = context;
    if (await this.isShorterCopy(job, item, bookId)) {
      return await this.retries.handleFailure(
        context,
        item,
        new ItemFailure(
          'A shorter copy of this volume already sits where the library would file this one. Ask an admin to add the title to the file naming pattern.',
        ),
        startedAt,
      );
    }
    this.logger.warn(
      `[${ITEM_EVENT}] [end] jobId=${job.id} itemId=${item.id} unitKey="${sanitizeLogValue(item.unitKey)}" bookId=${bookId} durationMs=${Date.now() - startedAt} outcome=skipped - unit was already in the library`,
    );
    await this.repo.updateItem(item.id, { status: 'skipped', bookId, error: ALREADY_IMPORTED_NOTE });
    await this.recordImports(job, item, bookId);
    if (isGroupedMangaUnit(job.kind, (item.remoteRef as ItemRemoteRef).unit)) await this.importer.cleanupUnitWorkDir(job.id, item.id);
    await this.discardEngineCopy(context, item);
  }

  /**
   * A grown volume carries its range in its title, but a file naming pattern without the title files it where the shorter
   * copy already is. The ledger then must not claim the grown range for the shorter book.
   */
  private async isShorterCopy(job: WebSerialJobRow, item: WebSerialJobItemRow, bookId: number): Promise<boolean> {
    const volume = volumeKeyBase(item.unitKey, job.seriesKey);
    if (volume === null) return false;
    const keys = await this.repo.findLedgerKeysForBook(job.userId, job.seriesKey, bookId);
    return keys.some((key) => key !== item.unitKey && volumeKeyBase(key, job.seriesKey) === volume);
  }

  /** The book is in the library, so the engine's copy is dead weight. A failure here is logged and never touches the item. */
  private async discardEngineCopy(context: JobContext, item: WebSerialJobItemRow): Promise<void> {
    const { job, client, connection } = context;
    if (!client.discardUnit) return;
    const startedAt = Date.now();
    try {
      const unit = (item.remoteRef as ItemRemoteRef).unit;
      if (!unit) return;
      const handles = isGroupedMangaUnit(job.kind, unit)
        ? parseGroupedChapters(unit).flatMap((chapter) =>
            chapter.chapterId ? [{ unitKey: chapter.chapterId, remote: { chapterId: chapter.chapterId } }] : [],
          )
        : [{ unitKey: item.unitKey, remote: unit.remote }];
      if (handles.length === 0) return;
      await client.discardUnit(connection, handles);
    } catch (err) {
      const { errorClass, message } = describeError(err);
      this.logger.warn(
        `[web_serials.engine_cleanup] [fail] jobId=${job.id} itemId=${item.id} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message.slice(0, ERROR_MAX_LENGTH))}" - engine copy could not be removed`,
      );
    }
  }

  /** The book exists already, so a failure here is logged and never turns the unit into a failed one. */
  private async recordImports(job: WebSerialJobRow, item: WebSerialJobItemRow, bookId: number): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.repo.recordImports(buildImportRows(job, item, bookId));
    } catch (err) {
      const { errorClass, message } = describeError(err);
      this.logger.warn(
        `[${ITEM_EVENT}] [fail] jobId=${job.id} itemId=${item.id} unitKey="${sanitizeLogValue(item.unitKey)}" durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - import could not be recorded`,
      );
    }
  }

  /** Writes only when the value changed, so a steady poll costs no database write. */
  private async writeCurrentUnit(jobId: number, current: WebSerialJobCurrentUnit | null): Promise<void> {
    const signature = JSON.stringify(current);
    if (this.currentSignatures.get(jobId) === signature) return;
    this.currentSignatures.set(jobId, signature);
    if (current === null) this.currentSignatures.delete(jobId);
    try {
      await this.repo.setCurrentUnit(jobId, current);
    } catch {
      this.currentSignatures.delete(jobId);
    }
  }

  /** Null when the job was cancelled, paused or moved before the unit finished. The note says what the filed book is missing. */
  private async fetchAndImport(context: JobContext, item: WebSerialJobItemRow): Promise<{ bookId: number; note: string | null } | null> {
    const { job, client, connection, remoteId, series } = context;
    const ref = item.remoteRef as ItemRemoteRef;
    if (!ref.unit) throw new ItemFailure('The unit description is missing');

    if (isGroupedMangaUnit(job.kind, ref.unit)) {
      const bookId = await this.groupedManga.fetchAndImport(context, item, { ...ref, unit: ref.unit });
      return bookId === null ? null : { bookId, note: null };
    }

    await this.repo.updateItem(item.id, { status: 'fetching' });
    let handle: EngineUnitHandle = { unitKey: item.unitKey, remote: ref.handle ?? {} };
    if (!ref.handle) {
      const unit = client.requiresUnitWorkDir
        ? { ...ref.unit, remote: { ...ref.unit.remote, workDir: await this.importer.prepareUnitWorkDir(job.id, item.id) } }
        : ref.unit;
      handle = await client.startUnit(connection, remoteId, unit);
      await this.repo.updateItem(item.id, { remoteRef: { ...ref, handle: handle.remote } });
    }

    const single: CurrentUnitMapper = (progress) => ({
      label: item.label,
      stage: progress.stage ?? 'fetching',
      chaptersDone: progress.chaptersDone ?? null,
      chaptersTotal: progress.chaptersTotal ?? null,
      progress: progress.progress,
    });
    const keepHandle = async (remote: EngineUnitHandle['remote']) => {
      await this.repo.updateItem(item.id, { remoteRef: { ...ref, handle: remote } });
    };
    if (!(await this.waitForUnit(context, handle, single, keepHandle))) return this.abandonUnit(context, item, handle);

    // A unit built from chapters fetched here (the LNReader EPUB) is still fetching until its book exists.
    let built: EngineDownload | null = null;
    if (client.requiresUnitWorkDir) {
      const fetching = new AbortController();
      this.chapterFetches.set(job.id, fetching);
      try {
        built = await client.download(
          connection,
          handle,
          AbortSignal.any([context.signal, fetching.signal]),
          async (progress) => {
            await this.writeCurrentUnit(job.id, {
              label: item.label,
              stage: progress.stage,
              chaptersDone: progress.chaptersDone,
              chaptersTotal: progress.chaptersTotal,
              progress: progress.chaptersTotal > 0 ? progress.chaptersDone / progress.chaptersTotal : null,
            });
          },
          { shouldStop: () => this.shouldStop(job.id), allowMissingChapters: this.retries.isFinalAttempt(ref.attempts ?? 0) },
        );
      } catch (err) {
        if (err instanceof UnitDownloadStopped || (fetching.signal.aborted && !context.signal.aborted))
          return this.abandonUnit(context, item, handle);
        throw err;
      } finally {
        this.chapterFetches.delete(job.id);
      }
    }
    if (!(await this.repo.transitionJob(job.id, ['running', 'importing'], { status: 'importing', heartbeatAt: new Date() }))) {
      if (built) closeDownload(built);
      return this.abandonUnit(context, item, handle);
    }
    await this.repo.updateItem(item.id, { status: 'importing' });
    await this.writeCurrentUnit(job.id, importingUnit(item.label));
    const targetFolderId = await this.resolveTargetFolder(job);
    const download = built ?? (await client.download(connection, handle, context.signal));
    const bookId = await this.importer.importUnit({
      jobId: job.id,
      itemId: item.id,
      userId: job.userId,
      kind: job.kind,
      download,
      metadata: buildDockMetadata(
        series,
        {
          label: item.label,
          sequence: item.sequence,
          publishedAt: ref.unit.publishedAt,
          chapterRange: growingVolumeRange(item.unitKey, job.seriesKey),
        },
        ref.unit.packaging,
        job.metadata,
      ),
      targetLibraryId: job.targetLibraryId,
      targetFolderId,
      ...(job.kind === 'manga' ? { maxBytes: WEB_SERIAL_CHAPTER_SIZE_CAP } : {}),
    });
    await this.repo.transitionJob(job.id, ['importing'], { status: 'running', heartbeatAt: new Date() });
    return { bookId, note: missingChaptersNote(download.missingChapters) };
  }

  /** Stops the engine job and hands the unit back, so a resume never picks up the cancelled engine job. */
  private async abandonUnit(context: JobContext, item: WebSerialJobItemRow, handle: EngineUnitHandle): Promise<null> {
    await context.client.cancelUnit?.(context.connection, handle).catch(() => undefined);
    await this.repo.releaseItem(item.id);
    return null;
  }

  /**
   * Polls until the engine has the unit ready. False when the job was cancelled meanwhile. An engine that moves its handle
   * on (lightnovel-crawler's build step) has it saved through `keepHandle`, so a restart resumes that step and never starts it twice.
   */
  private async waitForUnit(
    context: JobContext,
    handle: EngineUnitHandle,
    toCurrent: CurrentUnitMapper,
    keepHandle?: (remote: EngineUnitHandle['remote']) => Promise<void>,
  ): Promise<boolean> {
    const { job, client, connection } = context;
    let lastChange = Date.now();
    let lastSignature = '';
    let errors = 0;
    let pollDelay = POLL_FIRST_MS;
    let lastHeartbeat = 0;
    for (;;) {
      if (this.stopping) throw new JobStopped();
      if (await this.shouldStop(job.id)) return false;
      try {
        const before = keepHandle ? JSON.stringify(handle.remote) : '';
        const progress = await client.pollUnit(connection, handle);
        if (keepHandle && JSON.stringify(handle.remote) !== before) await keepHandle(handle.remote);
        errors = 0;
        if (progress.state === 'done') return true;
        if (progress.state === 'failed') {
          const reason = progress.reason || 'The source could not provide this unit';
          throw new ItemFailure(reason, classifyFailure(reason));
        }
        await this.writeCurrentUnit(job.id, toCurrent(progress));
        const signature = `${progress.state}:${progress.progress ?? ''}:${progress.chaptersDone ?? ''}:${progress.stage ?? ''}`;
        if (signature !== lastSignature) {
          lastSignature = signature;
          lastChange = Date.now();
        }
      } catch (err) {
        if (err instanceof ItemFailure) throw err;
        if (isEngineJobGone(err)) throw new ItemFailure('The download service no longer has this job', 'engine_job_lost');
        errors += 1;
        if (errors >= MAX_CONSECUTIVE_POLL_ERRORS) throw err;
      }
      if (Date.now() - lastChange > STALL_TIMEOUT_MS) throw new ItemFailure('The source stopped making progress');
      if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
        lastHeartbeat = Date.now();
        await this.repo.heartbeat(job.id);
      }
      await this.sleep(pollDelay);
      pollDelay = Math.min(pollDelay * 2, POLL_INTERVAL_MS);
    }
  }

  /** True when the job reached an end state (or was stopped); false when an item was re-armed meanwhile and the loop must run again. */
  private async finish(context: JobContext, startedAt: number): Promise<boolean> {
    const { job } = context;
    await this.repo.refreshCounters(job.id);
    const counts = await this.repo.countItemsByStatus(job.id);
    const imported = counts.imported ?? 0;
    const failed = counts.failed ?? 0;
    const skipped = counts.skipped ?? 0;
    const gapped = imported > 0 ? await this.repo.countGappedImports(job.id) : 0;
    const status = failed === 0 && gapped === 0 ? 'completed' : imported === 0 ? 'failed' : 'completed_with_gaps';
    const noun = unitNoun(job);
    const failedMessage =
      failed === 0
        ? null
        : failedUnitsMessage((await this.repo.countFailureReasons(job.id)) as Map<FailureReason, number>, failed, noun, job.sourceName);
    const message = [failedMessage, gapped > 0 ? gappedUnitsMessage(gapped, noun) : null].filter(Boolean).join(' ') || null;
    const finished = await this.repo.transitionJob(
      job.id,
      ['running', 'importing'],
      { status, message, currentUnit: null, finishedAt: new Date() },
      { requireSettledItems: true },
    );
    if (!finished) {
      const current = await this.repo.getJobStatus(job.id);
      if (current === 'running' || current === 'importing') return false;
      const outcome = current === 'paused' ? 'paused' : current === 'queued' ? 'requeued' : 'cancelled';
      this.logger.log(
        `[${JOB_EVENT}] [end] jobId=${job.id} userId=${job.userId} kind=${job.kind} durationMs=${Date.now() - startedAt} outcome=${outcome} imported=${imported} - job stopped`,
      );
      return true;
    }
    this.logger.log(
      `[${JOB_EVENT}] [end] jobId=${job.id} userId=${job.userId} kind=${job.kind} durationMs=${Date.now() - startedAt} outcome=${status} imported=${imported} failed=${failed} skipped=${skipped} gapped=${gapped} - job finished`,
    );
    await this.announce(job, status, message);
    return true;
  }

  /** The job's folder can be deleted while it runs (the FK nulls it); fall back to the library's first folder. */
  private async resolveTargetFolder(job: WebSerialJobRow): Promise<number> {
    const folders = await this.repo.findLibraryFolders(job.targetLibraryId);
    if (job.targetFolderId !== null && folders.some((folder) => folder.id === job.targetFolderId)) return job.targetFolderId;
    const first = folders[0];
    if (!first) throw new ItemFailure('The target library has no folder to add books to');
    return first.id;
  }

  /** Anything but running or importing ends this run between polls: a cancel, a pause, or a pause resumed before the run noticed. */
  private async shouldStop(jobId: number): Promise<boolean> {
    const status = await this.repo.getJobStatus(jobId);
    return status !== 'running' && status !== 'importing';
  }

  /** A paused job keeps every item; a half-done one goes back to pending with its engine handle dropped. */
  private async releasePausedItems(jobId: number): Promise<void> {
    const startedAt = Date.now();
    try {
      if ((await this.repo.getJobStatus(jobId)) !== 'paused') return;
      const released = await this.repo.releaseInFlightItems(jobId);
      await this.repo.refreshCounters(jobId);
      this.logger.log(`[${JOB_EVENT}.pause] [end] jobId=${jobId} durationMs=${Date.now() - startedAt} releasedItems=${released} - job paused`);
    } catch (err) {
      const { errorClass, message } = describeError(err);
      this.logger.error(
        `[${JOB_EVENT}.pause] [fail] jobId=${jobId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - paused job items could not be released`,
      );
    }
  }

  private async announce(job: WebSerialJobRow, outcome: WebSerialOutcome, message: string | null): Promise<void> {
    const startedAt = Date.now();
    try {
      const row = await this.repo.findJobById(job.id);
      const payload = buildWebSerialOutcomeNotification({
        jobId: job.id,
        title: job.title,
        noun: unitNoun(job),
        outcome,
        message,
        imported: row?.unitsDone ?? 0,
        libraryName: row?.libraryName ?? null,
      });
      await this.notifications.upsertByGroupKey(job.userId, payload.groupKey, payload.patch, { markUnread: true });
    } catch (err) {
      const { errorClass, message: reason } = describeError(err);
      this.logger.warn(
        `[${JOB_EVENT}.notify] [fail] jobId=${job.id} userId=${job.userId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(reason)}" - outcome notification failed`,
      );
    }
  }

  protected now(): Date {
    return new Date();
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function closeDownload(download: EngineDownload): void {
  const stream = download.stream as { destroy?: () => void; cancel?: () => Promise<void> };
  if (typeof stream.destroy === 'function') stream.destroy();
  else void stream.cancel?.().catch(() => undefined);
}

function missingChaptersNote(chapters: string[] | undefined): string | null {
  if (!chapters || chapters.length === 0) return null;
  const shown = chapters.slice(0, 3).join(', ');
  const more = chapters.length > 3 ? ` and ${chapters.length - 3} more` : '';
  return `${GAPS_NOTE_PREFIX} ${shown}${more} could not be downloaded.`.slice(0, ERROR_MAX_LENGTH);
}

function gappedUnitsMessage(gapped: number, noun: string): string {
  return `${gapped} ${noun}${gapped === 1 ? ' was' : 's were'} added with missing chapters.`;
}

/** The volume part of a volume key: `volume-3` of `volume-3:201-250`, `vol:12` of `vol:12:100-103`. */
/** The chapters a unit holds, as the ledger records them; computed for units stored before they carried it. */
function unitRange(job: WebSerialJobRow, unit: EngineUnitSpec): WebSerialChapterRange | null {
  if (unit.chapterRange) return unit.chapterRange;
  const fromKey = rangeFromUnitKey(job.seriesKey, unit.unitKey);
  if (fromKey) return fromKey;
  if (isGroupedMangaUnit(job.kind, unit)) {
    const members = parseGroupedChapters(unit).flatMap((chapter) => (chapter.sequence === null || chapter.positional ? [] : [chapter.sequence]));
    const numbers = members.flatMap((sequence) => (chapterNumber(sequence) === null ? [] : [chapterNumber(sequence)!]));
    return numbers.length > 0 ? { from: Math.min(...numbers), to: Math.max(...numbers) } : null;
  }
  const number = unit.positional ? null : chapterNumber(unit.sequence);
  return job.kind === 'manga' && number !== null ? { from: number, to: number } : null;
}

function jobSeriesTitles(job: WebSerialJobRow): string[] {
  return [job.title, job.metadata?.match?.title].filter((title): title is string => Boolean(title));
}

function jobMatchKey(job: WebSerialJobRow): string | null {
  const id = job.metadata?.match?.id ?? job.metadata?.override?.matchId ?? null;
  return id ? `mb:${id}` : null;
}

function buildImportRows(job: WebSerialJobRow, item: WebSerialJobItemRow, bookId: number): NewWebSerialImportRow[] {
  const base = {
    userId: job.userId,
    seriesKey: job.seriesKey,
    matchKey: jobMatchKey(job),
    kind: job.kind,
    packaging: job.packaging,
    bookId,
    titleKey: compactSerialTitle(job.title).slice(0, 1000) || null,
  };
  const unit = (item.remoteRef as ItemRemoteRef).unit;
  const range = unit ? unitRange(job, unit) : null;
  const ranged = { chapterFrom: range?.from ?? null, chapterTo: range?.to ?? null };
  if (!unit || !isGroupedMangaUnit(job.kind, unit)) {
    const sequence = unit?.positional ? positionalLedgerSequence(item.sequence) : item.sequence;
    return [{ ...base, ...ranged, unitKey: item.unitKey.slice(0, 255), sequence: sequence.slice(0, 20) }];
  }
  const members = parseGroupedChapters(unit).map((chapter, index) => {
    const sequence = memberSequence(chapter, index);
    return {
      ...base,
      unitKey: memberUnitKey(chapter, item.unitKey, index).slice(0, 255),
      sequence: (chapter.positional ? positionalLedgerSequence(sequence) : sequence).slice(0, 20),
    };
  });
  return [{ ...base, ...ranged, unitKey: item.unitKey.slice(0, 255), sequence: seriesRangeNumber(unit).slice(0, 20) }, ...members];
}
