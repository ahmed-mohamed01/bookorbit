import { BadRequestException, Inject, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { EditionSyncProvenance, EditionSyncProvenanceSource, ReadAloudRebuildChunk } from '@bookorbit/types';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { constants, createWriteStream } from 'node:fs';
import { copyFile, type FileHandle, lstat, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, posix } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual } from 'node:util';
import { ZipArchive } from 'archiver';
import { XMLParser } from 'fast-xml-parser';
import * as unzipper from 'unzipper';

import { audioToolsConfig } from '../../config/config';
import { FileLockService, bookOperationLockKey } from '../../common/services/file-lock.service';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { parseAlignmentReport } from '../read-aloud/read-aloud-report';
import { ScannerService } from '../scanner/scanner.service';
import { EDITION_SYNC_INDEX_FORMAT, EDITION_SYNC_PROVENANCE_ENTRY, EDITION_SYNC_REPORT_ENTRY } from './edition-sync.constants';
import {
  canCheckChangedContent,
  canCheckChangedFile,
  compareProvenance,
  EditionSyncSourcesChangedError,
  isWorkerSafeEntry,
  provenanceFile,
} from './edition-sync-provenance';
import { audioFingerprint, chapterFingerprint } from './edition-sync-fingerprints';
import { EditionSyncRepository } from './edition-sync.repository';
import type { EditionSyncCaptureInput, EditionSyncCaptureResult, EditionSyncVerification, EditionSyncBookFileRef } from './edition-sync.types';

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_CHUNKS = 10_000;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const safePath = (path: string) =>
  path.length > 0 && !path.includes('\\') && !path.includes('\0') && !path.startsWith('/') && !path.split('/').includes('..');

async function digest(stream: Readable): Promise<string> {
  const hash = createHash('sha256');
  for await (const bytes of stream) hash.update(bytes);
  return hash.digest('hex');
}

