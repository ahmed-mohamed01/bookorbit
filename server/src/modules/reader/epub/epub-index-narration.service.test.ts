vi.mock('./epub-index-narration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./epub-index-narration')>();
  return {
    ...actual,
    buildIndexNarration: vi.fn(actual.buildIndexNarration),
    readIndexProvenance: vi.fn(actual.readIndexProvenance),
  };
});

import { InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ZipArchive } from 'archiver';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import type { EpubBookInfo } from '@bookorbit/types';
import { readStream } from '../../../common/test-utils/read-stream';
import type { RequestUser } from '../../../common/types/request-user';
import { BookReadService } from '../../book/book-read.service';
import { OVERLAY_SOURCE_RESOLVER } from '../../book/overlay-source-provider';
import { LibraryService } from '../../library/library.service';
import { buildIndexNarration, readIndexProvenance } from './epub-index-narration';
import { EpubIndexNarrationService, FAILED_INDEX_BUILD_TTL_MS, type IndexNarrationRequest } from './epub-index-narration.service';
import { EpubMediaStreamService } from './epub-media-stream.service';
import { EpubService } from './epub.service';

const mockBuild = vi.mocked(buildIndexNarration);
const mockProvenance = vi.mocked(readIndexProvenance);

async function zip(path: string, entries: Record<string, string>) {
  const archive = new ZipArchive();
  const done = pipeline(archive, createWriteStream(path));
  for (const [name, value] of Object.entries(entries)) archive.append(value, { name, store: name === 'mimetype' });
  await archive.finalize();
  await done;
}

const CONTAINER = `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;

const opf = (overlay: boolean) => `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata/>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"${overlay ? ' media-overlay="ch1-smil"' : ''}/>
    ${overlay ? '<item id="ch1-smil" href="ch1.smil" media-type="application/smil+xml"/><item id="a1" href="Audio/00001.mp4" media-type="audio/mp4"/>' : ''}
  </manifest>
  <spine><itemref idref="ch1"/></spine>
</package>`;

const PLAIN_CH1 = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>It was dark. The rain fell.</p></body></html>`;
const INDEX_CH1 = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p><span id="s1">It was dark.</span> <span id="s2">The rain fell.</span></p></body></html>`;
const SMIL = `<?xml version="1.0"?>
<smil xmlns="http://www.w3.org/ns/SMIL" version="3.0"><body>
  <par><text src="ch1.xhtml#s1"/><audio src="Audio/00001.mp4" clipBegin="1s" clipEnd="2s"/></par>
  <par><text src="ch1.xhtml#s2"/><audio src="Audio/00001.mp4" clipBegin="2s" clipEnd="4s"/></par>
