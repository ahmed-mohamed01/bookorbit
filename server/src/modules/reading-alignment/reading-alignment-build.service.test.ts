import { createHash } from 'crypto';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import { ReadingAlignmentBuildService } from './reading-alignment-build.service';

const SPINES = [
  { spineIndex: 0, text: 'The quick brown fox jumps over the lazy dog near the river bank at dawn today' },
  { spineIndex: 1, text: 'She sells sea shells by the sea shore every single summer morning here again' },
  { spineIndex: 2, text: 'In the beginning there was nothing but silence and then a spark ignited everything around' },
];

// Verbatim slices of each spine so the matcher scores them at near-perfect confidence.
const PHRASE_SPINE_0 = 'quick brown fox jumps over the lazy dog';
const PHRASE_SPINE_1 = 'sea shells by the sea shore every single';
const PHRASE_SPINE_2 = 'beginning there was nothing but silence and then';
const GIBBERISH = 'zzz qqq www vvv uuu ttt';

const EBOOK = { id: 5, absolutePath: '/books/x.epub', sizeBytes: 1000 };
const AUDIO_FILES = [{ fileId: 9, absolutePath: '/books/x.m4b', durationSeconds: 40 }];
const TEXT_BOOK_ID = 101;
const AUDIO_BOOK_ID = 202;

