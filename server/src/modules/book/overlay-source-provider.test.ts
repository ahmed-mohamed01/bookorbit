import { stat } from 'node:fs/promises';

import { AudioPlayOrderService } from '../audiobook-chapters/audio-play-order.service';
import { buildEpubMediaOverlayPlaylistFromFile } from '../reader/epub/epub-media-overlay';
import { AudiobookEbookProgressSyncService } from './audiobook-ebook-progress-sync.service';
import type { OverlaySourceCandidate, OverlaySourceResolver } from './overlay-source-provider';

vi.mock('node:fs/promises', () => ({ stat: vi.fn() }));
vi.mock('../reader/epub/epub-media-overlay', () => ({ buildEpubMediaOverlayPlaylistFromFile: vi.fn() }));

const mockStat = vi.mocked(stat);
const mockBuildPlaylist = vi.mocked(buildEpubMediaOverlayPlaylistFromFile);

const AUDIO = {
  id: 10,
  absolutePath: '/library/book/audio.mp3',
  format: 'mp3',
  role: 'content',
  sortOrder: 0,
  durationSeconds: 100,
  mediaOverlayAvailable: false,
  mediaOverlayDurationSeconds: null,
};
const EPUB = { ...AUDIO, id: 20, absolutePath: '/library/book/book.epub', format: 'epub', sortOrder: 1, durationSeconds: null };
const INDEX = {
  ...EPUB,
  id: 40,
  absolutePath: '/library/book/book.bookorbit-timings',
  format: 'bookorbit-timings',
  role: 'supplement',
  sortOrder: 2,
};
const READ_ALONG = {
  ...EPUB,
  id: 30,
  absolutePath: '/library/book/book.readaloud.epub',
  sortOrder: 3,
  mediaOverlayAvailable: true,
  mediaOverlayDurationSeconds: 100,
};

function playlist(fileId: number) {
  const item = {
    sectionIndex: 0,
    smilHref: 'OPS/c.smil',
    textHref: 'OPS/c.xhtml',
    audioHref: 'OPS/a.mp3',
    audioMimeType: 'audio/mpeg',
    durationSeconds: 50,
    label: null,
  };
  return {
    bookId: 5,
    fileId,
    durationSeconds: 100,
    sections: [],
    resources: [],
    items: [
      { ...item, index: 0, textFragment: 'first', clipBeginSeconds: 0, clipEndSeconds: 50 },
      { ...item, index: 1, textFragment: 'second', clipBeginSeconds: 50, clipEndSeconds: 100 },
    ],
  };
}

function setup(files: OverlaySourceCandidate[], resolver?: OverlaySourceResolver) {
  const bookRepo = {
    findReadAloudSyncMode: vi.fn().mockResolvedValue('auto'),
    findAudioEbookProgressSyncFiles: vi.fn().mockResolvedValue({ primaryFileId: EPUB.id, files }),
    upsertSyncedEpubProgressIfNewer: vi.fn().mockResolvedValue(true),
    syncKoboReadingStateFromProgress: vi.fn().mockResolvedValue(undefined),
    upsertAudioProgress: vi.fn().mockResolvedValue({ revision: 2 }),
  };
  const positionConverter = {
    fragmentToPositions: vi.fn(({ bookFileId, fragment }: { bookFileId: number; fragment: string }) =>
      Promise.resolve({ status: 'exact', cfi: `epubcfi(${bookFileId}-${fragment})`, koreaderProgress: null }),
    ),
    nearestFragmentForPosition: vi.fn().mockResolvedValue({ status: 'exact', fragment: 'second', chapterIndex: 0 }),
  };
  const chapterRepo = { findTrackRows: vi.fn().mockResolvedValue(files), findChapterState: vi.fn().mockResolvedValue(null) };
  const service = new AudiobookEbookProgressSyncService(
    bookRepo as never,
    positionConverter as never,
    new AudioPlayOrderService(chapterRepo as never),
    resolver,
  );
  return { service, bookRepo, positionConverter };
}

const audioParams = { userId: 7, bookId: 5, currentFileId: AUDIO.id, positionSeconds: 60, percentage: 60, syncKobo: false };

describe('overlay source resolver seam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStat.mockResolvedValue({ mtimeMs: 1234 } as never);
    mockBuildPlaylist.mockImplementation((_path, _bookId, fileId) => Promise.resolve(playlist(fileId as number) as never));
  });

  it('does not sync a book without a read-along when no resolver is registered', async () => {
    const t = setup([AUDIO, EPUB, INDEX]);
    await expect(t.service.syncFromAudioProgress(audioParams)).resolves.toBe(false);
    expect(mockBuildPlaylist).not.toHaveBeenCalled();
  });

  it('maps through the file the resolver offers when the book has no read-along', async () => {
    const resolver = {
      resolveOverlaySource: vi.fn(<T extends OverlaySourceCandidate>(_u: number, _b: number, files: readonly T[]) => {
        const found = files.find((file) => file.id === INDEX.id);
        return Promise.resolve(found ? { ...found, mediaOverlayAvailable: true } : null);
      }),
    };
    const t = setup([AUDIO, EPUB, INDEX], resolver);

    await expect(t.service.syncFromAudioProgress(audioParams)).resolves.toBe(true);
    expect(resolver.resolveOverlaySource).toHaveBeenCalledWith(7, 5, [AUDIO, EPUB, INDEX]);
    expect(mockBuildPlaylist).toHaveBeenCalledWith(INDEX.absolutePath, 5, INDEX.id);
    expect(t.bookRepo.upsertSyncedEpubProgressIfNewer).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7, fileId: EPUB.id, cfi: 'epubcfi(20-second)' }),
    );
  });

  it('never writes progress to a resolved source that is not an EPUB', async () => {
    const resolver = { resolveOverlaySource: vi.fn().mockResolvedValue({ ...INDEX, mediaOverlayAvailable: true }) };
    const t = setup([AUDIO, EPUB, INDEX], resolver);
    t.bookRepo.findAudioEbookProgressSyncFiles.mockResolvedValue({ primaryFileId: AUDIO.id, files: [AUDIO, EPUB, INDEX] });

    await expect(t.service.syncFromAudioProgress(audioParams)).resolves.toBe(true);
    const written = t.bookRepo.upsertSyncedEpubProgressIfNewer.mock.calls.map(([arg]) => (arg as { fileId: number }).fileId);
    expect(written).toEqual([EPUB.id]);
  });

  it('prefers a read-along EPUB and never asks the resolver', async () => {
    const resolver = { resolveOverlaySource: vi.fn() };
    const t = setup([AUDIO, EPUB, READ_ALONG, INDEX], resolver);

    await expect(t.service.syncFromAudioProgress(audioParams)).resolves.toBe(true);
    expect(resolver.resolveOverlaySource).not.toHaveBeenCalled();
    expect(mockBuildPlaylist).toHaveBeenCalledWith(READ_ALONG.absolutePath, 5, READ_ALONG.id);
  });

  it('passes the user to the resolver on the ebook to audio direction', async () => {
    const resolver = { resolveOverlaySource: vi.fn().mockResolvedValue(null) };
    const t = setup([AUDIO, EPUB, INDEX], resolver);

    await expect(
      t.service.syncFromEbookProgress({ userId: 9, bookId: 5, bookFileId: EPUB.id, percentage: 50, cfi: 'epubcfi(/6/2!/4/2/1:0)' }),
    ).resolves.toBe(false);
    expect(resolver.resolveOverlaySource).toHaveBeenCalledWith(9, 5, [AUDIO, EPUB, INDEX]);
  });
});
