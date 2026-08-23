import { describe, it, expect, vi, beforeEach } from 'vitest';

import { AudiobookshelfMatchService, type AbsMatchInput } from './audiobookshelf-match.service';
import type { AbsBookStateUpsert, AbsExactMatchRow, AbsFuzzyCandidate } from './audiobookshelf.repository';

const mockRepo = {
  findBookStatesByAbsItemIds: vi.fn(),
  findBookIdsByAudibleIds: vi.fn(),
  findBookIdsByIsbns: vi.fn(),
  findFuzzyCandidatesForTitles: vi.fn(),
  findLibraryChangedAt: vi.fn(),
  bulkUpsertBookStates: vi.fn(),
};

const mockClient = {
  getLibraries: vi.fn(),
  getLibraryItems: vi.fn(),
};

const mockLibraryService = {
  findAccessibleLibraryIds: vi.fn(),
};

function makeService() {
  return new AudiobookshelfMatchService(mockRepo as any, mockClient as any, mockLibraryService as any);
}

const superuser = { id: 42, isSuperuser: true, contentFilters: undefined } as any;

function makeItem(overrides: Partial<AbsMatchInput> = {}): AbsMatchInput {
  return {
    absLibraryItemId: 'abs-1',
    asin: null,
    isbn: null,
    title: null,
    author: null,
    seriesName: null,
    ...overrides,
  };
}

function exactRow(key: string, bookId: number): AbsExactMatchRow {
  return { key, bookId };
}

function fuzzyCandidate(overrides: Partial<AbsFuzzyCandidate> = {}): AbsFuzzyCandidate {
  return { bookId: 1, title: 'Test Book', authors: ['Test Author'], series: [], ...overrides };
}

/** Reads the single bulkUpsertBookStates(userId, rows) call and returns the rows keyed by absLibraryItemId. */
function capturedUpserts(): Map<string, AbsBookStateUpsert> {
  expect(mockRepo.bulkUpsertBookStates).toHaveBeenCalledTimes(1);
  const rows = mockRepo.bulkUpsertBookStates.mock.calls[0]![1] as AbsBookStateUpsert[];
  return new Map(rows.map((row) => [row.absLibraryItemId, row]));
}

