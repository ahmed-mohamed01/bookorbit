import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadGatewayException, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

import { AudiobookshelfBookStateService } from './audiobookshelf-book-state.service';
import { AudiobookshelfApiError } from './audiobookshelf-client.service';
import type { AbsBookStateView } from './audiobookshelf.repository';
import type { RequestUser } from '../../common/types/request-user';

const mockRepo = {
  listBookStates: vi.fn(),
  findBookStateView: vi.fn(),
  findBookStateRow: vi.fn(),
  updateBookState: vi.fn(),
  findSettings: vi.fn(),
  findBookStateByBookId: vi.fn(),
  findAudioProgress: vi.fn(),
};

const mockEditionLinks = {
  findLinkForBook: vi.fn(),
};

const mockClient = {
  getItemCover: vi.fn(),
  getMediaProgress: vi.fn(),
};

const mockBookService = {
  verifyBookAccess: vi.fn(),
  resolveAudiobookPositionForExternalSync: vi.fn(),
};

const mockSyncService = {
  pullPositionNow: vi.fn(),
};

const mockProgressPush = {
  pushPositionNow: vi.fn(),
};

const mockCoordinator = {
  acquireSync: vi.fn(),
  endSync: vi.fn(),
  tryStartPush: vi.fn(),
  endPush: vi.fn(),
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
    absSeriesName: 'ABS Series',
    absLibraryName: 'ABS Library',
    absPath: '/audiobooks/Author/Title',
    bookId: 42,
    bookTitle: 'Book Title',
    bookAuthorName: 'Book Author',
    bookSeriesName: 'Book Series',
    bookLibraryName: 'Book Library',
    bookFolderPath: '/books/Author/Title',
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
  return new AudiobookshelfBookStateService(
    mockRepo as never,
    mockBookService as never,
    mockLibraryService as never,
    mockEditionLinks as never,
    mockClient as never,
    mockSyncService as never,
    mockProgressPush as never,
    mockCoordinator as never,
  );
}

