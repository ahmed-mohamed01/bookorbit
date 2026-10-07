import { stat } from 'node:fs/promises';

import { buildEpubMediaOverlayPlaylistFromFile } from '../reader/epub/epub-media-overlay';
import { AudiobookEbookProgressSyncService } from './audiobook-ebook-progress-sync.service';

vi.mock('node:fs/promises', () => ({ stat: vi.fn() }));
vi.mock('../reader/epub/epub-media-overlay', () => ({ buildEpubMediaOverlayPlaylistFromFile: vi.fn() }));

const mockStat = vi.mocked(stat);
const mockBuildPlaylist = vi.mocked(buildEpubMediaOverlayPlaylistFromFile);

const SOURCE_TIME = new Date('2026-09-19T12:00:00.000Z');

function makeFiles(audioDuration: number | null = 100) {
  return {
    primaryFileId: 20,
    files: [
      {
        id: 10,
        absolutePath: '/library/audio.mp3',
        format: 'mp3',
        role: 'content',
        sortOrder: 0,
        durationSeconds: audioDuration,
        mediaOverlayAvailable: false,
        mediaOverlayDurationSeconds: null,
      },
      {
        id: 20,
        absolutePath: '/library/standard.epub',
        format: 'epub',
        role: 'content',
        sortOrder: 1,
        durationSeconds: null,
        mediaOverlayAvailable: false,
        mediaOverlayDurationSeconds: null,
      },
      {
        id: 30,
        absolutePath: '/library/read-along.epub',
        format: 'epub',
        role: 'content',
        sortOrder: 2,
        durationSeconds: null,
        mediaOverlayAvailable: true,
        mediaOverlayDurationSeconds: 100,
      },
    ],
  };
}

function makePlaylist() {
  return {
    bookId: 5,
    fileId: 30,
    durationSeconds: 100,
    sections: [],
    resources: [],
    items: [
      {
        index: 0,
        sectionIndex: 0,
        smilHref: 'OPS/chapter.smil',
        textHref: 'OPS/chapter.xhtml',
        textFragment: 'first',
        audioHref: 'OPS/audio.mp3',
        audioMimeType: 'audio/mpeg',
        clipBeginSeconds: 0,
        clipEndSeconds: 50,
        durationSeconds: 50,
        label: null,
      },
      {
        index: 1,
        sectionIndex: 0,
        smilHref: 'OPS/chapter.smil',
        textHref: 'OPS/chapter.xhtml',
        textFragment: 'second',
        audioHref: 'OPS/audio.mp3',
        audioMimeType: 'audio/mpeg',
        clipBeginSeconds: 50,
        clipEndSeconds: 100,
        durationSeconds: 50,
        label: null,
      },
    ],
  };
}

function makePlaylistWithZeroLengthClip() {
  const playlist = makePlaylist();
  return {
    ...playlist,
    items: [
      { ...playlist.items[0]!, textFragment: 'before', clipEndSeconds: 40, durationSeconds: 40 },
      {
        ...playlist.items[1]!,
        textFragment: 'zero',
        clipBeginSeconds: 40,
        clipEndSeconds: 40,
        durationSeconds: 0,
      },
      {
        ...playlist.items[1]!,
        index: 2,
        textFragment: 'after',
        clipBeginSeconds: 40,
        clipEndSeconds: 100,
        durationSeconds: 60,
      },
    ],
  };
}

/** A Storyteller read-along EPUB beside the original, with the audiobook never imported. */
function makeFilesWithoutAudio() {
  const files = makeFiles();
  return { ...files, primaryFileId: 30, files: files.files.filter((file) => file.format === 'epub') };
}

function makeFixture(
  audioDuration = 100,
  syncFiles: ReturnType<typeof makeFiles> = makeFiles(audioDuration),
  provenance?: { findSourceAudioBookId: ReturnType<typeof vi.fn> },
  offsetsStore?: { find: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> },
) {
  const bookRepo = {
    findReadAloudSyncMode: vi.fn().mockResolvedValue('auto'),
    findAudioEbookProgressSyncFiles: vi.fn().mockResolvedValue(syncFiles),
    upsertSyncedEpubProgressIfNewer: vi.fn().mockResolvedValue(true),
    syncKoboReadingStateFromProgress: vi.fn().mockResolvedValue(undefined),
    upsertAudioProgress: vi.fn().mockResolvedValue({ revision: 2 }),
    findAudioChapterStarts: vi.fn().mockResolvedValue([]),
  };
  const positionConverter = {
    fragmentToPositions: vi.fn(({ bookFileId, fragment }: { bookFileId: number; fragment: string }) =>
      Promise.resolve({ status: 'exact', cfi: `epubcfi(${bookFileId}-${fragment})`, koreaderProgress: `/body/${bookFileId}/${fragment}` }),
    ),
    nearestFragmentForPosition: vi.fn().mockResolvedValue({ status: 'exact', fragment: 'second', chapterIndex: 0 }),
  };
  return {
    bookRepo,
    positionConverter,
    service: new AudiobookEbookProgressSyncService(bookRepo as never, positionConverter as never, provenance, offsetsStore),
  };
}

