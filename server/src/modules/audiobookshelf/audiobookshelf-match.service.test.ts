import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import { AudiobookshelfMatchService, type AbsMatchInput } from './audiobookshelf-match.service';
import type { AbsBookStateUpsert } from './audiobookshelf.repository';

const emptyFilters = { includeTagIds: [], excludeTagIds: [], includeGenreIds: [], excludeGenreIds: [] };

function makeUser(overrides: Partial<RequestUser> = {}): RequestUser {
  return { id: 7, isSuperuser: false, contentFilters: emptyFilters, ...overrides } as unknown as RequestUser;
}

function makeInput(overrides: Partial<AbsMatchInput> = {}): AbsMatchInput {
  return {
    absLibraryItemId: 'abs-1',
    asin: null,
    isbn: null,
    title: 'The Way of Kings',
    author: 'Brandon Sanderson',
    seriesName: null,
    ...overrides,
  };
}

function upsertsFrom(bulk: ReturnType<typeof vi.fn>): AbsBookStateUpsert[] {
  return bulk.mock.calls[0]?.[1] ?? [];
}

describe('AudiobookshelfMatchService', () => {
  let repo: {
    findSettings: ReturnType<typeof vi.fn>;
    findBookStatesByAbsItemIds: ReturnType<typeof vi.fn>;
    findLibraryChangedAt: ReturnType<typeof vi.fn>;
    findBookIdsByAudibleIds: ReturnType<typeof vi.fn>;
    findBookIdsByIsbns: ReturnType<typeof vi.fn>;
    findFuzzyCandidates: ReturnType<typeof vi.fn>;
    bulkUpsertBookStates: ReturnType<typeof vi.fn>;
    deleteBookStatesNotIn: ReturnType<typeof vi.fn>;
  };
  let client: { getLibraries: ReturnType<typeof vi.fn>; getLibraryItems: ReturnType<typeof vi.fn> };
  let library: { findAccessibleLibraryIds: ReturnType<typeof vi.fn> };
  let service: AudiobookshelfMatchService;

  beforeEach(() => {
    repo = {
      findSettings: vi.fn(),
      findBookStatesByAbsItemIds: vi.fn().mockResolvedValue([]),
      findLibraryChangedAt: vi.fn().mockResolvedValue(new Date('2026-01-01T00:00:00Z')),
      findBookIdsByAudibleIds: vi.fn().mockResolvedValue([]),
      findBookIdsByIsbns: vi.fn().mockResolvedValue([]),
      findFuzzyCandidates: vi.fn().mockResolvedValue([]),
      bulkUpsertBookStates: vi.fn().mockResolvedValue(undefined),
      deleteBookStatesNotIn: vi.fn().mockResolvedValue(0),
    };
    client = { getLibraries: vi.fn(), getLibraryItems: vi.fn() };
    library = { findAccessibleLibraryIds: vi.fn().mockResolvedValue([1, 2]) };
    service = new AudiobookshelfMatchService(repo as never, client as never, library as never);
  });

  it('auto-links on exact ASIN match', async () => {
    repo.findBookIdsByAudibleIds.mockResolvedValue([{ key: 'B00ASIN', bookId: 100 }]);
    const summary = await service.matchItems(makeUser(), [makeInput({ asin: 'B00ASIN' })], { force: true });

    expect(summary.autoLinked).toBe(1);
    const [row] = upsertsFrom(repo.bulkUpsertBookStates);
    expect(row).toMatchObject({ bookId: 100, matchMethod: 'asin', needsReview: false, matchConfidence: 100, matchError: null });
    expect(repo.findFuzzyCandidates).not.toHaveBeenCalled();
  });

  it('auto-links on exact ISBN match when ASIN is absent', async () => {
    repo.findBookIdsByIsbns.mockResolvedValue([{ key: '9780306406157', bookId: 200 }]);
    const summary = await service.matchItems(makeUser(), [makeInput({ isbn: '978-0-306-40615-7' })], { force: true });

    expect(summary.autoLinked).toBe(1);
    const [row] = upsertsFrom(repo.bulkUpsertBookStates);
    expect(row).toMatchObject({ bookId: 200, matchMethod: 'isbn', needsReview: false });
  });

  it('records matchError and skips linking when one ASIN maps to multiple books', async () => {
    repo.findBookIdsByAudibleIds.mockResolvedValue([
      { key: 'B00ASIN', bookId: 1 },
      { key: 'B00ASIN', bookId: 2 },
    ]);
    const summary = await service.matchItems(makeUser(), [makeInput({ asin: 'B00ASIN' })], { force: true });

    expect(summary.errors).toBe(1);
    const [row] = upsertsFrom(repo.bulkUpsertBookStates);
    expect(row).toMatchObject({ bookId: null, matchError: 'ambiguous_asin', needsReview: false });
  });

  it('routes a fuzzy near-tie to review with a deterministic best pick, never auto-linking', async () => {
    repo.findFuzzyCandidates.mockResolvedValue([
      { bookId: 55, title: 'The Way of Kings', authors: ['Brandon Sanderson'], series: [] },
      { bookId: 33, title: 'The Way of Kings', authors: ['Brandon Sanderson'], series: [] },
    ]);
    const summary = await service.matchItems(makeUser(), [makeInput()], { force: true });

    expect(summary.needsReview).toBe(1);
    expect(summary.autoLinked).toBe(0);
    const [row] = upsertsFrom(repo.bulkUpsertBookStates);
    expect(row).toMatchObject({ bookId: 33, matchMethod: 'title_author_series', needsReview: true });
    expect(row.matchConfidence).toBeGreaterThan(0);
  });

  it('scores against the best matching series membership regardless of membership order', async () => {
    const input = makeInput({ seriesName: 'The Stormlight Archive #1' });
    const forward = [
      { name: 'Unrelated Series', seriesIndex: 9 },
      { name: 'The Stormlight Archive', seriesIndex: 1 },
    ];

    repo.findFuzzyCandidates.mockResolvedValueOnce([{ bookId: 70, title: 'The Way of Kings', authors: ['Brandon Sanderson'], series: forward }]);
    const first = await service.matchItems(makeUser(), [input], { force: true });
    const firstRow = upsertsFrom(repo.bulkUpsertBookStates)[0]!;

    repo.bulkUpsertBookStates.mockClear();
    repo.findFuzzyCandidates.mockResolvedValueOnce([
      { bookId: 70, title: 'The Way of Kings', authors: ['Brandon Sanderson'], series: [...forward].reverse() },
    ]);
    const second = await service.matchItems(makeUser(), [input], { force: true });
    const secondRow = upsertsFrom(repo.bulkUpsertBookStates)[0]!;

    expect(first.needsReview).toBe(1);
    expect(second.needsReview).toBe(1);
    expect(secondRow.matchConfidence).toBe(firstRow.matchConfidence);
    expect(secondRow.bookId).toBe(70);
  });

  it('memoizes negatives: a second incremental run does no candidate load when the library is unchanged', async () => {
    const lastAttempt = new Date('2026-02-01T00:00:00Z');
    repo.findBookStatesByAbsItemIds.mockResolvedValue([
      { absLibraryItemId: 'abs-1', bookId: null, matchMethod: null, needsReview: false, lastMatchAttemptAt: lastAttempt },
    ]);
    repo.findLibraryChangedAt.mockResolvedValue(new Date('2026-01-15T00:00:00Z'));

    const summary = await service.matchItems(makeUser(), [makeInput()], { force: false });

    expect(summary.skipped).toBe(1);
    expect(summary.processed).toBe(0);
    expect(repo.findBookIdsByAudibleIds).not.toHaveBeenCalled();
    expect(repo.findBookIdsByIsbns).not.toHaveBeenCalled();
    expect(repo.findFuzzyCandidates).not.toHaveBeenCalled();
    expect(repo.bulkUpsertBookStates).not.toHaveBeenCalled();
  });

  it('re-attempts a memoized negative when the library changed after the last attempt', async () => {
    const lastAttempt = new Date('2026-01-01T00:00:00Z');
    repo.findBookStatesByAbsItemIds.mockResolvedValue([
      { absLibraryItemId: 'abs-1', bookId: null, matchMethod: null, needsReview: false, lastMatchAttemptAt: lastAttempt },
    ]);
    repo.findLibraryChangedAt.mockResolvedValue(new Date('2026-03-01T00:00:00Z'));
    repo.findBookIdsByAudibleIds.mockResolvedValue([{ key: 'B00ASIN', bookId: 101 }]);

    const summary = await service.matchItems(makeUser(), [makeInput({ asin: 'B00ASIN' })], { force: false });

    expect(repo.findBookIdsByAudibleIds).toHaveBeenCalled();
    expect(summary.autoLinked).toBe(1);
  });

  it('leaves already-linked items untouched even on a forced rescan', async () => {
    repo.findBookStatesByAbsItemIds.mockResolvedValue([
      { absLibraryItemId: 'abs-1', bookId: 500, matchMethod: 'manual', needsReview: false, lastMatchAttemptAt: new Date() },
    ]);
    const summary = await service.matchItems(makeUser(), [makeInput({ asin: 'B00ASIN' })], { force: true });

    expect(summary.skipped).toBe(1);
    expect(summary.processed).toBe(0);
    expect(repo.findBookIdsByAudibleIds).not.toHaveBeenCalled();
    expect(repo.bulkUpsertBookStates).not.toHaveBeenCalled();
  });

  it('rescan fetches only book libraries and forces matching', async () => {
    repo.findSettings.mockResolvedValue({ enabled: true, serverUrl: 'https://abs.example', apiToken: 'token' });
    client.getLibraries.mockResolvedValue({
      libraries: [
        { id: 'L1', name: 'Audiobooks', mediaType: 'book', provider: 'audible' },
        { id: 'L2', name: 'Shows', mediaType: 'podcast', provider: 'itunes' },
      ],
    });
    client.getLibraryItems.mockResolvedValue({
      results: [
        {
          id: 'item-1',
          libraryId: 'L1',
          mediaType: 'book',
          media: { metadata: { title: 'T', subtitle: null, authorName: 'A', seriesName: null, isbn: null, asin: 'B00ASIN' }, duration: null },
        },
      ],
      total: 1,
      limit: 500,
      page: 0,
    });
    repo.findBookIdsByAudibleIds.mockResolvedValue([{ key: 'B00ASIN', bookId: 900 }]);

    const result = await service.rescan(makeUser());

    expect(result).toEqual({ queued: 1 });
    expect(client.getLibraryItems).toHaveBeenCalledTimes(1);
    expect(client.getLibraryItems).toHaveBeenCalledWith(7, 'https://abs.example', 'token', 'L1', { limit: 500, page: 0 });
    expect(repo.deleteBookStatesNotIn).toHaveBeenCalledWith(7, ['item-1']);
  });

  it('skips the prune when the provider inventory is empty', async () => {
    client.getLibraries.mockResolvedValue({ libraries: [] });

    const summary = await service.matchLibrary(makeUser(), 'https://abs.example', 'token', { force: false });

    expect(repo.deleteBookStatesNotIn).not.toHaveBeenCalled();
    expect(summary.pruned).toBe(0);
  });

  it('rescan rejects when the integration is not configured', async () => {
    repo.findSettings.mockResolvedValue(undefined);
    await expect(service.rescan(makeUser())).rejects.toThrow();
  });
});
