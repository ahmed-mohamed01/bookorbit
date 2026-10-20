import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ACTIVE_BOOK_REQUEST_STATUSES, DOWNLOAD_CLIENT_FILE_SELECTION, MAX_BATCH_UNITS } from '@bookorbit/types';
import type { BatchUnitView, BookRequestStatus, BookRequestDownloadStatus } from '@bookorbit/types';

import { isUniqueViolation } from '../../../common/utils/db-error.utils';
import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import type { RequestUser } from '../../../common/types/request-user';
import { BookRequestRepository } from '../book-request.repository';
import { BookRequestGateway } from '../book-request.gateway';
import { BookRequestService } from '../book-request.service';
import type { CreateBatchGrabDto } from '../dto/create-batch-grab.dto';
import { DownloadClientConfigService } from '../download-clients/download-client-config.service';
import { DownloadClientRegistry } from '../download-clients/download-client-registry';
import { BookRequestDownloadRepository } from '../fulfillment/book-request-download.repository';
import { RequestFulfillmentService, TORRENT_BUSY_MESSAGE } from '../fulfillment/request-fulfillment.service';
import { IndexerSearchService } from '../indexers/indexer-search.service';
import type { NewBatchUnitRow } from '../schema/book-request-batch.schema';
import { toUnitView } from './book-request-batch.mapper';
import { BookRequestBatchRepository } from './book-request-batch.repository';

const NOT_RETRYABLE = 'Only a failed batch can be retried.';
const TORRENT_GONE = 'The download client no longer has this torrent, so there is nothing to import. Send the batch again.';
const TORRENT_UNFINISHED = 'The download has not finished in the download client yet. Try again when it has.';
const RETRYABLE_DOWNLOAD_STATUSES: readonly BookRequestDownloadStatus[] = ['failed', 'imported'];

@Injectable()
export class BookRequestBatchService {
  private readonly logger = new Logger(BookRequestBatchService.name);

  constructor(
    private readonly requests: BookRequestRepository,
    private readonly batches: BookRequestBatchRepository,
    private readonly fulfillment: RequestFulfillmentService,
    private readonly clients: DownloadClientConfigService,
    private readonly releases: IndexerSearchService,
    private readonly requestService: BookRequestService,
    private readonly downloads: BookRequestDownloadRepository,
    private readonly registry: DownloadClientRegistry,
    private readonly gateway: BookRequestGateway,
  ) {}

  async settleAvailable(requestId: number, reason: string): Promise<boolean> {
    const moved = await this.requests.updateIf(
      requestId,
      ACTIVE_BOOK_REQUEST_STATUSES.filter((status) => status !== 'available'),
      {
        status: 'available',
        statusReason: reason,
      },
    );
    if (!moved) return false;
    this.gateway.emitChanged();
    this.logger.log(`[book_request.settle_available] [end] requestId=${requestId} moved=true - book request settled as available`);
    return true;
  }

  async findBatchUnits(batchRequestIds: number[]): Promise<Map<number, BatchUnitView[]>> {
    if (batchRequestIds.length > 50) throw new BadRequestException('At most 50 request ids are allowed');
    const result = new Map<number, BatchUnitView[]>();
    if (batchRequestIds.length === 0) return result;
    for (const row of await this.batches.findUnitsForRequests(batchRequestIds)) {
      const units = result.get(row.requestId);
      if (units) units.push(toUnitView(row));
      else result.set(row.requestId, [toUnitView(row)]);
    }
    return result;
  }

  async findBatchUnitByDockFileId(fileId: number): Promise<{ batchRequestId: number; unit: BatchUnitView } | null> {
    const row = await this.batches.findUnitByDockFileId(fileId);
    return row ? { batchRequestId: row.requestId, unit: toUnitView(row) } : null;
  }

  async findRequestsByIds(ids: number[]): Promise<
    Map<
      number,
      {
        userId: number;
        status: BookRequestStatus;
        seriesName: string | null;
        authors: string[] | null;
        targetLibraryId: number | null;
        targetFolderId: number | null;
      }
    >
  > {
    if (ids.length > 50) throw new BadRequestException('At most 50 request ids are allowed');
    if (ids.length === 0) return new Map();
    const rows = await this.requests.findByIds(ids);
    return new Map(
      rows.map(({ request }) => [
        request.id,
        {
          userId: request.userId,
          status: request.status as BookRequestStatus,
          seriesName: request.seriesName,
          authors: request.authors,
          targetLibraryId: request.targetLibraryId,
          targetFolderId: request.targetFolderId,
        },
      ]),
    );
  }