describe('AudiobookEbookProgressSyncService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStat.mockResolvedValue({ mtimeMs: 1234 } as never);
    mockBuildPlaylist.mockResolvedValue(makePlaylist());
  });

  it('maps accepted audiobook progress to both the normal and read-along EPUB', async () => {
    const { service, bookRepo, positionConverter } = makeFixture();

    await expect(
      service.syncFromAudioProgress({
        userId: 7,
        bookId: 5,
        currentFileId: 10,
        positionSeconds: 75,
        percentage: 75,
        syncKobo: true,
        sourceUpdatedAt: SOURCE_TIME,
      }),
    ).resolves.toBe(true);

    expect(bookRepo.upsertSyncedEpubProgressIfNewer).toHaveBeenCalledTimes(2);
    // The plain EPUB has no narration to resume, so it gets the text position without a marker.
    expect(bookRepo.upsertSyncedEpubProgressIfNewer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        userId: 7,
        fileId: 20,
        percentage: 75,
        positionSeconds: null,
        mediaOverlayFragment: null,
        mediaOverlaySectionIndex: null,
        sourceUpdatedAt: SOURCE_TIME,
      }),
    );
    expect(bookRepo.upsertSyncedEpubProgressIfNewer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        userId: 7,
        fileId: 30,
        percentage: 75,
        positionSeconds: 75,
        mediaOverlayFragment: 'OPS/chapter.xhtml#second',
        mediaOverlaySectionIndex: 0,
        sourceUpdatedAt: SOURCE_TIME,
      }),
    );
    expect(bookRepo.syncKoboReadingStateFromProgress).toHaveBeenCalledWith(7, 20, 75, null, null, null, null);
    expect(positionConverter.fragmentToPositions).toHaveBeenCalledWith(
      expect.objectContaining({ bookFileId: 20, sourceBookFileId: 30, fragment: 'second' }),
    );
  });

  it.each([40, 75, 100])('skips a zero-length media-overlay clip when mapping %s seconds', async (positionSeconds) => {
    const { service, bookRepo, positionConverter } = makeFixture();
    mockBuildPlaylist.mockResolvedValueOnce(makePlaylistWithZeroLengthClip());

    await expect(
      service.syncFromAudioProgress({
        userId: 7,
        bookId: 5,
        currentFileId: 10,
        positionSeconds,
        percentage: positionSeconds,
        syncKobo: false,
        sourceUpdatedAt: SOURCE_TIME,
      }),
    ).resolves.toBe(true);

    expect(positionConverter.fragmentToPositions).toHaveBeenCalledTimes(2);
    expect(positionConverter.fragmentToPositions).toHaveBeenNthCalledWith(1, expect.objectContaining({ fragment: 'after' }));
    expect(positionConverter.fragmentToPositions).toHaveBeenNthCalledWith(2, expect.objectContaining({ fragment: 'after' }));
    expect(bookRepo.upsertSyncedEpubProgressIfNewer).toHaveBeenCalledTimes(2);
    expect(bookRepo.upsertSyncedEpubProgressIfNewer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        fileId: 20,
        cfi: 'epubcfi(20-after)',
        percentage: positionSeconds,
        positionSeconds: null,
        mediaOverlayFragment: null,
      }),
    );
    expect(bookRepo.upsertSyncedEpubProgressIfNewer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        fileId: 30,
        percentage: positionSeconds,
        positionSeconds,
        mediaOverlayFragment: 'OPS/chapter.xhtml#after',
      }),
    );
  });

  it('does not replace or forward a newer EPUB position', async () => {
    const { service, bookRepo } = makeFixture();
    bookRepo.upsertSyncedEpubProgressIfNewer.mockResolvedValue(false);

    await expect(
      service.syncFromAudioProgress({
        userId: 7,
        bookId: 5,
        currentFileId: 10,
        positionSeconds: 25,
        percentage: 25,
        syncKobo: true,
        sourceUpdatedAt: SOURCE_TIME,
      }),
    ).resolves.toBe(false);

    expect(bookRepo.syncKoboReadingStateFromProgress).not.toHaveBeenCalled();
  });

  it('maps an EPUB position to revision-safe audiobook progress and the sibling EPUB', async () => {
    const { service, bookRepo, positionConverter } = makeFixture();

    await expect(
      service.syncFromEbookProgress({
        userId: 7,
        bookId: 5,
        bookFileId: 20,
        percentage: 75,
        cfi: 'epubcfi(/6/4)',
        sourceUpdatedAt: SOURCE_TIME,
      }),
    ).resolves.toBe(true);

    expect(bookRepo.upsertAudioProgress).toHaveBeenCalledWith(7, 5, 10, 50, 50, SOURCE_TIME);
    expect(bookRepo.upsertSyncedEpubProgressIfNewer).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 30, percentage: 50, positionSeconds: 50, sourceUpdatedAt: SOURCE_TIME }),
    );
    expect(positionConverter.nearestFragmentForPosition).toHaveBeenCalledWith(expect.objectContaining({ bookFileId: 20, sourceBookFileId: 30 }));
  });

  it('skips a zero-length clip when propagating an EPUB narration position to a sibling', async () => {
    const { service, bookRepo, positionConverter } = makeFixture();
    mockBuildPlaylist.mockResolvedValueOnce(makePlaylistWithZeroLengthClip());

    await expect(
      service.syncFromEbookProgress({
        userId: 7,
        bookId: 5,
        bookFileId: 30,
        percentage: 75,
        positionSeconds: 75,
        mediaOverlayFragment: 'OPS/chapter.xhtml#after',
        mediaOverlaySectionIndex: 0,
        sourceUpdatedAt: SOURCE_TIME,
      }),
    ).resolves.toBe(true);

    expect(bookRepo.upsertAudioProgress).toHaveBeenCalledWith(7, 5, 10, 75, 75, SOURCE_TIME);
    expect(positionConverter.fragmentToPositions).toHaveBeenCalledWith(
      expect.objectContaining({ bookFileId: 20, sourceBookFileId: 30, fragment: 'after' }),
    );
    expect(bookRepo.upsertSyncedEpubProgressIfNewer).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 20, cfi: 'epubcfi(20-after)', positionSeconds: null, mediaOverlayFragment: null }),
    );
  });

  it('follows the text position of a plain EPUB that sends back a narration marker an older sync left on it', async () => {
    const { service, bookRepo, positionConverter } = makeFixture();

    await expect(
      service.syncFromEbookProgress({
        userId: 7,
        bookId: 5,
        bookFileId: 20,
        percentage: 75,
        cfi: 'epubcfi(/6/4)',
        positionSeconds: 10,
        mediaOverlayFragment: 'OPS/chapter.xhtml#first',
        mediaOverlaySectionIndex: 0,
        sourceUpdatedAt: SOURCE_TIME,
      }),
    ).resolves.toBe(true);

    // The stale marker names 'first' at 10 seconds; the page the reader is on resolves to 'second'.
    expect(positionConverter.nearestFragmentForPosition).toHaveBeenCalledWith(expect.objectContaining({ bookFileId: 20, cfi: 'epubcfi(/6/4)' }));
    expect(bookRepo.upsertAudioProgress).toHaveBeenCalledWith(7, 5, 10, 50, 50, SOURCE_TIME);
    expect(bookRepo.upsertSyncedEpubProgressIfNewer).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 30, positionSeconds: 50, mediaOverlayFragment: 'OPS/chapter.xhtml#second' }),
    );
  });

  it('writes a read-along position to the plain sibling without a narration marker', async () => {
    const { service, bookRepo } = makeFixture();

    await expect(
      service.syncFromEbookProgress({ userId: 7, bookId: 5, bookFileId: 30, percentage: 75, cfi: 'epubcfi(/6/4)', sourceUpdatedAt: SOURCE_TIME }),
    ).resolves.toBe(true);

    expect(bookRepo.upsertAudioProgress).toHaveBeenCalledWith(7, 5, 10, 50, 50, SOURCE_TIME);
    expect(bookRepo.upsertSyncedEpubProgressIfNewer).toHaveBeenCalledOnce();
    expect(bookRepo.upsertSyncedEpubProgressIfNewer).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: 20,
        percentage: 50,
        positionSeconds: null,
        mediaOverlayFragment: null,
        mediaOverlaySectionIndex: null,
      }),
    );
  });

  it('stops sibling propagation when a newer audiobook state rejects the source write', async () => {
    const { service, bookRepo } = makeFixture();
    bookRepo.upsertAudioProgress.mockResolvedValue(undefined);

    await expect(
      service.syncFromEbookProgress({
        userId: 7,
        bookId: 5,
        bookFileId: 20,
        percentage: 75,
        cfi: 'epubcfi(/6/4)',
        sourceUpdatedAt: SOURCE_TIME,
      }),
    ).resolves.toBe(false);

    expect(bookRepo.upsertSyncedEpubProgressIfNewer).not.toHaveBeenCalled();
  });

  it('syncs narration to the audiobook without moving a sibling text position', async () => {
    const { service, bookRepo } = makeFixture();

    await expect(
      service.syncFromEbookProgress({
        userId: 7,
        bookId: 5,
        bookFileId: 30,
        percentage: 32,
        positionSeconds: 10,
        mediaOverlayFragment: 'OPS/chapter.xhtml#first',
        mediaOverlaySectionIndex: 0,
        sourceUpdatedAt: SOURCE_TIME,
        syncSiblingEpubs: false,
      }),
    ).resolves.toBe(true);

    expect(bookRepo.upsertAudioProgress).toHaveBeenCalledWith(7, 5, 10, 10, 10, SOURCE_TIME);
    expect(bookRepo.upsertSyncedEpubProgressIfNewer).not.toHaveBeenCalled();
  });

  it('rejects mapping when audiobook and overlay durations exceed tolerance', async () => {
    const { service, bookRepo } = makeFixture(120);

    await expect(
      service.syncFromAudioProgress({
        userId: 7,
        bookId: 5,
        currentFileId: 10,
        positionSeconds: 50,
        percentage: 50,
        syncKobo: false,
      }),
    ).resolves.toBe(false);

    expect(bookRepo.upsertSyncedEpubProgressIfNewer).not.toHaveBeenCalled();
  });

  it('does no mapping work when read-aloud sync is disabled', async () => {
    const { service, bookRepo } = makeFixture();
    bookRepo.findReadAloudSyncMode.mockResolvedValue('disabled');

    await expect(
      service.syncFromAudioProgress({
        userId: 7,
        bookId: 5,
        currentFileId: 10,
        positionSeconds: 50,
        percentage: 50,
        syncKobo: false,
      }),
    ).resolves.toBe(false);

    expect(bookRepo.findAudioEbookProgressSyncFiles).not.toHaveBeenCalled();
    expect(mockBuildPlaylist).not.toHaveBeenCalled();
  });
});

