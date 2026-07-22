import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { AudiobookshelfBookStateService } from './audiobookshelf-book-state.service';
import type { AbsBookStateView } from './audiobookshelf.repository';
import type { RequestUser } from '../../common/types/request-user';

const mockRepo = {
  listBookStates: vi.fn(),
  findBookStateView: vi.fn(),
  findBookStateRow: vi.fn(),
  updateBookState: vi.fn(),
};

const mockBookService = {
  verifyBookAccess: vi.fn(),
};

const mockLibraryService = {
  findAccessibleLibraryIds: vi.fn(),
};

const contentFilters = { includeTags: [], excludeTags: [] } as unknown as RequestUser['contentFilters'];

const baseUser: RequestUser = {
  id: 7,
  username: 'reader',
  name: 'Reader',
  email: null,
  active: true,
  isSuperuser: false,
  isDefaultPassword: false,
  tokenVersion: 0,
  settings: {},
  avatarUrl: null,
  provisioningMethod: 'local',
  permissions: [],
  contentFilters,
};

function makeView(overrides: Partial<AbsBookStateView> = {}): AbsBookStateView {
  return {
    absLibraryItemId: 'abs-1',
    absTitle: 'ABS Title',
    absAuthorName: 'ABS Author',
    bookId: 42,
    bookTitle: 'Book Title',
    bookAuthorName: 'Book Author',
    matchMethod: 'manual',
    matchConfidence: null,
    needsReview: false,
    matchError: null,
    syncExcluded: false,
    syncError: null,
    lastSyncedAt: new Date('2026-01-02T03:04:05.000Z'),
    ...overrides,
  };
}

function makeService() {
  return new AudiobookshelfBookStateService(mockRepo as never, mockBookService as never, mockLibraryService as never);
}

