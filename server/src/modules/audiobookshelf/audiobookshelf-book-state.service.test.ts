import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import { AudiobookshelfBookStateService } from './audiobookshelf-book-state.service';
import type { AbsBookStateView } from './audiobookshelf.repository';

function makeUser(): RequestUser {
  return {
    id: 7,
    isSuperuser: false,
    contentFilters: { includeTagIds: [], excludeTagIds: [], includeGenreIds: [], excludeGenreIds: [] },
  } as unknown as RequestUser;
}

function makeView(overrides: Partial<AbsBookStateView> = {}): AbsBookStateView {
  return {
    absLibraryItemId: 'abs-1',
    absTitle: 'ABS Title',
    absAuthorName: 'ABS Author',
    bookId: null,
    bookTitle: null,
    bookAuthorName: null,
    matchMethod: null,
    matchConfidence: null,
    needsReview: false,
    matchError: null,
    syncExcluded: false,
    syncError: null,
    lastSyncedAt: null,
    ...overrides,
  };
}

describe('AudiobookshelfBookStateService', () => {
  let repo: {
    listBookStates: ReturnType<typeof vi.fn>;
    findBookStateRow: ReturnType<typeof vi.fn>;
    findBookStateView: ReturnType<typeof vi.fn>;
    updateBookState: ReturnType<typeof vi.fn>;
  };
  let bookService: { verifyBookAccess: ReturnType<typeof vi.fn> };
  let libraryService: { findAccessibleLibraryIds: ReturnType<typeof vi.fn> };
  let service: AudiobookshelfBookStateService;

  beforeEach(() => {
    repo = {
      listBookStates: vi.fn(),
      findBookStateRow: vi.fn(),
      findBookStateView: vi.fn(),
      updateBookState: vi.fn().mockResolvedValue(undefined),
    };
    bookService = { verifyBookAccess: vi.fn().mockResolvedValue(undefined) };
    libraryService = { findAccessibleLibraryIds: vi.fn().mockResolvedValue([1, 2]) };
    service = new AudiobookshelfBookStateService(repo as never, bookService as never, libraryService as never);
  });

  it('maps a paginated bucket list to the API shape', async () => {
    repo.listBookStates.mockResolvedValue({
      items: [
        makeView({ bookId: 10, bookTitle: 'Local', bookAuthorName: 'Author', matchMethod: 'asin', lastSyncedAt: new Date('2026-05-01T00:00:00Z') }),
      ],
      total: 1,
    });

    const page = await service.list(makeUser(), { bucket: 'linked', page: 0, pageSize: 20 });

    expect(repo.listBookStates).toHaveBeenCalledWith(
      7,
      { libraryIds: [1, 2], contentFilters: { includeTagIds: [], excludeTagIds: [], includeGenreIds: [], excludeGenreIds: [] } },
      'linked',
      0,
      20,
      undefined,
    );
    expect(page).toMatchObject({ total: 1, page: 0, pageSize: 20 });
    expect(page.items[0]).toMatchObject({
      absLibraryItemId: 'abs-1',
      absTitle: 'ABS Title',
      bookId: 10,
      absCoverUrl: null,
      lastSyncedAt: '2026-05-01T00:00:00.000Z',
    });
  });

  it('confirm clears review state for a pending review match', async () => {
    repo.findBookStateRow.mockResolvedValue({ absLibraryItemId: 'abs-1', bookId: 10, needsReview: true });
    repo.findBookStateView.mockResolvedValue(makeView({ bookId: 10, needsReview: false, matchMethod: 'title_author_series' }));

    const result = await service.confirm(makeUser(), 'abs-1');

    expect(repo.updateBookState).toHaveBeenCalledWith(7, 'abs-1', { needsReview: false, matchError: null, manualUnlinked: false });
    expect(result.needsReview).toBe(false);
  });

  it('confirm rejects when a pending match no longer passes the current access scope', async () => {
    repo.findBookStateRow.mockResolvedValue({ absLibraryItemId: 'abs-1', bookId: 10, needsReview: true });
    repo.findBookStateView.mockResolvedValue(null);

    await expect(service.confirm(makeUser(), 'abs-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.updateBookState).not.toHaveBeenCalled();
  });

  it('confirm rejects an item that is not awaiting review', async () => {
    repo.findBookStateRow.mockResolvedValue({ absLibraryItemId: 'abs-1', bookId: 10, needsReview: false });
    await expect(service.confirm(makeUser(), 'abs-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.updateBookState).not.toHaveBeenCalled();
  });

  it('link verifies book access and sets a manual link', async () => {
    repo.findBookStateRow.mockResolvedValue({ absLibraryItemId: 'abs-1', bookId: null });
    repo.findBookStateView.mockResolvedValue(makeView({ bookId: 42, matchMethod: 'manual', bookTitle: 'Local' }));

    const result = await service.link(makeUser(), 'abs-1', 42);

    expect(bookService.verifyBookAccess).toHaveBeenCalledWith(42, expect.objectContaining({ id: 7 }));
    expect(repo.updateBookState).toHaveBeenCalledWith(
      7,
      'abs-1',
      expect.objectContaining({ bookId: 42, matchMethod: 'manual', needsReview: false, matchError: null, matchConfidence: null }),
    );
    expect(result.matchMethod).toBe('manual');
    expect(result.bookId).toBe(42);
  });

  it('link fails without touching state when the target book is not accessible', async () => {
    bookService.verifyBookAccess.mockRejectedValue(new NotFoundException());
    await expect(service.link(makeUser(), 'abs-1', 42)).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.updateBookState).not.toHaveBeenCalled();
  });

  it('link rejects when the ABS item is unknown', async () => {
    repo.findBookStateRow.mockResolvedValue(undefined);
    await expect(service.link(makeUser(), 'missing', 42)).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.updateBookState).not.toHaveBeenCalled();
  });

  it('unlink clears the link and match metadata', async () => {
    repo.findBookStateRow.mockResolvedValue({ absLibraryItemId: 'abs-1', bookId: 42 });
    repo.findBookStateView.mockResolvedValue(makeView({ bookId: null, matchMethod: null }));

    const result = await service.unlink(makeUser(), 'abs-1');

    expect(repo.updateBookState).toHaveBeenCalledWith(
      7,
      'abs-1',
      expect.objectContaining({ bookId: null, matchMethod: null, needsReview: false, matchError: null, manualUnlinked: true }),
    );
    expect(result.bookId).toBeNull();
    expect(result.matchMethod).toBeNull();
  });

  it('setExclusion toggles the syncExcluded flag', async () => {
    repo.findBookStateRow.mockResolvedValue({ absLibraryItemId: 'abs-1', bookId: 42 });
    repo.findBookStateView.mockResolvedValue(makeView({ syncExcluded: true }));

    const result = await service.setExclusion(makeUser(), 'abs-1', true);

    expect(repo.updateBookState).toHaveBeenCalledWith(7, 'abs-1', { syncExcluded: true });
    expect(result.syncExcluded).toBe(true);
  });

  it('rejects mutation of an existing link after access is lost', async () => {
    repo.findBookStateRow.mockResolvedValue({ absLibraryItemId: 'abs-1', bookId: 42 });
    repo.findBookStateView.mockResolvedValue(null);

    await expect(service.setExclusion(makeUser(), 'abs-1', true)).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.updateBookState).not.toHaveBeenCalled();
  });
});