describe('AudiobookshelfBookStateService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLibraryService.findAccessibleLibraryIds.mockResolvedValue([1, 2]);
    mockRepo.findSettings.mockResolvedValue({ excludedLibraryIds: [] });
  });

  describe('list', () => {
    it('resolves scope from accessible libraries + content filters and returns the bucketed page', async () => {
      const view = makeView();
      mockRepo.listBookStates.mockResolvedValue({ items: [view], total: 1 });

      const result = await makeService().list(baseUser, { bucket: 'linked', page: 2, pageSize: 10 } as never);

      expect(mockLibraryService.findAccessibleLibraryIds).toHaveBeenCalledWith(baseUser);
      expect(mockRepo.listBookStates).toHaveBeenCalledWith(7, { libraryIds: [1, 2], contentFilters }, 'linked', 2, 10, undefined, []);
      expect(result).toEqual({
        items: [
          {
            absLibraryItemId: 'abs-1',
            absTitle: 'ABS Title',
            absAuthorName: 'ABS Author',
            absSeriesName: 'ABS Series',
            absLibraryName: 'ABS Library',
            absPath: '/audiobooks/Author/Title',
            bookId: 42,
            bookTitle: 'Book Title',
            bookAuthorName: 'Book Author',
            bookSeriesName: 'Book Series',
            bookLibraryName: 'Book Library',
            bookFolderPath: '/books/Author/Title',
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

    it('maps the six review-context fields through unchanged, null when unlinked and populated when linked', async () => {
      const unlinked = makeView({
        bookId: null,
        bookTitle: null,
        bookAuthorName: null,
        bookSeriesName: null,
        bookLibraryName: null,
        bookFolderPath: null,
      });
      const linked = makeView({ bookId: 42 });
      mockRepo.listBookStates.mockResolvedValue({ items: [unlinked, linked], total: 2 });

      const result = await makeService().list(baseUser, { bucket: 'linked' } as never);

      expect(result.items[0]).toMatchObject({
        absSeriesName: 'ABS Series',
        absLibraryName: 'ABS Library',
        absPath: '/audiobooks/Author/Title',
        bookSeriesName: null,
        bookLibraryName: null,
        bookFolderPath: null,
      });
      expect(result.items[1]).toMatchObject({
        absSeriesName: 'ABS Series',
        absLibraryName: 'ABS Library',
        absPath: '/audiobooks/Author/Title',
        bookSeriesName: 'Book Series',
        bookLibraryName: 'Book Library',
        bookFolderPath: '/books/Author/Title',
      });
    });

    it('defaults page/pageSize and passes the search query through', async () => {
      mockRepo.listBookStates.mockResolvedValue({ items: [], total: 0 });

      const result = await makeService().list(baseUser, { bucket: 'needs-review', q: 'dune' } as never);

      expect(mockRepo.listBookStates).toHaveBeenCalledWith(7, expect.anything(), 'needs-review', 0, 20, 'dune', []);
      expect(result).toEqual({ items: [], total: 0, page: 0, pageSize: 20 });
    });

    it('omits content filters for superusers (scope is unfiltered)', async () => {
      mockRepo.listBookStates.mockResolvedValue({ items: [], total: 0 });
      const superuser: RequestUser = { ...baseUser, isSuperuser: true };

      await makeService().list(superuser, { bucket: 'unmatched' } as never);

      expect(mockRepo.listBookStates).toHaveBeenCalledWith(7, { libraryIds: [1, 2], contentFilters: undefined }, 'unmatched', 0, 20, undefined, []);
    });

    it("passes the user's deselected ABS library ids from settings through to the repository", async () => {
      mockRepo.listBookStates.mockResolvedValue({ items: [], total: 0 });
      mockRepo.findSettings.mockResolvedValue({ excludedLibraryIds: ['lib-graphicaudio'] });

      await makeService().list(baseUser, { bucket: 'needs-review' } as never);

      expect(mockRepo.listBookStates).toHaveBeenCalledWith(7, expect.anything(), 'needs-review', 0, 20, undefined, ['lib-graphicaudio']);
    });

    it('falls back to an empty excluded-id list when settings are missing', async () => {
      mockRepo.listBookStates.mockResolvedValue({ items: [], total: 0 });
      mockRepo.findSettings.mockResolvedValue(undefined);

      await makeService().list(baseUser, { bucket: 'unmatched' } as never);

      expect(mockRepo.listBookStates).toHaveBeenCalledWith(7, expect.anything(), 'unmatched', 0, 20, undefined, []);
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

describe('AudiobookshelfBookStateService.findPositionSyncLink', () => {
  const syncSettings = (overrides: Record<string, unknown> = {}) => ({
    enabled: true,
    serverUrl: 'https://abs.example.com',
    apiToken: 'token',
    syncPosition: true,
    pushPosition: true,
    excludedLibraryIds: [],
    ...overrides,
  });
  const audiobookState = (overrides: Record<string, unknown> = {}) => ({
    absLibraryItemId: 'abs-1',
    bookId: 218,
    absTitle: 'Alcatraz vs. the Evil Librarians',
    absAuthorName: 'Brandon Sanderson',
    absLibraryName: 'Fiction',
    absLibraryId: 'lib-fiction',
    pushPendingAt: null,
    lastSyncedPositionAbsUpdate: 5000,
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockBookService.verifyBookAccess.mockResolvedValue(undefined);
    mockRepo.findSettings.mockResolvedValue(syncSettings());
    mockRepo.findBookStateByBookId.mockResolvedValue(audiobookState());
    mockEditionLinks.findLinkForBook.mockResolvedValue(undefined);
    mockClient.getMediaProgress.mockResolvedValue({ progress: 0.25, isFinished: false, lastUpdate: 5000 });
  });

  it('describes the matched item and a two-way link from the database alone', async () => {
    await expect(makeService().findPositionSyncLink(baseUser, 218)).resolves.toEqual({
      audioBookId: 218,
      absLibraryItemId: 'abs-1',
      title: 'Alcatraz vs. the Evil Librarians',
      authorName: 'Brandon Sanderson',
      libraryName: 'Fiction',
      direction: 'two_way',
      syncing: true,
      pausedReason: null,
      webUrl: 'https://abs.example.com/item/abs-1',
    });
    expect(mockClient.getMediaProgress).not.toHaveBeenCalled();
    expect(mockBookService.verifyBookAccess).toHaveBeenCalledWith(218, baseUser);
  });

  it.each([
    [{ pushPosition: false }, 'from_abs'],
    [{ syncPosition: false }, 'to_abs'],
  ])('reports a one-way link for %o', async (overrides, direction) => {
    mockRepo.findSettings.mockResolvedValue(syncSettings(overrides));

    await expect(makeService().findPositionSyncLink(baseUser, 218)).resolves.toMatchObject({ direction });
  });

  it('reaches the item through the linked audiobook for a read-along or ebook', async () => {
    mockRepo.findBookStateByBookId.mockResolvedValueOnce(undefined).mockResolvedValueOnce(audiobookState());
    mockEditionLinks.findLinkForBook.mockResolvedValue({ audioBookId: 218, textBookId: 163, readAlongBookId: 307 });

    await expect(makeService().findPositionSyncLink(baseUser, 307)).resolves.toMatchObject({ audioBookId: 218, direction: 'two_way' });
    expect(mockRepo.findBookStateByBookId).toHaveBeenNthCalledWith(2, baseUser.id, 218);
    expect(mockBookService.verifyBookAccess).toHaveBeenCalledWith(218, baseUser);
  });

  it('returns nothing when the linked audiobook is not visible to the user', async () => {
    mockRepo.findBookStateByBookId.mockResolvedValueOnce(undefined).mockResolvedValueOnce(audiobookState());
    mockEditionLinks.findLinkForBook.mockResolvedValue({ audioBookId: 218, textBookId: 163, readAlongBookId: 307 });
    mockBookService.verifyBookAccess.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new NotFoundException());

    await expect(makeService().findPositionSyncLink(baseUser, 307)).resolves.toBeNull();
  });

  it.each([
    ['sync is switched off', { enabled: false }],
    ['the connection is incomplete', { apiToken: null }],
  ])('returns nothing when %s', async (_label, overrides) => {
    mockRepo.findSettings.mockResolvedValue(syncSettings(overrides));

    await expect(makeService().findPositionSyncLink(baseUser, 218)).resolves.toBeNull();
    expect(mockRepo.findBookStateByBookId).not.toHaveBeenCalled();
  });

  it('returns nothing for an item in an excluded Audiobookshelf library', async () => {
    mockRepo.findSettings.mockResolvedValue(syncSettings({ excludedLibraryIds: ['lib-fiction'] }));

    await expect(makeService().findPositionSyncLink(baseUser, 218)).resolves.toBeNull();
  });

  it.each([
    ['a match that failed', { matchError: 'ambiguous' }],
    ['an item the user unlinked', { manualUnlinked: true }],
    ['an unmatched item', { bookId: null }],
  ])('returns nothing for %s, which the pull would not sync either', async (_label, overrides) => {
    mockRepo.findBookStateByBookId.mockResolvedValue(audiobookState(overrides));

    await expect(makeService().findPositionSyncLink(baseUser, 218)).resolves.toBeNull();
  });

  it.each([
    ['needs_review', { needsReview: true }],
    ['excluded', { syncExcluded: true }],
  ] as const)('returns a paused link for %s', async (pausedReason, overrides) => {
    mockRepo.findBookStateByBookId.mockResolvedValue(audiobookState(overrides));

    await expect(makeService().findPositionSyncLink(baseUser, 218)).resolves.toMatchObject({ syncing: false, pausedReason });
  });

  it('returns a paused link when position sync is off in both directions', async () => {
    mockRepo.findSettings.mockResolvedValue(syncSettings({ syncPosition: false, pushPosition: false }));

    await expect(makeService().findPositionSyncLink(baseUser, 218)).resolves.toMatchObject({
      direction: 'to_abs',
      syncing: false,
      pausedReason: 'position_sync_off',
    });
  });

  it('returns nothing when no settings exist', async () => {
    mockRepo.findSettings.mockResolvedValue(undefined);

    await expect(makeService().findPositionSyncLink(baseUser, 218)).resolves.toBeNull();
    expect(mockRepo.findBookStateByBookId).not.toHaveBeenCalled();
  });

  it('returns nothing for a book with no Audiobookshelf match and no link', async () => {
    mockRepo.findBookStateByBookId.mockResolvedValue(undefined);

    await expect(makeService().findPositionSyncLink(baseUser, 99)).resolves.toBeNull();
  });
});

describe('AudiobookshelfBookStateService.getCoverThumbnail', () => {
  const settings = {
    enabled: true,
    serverUrl: 'https://abs.example.com',
    apiToken: 'token',
    syncPosition: true,
    pushPosition: false,
    excludedLibraryIds: [],
  };
  const cover = { contentType: 'image/webp', body: Buffer.from([1, 2]) };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRepo.findSettings.mockResolvedValue(settings);
    mockRepo.findBookStateRow.mockResolvedValue({ absLibraryItemId: 'abs-1', bookId: 218 });
    mockBookService.verifyBookAccess.mockResolvedValue(undefined);
    mockClient.getItemCover.mockResolvedValue(cover);
  });

  it('fetches the cover of an item matched to a visible book with the user token', async () => {
    await expect(makeService().getCoverThumbnail(baseUser, 'abs-1', 80)).resolves.toBe(cover);
    expect(mockRepo.findBookStateRow).toHaveBeenCalledWith(baseUser.id, 'abs-1');
    expect(mockBookService.verifyBookAccess).toHaveBeenCalledWith(218, baseUser);
    expect(mockClient.getItemCover).toHaveBeenCalledWith(baseUser.id, 'https://abs.example.com', 'token', 'abs-1', 80);
  });

  it.each([
    ['an item that is not one of the user matches', () => mockRepo.findBookStateRow.mockResolvedValue(undefined)],
    ['an unmatched item', () => mockRepo.findBookStateRow.mockResolvedValue({ absLibraryItemId: 'abs-1', bookId: null })],
    ['a disconnected account', () => mockRepo.findSettings.mockResolvedValue({ ...settings, enabled: false })],
    ['an item without a cover', () => mockClient.getItemCover.mockResolvedValue(null)],
  ])('answers not found for %s', async (_label, arrange) => {
    arrange();

    await expect(makeService().getCoverThumbnail(baseUser, 'abs-1', 80)).rejects.toThrow(NotFoundException);
  });

  it.each([
    ['no position sync in either direction', () => mockRepo.findSettings.mockResolvedValue({ ...settings, syncPosition: false })],
    ['an excluded Audiobookshelf library', () => mockRepo.findSettings.mockResolvedValue({ ...settings, excludedLibraryIds: ['lib-1'] })],
    [
      'a match awaiting review',
      () => mockRepo.findBookStateRow.mockResolvedValue({ absLibraryItemId: 'abs-1', bookId: 218, absLibraryId: 'lib-1', needsReview: true }),
    ],
  ])('applies the panel gates and never fetches for %s', async (_label, arrange) => {
    mockRepo.findBookStateRow.mockResolvedValue({ absLibraryItemId: 'abs-1', bookId: 218, absLibraryId: 'lib-1' });
    arrange();

    await expect(makeService().getCoverThumbnail(baseUser, 'abs-1', 80)).rejects.toThrow(NotFoundException);
    expect(mockClient.getItemCover).not.toHaveBeenCalled();
  });

  it('never fetches for a book the user cannot see', async () => {
    mockBookService.verifyBookAccess.mockRejectedValue(new NotFoundException());

    await expect(makeService().getCoverThumbnail(baseUser, 'abs-1', 80)).rejects.toThrow(NotFoundException);
    expect(mockClient.getItemCover).not.toHaveBeenCalled();
  });

  it('reports an unreachable Audiobookshelf as a bad gateway', async () => {
    mockClient.getItemCover.mockRejectedValue(new AudiobookshelfApiError('down', 'network'));

    await expect(makeService().getCoverThumbnail(baseUser, 'abs-1', 80)).rejects.toThrow(BadGatewayException);
  });
});

describe('AudiobookshelfBookStateService.getLiveSyncStatus', () => {
  const settings = (overrides: Record<string, unknown> = {}) => ({
    enabled: true,
    serverUrl: 'https://abs.example.com',
    apiToken: 'token',
    syncPosition: true,
    pushPosition: true,
    excludedLibraryIds: [],
    ...overrides,
  });
  const row = (overrides: Record<string, unknown> = {}) => ({
    absLibraryItemId: 'abs-1',
    absLibraryId: 'lib-1',
    bookId: 218,
    needsReview: false,
    matchError: null,
    syncExcluded: false,
    manualUnlinked: false,
    pushPendingAt: null,
    lastSyncedPositionAbsUpdate: 5000,
    lastSyncedProgressAt: null,
    lastSyncedAt: null,
    syncError: null,
    updatedAt: new Date(0),
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockRepo.findSettings.mockResolvedValue(settings());
    mockRepo.findBookStateRow.mockResolvedValue(row());
    mockBookService.verifyBookAccess.mockResolvedValue(undefined);
    mockClient.getMediaProgress.mockResolvedValue({ progress: 0.25, isFinished: false, lastUpdate: 5000 });
    mockRepo.findAudioProgress.mockResolvedValue(undefined);
  });

  it('reads Audiobookshelf progress with a short timeout and reports it in sync', async () => {
    await expect(makeService().getLiveSyncStatus(baseUser, 'abs-1')).resolves.toEqual({
      status: 'synced',
      progress: { percentage: 25, isFinished: false, lastUpdate: 5000 },
      local: null,
      divergedReason: null,
    });
    expect(mockClient.getMediaProgress).toHaveBeenCalledWith(baseUser.id, 'https://abs.example.com', 'token', 'abs-1', 4000);
    expect(mockBookService.verifyBookAccess).toHaveBeenCalledWith(218, baseUser);
  });

  it('reports an unreachable server instead of failing', async () => {
    mockClient.getMediaProgress.mockRejectedValue(new AudiobookshelfApiError('timed out', 'timeout'));

    await expect(makeService().getLiveSyncStatus(baseUser, 'abs-1')).resolves.toEqual({
      status: 'unreachable',
      progress: null,
      local: null,
      divergedReason: null,
    });
  });

  it('reports no progress for an item Audiobookshelf has none for yet', async () => {
    mockClient.getMediaProgress.mockResolvedValue(null);

    await expect(makeService().getLiveSyncStatus(baseUser, 'abs-1')).resolves.toEqual({
      status: 'synced',
      progress: null,
      local: null,
      divergedReason: null,
    });
  });

  it('reports a waiting push as sending when the local position is newer', async () => {
    mockRepo.findBookStateRow.mockResolvedValue(row({ pushPendingAt: new Date() }));
    mockRepo.findAudioProgress.mockResolvedValue({ capturedAt: new Date(8000), updatedAt: new Date(8000) });
    mockClient.getMediaProgress.mockResolvedValue({ progress: 0.3, isFinished: false, lastUpdate: 7000 });

    await expect(makeService().getLiveSyncStatus(baseUser, 'abs-1')).resolves.toMatchObject({ status: 'sending' });
    expect(mockRepo.findAudioProgress).toHaveBeenCalledWith(baseUser.id, 218);
  });

  it('reports receiving when a newer Audiobookshelf position beats a waiting push', async () => {
    mockRepo.findBookStateRow.mockResolvedValue(row({ pushPendingAt: new Date() }));
    mockRepo.findAudioProgress.mockResolvedValue({ capturedAt: new Date(6000), updatedAt: new Date(6000) });
    mockClient.getMediaProgress.mockResolvedValue({ progress: 0.3, isFinished: false, lastUpdate: 9000 });

    await expect(makeService().getLiveSyncStatus(baseUser, 'abs-1')).resolves.toMatchObject({ status: 'receiving' });
  });

  it('does not report sending when the local position was already pushed', async () => {
    mockRepo.findBookStateRow.mockResolvedValue(row({ pushPendingAt: new Date(), lastSyncedProgressAt: new Date(8000) }));
    mockRepo.findAudioProgress.mockResolvedValue({ capturedAt: new Date(8000), updatedAt: new Date(8000) });

    await expect(makeService().getLiveSyncStatus(baseUser, 'abs-1')).resolves.toMatchObject({ status: 'synced' });
  });

  it('reports a newer Audiobookshelf position as receiving only when positions are pulled', async () => {
    mockClient.getMediaProgress.mockResolvedValue({ progress: 0.3, isFinished: false, lastUpdate: 9000 });
    await expect(makeService().getLiveSyncStatus(baseUser, 'abs-1')).resolves.toMatchObject({ status: 'receiving' });

    mockRepo.findSettings.mockResolvedValue(settings({ syncPosition: false }));
    await expect(makeService().getLiveSyncStatus(baseUser, 'abs-1')).resolves.toMatchObject({ status: 'synced' });
  });

  it('reports synced for a position the pull already looked at and refused', async () => {
    mockRepo.findBookStateRow.mockResolvedValue(row({ lastSyncedAt: new Date(9500) }));
    mockClient.getMediaProgress.mockResolvedValue({ progress: 0.3, isFinished: false, lastUpdate: 9000 });

    await expect(makeService().getLiveSyncStatus(baseUser, 'abs-1')).resolves.toMatchObject({ status: 'synced' });
  });

  it('reports synced for a position whose pull attempt failed after the Audiobookshelf update', async () => {
    mockRepo.findBookStateRow.mockResolvedValue(row({ lastSyncedAt: new Date(1000), syncError: 'no audio files', updatedAt: new Date(9500) }));
    mockClient.getMediaProgress.mockResolvedValue({ progress: 0.3, isFinished: false, lastUpdate: 9000 });

    await expect(makeService().getLiveSyncStatus(baseUser, 'abs-1')).resolves.toMatchObject({ status: 'synced' });
  });

  it.each([
    ['no position sync in either direction', () => mockRepo.findSettings.mockResolvedValue(settings({ syncPosition: false, pushPosition: false }))],
    ['an excluded Audiobookshelf library', () => mockRepo.findSettings.mockResolvedValue(settings({ excludedLibraryIds: ['lib-1'] }))],
    ['a match awaiting review', () => mockRepo.findBookStateRow.mockResolvedValue(row({ needsReview: true }))],
    ['a book the user cannot see', () => mockBookService.verifyBookAccess.mockRejectedValue(new NotFoundException())],
  ])('answers not found without calling Audiobookshelf for %s', async (_label, arrange) => {
    arrange();

    await expect(makeService().getLiveSyncStatus(baseUser, 'abs-1')).rejects.toThrow(NotFoundException);
    expect(mockClient.getMediaProgress).not.toHaveBeenCalled();
  });

  describe('diverged', () => {
    const localRow = (capturedAtMs: number, overrides: Record<string, unknown> = {}) => ({
      currentFileId: 11,
      positionSeconds: 100,
      percentage: 40,
      capturedAt: new Date(capturedAtMs),
      updatedAt: new Date(capturedAtMs),
      revision: 1,
      ...overrides,
    });
    const remote = (currentTime: number, lastUpdate: number) => ({ progress: 0.25, isFinished: false, currentTime, lastUpdate });
    const localAt = (audioSeconds: number) =>
      mockBookService.resolveAudiobookPositionForExternalSync.mockResolvedValue({ audioSeconds, audioTotalSeconds: 36_000 });

    it('reports the local position and stays synced when both sides agree within a minute on the book clock', async () => {
      mockRepo.findAudioProgress.mockResolvedValue(localRow(4000));
      mockClient.getMediaProgress.mockResolvedValue(remote(1_030, 5000));
      localAt(1_000);

      await expect(makeService().getLiveSyncStatus(baseUser, 'abs-1')).resolves.toEqual({
        status: 'synced',
        progress: { percentage: 25, isFinished: false, lastUpdate: 5000 },
        local: { percentage: 40, capturedAt: new Date(4000).toISOString() },
        divergedReason: null,
      });
      expect(mockBookService.resolveAudiobookPositionForExternalSync).toHaveBeenCalledWith(218, 11, 100);
    });

    it('reports push_off when the newer local position has nowhere to go', async () => {
      mockRepo.findSettings.mockResolvedValue(settings({ pushPosition: false }));
      mockRepo.findAudioProgress.mockResolvedValue(localRow(9000));
      mockClient.getMediaProgress.mockResolvedValue(remote(1_000, 5000));
      localAt(2_000);

      await expect(makeService().getLiveSyncStatus(baseUser, 'abs-1')).resolves.toMatchObject({ status: 'diverged', divergedReason: 'push_off' });
    });

    it('reports pull_refused when the newer Audiobookshelf position was looked at and not applied', async () => {
      mockRepo.findBookStateRow.mockResolvedValue(row({ lastSyncedAt: new Date(9500) }));
      mockRepo.findAudioProgress.mockResolvedValue(localRow(4000));
      mockClient.getMediaProgress.mockResolvedValue(remote(5_000, 9000));
      localAt(1_000);

      await expect(makeService().getLiveSyncStatus(baseUser, 'abs-1')).resolves.toMatchObject({
        status: 'diverged',
        divergedReason: 'pull_refused',
      });
    });

    it('reports stale when neither side moved since the last sync but they disagree', async () => {
      mockRepo.findAudioProgress.mockResolvedValue(localRow(5000));
      mockClient.getMediaProgress.mockResolvedValue(remote(5_000, 5000));
      localAt(1_000);

      await expect(makeService().getLiveSyncStatus(baseUser, 'abs-1')).resolves.toMatchObject({ status: 'diverged', divergedReason: 'stale' });
    });

    it('reports stale for a newer local position while push is on but nothing is pending', async () => {
      mockRepo.findAudioProgress.mockResolvedValue(localRow(9000));
      mockClient.getMediaProgress.mockResolvedValue(remote(1_000, 5000));
      localAt(2_000);

      await expect(makeService().getLiveSyncStatus(baseUser, 'abs-1')).resolves.toMatchObject({ status: 'diverged', divergedReason: 'stale' });
    });

    it('keeps sending and receiving ahead of a divergence', async () => {
      mockRepo.findBookStateRow.mockResolvedValue(row({ pushPendingAt: new Date() }));
      mockRepo.findAudioProgress.mockResolvedValue(localRow(9000));
      mockClient.getMediaProgress.mockResolvedValue(remote(1_000, 5000));
      localAt(5_000);
      await expect(makeService().getLiveSyncStatus(baseUser, 'abs-1')).resolves.toMatchObject({ status: 'sending', divergedReason: null });

      mockRepo.findBookStateRow.mockResolvedValue(row());
      mockRepo.findAudioProgress.mockResolvedValue(localRow(4000));
      mockClient.getMediaProgress.mockResolvedValue(remote(5_000, 9000));
      await expect(makeService().getLiveSyncStatus(baseUser, 'abs-1')).resolves.toMatchObject({ status: 'receiving', divergedReason: null });
    });

    it('stays synced when the local position cannot be placed on the book clock', async () => {
      mockRepo.findAudioProgress.mockResolvedValue(localRow(5000));
      mockClient.getMediaProgress.mockResolvedValue(remote(9_000, 5000));
      mockBookService.resolveAudiobookPositionForExternalSync.mockResolvedValue(null);

      await expect(makeService().getLiveSyncStatus(baseUser, 'abs-1')).resolves.toMatchObject({ status: 'synced', divergedReason: null });
    });

    it('reports the local position even when Audiobookshelf is unreachable', async () => {
      mockRepo.findAudioProgress.mockResolvedValue(localRow(5000));
      mockClient.getMediaProgress.mockRejectedValue(new AudiobookshelfApiError('timed out', 'timeout'));

      await expect(makeService().getLiveSyncStatus(baseUser, 'abs-1')).resolves.toEqual({
        status: 'unreachable',
        progress: null,
        local: { percentage: 40, capturedAt: new Date(5000).toISOString() },
        divergedReason: null,
      });
      expect(mockBookService.resolveAudiobookPositionForExternalSync).not.toHaveBeenCalled();
    });
  });

  it('answers not found for an item that is not one of the user matches', async () => {
    mockRepo.findBookStateRow.mockResolvedValue(undefined);

    await expect(makeService().getLiveSyncStatus(baseUser, 'abs-1')).rejects.toThrow(NotFoundException);
    expect(mockClient.getMediaProgress).not.toHaveBeenCalled();
  });
});

describe('AudiobookshelfBookStateService.reconcile', () => {
  const settings = {
    enabled: true,
    serverUrl: 'https://abs.example.com',
    apiToken: 'token',
    syncPosition: true,
    pushPosition: false,
    excludedLibraryIds: [],
  };
  const row = {
    absLibraryItemId: 'abs-1',
    absLibraryId: 'lib-1',
    bookId: 218,
    needsReview: false,
    matchError: null,
    syncExcluded: false,
    manualUnlinked: false,
    pushPendingAt: null,
    lastSyncedPositionAbsUpdate: 5000,
    lastSyncedProgressAt: null,
    lastSyncedAt: null,
    syncError: null,
    updatedAt: new Date(0),
  };
  const remote = { progress: 0.5, isFinished: false, currentTime: 1_800, duration: 3_600, lastUpdate: 5000 };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRepo.findSettings.mockResolvedValue(settings);
    mockRepo.findBookStateRow.mockResolvedValue(row);
    mockRepo.findAudioProgress.mockResolvedValue(undefined);
    mockBookService.verifyBookAccess.mockResolvedValue(undefined);
    mockClient.getMediaProgress.mockResolvedValue(remote);
    mockCoordinator.acquireSync.mockResolvedValue(true);
    mockCoordinator.tryStartPush.mockReturnValue(true);
    mockSyncService.pullPositionNow.mockResolvedValue({ applied: true, reason: 'applied' });
    mockProgressPush.pushPositionNow.mockResolvedValue({ outcome: 'pushed', reason: 'pushed' });
  });

  it('pulls the Audiobookshelf position under the sync lock and returns the fresh live status', async () => {
    const result = await makeService().reconcile(baseUser, 'abs-1', 'pull');

    expect(mockCoordinator.acquireSync).toHaveBeenCalledWith(baseUser.id, 10_000);
    expect(mockClient.getMediaProgress).toHaveBeenNthCalledWith(1, baseUser.id, 'https://abs.example.com', 'token', 'abs-1');
    expect(mockSyncService.pullPositionNow).toHaveBeenCalledWith(
      baseUser,
      expect.objectContaining({ absLibraryItemId: 'abs-1', bookId: 218 }),
      remote,
    );
    expect(mockCoordinator.endSync).toHaveBeenCalledWith(baseUser.id);
    expect(result).toMatchObject({ status: 'synced', progress: { percentage: 50 } });
  });

  it('answers conflict when a sync holds the lock past the wait', async () => {
    mockCoordinator.acquireSync.mockResolvedValue(false);

    await expect(makeService().reconcile(baseUser, 'abs-1', 'pull')).rejects.toThrow(ConflictException);
    expect(mockSyncService.pullPositionNow).not.toHaveBeenCalled();
    expect(mockCoordinator.endSync).not.toHaveBeenCalled();
  });

  it('applies nothing when Audiobookshelf has no progress for the item', async () => {
    mockClient.getMediaProgress.mockResolvedValue(null);

    await makeService().reconcile(baseUser, 'abs-1', 'pull');

    expect(mockSyncService.pullPositionNow).not.toHaveBeenCalled();
    expect(mockCoordinator.endSync).toHaveBeenCalledWith(baseUser.id);
  });

  it('reports an unreachable server on pull as a bad gateway and releases the lock', async () => {
    mockClient.getMediaProgress.mockRejectedValue(new AudiobookshelfApiError('timed out', 'timeout'));

    await expect(makeService().reconcile(baseUser, 'abs-1', 'pull')).rejects.toThrow(BadGatewayException);
    expect(mockCoordinator.endSync).toHaveBeenCalledWith(baseUser.id);
  });

  it('pushes the local position under the push lock even with push switched off', async () => {
    await makeService().reconcile(baseUser, 'abs-1', 'push');

    expect(mockCoordinator.tryStartPush).toHaveBeenCalledWith(baseUser.id);
    expect(mockProgressPush.pushPositionNow).toHaveBeenCalledWith(baseUser.id, 'abs-1');
    expect(mockCoordinator.endPush).toHaveBeenCalledWith(baseUser.id);
    expect(mockSyncService.pullPositionNow).not.toHaveBeenCalled();
  });

  it('reads the status from the row the push just updated', async () => {
    mockRepo.findBookStateRow.mockResolvedValueOnce(row).mockResolvedValueOnce({ ...row, lastSyncedPositionAbsUpdate: 9000 });
    mockClient.getMediaProgress.mockResolvedValue({ ...remote, lastUpdate: 9000 });

    await expect(makeService().reconcile(baseUser, 'abs-1', 'push')).resolves.toMatchObject({ status: 'synced' });
    expect(mockRepo.findBookStateRow).toHaveBeenCalledTimes(2);
  });

  it('answers conflict when a sync or push already holds the push lock', async () => {
    mockCoordinator.tryStartPush.mockReturnValue(false);

    await expect(makeService().reconcile(baseUser, 'abs-1', 'push')).rejects.toThrow(ConflictException);
    expect(mockProgressPush.pushPositionNow).not.toHaveBeenCalled();
    expect(mockCoordinator.endPush).not.toHaveBeenCalled();
  });

  it('reports a failed push as a bad gateway and releases the lock', async () => {
    mockProgressPush.pushPositionNow.mockResolvedValue({ outcome: 'unreachable', reason: 'unreachable' });

    await expect(makeService().reconcile(baseUser, 'abs-1', 'push')).rejects.toThrow(BadGatewayException);
    expect(mockCoordinator.endPush).toHaveBeenCalledWith(baseUser.id);
  });

  it('returns the live status when a push guard declines', async () => {
    mockProgressPush.pushPositionNow.mockResolvedValue({ outcome: 'skipped', reason: 'near_end' });

    await expect(makeService().reconcile(baseUser, 'abs-1', 'push')).resolves.toMatchObject({ status: 'synced' });
  });

  it('answers not found without taking a lock for an item that is not one of the user matches', async () => {
    mockRepo.findBookStateRow.mockResolvedValue(undefined);

    await expect(makeService().reconcile(baseUser, 'abs-1', 'pull')).rejects.toThrow(NotFoundException);
    expect(mockCoordinator.acquireSync).not.toHaveBeenCalled();
  });
});