describe('AudiobookEbookProgressSyncService sibling EPUBs without an audiobook', () => {
  const KOREADER_XPOINTER = '/body/DocFragment[1]/body/p[3]/text().0';

  beforeEach(() => {
    vi.clearAllMocks();
    mockStat.mockResolvedValue({ mtimeMs: 1234 } as never);
    mockBuildPlaylist.mockResolvedValue(makePlaylist());
  });

  it('carries a device position on the original EPUB to the read-along copy', async () => {
    const { service, bookRepo, positionConverter } = makeFixture(100, makeFilesWithoutAudio());

    await expect(
      service.syncFromEbookProgress({
        userId: 7,
        bookId: 5,
        bookFileId: 20,
        percentage: 69,
        cfi: 'epubcfi(/6/4)',
        koreaderProgress: KOREADER_XPOINTER,
        sourceUpdatedAt: SOURCE_TIME,
      }),
    ).resolves.toBe(true);

    expect(bookRepo.upsertAudioProgress).not.toHaveBeenCalled();
    expect(positionConverter.nearestFragmentForPosition).toHaveBeenCalledWith(
      expect.objectContaining({ bookFileId: 20, sourceBookFileId: 30, cfi: 'epubcfi(/6/4)', xpointer: KOREADER_XPOINTER }),
    );
    expect(positionConverter.fragmentToPositions).toHaveBeenCalledWith({ bookFileId: 30, sourceBookFileId: 30, chapterIndex: 0, fragment: 'second' });
    expect(bookRepo.upsertSyncedEpubProgressIfNewer).toHaveBeenCalledOnce();
    expect(bookRepo.upsertSyncedEpubProgressIfNewer).toHaveBeenCalledWith({
      userId: 7,
      fileId: 30,
      cfi: 'epubcfi(30-second)',
      koreaderProgress: '/body/30/second',
      percentage: 69,
      positionSeconds: 50,
      mediaOverlayFragment: 'OPS/chapter.xhtml#second',
      mediaOverlaySectionIndex: 0,
      sourceUpdatedAt: SOURCE_TIME,
    });
  });

  it('carries a web position on the read-along copy to the original without a narration marker', async () => {
    const { service, bookRepo, positionConverter } = makeFixture(100, makeFilesWithoutAudio());

    await expect(
      service.syncFromEbookProgress({
        userId: 7,
        bookId: 5,
        bookFileId: 30,
        percentage: 67,
        cfi: 'epubcfi(/6/4)',
        koreaderProgress: KOREADER_XPOINTER,
        sourceUpdatedAt: SOURCE_TIME,
      }),
    ).resolves.toBe(true);

    expect(positionConverter.nearestFragmentForPosition).toHaveBeenCalledWith(expect.objectContaining({ bookFileId: 30, sourceBookFileId: 30 }));
    expect(positionConverter.fragmentToPositions).toHaveBeenCalledWith({ bookFileId: 20, sourceBookFileId: 30, chapterIndex: 0, fragment: 'second' });
    expect(bookRepo.upsertSyncedEpubProgressIfNewer).toHaveBeenCalledOnce();
    expect(bookRepo.upsertSyncedEpubProgressIfNewer).toHaveBeenCalledWith({
      userId: 7,
      fileId: 20,
      cfi: 'epubcfi(20-second)',
      koreaderProgress: '/body/20/second',
      percentage: 67,
      positionSeconds: null,
      mediaOverlayFragment: null,
      mediaOverlaySectionIndex: null,
      sourceUpdatedAt: SOURCE_TIME,
    });
  });

  it('parses nothing for a read-along EPUB that has no sibling and no audiobook', async () => {
    const readAlongOnly = makeFilesWithoutAudio();
    readAlongOnly.files = readAlongOnly.files.filter((file) => file.id === 30);
    const { service, bookRepo, positionConverter } = makeFixture(100, readAlongOnly);

    await expect(
      service.syncFromEbookProgress({ userId: 7, bookId: 5, bookFileId: 30, percentage: 67, cfi: 'epubcfi(/6/4)', sourceUpdatedAt: SOURCE_TIME }),
    ).resolves.toBe(false);

    expect(mockStat).not.toHaveBeenCalled();
    expect(mockBuildPlaylist).not.toHaveBeenCalled();
    expect(positionConverter.nearestFragmentForPosition).not.toHaveBeenCalled();
    expect(bookRepo.upsertSyncedEpubProgressIfNewer).not.toHaveBeenCalled();
  });

  it('parses nothing for a narration write that did not move the text position', async () => {
    const { service, bookRepo, positionConverter } = makeFixture(100, makeFilesWithoutAudio());

    await expect(
      service.syncFromEbookProgress({
        userId: 7,
        bookId: 5,
        bookFileId: 30,
        percentage: 32,
        positionSeconds: 10,
        mediaOverlayFragment: 'OPS/chapter.xhtml#first',
        mediaOverlaySectionIndex: 0,
        sourceUpdatedAt: SOURCE_TIME,
        syncSiblingEpubs: false,
      }),
    ).resolves.toBe(false);

    expect(mockBuildPlaylist).not.toHaveBeenCalled();
    expect(positionConverter.nearestFragmentForPosition).not.toHaveBeenCalled();
    expect(bookRepo.upsertSyncedEpubProgressIfNewer).not.toHaveBeenCalled();
  });

  it('keeps every copy on its own position when read-aloud sync is disabled', async () => {
    const { service, bookRepo } = makeFixture(100, makeFilesWithoutAudio());
    bookRepo.findReadAloudSyncMode.mockResolvedValue('disabled');

    await expect(
      service.syncFromEbookProgress({ userId: 7, bookId: 5, bookFileId: 20, percentage: 69, koreaderProgress: KOREADER_XPOINTER }),
    ).resolves.toBe(false);

    expect(bookRepo.findAudioEbookProgressSyncFiles).not.toHaveBeenCalled();
    expect(bookRepo.upsertSyncedEpubProgressIfNewer).not.toHaveBeenCalled();
  });

  it.each([
    ['its duration is too far from the narration', () => makeFixture(120)],
    ['a file has no duration', () => makeFixture(100, makeFiles(null))],
  ])('syncs the sibling EPUB by text when the audiobook cannot be mapped because %s', async (_reason, fixture) => {
    const { service, bookRepo } = fixture();

    await expect(
      service.syncFromEbookProgress({
        userId: 7,
        bookId: 5,
        bookFileId: 20,
        percentage: 69,
        koreaderProgress: KOREADER_XPOINTER,
        sourceUpdatedAt: SOURCE_TIME,
      }),
    ).resolves.toBe(true);

    expect(bookRepo.upsertAudioProgress).not.toHaveBeenCalled();
    expect(bookRepo.upsertSyncedEpubProgressIfNewer).toHaveBeenCalledOnce();
    expect(bookRepo.upsertSyncedEpubProgressIfNewer).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 30, percentage: 69, positionSeconds: 50, mediaOverlayFragment: 'OPS/chapter.xhtml#second' }),
    );
  });

  it('writes nothing when the copies do not share the chapter text', async () => {
    const { service, bookRepo, positionConverter } = makeFixture(100, makeFilesWithoutAudio());
    positionConverter.fragmentToPositions.mockResolvedValue({ status: 'failed', reason: 'chapter_text_mismatch' } as never);

    await expect(
      service.syncFromEbookProgress({ userId: 7, bookId: 5, bookFileId: 30, percentage: 67, cfi: 'epubcfi(/6/4)', sourceUpdatedAt: SOURCE_TIME }),
    ).resolves.toBe(false);

    expect(bookRepo.upsertSyncedEpubProgressIfNewer).not.toHaveBeenCalled();
  });

  it('writes nothing when the position cannot be placed on the narration', async () => {
    const { service, bookRepo, positionConverter } = makeFixture(100, makeFilesWithoutAudio());
    positionConverter.nearestFragmentForPosition.mockResolvedValue({ status: 'failed', reason: 'no_candidate_fragments' });

    await expect(
      service.syncFromEbookProgress({ userId: 7, bookId: 5, bookFileId: 20, percentage: 69, koreaderProgress: KOREADER_XPOINTER }),
    ).resolves.toBe(false);

    expect(positionConverter.fragmentToPositions).not.toHaveBeenCalled();
    expect(bookRepo.upsertSyncedEpubProgressIfNewer).not.toHaveBeenCalled();
  });

  it('reports no sync when the sibling already holds a newer position', async () => {
    const { service, bookRepo } = makeFixture(100, makeFilesWithoutAudio());
    bookRepo.upsertSyncedEpubProgressIfNewer.mockResolvedValue(false);

    await expect(
      service.syncFromEbookProgress({ userId: 7, bookId: 5, bookFileId: 20, percentage: 69, koreaderProgress: KOREADER_XPOINTER }),
    ).resolves.toBe(false);

    expect(bookRepo.upsertSyncedEpubProgressIfNewer).toHaveBeenCalledOnce();
  });
});

