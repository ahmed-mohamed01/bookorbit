import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import { AudiobookshelfRepository } from './audiobookshelf.repository';

const dialect = new PgDialect();

function compileSql(value: unknown) {
  return dialect.sqlToQuery(value as SQL);
}

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
    const chain = makeSelectChain('orderBy', rows);
    const db = { select: vi.fn().mockReturnValue(chain) };
    const repo = new AudiobookshelfRepository(db as never);

    await expect(repo.findAudioFilesInPlayOrder(10)).resolves.toEqual(rows);
    expect(compileSql(chain.where.mock.calls[0]![0])).toMatchObject({
      sql: '("book_files"."book_id" = $1 and "book_files"."role" = $2)',
      params: [10, 'content'],
    });
    expect(chain.orderBy.mock.calls[0]!.map((expression) => compileSql(expression).sql)).toEqual([
      '"book_files"."sort_order" asc',
      '"book_files"."id" asc',
    ]);
  });

  it('groups content files by book while preserving playback order', async () => {
    const rows = [
      { bookId: 10, id: 11, format: 'mp3', durationSeconds: 120 },
      { bookId: 10, id: 12, format: 'mp3', durationSeconds: 180 },
      { bookId: 20, id: 21, format: 'm4b', durationSeconds: 3600 },
    ];
    const chain = makeSelectChain('orderBy', rows);
    const db = { select: vi.fn().mockReturnValue(chain) };
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
    const whereQuery = compileSql(chain.where.mock.calls[0]![0]);
    expect(whereQuery.sql).toBe('("book_files"."book_id" in ($1, $2) and "book_files"."role" = $3)');
    expect(whereQuery.params).toEqual([20, 10, 'content']);
    expect(chain.orderBy.mock.calls[0]!.map((expression) => compileSql(expression).sql)).toEqual([
      '"book_files"."book_id" asc',
      '"book_files"."sort_order" asc',
      '"book_files"."id" asc',
    ]);
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
    const selectChain = makeSelectChain('limit', [progress]);
    const db = {
      select: vi.fn().mockReturnValue(selectChain),
      insert: vi.fn().mockReturnValue({ values }),
    };
    const repo = new AudiobookshelfRepository(db as never);

    await expect(repo.findAudioProgress(1, 10)).resolves.toEqual(progress);
    await expect(repo.upsertAudioProgress(1, 10, 12, 90, 25)).resolves.toEqual(progress);
    expect(compileSql(selectChain.where.mock.calls[0]![0])).toMatchObject({
      sql: '("audiobook_progress"."user_id" = $1 and "audiobook_progress"."book_id" = $2)',
      params: [1, 10],
    });
    expect(selectChain.limit).toHaveBeenCalledWith(1);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ userId: 1, bookId: 10, currentFileId: 12, positionSeconds: 90, percentage: 25 }));
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.any(Array),
        set: expect.objectContaining({ currentFileId: 12, positionSeconds: 90, percentage: 25 }),
      }),
    );
  });
});