describe('AudiobookshelfMatchService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLibraryService.findAccessibleLibraryIds.mockResolvedValue([1, 2]);
    mockRepo.findBookStatesByAbsItemIds.mockResolvedValue([]);
    mockRepo.findBookIdsByAudibleIds.mockResolvedValue([]);
    mockRepo.findBookIdsByIsbns.mockResolvedValue([]);
    mockRepo.findFuzzyCandidatesForTitles.mockResolvedValue(new Map());
    mockRepo.findLibraryChangedAt.mockResolvedValue(null);
    mockRepo.bulkUpsertBookStates.mockResolvedValue(undefined);
  });

  describe('matchItems - exact cascade', () => {
    it('links via ASIN even when an ISBN is also present (ASIN wins the cascade)', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', asin: 'ASIN123', isbn: '9781234567890', title: 'T', author: 'A' });
      mockRepo.findBookIdsByAudibleIds.mockResolvedValue([exactRow('ASIN123', 7)]);
      // A different book matches by ISBN; it must be ignored because ASIN is the higher tier.
      mockRepo.findBookIdsByIsbns.mockResolvedValue([exactRow('9781234567890', 999)]);

      const summary = await makeService().matchItems(superuser, [item], { force: false });

      const upsert = capturedUpserts().get('i1')!;
      expect(upsert).toMatchObject({ bookId: 7, matchMethod: 'asin', matchConfidence: 100, needsReview: false, matchError: null });
      expect(summary.autoLinked).toBe(1);
      expect(summary.errors).toBe(0);
    });

    it('auto-links a single exact ISBN hit with confidence 100 and needsReview false', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', isbn: '978-1-234-56789-0' });
      mockRepo.findBookIdsByIsbns.mockResolvedValue([exactRow('9781234567890', 12)]);

      const summary = await makeService().matchItems(superuser, [item], { force: false });

      const upsert = capturedUpserts().get('i1')!;
      expect(upsert).toMatchObject({
        absLibraryItemId: 'i1',
        bookId: 12,
        matchMethod: 'isbn',
        matchConfidence: 100,
        needsReview: false,
        matchError: null,
      });
      expect(upsert.lastMatchAttemptAt).toBeInstanceOf(Date);
      expect(summary.autoLinked).toBe(1);
    });

    it('does NOT guess on multiple ASIN hits: records ambiguous_asin, bookId null, errors++', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', asin: 'ASIN123' });
      mockRepo.findBookIdsByAudibleIds.mockResolvedValue([exactRow('ASIN123', 1), exactRow('ASIN123', 2)]);

      const summary = await makeService().matchItems(superuser, [item], { force: false });

      const upsert = capturedUpserts().get('i1')!;
      expect(upsert).toMatchObject({ bookId: null, matchMethod: null, matchConfidence: null, needsReview: false, matchError: 'ambiguous_asin' });
      expect(summary.errors).toBe(1);
      expect(summary.autoLinked).toBe(0);
    });

    it('does NOT guess on multiple ISBN hits: records ambiguous_isbn, bookId null, errors++', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', isbn: '9781234567890' });
      mockRepo.findBookIdsByIsbns.mockResolvedValue([exactRow('9781234567890', 3), exactRow('9781234567890', 4)]);

      const summary = await makeService().matchItems(superuser, [item], { force: false });

      const upsert = capturedUpserts().get('i1')!;
      expect(upsert).toMatchObject({ bookId: null, matchMethod: null, matchError: 'ambiguous_isbn' });
      expect(summary.errors).toBe(1);
    });

    it('passes normalized (uppercased) ASIN keys to the repo and still hits on a lowercase input', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', asin: '  asin123  ' });
      mockRepo.findBookIdsByAudibleIds.mockResolvedValue([exactRow('ASIN123', 5)]);

      const summary = await makeService().matchItems(superuser, [item], { force: false });

      expect(mockRepo.findBookIdsByAudibleIds).toHaveBeenCalledWith([1, 2], undefined, ['ASIN123']);
      expect(capturedUpserts().get('i1')).toMatchObject({ bookId: 5, matchMethod: 'asin' });
      expect(summary.autoLinked).toBe(1);
    });

    it('passes normalized ISBN keys to the repo (hyphens/case stripped) and still hits', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', isbn: '979-8-3abc-5X' });
      mockRepo.findBookIdsByIsbns.mockResolvedValue([exactRow('979835X', 8)]);

      await makeService().matchItems(superuser, [item], { force: false });

      expect(mockRepo.findBookIdsByIsbns).toHaveBeenCalledWith([1, 2], undefined, ['979835X']);
      expect(capturedUpserts().get('i1')).toMatchObject({ bookId: 8, matchMethod: 'isbn' });
    });
  });

  describe('matchItems - fuzzy fallback', () => {
    it('falls to fuzzy when no exact hit and suggests a single strong candidate as needsReview (never auto-links)', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', title: 'Test Book', author: 'Test Author' });
      mockRepo.findFuzzyCandidatesForTitles.mockResolvedValue(new Map([['Test Book', [fuzzyCandidate({ bookId: 55 })]]]));

      const summary = await makeService().matchItems(superuser, [item], { force: false });

      const upsert = capturedUpserts().get('i1')!;
      expect(upsert).toMatchObject({ bookId: 55, matchMethod: 'title_author_series', needsReview: true, matchError: null });
      expect(upsert.matchConfidence).toBe(100);
      expect(summary.needsReview).toBe(1);
      expect(summary.autoLinked).toBe(0);
    });

    it('records ambiguous_fuzzy when two candidates fall within the ambiguity margin', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', title: 'Test Book', author: 'Test Author' });
      mockRepo.findFuzzyCandidatesForTitles.mockResolvedValue(
        new Map([['Test Book', [fuzzyCandidate({ bookId: 55 }), fuzzyCandidate({ bookId: 66 })]]]),
      );

      const summary = await makeService().matchItems(superuser, [item], { force: false });

      const upsert = capturedUpserts().get('i1')!;
      expect(upsert).toMatchObject({ bookId: null, matchMethod: null, matchConfidence: null, needsReview: false, matchError: 'ambiguous_fuzzy' });
      expect(summary.errors).toBe(1);
      expect(summary.needsReview).toBe(0);
    });

    it('records an unmatched (no error) row when no candidate clears the thresholds', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', title: 'Test Book', author: 'Test Author' });
      mockRepo.findFuzzyCandidatesForTitles.mockResolvedValue(
        new Map([['Test Book', [fuzzyCandidate({ bookId: 55, title: 'A Completely Unrelated Volume', authors: ['Nobody At All'] })]]]),
      );

      const summary = await makeService().matchItems(superuser, [item], { force: false });

      expect(capturedUpserts().get('i1')).toMatchObject({ bookId: null, matchMethod: null, matchError: null, needsReview: false });
      expect(summary.unmatched).toBe(1);
      expect(summary.errors).toBe(0);
    });

    it('marks every fuzzy suggestion needsReview so later progress writes exclude them', async () => {
      const items = [
        makeItem({ absLibraryItemId: 'i1', title: 'Test Book', author: 'Test Author' }),
        makeItem({ absLibraryItemId: 'i2', title: 'Another Book', author: 'Second Author' }),
      ];
      mockRepo.findFuzzyCandidatesForTitles.mockResolvedValue(
        new Map([
          ['Test Book', [fuzzyCandidate({ bookId: 55 })]],
          ['Another Book', [fuzzyCandidate({ bookId: 77, title: 'Another Book', authors: ['Second Author'] })]],
        ]),
      );

      await makeService().matchItems(superuser, items, { force: false });

      const upserts = capturedUpserts();
      expect(upserts.get('i1')!.needsReview).toBe(true);
      expect(upserts.get('i2')!.needsReview).toBe(true);
    });

    it('does not run a fuzzy query when the item lacks a title or author', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', title: 'Only A Title' });

      const summary = await makeService().matchItems(superuser, [item], { force: false });

      expect(mockRepo.findFuzzyCandidatesForTitles).not.toHaveBeenCalled();
      expect(summary.unmatched).toBe(1);
    });
  });

  describe('matchItems - existing-state skips', () => {
    it('skips an already-linked item (bookId set) and does not re-match it', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', asin: 'ASIN123' });
      mockRepo.findBookStatesByAbsItemIds.mockResolvedValue([
        { absLibraryItemId: 'i1', bookId: 9, matchMethod: 'asin', manualUnlinked: false, lastMatchAttemptAt: new Date() },
      ]);

      const summary = await makeService().matchItems(superuser, [item], { force: false });

      expect(summary.skipped).toBe(1);
      expect(summary.processed).toBe(0);
      expect(mockRepo.bulkUpsertBookStates).not.toHaveBeenCalled();
    });

    it('skips a manual state (matchMethod=manual) even with no bookId', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', asin: 'ASIN123' });
      mockRepo.findBookStatesByAbsItemIds.mockResolvedValue([
        { absLibraryItemId: 'i1', bookId: null, matchMethod: 'manual', manualUnlinked: false, lastMatchAttemptAt: null },
      ]);

      const summary = await makeService().matchItems(superuser, [item], { force: false });

      expect(summary.skipped).toBe(1);
      expect(mockRepo.bulkUpsertBookStates).not.toHaveBeenCalled();
    });

    // NOTE: a linked/manual state is skipped unconditionally (even with force:true); only
    // manualUnlinked and the lastMatchAttemptAt "unchanged" skip are force-gated. This asserts
    // the actual behaviour, which is slightly narrower than "linked states re-match under force".
    it('still skips an already-linked item under force:true', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', asin: 'ASIN123' });
      mockRepo.findBookStatesByAbsItemIds.mockResolvedValue([
        { absLibraryItemId: 'i1', bookId: 9, matchMethod: 'asin', manualUnlinked: false, lastMatchAttemptAt: new Date() },
      ]);

      const summary = await makeService().matchItems(superuser, [item], { force: true });

      expect(summary.skipped).toBe(1);
      expect(mockRepo.bulkUpsertBookStates).not.toHaveBeenCalled();
    });

    it('skips a manualUnlinked item when force is false', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', asin: 'ASIN123' });
      mockRepo.findBookStatesByAbsItemIds.mockResolvedValue([
        { absLibraryItemId: 'i1', bookId: null, matchMethod: null, manualUnlinked: true, lastMatchAttemptAt: null },
      ]);

      const summary = await makeService().matchItems(superuser, [item], { force: false });

      expect(summary.skipped).toBe(1);
      expect(mockRepo.findBookIdsByAudibleIds).not.toHaveBeenCalled();
    });

    it('re-matches a manualUnlinked item when force is true', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', asin: 'ASIN123' });
      mockRepo.findBookStatesByAbsItemIds.mockResolvedValue([
        { absLibraryItemId: 'i1', bookId: null, matchMethod: null, manualUnlinked: true, lastMatchAttemptAt: null },
      ]);
      mockRepo.findBookIdsByAudibleIds.mockResolvedValue([exactRow('ASIN123', 5)]);

      const summary = await makeService().matchItems(superuser, [item], { force: true });

      expect(summary.processed).toBe(1);
      expect(capturedUpserts().get('i1')).toMatchObject({ bookId: 5, matchMethod: 'asin' });
    });

    it('skips a prior no-hit attempt when the library has not changed since (force false)', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', asin: 'ASIN123' });
      mockRepo.findBookStatesByAbsItemIds.mockResolvedValue([
        { absLibraryItemId: 'i1', bookId: null, matchMethod: null, manualUnlinked: false, lastMatchAttemptAt: new Date('2026-01-01') },
      ]);
      mockRepo.findLibraryChangedAt.mockResolvedValue(new Date('2025-01-01'));

      const summary = await makeService().matchItems(superuser, [item], { force: false });

      expect(summary.skipped).toBe(1);
      expect(mockRepo.bulkUpsertBookStates).not.toHaveBeenCalled();
    });

    it('re-attempts a prior no-hit when the library changed after the last attempt', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', asin: 'ASIN123' });
      mockRepo.findBookStatesByAbsItemIds.mockResolvedValue([
        { absLibraryItemId: 'i1', bookId: null, matchMethod: null, manualUnlinked: false, lastMatchAttemptAt: new Date('2025-01-01') },
      ]);
      mockRepo.findLibraryChangedAt.mockResolvedValue(new Date('2026-01-01'));
      mockRepo.findBookIdsByAudibleIds.mockResolvedValue([exactRow('ASIN123', 5)]);

      const summary = await makeService().matchItems(superuser, [item], { force: false });

      expect(summary.processed).toBe(1);
      expect(capturedUpserts().get('i1')).toMatchObject({ bookId: 5 });
    });
  });

  describe('matchItems - misc', () => {
    it('returns an empty summary and touches nothing for an empty page', async () => {
      const summary = await makeService().matchItems(superuser, [], { force: false });
      expect(summary.totalItems).toBe(0);
      expect(mockRepo.findBookStatesByAbsItemIds).not.toHaveBeenCalled();
      expect(mockRepo.bulkUpsertBookStates).not.toHaveBeenCalled();
    });

    it('passes content filters through for a non-superuser', async () => {
      const filters = { some: 'rule' };
      const nonSuperuser = { id: 7, isSuperuser: false, contentFilters: filters } as any;
      const item = makeItem({ absLibraryItemId: 'i1', asin: 'ASIN123' });
      mockRepo.findBookIdsByAudibleIds.mockResolvedValue([exactRow('ASIN123', 5)]);

      await makeService().matchItems(nonSuperuser, [item], { force: false });

      expect(mockRepo.findBookIdsByAudibleIds).toHaveBeenCalledWith([1, 2], filters, ['ASIN123']);
    });
  });

  describe('matchLibrary - single inventory page', () => {
    it('paginates one book library page and aggregates the page summary', async () => {
      mockClient.getLibraries.mockResolvedValue({
        libraries: [
          { id: 'lib-book', name: 'Books', mediaType: 'book', provider: 'audible' },
          { id: 'lib-pod', name: 'Podcasts', mediaType: 'podcast', provider: 'audible' },
        ],
      });
      mockClient.getLibraryItems.mockResolvedValue({
        results: [
          {
            id: 'i1',
            libraryId: 'lib-book',
            mediaType: 'book',
            media: { metadata: { title: 'T', subtitle: null, authorName: 'A', seriesName: null, isbn: null, asin: 'ASIN123' }, duration: null },
          },
        ],
        total: 1,
        limit: 500,
        page: 0,
      });
      mockRepo.findBookIdsByAudibleIds.mockResolvedValue([exactRow('ASIN123', 5)]);

      const summary = await makeService().matchLibrary(superuser, 'https://abs.example', 'token', { force: true });

      expect(mockClient.getLibraryItems).toHaveBeenCalledTimes(1);
      expect(mockClient.getLibraryItems).toHaveBeenCalledWith(42, 'https://abs.example', 'token', 'lib-book', { limit: 500, page: 0 });
      expect(summary.totalItems).toBe(1);
      expect(summary.autoLinked).toBe(1);
      expect(capturedUpserts().get('i1')).toMatchObject({ bookId: 5, matchMethod: 'asin' });
    });

    it('excludes libraries listed in excludedLibraryIds', async () => {
      mockClient.getLibraries.mockResolvedValue({
        libraries: [{ id: 'lib-book', name: 'Books', mediaType: 'book', provider: 'audible' }],
      });

      const summary = await makeService().matchLibrary(superuser, 'https://abs.example', 'token', { force: true, excludedLibraryIds: ['lib-book'] });

      expect(mockClient.getLibraryItems).not.toHaveBeenCalled();
      expect(summary.totalItems).toBe(0);
    });
  });
});
