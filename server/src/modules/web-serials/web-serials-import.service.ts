import { createWriteStream } from 'fs';
import { mkdir, readdir, realpath, rename, rm, stat } from 'fs/promises';
import { dirname, join } from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { BadGatewayException, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { BookDockMetadata, WebSerialKind } from '@bookorbit/types';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { BookDockFinalizeService } from '../book-dock/book-dock-finalize.service';
import { BookDockRepository } from '../book-dock/book-dock.repository';
import type { EngineDownload } from './engines/web-serial-engine';
import { DuplicateBookError, ImportStageError } from './web-serials-import.errors';
import { describeError } from './web-serials-log.utils';

const IMPORT_EVENT = 'web_serials.import';

export const WEB_SERIAL_SIZE_CAPS: Record<WebSerialKind, number> = {
  manga: 2 * 1024 * 1024 * 1024,
  novel: 1024 * 1024 * 1024,
};

export const WEB_SERIAL_CHAPTER_SIZE_CAP = 500 * 1024 * 1024;

export interface WebSerialUnitImport {
  jobId: number;
  itemId: number;
  userId: number;
  kind: WebSerialKind;
  download: EngineDownload;
  metadata: BookDockMetadata;
  targetLibraryId: number;
  targetFolderId: number;
  /** Overrides the per-kind size cap, for example the single chapter cap. */
  maxBytes?: number;
}

function toNodeStream(stream: EngineDownload['stream']): NodeJS.ReadableStream {
  return typeof (stream as ReadableStream).getReader === 'function'
    ? Readable.fromWeb(stream as import('stream/web').ReadableStream)
    : (stream as NodeJS.ReadableStream);
}

function sizeCap(limit: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > limit) callback(new BadGatewayException('The downloaded file is larger than the allowed size'));
      else callback(null, chunk);
    },
  });
}

