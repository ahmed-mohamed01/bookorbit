import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { basename } from 'path';
import { parseReleaseVolumes, type BookDockMetadata, type BatchUnitView } from '@bookorbit/types';
import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import { BookDockEventsService, BOOK_DOCK_FILE_INGESTED } from '../../book-dock/book-dock-events.service';
import { BookDockFinalizeService } from '../../book-dock/book-dock-finalize.service';
import { BookDockRepository } from '../../book-dock/book-dock.repository';
import { BookDockService } from '../../book-dock/book-dock.service';
import { BookRequestGateway } from '../book-request.gateway';
import { BookRequestRepository } from '../book-request.repository';
import { RequestAutomationSettingsService } from '../fulfillment/request-automation-settings.service';
import { verifyAgainstRequest } from '../fulfillment/request-verification.service';
import { BookRequestBatchRepository } from './book-request-batch.repository';
import { toUnitView } from './book-request-batch.mapper';

type SeriesMetadata = { seriesName: string; seriesIndex: string; authors?: string[] };
type MetadataResolver = (ctx: { batchRequestId: number; unit: BatchUnitView }) => Promise<SeriesMetadata | null>;
type FilingResult = 'filed' | 'held' | 'skipped';

@Injectable()
export class BatchUnitFilingService implements OnModuleInit {
  private readonly logger = new Logger(BatchUnitFilingService.name);
  private readonly resolvers: MetadataResolver[] = [];
  private readonly filings = new Map<number, Promise<FilingResult>>();

  constructor(
    private readonly events: BookDockEventsService,
    private readonly batches: BookRequestBatchRepository,
    private readonly requests: BookRequestRepository,
    private readonly dockRepo: BookDockRepository,
    private readonly dock: BookDockService,
    private readonly finalizeService: BookDockFinalizeService,
    private readonly settings: RequestAutomationSettingsService,
    private readonly gateway: BookRequestGateway,
  ) {}

  onModuleInit(): void {
    this.events.on(BOOK_DOCK_FILE_INGESTED, (fileId: number) => {
      const started = Date.now();
      void this.fileUnit(fileId).catch((error: unknown) => this.logFailure(fileId, started, error));
    });
  }

  registerMetadataResolver(fn: MetadataResolver): void {
    this.resolvers.push(fn);
  }

  fileUnit(fileId: number): Promise<FilingResult> {
    const existing = this.filings.get(fileId);
    if (existing) return existing;
    const filing = this.fileUnitNow(fileId).finally(() => this.filings.delete(fileId));
    this.filings.set(fileId, filing);
    return filing;
  }

