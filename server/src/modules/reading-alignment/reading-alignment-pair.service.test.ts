import { describe, expect, it, vi } from 'vitest';

import { ReadingAlignmentPairService } from './reading-alignment-pair.service';

const USER_ID = 7;

function makeRepo(options: { ebook?: boolean; audio?: boolean; readAlong?: boolean; mode?: 'auto' | 'disabled' } = {}) {
  return {
    findEbookFile: vi.fn().mockResolvedValue((options.ebook ?? true) ? { id: 1 } : undefined),
    resolveAudioPlayOrder: vi.fn().mockResolvedValue((options.audio ?? true) ? [{ fileId: 2 }] : []),
    hasReadAlong: vi.fn().mockResolvedValue(options.readAlong ?? false),
    findReadAloudSyncMode: vi.fn().mockResolvedValue(options.mode ?? 'auto'),
  };
}

describe('ReadingAlignmentPairService.resolveAlignmentPair', () => {
  it.each([
    [true, true, { textBookId: 11, audioBookId: 11 }],
    [true, false, null],
    [false, true, null],
    [false, false, null],
  ])('resolves a same-book pair with ebook=%s audio=%s', async (ebook, audio, expected) => {
    const repo = makeRepo({ ebook, audio });
    const service = new ReadingAlignmentPairService(repo as never);

    await expect(service.resolveAlignmentPair(11, USER_ID)).resolves.toEqual(expected);
    expect(repo.findEbookFile).toHaveBeenCalledWith(11);
    expect(repo.resolveAudioPlayOrder).toHaveBeenCalledWith(11);
  });

  it("has no pair for a book with a read-along, which upstream's read-aloud sync owns", async () => {
    const repo = makeRepo({ readAlong: true });
    const service = new ReadingAlignmentPairService(repo as never);

    await expect(service.resolveAlignmentPair(11, USER_ID)).resolves.toBeNull();
    expect(repo.hasReadAlong).toHaveBeenCalledWith(11);
    expect(repo.findReadAloudSyncMode).not.toHaveBeenCalled();
  });

  it.each([
    [true, { textBookId: 11, audioBookId: 11 }],
    [false, null],
  ])('with edition sync installed, pairs only when the user may use the Whisper fallback (allowed=%s)', async (allowed, expected) => {
    const repo = makeRepo();
    const editionSyncFallback = { allowsWhisperFallback: vi.fn().mockResolvedValue(allowed) };
    const service = new ReadingAlignmentPairService(repo as never, editionSyncFallback as never);

    await expect(service.resolveAlignmentPair(11, USER_ID)).resolves.toEqual(expected);
    expect(editionSyncFallback.allowsWhisperFallback).toHaveBeenCalledWith(USER_ID, 11);
  });

  it('a user gated off by edition sync gets no pair and the read-aloud mode is not read', async () => {
    const repo = makeRepo();
    const editionSyncFallback = { allowsWhisperFallback: vi.fn().mockResolvedValue(false) };
    const service = new ReadingAlignmentPairService(repo as never, editionSyncFallback as never);

    await expect(service.resolveAlignmentPair(11, USER_ID)).resolves.toBeNull();
    expect(repo.findReadAloudSyncMode).not.toHaveBeenCalled();
  });

  it("has no pair when the user's read-aloud sync mode for the book is disabled", async () => {
    const repo = makeRepo({ mode: 'disabled' });
    const editionSyncFallback = { allowsWhisperFallback: vi.fn().mockResolvedValue(true) };
    const service = new ReadingAlignmentPairService(repo as never, editionSyncFallback as never);

    await expect(service.resolveAlignmentPair(11, USER_ID)).resolves.toBeNull();
    expect(repo.findReadAloudSyncMode).toHaveBeenCalledWith(USER_ID, 11);
  });

  it('pairs when both edition sync and the read-aloud mode allow it', async () => {
    const repo = makeRepo({ mode: 'auto' });
    const editionSyncFallback = { allowsWhisperFallback: vi.fn().mockResolvedValue(true) };
    const service = new ReadingAlignmentPairService(repo as never, editionSyncFallback as never);

    await expect(service.resolveAlignmentPair(11, USER_ID)).resolves.toEqual({ textBookId: 11, audioBookId: 11 });
    expect(repo.findReadAloudSyncMode).toHaveBeenCalledWith(USER_ID, 11);
  });

  it('does not ask edition sync when the book has a read-along', async () => {
    const repo = makeRepo({ readAlong: true });
    const editionSyncFallback = { allowsWhisperFallback: vi.fn().mockResolvedValue(true) };
    const service = new ReadingAlignmentPairService(repo as never, editionSyncFallback as never);

    await expect(service.resolveAlignmentPair(11, USER_ID)).resolves.toBeNull();
    expect(editionSyncFallback.allowsWhisperFallback).not.toHaveBeenCalled();
  });
});
