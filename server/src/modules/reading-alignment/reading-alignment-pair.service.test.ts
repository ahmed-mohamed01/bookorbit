import { describe, expect, it, vi } from 'vitest';

import { ReadingAlignmentPairService } from './reading-alignment-pair.service';

describe('ReadingAlignmentPairService.resolveAlignmentPair', () => {
  it.each([
    [true, true, { textBookId: 11, audioBookId: 11 }],
    [true, false, null],
    [false, true, null],
    [false, false, null],
  ])('resolves a same-book pair with ebook=%s audio=%s', async (hasEbook, hasAudio, expected) => {
    const repo = {
      findEbookFile: vi.fn().mockResolvedValue(hasEbook ? { id: 1 } : undefined),
      resolveAudioPlayOrder: vi.fn().mockResolvedValue(hasAudio ? [{ fileId: 2 }] : []),
    };
    const service = new ReadingAlignmentPairService({ ...repo, hasReadAlong: vi.fn().mockResolvedValue(false) } as never);

    await expect(service.resolveAlignmentPair(11)).resolves.toEqual(expected);
    expect(repo.findEbookFile).toHaveBeenCalledWith(11);
    expect(repo.resolveAudioPlayOrder).toHaveBeenCalledWith(11);
  });

  it("has no pair for a book with a read-along, which upstream's read-aloud sync owns", async () => {
    const repo = {
      findEbookFile: vi.fn().mockResolvedValue({ id: 1 }),
      resolveAudioPlayOrder: vi.fn().mockResolvedValue([{ fileId: 2 }]),
      hasReadAlong: vi.fn().mockResolvedValue(true),
    };
    const service = new ReadingAlignmentPairService(repo as never);

    await expect(service.resolveAlignmentPair(11)).resolves.toBeNull();
    expect(repo.hasReadAlong).toHaveBeenCalledWith(11);
  });
});