  async create(user: RequestUser, dto: CreateBatchGrabDto): Promise<{ requestId: number }> {
    const startedAt = Date.now();
    this.logger.log(
      `[book_request.batch_create] [start] userId=${user.id} sourceRequestId=${dto.sourceRequestId} units=${dto.unitIndexes.length} clientId=${dto.downloadClientId} - batch grab started`,
    );

    let requestId: number | null = null;
    try {
      const source = await this.requests.findById(dto.sourceRequestId);
      if (!source) throw new NotFoundException('Book request not found');

      const inspection = await this.fulfillment.inspectRelease(dto.sourceRequestId, { indexerId: dto.indexerId, releaseGuid: dto.releaseGuid }, user);
      const selection = inspection.selection;
      if (!selection) {
        if (inspection.unitCount >= 2 || (inspection.totalFiles ?? 0) > MAX_BATCH_UNITS) {
          throw new BadRequestException('This release has more than 2,000 files. Picking books works up to 2,000.');
        }
        throw new BadRequestException('This release holds one book. Use Download release instead.');
      }

      const client = await this.clients.findOne(dto.downloadClientId);
      if (!DOWNLOAD_CLIENT_FILE_SELECTION[client.adapterType]) {
        throw new BadRequestException('Picking books needs a client that can skip files: qBittorrent, Transmission or Deluge.');
      }

      const unitsByIndex = new Map(selection.units.map((unit) => [unit.index, unit]));
      const ticked = dto.unitIndexes.map((index) => unitsByIndex.get(index));
      if (new Set(dto.unitIndexes).size !== dto.unitIndexes.length || ticked.some((unit) => unit === undefined)) {
        throw new BadRequestException('One or more of the chosen books are not part of this release.');
      }

      const imported = new Set(selection.alreadyImported ?? []);
      if (dto.unitIndexes.some((index) => imported.has(index))) {
        throw new BadRequestException('These books are already in Book Dock from an earlier batch.');
      }

      await this.fulfillment.assertTorrentFree({
        sourceRequestId: dto.sourceRequestId,
        indexerId: dto.indexerId,
        releaseGuid: dto.releaseGuid,
        downloadClientId: dto.downloadClientId,
      });

      const filesByUnit = new Map<number, string[]>();
      const sizesByUnit = new Map<number, Array<number | null>>();
      for (const file of selection.files) {
        if (file.unitIndex === null) continue;
        const paths = filesByUnit.get(file.unitIndex);
        const sizes = sizesByUnit.get(file.unitIndex);
        if (paths && sizes) {
          paths.push(file.path);
          sizes.push(file.sizeBytes);
        } else {
          filesByUnit.set(file.unitIndex, [file.path]);
          sizesByUnit.set(file.unitIndex, [file.sizeBytes]);
        }
      }

      const pickedUnits = ticked.filter((unit): unit is NonNullable<typeof unit> => unit !== undefined);
      const wantedPaths = pickedUnits.flatMap((unit) => filesByUnit.get(unit.index) ?? []);
      const sizeBytes = pickedUnits.reduce((total, unit) => total + (unit.sizeBytes ?? 0), 0);
      const mediaKind = pickedUnits.every((unit) => unit.mediaKind === 'audiobook') ? 'audiobook' : 'ebook';
      const title = (
        this.releases.find(dto.sourceRequestId, dto.indexerId, dto.releaseGuid.trim())?.title ??
        selection.rootName ??
        source.request.title
      ).slice(0, 500);

      const row = await this.requests.create({
        userId: user.id,
        mediaKind,
        status: 'approved',
        title,
        authors: source.request.authors,
        targetLibraryId: source.request.targetLibraryId,
        targetFolderId: source.request.targetFolderId,
        dedupeKey: `batch:${randomUUID()}`,
      });
      requestId = row.id;

      await this.batches.setKind(row.id, 'batch');
      await this.batches.insertUnits(
        pickedUnits.map((unit): NewBatchUnitRow => ({
          requestId: row.id,
          unitIndex: unit.index,
          title: unit.title,
          primaryPath: unit.primaryPath,
          filePaths: filesByUnit.get(unit.index) ?? [],
          mediaKind: unit.mediaKind,
          sizeBytes: unit.sizeBytes,
          fileSizes: knownSizes(sizesByUnit.get(unit.index)),
          status: 'waiting',
        })),
      );

      await this.fulfillment.grabSelection(
        {
          sourceRequestId: dto.sourceRequestId,
          batchRequestId: row.id,
          indexerId: dto.indexerId,
          releaseGuid: dto.releaseGuid,
          downloadClientId: dto.downloadClientId,
          wantedPaths,
        },
        user,
      );

      this.logger.log(
        `[book_request.batch_create] [end] requestId=${row.id} userId=${user.id} sourceRequestId=${dto.sourceRequestId} units=${pickedUnits.length} sizeBytes=${sizeBytes} clientId=${dto.downloadClientId} durationMs=${Date.now() - startedAt} - batch grab started`,
      );
      return { requestId: row.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (requestId !== null) {
        await this.requests.updateIf(requestId, ['approved'], { status: 'failed', statusReason: message }).catch(() => undefined);
      }
      const errorClass = error instanceof Error ? error.constructor.name : typeof error;
      this.logger.warn(
        `[book_request.batch_create] [fail] requestId=${requestId ?? 'none'} userId=${user.id} sourceRequestId=${dto.sourceRequestId} units=${dto.unitIndexes.length} clientId=${dto.downloadClientId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - batch grab failed`,
      );
      throw error;
    }
  }

  /**
   * Sends a failed batch back through the import without downloading anything: the finished
   * torrent is still in the client, so only the BookOrbit side of the batch is reset. The monitor's
   * resume sweep picks the `completed` download up and re-imports it.
   */
  async retry(user: RequestUser, requestId: number): Promise<void> {
    const startedAt = Date.now();
    this.logger.log(`[book_request.batch_retry] [start] requestId=${requestId} userId=${user.id} - batch import retry started`);

    try {
      const joined = await this.requests.findById(requestId);
      if (!joined) throw new NotFoundException('Book request not found');
      const kind = (await this.batches.findKinds([requestId])).get(requestId);
      if (kind !== 'batch' || joined.request.status !== 'failed') throw new BadRequestException(NOT_RETRYABLE);

      const download = (await this.downloads.findLatestForRequests([requestId])).get(requestId)?.download;
      if (!download || download.downloadClientId === null || download.clientKey === null) throw new BadRequestException(NOT_RETRYABLE);
      if (!RETRYABLE_DOWNLOAD_STATUSES.includes(download.status as BookRequestDownloadStatus)) throw new BadRequestException(NOT_RETRYABLE);

      const config = await this.clients.resolveConfig(download.downloadClientId);
      const reported = await this.registry.require(config.adapterType).status([download.clientKey], config);
      const live = reported.find((status) => status.clientKey.toLowerCase() === download.clientKey?.toLowerCase());
      if (!live) throw new BadRequestException(TORRENT_GONE);
      if (live.state !== 'completed' || live.progressPercent < 100) throw new BadRequestException(TORRENT_UNFINISHED);

      if (await this.downloads.findUnsettledByClientKey(download.downloadClientId, download.clientKey)) {
        throw new BadRequestException(TORRENT_BUSY_MESSAGE);
      }

      const reason = joined.request.statusReason;
      const resumed = await this.requests.updateIf(requestId, ['failed'], {
        status: 'downloading',
        statusReason: null,
        failureCode: null,
        failureMeta: null,
      });
      if (!resumed) throw new BadRequestException(NOT_RETRYABLE);

      // The download goes last: the resume sweep imports any `completed` download, and the units must be waiting again by then.
      const units = await this.batches.resetUnitsForRetry(requestId);
      let claimed: Awaited<ReturnType<BookRequestDownloadRepository['updateIf']>>;
      try {
        claimed = await this.downloads.updateIf(download.id, RETRYABLE_DOWNLOAD_STATUSES, { status: 'completed', errorMessage: null });
      } catch (error) {
        await this.requests.updateIf(requestId, ['downloading'], { status: 'failed', statusReason: reason });
        if (isUniqueViolation(error)) throw new BadRequestException(TORRENT_BUSY_MESSAGE);
        throw error;
      }
      if (!claimed) {
        await this.requests.updateIf(requestId, ['downloading'], { status: 'failed', statusReason: reason });
        throw new BadRequestException(NOT_RETRYABLE);
      }
      await this.downloads.setFilesPendingSince(download.id, null);
      this.gateway.emitChanged();

      this.logger.log(
        `[book_request.batch_retry] [end] requestId=${requestId} userId=${user.id} downloadId=${download.id} units=${units} durationMs=${Date.now() - startedAt} - batch import retry queued`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorClass = error instanceof Error ? error.constructor.name : typeof error;
      this.logger.warn(
        `[book_request.batch_retry] [fail] requestId=${requestId} userId=${user.id} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - batch import retry failed`,
      );
      throw error;
    }
  }

  async listUnits(user: RequestUser, requestId: number): Promise<BatchUnitView[]> {
    await this.requestService.getOne(requestId, user);
    return (await this.batches.findUnits(requestId)).map(toUnitView);
  }
}

function knownSizes(sizes: Array<number | null> | undefined): number[] | null {
  if (!sizes || sizes.some((size) => size === null)) return null;
  return sizes as number[];
}
