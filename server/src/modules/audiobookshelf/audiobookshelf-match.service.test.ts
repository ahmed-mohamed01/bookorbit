import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';

import { AudiobookshelfMatchService, type AbsMatchInput } from './audiobookshelf-match.service';
import type { AbsBookStateUpsert, AbsExactMatchRow, AbsFuzzyCandidate } from './audiobookshelf.repository';

const mockRepo = {
  findSettings: vi.fn(),
  findBookStateCleanupCandidates: vi.fn(),
  deleteBookStatesByAbsItemIds: vi.fn(),
  updateStaleCount: vi.fn(),
  findBookStatesByAbsItemIds: vi.fn(),
  findBookIdsByAudibleIds: vi.fn(),
  findBookIdsByIsbns: vi.fn(),
  findBookIdsByPaths: vi.fn(),
  findFuzzyCandidatesForTitles: vi.fn(),
  findDistinctBookFolderPaths: vi.fn(),
  findLibraryChangedAt: vi.fn(),
  bulkUpsertBookStates: vi.fn(),
  refreshAbsContext: vi.fn(),
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
    path: null,
    libraryName: null,
    ...overrides,
  };
}

function exactRow(key: string, bookId: number): AbsExactMatchRow {
  return { key, bookId };
}

function fuzzyCandidate(overrides: Partial<AbsFuzzyCandidate> = {}): AbsFuzzyCandidate {
  return { bookId: 1, title: 'Test Book', authors: ['Test Author'], series: [], ...overrides };
}

/** Reads the single bulkUpsertBookStates(userId, rows, readAt) call and returns the rows keyed by absLibraryItemId. */
function capturedUpserts(): Map<string, AbsBookStateUpsert> {
  expect(mockRepo.bulkUpsertBookStates).toHaveBeenCalledTimes(1);
  const [, rows, readAt] = mockRepo.bulkUpsertBookStates.mock.calls[0]! as [number, AbsBookStateUpsert[], Date];
  // Every write carries the time the run read state, which is what lets it yield to a user decision
  // made while the batch was being computed.
  expect(readAt).toBeInstanceOf(Date);
  return new Map(rows.map((row) => [row.absLibraryItemId, row]));
}

