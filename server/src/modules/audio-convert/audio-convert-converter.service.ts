import { constants as fsConstants } from 'node:fs';
import { access, chmod, chown, copyFile, mkdir, readFile, rename, rm, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

import type {
  AudioConvertBitrate,
  AudioConvertCannotReason,
  AudioConvertChannels,
  AudioConvertErrorCode,
  AudioConvertJobResult,
  AudioConvertPlan,
  AudioConvertPlanFile,
  AudioConvertResolvedCodec,
  AudiobookChapter,
  AudiobookChapterSource,
} from '@bookorbit/types';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import sharp from 'sharp';

import { FileLockService, bookOperationLockKey } from '../../common/services/file-lock.service';
import { SelfWriteRegistry } from '../../common/services/self-write-registry.service';
import { orderAudiobookTracks } from '../../common/utils/audiobook-chapters.utils';
import { computeFileHash } from '../../common/utils/file-hash.utils';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { audioToolsConfig, storageConfig } from '../../config/config';
import { BookCoverStore } from '../book-cover-store/book-cover-store.service';
import { FileWriteRepository } from '../file-write/file-write.repository';
import { MetadataService } from '../metadata/metadata.service';
import { AudioProbeCache, probeAudio, runConvertFfmpeg } from './audio-convert-ffmpeg';
import { AudioConvertRepository, toJob, type ConvertBookContext, type ConvertFileRow } from './audio-convert.repository';
import {
  buildConcatList,
  buildConvertArgs,
  buildFfmetadata,
  chooseAutoCodec,
  errorClass,
  errorMessage,
  exactStartsMs,
  outputPathFor,
  perFileChapters,
  plainStartsSeconds,
  progressPercent,
  rebaseChapters,
  resolveCodec,
  type AudioProbe,
  type ConvertChapterMode,
  type ConvertTags,
} from './audio-convert.utils';
import type { AudioConvertJobRow, AudioConvertSettingsRow, AudioConvertWorkPaths } from './schema/audio-convert.schema';

const MP4_FORMATS = new Set(['m4b', 'm4a']);
/** Room a conversion needs beside the book: the new file is about as large as the old ones. */
const DISK_HEADROOM = 1.1;
/** ffprobe processes per plan; a 200-part book must not start 200 at once. */
const PROBE_CONCURRENCY = 4;

export class ConvertError extends Error {
  constructor(
    readonly code: AudioConvertErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ConvertError';
  }
}

/** The job must wait: someone is listening or the library is busy. It goes back in the queue until `until`. */
export class ConvertDeferredError extends Error {
  constructor(readonly until: Date) {
    super('deferred');
    this.name = 'ConvertDeferredError';
  }
}

export class ConvertCancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'ConvertCancelledError';
  }
}

export interface ConvertHooks {
  onProgress: (percent: number) => void;
  /** Checked under the book lock right before the backup and swap; a date defers the job to then. */
  readyToSwap: () => Promise<Date | null>;
  /** Makes the job uncancellable; false when it was cancelled first. Synchronous, so no cancel slips in between. */
  enterSwap: () => boolean;
  onSwapping: () => Promise<void>;
}

export interface ConvertOutcome {
  result: AudioConvertJobResult;
  backupPath: string | null;
}

export type RecoveryOutcome =
  { status: 'success'; backupPath: string | null; result: Partial<AudioConvertJobResult> } | { status: 'failed'; message: string };

interface ConvertTimeline {
  oldStartsSeconds: number[];
  newStartsSeconds: number[];
}

interface ChapterPlan {
  /** What `book_metadata.chapters` becomes, or null to leave it. */
  stored: AudiobookChapter[] | null;
  /** What the ffmetadata file carries, when `mode` is `metadata`. */
  embedded: AudiobookChapter[] | null;
  mode: ConvertChapterMode;
}

interface ProbedFile {
  row: ConvertFileRow;
  probe: (AudioProbe & { chapterCount: number }) | null;
}

@Injectable()
export class AudioConvertConverterService {
  private readonly logger = new Logger(AudioConvertConverterService.name);
  private readonly probes: AudioProbeCache;

