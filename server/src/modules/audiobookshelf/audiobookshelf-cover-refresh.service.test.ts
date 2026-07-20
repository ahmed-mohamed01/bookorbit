import type { RequestUser } from '../../common/types/request-user';
import { AudiobookshelfCoverRefreshService } from './audiobookshelf-cover-refresh.service';

const user = { id: 7 } as RequestUser;

function makeService() {
  const bookService = {
    resolveSelectionToIds: vi.fn().mockImplementation(({ bookIds }: { bookIds: number[] }) => Promise.resolve(bookIds)),
  };
  const bookReadService = {
    findPrimaryFilesByBookIds: vi.fn().mockResolvedValue([]),
  };
  const repository = {
    findSidecarCoverCandidatesByBookIds: vi.fn().mockResolvedValue([]),
  };
  const bookMetadataLockService = {
    getCoverLockedBookIds: vi.fn().mockResolvedValue(new Set<number>()),
  };
  const metadataService = {
    applyCoverFromSources: vi.fn().mockResolvedValue(false),
  };

  return {
    service: new AudiobookshelfCoverRefreshService(
      bookService as never,
      bookReadService as never,
      repository as never,
      bookMetadataLockService as never,
      metadataService as never,
    ),
    bookService,
    bookReadService,
    repository,
    bookMetadataLockService,
    metadataService,
  };
}

