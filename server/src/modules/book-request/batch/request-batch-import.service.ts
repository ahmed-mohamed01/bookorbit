import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UNSETTLED_BOOK_REQUEST_DOWNLOAD_STATUSES, WORKER_WRITABLE_BOOK_REQUEST_STATUSES } from '@bookorbit/types';
import { mkdir, opendir, readdir, realpath, rmdir, stat, unlink } from 'fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'path';

import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import type { BookRequestDownloadRow, BookRequestRow } from '../../../db/schema';
import { BookDockRepository } from '../../book-dock/book-dock.repository';
import { BookDockIngestService } from '../../book-dock/book-dock-ingest.service';
import type { ReleasePlan, ReleaseUnit } from '../../scanner/lib/release-plan';
import { BookRequestRepository } from '../book-request.repository';
import { BookRequestGateway } from '../book-request.gateway';
import { BookRequestDownloadRepository } from '../fulfillment/book-request-download.repository';
import { DownloadRemovalService } from '../fulfillment/download-removal.service';
import { RequestFulfillmentService } from '../fulfillment/request-fulfillment.service';
import { MAX_UNIQUE_SUFFIX_ATTEMPTS, RequestImportService, unreadableDownloadMessage } from '../fulfillment/request-import.service';
import type { BatchUnitRow } from '../schema/book-request-batch.schema';
import { BookRequestBatchRepository } from './book-request-batch.repository';
import type { BatchUnitPlacer, RequestImportHook } from './request-import-hook';

/** How long a finished download may keep reporting chosen files that are not all there. */
const BATCH_FILES_GRACE_MS = 30 * 60 * 1000;
const BATCH_FILES_NEVER_ARRIVED = 'The download client reported the download finished, but some selected files never arrived.';

/**
 * The fork's part of importing a finished download: a client that names only the first of several
 * files, and multi-book batches. `RequestImportService` reaches it through `REQUEST_IMPORT_HOOK`.
 */
@Injectable()
export class RequestBatchImportService implements RequestImportHook, OnApplicationBootstrap {
  // Logged under the importer's name: these lines are steps of its import, and log searches rely on it.
  private readonly logger = new Logger(RequestImportService.name);
  private bookDockPath: string;

  constructor(
    private readonly config: ConfigService,
    private readonly downloads: BookRequestDownloadRepository,
    private readonly requests: BookRequestRepository,
    private readonly gateway: BookRequestGateway,
    private readonly dockRepo: BookDockRepository,
    private readonly dockIngest: BookDockIngestService,
    private readonly fulfillment: RequestFulfillmentService,
    private readonly removal: DownloadRemovalService,
    private readonly batches: BookRequestBatchRepository,
  ) {
    this.bookDockPath = this.config.getOrThrow<string>('storage.bookDockPath');
  }

  /** Resolved the way `RequestImportService` resolves it, so dock containment compares the same spelling. */
  async onApplicationBootstrap(): Promise<void> {
    await mkdir(this.bookDockPath, { recursive: true });
    this.bookDockPath = await realpath(this.bookDockPath);
  }

  async importBatch(
    importer: BatchUnitPlacer,
    download: BookRequestDownloadRow,
    request: BookRequestRow,
    root: string,
    plan: ReleasePlan,
    containmentRoot: string,
  ): Promise<boolean> {
    if ((await this.batches.findKinds([request.id])).get(request.id) !== 'batch') return false;
    await this.runBatchImportFromDisk(importer, download, request, root, plan, containmentRoot);
    return true;
  }

