import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import { bookFiles, books, libraries } from '../../db/schema';
import { BookKnowledgeRepository } from './book-knowledge.repository';

function makeOrderedSelectChain<T>(rows: T) {
  const chain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return chain;
}

describe('BookKnowledgeRepository.knowledgeFileCandidates', () => {
  it('selects the ranking inputs and source fields in one query ordered by sort order and file ID', async () => {
    const rows = [{ id: 12, bookId: 9 }];
    const chain = makeOrderedSelectChain(rows);
    const db = { select: vi.fn().mockReturnValue(chain) };
    const repo = new BookKnowledgeRepository(db as never);

    await expect(repo.knowledgeFileCandidates(9)).resolves.toBe(rows);

    expect(db.select).toHaveBeenCalledExactlyOnceWith({
      id: bookFiles.id,
      bookId: bookFiles.bookId,
      format: bookFiles.format,
      role: bookFiles.role,
      absolutePath: bookFiles.absolutePath,
      fileHash: bookFiles.fileHash,
      sizeBytes: bookFiles.sizeBytes,
      mediaOverlayAvailable: bookFiles.mediaOverlayAvailable,
      primaryFileId: books.primaryFileId,
      formatPriority: libraries.formatPriority,
    });
    expect(chain.from).toHaveBeenCalledWith(bookFiles);
    expect(chain.innerJoin.mock.calls.map(([table]) => table)).toEqual([books, libraries]);
    const dialect = new PgDialect();
    expect(dialect.sqlToQuery(chain.where.mock.calls[0]![0])).toMatchObject({ sql: '"book_files"."book_id" = $1', params: [9] });
    const order = (chain.orderBy.mock.calls[0] as Parameters<PgDialect['sqlToQuery']>[0][]).map((column) => dialect.sqlToQuery(column).sql);
    expect(order).toEqual(['"book_files"."sort_order" asc', '"book_files"."id" asc']);
  });
});
