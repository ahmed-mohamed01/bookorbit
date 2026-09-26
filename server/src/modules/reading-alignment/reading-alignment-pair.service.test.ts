import { describe, expect, it, vi } from 'vitest';

import { ReadingAlignmentPairService } from './reading-alignment-pair.service';

function build(options?: {
  link?: { textBookId: number; audioBookId: number; readAlongBookId?: number | null };
  modality?: 'text' | 'audio' | 'both' | 'none';
}) {
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

  it('refuses to align the generated read-along member, without falling back to a self-pair', async () => {
    const { service, editionLinkRepo } = build({ link: { textBookId: 11, audioBookId: 22, readAlongBookId: 33 }, modality: 'both' });

    await expect(service.resolveAlignmentPair(33)).resolves.toBeNull();
    expect(editionLinkRepo.getBookModality).not.toHaveBeenCalled();
  });

  it('still resolves the pair from the text member of a three-way link', async () => {
    const { service } = build({ link: { textBookId: 11, audioBookId: 22, readAlongBookId: 33 } });

    await expect(service.resolveAlignmentPair(11)).resolves.toEqual({ textBookId: 11, audioBookId: 22 });
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