  /**
   * A client that wrote several files but named only the first, as Shelfmark does, leaves the rest
   * to be found beside it. Its folder is only taken when it holds exactly those files: in most of
   * Shelfmark's layouts the files land in a folder shared with other books, where nothing says
   * which belong to this one. An ebook then falls back to the file it was named, which is a whole
   * book on its own; an audiobook missing its other parts is not, so it is held. Null when held.
   */
  async contentPath(download: BookRequestDownloadRow, request: BookRequestRow, localPath: string): Promise<string | null> {
    const expected = (await this.downloads.findContentFileCount(download.id)) ?? 1;
    if (expected <= 1) return localPath;
    const info = await stat(localPath).catch(() => null);
    if (info?.isDirectory()) return localPath;

    const folder = dirname(localPath);
    if (await holdsExactlyFiles(folder, expected)) return folder;
    if (request.mediaKind !== 'audiobook') {
      this.logger.log(
        `[book_request.import] [end] requestId=${request.id} downloadId=${download.id} expectedFiles=${expected} - the files share a folder with others, importing the named file alone`,
      );
      return localPath;
    }

    this.logger.warn(
      `[book_request.import] [end] requestId=${request.id} downloadId=${download.id} expectedFiles=${expected} - the files of a multi-file audiobook share a folder with others, holding rather than guessing`,
    );
    await this.fulfillment.holdForReview(
      download,
      request,
      `the download client wrote ${expected} files for this audiobook into a folder that holds other files too, so BookOrbit cannot tell which ones belong to it. In Shelfmark, setting the audiobook file organization to "Rename and group" gives each such download its own folder`,
    );
    return null;
  }

