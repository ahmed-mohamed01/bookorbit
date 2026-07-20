import { AudiobookshelfRepository } from './audiobookshelf.repository';

describe('Audiobookshelf cover refresh repository', () => {
  it('loads all sidecar cover candidates for a book batch in one query', async () => {
    const rows = [
      {
        bookId: 1,
        absolutePath: '/library/one/cover.jpg',
        format: 'jpg',
        metadataPrecedence: ['sidecar', 'embedded'],
        organizationMode: 'book_per_folder',
      },
    ];
    const where = vi.fn().mockResolvedValue(rows);
    const chain = {
      from: vi.fn(),
      innerJoin: vi.fn(),
      where,
    };
    chain.from.mockReturnValue(chain);
    chain.innerJoin.mockReturnValue(chain);
    const db = { select: vi.fn().mockReturnValue(chain) };
    const repository = new AudiobookshelfRepository(db as never);

    await expect(repository.findSidecarCoverCandidatesByBookIds([1, 2])).resolves.toEqual(rows);

    expect(db.select).toHaveBeenCalledTimes(1);
    expect(chain.innerJoin).toHaveBeenCalledTimes(2);
    expect(where).toHaveBeenCalledTimes(1);
  });

  it('does not query for an empty book batch', async () => {
    const db = { select: vi.fn() };
    const repository = new AudiobookshelfRepository(db as never);

    await expect(repository.findSidecarCoverCandidatesByBookIds([])).resolves.toEqual([]);

    expect(db.select).not.toHaveBeenCalled();
  });
});
