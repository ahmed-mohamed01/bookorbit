import { describe, expect, it, vi } from 'vitest';

import { AudiobookshelfRepository } from './audiobookshelf.repository';

describe('AudiobookshelfRepository', () => {
  it('normalizes aggregate library timestamps returned as strings', async () => {
    const where = vi
      .fn<(...args: unknown[]) => Promise<Array<{ changedAt: string }>>>()
      .mockResolvedValue([{ changedAt: '2026-07-17T11:44:00.000Z' }]);
    const chain = {
      from: vi.fn<(...args: unknown[]) => unknown>(),
      leftJoin: vi.fn<(...args: unknown[]) => unknown>(),
      where,
    };
    chain.from.mockReturnValue(chain);
    chain.leftJoin.mockReturnValue(chain);
    const db = { select: vi.fn<(...args: unknown[]) => typeof chain>().mockReturnValue(chain) };
    const repository = new AudiobookshelfRepository(db as never);

    await expect(repository.findLibraryChangedAt([1])).resolves.toEqual(new Date('2026-07-17T11:44:00.000Z'));
  });
});