/** Files one downloaded unit through the Book Dock, the same way an upload does. */
@Injectable()
export class WebSerialsImportService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WebSerialsImportService.name);
  private bookDockPath: string;
  private readonly workRoot: string;

  constructor(
    config: ConfigService,
    private readonly dockRepo: BookDockRepository,
    private readonly dockFinalize: BookDockFinalizeService,
  ) {
    this.bookDockPath = config.getOrThrow<string>('storage.bookDockPath');
    this.workRoot = join(config.getOrThrow<string>('storage.appDataPath'), 'tmp', 'web-serials');
  }

  async onApplicationBootstrap(): Promise<void> {
    await mkdir(this.bookDockPath, { recursive: true });
    this.bookDockPath = await realpath(this.bookDockPath);
  }

  async prepareUnitWorkDir(jobId: number, itemId: number): Promise<string> {
    const path = join(this.workRoot, `job-${jobId}`, `unit-${itemId}`);
    await mkdir(path, { recursive: true });
    return path;
  }

  async saveWorkDownload(download: EngineDownload, finalPath: string): Promise<number> {
    const cap = WEB_SERIAL_CHAPTER_SIZE_CAP;
    const partialPath = `${finalPath}.part`;
    if (download.size !== null && download.size > cap) throw new BadGatewayException('The downloaded file is larger than the allowed size');
    await mkdir(dirname(finalPath), { recursive: true });
    await rm(partialPath, { force: true });
    try {
      await pipeline(toNodeStream(download.stream), sizeCap(cap), createWriteStream(partialPath, { flags: 'wx' }));
      await rename(partialPath, finalPath);
      return (await stat(finalPath)).size;
    } catch (error) {
      await rm(partialPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async removeJobWorkDir(jobId: number): Promise<void> {
    await rm(join(this.workRoot, `job-${jobId}`), { recursive: true, force: true }).catch(() => undefined);
  }

  /** Ids of every job that has a work folder on disk. */
  async listWorkJobIds(): Promise<number[]> {
    try {
      const entries = await readdir(this.workRoot, { withFileTypes: true });
      return entries.flatMap((entry) => {
        const match = entry.isDirectory() ? /^job-(\d+)$/.exec(entry.name) : null;
        return match ? [Number(match[1])] : [];
      });
    } catch {
      return [];
    }
  }

  async cleanupUnitWorkDir(jobId: number, itemId: number): Promise<void> {
    await rm(join(this.workRoot, `job-${jobId}`, `unit-${itemId}`), { recursive: true, force: true }).catch(() => undefined);
  }

  /** Returns the id of the book that was filed. Everything it wrote in the dock is removed again when it fails. */
  async importUnit(request: WebSerialUnitImport): Promise<number> {
    const startedAt = Date.now();
    const { download } = request;
    const cap = request.maxBytes ?? WEB_SERIAL_SIZE_CAPS[request.kind];
    const fileName = `web-serial-${request.jobId}-${request.itemId}.${download.format}`;
    const dockPath = join(this.bookDockPath, fileName);
    const partialPath = join(this.bookDockPath, `.${fileName}.part`);
    this.logger.log(`[${IMPORT_EVENT}] [start] jobId=${request.jobId} itemId=${request.itemId} format=${download.format} - unit import started`);

    try {
      if (download.size !== null && download.size > cap) {
        throw new BadGatewayException('The downloaded file is larger than the allowed size');
      }
      await this.discardDockEntry(dockPath);
      await rm(partialPath, { force: true });
      await pipeline(toNodeStream(download.stream), sizeCap(cap), createWriteStream(partialPath, { flags: 'wx' }));
      const fileSize = (await stat(partialPath)).size;
      const bookId = await this.fileInDock(request, fileName, dockPath, partialPath, fileSize);
      this.logger.log(
        `[${IMPORT_EVENT}] [end] jobId=${request.jobId} itemId=${request.itemId} durationMs=${Date.now() - startedAt} bookId=${bookId} sizeBytes=${fileSize} - unit import completed`,
      );
      return bookId;
    } catch (error) {
      await this.discardDockEntry(dockPath);
      await rm(partialPath, { force: true }).catch(() => undefined);
      const { errorClass, message } = describeError(error);
      const log = error instanceof DuplicateBookError ? this.logger.warn.bind(this.logger) : this.logger.error.bind(this.logger);
      log(
        `[${IMPORT_EVENT}] [fail] jobId=${request.jobId} itemId=${request.itemId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - unit import failed`,
      );
      throw error;
    }
  }

  private async fileInDock(request: WebSerialUnitImport, fileName: string, dockPath: string, partialPath: string, fileSize: number): Promise<number> {
    try {
      const row = await this.dockRepo.create({
        fileName,
        absolutePath: dockPath,
        fileSize,
        format: request.download.format,
        status: 'ready',
        selectedMetadata: request.metadata,
        targetLibraryId: request.targetLibraryId,
        targetFolderId: request.targetFolderId,
        uploadedBy: request.userId,
        autoFinalizeSuppressed: true,
      });
      await rename(partialPath, dockPath);
      const result = await this.dockFinalize.finalizeManagedFile(row.id, { libraryId: request.targetLibraryId, folderId: request.targetFolderId });
      if (result.success && result.bookId !== undefined) return result.bookId;
      if (result.isDuplicate) {
        if (result.existingBookId !== undefined) throw new DuplicateBookError(result.existingBookId);
        throw new BadGatewayException('This book is already in the library');
      }
      throw new BadGatewayException(`The book could not be filed: ${result.message ?? 'the Book Dock could not file it'}`);
    } catch (error) {
      if (error instanceof DuplicateBookError) throw error;
      throw new ImportStageError(describeError(error).message, error);
    }
  }

  private async discardDockEntry(dockPath: string): Promise<void> {
    await this.dockRepo.deleteByAbsolutePath(dockPath).catch(() => undefined);
    await rm(dockPath, { force: true }).catch(() => undefined);
  }
}
