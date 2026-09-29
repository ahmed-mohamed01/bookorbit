import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StorytellerReadAlongOutputService } from './storyteller-read-along-output.service';
import type { StorytellerRepository } from './storyteller.repository';

describe('StorytellerReadAlongOutputService', () => {
  let repo: {
    findOutputBookIds: ReturnType<typeof vi.fn>;
    findBuildByOutputBook: ReturnType<typeof vi.fn>;
    findBuildByPair: ReturnType<typeof vi.fn>;
    updateBuild: ReturnType<typeof vi.fn>;
  };
  const link = { id: 9, textBookId: 10, audioBookId: 20, readAlongBookId: null };
  let service: StorytellerReadAlongOutputService;

  beforeEach(() => {
    repo = {
      findOutputBookIds: vi.fn().mockResolvedValue(new Set([30])),
      findBuildByOutputBook: vi.fn(),
      findBuildByPair: vi.fn(),
      updateBuild: vi.fn().mockResolvedValue(undefined),
    };
    service = new StorytellerReadAlongOutputService(repo as unknown as StorytellerRepository);
  });

  it('names the generated read-alongs, without a query for no books', async () => {
    await expect(service.findReadAlongOutputs([])).resolves.toEqual(new Set());
    expect(repo.findOutputBookIds).not.toHaveBeenCalled();

    await expect(service.findReadAlongOutputs([30, 31])).resolves.toEqual(new Set([30]));
  });

  it('names the pair a read-along was built from', async () => {
    repo.findBuildByOutputBook.mockResolvedValue({ id: 4, textBookId: 10, audioBookId: 20, outputBookId: 30 });

    await expect(service.findSourcePair(30)).resolves.toEqual({ textBookId: 10, audioBookId: 20 });
    expect(repo.findBuildByOutputBook).toHaveBeenCalledWith(30);
  });

  it('has no pair for a book no build produced', async () => {
    repo.findBuildByOutputBook.mockResolvedValue(undefined);

    await expect(service.findSourcePair(31)).resolves.toBeNull();
  });

  describe('a link that lost its read-along', () => {
    const ready = { id: 4, status: 'ready', outputBookId: 30, attachedLinkId: null as number | null };

    it("names the pair's ready output for a link it was never attached to", async () => {
      repo.findBuildByPair.mockResolvedValue({ ...ready, attachedLinkId: 5 });

      await expect(service.findLostReadAlong(link)).resolves.toEqual({ buildId: 4, outputBookId: 30 });
      expect(repo.findBuildByPair).toHaveBeenCalledWith(10, 20);
    });

    it.each([
      ['the link already carries a read-along', { ...link, readAlongBookId: 31 }, ready],
      ['it was detached from this same link on purpose', link, { ...ready, attachedLinkId: 9 }],
      ['the build is not ready', link, { ...ready, status: 'building' }],
      ['its output book was deleted', link, { ...ready, outputBookId: null }],
      ['the pair never built one', link, undefined],
    ])('names nothing when %s', async (_case, target, build) => {
      repo.findBuildByPair.mockResolvedValue(build);

      await expect(service.findLostReadAlong(target)).resolves.toBeNull();
    });

    it('records the attachment on the build', async () => {
      await service.recordAttachment(4, 9);

      expect(repo.updateBuild).toHaveBeenCalledWith(4, { attachedLinkId: 9 });
    });

    it('records a detach on the build that generated the read-along', async () => {
      repo.findBuildByOutputBook.mockResolvedValue({ ...ready, id: 4 });

      await service.recordDetach(30, 9);

      expect(repo.findBuildByOutputBook).toHaveBeenCalledWith(30);
      expect(repo.updateBuild).toHaveBeenCalledWith(4, { attachedLinkId: 9 });
    });

    it('records no detach for a book no build generated', async () => {
      repo.findBuildByOutputBook.mockResolvedValue(undefined);

      await service.recordDetach(31, 9);

      expect(repo.updateBuild).not.toHaveBeenCalled();
    });
  });
});
