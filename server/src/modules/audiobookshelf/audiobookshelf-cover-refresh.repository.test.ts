import { AudiobookshelfRepository } from './audiobookshelf.repository';

describe('Audiobookshelf cover refresh repository', () => {
  it('chunks large book batches and returns the union of sidecar cover candidates', async () => {
    const firstRow = {
      bookId: 1,
      absolutePath: '/library/one/cover.jpg',
      format: 'jpg',
      metadataPrecedence: ['sidecar', 'embedded'],
      organizationMode: 'book_per_folder',
    };
    const secondRow = { ...firstRow, bookId: 1001, absolutePath: '/library/one-thousand-one/cover.jpg' };
    const where = vi.fn().mockResolvedValueOnce([firstRow]).mockResolvedValueOnce([secondRow]);
    const chain = {
      from: vi.fn(),
      innerJoin: vi.fn(),
      where,
    };
    chain.from.mockReturnValue(chain);
    chain.innerJoin.mockReturnValue(chain);
    const db = { select: vi.fn().mockReturnValue(chain) };
    const repository = new AudiobookshelfRepository(db as never);

    const bookIds = Array.from({ length: 1001 }, (_, index) => index + 1);

    await expect(repository.findSidecarCoverCandidatesByBookIds(bookIds)).resolves.toEqual([firstRow, secondRow]);

    expect(db.select).toHaveBeenCalledTimes(2);
    expect(chain.innerJoin).toHaveBeenCalledTimes(4);
    expect(where).toHaveBeenCalledTimes(2);
  });

  it('does not query for an empty book batch', async () => {
    const db = { select: vi.fn() };
    const repository = new AudiobookshelfRepository(db as never);

    await expect(repository.findSidecarCoverCandidatesByBookIds([])).resolves.toEqual([]);

    expect(db.select).not.toHaveBeenCalled();
  });
});
