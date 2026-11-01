import { audioToolsConfig } from '../../config/config';
import { audioFingerprint, chapterFingerprint } from './edition-sync-fingerprints';
vi.mock('./edition-sync-fingerprints', () => ({
  audioFingerprint: vi.fn().mockResolvedValue('a'.repeat(32)),
  chapterFingerprint: vi.fn().mockResolvedValue('b'.repeat(64)),
}));
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZipArchive } from 'archiver';
import * as unzipper from 'unzipper';
import { createWriteStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { chmod, stat, lstat, mkdtemp, mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { FileLockService } from '../../common/services/file-lock.service';
import { ScannerService } from '../scanner/scanner.service';
import { EditionSyncRepository } from './edition-sync.repository';
import { EditionSyncIndexStoreService } from './edition-sync-index-store.service';
import { EditionSyncSourcesChangedError } from './edition-sync-provenance';
import type { EditionSyncBookFileRef, EditionSyncCaptureInput } from './edition-sync.types';

const totals = {
  sentences: 10,
  matchedSentences: 9,
  interpolatedSentences: 1,
  unmatchedSentences: 0,
  droppedSentences: 0,
  seconds: 60,
  matchedSeconds: 58,
  interpolatedSeconds: 1,
  looseSeconds: 1,
  tracks: 1,
  unalignedTracks: 0,
};
async function zip(path: string, entries: Record<string, string>) {
  const archive = new ZipArchive();
  const done = pipeline(archive, createWriteStream(path));
  for (const [name, value] of Object.entries(entries)) archive.append(value, { name, store: name === 'mimetype' });
  await archive.finalize();
  await done;
}

describe('EditionSyncIndexStoreService', () => {
  let root: string;
  let service: EditionSyncIndexStoreService;
  let input: EditionSyncCaptureInput;
  let source: { bookId: number; libraryId: number; epub: EditionSyncBookFileRef; audio: EditionSyncBookFileRef[] };
  const repo = {
    findIndexSource: vi.fn(),
    findIndexRow: vi.fn(),
    findBookFilesByIds: vi.fn(),
    markStale: vi.fn(),
    updateIndexRow: vi.fn(),
    refreshProvenance: vi.fn().mockResolvedValue(true),
    flagRecheck: vi.fn(),
  };
  const scanner = { scanBookFolderAsync: vi.fn() };
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.mocked(audioFingerprint).mockResolvedValue('a'.repeat(32));
    vi.mocked(chapterFingerprint).mockResolvedValue('b'.repeat(64));
    repo.refreshProvenance.mockResolvedValue(true);
    root = await mkdtemp(join(tmpdir(), 'edition-sync-test-'));
    const workDir = join(root, 'work');
    await mkdir(join(workDir, 'processed-audio'), { recursive: true });
    const file = (id: number, format: string): EditionSyncBookFileRef => ({
      id,
      bookId: 7,
      absolutePath: join(root, `book.${format}`),
      format,
      role: 'content',
      sizeBytes: 100,
      fileHash: 'hash',
      mtime: new Date(1000),
      durationSeconds: 60,
      mediaOverlayAvailable: false,
    });
    source = { bookId: 7, libraryId: 3, epub: file(1, 'epub'), audio: [file(2, 'mp3')] };
    repo.findIndexSource.mockResolvedValue(source);
    repo.findBookFilesByIds.mockResolvedValue([source.epub, ...source.audio]);
    input = {
      bookId: 7,
      workDir,
      request: {
        epubPath: source.epub.absolutePath,
        audioPaths: [source.audio[0]!.absolutePath],
        language: 'en',
        granularity: 'sentence',
        model: 'quartznet15x5',
        decisions: { chapters: {}, audio: [] },
      },
      sources: { epub: source.epub, audio: source.audio },
      workerVersion: 'test',
    };
    await zip(source.epub.absolutePath, { mimetype: 'application/epub+zip' });
    await writeFile(source.audio[0]!.absolutePath, 'source audio');
    for (const file of [source.epub, ...source.audio]) {
      const info = await stat(file.absolutePath);
      file.sizeBytes = info.size;
      file.mtime = info.mtime;
    }
    await writeFile(join(workDir, 'report.json'), JSON.stringify({ version: 4, totals }));
    await writeFile(join(workDir, 'processed-audio', '00001.mp3'), 'audio');
    await writeFile(
      join(workDir, 'processed-audio', '00001.source.json'),
      JSON.stringify({ source: '0001.mp3', sourceSize: 100, start: 0, end: 60, title: null }),
    );
    await zip(join(workDir, 'output.epub'), {
      mimetype: 'application/epub+zip',
      'OPS/book.opf': '<package><manifest><item href="audio.mp3" media-type="audio/mpeg"/></manifest></package>',
      'OPS/audio.mp3': 'audio',
      'OPS/chapter.xhtml': '<p id="s1">Text</p>',
      'OPS/chapter.smil': '<smil/>',
      'OPS/image.png': 'image',
    });
    const module = await Test.createTestingModule({
      providers: [
        EditionSyncIndexStoreService,
        { provide: audioToolsConfig.KEY, useValue: { ffmpegPath: 'configured-ffmpeg' } },
        FileLockService,
        { provide: EditionSyncRepository, useValue: repo },
        { provide: ScannerService, useValue: scanner },
      ],
    }).compile();
    service = module.get(EditionSyncIndexStoreService);
  });
  afterEach(async () => {
    await chmod(root, 0o755);
    await rm(root, { recursive: true, force: true });
  });
  it.each(['metadata_only', 'content_changed', 'no_fingerprint', 'failed'])('content recheck handles %s', async (outcome) => {
    const capture = await service.capture(input);
    const previous = structuredClone(capture.provenance);
    await writeFile(source.audio[0]!.absolutePath, 'retagged audio');
    const info = await stat(source.audio[0]!.absolutePath);
    Object.assign(source.audio[0]!, { sizeBytes: info.size, mtime: info.mtime, fileHash: 'new-hash' });
    if (outcome === 'content_changed') vi.mocked(audioFingerprint).mockResolvedValue('c'.repeat(32));
    if (outcome === 'no_fingerprint') delete previous.audio[0]!.audioFingerprint;
    if (outcome === 'failed') vi.mocked(audioFingerprint).mockRejectedValue(new Error('ffmpeg failed'));
    const warn = vi.spyOn(service['logger'], 'warn');
    const log = vi.spyOn(service['logger'], 'log');
    const result = await service.checkContent(7, previous);
    if (outcome === 'failed') {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[edition_sync.content_check] [fail]'));
      expect(log.mock.calls.some(([message]) => String(message).includes('[edition_sync.content_check] [end]'))).toBe(false);
    }
    expect(result).toBe(outcome === 'metadata_only' ? 'metadata_only' : 'content_changed');
    if (outcome === 'metadata_only') {
      expect(repo.refreshProvenance).toHaveBeenCalledWith(
        7,
        previous,
        expect.objectContaining({
          audio: [expect.objectContaining({ fileHash: 'new-hash', audioFingerprint: 'a'.repeat(32), sizeBytes: info.size })],
        }),
        expect.any(Date),
      );
    } else expect(repo.refreshProvenance).not.toHaveBeenCalled();
  });

  it.each(['moved', 'missing', 'other', 'unchanged'])('handles a code-less hashing error with %s source stats', async (state) => {
    const captured = await service.capture(input);
    source.epub.fileHash = 'changed';
    vi.mocked(chapterFingerprint).mockImplementationOnce(async () => {
      if (state === 'moved') await utimes(source.epub.absolutePath, new Date(), new Date(Date.now() + 2000));
      if (state === 'other') await utimes(source.audio[0]!.absolutePath, new Date(), new Date(Date.now() + 2000));
      if (state === 'missing') await rm(source.epub.absolutePath);
      throw new Error('FILE_ENDED');
    });
    const warn = vi.spyOn(service['logger'], 'warn');
    const log = vi.spyOn(service['logger'], 'log');
    expect(await service.checkContent(7, captured.provenance)).toBe(state === 'unchanged' ? 'content_changed' : 'retry');
    expect(repo.markStale).not.toHaveBeenCalled();
    if (state === 'unchanged') expect(warn).toHaveBeenCalledWith(expect.stringContaining('[edition_sync.content_check] [fail]'));
    else {
      expect(warn).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('outcome=retry'));
    }
  });

  it.each(['before', 'during', 'after', 'catalog', 'capture', 'vanished'])('retries when %s moves during a content check', async (cause) => {
    const captured = await service.capture(input);
    const previous = structuredClone(captured.provenance);
    source.epub.fileHash = 'changed';
    if (cause === 'before') source.epub.sizeBytes!++;
    if (cause === 'during')
      vi.mocked(chapterFingerprint).mockImplementationOnce(async () => {
        await writeFile(source.epub.absolutePath, 'changed while hashing');
        return 'b'.repeat(64);
      });
    if (cause === 'after')
      vi.mocked(audioFingerprint).mockImplementationOnce(async () => {
        await writeFile(source.epub.absolutePath, 'changed later');
        return 'a'.repeat(32);
      });
    if (cause === 'after') source.audio[0]!.fileHash = 'changed';
    if (cause === 'catalog') repo.findBookFilesByIds.mockResolvedValue([source.epub, { ...source.audio[0], fileHash: 'moved' }]);
    if (cause === 'capture') repo.refreshProvenance.mockResolvedValue(false);
    if (cause === 'vanished') await rm(source.epub.absolutePath);
    expect(await service.checkContent(7, previous)).toBe('retry');
    expect(repo.markStale).not.toHaveBeenCalled();
  });

  it.each(['before', 'during', 'end', 'io'])('omits a fingerprint when capture source stat moves: %s', async (cause) => {
    if (cause === 'before') source.epub.sizeBytes!++;
    if (cause === 'io') await rm(source.audio[0]!.absolutePath);
    if (cause === 'during')
      vi.mocked(chapterFingerprint).mockImplementationOnce(async () => {
        await writeFile(source.audio[0]!.absolutePath, 'changed during capture');
        return 'b'.repeat(64);
      });
    if (cause === 'end')
      vi.mocked(audioFingerprint).mockImplementationOnce(async () => {
        await utimes(source.epub.absolutePath, new Date(), new Date(Date.now() + 2000));
        return 'a'.repeat(32);
      });
    const warn = vi.spyOn(service['logger'], 'warn');
    const captured = await service.capture(input);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /\[edition_sync\.fingerprint\] \[fail\] bookId=7 kind=(chapter|audio) path="[^"]+" durationMs=\d+ errorClass=\S+ error="[^"]+" - fingerprint skipped/,
      ),
    );
    if (cause === 'before' || cause === 'end') expect(warn).toHaveBeenCalledWith(expect.stringContaining('errorClass=InternalServerErrorException'));
    if (cause === 'before' || cause === 'end') expect(captured.provenance.epub).not.toHaveProperty('chapterFingerprint');
    else expect(captured.provenance.audio[0]).not.toHaveProperty('audioFingerprint');
  });

  it('defers a changed fingerprinted audio file even when another audio fingerprint is absent', async () => {
    const other = { ...source.audio[0]!, id: 3, absolutePath: join(root, 'other.mp3') };
    await writeFile(other.absolutePath, 'other audio');
    const info = await stat(other.absolutePath);
    Object.assign(other, { sizeBytes: info.size, mtime: info.mtime });
    source.audio.push(other);
    repo.findBookFilesByIds.mockResolvedValue([source.epub, ...source.audio]);
    vi.mocked(audioFingerprint).mockImplementation((path) => {
      if (path === other.absolutePath) return Promise.reject(new Error('cannot fingerprint other audio'));
      return Promise.resolve('a'.repeat(32));
    });
    const captured = await service.capture(input);
    repo.findIndexRow.mockResolvedValue({ status: 'ready', ...captured });
    repo.findBookFilesByIds.mockResolvedValue([source.epub, { ...source.audio[0], fileHash: 'changed' }, other]);
    expect(await service.verifyProvenance(7)).toEqual({ valid: false, reason: 'audio_changed' });
    expect(repo.flagRecheck).toHaveBeenCalledWith(7);
    expect(repo.markStale).not.toHaveBeenCalled();
  });

  it('ignores legacy textFingerprint provenance without treating it as chapter coverage', async () => {
    const captured = await service.capture(input);
    const old = structuredClone(captured.provenance);
    delete old.epub.chapterFingerprint;
    Object.assign(old.epub, { textFingerprint: 'old dev fingerprint' });
    await zip(captured.indexPath, { 'bookorbit-timings/provenance.json': JSON.stringify(old) });
    expect(await service.readProvenance(captured.indexPath)).not.toBeNull();
    source.epub.fileHash = 'changed';
    expect(await service.checkContent(7, old)).toBe('content_changed');
  });

  it('uses refreshed DB file metadata while preserving the zip capture snapshot', async () => {
    const captured = await service.capture(input);
    const refreshed = structuredClone(captured.provenance);
    refreshed.audio[0]!.fileHash = 'refreshed';
    repo.findIndexRow.mockResolvedValue({ status: 'ready', ...captured, provenance: refreshed });
    repo.findBookFilesByIds.mockResolvedValue([source.epub, { ...source.audio[0], fileHash: 'refreshed' }]);
    expect(await service.verifyProvenance(7)).toEqual({ valid: true });
    await service.copyIndex(7, join(root, 'copy.epub'));
    expect(await service.readProvenance(join(root, 'copy.epub'))).toEqual(captured.provenance);
    refreshed.audio[0]!.audioFingerprint = 'c'.repeat(32);
    expect(await service.verifyProvenance(7)).toEqual({ valid: false, reason: 'index_missing' });
  });

  it('fails closed when a newer change prevents the conditional provenance refresh', async () => {
    const captured = await service.capture(input);
    const previous = structuredClone(captured.provenance);
    source.epub.fileHash = 'new';
    repo.refreshProvenance.mockResolvedValue(false);
    expect(await service.checkContent(7, previous)).toBe('retry');
    expect(repo.refreshProvenance).toHaveBeenCalled();
  });

  it('streams an audioless EPUB, preserving markup and embedding report/provenance', async () => {
    const captured = await service.capture(input);
    const archive = await unzipper.Open.file(captured.indexPath);
    expect(archive.files.map((entry) => entry.path)).toEqual([
      'mimetype',
      'OPS/book.opf',
      'OPS/chapter.xhtml',
      'OPS/chapter.smil',
      'OPS/image.png',
      'bookorbit-timings/provenance.json',
      'bookorbit-timings/report.json',
    ]);
    expect((await archive.files[1]!.buffer()).toString()).toContain('audio.mp3');
    expect(captured.provenance.audioEntries).toEqual([{ href: 'OPS/audio.mp3', chunk: '00001.mp3', size: 5 }]);
    expect(captured.provenance.sources[0]?.source).toBe('0001.mp3');
    expect(captured.provenance.sources[0]?.name).toBe('00001.mp3');
    expect(scanner.scanBookFolderAsync).toHaveBeenCalledWith(captured.indexPath, 3);
    expect((await readFile(captured.indexPath)).readUInt16LE(8)).toBe(0);
    expect(await service.readProvenance(captured.indexPath)).toEqual(captured.provenance);
  });
  it('keeps the capture when a fingerprint cannot be computed', async () => {
    vi.mocked(audioFingerprint).mockRejectedValue(new Error('ffmpeg failed'));
    const captured = await service.capture(input);
    expect(captured.provenance.audio[0]).not.toHaveProperty('audioFingerprint');
    expect(captured.provenance.chunks[0]).toBeDefined();
    expect(captured.provenance.chunks[0]).not.toHaveProperty('audioMd5');
    expect(captured.provenance.epub.chapterFingerprint).toBe('b'.repeat(64));
  });
  it('drops only identical image and font assets and reads old provenance', async () => {
    const assets = { 'OPS/image.png': 'image', 'OPS/font.WOFF2': 'font', 'OPS/changed.jpg': 'first', 'OPS/style.css': 'style' };
    await zip(source.epub.absolutePath, { mimetype: 'application/epub+zip', ...assets });
    const sourceInfo = await stat(source.epub.absolutePath);
    source.epub.sizeBytes = sourceInfo.size;
    source.epub.mtime = sourceInfo.mtime;
    await zip(join(input.workDir, 'output.epub'), {
      mimetype: 'application/epub+zip',
      ...assets,
      'OPS/changed.jpg': 'other',
      'OPS/audio.mp3': 'audio',
    });
    const captured = await service.capture(input);
    const original = await unzipper.Open.file(source.epub.absolutePath);
    expect(captured.provenance.sourceEntries).toEqual(
      ['OPS/image.png', 'OPS/font.WOFF2'].map((href) => {
        const entry = original.files.find((entry) => entry.path === href)!;
        return { href, size: entry.uncompressedSize, crc32: entry.crc32, position: 1 };
      }),
    );
    const archive = await unzipper.Open.file(captured.indexPath);
    expect(archive.files.map((entry) => entry.path)).toEqual([
      'mimetype',
      'OPS/changed.jpg',
      'OPS/style.css',
      'bookorbit-timings/provenance.json',
      'bookorbit-timings/report.json',
    ]);
    const old = { ...captured.provenance };
    delete old.sourceEntries;
    await zip(captured.indexPath, { 'bookorbit-timings/provenance.json': JSON.stringify(old) });
    expect(await service.readProvenance(captured.indexPath)).toEqual(old);
  });
  it('does not overwrite foreign files and reuses only its own filename', async () => {
    const original = join(root, 'book.bookorbit-timings');
    await writeFile(original, 'foreign');
    const first = await service.capture(input);
    const second = await service.capture(input);
    expect(first.indexPath).toBe(join(root, 'book-2.bookorbit-timings'));
    expect(second.indexPath).toBe(first.indexPath);
    expect(await readFile(original, 'utf8')).toBe('foreign');
  });
  it('invalidates missing indexes and changed sources, and permits reordered JSON object keys', async () => {
    const captured = await service.capture(input);
    repo.findIndexRow.mockResolvedValue({ status: 'ready', ...captured, provenance: { ...captured.provenance, version: 1 } });
    expect(await service.verifyProvenance(7)).toEqual({ valid: true });
    repo.findBookFilesByIds.mockResolvedValue([source.epub, { ...source.audio[0], fileHash: 'changed' }]);
    expect(await service.verifyProvenance(7)).toEqual({ valid: false, reason: 'audio_changed' });
    await rm(captured.indexPath);
    expect(await service.verifyProvenance(7)).toEqual({ valid: false, reason: 'index_missing' });
  });
  it('rejects changed audio before writing an index', async () => {
    repo.findBookFilesByIds.mockResolvedValue([source.epub, { ...source.audio[0], mtime: new Date(2000) }]);
    await expect(service.capture(input)).rejects.toEqual(new EditionSyncSourcesChangedError('audio_changed'));
    expect((await readdir(root)).filter((name) => name.endsWith('.bookorbit-timings'))).toEqual([]);
  });
  it('records the snapshot paths when current rows have been renamed', async () => {
    repo.findBookFilesByIds.mockResolvedValue([source.epub, { ...source.audio[0], absolutePath: '/renamed.mp3' }]);
    const captured = await service.capture(input);
    expect(captured.provenance.audio[0]?.path).toBe(source.audio[0]!.absolutePath);
    expect(captured.provenance.model).toBe(input.request.model);
  });
  it('keeps the source EPUB audio as content', async () => {
    await zip(source.epub.absolutePath, { mimetype: 'application/epub+zip', 'OPS/clip.mp3': 'clip' });
    const info = await stat(source.epub.absolutePath);
    source.epub.sizeBytes = info.size;
    source.epub.mtime = info.mtime;
    await zip(join(input.workDir, 'output.epub'), {
      mimetype: 'application/epub+zip',
      'OPS/audio.mp3': 'audio',
      'OPS/clip.mp3': 'clip',
    });
    const captured = await service.capture(input);
    const archive = await unzipper.Open.file(captured.indexPath);
    expect(archive.files.some((entry) => entry.path === 'OPS/clip.mp3')).toBe(true);
    expect(captured.provenance.audioEntries.map((entry) => entry.href)).toEqual(['OPS/audio.mp3']);
  });
  it('follows an index file id after a rename', async () => {
    const captured = await service.capture(input);
    const renamed = join(root, 'renamed.bookorbit-timings');
    const { rename } = await import('node:fs/promises');
    await rename(captured.indexPath, renamed);
    repo.findIndexRow.mockResolvedValue({ status: 'ready', ...captured, indexFileId: 9 });
    repo.findBookFilesByIds.mockImplementation((ids: number[]) =>
      Promise.resolve(ids[0] === 9 ? [{ ...source.epub, id: 9, absolutePath: renamed }] : [source.epub, ...source.audio]),
    );
    expect(await service.verifyProvenance(7)).toEqual({ valid: true });
    expect(repo.updateIndexRow).toHaveBeenCalledWith(7, { indexPath: renamed });
    await rm(renamed);
    expect(await service.verifyProvenance(7)).toEqual({ valid: false, reason: 'index_missing' });
  });
  it('removes only superseded files belonging to this book', async () => {
    const captured = await service.capture(input);
    await service.removeSupersededIndex(8, captured.indexPath, '/new');
    expect(await service.readProvenance(captured.indexPath)).not.toBeNull();
    await service.removeSupersededIndex(7, captured.indexPath, '/new');
    expect(await service.readProvenance(captured.indexPath)).toBeNull();
  });
  it.skipIf(process.getuid?.() === 0)(
    'fails instead of hanging when the index folder is not writable',
    async () => {
      await zip(join(input.workDir, 'output.epub'), {
        mimetype: 'application/epub+zip',
        'OPS/book.opf': '<package><manifest><item href="audio.mp3" media-type="audio/mpeg"/></manifest></package>',
        'OPS/audio.mp3': 'audio',
        'OPS/large.bin': randomBytes(8 * 1024 * 1024).toString('base64'),
        'OPS/chapter.xhtml': '<p id="s1">Text</p>',
      });
      await chmod(root, 0o555);
      await expect(service.capture(input)).rejects.toMatchObject({ code: 'EACCES' });
      await expect(service.capture(input)).rejects.toMatchObject({ code: 'EACCES' });
    },
    30_000,
  );
  it('copies an index over a destination link without following it', async () => {
    const captured = await service.capture(input);
    repo.findIndexRow.mockResolvedValue({ status: 'ready', ...captured });
    const victim = join(root, 'victim.txt');
    const destination = join(input.workDir, 'index.epub');
    await writeFile(victim, 'keep');
    await symlink(victim, destination);
    await service.copyIndex(7, destination);
    expect(await readFile(victim, 'utf8')).toBe('keep');
    expect((await lstat(destination)).isFile()).toBe(true);
    expect(await service.readProvenance(destination)).toEqual(captured.provenance);
  });
  it('refuses worker files that were replaced by links', async () => {
    const report = join(input.workDir, 'report.json');
    const elsewhere = join(root, 'elsewhere.json');
    await writeFile(elsewhere, await readFile(report));
    await rm(report);
    await symlink(elsewhere, report);
    await expect(service.capture(input)).rejects.toThrow();
    await rm(report);
    await writeFile(report, await readFile(elsewhere));
    const chunk = join(input.workDir, 'processed-audio', '00001.mp3');
    await rm(chunk);
    await writeFile(join(root, 'chunk.mp3'), 'audio');
    await symlink(join(root, 'chunk.mp3'), chunk);
    await expect(service.capture(input)).rejects.toThrow();
    expect((await readdir(root)).filter((name) => name.endsWith('.bookorbit-timings'))).toEqual([]);
  });
  it('removes an index file of this book without consulting the index row', async () => {
    const captured = await service.capture(input);
    const foreign = join(root, 'foreign.bookorbit-timings');
    await writeFile(foreign, 'foreign');
    expect(await service.removeIndexFile(7, foreign)).toBe(0);
    expect(await service.removeIndexFile(8, captured.indexPath)).toBe(0);
    expect(await service.removeIndexFile(7, join(root, 'missing.bookorbit-timings'))).toBe(0);
    expect(await service.removeIndexFile(7, captured.indexPath)).toBe(captured.indexBytes);
    expect(await readFile(foreign, 'utf8')).toBe('foreign');
    await expect(lstat(captured.indexPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(scanner.scanBookFolderAsync).toHaveBeenLastCalledWith(captured.indexPath, 3);
    expect(repo.findIndexRow).not.toHaveBeenCalled();
  });
});