describe('AudiobookshelfMatchService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLibraryService.findAccessibleLibraryIds.mockResolvedValue([1, 2]);
    mockRepo.findBookStatesByAbsItemIds.mockResolvedValue([]);
    mockRepo.findBookIdsByAudibleIds.mockResolvedValue([]);
    mockRepo.findBookIdsByIsbns.mockResolvedValue([]);
    mockRepo.findBookIdsByPaths.mockResolvedValue([]);
    mockRepo.findFuzzyCandidatesForTitles.mockResolvedValue(new Map());
    mockRepo.findDistinctBookFolderPaths.mockResolvedValue([]);
    mockRepo.findLibraryChangedAt.mockResolvedValue(null);
    mockRepo.bulkUpsertBookStates.mockResolvedValue(undefined);
    mockRepo.refreshAbsContext.mockResolvedValue(undefined);
    mockRepo.findSettings.mockResolvedValue({ enabled: true, serverUrl: 'https://abs.example', apiToken: 'token', excludedLibraryIds: [] });
    mockRepo.findBookStateCleanupCandidates.mockResolvedValue([]);
    mockRepo.deleteBookStatesByAbsItemIds.mockResolvedValue(0);
    mockRepo.updateStaleCount.mockResolvedValue(undefined);
  });

  describe('matchItems - concurrent user decisions', () => {
    it('stamps the write with the time state was read, not the time the write happens', async () => {
      // The candidate queries are the window a user decision can land in, so the stamp has to predate
      // them; taking it at write time would let the batch overwrite what the user just did.
      const item = makeItem({ absLibraryItemId: 'i1', asin: 'ASIN123' });
      mockRepo.findBookIdsByAudibleIds.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 12));
        return [exactRow('ASIN123', 7)];
      });

      await makeService().matchItems(superuser, [item], { force: false });

      const [, rows, readAt] = mockRepo.bulkUpsertBookStates.mock.calls[0]! as [number, AbsBookStateUpsert[], Date];
      expect(readAt.getTime()).toBeLessThan(rows[0]!.lastMatchAttemptAt.getTime());
    });
  });

  describe('matchItems - ABS context refresh for skipped rows', () => {
    it('refreshes library, series, and path for a settled row without re-upserting it', async () => {
      mockRepo.findBookStatesByAbsItemIds.mockResolvedValue([
        { absLibraryItemId: 'i-linked', bookId: 7, matchMethod: 'asin', needsReview: false, manualUnlinked: false, lastMatchAttemptAt: null },
      ]);
      const linked = makeItem({ absLibraryItemId: 'i-linked', seriesName: 'Mistborn', libraryName: 'Graphic Audio', path: '/abs/mistborn-6' });
      const fresh = makeItem({ absLibraryItemId: 'i-new', title: 'T', author: 'A' });

      await makeService().matchItems(superuser, [linked, fresh], { force: false });

      expect(mockRepo.refreshAbsContext).toHaveBeenCalledWith(42, [
        { absLibraryItemId: 'i-linked', absSeriesName: 'Mistborn', absLibraryName: 'Graphic Audio', absPath: '/abs/mistborn-6' },
      ]);
      const upserts = capturedUpserts();
      expect(upserts.has('i-linked')).toBe(false);
      expect(upserts.has('i-new')).toBe(true);
    });

    it('still refreshes context when every item on the page is skipped', async () => {
      mockRepo.findBookStatesByAbsItemIds.mockResolvedValue([
        { absLibraryItemId: 'i-linked', bookId: 7, matchMethod: 'manual', needsReview: false, manualUnlinked: false, lastMatchAttemptAt: null },
      ]);
      const linked = makeItem({ absLibraryItemId: 'i-linked', seriesName: null, libraryName: 'Fiction', path: '/abs/somewhere' });

      const summary = await makeService().matchItems(superuser, [linked], { force: false });

      expect(summary.skipped).toBe(1);
      expect(mockRepo.bulkUpsertBookStates).not.toHaveBeenCalled();
      expect(mockRepo.refreshAbsContext).toHaveBeenCalledWith(42, [
        { absLibraryItemId: 'i-linked', absSeriesName: null, absLibraryName: 'Fiction', absPath: '/abs/somewhere' },
      ]);
    });
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

    it('carries the ABS series, library, and path facts from the item into every upsert row', async () => {
      const item = makeItem({
        absLibraryItemId: 'i1',
        isbn: '9781234567890',
        seriesName: 'The Expanse #3',
        path: '/audiobooks/Author/Title',
        libraryName: 'Audiobooks',
      });
      mockRepo.findBookIdsByIsbns.mockResolvedValue([exactRow('9781234567890', 12)]);

      await makeService().matchItems(superuser, [item], { force: false });

      expect(capturedUpserts().get('i1')).toMatchObject({
        absSeriesName: 'The Expanse #3',
        absPath: '/audiobooks/Author/Title',
        absLibraryName: 'Audiobooks',
      });
    });

    it('carries the ABS series, library, and path facts through an unmatched (no-hit) row too', async () => {
      const item = makeItem({
        absLibraryItemId: 'i1',
        seriesName: 'Some Series',
        path: '/audiobooks/Author/Title',
        libraryName: 'Audiobooks',
      });

      await makeService().matchItems(superuser, [item], { force: false });

      expect(capturedUpserts().get('i1')).toMatchObject({
        absSeriesName: 'Some Series',
        absPath: '/audiobooks/Author/Title',
        absLibraryName: 'Audiobooks',
        bookId: null,
      });
    });
  });

  describe('matchItems - path tier', () => {
    const mappings = [{ absPrefix: '/audiobooks', localPrefix: '/books' }];

    it('auto-links a unique mapped path hit with matchMethod path and no review', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', path: '/audiobooks/Author/Title' });
      mockRepo.findBookIdsByPaths.mockResolvedValue([exactRow('/books/Author/Title', 21)]);

      const summary = await makeService().matchItems(superuser, [item], { force: false, pathMappings: mappings });

      expect(mockRepo.findBookIdsByPaths).toHaveBeenCalledWith([1, 2], undefined, ['/books/Author/Title']);
      expect(capturedUpserts().get('i1')).toMatchObject({
        bookId: 21,
        matchMethod: 'path',
        matchConfidence: 100,
        needsReview: false,
        matchError: null,
      });
      expect(summary.autoLinked).toBe(1);
    });

    it('normalizes duplicate separators and trailing slashes on both the item path and the prefixes', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', path: '/audiobooks//Author/Title/' });
      mockRepo.findBookIdsByPaths.mockResolvedValue([exactRow('/books/Author/Title', 21)]);

      await makeService().matchItems(superuser, [item], {
        force: false,
        pathMappings: [{ absPrefix: '/audiobooks/', localPrefix: '/books//' }],
      });

      expect(mockRepo.findBookIdsByPaths).toHaveBeenCalledWith([1, 2], undefined, ['/books/Author/Title']);
      expect(capturedUpserts().get('i1')).toMatchObject({ bookId: 21, matchMethod: 'path' });
    });

    it('applies the longest matching absPrefix when several mappings could apply', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', path: '/audiobooks/scifi/Author/Title' });
      mockRepo.findBookIdsByPaths.mockResolvedValue([exactRow('/library/scifi-audio/Author/Title', 33)]);

      const summary = await makeService().matchItems(superuser, [item], {
        force: false,
        pathMappings: [
          { absPrefix: '/audiobooks', localPrefix: '/books' },
          { absPrefix: '/audiobooks/scifi', localPrefix: '/library/scifi-audio' },
        ],
      });

      expect(mockRepo.findBookIdsByPaths).toHaveBeenCalledWith([1, 2], undefined, ['/library/scifi-audio/Author/Title']);
      expect(capturedUpserts().get('i1')).toMatchObject({ bookId: 33, matchMethod: 'path' });
      expect(summary.autoLinked).toBe(1);
    });

    it('does NOT guess when one mapped path resolves to two books: ambiguous_path, bookId null, errors++', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', path: '/audiobooks/Author/Title' });
      mockRepo.findBookIdsByPaths.mockResolvedValue([exactRow('/books/Author/Title', 4), exactRow('/books/Author/Title', 5)]);

      const summary = await makeService().matchItems(superuser, [item], { force: false, pathMappings: mappings });

      expect(capturedUpserts().get('i1')).toMatchObject({
        bookId: null,
        matchMethod: null,
        matchConfidence: null,
        needsReview: false,
        matchError: 'ambiguous_path',
      });
      expect(summary.errors).toBe(1);
      expect(summary.autoLinked).toBe(0);
    });

    it('falls through to fuzzy when the mapped path matches no local file', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', path: '/audiobooks/Author/Title', title: 'Test Book', author: 'Test Author' });
      mockRepo.findBookIdsByPaths.mockResolvedValue([]);
      mockRepo.findFuzzyCandidatesForTitles.mockResolvedValue(new Map([['Test Book', [fuzzyCandidate({ bookId: 55 })]]]));

      const summary = await makeService().matchItems(superuser, [item], { force: false, pathMappings: mappings });

      expect(capturedUpserts().get('i1')).toMatchObject({ bookId: 55, matchMethod: 'title_author_series', needsReview: true });
      expect(summary.needsReview).toBe(1);
    });

    it('skips the tier entirely when no mappings are configured', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', path: '/audiobooks/Author/Title' });

      const summary = await makeService().matchItems(superuser, [item], { force: false });

      expect(mockRepo.findBookIdsByPaths).not.toHaveBeenCalled();
      expect(summary.unmatched).toBe(1);
    });

    it('skips the tier for an item with no path, and for a path no mapping covers', async () => {
      const items = [makeItem({ absLibraryItemId: 'i1' }), makeItem({ absLibraryItemId: 'i2', path: '/podcasts/Author/Title' })];

      const summary = await makeService().matchItems(superuser, items, { force: false, pathMappings: mappings });

      expect(mockRepo.findBookIdsByPaths).not.toHaveBeenCalled();
      expect(summary.unmatched).toBe(2);
    });

    it('keeps the cascade order: a matching ISBN wins over a mapped path pointing at another book', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', isbn: '9781234567890', path: '/audiobooks/Author/Title' });
      mockRepo.findBookIdsByIsbns.mockResolvedValue([exactRow('9781234567890', 12)]);
      mockRepo.findBookIdsByPaths.mockResolvedValue([exactRow('/books/Author/Title', 999)]);

      const summary = await makeService().matchItems(superuser, [item], { force: false, pathMappings: mappings });

      expect(capturedUpserts().get('i1')).toMatchObject({ bookId: 12, matchMethod: 'isbn' });
      expect(summary.autoLinked).toBe(1);
    });

    it('keeps the cascade order: ASIN wins over a mapped path pointing at another book', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', asin: 'ASIN123', path: '/audiobooks/Author/Title' });
      mockRepo.findBookIdsByAudibleIds.mockResolvedValue([exactRow('ASIN123', 7)]);
      mockRepo.findBookIdsByPaths.mockResolvedValue([exactRow('/books/Author/Title', 999)]);

      await makeService().matchItems(superuser, [item], { force: false, pathMappings: mappings });

      expect(capturedUpserts().get('i1')).toMatchObject({ bookId: 7, matchMethod: 'asin' });
    });

    it('deduplicates candidate paths across items in one page', async () => {
      const items = [
        makeItem({ absLibraryItemId: 'i1', path: '/audiobooks/Author/Title' }),
        makeItem({ absLibraryItemId: 'i2', path: '/audiobooks/Author/Title/' }),
      ];
      mockRepo.findBookIdsByPaths.mockResolvedValue([exactRow('/books/Author/Title', 21)]);

      await makeService().matchItems(superuser, items, { force: false, pathMappings: mappings });

      expect(mockRepo.findBookIdsByPaths).toHaveBeenCalledWith([1, 2], undefined, ['/books/Author/Title']);
      const upserts = capturedUpserts();
      expect(upserts.get('i1')).toMatchObject({ bookId: 21, matchMethod: 'path' });
      expect(upserts.get('i2')).toMatchObject({ bookId: 21, matchMethod: 'path' });
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

    // NOTE: a settled linked/manual state is skipped even under force:true; only manualUnlinked, the
    // lastMatchAttemptAt "unchanged" skip and pending-review proposals (see the upgrade suite below)
    // are force-gated.
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

  describe('matchItems - forced review upgrade', () => {
    const mappings = [{ absPrefix: '/audiobooks', localPrefix: '/books' }];

    function reviewState(overrides: Record<string, unknown> = {}) {
      return {
        absLibraryItemId: 'i1',
        bookId: 500,
        matchMethod: 'title_author_series',
        matchConfidence: 88,
        needsReview: true,
        manualUnlinked: false,
        lastMatchAttemptAt: new Date('2026-01-01'),
        ...overrides,
      };
    }

    it('replaces a review proposal with a unique ASIN hit, even when it points at another book', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', asin: 'ASIN123', title: 'Test Book', author: 'Test Author' });
      mockRepo.findBookStatesByAbsItemIds.mockResolvedValue([reviewState()]);
      mockRepo.findBookIdsByAudibleIds.mockResolvedValue([exactRow('ASIN123', 7)]);

      const summary = await makeService().matchItems(superuser, [item], { force: true });

      expect(capturedUpserts().get('i1')).toMatchObject({
        bookId: 7,
        matchMethod: 'asin',
        matchConfidence: 100,
        needsReview: false,
        matchError: null,
      });
      expect(summary.autoLinked).toBe(1);
      expect(summary.upgradedFromReview).toBe(1);
      expect(summary.processed).toBe(1);
      expect(summary.skipped).toBe(0);
      expect(mockRepo.findFuzzyCandidatesForTitles).not.toHaveBeenCalled();
    });

    it('replaces a review proposal with a unique mapped path hit', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', path: '/audiobooks/Author/Title', title: 'Test Book', author: 'Test Author' });
      mockRepo.findBookStatesByAbsItemIds.mockResolvedValue([reviewState()]);
      mockRepo.findBookIdsByPaths.mockResolvedValue([exactRow('/books/Author/Title', 21)]);

      const summary = await makeService().matchItems(superuser, [item], { force: true, pathMappings: mappings });

      expect(mockRepo.findBookIdsByPaths).toHaveBeenCalledWith([1, 2], undefined, ['/books/Author/Title']);
      expect(capturedUpserts().get('i1')).toMatchObject({ bookId: 21, matchMethod: 'path', matchConfidence: 100, needsReview: false });
      expect(summary.upgradedFromReview).toBe(1);
    });

    it('clears the proposal and records the ambiguity when the exact hit is ambiguous', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', asin: 'ASIN123', title: 'Test Book', author: 'Test Author' });
      mockRepo.findBookStatesByAbsItemIds.mockResolvedValue([reviewState()]);
      mockRepo.findBookIdsByAudibleIds.mockResolvedValue([exactRow('ASIN123', 1), exactRow('ASIN123', 2)]);

      const summary = await makeService().matchItems(superuser, [item], { force: true });

      expect(capturedUpserts().get('i1')).toMatchObject({ bookId: null, needsReview: false, matchError: 'ambiguous_asin' });
      expect(summary.errors).toBe(1);
      expect(summary.upgradedFromReview).toBe(0);
    });

    it('re-runs the fuzzy tier when no exact tier hits, replacing or clearing the proposal', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', asin: null, title: 'Test Book', author: 'Test Author' });
      mockRepo.findBookStatesByAbsItemIds.mockResolvedValue([reviewState()]);
      mockRepo.findFuzzyCandidatesForTitles.mockResolvedValue(
        new Map([['Test Book', [fuzzyCandidate({ bookId: 900, title: 'Test Book', authors: ['Test Author'] })]]]),
      );

      const summary = await makeService().matchItems(superuser, [item], { force: true });

      expect(mockRepo.findFuzzyCandidatesForTitles).toHaveBeenCalled();
      expect(capturedUpserts().get('i1')).toMatchObject({ bookId: 900, matchMethod: 'title_author_series', needsReview: true });
      expect(summary.needsReview).toBe(1);
      expect(summary.upgradedFromReview).toBe(0);
    });

    it('drops a proposal whose titles carry conflicting volume numbers', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', asin: null, title: 'The Primal Hunter 3', author: 'Zogarth' });
      mockRepo.findBookStatesByAbsItemIds.mockResolvedValue([reviewState()]);
      mockRepo.findFuzzyCandidatesForTitles.mockResolvedValue(
        new Map([['The Primal Hunter 3', [fuzzyCandidate({ bookId: 900, title: 'The Primal Hunter 16', authors: ['Zogarth'] })]]]),
      );

      const summary = await makeService().matchItems(superuser, [item], { force: true });

      expect(capturedUpserts().get('i1')).toMatchObject({ bookId: null, matchMethod: null, needsReview: false });
      expect(summary.unmatched).toBe(1);
    });

    it('never re-tests a review row when force is false', async () => {
      const item = makeItem({ absLibraryItemId: 'i1', asin: 'ASIN123' });
      mockRepo.findBookStatesByAbsItemIds.mockResolvedValue([reviewState()]);
      mockRepo.findBookIdsByAudibleIds.mockResolvedValue([exactRow('ASIN123', 7)]);

      const summary = await makeService().matchItems(superuser, [item], { force: false });

      expect(mockRepo.findBookIdsByAudibleIds).not.toHaveBeenCalled();
      expect(mockRepo.bulkUpsertBookStates).not.toHaveBeenCalled();
      expect(summary.skipped).toBe(1);
      expect(summary.upgradedFromReview).toBe(0);
    });

    it('never touches a manual link or a confirmed match under force', async () => {
      const items = [makeItem({ absLibraryItemId: 'i1', asin: 'ASIN123' }), makeItem({ absLibraryItemId: 'i2', asin: 'ASIN456' })];
      mockRepo.findBookStatesByAbsItemIds.mockResolvedValue([
        reviewState({ absLibraryItemId: 'i1', matchMethod: 'manual' }),
        // Confirming a proposal clears needsReview, which is what takes it out of the upgrade pass.
        reviewState({ absLibraryItemId: 'i2', needsReview: false }),
      ]);
      mockRepo.findBookIdsByAudibleIds.mockResolvedValue([exactRow('ASIN123', 7), exactRow('ASIN456', 8)]);

      const summary = await makeService().matchItems(superuser, items, { force: true });

      expect(mockRepo.bulkUpsertBookStates).not.toHaveBeenCalled();
      expect(summary.skipped).toBe(2);
      expect(summary.upgradedFromReview).toBe(0);
    });

    it('upgrades review rows alongside a normal match pass on the same page', async () => {
      const items = [
        makeItem({ absLibraryItemId: 'i1', asin: 'ASIN123', title: 'Test Book', author: 'Test Author' }),
        makeItem({ absLibraryItemId: 'i2', title: 'Another Book', author: 'Second Author' }),
      ];
      mockRepo.findBookStatesByAbsItemIds.mockResolvedValue([reviewState()]);
      mockRepo.findBookIdsByAudibleIds.mockResolvedValue([exactRow('ASIN123', 7)]);
      mockRepo.findFuzzyCandidatesForTitles.mockResolvedValue(
        new Map([['Another Book', [fuzzyCandidate({ bookId: 77, title: 'Another Book', authors: ['Second Author'] })]]]),
      );

      const summary = await makeService().matchItems(superuser, items, { force: true });

      const upserts = capturedUpserts();
      expect(upserts.get('i1')).toMatchObject({ bookId: 7, matchMethod: 'asin', needsReview: false });
      expect(upserts.get('i2')).toMatchObject({ bookId: 77, matchMethod: 'title_author_series', needsReview: true });
      expect(mockRepo.findFuzzyCandidatesForTitles).toHaveBeenCalledWith([1, 2], undefined, ['Another Book'], 20);
      expect(summary.upgradedFromReview).toBe(1);
      expect(summary.autoLinked).toBe(1);
      expect(summary.needsReview).toBe(1);
      expect(summary.processed).toBe(2);
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
          { id: 'lib-book', name: 'Books', mediaType: 'book', folderPaths: ['/audiobooks'] },
          { id: 'lib-pod', name: 'Podcasts', mediaType: 'podcast', folderPaths: ['/podcasts'] },
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

    it('threads the ABS library name from the inventory walk into the upsert row', async () => {
      mockClient.getLibraries.mockResolvedValue({
        libraries: [{ id: 'lib-book', name: 'My Audiobooks', mediaType: 'book', folderPaths: ['/audiobooks'] }],
      });
      mockClient.getLibraryItems.mockResolvedValue({
        results: [
          {
            id: 'i1',
            libraryId: 'lib-book',
            mediaType: 'book',
            media: { metadata: { title: 'T', subtitle: null, authorName: 'A', seriesName: null, isbn: null, asin: null }, duration: null },
          },
        ],
        total: 1,
        limit: 500,
        page: 0,
      });

      await makeService().matchLibrary(superuser, 'https://abs.example', 'token', { force: true });

      expect(capturedUpserts().get('i1')).toMatchObject({ absLibraryName: 'My Audiobooks' });
    });

    it('excludes libraries listed in excludedLibraryIds', async () => {
      mockClient.getLibraries.mockResolvedValue({
        libraries: [{ id: 'lib-book', name: 'Books', mediaType: 'book', folderPaths: ['/audiobooks'] }],
      });

      const summary = await makeService().matchLibrary(superuser, 'https://abs.example', 'token', { force: true, excludedLibraryIds: ['lib-book'] });

      expect(mockClient.getLibraryItems).not.toHaveBeenCalled();
      expect(summary.totalItems).toBe(0);
    });

    it('persists the removable stale count after the full walk', async () => {
      mockClient.getLibraries.mockResolvedValue({ libraries: [{ id: 'lib-book', name: 'Books', mediaType: 'book', folderPaths: ['/audiobooks'] }] });
      mockClient.getLibraryItems.mockResolvedValue({
        results: [
          {
            id: 'i1',
            libraryId: 'lib-book',
            mediaType: 'book',
            media: { metadata: { title: 'T', subtitle: null, authorName: 'A', seriesName: null, isbn: null, asin: null }, duration: null },
          },
        ],
        total: 1,
        limit: 500,
        page: 0,
      });
      mockRepo.findBookStateCleanupCandidates.mockResolvedValue([
        { id: 1, absLibraryItemId: 'i1', bookId: null, syncExcluded: false },
        { id: 2, absLibraryItemId: 'gone-a', bookId: null, syncExcluded: false },
        { id: 3, absLibraryItemId: 'gone-b', bookId: null, syncExcluded: false },
        { id: 4, absLibraryItemId: 'gone-linked', bookId: 9, syncExcluded: false },
      ]);

      await makeService().matchLibrary(superuser, 'https://abs.example', 'token', { force: false });

      expect(mockRepo.updateStaleCount).toHaveBeenCalledWith(42, 2);
      expect(mockRepo.deleteBookStatesByAbsItemIds).not.toHaveBeenCalled();
    });

    it('leaves the stored stale count alone when the walk saw no items at all', async () => {
      mockClient.getLibraries.mockResolvedValue({ libraries: [] });

      await makeService().matchLibrary(superuser, 'https://abs.example', 'token', { force: false });

      expect(mockRepo.findBookStateCleanupCandidates).not.toHaveBeenCalled();
      expect(mockRepo.updateStaleCount).not.toHaveBeenCalled();
    });

    it('counts a manually unlinked stale row into the persisted stale count', async () => {
      // staleCount means "what a cleanup could remove"; a repeat cleanup with the box ticked would
      // still find a manually unlinked row, so recordStaleCount must count it in.
      mockClient.getLibraries.mockResolvedValue({ libraries: [{ id: 'lib-book', name: 'Books', mediaType: 'book', folderPaths: ['/audiobooks'] }] });
      mockClient.getLibraryItems.mockResolvedValue({
        results: [
          {
            id: 'i1',
            libraryId: 'lib-book',
            mediaType: 'book',
            media: { metadata: { title: 'T', subtitle: null, authorName: 'A', seriesName: null, isbn: null, asin: null }, duration: null },
          },
        ],
        total: 1,
        limit: 500,
        page: 0,
      });
      mockRepo.findBookStateCleanupCandidates.mockResolvedValue([
        { id: 1, absLibraryItemId: 'i1', bookId: null, syncExcluded: false, manualUnlinked: false },
        { id: 2, absLibraryItemId: 'gone-manual', bookId: null, syncExcluded: false, manualUnlinked: true },
      ]);

      await makeService().matchLibrary(superuser, 'https://abs.example', 'token', { force: false });

      expect(mockRepo.updateStaleCount).toHaveBeenCalledWith(42, 1);
    });
  });

  describe('rescan - concurrency guard', () => {
    it('rejects while a cleanup already holds the inventory-walk guard', async () => {
      let releaseLibraries: (value: { libraries: unknown[] }) => void = () => {};
      mockClient.getLibraries.mockReturnValue(new Promise((resolve) => (releaseLibraries = resolve)));
      mockRepo.findBookStateCleanupCandidates.mockResolvedValue([]);
      const service = makeService();

      const cleanupCall = service.cleanupStale(superuser, { includeManuallyUnlinked: false });
      await expect(service.rescan(superuser)).rejects.toBeInstanceOf(ConflictException);

      releaseLibraries({ libraries: [] });
      await expect(cleanupCall).rejects.toThrow(/empty inventory/i);
    });

    it('releases the guard after a failed rescan, letting a later rescan run', async () => {
      mockClient.getLibraries.mockRejectedValueOnce(new Error('network down'));
      const service = makeService();

      await expect(service.rescan(superuser)).rejects.toThrow(/network down/);

      mockClient.getLibraries.mockResolvedValue({ libraries: [] });
      await expect(service.rescan(superuser)).resolves.toEqual({ queued: 0 });
    });
  });

  describe('cleanupStale', () => {
    function stubInventory(itemIds: string[]): void {
      mockClient.getLibraries.mockResolvedValue({ libraries: [{ id: 'lib-book', name: 'Books', mediaType: 'book', folderPaths: ['/audiobooks'] }] });
      mockClient.getLibraryItems.mockResolvedValue({
        results: itemIds.map((id) => ({
          id,
          libraryId: 'lib-book',
          mediaType: 'book',
          media: { metadata: { title: 'T', subtitle: null, authorName: 'A', seriesName: null, isbn: null, asin: null }, duration: null },
        })),
        total: itemIds.length,
        limit: 500,
        page: 0,
      });
    }

    function candidate(
      overrides: Partial<{ id: number; absLibraryItemId: string; bookId: number | null; syncExcluded: boolean; manualUnlinked: boolean }> = {},
    ) {
      return { id: 1, absLibraryItemId: 'abs-1', bookId: null, syncExcluded: false, manualUnlinked: false, ...overrides };
    }

    const KEEP = { includeManuallyUnlinked: false };
    const INCLUDE = { includeManuallyUnlinked: true };

    it('rejects when Audiobookshelf sync is not configured and deletes nothing', async () => {
      mockRepo.findSettings.mockResolvedValue({ enabled: false, serverUrl: 'https://abs.example', apiToken: 'token' });

      await expect(makeService().cleanupStale(superuser, KEEP)).rejects.toBeInstanceOf(BadRequestException);
      expect(mockClient.getLibraries).not.toHaveBeenCalled();
      expect(mockRepo.deleteBookStatesByAbsItemIds).not.toHaveBeenCalled();
    });

    it('aborts without deleting when a page fetch fails mid-walk', async () => {
      mockClient.getLibraries.mockResolvedValue({ libraries: [{ id: 'lib-book', name: 'Books', mediaType: 'book', folderPaths: ['/audiobooks'] }] });
      mockClient.getLibraryItems.mockRejectedValue(new Error('Could not reach the Audiobookshelf server'));
      mockRepo.findBookStateCleanupCandidates.mockResolvedValue([candidate()]);

      await expect(makeService().cleanupStale(superuser, KEEP)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(mockRepo.findBookStateCleanupCandidates).not.toHaveBeenCalled();
      expect(mockRepo.deleteBookStatesByAbsItemIds).not.toHaveBeenCalled();
    });

    it('refuses to clean against an empty inventory', async () => {
      stubInventory([]);
      mockRepo.findBookStateCleanupCandidates.mockResolvedValue([candidate()]);

      await expect(makeService().cleanupStale(superuser, KEEP)).rejects.toThrow(/empty inventory/i);
      expect(mockRepo.findBookStateCleanupCandidates).not.toHaveBeenCalled();
      expect(mockRepo.deleteBookStatesByAbsItemIds).not.toHaveBeenCalled();
    });

    it('deletes only unseen rows with no book, no exclusion, and no manual unlink, counting the rest', async () => {
      stubInventory(['seen-1']);
      mockRepo.findBookStateCleanupCandidates.mockResolvedValue([
        candidate({ id: 1, absLibraryItemId: 'seen-1' }),
        candidate({ id: 2, absLibraryItemId: 'gone-unmatched' }),
        candidate({ id: 3, absLibraryItemId: 'gone-linked', bookId: 42 }),
        candidate({ id: 4, absLibraryItemId: 'gone-excluded', syncExcluded: true }),
        candidate({ id: 5, absLibraryItemId: 'gone-linked-excluded', bookId: 43, syncExcluded: true }),
        candidate({ id: 6, absLibraryItemId: 'gone-manual-unlinked', manualUnlinked: true }),
      ]);
      mockRepo.deleteBookStatesByAbsItemIds.mockResolvedValue(1);

      const result = await makeService().cleanupStale(superuser, KEEP);

      expect(mockRepo.deleteBookStatesByAbsItemIds).toHaveBeenCalledWith(42, ['gone-unmatched'], KEEP);
      expect(result).toEqual({ removed: 1, staleLinked: 2, staleExcluded: 1, staleManuallyUnlinked: 1, seenItems: 1 });
      // Everything removable is gone; the manually unlinked row is kept and counted into staleCount.
      expect(mockRepo.updateStaleCount).toHaveBeenCalledWith(42, 1);
    });

    it('keeps a manually unlinked row by default: not deleted, counted in staleManuallyUnlinked and staleCount', async () => {
      stubInventory(['seen-1']);
      mockRepo.findBookStateCleanupCandidates.mockResolvedValue([candidate({ id: 1, absLibraryItemId: 'gone-manual', manualUnlinked: true })]);
      mockRepo.deleteBookStatesByAbsItemIds.mockResolvedValue(0);

      const result = await makeService().cleanupStale(superuser, KEEP);

      expect(mockRepo.deleteBookStatesByAbsItemIds).toHaveBeenCalledWith(42, [], KEEP);
      expect(result).toEqual({ removed: 0, staleLinked: 0, staleExcluded: 0, staleManuallyUnlinked: 1, seenItems: 1 });
      expect(mockRepo.updateStaleCount).toHaveBeenCalledWith(42, 1);
    });

    it('removes a manually unlinked row when includeManuallyUnlinked is true', async () => {
      stubInventory(['seen-1']);
      mockRepo.findBookStateCleanupCandidates.mockResolvedValue([candidate({ id: 1, absLibraryItemId: 'gone-manual', manualUnlinked: true })]);
      mockRepo.deleteBookStatesByAbsItemIds.mockResolvedValue(1);

      const result = await makeService().cleanupStale(superuser, INCLUDE);

      expect(mockRepo.deleteBookStatesByAbsItemIds).toHaveBeenCalledWith(42, ['gone-manual'], INCLUDE);
      expect(result).toEqual({ removed: 1, staleLinked: 0, staleExcluded: 0, staleManuallyUnlinked: 0, seenItems: 1 });
      expect(mockRepo.updateStaleCount).toHaveBeenCalledWith(42, 0);
    });

    it('persists what a repeat cleanup would still find when a row survived the delete', async () => {
      stubInventory(['seen-1']);
      mockRepo.findBookStateCleanupCandidates.mockResolvedValue([
        candidate({ id: 1, absLibraryItemId: 'gone-a' }),
        candidate({ id: 2, absLibraryItemId: 'gone-b' }),
        candidate({ id: 3, absLibraryItemId: 'gone-c' }),
      ]);
      mockRepo.deleteBookStatesByAbsItemIds.mockResolvedValue(2);

      await makeService().cleanupStale(superuser, KEEP);

      expect(mockRepo.updateStaleCount).toHaveBeenCalledWith(42, 1);
    });

    it('does not touch the stored stale count when the inventory walk fails', async () => {
      mockClient.getLibraries.mockResolvedValue({ libraries: [{ id: 'lib-book', name: 'Books', mediaType: 'book', folderPaths: ['/audiobooks'] }] });
      mockClient.getLibraryItems.mockRejectedValue(new Error('Could not reach the Audiobookshelf server'));

      await expect(makeService().cleanupStale(superuser, KEEP)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(mockRepo.updateStaleCount).not.toHaveBeenCalled();
    });

    it('scopes the cleanup scan to the user and pages by keyset until a short page', async () => {
      stubInventory(['seen-1']);
      const firstPage = Array.from({ length: 1000 }, (_, i) => candidate({ id: i + 1, absLibraryItemId: `gone-${i}` }));
      mockRepo.findBookStateCleanupCandidates
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValueOnce([candidate({ id: 1001, absLibraryItemId: 'gone-last' })]);
      mockRepo.deleteBookStatesByAbsItemIds.mockResolvedValue(1001);

      const result = await makeService().cleanupStale(superuser, KEEP);

      expect(mockRepo.findBookStateCleanupCandidates).toHaveBeenNthCalledWith(1, 42, 0, 1000);
      expect(mockRepo.findBookStateCleanupCandidates).toHaveBeenNthCalledWith(2, 42, 1000, 1000);
      expect(mockRepo.findBookStateCleanupCandidates).toHaveBeenCalledTimes(2);
      expect(mockRepo.deleteBookStatesByAbsItemIds.mock.calls[0]![1]).toHaveLength(1001);
      expect(result.removed).toBe(1001);
    });

    it('rejects a second cleanup while one is already running for the same user', async () => {
      let releaseLibraries: (value: { libraries: unknown[] }) => void = () => {};
      mockClient.getLibraries.mockReturnValue(new Promise((resolve) => (releaseLibraries = resolve)));
      const service = makeService();

      const first = service.cleanupStale(superuser, KEEP);
      await expect(service.cleanupStale(superuser, KEEP)).rejects.toBeInstanceOf(ConflictException);

      releaseLibraries({ libraries: [] });
      await expect(first).rejects.toThrow(/empty inventory/i);
      await expect(service.cleanupStale(superuser, KEEP)).rejects.toThrow(/empty inventory/i);
    });

    it('rejects cleanup while a rescan holds the walk guard', async () => {
      let releaseLibraries: (value: { libraries: unknown[] }) => void = () => {};
      mockClient.getLibraries.mockReturnValue(new Promise((resolve) => (releaseLibraries = resolve)));
      const service = makeService();

      const rescanCall = service.rescan(superuser);
      await expect(service.cleanupStale(superuser, KEEP)).rejects.toBeInstanceOf(ConflictException);

      releaseLibraries({ libraries: [] });
      await rescanCall;
    });

    describe('incomplete inventory page mid-walk', () => {
      function stubShortMidWalkPage(): void {
        mockClient.getLibraries.mockResolvedValue({
          libraries: [{ id: 'lib-book', name: 'Books', mediaType: 'book', folderPaths: ['/audiobooks'] }],
        });
        mockClient.getLibraryItems.mockResolvedValue({
          results: [
            {
              id: 'i1',
              libraryId: 'lib-book',
              mediaType: 'book',
              media: { metadata: { title: 'T', subtitle: null, authorName: 'A', seriesName: null, isbn: null, asin: null }, duration: null },
            },
          ],
          total: 2,
          limit: 500,
          page: 0,
        });
      }

      it('throws ServiceUnavailableException and deletes nothing, writes no stale count', async () => {
        stubShortMidWalkPage();
        mockRepo.findBookStateCleanupCandidates.mockResolvedValue([candidate()]);

        await expect(makeService().cleanupStale(superuser, KEEP)).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(mockRepo.findBookStateCleanupCandidates).not.toHaveBeenCalled();
        expect(mockRepo.deleteBookStatesByAbsItemIds).not.toHaveBeenCalled();
        expect(mockRepo.updateStaleCount).not.toHaveBeenCalled();
      });

      it('completes normally when the final page is short and total agrees nothing remains', async () => {
        mockClient.getLibraries.mockResolvedValue({
          libraries: [{ id: 'lib-book', name: 'Books', mediaType: 'book', folderPaths: ['/audiobooks'] }],
        });
        mockClient.getLibraryItems.mockResolvedValue({
          results: [
            {
              id: 'seen-1',
              libraryId: 'lib-book',
              mediaType: 'book',
              media: { metadata: { title: 'T', subtitle: null, authorName: 'A', seriesName: null, isbn: null, asin: null }, duration: null },
            },
          ],
          // A short page (1 < the 500 page size) that IS the whole inventory: total agrees, so this
          // must terminate the walk normally rather than throw.
          total: 1,
          limit: 500,
          page: 0,
        });
        mockRepo.findBookStateCleanupCandidates.mockResolvedValue([candidate({ id: 1, absLibraryItemId: 'gone-1' })]);
        mockRepo.deleteBookStatesByAbsItemIds.mockResolvedValue(1);

        const result = await makeService().cleanupStale(superuser, KEEP);

        expect(result.seenItems).toBe(1);
        expect(mockRepo.deleteBookStatesByAbsItemIds).toHaveBeenCalledWith(42, ['gone-1'], KEEP);
      });
    });
  });

  describe('suggestPathMappings', () => {
    function stubInventoryPaths(paths: (string | null)[]): void {
      mockClient.getLibraries.mockResolvedValue({ libraries: [{ id: 'lib-book', name: 'Books', mediaType: 'book', folderPaths: ['/audiobooks'] }] });
      mockClient.getLibraryItems.mockResolvedValue({
        results: paths.map((path, index) => ({
          id: `abs-${index}`,
          libraryId: 'lib-book',
          mediaType: 'book',
          path,
          media: { metadata: { title: 'T', subtitle: null, authorName: 'A', seriesName: null, isbn: null, asin: null }, duration: null },
        })),
        total: paths.length,
        limit: 500,
        page: 0,
      });
    }

    /**
     * Serves `paths` as real 500-item pages the way Audiobookshelf does, so a fixture larger than one
     * page walks (and terminates) instead of being replayed whole on every page.
     */
    function stubPagedInventoryPaths(paths: string[]): void {
      mockClient.getLibraries.mockResolvedValue({ libraries: [{ id: 'lib-book', name: 'Books', mediaType: 'book', folderPaths: ['/audiobooks'] }] });
      mockClient.getLibraryItems.mockImplementation(
        (_userId: number, _serverUrl: string, _token: string, _libraryId: string, options: { limit: number; page: number }) => {
          const start = options.page * options.limit;
          const slice = paths.slice(start, start + options.limit);
          return Promise.resolve({
            results: slice.map((path, index) => ({
              id: `abs-${start + index}`,
              libraryId: 'lib-book',
              mediaType: 'book',
              path,
              media: { metadata: { title: 'T', subtitle: null, authorName: 'A', seriesName: null, isbn: null, asin: null }, duration: null },
            })),
            total: paths.length,
            limit: options.limit,
            page: options.page,
          });
        },
      );
    }

    /** `count` folder paths under `prefix`, keyed `Author {n}/Book {n}` so both sides can share keys. */
    function folders(prefix: string, count: number, firstIndex = 0): string[] {
      return Array.from({ length: count }, (_, i) => `${prefix}/Author ${firstIndex + i}/Book ${firstIndex + i}`);
    }

    it('suggests a pair once enough items agree, and drops the ones below the support threshold', async () => {
      stubInventoryPaths([...folders('/audiobooks', 5), ...folders('/media/abs', 4, 100)]);
      mockRepo.findDistinctBookFolderPaths.mockResolvedValue([...folders('/books', 5), ...folders('/books', 4, 100)]);

      const result = await makeService().suggestPathMappings(superuser);

      expect(result).toEqual({ suggestions: [{ absPrefix: '/audiobooks', localPrefix: '/books', supportCount: 5 }], scannedItems: 9 });
      expect(mockRepo.findDistinctBookFolderPaths).toHaveBeenCalledWith([1, 2], undefined, null, 2000);
    });

    it('returns the strongest ten candidates, highest support first', async () => {
      const absPaths: string[] = [];
      const localPaths: string[] = [];
      // Prefix n carries 5 + n agreeing items, so the weakest of the eleven is the one that falls off.
      for (let n = 0; n < 11; n++) {
        const first = n * 100;
        absPaths.push(...folders(`/abs-${n}`, 5 + n, first));
        localPaths.push(...folders('/books', 5 + n, first));
      }
      stubInventoryPaths(absPaths);
      mockRepo.findDistinctBookFolderPaths.mockResolvedValue(localPaths);

      const { suggestions } = await makeService().suggestPathMappings(superuser);

      expect(suggestions).toHaveLength(10);
      expect(suggestions[0]).toEqual({ absPrefix: '/abs-10', localPrefix: '/books', supportCount: 15 });
      expect(suggestions.map((suggestion) => suggestion.supportCount)).toEqual([15, 14, 13, 12, 11, 10, 9, 8, 7, 6]);
      expect(suggestions.some((suggestion) => suggestion.absPrefix === '/abs-0')).toBe(false);
    });

    it('abstains for items whose trailing folders exist under more than one local prefix', async () => {
      const ambiguous = folders('/audiobooks', 6);
      const unique = folders('/audiobooks', 5, 100);
      stubInventoryPaths([...ambiguous, ...unique]);
      mockRepo.findDistinctBookFolderPaths.mockResolvedValue([...folders('/books', 6), ...folders('/media/books', 6), ...folders('/books', 5, 100)]);

      const { suggestions } = await makeService().suggestPathMappings(superuser);

      expect(suggestions).toEqual([{ absPrefix: '/audiobooks', localPrefix: '/books', supportCount: 5 }]);
    });

    it('excludes pairs already saved, comparing them canonicalized', async () => {
      mockRepo.findSettings.mockResolvedValue({
        enabled: true,
        serverUrl: 'https://abs.example',
        apiToken: 'token',
        excludedLibraryIds: [],
        pathMappings: [{ absPrefix: '/audiobooks//', localPrefix: '/books/' }],
      });
      stubInventoryPaths(folders('/audiobooks', 6));
      mockRepo.findDistinctBookFolderPaths.mockResolvedValue(folders('/books', 6));

      const result = await makeService().suggestPathMappings(superuser);

      expect(result).toEqual({ suggestions: [], scannedItems: 6 });
    });

    it('skips items without a path but still counts them as scanned', async () => {
      stubInventoryPaths([...folders('/audiobooks', 5), null, null]);
      mockRepo.findDistinctBookFolderPaths.mockResolvedValue(folders('/books', 5));

      const result = await makeService().suggestPathMappings(superuser);

      expect(result).toEqual({ suggestions: [{ absPrefix: '/audiobooks', localPrefix: '/books', supportCount: 5 }], scannedItems: 7 });
    });

    it('never offers the filesystem root as either side of a mapping', async () => {
      // Items sitting directly under a root split to a `/` prefix, which matches every absolute path
      // yet rewrites nothing, so such a pair must never be offered from either side.
      stubInventoryPaths(Array.from({ length: 6 }, (_, i) => `/Author ${i}/Book ${i}`));
      mockRepo.findDistinctBookFolderPaths.mockResolvedValue(folders('/books', 6));

      await expect(makeService().suggestPathMappings(superuser)).resolves.toEqual({ suggestions: [], scannedItems: 6 });

      stubInventoryPaths(folders('/audiobooks', 6));
      mockRepo.findDistinctBookFolderPaths.mockResolvedValue(Array.from({ length: 6 }, (_, i) => `/Author ${i}/Book ${i}`));

      await expect(makeService().suggestPathMappings(superuser)).resolves.toEqual({ suggestions: [], scannedItems: 6 });
    });

    // The cap is 5000 distinct trailing keys; these two pin both sides of that boundary.
    it('indexes a new trailing key while the cap still has room', async () => {
      stubPagedInventoryPaths([...folders('/filler', 4994, 10_000), ...folders('/audiobooks', 6)]);
      mockRepo.findDistinctBookFolderPaths.mockResolvedValue(folders('/books', 6));

      const result = await makeService().suggestPathMappings(superuser);

      expect(result.scannedItems).toBe(5000);
      expect(result.suggestions).toEqual([{ absPrefix: '/audiobooks', localPrefix: '/books', supportCount: 6 }]);
    });

    it('stops indexing new trailing keys once the cap is reached', async () => {
      stubPagedInventoryPaths([...folders('/filler', 5000, 10_000), ...folders('/audiobooks', 6)]);
      mockRepo.findDistinctBookFolderPaths.mockResolvedValue(folders('/books', 6));

      const result = await makeService().suggestPathMappings(superuser);

      // Same six agreeing items as above, but their keys arrive after the index is full.
      expect(result.scannedItems).toBe(5006);
      expect(result.suggestions).toEqual([]);
    });

    it('scopes the local folder read to the accessible libraries and content filters', async () => {
      const filters = { some: 'rule' };
      const nonSuperuser = { id: 7, isSuperuser: false, contentFilters: filters } as any;
      stubInventoryPaths(folders('/audiobooks', 5));

      await makeService().suggestPathMappings(nonSuperuser);

      expect(mockRepo.findDistinctBookFolderPaths).toHaveBeenCalledWith([1, 2], filters, null, 2000);
    });

    it('rejects when Audiobookshelf sync is not configured', async () => {
      mockRepo.findSettings.mockResolvedValue({ enabled: false, serverUrl: 'https://abs.example', apiToken: 'token' });

      await expect(makeService().suggestPathMappings(superuser)).rejects.toBeInstanceOf(BadRequestException);
      expect(mockClient.getLibraries).not.toHaveBeenCalled();
    });

    it('aborts without reading local folders when a page fetch fails mid-walk', async () => {
      mockClient.getLibraries.mockResolvedValue({ libraries: [{ id: 'lib-book', name: 'Books', mediaType: 'book', folderPaths: ['/audiobooks'] }] });
      mockClient.getLibraryItems.mockRejectedValue(new Error('Could not reach the Audiobookshelf server'));

      await expect(makeService().suggestPathMappings(superuser)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(mockRepo.findDistinctBookFolderPaths).not.toHaveBeenCalled();
    });

    it('refuses to infer anything from an empty inventory', async () => {
      stubInventoryPaths([]);

      await expect(makeService().suggestPathMappings(superuser)).rejects.toBeInstanceOf(BadRequestException);
      expect(mockRepo.findDistinctBookFolderPaths).not.toHaveBeenCalled();
    });

    it('shares the in-flight guard with the cleanup so one user never runs two inventory walks', async () => {
      let releaseLibraries: (value: { libraries: unknown[] }) => void = () => {};
      mockClient.getLibraries.mockReturnValue(new Promise((resolve) => (releaseLibraries = resolve)));
      const service = makeService();

      const first = service.suggestPathMappings(superuser);
      await expect(service.suggestPathMappings(superuser)).rejects.toBeInstanceOf(ConflictException);
      await expect(service.cleanupStale(superuser, { includeManuallyUnlinked: false })).rejects.toBeInstanceOf(ConflictException);
      await expect(service.rescan(superuser)).rejects.toBeInstanceOf(ConflictException);

      releaseLibraries({ libraries: [] });
      await expect(first).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.cleanupStale(superuser, { includeManuallyUnlinked: false })).rejects.toThrow(/empty inventory/i);
    });
  });
});