describe('AudiobookshelfCoverRefreshService', () => {
  it('refreshes a batch in input order with per-book precedence and organization rules', async () => {
    const { service, bookService, bookReadService, repository, bookMetadataLockService, metadataService } = makeService();
    const onProgress = vi.fn();
    const bookIds = [1, 2, 3, 4];
    bookReadService.findPrimaryFilesByBookIds.mockResolvedValue([
      { bookId: 1, absolutePath: '/library/one/book.m4b', format: 'm4b' },
      { bookId: 2, absolutePath: '/library/two/book.m4b', format: 'm4b' },
      { bookId: 3, absolutePath: '/library/three.epub', format: 'epub' },
    ]);
    repository.findSidecarCoverCandidatesByBookIds.mockResolvedValue([
      {
        bookId: 1,
        absolutePath: '/library/one/cover.jpg',
        format: 'jpg',
        metadataPrecedence: ['sidecar', 'embedded'],
        organizationMode: 'book_per_folder',
      },
      {
        bookId: 2,
        absolutePath: '/library/two/cover.jpg',
        format: 'jpg',
        metadataPrecedence: ['embedded', 'sidecar'],
        organizationMode: 'book_per_folder',
      },
      {
        bookId: 3,
        absolutePath: '/library/cover.jpg',
        format: 'jpg',
        metadataPrecedence: ['sidecar', 'embedded'],
        organizationMode: 'book_per_file',
      },
      {
        bookId: 4,
        absolutePath: '/library/four/cover.png',
        format: 'png',
        metadataPrecedence: ['sidecar', 'embedded'],
        organizationMode: 'book_per_folder',
      },
    ]);
    metadataService.applyCoverFromSources
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(service.bulkReExtractCover(bookIds, user, onProgress)).resolves.toEqual({ processed: 4, updated: 2 });

    expect(bookService.resolveSelectionToIds).toHaveBeenCalledWith({ bookIds }, user);
    expect(bookReadService.findPrimaryFilesByBookIds).toHaveBeenCalledTimes(1);
    expect(bookReadService.findPrimaryFilesByBookIds).toHaveBeenCalledWith(bookIds);
    expect(repository.findSidecarCoverCandidatesByBookIds).toHaveBeenCalledTimes(1);
    expect(repository.findSidecarCoverCandidatesByBookIds).toHaveBeenCalledWith(bookIds);
    expect(bookMetadataLockService.getCoverLockedBookIds).toHaveBeenCalledWith(bookIds);
    expect(metadataService.applyCoverFromSources).toHaveBeenNthCalledWith(1, 1, [
      { kind: 'sidecar', absolutePath: '/library/one/cover.jpg' },
      { kind: 'embedded', absolutePath: '/library/one/book.m4b', format: 'm4b' },
    ]);
    expect(metadataService.applyCoverFromSources).toHaveBeenNthCalledWith(2, 2, [
      { kind: 'embedded', absolutePath: '/library/two/book.m4b', format: 'm4b' },
      { kind: 'sidecar', absolutePath: '/library/two/cover.jpg' },
    ]);
    expect(metadataService.applyCoverFromSources).toHaveBeenNthCalledWith(3, 3, [
      { kind: 'embedded', absolutePath: '/library/three.epub', format: 'epub' },
    ]);
    expect(metadataService.applyCoverFromSources).toHaveBeenNthCalledWith(4, 4, [{ kind: 'sidecar', absolutePath: '/library/four/cover.png' }]);
    expect(onProgress.mock.calls).toEqual([[1], [2], [3], [4]]);
  });

  it('skips locked covers and stops before the next book when cancelled', async () => {
    const { service, bookReadService, bookMetadataLockService, metadataService } = makeService();
    const onProgress = vi.fn();
    const isCancelled = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValueOnce(true);
    bookReadService.findPrimaryFilesByBookIds.mockResolvedValue([
      { bookId: 1, absolutePath: '/library/one.epub', format: 'epub' },
      { bookId: 2, absolutePath: '/library/two.epub', format: 'epub' },
      { bookId: 3, absolutePath: '/library/three.epub', format: 'epub' },
    ]);
    bookMetadataLockService.getCoverLockedBookIds.mockResolvedValue(new Set([1]));
    metadataService.applyCoverFromSources.mockResolvedValue(true);

    await expect(service.bulkReExtractCover([1, 2, 3], user, onProgress, { isCancelled })).resolves.toEqual({ processed: 1, updated: 1 });

    expect(metadataService.applyCoverFromSources).toHaveBeenCalledTimes(1);
    expect(metadataService.applyCoverFromSources).toHaveBeenCalledWith(2, [{ kind: 'embedded', absolutePath: '/library/two.epub', format: 'epub' }]);
    expect(onProgress).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledWith(2);
  });

  it('stops after a progress callback interruption', async () => {
    const { service, bookReadService, metadataService } = makeService();
    bookReadService.findPrimaryFilesByBookIds.mockResolvedValue([
      { bookId: 1, absolutePath: '/library/one.epub', format: 'epub' },
      { bookId: 2, absolutePath: '/library/two.epub', format: 'epub' },
    ]);
    metadataService.applyCoverFromSources.mockResolvedValue(true);
    const onProgress = vi.fn(() => {
      throw new Error('stream closed');
    });

    await expect(service.bulkReExtractCover([1, 2], user, onProgress)).resolves.toEqual({ processed: 1, updated: 1 });

    expect(metadataService.applyCoverFromSources).toHaveBeenCalledTimes(1);
  });

  it('returns immediately for an empty batch without checking access or querying', async () => {
    const { service, bookService, bookReadService, repository, bookMetadataLockService } = makeService();

    await expect(service.bulkReExtractCover([], user)).resolves.toEqual({ processed: 0, updated: 0 });

    expect(bookService.resolveSelectionToIds).not.toHaveBeenCalled();
    expect(bookReadService.findPrimaryFilesByBookIds).not.toHaveBeenCalled();
    expect(repository.findSidecarCoverCandidatesByBookIds).not.toHaveBeenCalled();
    expect(bookMetadataLockService.getCoverLockedBookIds).not.toHaveBeenCalled();
  });

  it('bounds lookup maps by processing large selections in outer batches', async () => {
    const { service, bookReadService, repository, bookMetadataLockService } = makeService();
    const bookIds = Array.from({ length: 501 }, (_, index) => index + 1);

    await service.bulkReExtractCover(bookIds, user);

    expect(bookReadService.findPrimaryFilesByBookIds).toHaveBeenNthCalledWith(1, bookIds.slice(0, 500));
    expect(bookReadService.findPrimaryFilesByBookIds).toHaveBeenNthCalledWith(2, bookIds.slice(500));
    expect(repository.findSidecarCoverCandidatesByBookIds).toHaveBeenCalledTimes(2);
    expect(bookMetadataLockService.getCoverLockedBookIds).toHaveBeenCalledTimes(2);
  });

  it('applies covers with small bounded concurrency', async () => {
    const { service, bookReadService, metadataService } = makeService();
    const bookIds = Array.from({ length: 12 }, (_, index) => index + 1);
    bookReadService.findPrimaryFilesByBookIds.mockResolvedValue(
      bookIds.map((bookId) => ({ bookId, absolutePath: `/library/${bookId}.epub`, format: 'epub' })),
    );
    let active = 0;
    let maxActive = 0;
    metadataService.applyCoverFromSources.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      return true;
    });

    await expect(service.bulkReExtractCover(bookIds, user)).resolves.toEqual({ processed: 12, updated: 12 });

    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(5);
  });

  it('propagates access failures before loading cover candidates', async () => {
    const { service, bookService, bookReadService, repository, bookMetadataLockService } = makeService();
    const error = new Error('not accessible');
    bookService.resolveSelectionToIds.mockRejectedValue(error);

    await expect(service.bulkReExtractCover([1], user)).rejects.toBe(error);

    expect(bookReadService.findPrimaryFilesByBookIds).not.toHaveBeenCalled();
    expect(repository.findSidecarCoverCandidatesByBookIds).not.toHaveBeenCalled();
    expect(bookMetadataLockService.getCoverLockedBookIds).not.toHaveBeenCalled();
  });
});
