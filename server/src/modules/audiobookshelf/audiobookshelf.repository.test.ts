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

  it('updates runtime sync state without entering the settings insert path', async () => {
    const where = vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
    const updateChain = { set: vi.fn<(...args: unknown[]) => { where: typeof where }>() };
    updateChain.set.mockReturnValue({ where });
    const db = { update: vi.fn<(...args: unknown[]) => typeof updateChain>().mockReturnValue(updateChain) };
    const repository = new AudiobookshelfRepository(db as never);

    await repository.updateSettings(7, { lastSyncError: 'provider timeout' });

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ lastSyncError: 'provider timeout', updatedAt: expect.any(Date) }));
    expect(where).toHaveBeenCalledTimes(1);
  });
});
