import { describe, expect, it, vi } from 'vitest';

import { ReadingAlignmentPairService } from './reading-alignment-pair.service';

function build(options?: { link?: { textBookId: number; audioBookId: number }; modality?: 'text' | 'audio' | 'both' | 'none' }) {
  const editionLinkRepo = {
    findLinkForBook: vi.fn().mockResolvedValue(options?.link),
    getBookModality: vi.fn().mockResolvedValue(options?.modality ?? 'none'),
  };
  const service = new ReadingAlignmentPairService(editionLinkRepo as never);
  return { service, editionLinkRepo };
}

describe('ReadingAlignmentPairService.resolveAlignmentPair', () => {
  it('returns the linked text and audio book IDs', async () => {
    const { service, editionLinkRepo } = build({ link: { textBookId: 11, audioBookId: 22 } });

    await expect(service.resolveAlignmentPair(22)).resolves.toEqual({ textBookId: 11, audioBookId: 22 });
    expect(editionLinkRepo.getBookModality).not.toHaveBeenCalled();
  });

  it('returns a self-pair for one record with both formats', async () => {
    const { service } = build({ modality: 'both' });

    await expect(service.resolveAlignmentPair(11)).resolves.toEqual({ textBookId: 11, audioBookId: 11 });
  });

  it('returns null for an unlinked book without both formats', async () => {
    const { service } = build({ modality: 'text' });

    await expect(service.resolveAlignmentPair(11)).resolves.toBeNull();
  });
});