  /**
   * Every ticked unit is placed on its own, so one missing or unplaceable file fails only its row.
   * The download's own book_dock_file_id stays null: verification follows that column, and a batch
   * has no single dock row for it to follow. Rows already in the dock or failed are skipped, which
   * makes a re-run after a crash place only what is left.
   */
  private async runBatchImportFromDisk(
    importer: BatchUnitPlacer,
    download: BookRequestDownloadRow,
    request: BookRequestRow,
    root: string,
    plan: ReleasePlan,
    containmentRoot: string,
  ): Promise<void> {
    const started = Date.now();
    const rows = await this.batches.findUnits(request.id);

    const unreadable = await batchSourceProblem(root, download.contentPath ?? root, plan);
    if (unreadable && unreadable.errorClass !== 'EmptyDownload') {
      await this.failUnreadableBatch(download, request, unreadable, started);
      return;
    }

    const missing = await incompleteBatchFiles(root, rows);
    if (missing > 0) {
      await this.holdIncompleteBatch(download, request, missing, started);
      return;
    }

    await this.downloads.setFilesPendingSince(download.id, null);

    if (unreadable) {
      await this.failUnreadableBatch(download, request, unreadable, started);
      return;
    }

    // 'importing' is accepted so a run resumed after a crash can pick the request up again.
    const claimed = await this.requests.updateIf(request.id, [...WORKER_WRITABLE_BOOK_REQUEST_STATUSES, 'importing'], { status: 'importing' });
    if (!claimed) {
      await this.downloads.updateIf(download.id, UNSETTLED_BOOK_REQUEST_DOWNLOAD_STATUSES, {
        status: 'failed',
        errorMessage: 'The request was settled while this download was finishing, so nothing was imported',
      });
      this.gateway.emitChanged();
      return;
    }
    this.gateway.emitChanged();

    this.logger.log(
      `[book_request.batch_import] [start] requestId=${request.id} downloadId=${download.id} units=${rows.length} - placing batch units`,
    );

    const diskUnits = new Map(plan.units.map((unit) => [unit.primaryPath, unit]));
    let placed = rows.filter((row) => row.status === 'in_dock' || row.status === 'filed').length;
    let failed = 0;

    for (const row of rows) {
      if (row.status !== 'waiting' && row.status !== 'placing') continue;
      if ((await this.requests.findById(request.id))?.request.status !== 'importing') {
        this.logger.warn(
          `[book_request.batch_import] [end] requestId=${request.id} downloadId=${download.id} placed=${placed} failed=${failed} durationMs=${Date.now() - started} - the request was settled mid-import, stopping`,
        );
        await this.downloads.updateIf(download.id, UNSETTLED_BOOK_REQUEST_DOWNLOAD_STATUSES, {
          status: 'failed',
          errorMessage: 'The request was settled while this download was finishing, so the remaining books were not imported',
        });
        this.gateway.emitChanged();
        return;
      }
      const unit = diskUnits.get(row.primaryPath);
      try {
        if (!unit) {
          await this.batches.updateUnit(row.id, { status: 'failed', errorMessage: 'This file was not found in the finished download.' });
          this.logBatchUnitFailure(request.id, row.unitIndex, 'This file was not found in the finished download.');
          failed++;
        } else {
          let dockFileId =
            row.status === 'placing' && row.bookDockFileId !== null ? await this.adoptPlacedUnit(request.id, row.bookDockFileId) : null;
          if (dockFileId === null) {
            await this.batches.updateUnit(row.id, { status: 'placing', errorMessage: null });
            dockFileId = await this.placeBatchUnit(importer, download, request, root, unit, containmentRoot, row.id);
          }
          await this.batches.updateUnit(row.id, { status: 'in_dock', bookDockFileId: dockFileId });
          placed++;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.batches.updateUnit(row.id, { status: 'failed', errorMessage: message.slice(0, 500) });
        this.logBatchUnitFailure(request.id, row.unitIndex, message);
        failed++;
      }
      this.gateway.emitChanged();
    }

    // The request first: a crash between the two leaves a completed download that the resume sweep
    // settles, where the other order would leave the request at 'importing' for good.
    await this.requests.updateIf(
      request.id,
      ['importing'],
      placed > 0 ? { status: 'available' } : { status: 'failed', statusReason: 'None of the ticked books could be placed in Book Dock.' },
    );
    await this.downloads.updateIf(download.id, ['completed'], { status: 'imported' });
    this.logger.log(
      `[book_request.batch_import] [end] requestId=${request.id} downloadId=${download.id} placed=${placed} failed=${failed} durationMs=${Date.now() - started} - batch import finished`,
    );
    this.gateway.emitChanged();
    await this.removal.cleanupStagedDirectDownload(download);
  }

  /**
   * A torrent extended with more files can be reported as finished for a moment before the new
   * files arrive. Nothing is wrong with the units, so the download goes back to being polled; only
   * a client that still disagrees long after the grab fails the batch.
   */
  private async holdIncompleteBatch(download: BookRequestDownloadRow, request: BookRequestRow, missing: number, started: number): Promise<void> {
    const { filesPendingSince } = await this.downloads.findExtension(download.id);
    if (filesPendingSince === null) await this.downloads.setFilesPendingSince(download.id, new Date(started));
    if (filesPendingSince !== null && started - filesPendingSince.getTime() >= BATCH_FILES_GRACE_MS) {
      await this.requests.updateIf(request.id, [...WORKER_WRITABLE_BOOK_REQUEST_STATUSES, 'importing'], {
        status: 'failed',
        statusReason: BATCH_FILES_NEVER_ARRIVED,
      });
      await this.downloads.updateIf(download.id, UNSETTLED_BOOK_REQUEST_DOWNLOAD_STATUSES, {
        status: 'failed',
        errorMessage: BATCH_FILES_NEVER_ARRIVED,
      });
      this.logger.warn(
        `[book_request.batch_import] [fail] requestId=${request.id} downloadId=${download.id} missingUnits=${missing} durationMs=${Date.now() - started} errorClass=FilesNeverArrived error="${sanitizeLogValue(BATCH_FILES_NEVER_ARRIVED)}" - the selected files never arrived`,
      );
      this.gateway.emitChanged();
      return;
    }

    await this.downloads.updateIf(download.id, ['completed', 'importing'], {
      status: 'downloading',
      completedAt: null,
      lastProgressAt: new Date(),
    });
    await this.requests.updateIf(request.id, ['importing'], { status: 'downloading' });
    this.logger.log(
      `[book_request.batch_import] [end] requestId=${request.id} downloadId=${download.id} missingUnits=${missing} durationMs=${Date.now() - started} - selected files are not complete yet, polling the client again`,
    );
    this.gateway.emitChanged();
  }

  /**
   * Units stay 'waiting': nothing was wrong with them, so a later re-run can still place them once
   * the download is readable again.
   */
  private async failUnreadableBatch(
    download: BookRequestDownloadRow,
    request: BookRequestRow,
    problem: { errorClass: string; message: string },
    started: number,
  ): Promise<void> {
    const message = problem.message;
    await this.requests.updateIf(request.id, [...WORKER_WRITABLE_BOOK_REQUEST_STATUSES, 'importing'], {
      status: 'failed',
      statusReason: message,
    });
    await this.downloads.updateIf(download.id, UNSETTLED_BOOK_REQUEST_DOWNLOAD_STATUSES, { status: 'failed', errorMessage: message });
    this.logger.warn(
      `[book_request.batch_import] [fail] requestId=${request.id} downloadId=${download.id} durationMs=${Date.now() - started} errorClass=${problem.errorClass} error="${sanitizeLogValue(message)}" - the finished download could not be read`,
    );
    this.gateway.emitChanged();
    await this.removal.cleanupStagedDirectDownload(download);
  }

  private logBatchUnitFailure(requestId: number, unitIndex: number, message: string): void {
    this.logger.warn(
      `[book_request.batch_import] [fail] requestId=${requestId} unitIndex=${unitIndex} error="${sanitizeLogValue(message)}" - could not place this unit`,
    );
  }

  private async placeBatchUnit(
    importer: BatchUnitPlacer,
    download: BookRequestDownloadRow,
    request: BookRequestRow,
    root: string,
    unit: ReleaseUnit,
    containmentRoot: string,
    unitRowId: number,
  ): Promise<number> {
    let { placement, dockRow, suffix } = await importer.claimDestination(request, root, unit);
    await this.batches.updateUnit(unitRowId, { status: 'placing', bookDockFileId: dockRow.id });
    for (;;) {
      try {
        await importer.placeUnit(placement, containmentRoot, download);
        break;
      } catch (error) {
        await this.dockRepo.deleteById(dockRow.id).catch(() => {});
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || suffix >= MAX_UNIQUE_SUFFIX_ATTEMPTS - 1) {
          await this.batches.updateUnit(unitRowId, { bookDockFileId: null }).catch(() => {});
          throw error;
        }
        ({ placement, dockRow, suffix } = await importer.claimDestination(request, root, unit, suffix + 1));
        await this.batches.updateUnit(unitRowId, { status: 'placing', bookDockFileId: dockRow.id });
      }
    }

    await this.queueBatchDockRow(request.id, dockRow.id, placement.primaryDestPath);
    return dockRow.id;
  }

