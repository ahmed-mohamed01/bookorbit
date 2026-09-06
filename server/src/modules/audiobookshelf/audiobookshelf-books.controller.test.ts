import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Permission } from '@bookorbit/types';

import { AudiobookshelfBooksController } from './audiobookshelf-books.controller';
import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';

const mockBookStateService = {
  list: vi.fn(),
  confirm: vi.fn(),
  link: vi.fn(),
  unlink: vi.fn(),
  setExclusion: vi.fn(),
};

const mockMatchService = {
  rescan: vi.fn(),
  cleanupStale: vi.fn(),
};

const mockUser = { id: 1, isSuperuser: false, permissions: [] };

function makeController() {
  return new AudiobookshelfBooksController(mockBookStateService as never, mockMatchService as never);
}

describe('AudiobookshelfBooksController', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires the AudiobookshelfSync permission at the class level', () => {
    expect(Reflect.getMetadata(PERMISSION_KEY, AudiobookshelfBooksController)).toBe(Permission.AudiobookshelfSync);
  });

  it('list threads the user and query dto to the book-state service', async () => {
    const dto = { bucket: 'linked', page: 1, pageSize: 20, q: 'dune' };
    mockBookStateService.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    const result = await makeController().list(mockUser as never, dto as never);
    expect(result).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
    expect(mockBookStateService.list).toHaveBeenCalledWith(mockUser, dto);
  });

  it('rescan delegates to the match service with the user', async () => {
    mockMatchService.rescan.mockResolvedValue({ scanned: 3 });
    const result = await makeController().rescan(mockUser as never);
    expect(result).toEqual({ scanned: 3 });
    expect(mockMatchService.rescan).toHaveBeenCalledWith(mockUser);
  });

  it('cleanupStale delegates to the match service with the user and returns its result', async () => {
    const cleanup = { removed: 4988, staleLinked: 2, staleExcluded: 1, staleManuallyUnlinked: 0, seenItems: 120 };
    mockMatchService.cleanupStale.mockResolvedValue(cleanup);

    const result = await makeController().cleanupStale(mockUser as never, {} as never);

    expect(result).toEqual(cleanup);
    expect(mockMatchService.cleanupStale).toHaveBeenCalledWith(mockUser, { includeManuallyUnlinked: false });
  });

  it('cleanupStale threads includeManuallyUnlinked through when set', async () => {
    const cleanup = { removed: 10, staleLinked: 0, staleExcluded: 0, staleManuallyUnlinked: 0, seenItems: 10 };
    mockMatchService.cleanupStale.mockResolvedValue(cleanup);

    const result = await makeController().cleanupStale(mockUser as never, { includeManuallyUnlinked: true } as never);

    expect(result).toEqual(cleanup);
    expect(mockMatchService.cleanupStale).toHaveBeenCalledWith(mockUser, { includeManuallyUnlinked: true });
  });

  it('confirm passes the item id through to the book-state service', async () => {
    mockBookStateService.confirm.mockResolvedValue({ absLibraryItemId: 'abs-1' });
    const result = await makeController().confirm(mockUser as never, 'abs-1');
    expect(result).toEqual({ absLibraryItemId: 'abs-1' });
    expect(mockBookStateService.confirm).toHaveBeenCalledWith(mockUser, 'abs-1');
  });

  it('link maps the dto bookId into the book-state service call', async () => {
    mockBookStateService.link.mockResolvedValue({ absLibraryItemId: 'abs-1', bookId: 42 });
    const result = await makeController().link(mockUser as never, 'abs-1', { bookId: 42 } as never);
    expect(result).toEqual({ absLibraryItemId: 'abs-1', bookId: 42 });
    expect(mockBookStateService.link).toHaveBeenCalledWith(mockUser, 'abs-1', 42);
  });

  it('unlink passes the item id through to the book-state service', async () => {
    mockBookStateService.unlink.mockResolvedValue({ absLibraryItemId: 'abs-1', bookId: null });
    const result = await makeController().unlink(mockUser as never, 'abs-1');
    expect(result).toEqual({ absLibraryItemId: 'abs-1', bookId: null });
    expect(mockBookStateService.unlink).toHaveBeenCalledWith(mockUser, 'abs-1');
  });

  it('setExclusion maps the dto syncExcluded flag into the book-state service call', async () => {
    mockBookStateService.setExclusion.mockResolvedValue({ absLibraryItemId: 'abs-1', syncExcluded: true });
    const result = await makeController().setExclusion(mockUser as never, 'abs-1', { syncExcluded: true } as never);
    expect(result).toEqual({ absLibraryItemId: 'abs-1', syncExcluded: true });
    expect(mockBookStateService.setExclusion).toHaveBeenCalledWith(mockUser, 'abs-1', true);
  });
});