  constructor(
    private readonly repo: AudioConvertRepository,
    private readonly locks: FileLockService,
    private readonly coverStore: BookCoverStore,
    private readonly fileWriteRepo: FileWriteRepository,
    private readonly metadata: MetadataService,
    private readonly selfWrites: SelfWriteRegistry,
    @Inject(audioToolsConfig.KEY) private readonly tools: ConfigType<typeof audioToolsConfig>,
    @Inject(storageConfig.KEY) private readonly storage: ConfigType<typeof storageConfig>,
  ) {
    this.probes = new AudioProbeCache((path) => probeAudio(this.tools.ffprobePath, path), PROBE_CONCURRENCY);
  }

  get workRoot(): string {
    return join(this.storage.appDataPath, 'audio-convert', 'jobs');
  }

  get backupRoot(): string {
    return join(this.storage.appDataPath, 'audio-convert', 'backups');
  }

  // ── Plan ──────────────────────────────────────────────────────────────────

  async plan(bookId: number): Promise<AudioConvertPlan> {
    const [book, rows, latest, counts, readAlong] = await Promise.all([
      this.repo.findBook(bookId),
      this.repo.findContentAudioFiles(bookId),
      this.repo.latestJob(bookId),
      this.repo.countListeners(bookId),
      this.repo.hasReadAlong(bookId),
    ]);
    const ordered = orderAudiobookTracks(rows);
    const probed = await this.probeAll(ordered);
    const files: AudioConvertPlanFile[] = probed.map(({ row, probe }) => ({
      fileId: row.id,
      relativePath: row.relPath ?? basename(row.absolutePath),
      format: (row.format ?? '').toLowerCase(),
      sizeBytes: row.sizeBytes ?? 0,
      durationMs: probe?.durationMs ?? (row.durationSeconds === null ? null : row.durationSeconds * 1000),
      codec: probe?.codec ?? null,
      sampleRate: probe?.sampleRate ?? null,
      channels: probe?.channels ?? null,
      bitrateKbps: probe?.bitrateKbps ?? null,
    }));
    const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
    const durations = files.map((file) => file.durationMs);
    const totalDurationMs = durations.every((value) => value !== null) ? durations.reduce<number>((sum, value) => sum + value!, 0) : null;
    const finalPath = ordered[0]
      ? outputPathFor(
          ordered.map((row) => row.absolutePath),
          book?.folderPath,
        )
      : null;
    const status =
      book && finalPath
        ? await this.planStatus(ordered, probed, totalBytes, latest, dirname(finalPath))
        : { status: 'cannot' as const, reason: 'no_audio' as const };
    const probes = probed.map((entry) => entry.probe).filter((probe): probe is AudioProbe & { chapterCount: number } => probe !== null);
    const auto = probes.length === probed.length && probes.length > 0 ? chooseAutoCodec(probes) : null;
    const storedChapters = book?.chapters?.length ? book.chapters.length : 0;
    const embedded = probed.length === 1 ? (probed[0]!.probe?.chapterCount ?? 0) : 0;
    const chapterSource = storedChapters > 0 ? 'stored' : probed.length > 1 ? 'per_file' : embedded > 0 ? 'embedded' : 'none';
    const hasCover = (await this.coverStore.resolve(bookId, { medium: 'audio', variant: 'cover' }).catch(() => null)) !== null;

    return {
      bookId,
      status: status.status,
      reason: status.reason,
      files,
      outputName: finalPath ? basename(finalPath) : null,
      autoCodec: auto?.codec ?? null,
      autoCodecReason: auto?.reason ?? null,
      totalBytes,
      totalDurationMs,
      chapterCount: storedChapters || (probed.length > 1 ? probed.length : embedded),
      chapterSource,
      hasCover,
      listenersWithProgress: counts.listeners,
      bookmarkCount: counts.bookmarks,
      hasReadAlong: readAlong,
      latestJob: latest ? toJob(latest, book?.title ?? null) : null,
    };
  }