// The worker writes these files; never follow a link it may have left in place of one.
async function openWorkerFile(path: string): Promise<FileHandle> {
  const handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new InternalServerErrorException('Invalid worker output file');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readWorkerText(path: string, tooLarge: string): Promise<string> {
  const handle = await openWorkerFile(path);
  try {
    if ((await handle.stat()).size > MAX_JSON_BYTES) throw new InternalServerErrorException(tooLarge);
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function digestWorkerFile(path: string): Promise<{ size: number; sha256: string }> {
  const handle = await openWorkerFile(path);
  try {
    const { size } = await handle.stat();
    return { size, sha256: await digest(handle.createReadStream({ autoClose: false })) };
  } finally {
    await handle.close();
  }
}

async function requireWorkerDirectory(path: string): Promise<void> {
  if (!(await lstat(path)).isDirectory()) throw new InternalServerErrorException('Invalid worker output folder');
}

async function boundedText(entry: unzipper.File): Promise<string> {
  if (entry.uncompressedSize > MAX_JSON_BYTES) throw new InternalServerErrorException('Timing index metadata is too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const bytes of entry.stream()) {
    size += (bytes as Buffer).length;
    if (size > MAX_JSON_BYTES) throw new InternalServerErrorException('Timing index metadata is too large');
    chunks.push(bytes as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function immutableProvenance(value: EditionSyncProvenance) {
  return {
    ...value,
    epub: { bookFileId: value.epub.bookFileId, chapterFingerprint: value.epub.chapterFingerprint },
    audio: value.audio.map((file) => ({ bookFileId: file.bookFileId, order: file.order, audioFingerprint: file.audioFingerprint })),
  };
}

@Injectable()
export class EditionSyncIndexStoreService {
  private readonly logger = new Logger(EditionSyncIndexStoreService.name);

  constructor(
    private readonly repo: EditionSyncRepository,
    private readonly locks: FileLockService,
    private readonly scanner: ScannerService,
    @Inject(audioToolsConfig.KEY) private readonly config: ConfigType<typeof audioToolsConfig>,
  ) {}

  async capture(input: EditionSyncCaptureInput): Promise<EditionSyncCaptureResult> {
    const started = Date.now();
    this.logger.log(`[edition_sync.capture] [start] bookId=${input.bookId} - capturing timing index`);
    try {
      const result = await this.locks.withLock(bookOperationLockKey(input.bookId), () => this.captureLocked(input));
      this.logger.log(
        `[edition_sync.capture] [end] bookId=${input.bookId} durationMs=${Date.now() - started} indexBytes=${result.indexBytes} chunks=${result.provenance.chunks.length} sourceEntries=${result.provenance.sourceEntries?.length ?? 0} droppedBytes=${result.provenance.sourceEntries?.reduce((sum, entry) => sum + entry.size, 0) ?? 0} - timing index captured`,
      );
      return result;
    } catch (error) {
      this.logger.warn(
        `[edition_sync.capture] [fail] bookId=${input.bookId} durationMs=${Date.now() - started} errorClass=${error instanceof Error ? error.name : 'Unknown'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - capture failed`,
      );
      throw error;
    }
  }

  async resolveCaptureSources(bookId: number, request: EditionSyncCaptureInput['request']): Promise<EditionSyncCaptureInput['sources'] | null> {
    const source = await this.repo.findIndexSource(bookId);
    if (!source) return null;
    const files = [source.epub, ...source.audio];
    let epub = files.find((file) => file.absolutePath === request.epubPath);
    if (!epub) {
      const id = await this.repo.findBookFileIdByPath(bookId, request.epubPath);
      if (id !== null) epub = (await this.repo.findBookFilesByIds([id])).find((file) => file.bookId === bookId && file.format === 'epub');
    }
    const audio = request.audioPaths.map((path) => files.find((file) => file.absolutePath === path));
    if (!epub || audio.some((file) => !file)) return null;
    return { epub, audio: audio.filter((file) => file !== undefined) };
  }

  private async captureLocked(input: EditionSyncCaptureInput): Promise<EditionSyncCaptureResult> {
    const { epub, audio } = input.sources;
    await requireWorkerDirectory(input.workDir);
    const snapshot: EditionSyncProvenance = {
      version: 1,
      bookId: input.bookId,
      workerVersion: input.workerVersion,
      ...input.request,
      epub: provenanceFile(epub),
      audio: audio.map((file, order) => ({ ...provenanceFile(file), order })),
      sources: [],
      chunks: [],
      audioEntries: [],
      report: {} as EditionSyncProvenance['report'],
      createdAt: '',
    };
    const verification = compareProvenance(snapshot, await this.repo.findBookFilesByIds([epub.id, ...audio.map((file) => file.id)]));
    if (!verification.valid) throw new EditionSyncSourcesChangedError(verification.reason as 'epub_changed' | 'audio_changed' | 'file_missing');
    const source = await this.repo.findIndexSource(input.bookId);
    if (!source) throw new NotFoundException('Timing index source is missing');
    const { fingerprints, checkStats } = await this.captureFingerprints(input.bookId, epub, audio);
    const reportText = await readWorkerText(join(input.workDir, 'report.json'), 'Alignment report is too large');
    const report = parseAlignmentReport(reportText).totals;
    const processed = join(input.workDir, 'processed-audio');
    await requireWorkerDirectory(processed);
    const names = (await readdir(processed)).filter((name) => !name.startsWith('.') && !name.endsWith('.json')).sort();
    if (!names.length || names.length > MAX_CHUNKS) throw new InternalServerErrorException('Invalid processed audio count');
    const chunks: ReadAloudRebuildChunk[] = [];
    const sources: EditionSyncProvenanceSource[] = [];
    for (const name of names)
      chunks.push({
        name,
        ...(await digestWorkerFile(join(processed, name))),
        ...(await this.optionalFingerprint(input.bookId, join(processed, name), 'audio').then((audioMd5) => (audioMd5 ? { audioMd5 } : {}))),
      });
    for (const name of (await readdir(processed)).filter((name) => name.endsWith('.source.json')).sort()) {
      const text = await readWorkerText(join(processed, name), 'Audio source metadata is too large');
      const value = JSON.parse(text) as Omit<EditionSyncProvenanceSource, 'name'>;
      sources.push({
        name:
          names.find((chunk) => basename(chunk, extname(chunk)) === name.slice(0, -'.source.json'.length)) ?? name.slice(0, -'.source.json'.length),
        source: value.source,
        sourceSize: value.sourceSize,
        start: value.start,
        end: value.end,
        title: value.title ?? null,
      });
    }
    const outputPath = join(input.workDir, 'output.epub');
    if (!(await lstat(outputPath)).isFile()) throw new InternalServerErrorException('Invalid worker output file');
    const archive = await unzipper.Open.file(outputPath);
    const audioPaths = new Set<string>();
    const xml = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
    for (const entry of archive.files.filter((file) => /\.opf$/i.test(file.path))) {
      const parsed = xml.parse(await boundedText(entry)) as {
        package?: { manifest?: { item?: { '@_href'?: string; '@_media-type'?: string } | Array<{ '@_href'?: string; '@_media-type'?: string }> } };
      };
      const items = parsed.package?.manifest?.item ?? [];
      for (const item of Array.isArray(items) ? items : [items]) {
        if (item['@_media-type']?.startsWith('audio/') && item['@_href'])
          audioPaths.add(posix.normalize(posix.join(posix.dirname(entry.path), decodeURIComponent(item['@_href']))));
      }
    }
    const audioEntries: EditionSyncProvenance['audioEntries'] = [];
    const byHash = new Map(chunks.map((chunk) => [`${chunk.size}:${chunk.sha256}`, chunk]));
    const sourceEntries: NonNullable<EditionSyncProvenance['sourceEntries']> = [];
    const kept: unzipper.File[] = [];
    const seen = new Set<string>();
    const original = await unzipper.Open.file(input.request.epubPath);
    const originalEntries = new Map(original.files.map((entry) => [entry.path, entry]));
    const originalSizes = new Map(original.files.map((entry) => [entry.path, entry.uncompressedSize]));
    for (const entry of archive.files) {
      if (entry.type === 'Directory') continue;
      if (!safePath(entry.path) || seen.has(entry.path)) throw new InternalServerErrorException('Invalid EPUB entry path');
      seen.add(entry.path);
      if (audioPaths.has(entry.path) || /\.(mp3|m4a|m4b|aac|ogg|opus|wav|flac)$/i.test(entry.path)) {
        const chunk = byHash.get(`${entry.uncompressedSize}:${await digest(entry.stream())}`);
        if (!chunk) {
          if (originalSizes.get(entry.path) === entry.uncompressedSize) {
            kept.push(entry);
            continue;
          }
          throw new InternalServerErrorException('EPUB audio does not match processed chunks');
        }
        audioEntries.push({ href: entry.path, chunk: chunk.name, size: entry.uncompressedSize });
      } else if (!entry.path.startsWith('bookorbit-timings/')) {
        const sourceEntry = originalEntries.get(entry.path);
        if (
          sourceEntries.length < MAX_CHUNKS &&
          isWorkerSafeEntry(entry.path) &&
          /\.(jpg|jpeg|png|gif|webp|svg|bmp|avif|ttf|otf|woff|woff2)$/i.test(entry.path) &&
          sourceEntry?.type === 'File' &&
          sourceEntry.uncompressedSize === entry.uncompressedSize
        ) {
          const hasCrc = Number.isInteger(entry.crc32) && Number.isInteger(sourceEntry.crc32);
          const identical = hasCrc ? entry.crc32 === sourceEntry.crc32 : (await digest(entry.stream())) === (await digest(sourceEntry.stream()));
          if (identical) {
            let checksum = entry.crc32;
            if (!Number.isInteger(checksum)) {
              checksum = 0;
              for await (const bytes of entry.stream()) checksum = crc32(bytes as Buffer, checksum);
            }
            sourceEntries.push({ href: entry.path, size: entry.uncompressedSize, crc32: checksum, position: kept.length });
            continue;
          }
        }
        kept.push(entry);
      }
    }
    if (!audioEntries.length || !seen.has('mimetype')) throw new InternalServerErrorException('Aligned EPUB has no usable audio');
    await checkStats();
    const provenance: EditionSyncProvenance = {
      version: 1,
      bookId: input.bookId,
      workerVersion: input.workerVersion,
      language: input.request.language,
      granularity: input.request.granularity,
      model: input.request.model,
      epub: { ...provenanceFile(epub), ...(fingerprints.has(epub.id) ? { chapterFingerprint: fingerprints.get(epub.id) } : {}) },
      audio: [],
      sources,
      chunks,
      audioEntries,
      sourceEntries,
      report,
      decisions: input.request.decisions,
      createdAt: new Date().toISOString(),
    };
    for (const [order, file] of audio.entries())
      provenance.audio.push({
        ...provenanceFile(file),
        order,
        ...(fingerprints.has(file.id) ? { audioFingerprint: fingerprints.get(file.id) } : {}),
      });
    const folder = dirname(epub.absolutePath);
    const stem = basename(epub.absolutePath, extname(epub.absolutePath));
    let destination = '';
    for (let suffix = 1; suffix <= 50; suffix++) {
      const candidate = join(folder, `${stem}${suffix === 1 ? '' : `-${suffix}`}.${EDITION_SYNC_INDEX_FORMAT}`);
      const info = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!info || (info.isFile() && (await this.readProvenance(candidate))?.bookId === input.bookId)) {
        destination = candidate;
        break;
      }
    }
    if (!destination) throw new InternalServerErrorException('No free timing index filename');
    const previous = await this.readProvenance(destination);
    if (previous && isDeepStrictEqual({ ...previous, createdAt: '' }, { ...provenance, createdAt: '' })) {
      return { indexPath: destination, indexBytes: (await stat(destination)).size, provenance: previous };
    }
    const partial = join(folder, `.bookorbit-timings-${input.bookId}.partial`);
    await rm(partial, { force: true });
    try {
      const output = new ZipArchive();
      const done = pipeline(output, createWriteStream(partial, { flags: 'wx' }));
      void done.catch(() => undefined);
      // A failed write stops draining the archive, so every wait must also end when the write does.
      const whileWriting = <T>(step: Promise<T>) => Promise.race([step, done.then(() => step)]);
      let current: Readable | undefined;
      try {
        kept.sort((a, b) => Number(b.path === 'mimetype') - Number(a.path === 'mimetype'));
        // Open one input stream at a time so a large EPUB cannot accumulate inflated buffers.
        for (const entry of kept) {
          const stream = entry.stream();
          current = stream;
          output.append(stream, { name: entry.path, store: entry.path === 'mimetype' });
          await whileWriting(
            new Promise<void>((resolve, reject) => {
              stream.once('end', resolve);
              stream.once('error', reject);
            }),
          );
        }
        current = undefined;
        output.append(JSON.stringify(provenance), { name: EDITION_SYNC_PROVENANCE_ENTRY });
        output.append(reportText, { name: EDITION_SYNC_REPORT_ENTRY });
        await whileWriting(output.finalize());
        await done;
      } catch (error) {
        current?.destroy();
        output.destroy(error instanceof Error ? error : undefined);
        await done.catch(() => undefined);
        throw error;
      }
      await rename(partial, destination);
    } finally {
      await rm(partial, { force: true });
    }
    this.scanner.scanBookFolderAsync(destination, source.libraryId);
    return { indexPath: destination, indexBytes: (await stat(destination)).size, provenance };
  }

  private async captureFingerprints(bookId: number, epub: EditionSyncBookFileRef, audio: EditionSyncBookFileRef[]) {
    const fingerprints = new Map<number, string>();
    const sources = [{ file: epub, kind: 'chapter' as const }, ...audio.map((file) => ({ file, kind: 'audio' as const }))];
    const sourceStats = new Map<number, { size: number; mtimeMs: number }>();
    for (const { file, kind } of sources) {
      const started = Date.now();
      try {
        const info = await stat(file.absolutePath);
        if (info.size !== file.sizeBytes || Math.abs(info.mtimeMs - (file.mtime?.getTime() ?? 0)) >= 1)
          throw new InternalServerErrorException('Source stat differs from catalog');
        sourceStats.set(file.id, { size: info.size, mtimeMs: info.mtimeMs });
        const fingerprint = await this.optionalFingerprint(bookId, file.absolutePath, kind);
        if (fingerprint) fingerprints.set(file.id, fingerprint);
      } catch (error) {
        this.fingerprintSkipped(bookId, file.absolutePath, kind, started, error);
      }
    }
    const checkStats = async () => {
      for (const { file, kind } of sources) {
        const before = sourceStats.get(file.id);
        if (!before || !fingerprints.has(file.id)) continue;
        const started = Date.now();
        try {
          const info = await stat(file.absolutePath);
          if (info.size !== before.size || info.mtimeMs !== before.mtimeMs)
            throw new InternalServerErrorException('Source stat changed during capture');
        } catch (error) {
          fingerprints.delete(file.id);
          this.fingerprintSkipped(bookId, file.absolutePath, kind, started, error);
        }
      }
    };
    return { fingerprints, checkStats };
  }

  /** A missing fingerprint only costs the metadata-only shortcut later, so it never fails a capture. */
  private async optionalFingerprint(bookId: number, path: string, kind: 'chapter' | 'audio'): Promise<string | undefined> {
    const started = Date.now();
    try {
      return kind === 'chapter' ? await chapterFingerprint(path) : await audioFingerprint(path, this.config.ffmpegPath);
    } catch (error) {
      this.fingerprintSkipped(bookId, path, kind, started, error);
      return undefined;
    }
  }

  private fingerprintSkipped(bookId: number, path: string, kind: 'chapter' | 'audio', started: number, error: unknown): void {
    this.logger.warn(
      `[edition_sync.fingerprint] [fail] bookId=${bookId} kind=${kind} path="${sanitizeLogValue(path)}" durationMs=${Date.now() - started} errorClass=${error instanceof Error ? error.name : 'Unknown'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - fingerprint skipped`,
    );
  }

  async checkContent(bookId: number, stored: EditionSyncProvenance): Promise<'metadata_only' | 'content_changed' | 'retry'> {
    const started = Date.now();
    let files = 0;
    let candidates: EditionSyncBookFileRef[] = [];
    const checked = new Map<string, { size: number; mtimeMs: number }>();
    this.logger.log(`[edition_sync.content_check] [start] bookId=${bookId} - checking source content`);
    const end = (outcome: string) =>
      this.logger.log(
        `[edition_sync.content_check] [end] bookId=${bookId} durationMs=${Date.now() - started} outcome=${outcome} files=${files} - source content checked`,
      );
    try {
      const source = await this.repo.findIndexSource(bookId);
      if (!source || source.epub.id !== stored.epub.bookFileId || source.audio.length !== stored.audio.length) {
        end('content_changed');
        return 'content_changed';
      }
      const refreshed = structuredClone(stored);
      candidates = [source.epub, ...source.audio];
      const audioById = new Map(source.audio.map((file) => [file.id, file]));
      for (const [previous, target, current, fingerprint] of [
        [stored.epub, refreshed.epub, source.epub, stored.epub.chapterFingerprint],
        ...stored.audio.map((audio, index) => [audio, refreshed.audio[index], audioById.get(audio.bookFileId), audio.audioFingerprint] as const),
      ] as const) {
        if (!current || current.bookId !== bookId) {
          end('content_changed');
          return 'content_changed';
        }
        const changed = !compareProvenance({ ...stored, epub: previous, audio: [] }, [current]).valid;
        if (changed) files++;
        if (!canCheckChangedFile(bookId, previous, current, fingerprint)) {
          end('no_fingerprint');
          return 'content_changed';
        }
        const before = await stat(current.absolutePath);
        if (before.size !== current.sizeBytes || Math.abs(before.mtimeMs - (current.mtime?.getTime() ?? 0)) >= 1) {
          end('retry');
          return 'retry';
        }
        checked.set(current.absolutePath, { size: before.size, mtimeMs: before.mtimeMs });
        if (!changed) continue;
        const actual =
          current.id === source.epub.id
            ? await chapterFingerprint(current.absolutePath)
            : await audioFingerprint(current.absolutePath, this.config.ffmpegPath);
        const after = await stat(current.absolutePath);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
          end('retry');
          return 'retry';
        }
        if (actual !== fingerprint) {
          end('content_changed');
          return 'content_changed';
        }
        Object.assign(target, provenanceFile(current));
      }
      for (const [path, file] of checked) {
        const info = await stat(path);
        if (info.size !== file.size || info.mtimeMs !== file.mtimeMs) {
          end('retry');
          return 'retry';
        }
      }
      const fresh = await this.repo.findBookFilesByIds([refreshed.epub.bookFileId, ...refreshed.audio.map((file) => file.bookFileId)]);
      if (!compareProvenance(refreshed, fresh).valid) {
        end('retry');
        return 'retry';
      }
      if (!(await this.repo.refreshProvenance(bookId, stored, refreshed, new Date(started)))) {
        end('retry');
        return 'retry';
      }
      end('metadata_only');
      return 'metadata_only';
    } catch (error) {
      // A file renamed or replaced by a concurrent write disappears briefly; a real deletion shows up as file_missing next time.
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        end('retry');
        return 'retry';
      }
      for (const file of candidates) {
        try {
          const info = await stat(file.absolutePath);
          const before = checked.get(file.absolutePath);
          const moved = before
            ? info.size !== before.size || info.mtimeMs !== before.mtimeMs
            : info.size !== file.sizeBytes || Math.abs(info.mtimeMs - (file.mtime?.getTime() ?? 0)) >= 1;
          if (!moved) continue;
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') continue;
        }
        end('retry');
        return 'retry';
      }
      this.logger.warn(
        `[edition_sync.content_check] [fail] bookId=${bookId} durationMs=${Date.now() - started} errorClass=${error instanceof Error ? error.name : 'Unknown'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - source content check failed`,
      );
      return 'content_changed';
    }
  }

  async readProvenance(indexPath: string): Promise<EditionSyncProvenance | null> {
    try {
      if (!(await lstat(indexPath)).isFile()) return null;
      const archive = await unzipper.Open.file(indexPath);
      const entry = archive.files.find((file) => file.path === EDITION_SYNC_PROVENANCE_ENTRY);
      if (!entry) return null;
      const value = JSON.parse(await boundedText(entry)) as EditionSyncProvenance;
      return value.version === 1 &&
        Number.isSafeInteger(value.bookId) &&
        Array.isArray(value.audio) &&
        Array.isArray(value.chunks) &&
        Array.isArray(value.audioEntries)
        ? value
        : null;
    } catch {
      return null;
    }
  }

  async verifyProvenance(bookId: number): Promise<EditionSyncVerification> {
    const row = await this.repo.findIndexRow(bookId);
    if (row?.indexFileId) {
      const [file] = await this.repo.findBookFilesByIds([row.indexFileId]);
      if (file && file.bookId === bookId && file.absolutePath !== row.indexPath && (await lstat(file.absolutePath).catch(() => null))?.isFile()) {
        await this.repo.updateIndexRow(bookId, { indexPath: file.absolutePath });
        row.indexPath = file.absolutePath;
      }
    }
    if (!row?.provenance || !row.indexPath || !(await lstat(row.indexPath).catch(() => null))?.isFile())
      return this.invalidate(bookId, 'index_missing');
    const stored = await this.readProvenance(row.indexPath);
    if (!stored || stored.bookId !== bookId || !isDeepStrictEqual(immutableProvenance(stored), immutableProvenance(row.provenance)))
      return this.invalidate(bookId, 'index_missing');
    const current = row.provenance;
    const ids = [current.epub.bookFileId, ...current.audio.map((file) => file.bookFileId)];
    const source = await this.repo.findIndexSource(bookId);
    if (
      source &&
      (source.audio.length !== stored.audio.length || source.audio.some((file) => !stored.audio.some((entry) => entry.bookFileId === file.id)))
    ) {
      await this.repo.markStale(bookId, 'audio_changed');
      return { valid: false, reason: 'audio_changed' };
    }
    const files = await this.repo.findBookFilesByIds(ids);
    const result = compareProvenance(current, files);
    if (!result.valid) {
      if (canCheckChangedContent(current, files)) await this.repo.flagRecheck(bookId);
      else await this.repo.markStale(bookId, result.reason);
    }
    return result;
  }

  private async invalidate(bookId: number, reason: 'index_missing'): Promise<EditionSyncVerification> {
    await this.repo.markStale(bookId, reason);
    return { valid: false, reason };
  }

  async copyIndex(bookId: number, destination: string): Promise<void> {
    await this.locks.withLock(bookOperationLockKey(bookId), async () => {
      if (!(await this.verifyProvenance(bookId)).valid) throw new BadRequestException('Timing index is stale');
      const row = await this.repo.findIndexRow(bookId);
      if (!row?.indexPath) throw new NotFoundException('Timing index is missing');
      await rm(destination, { force: true });
      await copyFile(row.indexPath, destination, constants.COPYFILE_EXCL);
    });
  }

  async removeSupersededIndex(bookId: number, previousPath: string, currentPath: string): Promise<void> {
    const started = Date.now();
    try {
      await this.locks.withLock(bookOperationLockKey(bookId), async () => {
        if (previousPath === currentPath) return;
        const info = await lstat(previousPath).catch(() => null);
        if (!info?.isFile() || (await this.readProvenance(previousPath))?.bookId !== bookId) return;
        await rm(previousPath, { force: true });
        const source = await this.repo.findIndexSource(bookId);
        if (source) this.scanner.scanBookFolderAsync(previousPath, source.libraryId);
        this.logger.log(
          `[edition_sync.delete_index] [end] bookId=${bookId} durationMs=${Date.now() - started} superseded=true freedBytes=${info.size} - superseded index removed`,
        );
      });
    } catch (error) {
      this.logger.warn(
        `[edition_sync.delete_index] [fail] bookId=${bookId} durationMs=${Date.now() - started} errorClass=${error instanceof Error ? error.name : 'Unknown'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - superseded index removal failed`,
      );
    }
  }

  async removeIndexFile(bookId: number, indexPath: string): Promise<number> {
    const started = Date.now();
    this.logger.log(`[edition_sync.delete_index] [start] bookId=${bookId} - deleting timing index`);
    try {
      const freedBytes = await this.locks.withLock(bookOperationLockKey(bookId), () => this.removeIndexFileLocked(bookId, indexPath));
      this.logger.log(
        `[edition_sync.delete_index] [end] bookId=${bookId} durationMs=${Date.now() - started} freedBytes=${freedBytes} - timing index deletion completed`,
      );
      return freedBytes;
    } catch (error) {
      this.logger.warn(
        `[edition_sync.delete_index] [fail] bookId=${bookId} durationMs=${Date.now() - started} errorClass=${error instanceof Error ? error.name : 'Unknown'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - timing index deletion failed`,
      );
      throw error;
    }
  }

  private async removeIndexFileLocked(bookId: number, indexPath: string): Promise<number> {
    const info = await lstat(indexPath).catch(() => null);
    if (!info?.isFile() || (await this.readProvenance(indexPath))?.bookId !== bookId) return 0;
    const source = await this.repo.findIndexSource(bookId);
    await rm(indexPath, { force: true });
    if (source) this.scanner.scanBookFolderAsync(indexPath, source.libraryId);
    return info.size;
  }
}