  /**
   * A unit left at 'placing' with a dock row id was interrupted after its destination was claimed.
   * If that row's file landed, the unit is done; otherwise the stale claim is dropped so placing
   * again cannot leave a second row behind.
   */
  private async adoptPlacedUnit(requestId: number, dockFileId: number): Promise<number | null> {
    const dockRow = await this.dockRepo.findById(dockFileId);
    if (dockRow) {
      const expected = !dockRow.unitDirectory
        ? [{ absolutePath: dockRow.absolutePath, fileSize: dockRow.fileSize }]
        : await this.dockRepo.findUnitFiles(dockFileId);
      const landed =
        expected.length > 0 && (await Promise.all(expected.map((file) => this.hasLanded(file.absolutePath, file.fileSize)))).every(Boolean);
      if (landed) {
        await this.queueBatchDockRow(requestId, dockRow.id, dockRow.absolutePath);
        return dockRow.id;
      }
      await this.removeLeftovers(dockRow, !dockRow.unitDirectory ? [] : expected.map((file) => file.absolutePath));
    }
    await this.dockRepo.deleteById(dockFileId).catch(() => {});
    return null;
  }

  private hasLanded(path: string, size: number | null): Promise<boolean> {
    return stat(path).then(
      (info) => info.isFile() && info.size === size,
      () => false,
    );
  }