  private async planStatus(
    ordered: ConvertFileRow[],
    probed: ProbedFile[],
    totalBytes: number,
    latest: AudioConvertJobRow | null,
    outputFolder: string,
  ): Promise<{ status: AudioConvertPlan['status']; reason: AudioConvertCannotReason | null }> {
    if (latest && ['waiting', 'queued', 'running'].includes(latest.status)) return { status: 'waiting', reason: null };
    const blocked = this.formatBlock(ordered);
    if (blocked === 'already_converted') return { status: 'converted', reason: null };
    if (blocked) return { status: 'cannot', reason: blocked };
    if (probed.some((entry) => entry.probe === null)) return { status: 'cannot', reason: 'probe_failed' };
    const space = await this.spaceProblem(outputFolder, totalBytes);
    if (space) return { status: 'cannot', reason: space };
    return { status: 'can_convert', reason: null };
  }

  private formatBlock(ordered: ConvertFileRow[]): 'no_audio' | 'already_converted' | 'mixed_formats_with_m4b' | null {
    if (ordered.length === 0) return 'no_audio';
    const formats = ordered.map((row) => (row.format ?? '').toLowerCase());
    if (ordered.length === 1 && MP4_FORMATS.has(formats[0]!)) return 'already_converted';
    if (formats.some((format) => MP4_FORMATS.has(format)) && !formats.every((format) => MP4_FORMATS.has(format))) return 'mixed_formats_with_m4b';
    return null;
  }

  private async spaceProblem(folder: string, totalBytes: number): Promise<'folder_not_writable' | 'low_disk' | null> {
    try {
      await access(folder, fsConstants.W_OK);
    } catch {
      return 'folder_not_writable';
    }
    try {
      const fs = await statfs(folder);
      if (fs.bavail * fs.bsize < totalBytes * DISK_HEADROOM) return 'low_disk';
    } catch {
      // statfs is missing on some filesystems; the write itself will fail if the disk is full.
    }
    return null;
  }

  private async probeAll(rows: ConvertFileRow[]): Promise<ProbedFile[]> {
    const results = await this.probes.probeAll(rows.map((row) => row.absolutePath));
    return rows.map((row, index) => ({ row, probe: results[index] ?? null }));
  }

  // ── Convert ──────────────────────────────────────────────────────────────

  /**
   * Converts one book. Probing and encoding run without the book lock; the backup and swap run under it,
   * after `hooks.readyToSwap` confirms nobody is listening and the library is not busy, and after the
   * inputs are checked to be the files that were encoded. Until the database commit the originals are
   * untouched; a failure removes the new file and leaves the book as it was.
   */
  async convert(job: AudioConvertJobRow, settings: AudioConvertSettingsRow, signal: AbortSignal, hooks: ConvertHooks): Promise<ConvertOutcome> {
    const book = await this.repo.findBook(job.bookId);
    if (!book || book.status !== 'present') throw new ConvertError('book_missing');
    const ordered = orderAudiobookTracks(await this.repo.findContentAudioFiles(job.bookId));
    const blocked = this.formatBlock(ordered);
    if (blocked) throw new ConvertError(blocked);

    const snapshot = await snapshotFiles(ordered);
    const probed = await this.probeAll(ordered);
    if (probed.some((entry) => entry.probe === null)) throw new ConvertError('probe_failed');
    const probes = probed.map((entry) => entry.probe!);
    const totalBytes = ordered.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0);
    const finalPath = outputPathFor(
      ordered.map((row) => row.absolutePath),
      book.folderPath,
    );
    const space = await this.spaceProblem(dirname(finalPath), totalBytes);
    if (space) throw new ConvertError(space);

    const codec: AudioConvertResolvedCodec = resolveCodec(job.codec, probes);
    const durationsMs = probes.map((probe) => probe.durationMs);
    const totalMs = durationsMs.reduce((sum, value) => sum + value, 0);
    const timeline = this.timelines(ordered, durationsMs);
    const chapters = this.chapterPlan(settings, book.chapters, ordered, durationsMs, probes, timeline, totalMs);
    const tags = settings.embedMetadata ? await this.loadTags(job.bookId) : null;

    const workDir = join(this.workRoot, job.id);
    const tempOutput = join(dirname(finalPath), `.bookorbit-convert-${job.id}.m4b`);
    const workPaths: AudioConvertWorkPaths = { workDir, tempOutput };
    await this.repo.setWorkPaths(job.id, workPaths);
    await mkdir(workDir, { recursive: true });

