import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import { AudiobookshelfCoverRefreshService } from './audiobookshelf-cover-refresh.service';

const user = { id: 42, isSuperuser: false, permissions: [] } as unknown as RequestUser;

function build() {
  const bookService = {
    resolveSelectionToIds: vi.fn().mockResolvedValue([7]),
    bulkReExtractCover: vi.fn().mockResolvedValue({ processed: 1, updated: 1 }),
  };
  const bookReadService = { findPrimaryFilesByBookIds: vi.fn().mockResolvedValue([]) };
  const repository = { findSidecarCoverCandidatesByBookIds: vi.fn().mockResolvedValue([]) };
  const metadataService = { applyCoverFromSources: vi.fn().mockResolvedValue(true) };
  const service = new AudiobookshelfCoverRefreshService(
    bookService as never,
    bookReadService as never,
    repository as never,
    metadataService as never,
  );
  return { service, bookService, bookReadService, repository, metadataService };
}

describe('AudiobookshelfCoverRefreshService', () => {
  it('requires editor access before refreshing covers', async () => {
    const { service, bookService } = build();
    await service.bulkReExtractCover([7], user);
    expect(bookService.resolveSelectionToIds).toHaveBeenCalledWith({ bookIds: [7] }, user, 'editor');
  });

  it('stops before looking up or changing covers when access is forbidden', async () => {
    const { service, bookService, repository, metadataService } = build();
    bookService.resolveSelectionToIds.mockRejectedValue(new ForbiddenException());
    await expect(service.bulkReExtractCover([7], user)).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.findSidecarCoverCandidatesByBookIds).not.toHaveBeenCalled();
    expect(bookService.bulkReExtractCover).not.toHaveBeenCalled();
    expect(metadataService.applyCoverFromSources).not.toHaveBeenCalled();
  });

  it('applies sidecar-first books separately and sums the result counts', async () => {
    const { service, bookService, bookReadService, repository, metadataService } = build();
    repository.findSidecarCoverCandidatesByBookIds.mockResolvedValue([
      {
        bookId: 7,
        absolutePath: '/books/seven/cover.jpg',
        format: 'jpg',
        organizationMode: 'book_per_folder',
        metadataPrecedence: ['sidecar', 'embedded'],
      },
    ]);
    bookReadService.findPrimaryFilesByBookIds.mockResolvedValue([{ bookId: 7, absolutePath: '/books/seven/book.epub', format: 'epub' }]);
    await expect(service.bulkReExtractCover([7, 8], user)).resolves.toEqual({ processed: 2, updated: 2 });
    expect(bookService.bulkReExtractCover).toHaveBeenCalledWith([8], user, undefined, undefined);
    expect(metadataService.applyCoverFromSources).toHaveBeenCalledWith(7, [
      { kind: 'sidecar', absolutePath: '/books/seven/cover.jpg' },
      { kind: 'embedded', absolutePath: '/books/seven/book.epub', format: 'epub' },
    ]);
  });
});