  /**
   * A stale claim's files that did land would otherwise be ingested by the Book Dock watcher as a
   * partial second row once the claim is gone. Only paths inside the dock are touched, and the
   * directories are removed with a plain rmdir so anything unexpected inside survives.
   */
  private async removeLeftovers(dockRow: { absolutePath: string; unitDirectory: string | null }, unitFilePaths: string[]): Promise<void> {
    const files = !dockRow.unitDirectory ? [dockRow.absolutePath] : unitFilePaths;
    for (const path of files) {
      if (this.isInsideBookDock(path)) await unlink(path).catch(() => {});
    }
    const directory = dockRow.unitDirectory;
    if (!directory || !this.isInsideBookDock(directory)) return;
    const nested = new Set<string>();
    for (const path of files) {
      for (let dir = dirname(path); dir.startsWith(directory + sep) && this.isInsideBookDock(dir); dir = dirname(dir)) nested.add(dir);
    }
    for (const dir of [...nested].sort((left, right) => right.length - left.length)) await rmdir(dir).catch(() => {});
    await rmdir(directory).catch(() => {});
  }

  private isInsideBookDock(path: string): boolean {
    const rel = relative(this.bookDockPath, path);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  }

  private async queueBatchDockRow(requestId: number, dockFileId: number, primaryDestPath: string): Promise<void> {
    await this.dockIngest.ingestFromWatchedFolder(primaryDestPath).catch((err: unknown) => {
      this.logger.warn(
        `[book_request.batch_import] [fail] requestId=${requestId} dockFileId=${dockFileId} error="${sanitizeLogValue(err instanceof Error ? err.message : String(err))}" - could not queue the dock row, leaving it to the watcher`,
      );
    });
  }
}

/**
 * Whether `folder` holds `expected` files and nothing else. Stops at the first subfolder or the
 * first file past the count, so a shared download folder costs a few entries rather than a walk.
 */
async function holdsExactlyFiles(folder: string, expected: number): Promise<boolean> {
  const dir = await opendir(folder).catch(() => null);
  if (!dir) return false;
  let files = 0;
  for await (const entry of dir) {
    if (!entry.isFile() || ++files > expected) return false;
  }
  return files === expected;
}

/**
 * The directory walk swallows read errors, so an unreadable download looks exactly like one that
 * holds nothing. A batch has to tell the two apart: marking every unit "not found" would blame
 * the files for a problem with the folder.
 */
async function batchSourceProblem(root: string, clientPath: string, plan: ReleasePlan): Promise<{ errorClass: string; message: string } | null> {
  try {
    await readdir(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { errorClass: code ?? 'Error', message: unreadableDownloadMessage(root, clientPath, code) };
  }
  if (plan.units.length === 0) {
    return { errorClass: 'EmptyDownload', message: 'BookOrbit could not read the finished download: the download folder is empty' };
  }
  return null;
}

/**
 * How many waiting units have a file that is missing or smaller than when the batch was created.
 * Rows from before sizes were recorded carry none and are never held back.
 */
async function incompleteBatchFiles(root: string, rows: BatchUnitRow[]): Promise<number> {
  let incomplete = 0;
  for (const row of rows) {
    if ((row.status !== 'waiting' && row.status !== 'placing') || !row.fileSizes || row.fileSizes.length !== row.filePaths.length) continue;
    for (let index = 0; index < row.filePaths.length; index++) {
      const size = await stat(join(root, row.filePaths[index])).then(
        (info) => info.size,
        () => null,
      );
      if (size === null || size < row.fileSizes[index]) {
        incomplete++;
        break;
      }
    }
  }
  return incomplete;
}