/** Audiobook 5 split into files of the given lengths, ids 11, 12, ... */
function makeAudioBookFiles(durations: (number | null)[]) {
  return { primaryFileId: 11, files: durations.map((durationSeconds, index) => ({ ...makeFiles().files[0]!, id: 11 + index, durationSeconds })) };
}

describe('AudiobookEbookProgressSyncService read-along book behind a linked audiobook', () => {
  // The read-along book holds only its EPUB; 20 s of unnarrated credits open the audiobook.
  const readAlongFiles = () => ({ primaryFileId: 30, files: makeFiles().files.filter((file) => file.id === 30) });
  const linkFiles = (fixture: ReturnType<typeof makeFixture>, audioDurations: number[]) =>
    fixture.bookRepo.findAudioEbookProgressSyncFiles.mockImplementation((bookId: number) =>
      Promise.resolve(bookId === 5 ? makeAudioBookFiles(audioDurations) : readAlongFiles()),
    );
  const params = {
    userId: 7,
    audioBookId: 5,
    readAlongBookId: 9,
    audioSeconds: 95,
    audioTotalSeconds: 120,
    syncKobo: true,
    sourceUpdatedAt: SOURCE_TIME,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockStat.mockResolvedValue({ mtimeMs: 1234 } as never);
    mockBuildPlaylist.mockResolvedValue(makePlaylist());
  });

  function makeReadAlongFixture() {
    const fixture = makeFixture(100, readAlongFiles());
    linkFiles(fixture, [20, 100]);
    fixture.bookRepo.findAudioChapterStarts.mockResolvedValue([{ startMs: 0 }, { startMs: 20_000 }]);
    return fixture;
  }

  it('places the audiobook position on the narrated sentence within its chapter', async () => {
    const { service, bookRepo } = makeReadAlongFixture();

    await expect(service.syncReadAlongFromAudioPosition(params)).resolves.toBe(true);

    expect(bookRepo.findAudioChapterStarts).toHaveBeenCalledWith(5);
    expect(bookRepo.findAudioEbookProgressSyncFiles).toHaveBeenCalledWith(9);
    // 95 s is 75 s into the narrated chapter; the credits never reach the read-along timeline.
    expect(bookRepo.upsertSyncedEpubProgressIfNewer).toHaveBeenCalledWith({
      userId: 7,
      fileId: 30,
      cfi: 'epubcfi(30-second)',
      percentage: 75,
      positionSeconds: 75,
      mediaOverlayFragment: 'OPS/chapter.xhtml#second',
      mediaOverlaySectionIndex: 0,
      koreaderProgress: '/body/30/second',
      sourceUpdatedAt: SOURCE_TIME,
    });
    expect(bookRepo.syncKoboReadingStateFromProgress).toHaveBeenCalledWith(7, 30, 75, null, null, null, null);
  });

  it('writes nothing when the narration does not fit the audiobook chapters', async () => {
    const { service, bookRepo } = makeReadAlongFixture();
    bookRepo.findAudioChapterStarts.mockResolvedValue([{ startMs: 0 }, { startMs: 60_000 }]);

    await expect(service.syncReadAlongFromAudioPosition(params)).resolves.toBe(false);

    expect(bookRepo.upsertSyncedEpubProgressIfNewer).not.toHaveBeenCalled();
  });

  describe('a read-along BookOrbit built from this audiobook', () => {
    // Storyteller moved the chapter 2 cut: its 100 s narration file stands for a 115 s chapter.
    function makeBuiltFixture(sourceAudioBookId: number | null) {
      const playlist = makePlaylist();
      mockBuildPlaylist.mockResolvedValue({
        ...playlist,
        items: playlist.items.map((item) => ({ ...item, audioHref: 'OPS/Audio/00001-00002.mp4' })),
      });
      const provenance = { findSourceAudioBookId: vi.fn().mockResolvedValue(sourceAudioBookId) };
      const fixture = makeFixture(100, readAlongFiles(), provenance);
      linkFiles(fixture, [135]);
      fixture.bookRepo.findAudioChapterStarts.mockResolvedValue([{ startMs: 0 }, { startMs: 20_000 }]);
      return { ...fixture, provenance };
    }

    it('pairs the narration with its chapter by Storyteller file name', async () => {
      const { service, bookRepo, provenance } = makeBuiltFixture(5);

      await expect(service.syncReadAlongFromAudioPosition({ ...params, audioTotalSeconds: 135 })).resolves.toBe(true);

      expect(provenance.findSourceAudioBookId).toHaveBeenCalledWith(9);
      expect(bookRepo.upsertSyncedEpubProgressIfNewer).toHaveBeenCalledWith(expect.objectContaining({ positionSeconds: 75 }));
    });

    it('keeps duration matching when the read-along was built from another audiobook', async () => {
      const { service, bookRepo } = makeBuiltFixture(6);

      await expect(service.syncReadAlongFromAudioPosition({ ...params, audioTotalSeconds: 135 })).resolves.toBe(false);

      expect(bookRepo.upsertSyncedEpubProgressIfNewer).not.toHaveBeenCalled();
    });
  });

  it('warns once per mismatched book pair and logs repeats at debug', async () => {
    const { service, bookRepo } = makeReadAlongFixture();
    const logger = service['logger'];
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    bookRepo.findAudioChapterStarts.mockResolvedValue([{ startMs: 0 }, { startMs: 60_000 }]);

    await expect(service.syncReadAlongFromAudioPosition(params)).resolves.toBe(false);
    await expect(service.syncReadAlongFromAudioPosition(params)).resolves.toBe(false);
    await expect(service.syncReadAlongFromAudioPosition({ ...params, readAlongBookId: 10 })).resolves.toBe(false);

    expect(warn).toHaveBeenCalledTimes(2);
    expect(debug).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(
        /audioBookId=5 readAlongBookId=9 durationMs=\d+ matched=false reason=narration_mismatch narrationFile=1 narrationSeconds=100\.000 chapter=1 chapterSeconds=60\.000 - /,
      ),
    );
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('audioBookId=5 readAlongBookId=9'));
    expect(warn).toHaveBeenNthCalledWith(2, expect.stringContaining('audioBookId=5 readAlongBookId=10'));
  });

  it('skips Kobo when the read-along already holds a newer position', async () => {
    const { service, bookRepo } = makeReadAlongFixture();
    bookRepo.upsertSyncedEpubProgressIfNewer.mockResolvedValue(false);

    await expect(service.syncReadAlongFromAudioPosition(params)).resolves.toBe(false);

    expect(bookRepo.syncKoboReadingStateFromProgress).not.toHaveBeenCalled();
  });

  it('does no mapping work when read-aloud sync is disabled for the read-along book', async () => {
    const { service, bookRepo } = makeReadAlongFixture();
    bookRepo.findReadAloudSyncMode.mockResolvedValue('disabled');

    await expect(service.syncReadAlongFromAudioPosition(params)).resolves.toBe(false);

    expect(bookRepo.findReadAloudSyncMode).toHaveBeenCalledWith(7, 9);
    expect(mockBuildPlaylist).not.toHaveBeenCalled();
  });
});

