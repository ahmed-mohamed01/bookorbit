import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DOWNLOAD_CLIENT_FILE_SELECTION, MAX_BATCH_UNITS } from '@bookorbit/types';
import type { BatchUnitView, ReleaseUnitMediaKind } from '@bookorbit/types';

import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import type { RequestUser } from '../../../common/types/request-user';
import { BookRequestRepository } from '../book-request.repository';
import { BookRequestService } from '../book-request.service';
import type { CreateBatchGrabDto } from '../dto/create-batch-grab.dto';
import { DownloadClientConfigService } from '../download-clients/download-client-config.service';
import { RequestFulfillmentService } from '../fulfillment/request-fulfillment.service';
import { IndexerSearchService } from '../indexers/indexer-search.service';
import type { BatchUnitRow, NewBatchUnitRow } from '../schema/book-request-batch.schema';
import { BookRequestBatchRepository } from './book-request-batch.repository';

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
  ) {}

  async create(user: RequestUser, dto: CreateBatchGrabDto): Promise<{ requestId: number }> {
    const startedAt = Date.now();
    this.logger.log(
      `[book_request.batch_create] [start] userId=${user.id} sourceRequestId=${dto.sourceRequestId} units=${dto.unitIndexes.length} clientId=${dto.downloadClientId} - batch grab started`,
    );

    let requestId: number | null = null;
    try {
      const source = await this.requests.findById(dto.sourceRequestId);
      if (!source) throw new NotFoundException('Book request not found');

      const inspection = await this.fulfillment.inspectRelease(dto.sourceRequestId, { indexerId: dto.indexerId, releaseGuid: dto.releaseGuid });
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

      const filesByUnit = new Map<number, string[]>();
      for (const file of selection.files) {
        if (file.unitIndex === null) continue;
        const paths = filesByUnit.get(file.unitIndex);
        if (paths) paths.push(file.path);
        else filesByUnit.set(file.unitIndex, [file.path]);
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
        targetLibraryId: null,
        targetFolderId: null,
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

  async listUnits(user: RequestUser, requestId: number): Promise<BatchUnitView[]> {
    await this.requestService.getOne(requestId, user);
    return (await this.batches.findUnits(requestId)).map(toUnitView);
  }
}

function toUnitView(row: BatchUnitRow): BatchUnitView {
  return {
    unitIndex: row.unitIndex,
    title: row.title,
    primaryPath: row.primaryPath,
    mediaKind: row.mediaKind as ReleaseUnitMediaKind,
    sizeBytes: row.sizeBytes,
    status: row.status as BatchUnitView['status'],
    bookDockFileId: row.bookDockFileId,
    errorMessage: row.errorMessage,
  };
}