</body></smil>`;

const provenance = (epubFileId: number) => ({
  version: 1,
  bookId: 7,
  epub: { bookFileId: epubFileId },
  audio: [{ bookFileId: 31, order: 0 }],
  sources: [{ name: '00001.mp4', source: '0001.m4b', start: 100, end: 200 }],
  audioEntries: [{ href: 'OEBPS/Audio/00001.mp4', chunk: '00001.mp4', size: 1 }],
});

const user = { id: 5, isSuperuser: false } as RequestUser;

describe('EpubIndexNarrationService', () => {
  let root: string;
  let plainPath: string;
  let indexPath: string;
  let audioPath: string;
  let service: EpubService;
  let narration: EpubIndexNarrationService;
  let files: Array<Record<string, unknown>>;
  const bookReadService = {
    findLibraryIdByBookId: vi.fn(),
    findFileById: vi.fn(),
    findPrimaryFilesByBookIds: vi.fn(),
    findAudioEbookProgressSyncFiles: vi.fn(),
  };
  const libraryService = { verifyUserAccess: vi.fn() };
  const resolver = { resolveOverlaySource: vi.fn() };

  async function compile(withResolver = true) {
    const module = await Test.createTestingModule({
      providers: [
        EpubService,
        EpubMediaStreamService,
        EpubIndexNarrationService,
        { provide: BookReadService, useValue: bookReadService },
        { provide: LibraryService, useValue: libraryService },
        ...(withResolver ? [{ provide: OVERLAY_SOURCE_RESOLVER, useValue: resolver }] : []),
      ],
    }).compile();
    service = module.get(EpubService);
    narration = module.get(EpubIndexNarrationService);
  }

  const plainInfo = (overlay = false) => ({ spine: [], manifest: overlay ? [{ mediaOverlay: 'ch1-smil' }] : [] }) as unknown as EpubBookInfo;
  const request = (overlay = false, mtime = 1): IndexNarrationRequest => ({ bookId: 7, fileId: 12, epub: { info: plainInfo(overlay), mtime }, user });
  const settle = () => Promise.allSettled(mockBuild.mock.results.map((result) => result.value as Promise<unknown>));

  beforeEach(async () => {
    vi.clearAllMocks();
    const actual = await vi.importActual<typeof import('./epub-index-narration')>('./epub-index-narration');
    mockBuild.mockReset();
    mockBuild.mockImplementation(actual.buildIndexNarration);
    mockProvenance.mockReset();
    mockProvenance.mockImplementation(actual.readIndexProvenance);
    root = await mkdtemp(join(tmpdir(), 'index-narration-service-'));
    plainPath = join(root, 'book.epub');
    indexPath = join(root, 'book.bookorbit-timings');
    audioPath = join(root, 'part1.m4b');
    await zip(plainPath, {
      mimetype: 'application/epub+zip',
      'META-INF/container.xml': CONTAINER,
      'OEBPS/content.opf': opf(false),
      'OEBPS/ch1.xhtml': PLAIN_CH1,
    });
    await zip(indexPath, {
      mimetype: 'application/epub+zip',
      'META-INF/container.xml': CONTAINER,
      'OEBPS/content.opf': opf(true),
      'OEBPS/ch1.xhtml': INDEX_CH1,
      'OEBPS/ch1.smil': SMIL,
      'bookorbit-timings/provenance.json': JSON.stringify(provenance(12)),
    });
    await writeFile(audioPath, Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)));
    files = [
      { id: 12, absolutePath: plainPath, format: 'epub', role: 'content', mediaOverlayAvailable: false },
      { id: 31, absolutePath: audioPath, format: 'm4b', role: 'content', mediaOverlayAvailable: false },
      { id: 90, absolutePath: indexPath, format: 'bookorbit-timings', role: 'extra', mediaOverlayAvailable: false },
    ];
    bookReadService.findLibraryIdByBookId.mockResolvedValue(3);
    bookReadService.findFileById.mockResolvedValue({ id: 12, bookId: 7, format: 'epub', absolutePath: plainPath });
    bookReadService.findAudioEbookProgressSyncFiles.mockImplementation(() => Promise.resolve({ primaryFileId: 12, files }));
    libraryService.verifyUserAccess.mockResolvedValue(undefined);
    resolver.resolveOverlaySource.mockImplementation((_userId: number, _bookId: number, candidates: Array<{ id: number }>) =>
      Promise.resolve(candidates.find((file) => file.id === 90) ?? null),
    );
    await compile();
  });

  afterEach(async () => {
    vi.useRealTimers();
    // Background builds read the index, so they finish before it is removed.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await Promise.allSettled(mockBuild.mock.results.map((result) => result.value as Promise<unknown>));
    await rm(root, { recursive: true, force: true });
  });

  describe('gates', () => {
    it('reads along a plain EPUB whose book has an audiobook and a timing index for it', async () => {
      expect(await narration.readsAlong(request())).toBe(true);
    });

    it('stays off for an EPUB with its own media overlay', async () => {
      expect(await narration.readsAlong(request(true))).toBe(false);
      expect(bookReadService.findAudioEbookProgressSyncFiles).not.toHaveBeenCalled();
    });

    it('stays off when a content sibling EPUB reads along', async () => {
      files.push({ id: 13, absolutePath: '/x.epub', format: 'epub', role: 'content', mediaOverlayAvailable: true });
      expect(await narration.readsAlong(request())).toBe(false);
    });

    it('is not blocked by a read-along EPUB that is not a content file', async () => {
      files.push({ id: 13, absolutePath: '/x.epub', format: 'epub', role: 'extra', mediaOverlayAvailable: true });
      expect(await narration.readsAlong(request())).toBe(true);
    });

    it('stays off with no content audiobook file', async () => {
      files[1]!.role = 'extra';
      expect(await narration.readsAlong(request())).toBe(false);
      expect(resolver.resolveOverlaySource).not.toHaveBeenCalled();
    });

    it('stays off when the overlay source is not a timing index', async () => {
      resolver.resolveOverlaySource.mockResolvedValue({ ...files[0], format: 'epub' });
      expect(await narration.readsAlong(request())).toBe(false);
    });

    it('stays off when the index was made from another EPUB', async () => {
      expect(await narration.readsAlong({ ...request(), fileId: 13 })).toBe(false);
    });

    it('stays off with no overlay source resolver', async () => {
      await compile(false);
      expect(await narration.readsAlong(request())).toBe(false);
    });
  });

  describe('book info', () => {
    it('flags the EPUB without waiting for the playlist to build', async () => {
      let finish: (value: null) => void = () => undefined;
      mockBuild.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
      const info = await service.getBookInfo(7, 12, user);
      expect(info.timingIndexNarration).toBe(true);
      await vi.waitFor(() => expect(mockBuild).toHaveBeenCalledTimes(1));
      finish(null);
    });

    it('logs a failed background build instead of leaving it unhandled', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      mockBuild.mockRejectedValueOnce(new Error('corrupt "index"'));
      expect((await service.getBookInfo(7, 12, user)).timingIndexNarration).toBe(true);
      await vi.waitFor(() => expect(warn).toHaveBeenCalled());
      expect(warn.mock.calls[0]![0]).toMatch(
        /^\[epub\.index_narration\] \[fail\] bookId=7 fileId=12 userId=5 durationMs=\d+ errorClass=Error error="corrupt \\"index\\""/,
      );
    });
  });

  describe('provenance and build cache', () => {
    it('reads the provenance once per index version, and not at all once a build exists', async () => {
      expect(await narration.readsAlong(request())).toBe(true);
      expect(await narration.readsAlong(request())).toBe(true);
      expect(mockProvenance).toHaveBeenCalledTimes(1);
      await service.streamFile(7, 'bookorbit-audio/31.m4b', 12, {}, user);
      expect(mockProvenance).toHaveBeenCalledTimes(1);
      await utimes(indexPath, new Date(), new Date(Date.now() + 5000));
      await service.streamFile(7, 'bookorbit-audio/31.m4b', 12, {}, user);
      expect(mockProvenance).toHaveBeenCalledTimes(2);
    });

    it('stops claiming read along once the build finds none', async () => {
      mockBuild.mockResolvedValueOnce(null);
      expect(await narration.readsAlong(request())).toBe(true);
      await settle();
      expect(await narration.readsAlong(request())).toBe(false);
    });

    it('stops claiming read along while a failed build is remembered', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      mockBuild.mockRejectedValueOnce(new Error('corrupt'));
      expect(await narration.readsAlong(request())).toBe(true);
      await settle();
      expect(await narration.readsAlong(request())).toBe(false);
      vi.advanceTimersByTime(FAILED_INDEX_BUILD_TTL_MS + 1);
      expect(await narration.readsAlong(request())).toBe(true);
    });

    it('keeps the most recently used builds', async () => {
      mockBuild.mockImplementation(() => Promise.resolve(null));
      for (let mtime = 1; mtime <= 8; mtime++) await narration.playlist(request(false, mtime));
      await narration.playlist(request(false, 1));
      await narration.playlist(request(false, 9));
      expect(mockBuild).toHaveBeenCalledTimes(9);
      await narration.playlist(request(false, 1));
      expect(mockBuild).toHaveBeenCalledTimes(9);
      await narration.playlist(request(false, 2));
      expect(mockBuild).toHaveBeenCalledTimes(10);
    });

    it('builds again when an audiobook file moves', async () => {
      await narration.playlist(request());
      const moved = join(root, 'moved.m4b');
      await copyFile(audioPath, moved);
      files[1]!.absolutePath = moved;
      await narration.playlist(request());
      expect(mockBuild).toHaveBeenCalledTimes(2);
    });

    it('logs nothing as failed while the index is missing', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      await rm(indexPath);
      expect(await narration.playlist(request())).toBeNull();
      expect(await narration.playlist(request())).toBeNull();
      expect(await narration.readsAlong(request())).toBe(false);
      expect(warn).not.toHaveBeenCalled();
      expect(mockBuild).not.toHaveBeenCalled();
    });
  });

  describe('playlist', () => {
    it('gives the reader the timing index playlist when the EPUB has none', async () => {
      const playlist = await service.getMediaOverlayPlaylist(7, 12, user, { narrationFallback: true });
      expect(playlist.source).toBe('timing-index');
      expect(playlist.items.map((item) => [item.textFragment, item.audioHref, item.clipBeginSeconds])).toEqual([
        ['s1', 'bookorbit-audio/31.m4b', 101],
        ['s2', 'bookorbit-audio/31.m4b', 102],
      ]);
    });

    it('gives every other caller, Watch included, only the EPUB own overlay', async () => {
      const playlist = await service.getMediaOverlayPlaylist(7, 12, user);
      expect(playlist.items).toEqual([]);
      expect(playlist.source).toBeUndefined();
      expect(bookReadService.findAudioEbookProgressSyncFiles).not.toHaveBeenCalled();
    });

    it('keeps a failed build for a short while before trying again', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      mockBuild.mockRejectedValueOnce(new Error('corrupt'));
      expect(await narration.playlist(request())).toBeNull();
      expect(await narration.playlist(request())).toBeNull();
      expect(mockBuild).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(FAILED_INDEX_BUILD_TTL_MS + 1);
      await narration.playlist(request());
      expect(mockBuild).toHaveBeenCalledTimes(2);
    });

    it('logs a build with no read along as such', async () => {
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      mockBuild.mockResolvedValueOnce(null);
      expect(await narration.playlist(request())).toBeNull();
      expect(log.mock.calls[0]![0]).toMatch(/^\[epub\.index_narration\] \[start\] bookId=7 fileId=12 userId=5 indexFileId=90 - /);
      expect(log.mock.calls[1]![0]).toMatch(
        /^\[epub\.index_narration\] \[end\] bookId=7 fileId=12 userId=5 indexFileId=90 durationMs=\d+ built=false sentences=0/,
      );
    });
  });

  describe('streaming the audiobook', () => {
    const href = 'bookorbit-audio/31.m4b';
    const read = async (file: { openBody: () => NodeJS.ReadableStream }) => readStream(file.openBody());

    it('serves a byte range', async () => {
      const file = await service.streamFile(7, href, 12, { range: 'bytes=10-19' }, user);
      expect(file).toMatchObject({ status: 206, size: 10, contentRange: 'bytes 10-19/1000', contentType: 'audio/mp4', acceptsRanges: true });
      expect([...(await read(file))]).toEqual(Array.from({ length: 10 }, (_, i) => 10 + i));
    });

    it('serves the whole file', async () => {
      const file = await service.streamFile(7, href, 12, {}, user);
      expect(file).toMatchObject({ status: 200, size: 1000, contentRange: null });
      expect((await read(file)).length).toBe(1000);
    });

    it('answers a matching If-None-Match with 304', async () => {
      const { etag } = await service.streamFile(7, href, 12, {}, user);
      const file = await service.streamFile(7, href, 12, { ifNoneMatch: etag! }, user);
      expect(file).toMatchObject({ status: 304, size: 0 });
      expect(file.openBody()).toBeInstanceOf(Readable);
    });

    it('answers a range past the end with 416', async () => {
      expect(await service.streamFile(7, href, 12, { range: 'bytes=5000-' }, user)).toMatchObject({ status: 416, contentRange: 'bytes */1000' });
    });

    it('sends the whole file when If-Range does not match', async () => {
      expect(await service.streamFile(7, href, 12, { range: 'bytes=0-9', ifRange: '"old"' }, user)).toMatchObject({ status: 200, size: 1000 });
    });

    it('serves a byte range on the media-overlay route', async () => {
      const file = await service.streamMediaOverlayFile(7, href, 12, 'bytes=0-3', user);
      expect(file).toMatchObject({ status: 206, length: 4, size: 1000, contentRange: 'bytes 0-3/1000' });
      expect([...(await readStream(file.body as Readable))]).toEqual([0, 1, 2, 3]);
    });

    it('serves audio without building the playlist', async () => {
      expect(await service.streamFile(7, href, 12, { range: 'bytes=0-0' }, user)).toMatchObject({ status: 206, contentType: 'audio/mp4' });
      expect(mockBuild).not.toHaveBeenCalled();
    });

    it('is a 404 for a content audiobook file the index was not cut from', async () => {
      const other = join(root, 'part2.m4b');
      await writeFile(other, Buffer.alloc(10));
      files.push({ id: 32, absolutePath: other, format: 'm4b', role: 'content', mediaOverlayAvailable: false });
      await expect(service.streamFile(7, 'bookorbit-audio/32.m4b', 12, {}, user)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is a 404 for any href but the file own one', async () => {
      await expect(service.streamFile(7, 'bookorbit-audio/31.mp3', 12, {}, user)).rejects.toBeInstanceOf(NotFoundException);
      const parse = () => null;
      await expect(narration.streamFile(request(), 'bookorbit-audio/31.m4b/../../x', {}, parse)).rejects.toBeInstanceOf(NotFoundException);
      await expect(narration.streamFile(request(), 'bookorbit-audio/31x.m4b', {}, parse)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is a 500 HttpException when the audiobook file cannot be read', async () => {
      const loop = join(root, 'loop.m4b');
      await symlink(loop, loop);
      files[1]!.absolutePath = loop;
      await expect(service.streamFile(7, href, 12, {}, user)).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('is a 404 for an audiobook file the playlist does not play', async () => {
      await expect(service.streamFile(7, 'bookorbit-audio/77.m4b', 12, {}, user)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is a 404 once the audiobook file is removed', async () => {
      await service.getMediaOverlayPlaylist(7, 12, user, { narrationFallback: true });
      await rm(audioPath);
      await expect(service.streamFile(7, href, 12, {}, user)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.streamMediaOverlayFile(7, href, 12, undefined, user)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is a 404 when the book has no timing index', async () => {
      resolver.resolveOverlaySource.mockResolvedValue(null);
      await expect(service.streamFile(7, href, 12, {}, user)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
