import { describe, expect, it, vi } from 'vitest';

import { AudiobookshelfRepository } from './audiobookshelf.repository';

function makeSelectChain<T>(terminalMethod: 'limit' | 'orderBy', terminalResult: T) {
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(),
    orderBy: vi.fn(),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);

  if (terminalMethod === 'limit') chain.limit.mockResolvedValue(terminalResult);
  else chain.orderBy.mockResolvedValue(terminalResult);

  return chain;
}

describe('Audiobookshelf book queries', () => {
  it('returns content files in playback order for one book', async () => {
    const rows = [
      { id: 11, format: 'mp3', durationSeconds: 120 },
      { id: 12, format: 'm4b', durationSeconds: 3600 },
    ];
    const db = { select: vi.fn().mockReturnValue(makeSelectChain('orderBy', rows)) };
    const repo = new AudiobookshelfRepository(db as never);

    await expect(repo.findAudioFilesInPlayOrder(10)).resolves.toEqual(rows);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('groups content files by book while preserving playback order', async () => {
    const rows = [
      { bookId: 10, id: 11, format: 'mp3', durationSeconds: 120 },
      { bookId: 10, id: 12, format: 'mp3', durationSeconds: 180 },
      { bookId: 20, id: 21, format: 'm4b', durationSeconds: 3600 },
    ];
    const db = { select: vi.fn().mockReturnValue(makeSelectChain('orderBy', rows)) };
    const repo = new AudiobookshelfRepository(db as never);

    const result = await repo.findAudioFilesInPlayOrderForBooks([20, 10, 20]);

    expect(result).toEqual(
      new Map([
        [
          10,
          [
            { id: 11, format: 'mp3', durationSeconds: 120 },
            { id: 12, format: 'mp3', durationSeconds: 180 },
          ],
        ],
        [20, [{ id: 21, format: 'm4b', durationSeconds: 3600 }]],
      ]),
    );
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('returns an empty audio-file map without querying when no books are requested', async () => {
    const db = { select: vi.fn() };
    const repo = new AudiobookshelfRepository(db as never);

    await expect(repo.findAudioFilesInPlayOrderForBooks([])).resolves.toEqual(new Map());
    expect(db.select).not.toHaveBeenCalled();
  });

  it('reads and upserts Audiobookshelf audio progress', async () => {
    const progress = { userId: 1, bookId: 10, currentFileId: 12, positionSeconds: 90, percentage: 25 };
    const onConflictDoUpdate = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([progress]) });
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    const db = {
      select: vi.fn().mockReturnValue(makeSelectChain('limit', [progress])),
      insert: vi.fn().mockReturnValue({ values }),
    };
    const repo = new AudiobookshelfRepository(db as never);

    await expect(repo.findAudioProgress(1, 10)).resolves.toEqual(progress);
    await expect(repo.upsertAudioProgress(1, 10, 12, 90, 25)).resolves.toEqual(progress);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ userId: 1, bookId: 10, currentFileId: 12, positionSeconds: 90, percentage: 25 }));
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.any(Array),
        set: expect.objectContaining({ currentFileId: 12, positionSeconds: 90, percentage: 25 }),
      }),
    );
  });
});