function hash(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

const AUDIO_HASH = hash(AUDIO_FILES.map((f) => [f.fileId, f.absolutePath, f.durationSeconds]));
const EPUB_HASH = hash([EBOOK.id, EBOOK.absolutePath, EBOOK.sizeBytes]);

type RepoMock = {
  findEbookFile: ReturnType<typeof vi.fn>;
  resolveAudioFilesWithPaths: ReturnType<typeof vi.fn>;
  getAlignmentByPair: ReturnType<typeof vi.fn>;
  upsertAlignment: ReturnType<typeof vi.fn>;
  updateAlignmentProgress: ReturnType<typeof vi.fn>;
  setAlignmentStatus: ReturnType<typeof vi.fn>;
  clearAnchors: ReturnType<typeof vi.fn>;
  insertAnchor: ReturnType<typeof vi.fn>;
  countAnchors: ReturnType<typeof vi.fn>;
  getMaxAnchorSpineIndex: ReturnType<typeof vi.fn>;
  getMaxAnchorFraction: ReturnType<typeof vi.fn>;
};

type WhisperMock = { isAvailable: ReturnType<typeof vi.fn>; transcribeWindow: ReturnType<typeof vi.fn> };
type EpubMock = { extractSpineText: ReturnType<typeof vi.fn> };

interface Overrides {
  config?: Partial<Record<string, unknown>>;
  transcripts?: Record<number, string>;
  transcribeImpl?: (path: string, offset: number, duration: number) => Promise<string>;
  ebook?: typeof EBOOK | undefined;
  audioFiles?: typeof AUDIO_FILES;
  existing?: Record<string, unknown> | undefined;
  whisperAvailable?: boolean;
  maxAnchorSpineIndex?: number | null;
  maxAnchorFraction?: number | null;
  countAnchors?: number;
  pair?: { textBookId: number; audioBookId: number } | null;
}

function createService(overrides: Overrides = {}) {
  const config = {
    readingAlignmentEnabled: true,
    readingAlignmentSampleIntervalSec: 10,
    readingAlignmentClipSeconds: 5,
    whisperModel: 'base.en',
    ...overrides.config,
  };

  const transcripts = overrides.transcripts ?? {
    0: PHRASE_SPINE_0,
    10: PHRASE_SPINE_1,
    20: PHRASE_SPINE_2,
    30: PHRASE_SPINE_0,
  };

  const repo: RepoMock = {
    findEbookFile: vi.fn().mockResolvedValue('ebook' in overrides ? overrides.ebook : EBOOK),
    resolveAudioFilesWithPaths: vi.fn().mockResolvedValue(overrides.audioFiles ?? AUDIO_FILES),
    getAlignmentByPair: vi.fn().mockResolvedValue(overrides.existing),
    upsertAlignment: vi
      .fn()
      .mockImplementation((textBookId: number, audioBookId: number, values: Record<string, unknown>) =>
        Promise.resolve({ id: 1, textBookId, audioBookId, ...values }),
      ),
    updateAlignmentProgress: vi.fn().mockResolvedValue(undefined),
    setAlignmentStatus: vi.fn().mockResolvedValue(undefined),
    clearAnchors: vi.fn().mockResolvedValue(undefined),
    insertAnchor: vi.fn().mockResolvedValue(true),
    countAnchors: vi.fn().mockResolvedValue(overrides.countAnchors ?? (overrides.existing?.anchorCount as number | undefined) ?? 0),
    getMaxAnchorSpineIndex: vi.fn().mockResolvedValue(overrides.maxAnchorSpineIndex ?? null),
    getMaxAnchorFraction: vi.fn().mockResolvedValue(overrides.maxAnchorFraction ?? null),
  };

  const whisper: WhisperMock = {
    isAvailable: vi.fn().mockReturnValue(overrides.whisperAvailable ?? true),
    transcribeWindow: vi.fn(overrides.transcribeImpl ?? ((_path: string, offset: number) => Promise.resolve(transcripts[offset] ?? GIBBERISH))),
  };

  const epub: EpubMock = { extractSpineText: vi.fn().mockResolvedValue(SPINES) };
  const pairService = {
    resolveAlignmentPair: vi
      .fn()
      .mockResolvedValue(overrides.pair === undefined ? { textBookId: TEXT_BOOK_ID, audioBookId: AUDIO_BOOK_ID } : overrides.pair),
  };

  const syncService = { reconcilePairOnReady: vi.fn().mockResolvedValue(undefined) };
  const service = new ReadingAlignmentBuildService(
    config as never,
    repo as never,
    whisper as never,
    epub as never,
    pairService as never,
    syncService as never,
  );
  return { service, repo, whisper, epub, pairService, config, syncService };
}

const USER = { id: 42, isSuperuser: false } as unknown as RequestUser;

describe('ReadingAlignmentBuildService', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds monotonic anchors from samples and marks the alignment ready', async () => {
    const { service, repo, epub } = createService();

    await service.buildAlignment(TEXT_BOOK_ID, USER);

    const anchors = repo.insertAnchor.mock.calls.map((call) => call[0] as { audioSeconds: number; spineIndex: number });
    expect(anchors.map((a) => a.audioSeconds)).toEqual([0, 10, 20]);
    expect(anchors.map((a) => a.spineIndex)).toEqual([0, 1, 2]);

    // audioSeconds strictly increasing, spineIndex non-decreasing (monotonic windowing).
    for (let i = 1; i < anchors.length; i++) {
      expect(anchors[i]!.audioSeconds).toBeGreaterThan(anchors[i - 1]!.audioSeconds);
      expect(anchors[i]!.spineIndex).toBeGreaterThanOrEqual(anchors[i - 1]!.spineIndex);
    }

    expect(repo.findEbookFile).toHaveBeenCalledWith(TEXT_BOOK_ID);
    expect(repo.resolveAudioFilesWithPaths).toHaveBeenCalledWith(AUDIO_BOOK_ID);
    expect(repo.upsertAlignment).toHaveBeenCalledWith(TEXT_BOOK_ID, AUDIO_BOOK_ID, expect.objectContaining({ status: 'building', samplesTotal: 5 }));
    expect(epub.extractSpineText).toHaveBeenCalledWith(TEXT_BOOK_ID, EBOOK.id, USER);
    expect(repo.setAlignmentStatus).toHaveBeenCalledWith(1, 'ready', expect.objectContaining({ anchorCount: 3 }));
  });

  it('skips a sample whose transcription fails and still completes the build', async () => {
    const { service, repo, whisper } = createService({
      transcribeImpl: (_path, offset) => {
        if (offset === 10) return Promise.reject(new Error('ffmpeg blew up'));
        const map: Record<number, string> = { 0: PHRASE_SPINE_0, 20: PHRASE_SPINE_2, 30: PHRASE_SPINE_0 };
        return Promise.resolve(map[offset] ?? GIBBERISH);
      },
    });

    await service.buildAlignment(TEXT_BOOK_ID, USER);

    // The failing sample at offset 10 produced no anchor, but 0 and 20 did.
    const anchors = repo.insertAnchor.mock.calls.map((call) => call[0] as { audioSeconds: number; spineIndex: number });
    expect(anchors.map((a) => a.audioSeconds)).toEqual([0, 20]);
    expect(whisper.transcribeWindow).toHaveBeenCalledTimes(4);
    expect(repo.setAlignmentStatus).toHaveBeenCalledWith(1, 'ready', expect.objectContaining({ anchorCount: 2 }));
  });

  it('marks unalignable without transcribing when the ebook is missing', async () => {
    const { service, repo, whisper } = createService({ ebook: undefined });

    await service.buildAlignment(TEXT_BOOK_ID, USER);

    expect(repo.upsertAlignment).toHaveBeenCalledWith(TEXT_BOOK_ID, AUDIO_BOOK_ID, expect.objectContaining({ status: 'unalignable' }));
    expect(whisper.transcribeWindow).not.toHaveBeenCalled();
    expect(repo.setAlignmentStatus).not.toHaveBeenCalled();
  });

  it('marks unalignable without transcribing when there is no audio', async () => {
    const { service, repo, whisper } = createService({ audioFiles: [] });

    await service.buildAlignment(TEXT_BOOK_ID, USER);

    expect(repo.upsertAlignment).toHaveBeenCalledWith(TEXT_BOOK_ID, AUDIO_BOOK_ID, expect.objectContaining({ status: 'unalignable' }));
    expect(whisper.transcribeWindow).not.toHaveBeenCalled();
  });

  it('returns early without marking unalignable when whisper is unavailable', async () => {
    const { service, repo, whisper } = createService({ whisperAvailable: false });

    await service.buildAlignment(TEXT_BOOK_ID, USER);

    expect(whisper.transcribeWindow).not.toHaveBeenCalled();
    expect(repo.upsertAlignment).not.toHaveBeenCalled();
    expect(repo.setAlignmentStatus).not.toHaveBeenCalled();
  });

  it('returns early when reading alignment is disabled', async () => {
    const { service, repo, whisper } = createService({ config: { readingAlignmentEnabled: false } });

    await service.buildAlignment(TEXT_BOOK_ID, USER);

    expect(whisper.transcribeWindow).not.toHaveBeenCalled();
    expect(repo.upsertAlignment).not.toHaveBeenCalled();
  });

  it('resumes from samplesDone and only transcribes the remaining samples', async () => {
    const existing = {
      id: 1,
      status: 'building',
      audioContentHash: AUDIO_HASH,
      epubContentHash: EPUB_HASH,
      samplesDone: 2,
      anchorCount: 1,
    };
    const { service, repo, whisper } = createService({ existing, maxAnchorSpineIndex: 0 });

    await service.buildAlignment(TEXT_BOOK_ID, USER);

    const offsets = whisper.transcribeWindow.mock.calls.map((call) => call[1] as number);
    expect(offsets).toEqual([20, 30]);
    expect(whisper.transcribeWindow).not.toHaveBeenCalledWith('/books/x.m4b', 0, expect.anything());
    expect(repo.clearAnchors).not.toHaveBeenCalled();
    // Preset anchor (1) plus the accepted offset-20 anchor reaches the ready threshold.
    expect(repo.setAlignmentStatus).toHaveBeenCalledWith(1, 'ready', expect.objectContaining({ anchorCount: 2 }));
  });

  it('does not double-count or duplicate an anchor a crash persisted before its checkpoint (resume idempotency)', async () => {
    // Crash boundary: samples 0 and 1 checkpointed (anchorCount=2), then sample 2 (offset 20) inserted
    // its anchor but the process died before the checkpoint advanced. On disk there are 3 anchor rows
    // yet samplesDone is still 2 - so countAnchors is the truth (3), the stored checkpoint is stale (2).
    const existing = {
      id: 1,
      status: 'failed',
      audioContentHash: AUDIO_HASH,
      epubContentHash: EPUB_HASH,
      samplesDone: 2,
      anchorCount: 2,
    };
    const { service, repo } = createService({
      existing,
      countAnchors: 3,
      maxAnchorSpineIndex: 2,
      transcripts: {
        20: 'beginning there was nothing but silence',
        30: 'silence and then a spark ignited everything',
      },
    });
    // The first re-processed sample (offset 20) conflicts on (alignmentId, audioSeconds) and inserts
    // nothing; every later sample is a genuine new insert. Call order is guaranteed by the ascending loop.
    repo.insertAnchor.mockResolvedValueOnce(false);

    await service.buildAlignment(TEXT_BOOK_ID, USER);

    const offsets = repo.insertAnchor.mock.calls.map((call) => (call[0] as { audioSeconds: number }).audioSeconds);
    expect(offsets).toEqual([20, 30]); // offset 20 re-attempted (no-op), offset 30 genuinely new

    // Seeded from countAnchors (3) plus the single real insert (offset 30) = 4, equal to the row count.
    // The old code seeded from the stale checkpoint and counted the conflicting re-insert, reaching 5.
    expect(repo.setAlignmentStatus).toHaveBeenCalledWith(1, 'ready', expect.objectContaining({ anchorCount: 4 }));
  });

  it('is a no-op when hashes match an existing ready alignment', async () => {
    const existing = {
      id: 1,
      status: 'ready',
      audioContentHash: AUDIO_HASH,
      epubContentHash: EPUB_HASH,
      samplesDone: 5,
      anchorCount: 3,
    };
    const { service, repo, whisper } = createService({ existing });

    await service.buildAlignment(TEXT_BOOK_ID, USER);

    expect(repo.upsertAlignment).not.toHaveBeenCalled();
    expect(whisper.transcribeWindow).not.toHaveBeenCalled();
    expect(repo.setAlignmentStatus).not.toHaveBeenCalled();
  });

  it('marks unalignable when too few anchors are found', async () => {
    const { service, repo } = createService({ transcripts: {} });

    await service.buildAlignment(TEXT_BOOK_ID, USER);

    expect(repo.insertAnchor).not.toHaveBeenCalled();
    expect(repo.setAlignmentStatus).toHaveBeenCalledWith(1, 'unalignable', expect.objectContaining({ anchorCount: 0 }));
  });

  it('skips a concurrent build for the same book (overlap guard)', async () => {
    let releaseFirst: (value: string) => void = () => undefined;
    const gate = new Promise<string>((resolve) => {
      releaseFirst = resolve;
    });
    let firstCall = true;
    const { service, repo, whisper } = createService({
      transcribeImpl: (_path, offset) => {
        if (firstCall) {
          firstCall = false;
          return gate; // first sample of the first build hangs until released
        }
        const map: Record<number, string> = { 0: PHRASE_SPINE_0, 10: PHRASE_SPINE_1, 20: PHRASE_SPINE_2 };
        return Promise.resolve(map[offset] ?? GIBBERISH);
      },
    });

    const first = service.buildAlignment(TEXT_BOOK_ID, USER);
    // Let the first build advance until it parks on its hanging clip.
    await new Promise((resolve) => setImmediate(resolve));

    // A second call while the first holds the guard must bail out immediately.
    await service.buildAlignment(AUDIO_BOOK_ID, USER);

    const messages = logSpy.mock.calls.map((call) => call[0] as string);
    expect(messages.some((message) => message.includes('already in flight'))).toBe(true);
    expect(whisper.transcribeWindow).toHaveBeenCalledTimes(1);
    expect(repo.upsertAlignment).toHaveBeenCalledTimes(1);

    releaseFirst(PHRASE_SPINE_0);
    await first;
  });

  it('computes an ebook fraction for every anchor at build time', async () => {
    const { service, repo } = createService();

    await service.buildAlignment(TEXT_BOOK_ID, USER);

    const anchors = repo.insertAnchor.mock.calls.map((call) => call[0] as { audioSeconds: number; ebookFraction: number | null });
    expect(anchors).toHaveLength(3);
    for (const anchor of anchors) {
      expect(typeof anchor.ebookFraction).toBe('number');
      expect(Number.isFinite(anchor.ebookFraction as number)).toBe(true);
      expect(anchor.ebookFraction as number).toBeGreaterThanOrEqual(0);
      expect(anchor.ebookFraction as number).toBeLessThanOrEqual(1);
    }
    // Fractions are non-decreasing, matching the ascending audioSeconds.
    for (let i = 1; i < anchors.length; i++) {
      expect(anchors[i]!.ebookFraction as number).toBeGreaterThanOrEqual(anchors[i - 1]!.ebookFraction as number);
    }
  });

  it('rejects an anchor whose ebook fraction would move backward within a spine', async () => {
    const spine = {
      spineIndex: 0,
      text:
        'alpha bravo charlie delta echo foxtrot golf hotel india juliet ' +
        'kilo lima mike november oscar papa quebec romeo sierra tango ' +
        'uniform victor whiskey xray yankee zulu one two three four five',
    };
    const late = 'uniform victor whiskey xray yankee zulu one two';
    const early = 'alpha bravo charlie delta echo foxtrot golf hotel';
    const { service, repo, epub } = createService({ transcripts: { 0: late, 10: early } });
    epub.extractSpineText.mockResolvedValue([spine]);

    await service.buildAlignment(TEXT_BOOK_ID, USER);

    // The late phrase anchors first (high fraction); the earlier phrase at offset 10 would decrease the
    // fraction against increasing audioSeconds, so it is dropped and only the first anchor is written.
    const anchors = repo.insertAnchor.mock.calls.map((call) => call[0] as { audioSeconds: number });
    expect(anchors.map((a) => a.audioSeconds)).toEqual([0]);
  });

  it('marks the build failed with an actionable error when transcription systemically fails', async () => {
    const { service, repo, whisper } = createService({ transcribeImpl: () => Promise.reject(new Error('spawn ENOENT')) });

    await service.buildAlignment(TEXT_BOOK_ID, USER);

    // Early abort after 3 consecutive failures rather than spawning a doomed subprocess for every sample.
    expect(whisper.transcribeWindow).toHaveBeenCalledTimes(3);
    expect(repo.insertAnchor).not.toHaveBeenCalled();
    expect(repo.setAlignmentStatus).toHaveBeenCalledWith(1, 'failed', expect.objectContaining({ error: expect.stringContaining('WHISPER_PATH') }));
  });

  it('marks the alignment failed (never left building) when the build throws', async () => {
    const { service, repo, epub } = createService();
    epub.extractSpineText.mockRejectedValue(new Error('epub exploded'));

    await expect(service.buildAlignment(TEXT_BOOK_ID, USER)).rejects.toThrow('epub exploded');

    expect(repo.setAlignmentStatus).toHaveBeenCalledWith(1, 'failed', expect.objectContaining({ error: expect.stringContaining('epub exploded') }));
  });

  it('marks unalignable without transcribing when an audio file has an unknown duration', async () => {
    const { service, repo, whisper } = createService({
      audioFiles: [{ fileId: 9, absolutePath: '/books/x.m4b', durationSeconds: null }] as unknown as typeof AUDIO_FILES,
    });

    await service.buildAlignment(TEXT_BOOK_ID, USER);

    expect(repo.upsertAlignment).toHaveBeenCalledWith(
      TEXT_BOOK_ID,
      AUDIO_BOOK_ID,
      expect.objectContaining({ status: 'unalignable', error: expect.stringContaining('duration') }),
    );
    expect(whisper.transcribeWindow).not.toHaveBeenCalled();
    expect(repo.setAlignmentStatus).not.toHaveBeenCalled();
  });

  it('runs the one-shot reconcile after a build completes ready', async () => {
    const { service, syncService } = createService();

    await service.buildAlignment(TEXT_BOOK_ID, USER);

    expect(syncService.reconcilePairOnReady).toHaveBeenCalledWith({ textBookId: TEXT_BOOK_ID, audioBookId: AUDIO_BOOK_ID }, USER.id);
  });

  it('still reconciles when the build is skipped as up to date (relink of a built pair)', async () => {
    const existing = {
      id: 1,
      status: 'ready',
      audioContentHash: AUDIO_HASH,
      epubContentHash: EPUB_HASH,
      samplesDone: 5,
      anchorCount: 3,
    };
    const { service, syncService } = createService({ existing });

    await service.buildAlignment(TEXT_BOOK_ID, USER);

    expect(syncService.reconcilePairOnReady).toHaveBeenCalledWith({ textBookId: TEXT_BOOK_ID, audioBookId: AUDIO_BOOK_ID }, USER.id);
  });

  it('does not reconcile when the build ends unalignable', async () => {
    const { service, syncService } = createService({ transcripts: {} });

    await service.buildAlignment(TEXT_BOOK_ID, USER);

    expect(syncService.reconcilePairOnReady).not.toHaveBeenCalled();
  });

  it('aborts a resumed build after sustained consecutive transcription failures', async () => {
    const audioFiles = [{ fileId: 9, absolutePath: '/books/x.m4b', durationSeconds: 400 }];
    const existing = {
      id: 1,
      status: 'failed',
      audioContentHash: hash(audioFiles.map((f) => [f.fileId, f.absolutePath, f.durationSeconds])),
      epubContentHash: EPUB_HASH,
      samplesDone: 2,
      anchorCount: 1,
    };
    const { service, repo, whisper } = createService({
      audioFiles,
      existing,
      countAnchors: 1,
      maxAnchorSpineIndex: 0,
      transcribeImpl: () => Promise.reject(new Error('model unreachable')),
    });

    await service.buildAlignment(TEXT_BOOK_ID, USER);

    // Existing anchors defeat the zero-anchor early abort, but the hard ceiling still stops the burn.
    expect(whisper.transcribeWindow).toHaveBeenCalledTimes(10);
    expect(repo.setAlignmentStatus).toHaveBeenCalledWith(1, 'failed', expect.objectContaining({ anchorCount: 1 }));
  });
});
