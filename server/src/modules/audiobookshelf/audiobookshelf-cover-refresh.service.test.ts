import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import { AudiobookshelfCoverRefreshService } from './audiobookshelf-cover-refresh.service';

const user = { id: 42, isSuperuser: false, permissions: [] } as unknown as RequestUser;

function build() {
  const bookService = {
    resolveSelectionToIds: vi.fn().mockResolvedValue([7]),
    bulkReExtractCover: vi.fn().mockResolvedValue({ processed: 1, updated: 1 }),
    bulkItemAccess: vi.fn().mockResolvedValue('ok'),
  };
  const bookReadService = { findPrimaryFilesByBookIds: vi.fn().mockResolvedValue([]) };
  const repository = { findSidecarCoverCandidatesByBookIds: vi.fn().mockResolvedValue([]) };
  const metadataService = {
    applyCoverFromSources: vi.fn().mockResolvedValue(true),
    applyCoverSource: vi.fn().mockResolvedValue('saved'),
    refreshCoverForBook: vi.fn().mockResolvedValue(false),
  };
  const lockService = {
    getCoverLockedBookIds: vi.fn().mockResolvedValue(new Set()),
    getBookIdsWithLockedField: vi.fn().mockResolvedValue(new Set()),
  };
  const coverReconciler = { enqueue: vi.fn().mockResolvedValue(undefined) };
  const service = new AudiobookshelfCoverRefreshService(
    bookService as never,
    bookReadService as never,
    repository as never,
    metadataService as never,
    lockService as never,
    coverReconciler as never,
  );
  return { service, bookService, bookReadService, repository, metadataService, lockService, coverReconciler };
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

  describe('prepareBulkRun', () => {
    const sidecarRow = {
      bookId: 7,
      absolutePath: '/books/seven/cover.jpg',
      format: 'jpg',
      organizationMode: 'book_per_folder',
      metadataPrecedence: ['sidecar', 'embedded'],
    };

    it('leaves the run to upstream when no book ranks its sidecar first', async () => {
      const { service, repository } = build();
      await expect(service.prepareBulkRun([7, 8])).resolves.toBeNull();
      expect(repository.findSidecarCoverCandidatesByBookIds).toHaveBeenCalledWith([7, 8]);
    });

    it('looks the selection up in batches of 500', async () => {
      const { service, repository } = build();
      await service.prepareBulkRun(Array.from({ length: 1001 }, (_, index) => index + 1));
      expect(repository.findSidecarCoverCandidatesByBookIds).toHaveBeenCalledTimes(3);
      expect(repository.findSidecarCoverCandidatesByBookIds.mock.calls.map(([ids]) => ids.length)).toEqual([500, 500, 1]);
    });

    it('applies a sidecar-first book sidecar first, hands every other book back and reconciles the attempt', async () => {
      const { service, bookService, bookReadService, repository, metadataService, coverReconciler } = build();
      repository.findSidecarCoverCandidatesByBookIds.mockResolvedValue([sidecarRow]);
      bookReadService.findPrimaryFilesByBookIds.mockResolvedValue([{ bookId: 7, absolutePath: '/books/seven/book.epub', format: 'epub' }]);
      const item = (await service.prepareBulkRun([7, 8]))!;

      await expect(item(8, user)).resolves.toBeNull();
      await expect(item(7, user)).resolves.toEqual({ status: 'attempted', updated: true });
      expect(bookService.bulkItemAccess).toHaveBeenCalledWith(7, user);
      expect(bookReadService.findPrimaryFilesByBookIds).toHaveBeenCalledWith([7]);
      expect(metadataService.applyCoverSource).toHaveBeenCalledWith(7, { kind: 'sidecar', absolutePath: '/books/seven/cover.jpg' });
      expect(metadataService.refreshCoverForBook).not.toHaveBeenCalled();
      expect(coverReconciler.enqueue).toHaveBeenCalledExactlyOnceWith([7]);
    });

    it('falls back to embedded art when the sidecar gives nothing', async () => {
      const { service, bookReadService, repository, metadataService, coverReconciler } = build();
      repository.findSidecarCoverCandidatesByBookIds.mockResolvedValue([sidecarRow]);
      bookReadService.findPrimaryFilesByBookIds.mockResolvedValue([{ bookId: 7, absolutePath: '/books/seven/book.epub', format: 'epub' }]);
      metadataService.applyCoverSource.mockResolvedValue('failed');
      metadataService.refreshCoverForBook.mockResolvedValue(true);
      const item = (await service.prepareBulkRun([7]))!;

      await expect(item(7, user)).resolves.toEqual({ status: 'attempted', updated: true });
      expect(metadataService.refreshCoverForBook).toHaveBeenCalledWith(7, '/books/seven/book.epub', 'epub');
      expect(coverReconciler.enqueue).toHaveBeenCalledWith([7]);
    });

    it('counts a readable book whose art yields nothing as attempted without an update, as upstream does', async () => {
      const { service, bookReadService, repository, metadataService, coverReconciler } = build();
      repository.findSidecarCoverCandidatesByBookIds.mockResolvedValue([sidecarRow]);
      bookReadService.findPrimaryFilesByBookIds.mockResolvedValue([{ bookId: 7, absolutePath: '/books/seven/book.epub', format: 'epub' }]);
      metadataService.applyCoverSource.mockResolvedValue('failed');
      const item = (await service.prepareBulkRun([7]))!;

      await expect(item(7, user)).resolves.toEqual({ status: 'attempted', updated: false });
      expect(coverReconciler.enqueue).toHaveBeenCalledWith([7]);
    });

    it('answers no-source when the sidecar gives nothing and there is no embedded file, without reconciling', async () => {
      const { service, repository, metadataService, coverReconciler } = build();
      repository.findSidecarCoverCandidatesByBookIds.mockResolvedValue([sidecarRow]);
      metadataService.applyCoverSource.mockResolvedValue('failed');
      const item = (await service.prepareBulkRun([7]))!;

      await expect(item(7, user)).resolves.toEqual({ status: 'no-source' });
      expect(metadataService.refreshCoverForBook).not.toHaveBeenCalled();
      expect(coverReconciler.enqueue).not.toHaveBeenCalled();
    });

    it('answers locked for a book whose every cover slot is locked, without reading or reconciling', async () => {
      const { service, repository, lockService, metadataService, coverReconciler } = build();
      repository.findSidecarCoverCandidatesByBookIds.mockResolvedValue([
        sidecarRow,
        { ...sidecarRow, bookId: 9, absolutePath: '/books/nine/cover.jpg' },
      ]);
      lockService.getCoverLockedBookIds.mockResolvedValue(new Set([7, 9]));
      lockService.getBookIdsWithLockedField.mockResolvedValue(new Set([7]));
      const item = (await service.prepareBulkRun([7, 9]))!;

      await expect(item(7, user)).resolves.toEqual({ status: 'locked' });
      await expect(item(9, user)).resolves.toEqual({ status: 'attempted', updated: true });
      expect(lockService.getCoverLockedBookIds).toHaveBeenCalledExactlyOnceWith([7, 9]);
      expect(lockService.getBookIdsWithLockedField).toHaveBeenCalledExactlyOnceWith([7, 9], 'audioCover');
      expect(metadataService.applyCoverSource).toHaveBeenCalledTimes(1);
      expect(coverReconciler.enqueue).toHaveBeenCalledExactlyOnceWith([9]);
    });

    it('treats a sidecar landing in a locked slot as attempted without an update, as before', async () => {
      const { service, repository, metadataService } = build();
      repository.findSidecarCoverCandidatesByBookIds.mockResolvedValue([sidecarRow]);
      metadataService.applyCoverSource.mockResolvedValue('locked');
      const item = (await service.prepareBulkRun([7]))!;

      await expect(item(7, user)).resolves.toEqual({ status: 'attempted', updated: false });
      expect(metadataService.refreshCoverForBook).not.toHaveBeenCalled();
    });

    it('reads locks in batches of 500 for the sidecar-first books only', async () => {
      const { service, repository, lockService } = build();
      repository.findSidecarCoverCandidatesByBookIds.mockImplementation((ids: number[]) =>
        Promise.resolve(ids.filter((id) => id % 2 === 0).map((bookId) => ({ ...sidecarRow, bookId, absolutePath: `/books/${bookId}/cover.jpg` }))),
      );

      await service.prepareBulkRun(Array.from({ length: 1200 }, (_, index) => index + 1));

      expect(lockService.getCoverLockedBookIds.mock.calls.map(([ids]) => ids.length)).toEqual([500, 100]);
    });

    it('skips a sidecar-first book the actor can no longer edit', async () => {
      const { service, bookService, repository, metadataService } = build();
      repository.findSidecarCoverCandidatesByBookIds.mockResolvedValue([sidecarRow]);
      bookService.bulkItemAccess.mockResolvedValue('no-access');
      const item = (await service.prepareBulkRun([7]))!;

      await expect(item(7, user)).resolves.toEqual({ status: 'skipped', code: 'no-access' });
      expect(metadataService.applyCoverSource).not.toHaveBeenCalled();
    });

    it('counts a thrown apply as attempted without an update', async () => {
      const { service, repository, metadataService } = build();
      repository.findSidecarCoverCandidatesByBookIds.mockResolvedValue([sidecarRow]);
      metadataService.applyCoverSource.mockRejectedValue(new Error('unreadable'));
      const item = (await service.prepareBulkRun([7]))!;

      await expect(item(7, user)).resolves.toEqual({ status: 'attempted', updated: false });
    });
  });
});