describe('AudiobookEbookProgressSyncService audiobook behind a linked read-along', () => {
  // Audiobook 5 holds two 60 s files with a chapter each; read-along 9 narrates only the second chapter
  // with the 100 s playlist, so the first chapter plays the role of unnarrated credits.
  const audioFiles = {
    primaryFileId: 11,
    files: [
      { ...makeFiles().files[0]!, id: 11, durationSeconds: 20 },
      { ...makeFiles().files[0]!, id: 12, durationSeconds: 100 },
    ],
  };
  const readAlongFiles = { primaryFileId: 30, files: makeFiles().files.filter((file) => file.id === 30) };
  const params = { userId: 7, audioBookId: 5, readAlongBookId: 9, bookFileId: 30, sourceUpdatedAt: SOURCE_TIME };

  beforeEach(() => {
    vi.clearAllMocks();
    mockStat.mockResolvedValue({ mtimeMs: 1234 } as never);
    mockBuildPlaylist.mockResolvedValue(makePlaylist());
  });

  function makeLinkedFixture() {
    const fixture = makeFixture();
    fixture.bookRepo.findAudioEbookProgressSyncFiles.mockImplementation((bookId: number) =>
      Promise.resolve(bookId === 5 ? audioFiles : readAlongFiles),
    );
    fixture.bookRepo.findAudioChapterStarts.mockResolvedValue([{ startMs: 0 }, { startMs: 20_000 }]);
    return fixture;
  }

  it('turns a player file position into time through the whole audiobook', async () => {
    const { service } = makeLinkedFixture();

    await expect(service.resolveAudioBookPosition(5, 12, 75)).resolves.toEqual({ audioSeconds: 95, audioTotalSeconds: 120 });
    await expect(service.resolveAudioBookPosition(5, 99, 75)).resolves.toBeNull();
  });

  it('moves the audiobook to the sentence the read-along narration marker names', async () => {
    const { service, bookRepo } = makeLinkedFixture();

    await expect(
      service.syncAudioFromReadAlongPosition({ ...params, positionSeconds: 75, mediaOverlayFragment: 'OPS/chapter.xhtml#second' }),
    ).resolves.toBe(true);

    // 75 s of narration is 75 s into the narrated chapter, which starts at 20 s: file 12 at 75 s.
    expect(bookRepo.upsertAudioProgress).toHaveBeenCalledWith(7, 5, 12, 75, (95 / 120) * 100, SOURCE_TIME);
  });

  it('places a text-only position at the start of its nearest narrated sentence', async () => {
    const { service, bookRepo } = makeLinkedFixture();

    await expect(service.syncAudioFromReadAlongPosition({ ...params, cfi: 'epubcfi(/6/2)' })).resolves.toBe(true);

    expect(bookRepo.upsertAudioProgress).toHaveBeenCalledWith(7, 5, 12, 50, (70 / 120) * 100, SOURCE_TIME);
  });

  it('writes nothing when read-aloud sync is disabled on the read-along', async () => {
    const { service, bookRepo } = makeLinkedFixture();
    bookRepo.findReadAloudSyncMode.mockResolvedValue('disabled');

    await expect(service.syncAudioFromReadAlongPosition({ ...params, positionSeconds: 75 })).resolves.toBe(false);

    expect(bookRepo.findReadAloudSyncMode).toHaveBeenCalledWith(7, 9);
    expect(bookRepo.upsertAudioProgress).not.toHaveBeenCalled();
  });

  it('writes nothing when the narration does not fit the audiobook chapters', async () => {
    const { service, bookRepo } = makeLinkedFixture();
    bookRepo.findAudioChapterStarts.mockResolvedValue([{ startMs: 0 }, { startMs: 60_000 }]);

    await expect(service.syncAudioFromReadAlongPosition({ ...params, positionSeconds: 75 })).resolves.toBe(false);

    expect(bookRepo.upsertAudioProgress).not.toHaveBeenCalled();
  });

  it('reports no sync when the audiobook already holds newer playback', async () => {
    const { service, bookRepo } = makeLinkedFixture();
    bookRepo.upsertAudioProgress.mockResolvedValue(undefined);

    await expect(service.syncAudioFromReadAlongPosition({ ...params, positionSeconds: 75 })).resolves.toBe(false);
  });
});

