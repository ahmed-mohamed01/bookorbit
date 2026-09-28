import { constants } from 'fs';
import { copyFile, link, mkdir, realpath, rename, rm, stat, unlink } from 'fs/promises';
import { dirname, join } from 'path';
import { BadGatewayException, ConflictException, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { BookDockMetadata } from '@bookorbit/types';

import { SelfWriteRegistry } from '../../common/services/self-write-registry.service';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { BookDockFinalizeService } from '../book-dock/book-dock-finalize.service';
import { BookDockRepository } from '../book-dock/book-dock.repository';
import { inspectEpubMediaOverlayFields } from '../reader/epub/epub-media-overlay-capability';
import { computeFileHash } from '../scanner/lib/hash';
import type { StorytellerSession } from './storyteller-client.types';
import { describeError } from './storyteller-log.utils';
import { storytellerSafeFilepathSegment } from './storyteller-path.utils';
import { StorytellerRepository } from './storyteller.repository';

const IMPORT_EVENT = 'storyteller.read_along.import';
const STAGED_CLEANUP_EVENT = 'storyteller.read_along.staged_cleanup';
const REMOTE_KEY_CHARS = 8;
const LINK_FALLBACK_CODES = new Set(['EXDEV', 'EPERM', 'ENOSYS']);

export interface StorytellerReadAlongImport {
  buildId: number;
  textBookId: number;
  audioBookId: number;
  userId: number;
  session: StorytellerSession;
  storytellerBookUuid: string;
  /** Storyteller's own output, where this instance can read it; null to download it instead. */
  stagedPath: string | null;
  /** Take the staged file rather than copy it: Storyteller keeps nothing once the build cleans up. */
  consumeStaged: boolean;
  targetLibraryId: number;
  targetFolderId: number;
  /** A rebuild's previous output, whose file is replaced in place so the book keeps its id. */
  replaceBookId: number | null;
}

export interface StorytellerReadAlongImported {
  outputBookId: number;
  replaced: boolean;
}

/**
 * Files a finished read-along. Storyteller stamps the audio tags over the ebook's title, authors
 * and subjects when it writes the file, so nothing here reads metadata out of it: a new read-along
 * goes through the Book Dock carrying the linked editions' metadata, and a rebuild swaps the bytes
 * under the book it already has.
 */
@Injectable()
export class StorytellerReadAlongImportService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StorytellerReadAlongImportService.name);
  private bookDockPath: string;

  constructor(
    config: ConfigService,
    private readonly repo: StorytellerRepository,
    private readonly dockRepo: BookDockRepository,
    private readonly dockFinalize: BookDockFinalizeService,
    private readonly selfWrites: SelfWriteRegistry,
  ) {
    this.bookDockPath = config.getOrThrow<string>('storage.bookDockPath');
  }

  // Resolved like the watcher resolves it: a row whose path spells the folder differently is one
  // the watcher cannot find, and it would ingest the same file a second time.
  async onApplicationBootstrap(): Promise<void> {
    await mkdir(this.bookDockPath, { recursive: true });
    this.bookDockPath = await realpath(this.bookDockPath);
  }

  async importReadAlong(request: StorytellerReadAlongImport): Promise<StorytellerReadAlongImported> {
    const startedAt = Date.now();
    const source = request.stagedPath === null ? 'download' : 'staged';
    this.logger.log(
      `[${IMPORT_EVENT}] [start] buildId=${request.buildId} replaceBookId=${request.replaceBookId ?? 'none'} source=${source} consumeStaged=${request.consumeStaged} - read-along import started`,
    );
    try {
      const replaced = request.replaceBookId === null ? false : await this.replaceInPlace(request, request.replaceBookId);
      const outputBookId = replaced ? request.replaceBookId! : await this.fileThroughDock(request);
      await this.removeStagedBestEffort(request);
      this.logger.log(
        `[${IMPORT_EVENT}] [end] buildId=${request.buildId} durationMs=${Date.now() - startedAt} source=${source} outputBookId=${outputBookId} replaced=${replaced} - read-along import completed`,
      );
      return { outputBookId, replaced };
    } catch (error) {
      const { errorClass, message } = describeError(error);
      this.logger.error(
        `[${IMPORT_EVENT}] [fail] buildId=${request.buildId} durationMs=${Date.now() - startedAt} source=${source} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - read-along import failed`,
      );
      throw error;
    }
  }

  /**
   * The dock row is claimed before the file lands, as request imports claim theirs: a watcher that
   * saw the file first would ingest it with no owner and read Storyteller's metadata out of it.
   * The name carries the build and the Storyteller book, so a retry finds its own leftovers there.
   */
  private async fileThroughDock(request: StorytellerReadAlongImport): Promise<number> {
    const metadata = await this.readAlongMetadata(request);
    const key = storytellerSafeFilepathSegment(request.storytellerBookUuid).slice(0, REMOTE_KEY_CHARS) || 'unknown';
    const fileName = `storyteller-read-along-${request.buildId}-${key}.epub`;
    const dockPath = join(this.bookDockPath, fileName);
    await this.discardDockEntry(dockPath);

    const row = await this.dockRepo.create({
      fileName,
      absolutePath: dockPath,
      format: 'epub',
      // Ready from the start, so the dock never extracts or fetches metadata for it.
      status: 'ready',
      selectedMetadata: metadata,
      targetLibraryId: request.targetLibraryId,
      targetFolderId: request.targetFolderId,
      uploadedBy: request.userId,
      autoFinalizeSuppressed: true,
    });
    try {
      await this.placeFile(request, dockPath);
      await this.dockRepo.update(row.id, { fileSize: (await stat(dockPath)).size });
      const result = await this.dockFinalize.finalizeManagedFile(row.id, { libraryId: request.targetLibraryId, folderId: request.targetFolderId });
      if (!result.success || result.bookId === undefined) {
        const reason = result.message ?? 'the Book Dock could not file it';
        if (result.isDuplicate) throw new ConflictException(`The read-along library already has a book at ${result.newName ?? fileName}: ${reason}`);
        throw new BadGatewayException(`The read-along could not be filed: ${reason}`);
      }
      return result.bookId;
    } catch (error) {
      await this.discardDockEntry(dockPath);
      throw error;
    }
  }

  private async readAlongMetadata(request: StorytellerReadAlongImport): Promise<BookDockMetadata> {
    const metadata = (await this.repo.findReadAlongMetadata(request.textBookId, request.audioBookId)) ?? {};
    return metadata.title ? metadata : { ...metadata, title: 'Read-along' };
  }

  /** Only ever a path this service named for its own build, so whatever sits there is its own. */
  private async discardDockEntry(dockPath: string): Promise<void> {
    await this.dockRepo.deleteByAbsolutePath(dockPath).catch(() => undefined);
    await rm(dockPath, { force: true }).catch(() => undefined);
  }

  /**
   * Written next to the file and renamed over it, so a reader never opens half a book, while the
   * scanner is told the path is ours: the book row is brought up to date before the suppression
   * lifts, which is what keeps the scan from reading Storyteller's metadata back into the book.
   * False when the previous output is not a single EPUB, which the caller files as a new book.
   */
  private async replaceInPlace(request: StorytellerReadAlongImport, bookId: number): Promise<boolean> {
    const file = await this.repo.findSoleEpubContentFile(bookId);
    if (!file) return false;
    const temporaryPath = join(dirname(file.absolutePath), `.storyteller-read-along-${request.buildId}.tmp`);
    await rm(temporaryPath, { force: true });
    try {
      await this.selfWrites.track([file.absolutePath, temporaryPath], async () => {
        await this.placeFile(request, temporaryPath);
        const [fileStat, fileHash, mediaOverlay] = await Promise.all([
          stat(temporaryPath, { bigint: true }),
          computeFileHash(temporaryPath),
          inspectEpubMediaOverlayFields(temporaryPath, 'epub'),
        ]);
        await rename(temporaryPath, file.absolutePath);
        await this.repo.recordReplacedFile(bookId, file.id, {
          fileHash,
          sizeBytes: Number(fileStat.size),
          mtime: fileStat.mtime,
          ino: fileStat.ino,
          ...mediaOverlay,
        });
      });
      return true;
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * A staged file that is going away is hard-linked, which costs no disk and leaves the original
   * for `removeStagedBestEffort`. One Storyteller keeps is copied: a link would share its bytes with
   * whatever Storyteller writes to that path next.
   */
  private async placeFile(request: StorytellerReadAlongImport, destination: string): Promise<void> {
    if (request.stagedPath === null) {
      await request.session.downloadReadaloud(request.storytellerBookUuid, destination);
      return;
    }
    if (request.consumeStaged) {
      try {
        await link(request.stagedPath, destination);
        return;
      } catch (error) {
        if (!LINK_FALLBACK_CODES.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
    await copyFile(request.stagedPath, destination, constants.COPYFILE_EXCL);
  }

  /** Only once the read-along is filed: until then the staged file is the one copy a retry can use. */
  private async removeStagedBestEffort(request: StorytellerReadAlongImport): Promise<void> {
    if (request.stagedPath === null || !request.consumeStaged) return;
    try {
      await unlink(request.stagedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      const { errorClass, message } = describeError(error);
      this.logger.warn(
        `[${STAGED_CLEANUP_EVENT}] [fail] buildId=${request.buildId} path="${sanitizeLogValue(request.stagedPath)}" errorClass=${errorClass} error="${sanitizeLogValue(message)}" - staged read-along could not be removed`,
      );
    }
  }
}