  private async fileUnitNow(fileId: number): Promise<FilingResult> {
    const started = Date.now();
    this.logger.log(`[book_request.batch_file] [start] dockFileId=${fileId} - batch unit filing started`);
    let verify: 'series' | 'series-embedded' | 'fallback' | 'off' = 'off';
    const finish = (result: FilingResult): FilingResult => {
      this.logger.log(
        `[book_request.batch_file] [end] dockFileId=${fileId} durationMs=${Date.now() - started} result=${result} verify=${verify} - batch unit filing completed`,
      );
      return result;
    };
    const unit = await this.batches.findUnitByDockFileId(fileId);
    if (!unit || !['placing', 'in_dock'].includes(unit.status) || unit.bookDockFileId !== fileId) return finish('skipped');
    const joined = await this.requests.findById(unit.requestId);
    if (!joined?.request.targetLibraryId) return finish('skipped');
    const request = joined.request;
    const hold = async (reason: string): Promise<FilingResult> => {
      await this.batches.updateUnit(unit.id, { errorMessage: reason.slice(0, 500) });
      this.gateway.emitChanged();
      return finish('held');
    };
    try {
      const row = await this.dockRepo.findById(fileId);
      if (!row) return await hold('The Book Dock entry disappeared');
      let resolved: SeriesMetadata | null = null;
      let ignoreFetched = false;
      for (const resolver of this.resolvers) {
        const metadata = await resolver({ batchRequestId: unit.requestId, unit: toUnitView(unit) });
        if (metadata) {
          resolved = metadata;
          ignoreFetched = metadataVolumes(row.fetchedMetadata).some((volume) => volume !== Number(metadata.seriesIndex));
          const selectedMetadata = ignoreFetched
            ? mergeFilingMetadata(row.embeddedMetadata)
            : mergeFilingMetadata(row.embeddedMetadata, row.fetchedMetadata, row.selectedMetadata);
          Object.assign(selectedMetadata, nonEmptyMetadata({ seriesName: metadata.seriesName, seriesIndex: metadata.seriesIndex }));
          if (!selectedMetadata.authors?.length) Object.assign(selectedMetadata, nonEmptyMetadata({ authors: metadata.authors }));
          await this.dock.updateFile(fileId, { selectedMetadata }, row.uploadedBy ?? 0, true);
          break;
        }
      }
      const settings = await this.settings.get();
      if (settings.verificationEnabled) {
        if (resolved) {
          verify = ignoreFetched ? 'series-embedded' : 'series';
          const fetched = ignoreFetched ? null : row.fetchedMetadata;
          const metadata = [fetched, row.embeddedMetadata];
          const titles = [fetched?.title ?? '', row.embeddedMetadata?.title ?? '', unit.title ?? '', basename(unit.primaryPath)];
          const importedVolumes = [...metadata.flatMap(metadataVolumes), ...titles.slice(2).flatMap(singleTitleVolumes)];
          const expected = Number(resolved.seriesIndex);
          const differentVolume = importedVolumes.find((volume) => volume !== expected);
          if (differentVolume !== undefined) {
            return await hold(`imported book is volume ${differentVolume}, expected volume ${resolved.seriesIndex}`);
          }
          if (!matchesSeriesUnit(resolved, metadata, titles, importedVolumes)) {
            if (importedVolumes.length > 0) return await hold('Imported book could not be verified against the resolved series and volume');
            verify = 'fallback';
          }
        } else {
          verify = 'fallback';
        }
      }
      if (verify === 'fallback') {
        const outcome = verifyAgainstRequest(
          { ...request, title: resolved?.seriesName ?? unit.title ?? basename(unit.primaryPath), authors: resolved?.authors ?? request.authors },
          ignoreFetched ? null : row.fetchedMetadata,
          row.embeddedMetadata,
          settings.verificationThreshold,
          null,
        );
        if (!outcome.passed) return await hold(outcome.reason);
      }
      const folderId = request.targetFolderId ?? (await this.requests.findFirstFolderId(request.targetLibraryId!));
      if (folderId === null) return await hold('The destination library has no folder to file the book into');
      const result = await this.finalizeService.finalizeManagedFile(fileId, { libraryId: request.targetLibraryId!, folderId });
      if (!result.success) return await hold(result.message ?? 'The Book Dock could not file this book');
      await this.batches.markFiled(unit.id, result.bookId ?? null);
      this.gateway.emitChanged();
      return finish('filed');
    } catch (error) {
      this.logFailure(fileId, started, error);
      return hold(error instanceof Error ? error.message : String(error));
    }
  }

  private logFailure(fileId: number, started: number, error: unknown): void {
    this.logger.error(
      `[book_request.batch_file] [fail] dockFileId=${fileId} durationMs=${Date.now() - started} errorClass=${error instanceof Error ? error.name : 'UnknownError'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - batch unit filing failed`,
    );
  }
}

function singleTitleVolumes(title: string): number[] {
  const volumes = parseReleaseVolumes(title) ?? [];
  return volumes.length === 1 ? volumes : [];
}

function metadataVolumes(metadata: BookDockMetadata | null): number[] {
  return [...singleTitleVolumes(metadata?.title ?? ''), ...(metadata?.seriesIndex != null ? [Number(metadata.seriesIndex)] : [])];
}

function matchesSeriesUnit(series: SeriesMetadata, metadata: (BookDockMetadata | null)[], titles: string[], volumes: number[]): boolean {
  const expected = Number(series.seriesIndex);
  const volumeMatches = volumes.includes(expected) && volumes.every((volume) => volume === expected);
  const fold = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const baseTitle = fold(series.seriesName.split(': ')[0]!);
  const titleMatches = !!baseTitle && [...titles, ...metadata.map((item) => item?.seriesName ?? '')].some((title) => fold(title).includes(baseTitle));
  const authors = new Set((series.authors ?? []).map((author) => author.trim().toLowerCase()).filter(Boolean));
  const authorMatches = metadata.some((item) => item?.authors?.some((author) => authors.has(author.trim().toLowerCase())));
  return volumeMatches && (titleMatches || authorMatches);
}

function nonEmptyMetadata(metadata: BookDockMetadata | null): BookDockMetadata {
  return Object.fromEntries(
    Object.entries(metadata ?? {}).filter(
      ([, value]) => value != null && (typeof value !== 'string' || value.trim().length > 0) && (!Array.isArray(value) || value.length > 0),
    ),
  );
}

function mergeFilingMetadata(...sources: (BookDockMetadata | null)[]): BookDockMetadata {
  return Object.assign({}, ...sources.map(nonEmptyMetadata));
}