describe('AudiobookshelfBookStateService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLibraryService.findAccessibleLibraryIds.mockResolvedValue([1, 2]);
  });

  describe('list', () => {
    it('resolves scope from accessible libraries + content filters and returns the bucketed page', async () => {
      const view = makeView();
      mockRepo.listBookStates.mockResolvedValue({ items: [view], total: 1 });

      const result = await makeService().list(baseUser, { bucket: 'linked', page: 2, pageSize: 10 } as never);

      expect(mockLibraryService.findAccessibleLibraryIds).toHaveBeenCalledWith(baseUser);
      expect(mockRepo.listBookStates).toHaveBeenCalledWith(7, { libraryIds: [1, 2], contentFilters }, 'linked', 2, 10, undefined);
      expect(result).toEqual({
        items: [
          {
            absLibraryItemId: 'abs-1',
            absTitle: 'ABS Title',
            absAuthorName: 'ABS Author',
            absCoverUrl: null,
            bookId: 42,
            bookTitle: 'Book Title',
            bookAuthorName: 'Book Author',
            matchMethod: 'manual',
            matchConfidence: null,
            needsReview: false,
            matchError: null,
            syncExcluded: false,
            syncError: null,
            lastSyncedAt: '2026-01-02T03:04:05.000Z',
          },
        ],
        total: 1,
        page: 2,
        pageSize: 10,
      });
    });

    it('defaults page/pageSize and passes the search query through', async () => {
      mockRepo.listBookStates.mockResolvedValue({ items: [], total: 0 });

      const result = await makeService().list(baseUser, { bucket: 'needs-review', q: 'dune' } as never);

      expect(mockRepo.listBookStates).toHaveBeenCalledWith(7, expect.anything(), 'needs-review', 0, 20, 'dune');
      expect(result).toEqual({ items: [], total: 0, page: 0, pageSize: 20 });
    });

    it('omits content filters for superusers (scope is unfiltered)', async () => {
      mockRepo.listBookStates.mockResolvedValue({ items: [], total: 0 });
      const superuser: RequestUser = { ...baseUser, isSuperuser: true };

      await makeService().list(superuser, { bucket: 'unmatched' } as never);

      expect(mockRepo.listBookStates).toHaveBeenCalledWith(7, { libraryIds: [1, 2], contentFilters: undefined }, 'unmatched', 0, 20, undefined);
    });

    it('maps a null absTitle to an empty string', async () => {
      mockRepo.listBookStates.mockResolvedValue({ items: [makeView({ absTitle: null, lastSyncedAt: null })], total: 1 });

      const result = await makeService().list(baseUser, { bucket: 'linked' } as never);

      expect(result.items[0].absTitle).toBe('');
      expect(result.items[0].lastSyncedAt).toBeNull();
    });
  });

  describe('confirm', () => {
    it('sets bookId link confirmed (needsReview:false) and returns the refreshed view', async () => {
      const scoped = makeView({ bookId: 42, needsReview: true });
      mockRepo.findBookStateView.mockResolvedValueOnce(scoped).mockResolvedValueOnce(makeView({ needsReview: false }));

      const result = await makeService().confirm(baseUser, 'abs-1');

      expect(mockRepo.updateBookState).toHaveBeenCalledWith(7, 'abs-1', { needsReview: false, matchError: null, manualUnlinked: false });
      expect(result.needsReview).toBe(false);
    });

    it('throws NotFound when the item is out of scope / missing', async () => {
      mockRepo.findBookStateView.mockResolvedValue(null);

      await expect(makeService().confirm(baseUser, 'abs-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockRepo.updateBookState).not.toHaveBeenCalled();
    });

    it('throws BadRequest when the item is not awaiting review (no bookId)', async () => {
      mockRepo.findBookStateView.mockResolvedValue(makeView({ bookId: null, needsReview: true }));

      await expect(makeService().confirm(baseUser, 'abs-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(mockRepo.updateBookState).not.toHaveBeenCalled();
    });

    it('throws BadRequest when the item is already linked (needsReview:false)', async () => {
      mockRepo.findBookStateView.mockResolvedValue(makeView({ bookId: 42, needsReview: false }));

      await expect(makeService().confirm(baseUser, 'abs-1')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('link', () => {
    it('verifies book access and sets a manual link', async () => {
      mockRepo.findBookStateRow.mockResolvedValue({ bookId: null });
      mockRepo.findBookStateView.mockResolvedValue(makeView({ bookId: 99, matchMethod: 'manual' }));

      const result = await makeService().link(baseUser, 'abs-1', 99);

      expect(mockBookService.verifyBookAccess).toHaveBeenCalledWith(99, baseUser);
      expect(mockRepo.updateBookState).toHaveBeenCalledWith(
        7,
        'abs-1',
        expect.objectContaining({
          bookId: 99,
          matchMethod: 'manual',
          matchConfidence: null,
          needsReview: false,
          matchError: null,
          manualUnlinked: false,
        }),
      );
      expect(result.bookId).toBe(99);
    });

    it('throws NotFound when there is no ABS row for the item', async () => {
      mockRepo.findBookStateRow.mockResolvedValue(undefined);

      await expect(makeService().link(baseUser, 'abs-1', 99)).rejects.toBeInstanceOf(NotFoundException);
      expect(mockRepo.updateBookState).not.toHaveBeenCalled();
    });

    it('rejects when the currently-linked book is out of scope', async () => {
      mockRepo.findBookStateRow.mockResolvedValue({ bookId: 5 });
      mockRepo.findBookStateView.mockResolvedValue(null);

      await expect(makeService().link(baseUser, 'abs-1', 99)).rejects.toBeInstanceOf(NotFoundException);
      expect(mockRepo.updateBookState).not.toHaveBeenCalled();
    });

    it('propagates a rejected book access check without updating', async () => {
      mockBookService.verifyBookAccess.mockRejectedValueOnce(new NotFoundException());

      await expect(makeService().link(baseUser, 'abs-1', 99)).rejects.toBeInstanceOf(NotFoundException);
      expect(mockRepo.findBookStateRow).not.toHaveBeenCalled();
    });
  });

  describe('unlink', () => {
    it('clears the link and sets manualUnlinked:true', async () => {
      mockRepo.findBookStateRow.mockResolvedValue({ bookId: 42 });
      mockRepo.findBookStateView.mockResolvedValue(makeView({ bookId: null }));

      const result = await makeService().unlink(baseUser, 'abs-1');

      expect(mockRepo.updateBookState).toHaveBeenCalledWith(
        7,
        'abs-1',
        expect.objectContaining({
          bookId: null,
          matchMethod: null,
          matchConfidence: null,
          needsReview: false,
          matchError: null,
          manualUnlinked: true,
        }),
      );
      expect(result.bookId).toBeNull();
    });

    it('throws NotFound when the ABS row is missing', async () => {
      mockRepo.findBookStateRow.mockResolvedValue(undefined);

      await expect(makeService().unlink(baseUser, 'abs-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('skips the scope check when the current row has no bookId', async () => {
      mockRepo.findBookStateRow.mockResolvedValue({ bookId: null });
      mockRepo.findBookStateView.mockResolvedValue(makeView({ bookId: null }));

      await makeService().unlink(baseUser, 'abs-1');

      // Only the final viewOrThrow lookup runs, not a scope-assertion lookup.
      expect(mockRepo.findBookStateView).toHaveBeenCalledTimes(1);
    });
  });

  describe('setExclusion', () => {
    it('toggles syncExcluded', async () => {
      mockRepo.findBookStateRow.mockResolvedValue({ bookId: 42 });
      mockRepo.findBookStateView.mockResolvedValue(makeView({ syncExcluded: true }));

      const result = await makeService().setExclusion(baseUser, 'abs-1', true);

      expect(mockRepo.updateBookState).toHaveBeenCalledWith(7, 'abs-1', { syncExcluded: true });
      expect(result.syncExcluded).toBe(true);
    });

    it('throws NotFound when the ABS row is missing', async () => {
      mockRepo.findBookStateRow.mockResolvedValue(undefined);

      await expect(makeService().setExclusion(baseUser, 'abs-1', false)).rejects.toBeInstanceOf(NotFoundException);
      expect(mockRepo.updateBookState).not.toHaveBeenCalled();
    });

    it('rejects when the linked book is out of scope', async () => {
      mockRepo.findBookStateRow.mockResolvedValue({ bookId: 5 });
      mockRepo.findBookStateView.mockResolvedValue(null);

      await expect(makeService().setExclusion(baseUser, 'abs-1', true)).rejects.toBeInstanceOf(NotFoundException);
      expect(mockRepo.updateBookState).not.toHaveBeenCalled();
    });
  });
});
