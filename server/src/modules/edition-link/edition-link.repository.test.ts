import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EditionLinkRepository } from './edition-link.repository';
import { bookEditionLinks } from './schema/edition-link.schema';

function makeChain(result: unknown) {
  const chain: Record<string, ReturnType<typeof vi.fn>> & { then?: unknown } = {};
  const methods = ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'groupBy', 'limit', 'values', 'onConflictDoNothing', 'returning'];
  for (const method of methods) chain[method] = vi.fn(() => chain);
  chain.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

describe('EditionLinkRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getBookModality', () => {
    it.each([
      [[{ format: 'epub' }], 'text'],
      [[{ format: 'M4B' }], 'audio'],
      [[{ format: 'kepub' }, { format: 'mp3' }], 'both'],
      [[{ format: 'pdf' }, { format: null }], 'none'],
    ] as const)('detects content formats as %s', async (rows, expected) => {
      const chain = makeChain(rows);
      const repo = new EditionLinkRepository({ select: vi.fn(() => chain) } as never);

      await expect(repo.getBookModality(42)).resolves.toBe(expected);
      expect(chain.where).toHaveBeenCalledOnce();
    });
  });

  it('ranks plausible opposite-modality candidates and filters unrelated rows', async () => {
    const sourceChain = makeChain([{ title: 'Dune' }]);
    const sourceAuthorsChain = makeChain([{ name: 'Frank Herbert' }]);
    const candidatesChain = makeChain([
      { bookId: 2, title: 'Dune', authorNames: ['Frank Herbert'] },
      { bookId: 3, title: 'Cooking for Beginners', authorNames: ['Ada Baker'] },
    ]);
    const db = {
      select: vi.fn().mockReturnValueOnce(sourceChain).mockReturnValueOnce(sourceAuthorsChain).mockReturnValueOnce(candidatesChain),
    };
    const repo = new EditionLinkRepository(db as never);

    await expect(
      repo.findCounterpartCandidates({
        bookId: 1,
        modality: 'text',
        accessibleLibraryIds: [10, 11],
      }),
    ).resolves.toEqual([{ bookId: 2, title: 'Dune', authorName: 'Frank Herbert', score: 100 }]);
    expect(candidatesChain.where).toHaveBeenCalledOnce();
    expect(candidatesChain.limit).toHaveBeenCalledWith(100);
  });

  it('filters explicit candidate searches by title or author text', async () => {
    const sourceChain = makeChain([{ title: 'Dune' }]);
    const sourceAuthorsChain = makeChain([{ name: 'Frank Herbert' }]);
    const candidatesChain = makeChain([
      { bookId: 2, title: 'Dune', authorNames: ['Frank Herbert'] },
      { bookId: 3, title: 'The Left Hand of Darkness', authorNames: ['Ursula K. Le Guin'] },
    ]);
    const db = {
      select: vi.fn().mockReturnValueOnce(sourceChain).mockReturnValueOnce(sourceAuthorsChain).mockReturnValueOnce(candidatesChain),
    };
    const repo = new EditionLinkRepository(db as never);

    const results = await repo.findCounterpartCandidates({
      bookId: 1,
      modality: 'text',
      accessibleLibraryIds: [10],
      query: 'Le Guin',
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      bookId: 3,
      title: 'The Left Hand of Darkness',
      authorName: 'Ursula K. Le Guin',
    });
  });

  describe('findBookSummary', () => {
    it('resolves the counterpart title and first author in one joined query', async () => {
      const chain = makeChain([{ id: 20, title: 'Dune', authorNames: ['Frank Herbert', 'Co-Author'] }]);
      const db = { select: vi.fn(() => chain) };
      const repo = new EditionLinkRepository(db as never);

      await expect(repo.findBookSummary(20)).resolves.toEqual({ id: 20, title: 'Dune', authorName: 'Frank Herbert' });
      expect(db.select).toHaveBeenCalledOnce();
      expect(chain.where).toHaveBeenCalledOnce();
    });

    it('returns null when the book has no metadata row', async () => {
      const chain = makeChain([]);
      const db = { select: vi.fn(() => chain) };
      const repo = new EditionLinkRepository(db as never);

      await expect(repo.findBookSummary(999)).resolves.toBeNull();
    });

    it('falls back to a null author when the book has no authors', async () => {
      const chain = makeChain([{ id: 20, title: 'Dune', authorNames: [] }]);
      const db = { select: vi.fn(() => chain) };
      const repo = new EditionLinkRepository(db as never);

      await expect(repo.findBookSummary(20)).resolves.toEqual({ id: 20, title: 'Dune', authorName: null });
    });
  });

  it('inserts a correctly oriented link and returns it', async () => {
    const row = {
      id: 5,
      textBookId: 10,
      audioBookId: 20,
      createdBy: 7,
      createdAt: new Date(),
    };
    const chain = makeChain([row]);
    const db = { insert: vi.fn(() => chain) };
    const repo = new EditionLinkRepository(db as never);

    await expect(repo.insertLink(10, 20, 7)).resolves.toEqual(row);
    expect(db.insert).toHaveBeenCalledWith(bookEditionLinks);
    expect(chain.values).toHaveBeenCalledWith({ textBookId: 10, audioBookId: 20, createdBy: 7 });
    expect(chain.onConflictDoNothing).toHaveBeenCalledOnce();
  });

  it('deletes and returns the link containing a book', async () => {
    const row = {
      id: 5,
      textBookId: 10,
      audioBookId: 20,
      createdBy: 7,
      createdAt: new Date(),
    };
    const chain = makeChain([row]);
    const db = { delete: vi.fn(() => chain) };
    const repo = new EditionLinkRepository(db as never);

    await expect(repo.deleteLinkForBook(20)).resolves.toEqual(row);
    expect(db.delete).toHaveBeenCalledWith(bookEditionLinks);
    expect(chain.where).toHaveBeenCalledOnce();
  });
});
