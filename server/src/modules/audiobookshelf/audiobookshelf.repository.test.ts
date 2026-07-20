import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

import { AudiobookshelfRepository } from './audiobookshelf.repository';

const dialect = new PgDialect();

function makeExactMatchDb(column: 'audible_id' | 'isbn10', storedValue: string, bookId: number) {
  let selectedKey: unknown;
  const where = vi.fn((predicate: unknown) => {
    const query = dialect.sqlToQuery(predicate as never);
    const normalizedExpression = `upper(trim("book_metadata"."${column}"))`;
    const comparedValue = query.sql.includes(`${normalizedExpression} in (`) ? storedValue.trim().toUpperCase() : storedValue;
    if (!query.params.includes(comparedValue)) return Promise.resolve([]);

    const selectedKeySql = dialect.sqlToQuery(selectedKey as never).sql;
    const key = selectedKeySql === normalizedExpression ? storedValue.trim().toUpperCase() : storedValue;
    return Promise.resolve([{ key, bookId }]);
  });
  const chain = {
    from: vi.fn<(...args: unknown[]) => unknown>(),
    innerJoin: vi.fn<(...args: unknown[]) => unknown>(),
    where,
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  const select = vi.fn((selection: { key: unknown }) => {
    selectedKey = selection.key;
    return chain;
  });

  return { db: { select }, selectedKey: () => selectedKey, where };
}

describe('AudiobookshelfRepository', () => {
  it('matches a normalized ABS ASIN against an unnormalized stored audible_id', async () => {
    const { db, selectedKey, where } = makeExactMatchDb('audible_id', '  b00asin  ', 100);
    const repository = new AudiobookshelfRepository(db as never);

    await expect(repository.findBookIdsByAudibleIds([1, 2], undefined, ['B00ASIN'])).resolves.toEqual([{ key: 'B00ASIN', bookId: 100 }]);

    expect(dialect.sqlToQuery(selectedKey() as never).sql).toBe('upper(trim("book_metadata"."audible_id"))');
    const query = dialect.sqlToQuery(where.mock.calls[0]![0] as never);
    expect(query.sql).toContain('upper(trim("book_metadata"."audible_id")) in (');
    expect(query.params).toEqual([1, 2, 'present', 'B00ASIN']);
  });

  it('matches a normalized ABS ISBN-10 against a lowercase stored isbn10', async () => {
    const { db, selectedKey, where } = makeExactMatchDb('isbn10', '080442957x', 200);
    const repository = new AudiobookshelfRepository(db as never);

    await expect(repository.findBookIdsByIsbns([3], undefined, ['080442957X'])).resolves.toEqual([{ key: '080442957X', bookId: 200 }]);

    expect(dialect.sqlToQuery(selectedKey() as never).sql).toBe('upper(trim("book_metadata"."isbn10"))');
    const query = dialect.sqlToQuery(where.mock.calls[0]![0] as never);
    expect(query.sql).toContain('upper(trim("book_metadata"."isbn10")) in (');
    expect(query.params).toEqual([3, 'present', '080442957X']);
  });

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
    const settingsRow = { id: 1, userId: 7, lastSyncError: 'provider timeout' };
    const returning = vi.fn<(...args: unknown[]) => Promise<unknown[]>>().mockResolvedValue([settingsRow]);
    const where = vi.fn<(...args: unknown[]) => { returning: typeof returning }>().mockReturnValue({ returning });
    const updateChain = { set: vi.fn<(...args: unknown[]) => { where: typeof where }>() };
    updateChain.set.mockReturnValue({ where });
    const db = { update: vi.fn<(...args: unknown[]) => typeof updateChain>().mockReturnValue(updateChain) };
    const repository = new AudiobookshelfRepository(db as never);

    await expect(repository.updateSettings(7, { lastSyncError: 'provider timeout' })).resolves.toBe(settingsRow);

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ lastSyncError: 'provider timeout', updatedAt: expect.any(Date) }));
    expect(where).toHaveBeenCalledTimes(1);
    expect(returning).toHaveBeenCalledTimes(1);
  });

  it('prunes only the user book states not seen since the reconcile run start', async () => {
    const where = vi.fn<(...args: unknown[]) => Promise<{ rowCount: number }>>().mockResolvedValue({ rowCount: 2 });
    const deleteChain = { where };
    const db = { delete: vi.fn<(...args: unknown[]) => typeof deleteChain>().mockReturnValue(deleteChain) };
    const repository = new AudiobookshelfRepository(db as never);
    const runStartedAt = new Date('2026-07-17T00:00:00.000Z');

    await expect(repository.pruneBookStatesNotSeenSince(7, runStartedAt)).resolves.toBe(2);

    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledTimes(1);
    const query = dialect.sqlToQuery(where.mock.calls[0]![0] as never);
    expect(query.sql).toContain('last_seen_in_inventory_at');
    expect(query.sql).toContain('is null');
    expect(query.params).toEqual([7, runStartedAt.toISOString()]);
  });

  it('stamps the seen marker on every observed item, chunked', async () => {
    const where = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined);
    const set = vi.fn<(...args: unknown[]) => { where: typeof where }>().mockReturnValue({ where });
    const updateChain = { set };
    const db = { update: vi.fn<(...args: unknown[]) => typeof updateChain>().mockReturnValue(updateChain) };
    const repository = new AudiobookshelfRepository(db as never);
    const seenAt = new Date('2026-07-17T00:00:00.000Z');

    await repository.markBookStatesSeenInInventory(7, ['item-1', 'item-2'], seenAt);

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({ lastSeenInInventoryAt: seenAt });
    expect(where).toHaveBeenCalledTimes(1);
  });

  it('marks nothing when the observed item list is empty', async () => {
    const db = { update: vi.fn() };
    const repository = new AudiobookshelfRepository(db as never);

    await repository.markBookStatesSeenInInventory(7, [], new Date());

    expect(db.update).not.toHaveBeenCalled();
  });
});