    let backupPath: string | null = null;
    let renamed = false;
    try {
      const concatListPath = join(workDir, 'files.txt');
      const metadataPath = join(workDir, 'metadata.txt');
      await writeFile(
        concatListPath,
        buildConcatList(
          ordered.map((row) => row.absolutePath),
          durationsMs,
        ),
      );
      await writeFile(metadataPath, buildFfmetadata(tags, chapters.embedded, totalMs));
      const coverPath = settings.embedMetadata ? await this.writeCover(job.bookId, workDir) : null;

      await this.selfWrites.track([tempOutput], () =>
        runConvertFfmpeg(
          this.tools.ffmpegPath,
          buildConvertArgs({
            inputs: ordered.map((row) => row.absolutePath),
            concatListPath,
            metadataPath,
            coverPath,
            outputPath: tempOutput,
            codec,
            bitrate: job.bitrate as AudioConvertBitrate,
            channels: (job.channels ?? null) as AudioConvertChannels,
            embedMetadata: settings.embedMetadata,
            chapters: chapters.mode,
          }),
          { signal, outputPath: tempOutput, onProgress: (outTimeUs) => hooks.onProgress(progressPercent(outTimeUs, totalMs)) },
        ),
      );

      const output = await probeAudio(this.tools.ffprobePath, tempOutput);
      const tolerance = Math.max(1000, 50 * ordered.length);
      if (!output || Math.abs(output.durationMs - totalMs) > tolerance) {
        throw new ConvertError('verify_failed', `Expected ${totalMs} ms, got ${output?.durationMs ?? 'unreadable'}`);
      }
      if (chapters.embedded && output.chapterCount !== chapters.embedded.length) {
        throw new ConvertError('verify_failed', `Expected ${chapters.embedded.length} chapters, got ${output.chapterCount}`);
      }
      throwIfCancelled(signal);

      return await this.locks.withLock(bookOperationLockKey(job.bookId), async () => {
        const deferUntil = await hooks.readyToSwap();
        if (deferUntil) throw new ConvertDeferredError(deferUntil);
        await this.assertUnchanged(job.bookId, ordered, snapshot);
        const overwritesOriginal = ordered.some((row) => row.absolutePath === finalPath);
        if (!overwritesOriginal && (await exists(finalPath))) throw new ConvertError('swap_failed', `${basename(finalPath)} already exists`);

        // The backup is still cancellable; the swap that follows is not.
        if (settings.backupDays > 0 || overwritesOriginal) {
          const backup = await this.backup(job, ordered, signal);
          backupPath = backup.dir;
          workPaths.backupPath = backup.dir;
          workPaths.backupFiles = backup.files;
          await this.repo.setWorkPaths(job.id, workPaths);
        }
        if (!hooks.enterSwap()) throw new ConvertCancelledError();
        await hooks.onSwapping();

        const warnings: string[] = [];
        const result: AudioConvertJobResult = {
          filesMerged: ordered.length,
          sourceBytes: totalBytes,
          outputBytes: (await stat(tempOutput)).size,
          sourceDurationMs: totalMs,
          outputDurationMs: output.durationMs,
          chapters: output.chapterCount,
          codec,
          outputPath: relative(dirname(book.folderPath), finalPath),
          warnings,
        };
        await this.swap(job, book, ordered, tempOutput, finalPath, output.durationMs, workPaths, {
          timeline,
          chapters: chapters.stored,
          chaptersSource: book.chaptersSource ?? 'embedded',
          backupPath,
          result,
          onRenamed: () => (renamed = true),
        });

        await this.metadata.aggregateAudioDuration(job.bookId).catch(() => warnings.push('duration_not_updated'));
        return { backupPath, result };
      });
    } catch (error) {
      // Nothing was swapped: the originals are in place, so their copy is not needed.
      if (!renamed && backupPath) await this.deleteBackup(backupPath).catch(() => undefined);
      throw error;
    } finally {
      await rm(tempOutput, { force: true }).catch(() => undefined);
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Each file's start on the stored timeline (plain running sum of whole-second lengths, which the
   * manifest, the player, bookmarks and stored chapters use) and on the joined file's exact timeline.
   * A single file starts at 0 on both, so nothing in it moves.
   */
  private timelines(ordered: ConvertFileRow[], durationsMs: number[]): ConvertTimeline {
    if (ordered.length === 1) return { oldStartsSeconds: [0], newStartsSeconds: [0] };
    return {
      oldStartsSeconds: plainStartsSeconds(ordered.map((row) => row.durationSeconds)),
      newStartsSeconds: exactStartsMs(durationsMs).map((ms) => ms / 1000),
    };
  }