describe('AudiobookEbookProgressSyncService read-along fit', () => {
  const readAlongFiles = { primaryFileId: 30, files: makeFiles().files.filter((file) => file.id === 30) };
  const narration = [{ audioHref: 'OPS/audio.mp3', durationSeconds: 100 }];
  const matchedOffsets = [{ audioHref: 'OPS/audio.mp3', startSeconds: 20, durationSeconds: 100 }];
  const storedRecord = {
    readAlongFileId: 30,
    audioBookId: 5,
    narrationSignature: narration,
    audioSignature: [
      { fileId: 11, durationSeconds: 20 },
      { fileId: 12, durationSeconds: 100 },
    ],
    status: 'ready' as const,
    source: 'build' as const,
    offsets: [{ audioHref: 'OPS/audio.mp3', startSeconds: 15, durationSeconds: 100 }],
    mismatch: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockStat.mockResolvedValue({ mtimeMs: 1234 } as never);
    mockBuildPlaylist.mockResolvedValue(makePlaylist());
  });

  function makeFitFixture(audioDurations: (number | null)[] = [20, 100], stored: unknown = null) {
    const store = { find: vi.fn().mockResolvedValue(stored), save: vi.fn().mockResolvedValue(undefined), delete: vi.fn() };
    const fixture = makeFixture(100, readAlongFiles, undefined, store);
    fixture.bookRepo.findAudioEbookProgressSyncFiles.mockImplementation((bookId: number) =>
      Promise.resolve(bookId === 5 ? makeAudioBookFiles(audioDurations) : readAlongFiles),
    );
    fixture.bookRepo.findAudioChapterStarts.mockResolvedValue([{ startMs: 0 }, { startMs: 20_000 }]);
    vi.spyOn(fixture.service['logger'], 'log').mockImplementation(() => undefined);
    return { ...fixture, store };
  }

  it('matches a pair seen for the first time and stores the result', async () => {
    const { service, store } = makeFitFixture();

    await expect(service.resolveReadAlongFit(5, 9)).resolves.toEqual({ status: 'ready', offsets: matchedOffsets, source: 'match' });

    expect(store.find).toHaveBeenCalledWith(30, 5);
    expect(store.save).toHaveBeenCalledWith({
      ...storedRecord,
      source: 'match',
      offsets: matchedOffsets,
    });
  });

  it('stores a narration that fits no chapter run as a mismatch', async () => {
    const { service, bookRepo, store } = makeFitFixture();
    bookRepo.findAudioChapterStarts.mockResolvedValue([{ startMs: 0 }, { startMs: 60_000 }]);

    const fit = await service.resolveReadAlongFit(5, 9);

    expect(fit).toEqual({ status: 'narration_mismatch', mismatch: { narrationFile: 1, narrationSeconds: 100, chapter: 1, chapterSeconds: 60 } });
    expect(store.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'mismatch', offsets: null, mismatch: (fit as { mismatch: unknown }).mismatch }),
    );
  });

  it('places narration over audio without a chapter table', async () => {
    const { service, bookRepo } = makeFitFixture([100]);
    bookRepo.findAudioChapterStarts.mockResolvedValue([]);

    await expect(service.resolveReadAlongFit(5, 9)).resolves.toMatchObject({ status: 'ready', offsets: [{ startSeconds: 0 }] });
  });

  it('uses the stored offsets while neither narration nor audio changed, whatever the chapter table says', async () => {
    const { service, bookRepo, store } = makeFitFixture([20, 100], storedRecord);
    bookRepo.findAudioChapterStarts.mockResolvedValue([{ startMs: 0 }, { startMs: 60_000 }]);

    await expect(service.resolveReadAlongFit(5, 9)).resolves.toEqual({ status: 'ready', offsets: storedRecord.offsets, source: 'build' });

    expect(store.save).not.toHaveBeenCalled();
  });

  it('keeps the stored offsets and records new file ids when the files were re-imported with the same lengths', async () => {
    const { service, bookRepo, store } = makeFitFixture([20, 100], storedRecord);
    bookRepo.findAudioEbookProgressSyncFiles.mockImplementation((bookId: number) =>
      Promise.resolve(
        bookId === 5
          ? { primaryFileId: 41, files: [41, 42].map((id, index) => ({ ...makeFiles().files[0]!, id, durationSeconds: [20.6, 100][index]! })) }
          : readAlongFiles,
      ),
    );

    await expect(service.resolveReadAlongFit(5, 9)).resolves.toMatchObject({ status: 'ready', offsets: storedRecord.offsets });

    expect(store.save).toHaveBeenCalledWith({
      ...storedRecord,
      audioSignature: [
        { fileId: 41, durationSeconds: 20.6 },
        { fileId: 42, durationSeconds: 100 },
      ],
    });
  });

  it.each([
    ['a file length moved by more than a second', [21.5, 100]],
    ['a file was added', [20, 100, 5]],
  ])('reports changed audio without touching the record when %s', async (_, durations) => {
    const { service, store } = makeFitFixture(durations, storedRecord);

    await expect(service.resolveReadAlongFit(5, 9)).resolves.toEqual({ status: 'audio_changed' });

    expect(store.save).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();
  });

  it('matches again when the audio of a refused pair changed', async () => {
    const refused = {
      ...storedRecord,
      status: 'mismatch' as const,
      offsets: null,
      mismatch: { narrationFile: 1, narrationSeconds: 100, chapter: 1, chapterSeconds: 60 },
    };
    const { service, store } = makeFitFixture([20, 101.5], refused);

    await expect(service.resolveReadAlongFit(5, 9)).resolves.toMatchObject({ status: 'ready', source: 'match' });

    expect(store.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'ready' }));
  });

  it('matches again when the read-along narration changed', async () => {
    const { service, store } = makeFitFixture([20, 100], {
      ...storedRecord,
      narrationSignature: [{ audioHref: 'OPS/audio.mp3', durationSeconds: 90 }],
    });

    await expect(service.resolveReadAlongFit(5, 9)).resolves.toEqual({ status: 'ready', offsets: matchedOffsets, source: 'match' });

    expect(store.save).toHaveBeenCalledOnce();
  });

  it('reports a missing duration before looking for a record', async () => {
    const { service, store } = makeFitFixture([20, null]);

    await expect(service.resolveReadAlongFit(5, 9)).resolves.toEqual({ status: 'missing_duration' });

    expect(store.find).not.toHaveBeenCalled();
  });

  it('reports no narration when the read-along has no media overlay file', async () => {
    const { service, bookRepo } = makeFitFixture();
    bookRepo.findAudioEbookProgressSyncFiles.mockImplementation((bookId: number) =>
      Promise.resolve(
        bookId === 5 ? makeAudioBookFiles([20, 100]) : { primaryFileId: 20, files: makeFiles().files.filter((file) => file.id === 20) },
      ),
    );

    await expect(service.resolveReadAlongFit(5, 9)).resolves.toEqual({ status: 'no_narration' });
  });

  it('logs a failed fit and reports no narration rather than throwing', async () => {
    const { service, store } = makeFitFixture();
    store.find.mockRejectedValue(new Error('connection "lost"'));
    const warn = vi.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

    await expect(service.resolveReadAlongFit(5, 9)).resolves.toEqual({ status: 'no_narration' });

    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[book\.read_along_fit\] \[fail\] audioBookId=5 readAlongBookId=9 durationMs=\d+ errorClass=Error error="connection \\"lost\\"" - /,
      ),
    );
  });

  it('logs the match with its outcome', async () => {
    const { service } = makeFitFixture();
    const log = service['logger'].log as ReturnType<typeof vi.fn>;

    await service.resolveReadAlongFit(5, 9);

    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[book\.read_along_fit\] \[start\] audioBookId=5 readAlongBookId=9 readAlongFileId=30 builtFromAudio=false hadRecord=false - /,
      ),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[book\.read_along_fit\] \[end\] audioBookId=5 readAlongBookId=9 readAlongFileId=30 durationMs=\d+ narrationFiles=1 chapters=2 audioFiles=2 status=ready stored=true - /,
      ),
    );
  });

  it('syncs both directions through the stored offsets', async () => {
    const { service, bookRepo } = makeFitFixture([20, 100], storedRecord);

    await expect(
      service.syncReadAlongFromAudioPosition({
        userId: 7,
        audioBookId: 5,
        readAlongBookId: 9,
        audioSeconds: 90,
        audioTotalSeconds: 120,
        syncKobo: false,
        sourceUpdatedAt: SOURCE_TIME,
      }),
    ).resolves.toBe(true);
    // Stored offsets put the narration at 15 s, so 90 s is 75 s in.
    expect(bookRepo.upsertSyncedEpubProgressIfNewer).toHaveBeenCalledWith(expect.objectContaining({ positionSeconds: 75 }));

    await expect(
      service.syncAudioFromReadAlongPosition({
        userId: 7,
        audioBookId: 5,
        readAlongBookId: 9,
        bookFileId: 30,
        positionSeconds: 75,
        mediaOverlayFragment: 'OPS/chapter.xhtml#second',
        sourceUpdatedAt: SOURCE_TIME,
      }),
    ).resolves.toBe(true);
    expect(bookRepo.upsertAudioProgress).toHaveBeenCalledWith(7, 5, 12, 70, 75, SOURCE_TIME);
  });

  it('refuses both directions while the audio changed', async () => {
    const { service, bookRepo } = makeFitFixture([25, 100], storedRecord);
    const warn = vi.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

    await expect(
      service.syncReadAlongFromAudioPosition({
        userId: 7,
        audioBookId: 5,
        readAlongBookId: 9,
        audioSeconds: 90,
        audioTotalSeconds: 125,
        syncKobo: false,
        sourceUpdatedAt: SOURCE_TIME,
      }),
    ).resolves.toBe(false);
    await expect(
      service.syncAudioFromReadAlongPosition({
        userId: 7,
        audioBookId: 5,
        readAlongBookId: 9,
        bookFileId: 30,
        positionSeconds: 75,
        sourceUpdatedAt: SOURCE_TIME,
      }),
    ).resolves.toBe(false);

    expect(bookRepo.upsertSyncedEpubProgressIfNewer).not.toHaveBeenCalled();
    expect(bookRepo.upsertAudioProgress).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('matched=false reason=audio_changed - '));
  });
});
