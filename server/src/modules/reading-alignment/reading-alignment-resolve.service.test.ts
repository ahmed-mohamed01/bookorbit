import { ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import { ReadingAlignmentResolveService } from './reading-alignment-resolve.service';

const USER = { id: 42, isSuperuser: false } as RequestUser;
const BOOK_ID = 7;
const TEXT_BOOK_ID = 8;
const AUDIO_BOOK_ID = BOOK_ID;
const EBOOK_FILE_ID = 5;

const NEWER = new Date('2026-02-02T00:00:00Z');
const OLDER = new Date('2026-01-01T00:00:00Z');

// Two anchors spanning 0..200s and fraction 0..1. Play order is two 100s files.
function anchorRows(overrides?: { secondFraction?: number | null }) {
  return [
    { id: 1, alignmentId: 3, audioSeconds: 0, spineIndex: 0, phrase: 'start', confidence: 1, ebookFraction: 0 },
    {
      id: 2,
      alignmentId: 3,
      audioSeconds: 200,
      spineIndex: 4,
      phrase: 'end',
      confidence: 1,
      ebookFraction: overrides?.secondFraction === undefined ? 1 : overrides.secondFraction,
    },
  ];
}

function playOrder() {
  return [
    { fileId: 9, durationSeconds: 100 },
    { fileId: 10, durationSeconds: 100 },
  ];
}

interface RepoMock {
  getReadyAlignmentWithAnchors: ReturnType<typeof vi.fn>;
  backfillAnchorFraction: ReturnType<typeof vi.fn>;
  getReadingProgress: ReturnType<typeof vi.fn>;
  getAudiobookProgress: ReturnType<typeof vi.fn>;
  resolveAudioPlayOrder: ReturnType<typeof vi.fn>;
}

function build(overrides?: {
  ready?: unknown;
  ebookProgress?: unknown;
  audioProgress?: unknown;
  spines?: Array<{ spineIndex: number; text: string }>;
  verifyThrows?: boolean;
  libraryId?: number | null;
  pair?: { textBookId: number; audioBookId: number } | null;
}) {
  const repo: RepoMock = {
    getReadyAlignmentWithAnchors: vi
      .fn()
      .mockResolvedValue(
        overrides?.ready === undefined ? { alignment: { id: 3, ebookFileId: EBOOK_FILE_ID }, anchors: anchorRows() } : overrides.ready,
      ),
    backfillAnchorFraction: vi.fn().mockResolvedValue(undefined),
    getReadingProgress: vi.fn().mockResolvedValue(overrides?.ebookProgress ?? undefined),
    getAudiobookProgress: vi.fn().mockResolvedValue(overrides?.audioProgress ?? undefined),
    resolveAudioPlayOrder: vi.fn().mockResolvedValue(playOrder()),
  };
  const epub = { extractSpineText: vi.fn().mockResolvedValue(overrides?.spines ?? []) };
  const bookService = {
    verifyBookAccess: overrides?.verifyThrows
      ? vi.fn().mockRejectedValue(new ForbiddenException('No access to this library'))
      : vi.fn().mockResolvedValue(undefined),
  };
  const pairService = {
    resolveAlignmentPair: vi
      .fn()
      .mockResolvedValue(overrides?.pair === undefined ? { textBookId: TEXT_BOOK_ID, audioBookId: AUDIO_BOOK_ID } : overrides.pair),
  };
  const service = new ReadingAlignmentResolveService(repo as never, epub as never, bookService as never, pairService as never);
  return { service, repo, epub, bookService, pairService };
}

describe('ReadingAlignmentResolveService.resolveResume', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns phrase + spineIndex when audio progress is newer', async () => {
    const { service } = build({
      ebookProgress: { percentage: 0, updatedAt: OLDER },
      audioProgress: { currentFileId: 10, positionSeconds: 50, percentage: 75, updatedAt: NEWER },
    });

    const result = await service.resolveResume(BOOK_ID, USER);

    // file 10 @ 50s -> 150s absolute -> fraction 0.75 -> nearest anchor is the 'end' anchor.
    expect(result).toEqual({ available: true, source: 'audio', spineIndex: 4, phrase: 'end', percentage: 75 });
  });

  it('is unavailable when audio progress is missing', async () => {
    const { service } = build({ ebookProgress: { percentage: 0, updatedAt: OLDER }, audioProgress: undefined });
    expect(await service.resolveResume(BOOK_ID, USER)).toEqual({ available: false });
  });

  it('unavailable when there is no ready alignment', async () => {
    const { service } = build({ ready: null });
    expect(await service.resolveResume(BOOK_ID, USER)).toEqual({ available: false });
  });

  it('is gracefully unavailable when the book has no alignment pair', async () => {
    const { service, repo } = build({ pair: null });

    await expect(service.resolveResume(BOOK_ID, USER)).resolves.toEqual({ available: false });
    expect(repo.getReadyAlignmentWithAnchors).not.toHaveBeenCalled();
  });

  it('unavailable when the alignment has fewer than two anchors', async () => {
    const { service } = build({ ready: { alignment: { id: 3, ebookFileId: EBOOK_FILE_ID }, anchors: [anchorRows()[0]] } });
    expect(await service.resolveResume(BOOK_ID, USER)).toEqual({ available: false });
  });

  it('backfills and persists a missing anchor fraction from spine text', async () => {
    const { service, repo, epub } = build({
      ready: { alignment: { id: 3, ebookFileId: EBOOK_FILE_ID }, anchors: anchorRows({ secondFraction: null }) },
      spines: [
        { spineIndex: 0, text: '0123456789' },
        { spineIndex: 4, text: 'xxend' },
      ],
      ebookProgress: { percentage: 25, updatedAt: OLDER },
      audioProgress: { currentFileId: 9, positionSeconds: 0, percentage: 0, updatedAt: NEWER },
    });

    const result = await service.resolveResume(BOOK_ID, USER);

    expect(epub.extractSpineText).toHaveBeenCalledWith(TEXT_BOOK_ID, EBOOK_FILE_ID, USER);
    // 'end' sits at index 2 of spine 4; cumulativeBefore = 10; total = 15 -> 12/15 = 0.8.
    expect(repo.backfillAnchorFraction).toHaveBeenCalledWith(2, 0.8);
    expect(result).toMatchObject({ available: true, source: 'audio' });
  });

  it('drops an anchor whose phrase cannot be located, falling to unavailable', async () => {
    const { service, repo } = build({
      ready: { alignment: { id: 3, ebookFileId: EBOOK_FILE_ID }, anchors: anchorRows({ secondFraction: null }) },
      spines: [{ spineIndex: 0, text: 'no phrase here' }],
      ebookProgress: { percentage: 25, updatedAt: NEWER },
    });
    expect(await service.resolveResume(BOOK_ID, USER)).toEqual({ available: false });
    expect(repo.backfillAnchorFraction).not.toHaveBeenCalled();
  });

  it('enforces content-filter-aware access on the cached-fraction path', async () => {
    const { service, bookService } = build({
      ebookProgress: { percentage: 25, updatedAt: NEWER },
      audioProgress: { currentFileId: 9, positionSeconds: 0, percentage: 0, updatedAt: OLDER },
    });
    await service.resolveResume(BOOK_ID, USER);
    expect(bookService.verifyBookAccess).toHaveBeenCalledWith(BOOK_ID, USER);
  });

  it('propagates a Forbidden from the access check', async () => {
    const { service } = build({
      verifyThrows: true,
      ebookProgress: { percentage: 25, updatedAt: NEWER },
      audioProgress: { currentFileId: 9, positionSeconds: 0, percentage: 0, updatedAt: OLDER },
    });
    await expect(service.resolveResume(BOOK_ID, USER)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