  /**
   * `stored` is what `book_metadata.chapters` becomes, and is rebased whatever the embed setting, since
   * the stored list must match the new file. `embedded` is what goes into the M4B, and only when
   * chapters are embedded; a single file keeps its own chapters when nothing is stored.
   */
  private chapterPlan(
    settings: AudioConvertSettingsRow,
    stored: AudiobookChapter[] | null,
    ordered: ConvertFileRow[],
    durationsMs: number[],
    probes: (AudioProbe & { chapterCount: number })[],
    timeline: ConvertTimeline,
    totalMs: number,
  ): ChapterPlan {
    const multi = ordered.length > 1;
    const hasStored = stored !== null && stored.length > 0;
    if (!multi) {
      // One file: its timeline does not change, so the stored list stays exactly as it is.
      if (!settings.embedChapters) return { stored: null, embedded: null, mode: 'none' };
      if (hasStored) return { stored: null, embedded: stored.filter((chapter) => chapter.startMs < totalMs), mode: 'metadata' };
      return { stored: null, embedded: null, mode: (probes[0]?.chapterCount ?? 0) > 0 ? 'source' : 'none' };
    }
    const rebased = hasStored ? rebaseChapters(stored, timeline.oldStartsSeconds, timeline.newStartsSeconds, totalMs) : null;
    if (!settings.embedChapters) return { stored: rebased, embedded: null, mode: 'none' };
    const embedded =
      rebased ??
      perFileChapters(
        ordered.map((row) => row.absolutePath),
        durationsMs,
      );
    return { stored: embedded, embedded, mode: 'metadata' };
  }

  private async loadTags(bookId: number): Promise<ConvertTags | null> {
    const payload = await this.fileWriteRepo.loadPayload(bookId);
    if (!payload) return null;
    return {
      title: payload.title,
      subtitle: payload.subtitle,
      authors: payload.authors?.map((author) => author.name),
      narrators: payload.narrators,
      seriesName: payload.seriesName,
      seriesIndex: payload.seriesIndex,
      publisher: payload.publisher,
      publishedDate: payload.publishedDate,
      publishedYear: payload.publishedYear,
      description: payload.description,
      genres: payload.genres,
      language: payload.language,
      asin: payload.audibleId,
      isbn: payload.isbn13 ?? payload.isbn10,
    };
  }

  /** MP4 cover art must be JPEG or PNG; the stored cover may be WebP. */
  private async writeCover(bookId: number, workDir: string): Promise<string | null> {
    const source = await this.coverStore.resolve(bookId, { medium: 'audio', variant: 'cover' }).catch(() => null);
    if (!source) return null;
    try {
      const jpeg = await sharp(await readFile(source))
        .jpeg({ quality: 92 })
        .toBuffer();
      const path = join(workDir, 'cover.jpg');
      await writeFile(path, jpeg);
      return path;
    } catch {
      return null;
    }
  }

  /** The rows and files are the ones that were encoded: same rows, paths, sizes and modification times. */
  private async assertUnchanged(bookId: number, ordered: ConvertFileRow[], snapshot: FileSnapshot[]): Promise<void> {
    const now = orderAudiobookTracks(await this.repo.findContentAudioFiles(bookId));
    const same =
      now.length === ordered.length && now.every((row, index) => row.id === ordered[index]!.id && row.absolutePath === ordered[index]!.absolutePath);
    if (!same) throw new ConvertError('files_changed');
    const current = await snapshotFiles(ordered);
    for (const [index, before] of snapshot.entries()) {
      const after = current[index]!;
      if (!after.exists || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw new ConvertError('files_changed', `${basename(ordered[index]!.absolutePath)} changed while it was converted`);
      }
    }
  }

