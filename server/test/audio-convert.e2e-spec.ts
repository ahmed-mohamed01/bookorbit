import { execFileSync } from 'child_process';
import { copyFile, mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { bookOperationLockKey, FileLockService } from '../src/common/services/file-lock.service';
import { computeFileHash } from '../src/common/utils/file-hash.utils';
import {
  audiobookProgress,
  bookFiles,
  bookMetadata,
  bookmarks,
  books,
  bookTags,
  readerPreferences,
  readingProgress,
  tags,
  users,
} from '../src/db/schema';
import { BookCoverStore } from '../src/modules/book-cover-store/book-cover-store.service';
import { AudioConvertConverterService, ConvertError } from '../src/modules/audio-convert/audio-convert-converter.service';
import { probeAudio } from '../src/modules/audio-convert/audio-convert-ffmpeg';
import { AudioConvertQueueService } from '../src/modules/audio-convert/audio-convert-queue.service';
import { AudioConvertRepository } from '../src/modules/audio-convert/audio-convert.repository';
import { audioConvertJobs, type AudioConvertJobRow } from '../src/modules/audio-convert/schema/audio-convert.schema';
import { audioFingerprint } from '../src/modules/edition-sync/edition-sync-fingerprints';
import { closeE2EContext, createE2EContext, seedLibrary, triggerAndWaitForLibraryScan, type E2EContext } from './e2e/app-harness';

const TEST_TIMEOUT_MS = 120_000;

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function ffprobeJson(path: string): {
  format: { tags?: Record<string, string> };
  streams: { codec_type: string; disposition?: { attached_pic?: number } }[];
  chapters: { start_time: string; tags?: { title?: string } }[];
} {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-show_chapters', '-of', 'json', path]).toString());
}

function decodedMd5(path: string): string {
  return execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:a', '-f', 'md5', '-']).toString().trim();
}

describe.runIf(hasFfmpeg())('Convert to M4B (e2e)', () => {
  let ctx: E2EContext;
  let root: string;
  let adminId: number;

  beforeAll(async () => {
    ctx = await createE2EContext({ isolateAppData: true });
    root = await mkdtemp(join(tmpdir(), 'bookorbit-audio-convert-'));
    // Jobs left by an earlier run would be claimed first by the worker.
    await ctx.db.execute(sql`UPDATE audio_convert_jobs SET status = 'cancelled' WHERE status IN ('waiting', 'queued', 'running')`);
    const [admin] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.isSuperuser, true)).limit(1);
    adminId = admin!.id;
  });

  afterAll(async () => {
    await closeE2EContext(ctx);
    await rm(root, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const api = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    ctx.app.inject({ method, url: `/api/v1/audio-convert/${url}`, headers: { authorization: `Bearer ${ctx.adminToken}` }, payload });
  const repo = () => ctx.app.get(AudioConvertRepository);
  const jobRow = async (id: string) => (await ctx.db.select().from(audioConvertJobs).where(eq(audioConvertJobs.id, id)))[0]!;

  type Track = readonly [name: string, seconds: number];
  const settled = new Date(Date.now() - 10 * 60_000);

  async function writeAudio(path: string, seconds: number, kind: 'cbr' | 'vbr' | 'aac' = 'cbr', frequency = 330): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const codec =
      kind === 'vbr' ? ['-c:a', 'libmp3lame', '-q:a', '4'] : kind === 'aac' ? ['-c:a', 'aac', '-b:a', '64k'] : ['-ac', '2', '-b:a', '64k'];
    const format = kind === 'aac' ? ['-f', 'mp4'] : [];
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${seconds}`, ...codec, ...format, path]);
    await utimes(path, settled, settled);
  }

  /** A library holding one book at `<library>/<bookDir>`, scanned, with whole-second lengths as a real scan stores them. */
  async function makeBook(name: string, bookDir: string, tracks: readonly Track[], kind: 'cbr' | 'vbr' | 'aac' = 'cbr') {
    const libraryRoot = join(root, name);
    const folder = join(libraryRoot, bookDir);
    for (const [file, seconds] of tracks) await writeAudio(join(folder, file), seconds, kind);
    const { libraryId } = await seedLibrary(ctx.db, { rootPath: libraryRoot, mode: 'book_per_folder' });
    await triggerAndWaitForLibraryScan(ctx, libraryId);
    const [book] = await ctx.db.select({ id: books.id }).from(books).where(eq(books.libraryId, libraryId));
    expect(book).toBeDefined();
    const bookId = book!.id;
    const files = (await ctx.db.select().from(bookFiles).where(eq(bookFiles.bookId, bookId))).sort((a, b) =>
      a.absolutePath.localeCompare(b.absolutePath),
    );
    expect(files).toHaveLength(tracks.length);
    const exact: number[] = [];
    for (const file of files) {
      const probe = await probeAudio('ffprobe', file.absolutePath);
      exact.push(probe!.durationMs / 1000);
      await ctx.db
        .update(bookFiles)
        .set({ durationSeconds: Math.round(probe!.durationMs / 1000) })
        .where(eq(bookFiles.id, file.id));
    }
    const rounded = exact.map(Math.round);
    const plain = rounded.map((_, i) => rounded.slice(0, i).reduce((sum, value) => sum + value, 0));
    const exactStarts = exact.map((_, i) => exact.slice(0, i).reduce((sum, value) => sum + value, 0));
    return { libraryId, bookId, folder, files, exact, plain, exactStarts };
  }

  async function setStoredChapters(bookId: number, chapters: { title: string; startMs: number }[], title = 'Book') {
    await ctx.db
      .insert(bookMetadata)
      .values({ bookId, title, chapters, chaptersSource: 'manual' })
      .onConflictDoUpdate({ target: bookMetadata.bookId, set: { title, chapters, chaptersSource: 'manual' } });
  }

  async function settings(patch: object) {
    const response = await api('PATCH', 'settings', patch);
    expect(response.statusCode).toBe(200);
  }

  async function convertNow(bookId: number): Promise<AudioConvertJobRow> {
    const started = await api('POST', `books/${bookId}/convert`, {});
    expect(started.statusCode).toBe(200);
    await ctx.app.get(AudioConvertQueueService).tick();
    return jobRow(started.json().id);
  }

  const longAgo = new Date(Date.now() - 60 * 60_000);

  it(
    'joins a multi-part book on the stored timeline: progress, bookmarks, chapters, reading progress and other references',
    async () => {
      // 3.6 s parts store as 4 s, so each stored start drifts further from the exact one.
      const tracks = Array.from({ length: 6 }, (_, i) => [`Book ${String(i + 1).padStart(2, '0')}.mp3`, 3.6] as const);
      const { bookId, folder, files, plain, exactStarts, exact } = await makeBook('multi', 'Author/Book', tracks);
      expect(plain).toEqual([0, 4, 8, 12, 16, 20]);
      // Stored chapters within 2 s of some file starts: the snapped play order would move those starts
      // to 6 and 12.5, which is not where players or the manifest put a book position.
      await setStoredChapters(bookId, [
        { title: 'One', startMs: 0 },
        { title: 'Two', startMs: 6000 },
        { title: 'Three', startMs: 12_500 },
        { title: 'Four', startMs: 18_000 },
      ]);

      await ctx.db.insert(audiobookProgress).values({
        userId: adminId,
        bookId,
        currentFileId: files[1]!.id,
        positionSeconds: 1,
        percentage: 40,
        capturedAt: longAgo,
        updatedAt: longAgo,
      });
      const marks = await ctx.db
        .insert(bookmarks)
        .values([
          { userId: adminId, bookId, bookFileId: files[2]!.id, title: 'Mark', positionSeconds: 9 },
          // Both clamp to the exact end of the first part: they must not collide on the unique index.
          { userId: adminId, bookId, bookFileId: files[0]!.id, title: 'End A', positionSeconds: 3.7 },
          { userId: adminId, bookId, bookFileId: files[0]!.id, title: 'End B', positionSeconds: 3.9 },
        ])
        .returning();
      const older = new Date(Date.now() - 2 * 60 * 60_000);
      await ctx.db.insert(readingProgress).values([
        { bookFileId: files[0]!.id, userId: adminId, percentage: 5, positionSeconds: 1, lastReadAt: older, updatedAt: older },
        { bookFileId: files[2]!.id, userId: adminId, percentage: 30, positionSeconds: 2, lastReadAt: longAgo, updatedAt: longAgo },
      ]);
      // Re-pointing these collides on (user, file): the merged row goes with its file instead of failing the swap.
      await ctx.db.insert(readerPreferences).values([
        { userId: adminId, bookFileId: files[0]!.id, settings: { kept: true } },
        { userId: adminId, bookFileId: files[1]!.id, settings: { kept: false } },
      ]);

      await settings({ enabled: true, backupDays: 14, embedChapters: true, codec: 'auto', bitrate: '96k', channels: null });
      const plan = await api('GET', `books/${bookId}/convert`);
      expect(plan.json()).toMatchObject({
        status: 'can_convert',
        autoCodec: 'copy',
        listenersWithProgress: 1,
        bookmarkCount: 3,
        outputName: 'Book.m4b',
      });

      const job = await convertNow(bookId);
      expect(job.errorMessage ?? null).toBeNull();
      expect(job).toMatchObject({ status: 'success', codecUsed: 'copy', bitrate: '96k' });

      const after = await ctx.db.select().from(bookFiles).where(eq(bookFiles.bookId, bookId));
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ id: files[0]!.id, format: 'm4b', absolutePath: join(folder, 'Book.m4b'), relPath: 'Author/Book/Book.m4b' });
      expect((await readdir(folder)).sort()).toEqual(['Book.m4b']);

      const [progress] = await ctx.db
        .select()
        .from(audiobookProgress)
        .where(and(eq(audiobookProgress.userId, adminId), eq(audiobookProgress.bookId, bookId)));
      expect(progress!.currentFileId).toBe(files[0]!.id);
      expect(progress!.positionSeconds).toBeCloseTo(exactStarts[1]! + 1, 2);

      const moved = await ctx.db
        .select()
        .from(bookmarks)
        .where(
          inArray(
            bookmarks.id,
            marks.map((mark) => mark.id),
          ),
        );
      const byTitle = new Map(moved.map((mark) => [mark.title, mark]));
      // Stored 9 s is part 3 at 1 s (plain timeline), not part 2 at 3 s (snapped timeline).
      expect(byTitle.get('Mark')!.positionSeconds).toBeCloseTo(exactStarts[2]! + 1, 2);
      expect(byTitle.get('Mark')!.bookFileId).toBe(files[0]!.id);
      const ends = [byTitle.get('End A')!.positionSeconds!, byTitle.get('End B')!.positionSeconds!].sort();
      expect(ends[0]).toBeCloseTo(exact[0]!, 2);
      expect(ends[1]).toBeGreaterThan(ends[0]!);

      const [meta] = await ctx.db.select({ chapters: bookMetadata.chapters }).from(bookMetadata).where(eq(bookMetadata.bookId, bookId));
      const starts = (meta!.chapters as { startMs: number }[]).map((chapter) => chapter.startMs);
      // 6 s is part 2 at 2 s; 12.5 s is part 4 at 0.5 s; 18 s is part 5 at 2 s.
      const expected = [0, exactStarts[1]! + 2, exactStarts[3]! + 0.5, exactStarts[4]! + 2].map((s) => Math.round(s * 1000));
      expect(starts).toHaveLength(4);
      starts.forEach((value, i) => expect(Math.abs(value - expected[i]!)).toBeLessThanOrEqual(1));
      const out = ffprobeJson(join(folder, 'Book.m4b'));
      expect(out.chapters).toHaveLength(4);

      const reading = await ctx.db.select().from(readingProgress).where(eq(readingProgress.userId, adminId));
      const forBook = reading.filter((row) => files.some((file) => file.id === row.bookFileId));
      expect(forBook).toHaveLength(1);
      expect(forBook[0]!.bookFileId).toBe(files[0]!.id);
      expect(forBook[0]!.percentage).toBe(30);
      expect(forBook[0]!.positionSeconds).toBeCloseTo(exactStarts[2]! + 2, 2);

      const prefs = await ctx.db.select().from(readerPreferences).where(eq(readerPreferences.bookFileId, files[0]!.id));
      expect(prefs).toHaveLength(1);
      expect(prefs[0]!.settings).toEqual({ kept: true });

      expect(job.backupPath).toBeTruthy();
      expect((await readdir(job.backupPath!)).filter((name) => name.endsWith('.mp3'))).toHaveLength(6);
      expect(job.workPaths).toMatchObject({ phase: 'committed', finalPath: join(folder, 'Book.m4b') });

      // A restart after the commit but before the originals were removed: recovery removes them and
      // records the success with its backup.
      for (const file of files.slice(1)) await copyFile(join(job.backupPath!, file.absolutePath.split('/').pop()!), file.absolutePath);
      await ctx.db
        .update(audioConvertJobs)
        .set({ status: 'running', backupPath: null, finishedAt: null, errorCode: null })
        .where(eq(audioConvertJobs.id, job.id));
      await ctx.app.get(AudioConvertQueueService).recover();
      expect((await readdir(folder)).sort()).toEqual(['Book.m4b']);
      expect(await jobRow(job.id)).toMatchObject({ status: 'success', backupPath: job.backupPath });

      const preview = await api('GET', `libraries/${job.libraryId}/preview?status=converted`);
      expect(preview.json().items.map((item: { bookId: number }) => item.bookId)).toContain(bookId);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps a single VBR MP3 bit for bit with Copy and moves nothing on its timeline',
    async () => {
      const { bookId, folder, files } = await makeBook('single', 'Solo', [['Solo.mp3', 6]], 'vbr');
      const source = files[0]!.absolutePath;
      const fingerprint = await audioFingerprint(source, 'ffmpeg');
      const decoded = decodedMd5(source);
      // The first chapter is not at 0 and sits within 2 s of the start, which a snapped timeline would shift.
      const chapters = [
        { title: 'Opening', startMs: 1500 },
        { title: 'Middle', startMs: 3000 },
      ];
      await setStoredChapters(bookId, chapters, 'Solo Title');
      const [mark] = await ctx.db
        .insert(bookmarks)
        .values({ userId: adminId, bookId, bookFileId: files[0]!.id, title: 'Here', positionSeconds: 2.2 })
        .returning();
      await ctx.db.insert(audiobookProgress).values({
        userId: adminId,
        bookId,
        currentFileId: files[0]!.id,
        positionSeconds: 1.7,
        percentage: 20,
        capturedAt: longAgo,
        updatedAt: longAgo,
      });
      const cover = join(root, 'cover.jpg');
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', cover]);
      vi.spyOn(ctx.app.get(BookCoverStore), 'resolve').mockResolvedValue(cover);

      await settings({ enabled: true, backupDays: 0, embedChapters: true, embedMetadata: true, codec: 'copy' });
      const job = await convertNow(bookId);
      expect(job.errorMessage ?? null).toBeNull();
      expect(job).toMatchObject({ status: 'success', codecUsed: 'copy', backupPath: null });

      const output = join(folder, 'Solo.m4b');
      expect((await readdir(folder)).sort()).toEqual(['Solo.m4b']);
      expect(await audioFingerprint(output, 'ffmpeg')).toBe(fingerprint);
      expect(decodedMd5(output)).toBe(decoded);
      const probe = ffprobeJson(output);
      // The MP4 chapter track always starts its first chapter at 0; the rest keep their stored starts.
      expect(probe.chapters.map((chapter) => chapter.tags?.title)).toEqual(['Opening', 'Middle']);
      expect(Number(probe.chapters[1]!.start_time)).toBe(3);
      expect(probe.format.tags?.title).toBe('Solo Title');
      expect(probe.streams.some((stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic === 1)).toBe(true);

      const [meta] = await ctx.db.select({ chapters: bookMetadata.chapters }).from(bookMetadata).where(eq(bookMetadata.bookId, bookId));
      expect(meta!.chapters).toEqual(chapters);
      expect((await ctx.db.select().from(bookmarks).where(eq(bookmarks.id, mark!.id)))[0]!.positionSeconds).toBeCloseTo(2.2, 3);
      const [progress] = await ctx.db.select().from(audiobookProgress).where(eq(audiobookProgress.bookId, bookId));
      expect(progress!.positionSeconds).toBeCloseTo(1.7, 3);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'with chapters off, embeds none but still rebases the stored chapters',
    async () => {
      const tracks = [
        ['A 01.mp3', 3.6],
        ['A 02.mp3', 3.6],
      ] as const;
      const { bookId, folder, exactStarts } = await makeBook('nochapters', 'Quiet', tracks);
      await setStoredChapters(bookId, [
        { title: 'One', startMs: 0 },
        { title: 'Two', startMs: 5000 },
      ]);
      await settings({ enabled: true, backupDays: 0, embedChapters: false, codec: 'auto' });
      const job = await convertNow(bookId);
      expect(job.status).toBe('success');
      expect(ffprobeJson(join(folder, 'Quiet.m4b')).chapters).toHaveLength(0);
      const [meta] = await ctx.db.select({ chapters: bookMetadata.chapters }).from(bookMetadata).where(eq(bookMetadata.bookId, bookId));
      expect(Math.abs((meta!.chapters as { startMs: number }[])[1]!.startMs - Math.round((exactStarts[1]! + 1) * 1000))).toBeLessThanOrEqual(1);
      await settings({ embedChapters: true });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'names a joined book after its folder even when a later part already has that name',
    async () => {
      const { bookId, folder, files } = await makeBook(
        'samename',
        'Part Book',
        [
          ['A.m4a', 2],
          ['Part Book.m4b', 2],
        ],
        'aac',
      );
      expect(files.map((file) => file.format)).toEqual(['m4a', 'm4b']);
      await settings({ enabled: true, backupDays: 0, codec: 'auto' });
      const job = await convertNow(bookId);
      expect(job.errorMessage ?? null).toBeNull();
      expect(job.status).toBe('success');
      expect((await readdir(folder)).sort()).toEqual(['Part Book.m4b']);
      const after = await ctx.db.select().from(bookFiles).where(eq(bookFiles.bookId, bookId));
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ id: files[0]!.id, absolutePath: join(folder, 'Part Book.m4b') });
      // The overwritten part forced a backup even with backupDays 0.
      expect(job.backupPath).toBeTruthy();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'writes a multi-disc book into the book folder, named after it',
    async () => {
      const { bookId, folder, files } = await makeBook('discs', 'Disc Book', [
        ['CD1/01.mp3', 2],
        ['CD2/01.mp3', 2],
      ]);
      const [book] = await ctx.db.select({ folderPath: books.folderPath }).from(books).where(eq(books.id, bookId));
      expect(book!.folderPath).toBe(folder);
      expect((await api('GET', `books/${bookId}/convert`)).json().outputName).toBe('Disc Book.m4b');
      const job = await convertNow(bookId);
      expect(job.errorMessage ?? null).toBeNull();
      const [row] = await ctx.db.select().from(bookFiles).where(eq(bookFiles.id, files[0]!.id));
      expect(row!.absolutePath).toBe(join(folder, 'Disc Book.m4b'));
      expect(row!.relPath).toBe('Disc Book/Disc Book.m4b');
      await stat(join(folder, 'Disc Book.m4b'));
    },
    TEST_TIMEOUT_MS,
  );

  describe('swap checks', () => {
    async function queuedJob(bookId: number): Promise<AudioConvertJobRow> {
      const started = await api('POST', `books/${bookId}/convert`, {});
      expect(started.statusCode).toBe(200);
      return jobRow(started.json().id);
    }

    it(
      'encodes without the book lock, takes it for the swap, and refuses inputs that changed meanwhile',
      async () => {
        const { bookId, files, folder } = await makeBook('changed', 'Changed', [
          ['C 01.mp3', 2],
          ['C 02.mp3', 2],
        ]);
        await settings({ enabled: true, backupDays: 14 });
        const job = await queuedJob(bookId);
        const locks = ctx.app.get(FileLockService);
        const lockSeen: boolean[] = [];
        const converter = ctx.app.get(AudioConvertConverterService);
        const run = converter.convert(job, await repo().getSettings(), new AbortController().signal, {
          onProgress: () => lockSeen.push(locks.isLocked(bookOperationLockKey(bookId))),
          readyToSwap: async () => {
            expect(locks.isLocked(bookOperationLockKey(bookId))).toBe(true);
            // A tag editor rewrote a file while it was being encoded.
            await utimes(files[1]!.absolutePath, new Date(), new Date());
            return null;
          },
          enterSwap: () => true,
          onSwapping: () => Promise.resolve(),
        });
        await expect(run).rejects.toMatchObject({ code: 'files_changed' });
        expect(lockSeen.every((held) => !held)).toBe(true);
        expect((await readdir(folder)).sort()).toEqual(['C 01.mp3', 'C 02.mp3']);
        expect(await ctx.db.select().from(bookFiles).where(eq(bookFiles.bookId, bookId))).toHaveLength(2);
        await repo().cancelPendingJob(job.id);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'backs up before the swapping stage and deletes the backup when the job fails before the swap',
      async () => {
        const { bookId, folder } = await makeBook('backupfirst', 'Backup', [
          ['B 01.mp3', 2],
          ['B 02.mp3', 2],
        ]);
        await settings({ enabled: true, backupDays: 14 });
        const job = await queuedJob(bookId);
        let backupDir: string | undefined;
        const run = ctx.app.get(AudioConvertConverterService).convert(job, await repo().getSettings(), new AbortController().signal, {
          onProgress: () => undefined,
          readyToSwap: () => Promise.resolve(null),
          enterSwap: () => true,
          onSwapping: async () => {
            backupDir = (await jobRow(job.id)).workPaths?.backupPath;
            expect((await readdir(backupDir!)).filter((name) => name.endsWith('.mp3'))).toHaveLength(2);
            throw new ConvertError('swap_failed', 'database went away');
          },
        });
        await expect(run).rejects.toMatchObject({ code: 'swap_failed' });
        expect(backupDir).toBeTruthy();
        await expect(stat(backupDir!)).rejects.toThrow();
        expect((await readdir(folder)).sort()).toEqual(['B 01.mp3', 'B 02.mp3']);
        await repo().cancelPendingJob(job.id);
      },
      TEST_TIMEOUT_MS,
    );
  });

  it(
    'recovers a restart between the rename and the commit: removes only our file, restores an overwritten original',
    async () => {
      const { bookId, libraryId, folder, files } = await makeBook('crash', 'Crash', [
        ['K 01.mp3', 2],
        ['K 02.mp3', 2],
      ]);
      const originals = files.map((file) => file.absolutePath);
      const backup = join(process.env.APP_DATA_PATH!, 'audio-convert', 'backups', `${bookId}-crash`);
      await mkdir(backup, { recursive: true });
      const backupFiles: Record<string, string> = {};
      for (const path of originals) {
        backupFiles[path] = join(backup, path.split('/').pop()!);
        await copyFile(path, backupFiles[path]);
      }
      const originalHash = await computeFileHash(originals[1]!);

      // Case 1: the new file was renamed to a fresh name.
      const finalPath = join(folder, 'Crash.m4b');
      await writeAudio(finalPath, 1, 'aac', 550);
      const [first] = await ctx.db
        .insert(audioConvertJobs)
        .values({
          bookId,
          libraryId,
          trigger: 'manual',
          status: 'running',
          stage: 'swapping',
          workPaths: { phase: 'swapping', finalPath, newHash: await computeFileHash(finalPath), originals, backupPath: backup, backupFiles },
        })
        .returning();
      await ctx.app.get(AudioConvertQueueService).recover();
      expect((await readdir(folder)).sort()).toEqual(['K 01.mp3', 'K 02.mp3']);
      expect(await jobRow(first!.id)).toMatchObject({ status: 'failed', errorCode: 'interrupted' });
      await expect(stat(backup)).rejects.toThrow();

      // Case 2: the new file took the name of a later original, which the backup restores.
      await mkdir(backup, { recursive: true });
      for (const path of originals) await copyFile(path, backupFiles[path]!);
      await writeAudio(originals[1]!, 1, 'aac', 660);
      const newHash = await computeFileHash(originals[1]!);
      expect(newHash).not.toBe(originalHash);
      const [second] = await ctx.db
        .insert(audioConvertJobs)
        .values({
          bookId,
          libraryId,
          trigger: 'manual',
          status: 'running',
          stage: 'swapping',
          workPaths: { phase: 'swapping', finalPath: originals[1]!, newHash, originals, backupPath: backup, backupFiles },
        })
        .returning();
      await ctx.app.get(AudioConvertQueueService).recover();
      expect(await computeFileHash(originals[1]!)).toBe(originalHash);
      expect(await jobRow(second!.id)).toMatchObject({ status: 'failed', errorCode: 'interrupted' });

      // Case 3: crashed before the rename (the recorded hash is not on disk): nothing is touched.
      await writeFile(join(folder, '.bookorbit-convert-x.m4b'), 'partial');
      const [third] = await ctx.db
        .insert(audioConvertJobs)
        .values({
          bookId,
          libraryId,
          trigger: 'manual',
          status: 'running',
          stage: 'swapping',
          workPaths: {
            phase: 'swapping',
            finalPath: originals[0]!,
            newHash: 'f'.repeat(32),
            originals,
            tempOutput: join(folder, '.bookorbit-convert-x.m4b'),
          },
        })
        .returning();
      const before = await computeFileHash(originals[0]!);
      await ctx.app.get(AudioConvertQueueService).recover();
      expect(await computeFileHash(originals[0]!)).toBe(before);
      expect((await readdir(folder)).sort()).toEqual(['K 01.mp3', 'K 02.mp3']);
      expect((await jobRow(third!.id)).status).toBe('failed');
    },
    TEST_TIMEOUT_MS,
  );

  describe('jobs and library runs', () => {
    async function twoBookLibrary(name: string) {
      const libraryRoot = join(root, name);
      for (const title of ['Alpha', 'Beta']) await writeAudio(join(libraryRoot, title, `${title}.mp3`), 1);
      const { libraryId } = await seedLibrary(ctx.db, { rootPath: libraryRoot, mode: 'book_per_folder' });
      await triggerAndWaitForLibraryScan(ctx, libraryId);
      const rows = await ctx.db.select({ id: books.id, folderPath: books.folderPath }).from(books).where(eq(books.libraryId, libraryId));
      const byTitle = new Map<string, number>();
      for (const row of rows) {
        const title = row.folderPath.split('/').pop()!;
        byTitle.set(title, row.id);
        await setStoredChapters(row.id, [], `${title} Story`);
      }
      return { libraryId, alpha: byTitle.get('Alpha')!, beta: byTitle.get('Beta')! };
    }

    afterEach(async () => {
      await ctx.db.execute(sql`UPDATE audio_convert_jobs SET status = 'cancelled' WHERE status IN ('waiting', 'queued', 'running')`);
    });

    it('a run with a search queues only the books the preview lists for that search', async () => {
      const { libraryId, alpha } = await twoBookLibrary('search');
      await settings({ enabled: true });
      const preview = await api('GET', `libraries/${libraryId}/preview?search=alpha`);
      expect(preview.json().items.map((item: { bookId: number }) => item.bookId)).toEqual([alpha]);
      const run = await api('POST', `libraries/${libraryId}/run`, { search: 'alpha', excludeBookIds: [] });
      expect(run.statusCode).toBe(200);
      expect(run.json()).toEqual({ queued: 1, skipped: 0 });
      const jobs = await ctx.db.select().from(audioConvertJobs).where(eq(audioConvertJobs.libraryId, libraryId));
      expect(jobs.map((job) => job.bookId)).toEqual([alpha]);
    });

    it('respects content filters when choosing books', async () => {
      const { libraryId, alpha, beta } = await twoBookLibrary('filters');
      const [tag] = await ctx.db
        .insert(tags)
        .values({ name: `hidden-${libraryId}-${Date.now()}` })
        .returning();
      await ctx.db.insert(bookTags).values({ bookId: beta, tagId: tag!.id });
      const filters = { includeTagIds: [], includeGenreIds: [], excludeTagIds: [tag!.id], excludeGenreIds: [] };
      expect(await repo().convertibleBookIds(libraryId, { contentFilters: filters })).toEqual([alpha]);
      const page = await repo().preview(libraryId, { page: 1, pageSize: 50, contentFilters: filters });
      expect(page.items.map((item) => item.bookId)).toEqual([alpha]);
      expect((await repo().convertibleBookIds(libraryId)).sort()).toEqual([alpha, beta].sort());
    });

    it('Stop cancels queued jobs only and leaves books waiting in the pipeline', async () => {
      const { libraryId, alpha, beta } = await twoBookLibrary('stop');
      await repo().createJob({ bookId: alpha, libraryId, trigger: 'manual', status: 'queued', stage: 'ready' });
      const waiting = await repo().createJob({ bookId: beta, libraryId, trigger: 'auto', status: 'waiting', stage: 'metadata' });
      const stop = await api('POST', `libraries/${libraryId}/stop`);
      expect(stop.json()).toEqual({ cancelled: 1 });
      expect((await jobRow(waiting!.id)).status).toBe('waiting');
    });

    it('refuses convert-now while a chapter lookup holds the job, and allows it once the lease ran out', async () => {
      const { libraryId, alpha } = await twoBookLibrary('lookup');
      const job = await repo().createJob({
        bookId: alpha,
        libraryId,
        trigger: 'auto',
        status: 'waiting',
        stage: 'chapters',
        nextStepAt: new Date(Date.now() - 1000),
      });
      expect(await repo().claimChapterLookup(job!.id, new Date(Date.now() + 60_000))).toBe(true);
      expect(await repo().claimChapterLookup(job!.id, new Date(Date.now() + 60_000))).toBe(false);
      expect((await api('POST', `jobs/${job!.id}/convert-now`)).statusCode).toBe(409);
      await ctx.db
        .update(audioConvertJobs)
        .set({ nextStepAt: new Date(Date.now() - 1000) })
        .where(eq(audioConvertJobs.id, job!.id));
      const now = await api('POST', `jobs/${job!.id}/convert-now`);
      expect(now.statusCode).toBe(200);
      expect(now.json()).toMatchObject({ status: 'queued', stage: 'ready' });
    });

    it('claims the oldest due queued job once, and a recovery of an unstarted job fails it as interrupted', async () => {
      const { libraryId, alpha, beta } = await twoBookLibrary('claim');
      const later = await repo().createJob({
        bookId: beta,
        libraryId,
        trigger: 'manual',
        status: 'queued',
        stage: 'ready',
        nextStepAt: new Date(Date.now() + 60_000),
      });
      const due = await repo().createJob({ bookId: alpha, libraryId, trigger: 'manual', status: 'queued', stage: 'ready' });
      const claimed = await repo().claim();
      expect(claimed).toMatchObject({ id: due!.id, status: 'running', stage: 'converting', attempts: 1 });
      expect(await repo().claim()).toBeNull();
      expect((await jobRow(later!.id)).status).toBe('queued');
      await ctx.app.get(AudioConvertQueueService).recover();
      expect(await jobRow(due!.id)).toMatchObject({ status: 'failed', errorCode: 'interrupted' });
    });

    it('reports the saved encoder to any user and rejects null settings with a 400', async () => {
      await settings({ codec: 'aac', bitrate: '64k', channels: 1 });
      expect((await api('GET', 'enabled')).json()).toEqual({ enabled: true, encoder: { codec: 'aac', bitrate: '64k', channels: 1 } });
      expect((await api('PATCH', 'settings', { enabled: null })).statusCode).toBe(400);
      expect((await api('PATCH', 'settings', { backupDays: null })).statusCode).toBe(400);
      await settings({ codec: 'auto', bitrate: '128k', channels: null });
    });
  });
});