  private async backup(
    job: AudioConvertJobRow,
    ordered: ConvertFileRow[],
    signal: AbortSignal,
  ): Promise<{ dir: string; files: Record<string, string> }> {
    const dir = join(this.backupRoot, `${job.bookId}-${job.id}`);
    try {
      await mkdir(dir, { recursive: true });
      const free = await statfs(dir)
        .then((fs) => fs.bavail * fs.bsize)
        .catch(() => Number.POSITIVE_INFINITY);
      const needed = ordered.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0);
      if (free < needed * DISK_HEADROOM) throw new ConvertError('low_disk', 'Not enough room to back up the originals');
      const seen = new Set<string>();
      const files: Record<string, string> = {};
      for (const [index, row] of ordered.entries()) {
        throwIfCancelled(signal);
        let name = basename(row.absolutePath);
        if (seen.has(name)) name = `${index + 1}-${name}`;
        seen.add(name);
        const target = join(dir, name);
        await copyFile(row.absolutePath, target);
        const [source, copy] = await Promise.all([stat(row.absolutePath), stat(target)]);
        if (source.size !== copy.size) throw new ConvertError('backup_failed', `Backup of ${name} is incomplete`);
        files[row.absolutePath] = target;
      }
      await writeFile(join(dir, 'files.json'), JSON.stringify({ bookId: job.bookId, jobId: job.id, files }, null, 2));
      return { dir, files };
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof ConvertError || error instanceof ConvertCancelledError) throw error;
      throw new ConvertError('backup_failed', errorMessage(error));
    }
  }

  private async swap(
    job: AudioConvertJobRow,
    book: ConvertBookContext,
    ordered: ConvertFileRow[],
    tempOutput: string,
    finalPath: string,
    durationMs: number,
    workPaths: AudioConvertWorkPaths,
    context: {
      timeline: ConvertTimeline;
      chapters: AudiobookChapter[] | null;
      chaptersSource: AudiobookChapterSource | null;
      backupPath: string | null;
      result: AudioConvertJobResult;
      onRenamed: () => void;
    },
  ): Promise<void> {
    const kept = ordered[0]!;
    const originals = ordered.map((row) => row.absolutePath);
    const paths = [...new Set([...originals, finalPath, tempOutput])];
    await this.selfWrites.track(paths, async () => {
      const original = await stat(kept.absolutePath);
      await chmod(tempOutput, original.mode & 0o7777).catch(() => undefined);
      await chown(tempOutput, original.uid, original.gid).catch(() => undefined);

      // Both hashes are read before the rename (the hash is of the content, not the path), so the window
      // between the rename and the commit is as short as it can be, and recovery can recognise our file.
      const previousHash = await computeFileHash(kept.absolutePath).catch(() => null);
      const fileHash = await computeFileHash(tempOutput);
      const swapping: AudioConvertWorkPaths = { ...workPaths, phase: 'swapping', finalPath, newHash: fileHash, originals, result: context.result };
      await this.repo.setWorkPaths(job.id, swapping);

      await rename(tempOutput, finalPath);
      context.onRenamed();
      let committed = false;
      try {
        const written = await stat(finalPath, { bigint: true });
        await this.repo.commitSwap({
          jobId: job.id,
          bookId: book.bookId,
          keptFileId: kept.id,
          mergedFileIds: ordered.slice(1).map((row) => row.id),
          orderedFileIds: ordered.map((row) => row.id),
          oldStartsSeconds: context.timeline.oldStartsSeconds,
          newStartsSeconds: context.timeline.newStartsSeconds,
          totalSeconds: durationMs / 1000,
          file: {
            absolutePath: finalPath,
            relPath: relPathFor(kept, finalPath),
            ino: written.ino,
            sizeBytes: Number(written.size),
            mtime: new Date(Number(written.mtimeMs)),
            fileHash,
            durationSeconds: Math.round(durationMs / 1000),
          },
          previousHash,
          chapters: context.chapters,
          chaptersSource: context.chapters ? context.chaptersSource : null,
          workPaths: swapping,
          backupPath: context.backupPath,
        });
        committed = true;
      } finally {
        if (!committed) await this.rollbackFile(finalPath, swapping);
      }

      await this.removeOriginals(book.bookId, originals, finalPath, context.result.warnings);
    });
  }

  private async removeOriginals(bookId: number, originals: string[], finalPath: string, warnings: string[]): Promise<void> {
    for (const path of originals) {
      if (path === finalPath) continue;
      const startedAt = Date.now();
      await unlink(path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        warnings.push(`original_not_removed:${basename(path)}`);
        this.logger.error(
          `[audio_convert.remove_original] [fail] bookId=${bookId} path="${sanitizeLogValue(path)}" durationMs=${Date.now() - startedAt} errorClass=${errorClass(error)} error="${sanitizeLogValue(errorMessage(error))}" - original file not removed`,
        );
      });
    }
  }

  /**
   * Undoes a rename that never reached the database. Only our own file (by its hash) is touched: it is
   * removed, or, where it took an original's name, that original comes back from the backup.
   */
  private async rollbackFile(finalPath: string, paths: AudioConvertWorkPaths): Promise<boolean> {
    const hash = await computeFileHash(finalPath).catch(() => null);
    if (hash === null || hash !== paths.newHash) return true;
    const backupFile = paths.backupFiles?.[finalPath];
    if (paths.originals?.includes(finalPath)) {
      if (!backupFile) return false;
      return copyFile(backupFile, finalPath).then(
        () => true,
        () => false,
      );
    }
    await rm(finalPath, { force: true }).catch(() => undefined);
    return true;
  }

  /**
   * Finishes or undoes a job a restart cut off. Committed: the book already points at the new file, so
   * the leftover originals go and the job succeeds with its backup kept. Anything earlier: our new file
   * (if renamed) is removed or the overwritten original restored, the originals stay, the backup goes.
   */
  async recoverInterrupted(job: AudioConvertJobRow): Promise<RecoveryOutcome> {
    const paths = job.workPaths ?? {};
    try {
      if (paths.phase === 'committed' && paths.finalPath) {
        const warnings = [...(paths.result?.warnings ?? [])];
        const originals = paths.originals ?? [];
        await this.selfWrites.track([...originals, paths.finalPath], () => this.removeOriginals(job.bookId, originals, paths.finalPath!, warnings));
        await this.metadata.aggregateAudioDuration(job.bookId).catch(() => warnings.push('duration_not_updated'));
        return { status: 'success', backupPath: paths.backupPath ?? null, result: { ...(paths.result ?? {}), warnings } };
      }
      let restored = true;
      if (paths.phase === 'swapping' && paths.finalPath) {
        restored = await this.selfWrites.track([paths.finalPath], () => this.rollbackFile(paths.finalPath!, paths));
      }
      if (paths.backupPath && restored) await this.deleteBackup(paths.backupPath);
      return {
        status: 'failed',
        message: restored
          ? 'Server stopped before the conversion finished; the original files are unchanged'
          : `Server stopped while swapping files; restore ${basename(paths.finalPath ?? '')} from ${paths.backupPath ?? 'the backup'}`,
      };
    } finally {
      if (paths.tempOutput) await rm(paths.tempOutput, { force: true }).catch(() => undefined);
      if (paths.workDir) await rm(paths.workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async deleteBackup(path: string): Promise<void> {
    // Only ever delete inside our own backup folder.
    if (!path.startsWith(this.backupRoot + '/')) return;
    await rm(path, { recursive: true, force: true });
  }
}

interface FileSnapshot {
  exists: boolean;
  size: number;
  mtimeMs: number;
}

async function snapshotFiles(rows: readonly ConvertFileRow[]): Promise<FileSnapshot[]> {
  return Promise.all(
    rows.map(async (row) => {
      const info = await stat(row.absolutePath).catch(() => null);
      return info ? { exists: true, size: info.size, mtimeMs: info.mtimeMs } : { exists: false, size: -1, mtimeMs: -1 };
    }),
  );
}

/** The kept row's path relative to its library folder, for the new file. */
function relPathFor(kept: ConvertFileRow, finalPath: string): string | null {
  if (!kept.relPath) return null;
  const root = kept.absolutePath.endsWith(kept.relPath) ? kept.absolutePath.slice(0, kept.absolutePath.length - kept.relPath.length) : null;
  if (root !== null) return relative(root, finalPath);
  const rel = join(dirname(kept.relPath), basename(finalPath));
  return rel === '.' ? basename(finalPath) : rel;
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ConvertCancelledError();
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
