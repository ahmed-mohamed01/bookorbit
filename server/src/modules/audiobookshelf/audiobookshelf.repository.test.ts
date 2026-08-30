import { describe, it, expect, vi, beforeEach } from 'vitest';
import { and, asc, eq, gt, inArray, isNull, isNotNull, ne } from 'drizzle-orm';

import { AudiobookshelfRepository, type AbsBookStateUpsert } from './audiobookshelf.repository';
import { audiobookshelfBookState, audiobookshelfUserSettings } from './schema/audiobookshelf.schema';
import * as schema from '../../db/schema';
import { AUDIO_FORMATS } from '../scanner/lib/classify';

// Replace the drizzle predicate/operator builders with recording spies so tests can assert which
// WHERE predicates a query is built from (by column reference), while keeping the real `sql` tag and
// the real pgTable column objects. This is what lets us verify the sync-safety guards below.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  const record = (op: string) => vi.fn((...args: unknown[]) => ({ __op: op, args }) as unknown);
  return {
    ...actual,
    and: record('and'),
    or: record('or'),
    eq: record('eq'),
    ne: record('ne'),
    gt: record('gt'),
    lt: record('lt'),
    inArray: record('inArray'),
    isNull: record('isNull'),
    isNotNull: record('isNotNull'),
    asc: record('asc'),
    desc: record('desc'),
    ilike: record('ilike'),
  };
});

// True when some invocation of `spy` matched the reference/value predicate.
function someCall(spy: unknown, pred: (...args: any[]) => boolean): boolean {
  return (spy as { mock: { calls: unknown[][] } }).mock.calls.some((c) => pred(...c));
}

/**
 * How many of the queries built since the last `clearAllMocks` carried the audio-only candidate
 * guard. The guard is an EXISTS over content-role book_files whose only recorded predicate is
 * `inArray(bookFiles.format, AUDIO_FORMATS)` (the rest of it is opaque raw SQL), so counting
 * those calls is what proves each candidate query still restricts to books that have audio at all.
 * Every candidate query must contribute exactly one, so dropping the guard from any single call site
 * shows up as a lower count.
 */
function audioGuardCount(): number {
  const audioFormats = [...AUDIO_FORMATS];
  return (inArray as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
    (c) => c[0] === schema.bookFiles.format && Array.isArray(c[1]) && audioFormats.every((format) => (c[1] as string[]).includes(format)),
  ).length;
}

// A thenable query-builder chain: every builder method returns the chain, and awaiting it (or any
// terminal like `.returning()`/`.limit()`) resolves to `result`.
function makeChain(result: unknown) {
  const chain: Record<string, ReturnType<typeof vi.fn>> & { then?: unknown } = {};
  const methods = [
    'from',
    'innerJoin',
    'leftJoin',
    'where',
    'orderBy',
    'groupBy',
    'limit',
    'offset',
    'values',
    'onConflictDoUpdate',
    'onConflictDoNothing',
    'set',
    'returning',
  ];
  for (const m of methods) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return chain as never as Record<string, ReturnType<typeof vi.fn>>;
}

describe('AudiobookshelfRepository', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('findSettings', () => {
    it('returns the single settings row for the user', async () => {
      const row = { id: 1, userId: 7 };
      const chain = makeChain([row]);
      const db = { select: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      await expect(repo.findSettings(7)).resolves.toEqual(row);
      expect(someCall(eq, (c, v) => c === audiobookshelfUserSettings.userId && v === 7)).toBe(true);
      expect(chain.limit).toHaveBeenCalledWith(1);
    });
  });

  describe('findEnabledConfiguredUsers', () => {
    it('filters on enabled + keyset and returns the mapped userId rows', async () => {
      const rows = [{ userId: 10 }, { userId: 12 }];
      const chain = makeChain(rows);
      const db = { select: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      await expect(repo.findEnabledConfiguredUsers(5, 50)).resolves.toEqual(rows);

      // enabled = true guard
      expect(someCall(eq, (c, v) => c === audiobookshelfUserSettings.enabled && v === true)).toBe(true);
      // keyset: userId > afterUserId, ordered ascending, bounded by limit
      expect(someCall(gt, (c, v) => c === audiobookshelfUserSettings.userId && v === 5)).toBe(true);
      expect(someCall(asc, (c) => c === audiobookshelfUserSettings.userId)).toBe(true);
      expect(chain.orderBy).toHaveBeenCalledTimes(1);
      expect(chain.limit).toHaveBeenCalledWith(50);
      // The non-empty url/token guards are built with the real `sql` tag; asserted only via presence
      // of the WHERE call (their contents are opaque SQL fragments).
      expect(chain.where).toHaveBeenCalledTimes(1);
    });
  });

  describe('upsertSettings', () => {
    it('inserts with userId merged and upserts on the userId target', async () => {
      const row = { id: 1, userId: 7, enabled: true };
      const chain = makeChain([row]);
      const db = { insert: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      await expect(repo.upsertSettings(7, { enabled: true })).resolves.toEqual(row);
      expect(chain.values).toHaveBeenCalledWith({ userId: 7, enabled: true });
      const conflictArg = chain.onConflictDoUpdate.mock.calls[0][0] as {
        target: unknown;
        set: Record<string, unknown>;
      };
      expect(conflictArg.target).toBe(audiobookshelfUserSettings.userId);
      expect(conflictArg.set).toMatchObject({ enabled: true });
      expect(conflictArg.set.updatedAt).toBeInstanceOf(Date);
    });
  });

  describe('updateSettings', () => {
    it('applies the patch (with updatedAt) scoped to the user and returns the row', async () => {
      const row = { id: 1, userId: 7, enabled: false };
      const chain = makeChain([row]);
      const db = { update: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      await expect(repo.updateSettings(7, { enabled: false })).resolves.toEqual(row);
      const setArg = chain.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg).toMatchObject({ enabled: false });
      expect(setArg.updatedAt).toBeInstanceOf(Date);
      expect(someCall(eq, (c, v) => c === audiobookshelfUserSettings.userId && v === 7)).toBe(true);
    });

    it('returns undefined when no row matched', async () => {
      const chain = makeChain([]);
      const db = { update: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      await expect(repo.updateSettings(7, { enabled: false })).resolves.toBeUndefined();
    });
  });

  describe('updateStaleCount', () => {
    it('writes only the counter (plus updatedAt) for the given user', async () => {
      const chain = makeChain(undefined);
      const db = { update: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      await repo.updateStaleCount(7, 4930);

      expect(db.update).toHaveBeenCalledWith(audiobookshelfUserSettings);
      const setArg = chain.set.mock.calls[0][0] as Record<string, unknown>;
      expect(Object.keys(setArg).sort()).toEqual(['staleCount', 'updatedAt']);
      expect(setArg.staleCount).toBe(4930);
      expect(someCall(eq, (c, v) => c === audiobookshelfUserSettings.userId && v === 7)).toBe(true);
    });
  });

  describe('clearMatchMemoForUnmatched', () => {
    it('nulls the memo for the user unmatched rows only and returns how many it touched', async () => {
      const chain = makeChain({ rowCount: 12 });
      const db = { update: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      await expect(repo.clearMatchMemoForUnmatched(7)).resolves.toBe(12);

      expect(db.update).toHaveBeenCalledWith(audiobookshelfBookState);
      expect(db.update).toHaveBeenCalledTimes(1);
      const setArg = chain.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.lastMatchAttemptAt).toBeNull();
      expect(setArg.updatedAt).toBeInstanceOf(Date);
      expect(someCall(eq, (c, v) => c === audiobookshelfBookState.userId && v === 7)).toBe(true);
      expect(someCall(isNull, (c) => c === audiobookshelfBookState.bookId)).toBe(true);
      expect(someCall(isNotNull, (c) => c === audiobookshelfBookState.lastMatchAttemptAt)).toBe(true);
    });

    it('reports zero when the driver returns no row count', async () => {
      const chain = makeChain({});
      const db = { update: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      await expect(repo.clearMatchMemoForUnmatched(7)).resolves.toBe(0);
    });
  });

  describe('findLibraryFolderPaths', () => {
    it('reads deduped folder paths scoped to the accessible libraries, sorted and bounded', async () => {
      const chain = makeChain([{ path: '/books' }, { path: '/media/books' }]);
      const db = { selectDistinct: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      await expect(repo.findLibraryFolderPaths([3, 5])).resolves.toEqual(['/books', '/media/books']);
      expect(db.selectDistinct).toHaveBeenCalledTimes(1);
      expect(someCall(inArray, (c, v) => c === schema.libraryFolders.libraryId && Array.isArray(v) && v.join(',') === '3,5')).toBe(true);
      expect(someCall(asc, (c) => c === schema.libraryFolders.path)).toBe(true);
      expect(chain.limit).toHaveBeenCalledWith(500);
    });

    it('returns nothing without querying when the user has no accessible libraries', async () => {
      const db = { selectDistinct: vi.fn() };
      const repo = new AudiobookshelfRepository(db as never);

      await expect(repo.findLibraryFolderPaths([])).resolves.toEqual([]);
      expect(db.selectDistinct).not.toHaveBeenCalled();
    });
  });

  describe('findDistinctBookFolderPaths', () => {
    it('reads one distinct, sorted, bounded page scoped to accessible present books', async () => {
      const chain = makeChain([{ folderPath: '/books/A/T' }, { folderPath: '/books/B/T' }]);
      const db = { selectDistinct: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      await expect(repo.findDistinctBookFolderPaths([3, 5], undefined, null, 2000)).resolves.toEqual(['/books/A/T', '/books/B/T']);
      expect(db.selectDistinct).toHaveBeenCalledTimes(1);
      expect(db.selectDistinct).toHaveBeenCalledWith({ folderPath: schema.books.folderPath });
      expect(someCall(inArray, (c, v) => c === schema.books.libraryId && Array.isArray(v) && v.join(',') === '3,5')).toBe(true);
      expect(someCall(eq, (c, v) => c === schema.books.status && v === 'present')).toBe(true);
      expect(someCall(asc, (c) => c === schema.books.folderPath)).toBe(true);
      expect(chain.limit).toHaveBeenCalledWith(2000);
      // First page: no keyset cursor yet.
      expect(someCall(gt, (c) => c === schema.books.folderPath)).toBe(false);
    });

    it('continues from the keyset cursor on later pages', async () => {
      const chain = makeChain([]);
      const db = { selectDistinct: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      await repo.findDistinctBookFolderPaths([3], undefined, '/books/A/T', 2000);
      expect(someCall(gt, (c, v) => c === schema.books.folderPath && v === '/books/A/T')).toBe(true);
    });

    it('returns nothing without querying when the user has no accessible libraries', async () => {
      const db = { selectDistinct: vi.fn() };
      const repo = new AudiobookshelfRepository(db as never);

      await expect(repo.findDistinctBookFolderPaths([], undefined, null, 2000)).resolves.toEqual([]);
      expect(db.selectDistinct).not.toHaveBeenCalled();
    });
  });

  describe('bulkUpsertBookStates', () => {
    const makeRow = (id: string): AbsBookStateUpsert => ({
      absLibraryItemId: id,
      absTitle: `t-${id}`,
      absAuthorName: `a-${id}`,
      bookId: 1,
      matchMethod: 'isbn',
      matchConfidence: 100,
      needsReview: false,
      matchError: null,
      lastMatchAttemptAt: new Date(),
    });

    const readAt = new Date('2026-08-30T10:00:00Z');

    /** The `onConflictDoUpdate({...})` argument of the nth insert built by `chain`. */
    function conflictArgOf(chain: Record<string, ReturnType<typeof vi.fn>>, index = 0) {
      return chain.onConflictDoUpdate.mock.calls[index][0] as {
        target: unknown[];
        set: Record<string, unknown>;
        setWhere?: { queryChunks: unknown[] };
      };
    }

    it('short-circuits for an empty list without touching the db', async () => {
      const db = { insert: vi.fn() };
      const repo = new AudiobookshelfRepository(db as never);

      await repo.bulkUpsertBookStates(7, [], readAt);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('resets manualUnlinked:false on both insert values and the conflict set, on the composite target', async () => {
      const chain = makeChain(undefined);
      const db = { insert: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      await repo.bulkUpsertBookStates(7, [makeRow('abs-1')], readAt);

      const values = chain.values.mock.calls[0][0] as Array<Record<string, unknown>>;
      expect(values[0]).toMatchObject({ userId: 7, absLibraryItemId: 'abs-1', manualUnlinked: false });
      const conflictArg = conflictArgOf(chain);
      expect(conflictArg.target).toEqual([audiobookshelfBookState.userId, audiobookshelfBookState.absLibraryItemId]);
      expect(conflictArg.set.manualUnlinked).toBe(false);
    });

    /**
     * The compare-and-set that keeps a slow match run from overwriting a user decision taken while it
     * was computing. `readAt` rides in as the inserted `updated_at`, and the conflict branch only
     * fires while the stored row has not been touched since. Without both halves the guard is inert,
     * so both are asserted here.
     */
    it('stamps the batch with readAt and only updates a row untouched since then', async () => {
      const chain = makeChain(undefined);
      const db = { insert: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      await repo.bulkUpsertBookStates(7, [makeRow('abs-1')], readAt);

      // The read timestamp is transported by the insert, so `excluded.updated_at` carries it.
      const values = chain.values.mock.calls[0][0] as Array<Record<string, unknown>>;
      expect(values[0]!.updatedAt).toBe(readAt);

      const setWhere = conflictArgOf(chain).setWhere;
      expect(setWhere).toBeDefined();
      // Compares the stored row's own column against what the insert carries.
      expect(setWhere!.queryChunks).toContain(audiobookshelfBookState.updatedAt);
      const rendered = setWhere!.queryChunks.map((c) => ((c as { value?: string[] }).value ?? []).join('')).join('');
      expect(rendered).toContain('<= excluded.updated_at');

      // A row the batch does write gets a fresh timestamp, not the backdated read time.
      expect(conflictArgOf(chain).set.updatedAt).toBeInstanceOf(Date);
      expect(conflictArgOf(chain).set.updatedAt).not.toBe(readAt);
    });

    it('chunks the upsert at 500 rows per insert, guarding every chunk', async () => {
      const chain = makeChain(undefined);
      const db = { insert: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      const rows = Array.from({ length: 501 }, (_, i) => makeRow(`abs-${i}`));
      await repo.bulkUpsertBookStates(7, rows, readAt);

      expect(db.insert).toHaveBeenCalledTimes(2);
      expect((chain.values.mock.calls[0][0] as unknown[]).length).toBe(500);
      expect((chain.values.mock.calls[1][0] as unknown[]).length).toBe(1);
      expect(conflictArgOf(chain, 0).setWhere).toBeDefined();
      expect(conflictArgOf(chain, 1).setWhere).toBeDefined();
    });
  });

  describe('updateBookState', () => {
    /**
     * Every user decision (confirm, manual link, unlink, exclude) is written through here, and the
     * batch upsert's compare-and-set can only see that touch if this bumps `updatedAt`. Without it
     * the guard is silently inert, so it is pinned rather than left to the schema default.
     */
    it('bumps updatedAt on every patch, which is what the batch upsert compares against', async () => {
      const chain = makeChain(undefined);
      const db = { update: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      await repo.updateBookState(7, 'abs-1', { needsReview: false, matchError: null });

      const setArg = chain.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg).toMatchObject({ needsReview: false, matchError: null });
      expect(setArg.updatedAt).toBeInstanceOf(Date);
      expect(someCall(eq, (c, v) => c === audiobookshelfBookState.userId && v === 7)).toBe(true);
      expect(someCall(eq, (c, v) => c === audiobookshelfBookState.absLibraryItemId && v === 'abs-1')).toBe(true);
    });
  });

  describe('findBookStateCleanupCandidates', () => {
    it('scopes to the user and pages by ascending keyset within the limit', async () => {
      const rows = [{ id: 3, absLibraryItemId: 'abs-3', bookId: null, syncExcluded: false, manualUnlinked: false }];
      const chain = makeChain(rows);
      const db = { select: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      await expect(repo.findBookStateCleanupCandidates(7, 2, 1000)).resolves.toEqual(rows);

      expect(db.select).toHaveBeenCalledWith(
        expect.objectContaining({
          id: audiobookshelfBookState.id,
          absLibraryItemId: audiobookshelfBookState.absLibraryItemId,
          bookId: audiobookshelfBookState.bookId,
          syncExcluded: audiobookshelfBookState.syncExcluded,
          manualUnlinked: audiobookshelfBookState.manualUnlinked,
        }),
      );
      expect(someCall(eq, (c, v) => c === audiobookshelfBookState.userId && v === 7)).toBe(true);
      expect(someCall(gt, (c, v) => c === audiobookshelfBookState.id && v === 2)).toBe(true);
      expect(someCall(asc, (c) => c === audiobookshelfBookState.id)).toBe(true);
      expect(chain.limit).toHaveBeenCalledWith(1000);
    });
  });

  describe('deleteBookStatesByAbsItemIds', () => {
    it('short-circuits for an empty list without touching the db', async () => {
      const db = { delete: vi.fn() };
      const repo = new AudiobookshelfRepository(db as never);

      await expect(repo.deleteBookStatesByAbsItemIds(7, [], { includeManuallyUnlinked: false })).resolves.toBe(0);
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('scopes the delete to the user and counts the returned rows', async () => {
      const chain = makeChain([{ id: 1 }, { id: 2 }]);
      const db = { delete: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      await expect(repo.deleteBookStatesByAbsItemIds(7, ['abs-1', 'abs-2'], { includeManuallyUnlinked: false })).resolves.toBe(2);

      expect(db.delete).toHaveBeenCalledWith(audiobookshelfBookState);
      expect(someCall(eq, (c, v) => c === audiobookshelfBookState.userId && v === 7)).toBe(true);
      expect(someCall(inArray, (c, v) => c === audiobookshelfBookState.absLibraryItemId && Array.isArray(v) && v.length === 2)).toBe(true);
    });

    it('re-checks the row state at delete time, so a row that gained a link or an exclusion survives', async () => {
      const chain = makeChain([{ id: 1 }]);
      const db = { delete: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      await repo.deleteBookStatesByAbsItemIds(7, ['abs-1'], { includeManuallyUnlinked: false });

      // The caller classified these rows as pure unmatched in a paged read seconds earlier; the same
      // conditions are re-asserted in the statement so a concurrent link, exclusion, or manual unlink wins.
      expect(someCall(isNull, (c) => c === audiobookshelfBookState.bookId)).toBe(true);
      expect(someCall(eq, (c, v) => c === audiobookshelfBookState.syncExcluded && v === false)).toBe(true);
      expect(someCall(eq, (c, v) => c === audiobookshelfBookState.manualUnlinked && v === false)).toBe(true);
    });

    it('does not filter on manualUnlinked when includeManuallyUnlinked is true', async () => {
      const chain = makeChain([{ id: 1 }]);
      const db = { delete: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      await repo.deleteBookStatesByAbsItemIds(7, ['abs-1'], { includeManuallyUnlinked: true });

      expect(someCall(eq, (c, v) => c === audiobookshelfBookState.manualUnlinked && v === false)).toBe(false);
      // The link/exclusion re-check still applies regardless.
      expect(someCall(isNull, (c) => c === audiobookshelfBookState.bookId)).toBe(true);
      expect(someCall(eq, (c, v) => c === audiobookshelfBookState.syncExcluded && v === false)).toBe(true);
    });

    it('chunks the delete IN-list at 500 ids per statement', async () => {
      const chain = makeChain([{ id: 1 }]);
      const db = { delete: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      const ids = Array.from({ length: 501 }, (_, i) => `abs-${i}`);
      await expect(repo.deleteBookStatesByAbsItemIds(7, ids, { includeManuallyUnlinked: false })).resolves.toBe(2);

      expect(db.delete).toHaveBeenCalledTimes(2);
      const lists = (inArray as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .filter((c) => c[0] === audiobookshelfBookState.absLibraryItemId)
        .map((c) => (c[1] as string[]).length);
      expect(lists).toEqual([500, 1]);
    });
  });

  describe('findSyncableBookStatesByAbsItemIds', () => {
    const scope = { libraryIds: [1, 2] };

    it('short-circuits for an empty item list', async () => {
      const db = { select: vi.fn() };
      const repo = new AudiobookshelfRepository(db as never);

      await expect(repo.findSyncableBookStatesByAbsItemIds(7, scope as never, [])).resolves.toEqual([]);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('builds the sync-safety guards and returns the unwrapped state rows', async () => {
      const stateRow = { id: 1, userId: 7, absLibraryItemId: 'abs-1', bookId: 42 };
      const chain = makeChain([{ audiobookshelf_book_state: stateRow }]);
      const db = { select: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      await expect(repo.findSyncableBookStatesByAbsItemIds(7, scope as never, ['abs-1'])).resolves.toEqual([stateRow]);

      // The guards that prevent syncing wrong / low-confidence / excluded matches:
      expect(someCall(eq, (c, v) => c === audiobookshelfBookState.needsReview && v === false)).toBe(true);
      expect(someCall(eq, (c, v) => c === audiobookshelfBookState.syncExcluded && v === false)).toBe(true);
      expect(someCall(isNull, (c) => c === audiobookshelfBookState.matchError)).toBe(true);
      expect(someCall(inArray, (c, v) => c === audiobookshelfBookState.absLibraryItemId && Array.isArray(v))).toBe(true);
      // Scope guard: only books that are still present in an accessible library.
      expect(someCall(isNotNull, (c) => c === audiobookshelfBookState.bookId)).toBe(true);
      expect(someCall(inArray, (c, v) => c === schema.books.libraryId && Array.isArray(v) && v.length === 2)).toBe(true);
      expect(someCall(eq, (c, v) => c === schema.books.status && v === 'present')).toBe(true);
      // Sanity: `and` was used to combine the predicates.
      expect((and as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(0);
    });
  });

  describe('findBookIdsByPaths', () => {
    it('short-circuits without a query when there are no paths or no accessible libraries', async () => {
      const db = { select: vi.fn() };
      const repo = new AudiobookshelfRepository(db as never);

      await expect(repo.findBookIdsByPaths([1, 2], undefined, [])).resolves.toEqual([]);
      await expect(repo.findBookIdsByPaths([], undefined, ['/books/A/T'])).resolves.toEqual([]);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('scopes both path probes to accessible libraries, present books, and content-role files', async () => {
      const fileChain = makeChain([{ key: '/books/A/T/T.m4b', bookId: 11 }]);
      const folderChain = makeChain([{ key: '/books/A/T', bookId: 11 }]);
      const db = { select: vi.fn().mockReturnValueOnce(fileChain).mockReturnValueOnce(folderChain) };
      const repo = new AudiobookshelfRepository(db as never);

      await expect(repo.findBookIdsByPaths([1, 2], undefined, ['/books/A/T', '/books/A/T/T.m4b'])).resolves.toEqual([
        { key: '/books/A/T/T.m4b', bookId: 11 },
        { key: '/books/A/T', bookId: 11 },
      ]);

      // Same scoping as the ISBN/ASIN tiers.
      expect(someCall(inArray, (c, v) => c === schema.books.libraryId && Array.isArray(v) && v.length === 2)).toBe(true);
      expect(someCall(eq, (c, v) => c === schema.books.status && v === 'present')).toBe(true);
      expect(someCall(eq, (c, v) => c === schema.bookFiles.role && v === 'content')).toBe(true);
      // Both path domains an ABS item path can point at.
      expect(someCall(inArray, (c, v) => c === schema.bookFiles.absolutePath && Array.isArray(v) && v.length === 2)).toBe(true);
      expect(someCall(inArray, (c, v) => c === schema.books.folderPath && Array.isArray(v) && v.length === 2)).toBe(true);
    });

    it('chunks the path IN-list at 500 per query (two probes per chunk)', async () => {
      const chain = makeChain([]);
      const db = { select: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      await repo.findBookIdsByPaths(
        [1],
        undefined,
        Array.from({ length: 501 }, (_, i) => `/books/${i}`),
      );

      expect(db.select).toHaveBeenCalledTimes(4);
    });
  });

  /**
   * ABS links target the audiobook copy of a work, so an ABS item must never be able to match an
   * ebook-only book. That is enforced per candidate query rather than centrally, so each call site is
   * pinned separately here: losing the guard on any one of them would silently reopen the ebook-only
   * matches on that tier while every other tier still looked correct.
   */
  describe('audio-only candidate guard', () => {
    it('guards the ASIN key lookup', async () => {
      const chain = makeChain([]);
      const db = { select: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      await repo.findBookIdsByAudibleIds([1, 2], undefined, ['B0041JKNNA']);

      expect(db.select).toHaveBeenCalledTimes(1);
      expect(audioGuardCount()).toBe(1);
    });

    it('guards both ISBN key lookups (isbn13 and isbn10 are separate queries)', async () => {
      const chain = makeChain([]);
      const db = { select: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      await repo.findBookIdsByIsbns([1, 2], undefined, ['9780306406157', '080442957X']);

      expect(db.select).toHaveBeenCalledTimes(2);
      expect(audioGuardCount()).toBe(2);
    });

    it('guards both path probes: the content-file probe and the book-folder probe', async () => {
      const chain = makeChain([]);
      const db = { select: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      await repo.findBookIdsByPaths([1, 2], undefined, ['/books/A/T']);

      expect(db.select).toHaveBeenCalledTimes(2);
      expect(audioGuardCount()).toBe(2);
    });

    it('guards the fuzzy candidate lateral, per title batch', async () => {
      const db = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
      const repo = new AudiobookshelfRepository(db as never);

      await repo.findFuzzyCandidatesForTitles([1, 2], undefined, ['The Two Towers'], 20);

      expect(db.execute).toHaveBeenCalledTimes(1);
      expect(audioGuardCount()).toBe(1);
    });
  });

  describe('findCoverFilesForBooks', () => {
    it('short-circuits for an empty book list', async () => {
      const db = { select: vi.fn() };
      const repo = new AudiobookshelfRepository(db as never);

      await expect(repo.findCoverFilesForBooks(3, [])).resolves.toEqual([]);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('bounds the query to the given books and keeps the library/role/status guards', async () => {
      const row = { bookId: 1, absolutePath: '/library/Book/cover.jpg', format: 'jpg' };
      const chain = makeChain([row]);
      const db = { select: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      await expect(repo.findCoverFilesForBooks(3, [1, 2])).resolves.toEqual([row]);
      expect(someCall(inArray, (c, v) => c === schema.books.id && Array.isArray(v) && v.length === 2)).toBe(true);
      expect(someCall(eq, (c, v) => c === schema.books.libraryId && v === 3)).toBe(true);
      expect(someCall(eq, (c, v) => c === schema.bookFiles.role && v === 'cover')).toBe(true);
      expect(someCall(ne, (c, v) => c === schema.books.status && v === 'missing')).toBe(true);
    });

    it('chunks the book ids at 500 per query', async () => {
      const chain = makeChain([]);
      const db = { select: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      await repo.findCoverFilesForBooks(
        3,
        Array.from({ length: 501 }, (_, i) => i + 1),
      );

      expect(db.select).toHaveBeenCalledTimes(2);
    });
  });

  describe('findAudioProgressForBooks', () => {
    it('short-circuits for an empty book list', async () => {
      const db = { select: vi.fn() };
      const repo = new AudiobookshelfRepository(db as never);

      await expect(repo.findAudioProgressForBooks(7, [])).resolves.toEqual(new Map());
      expect(db.select).not.toHaveBeenCalled();
    });

    it('keys the newest-wins inputs by bookId, scoped to the user', async () => {
      const updatedAt = new Date('2026-07-19T00:00:00Z');
      const chain = makeChain([{ bookId: 10, percentage: 42, updatedAt }]);
      const db = { select: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      await expect(repo.findAudioProgressForBooks(7, [10])).resolves.toEqual(new Map([[10, { percentage: 42, updatedAt }]]));
      expect(someCall(eq, (c, v) => c === schema.audiobookProgress.userId && v === 7)).toBe(true);
      expect(someCall(inArray, (c, v) => c === schema.audiobookProgress.bookId && Array.isArray(v))).toBe(true);
    });
  });

  describe('upsertAudioProgressGuarded', () => {
    it('inserts with conflict-yield when there is no snapshot row', async () => {
      const chain = makeChain([{ updatedAt: new Date('2026-07-20T00:00:00Z') }]);
      const db = { insert: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      const row = await repo.upsertAudioProgressGuarded(7, 10, 501, 1000, 100, null);
      expect(row).toBeDefined();
      expect(db.insert).toHaveBeenCalledOnce();
      expect(chain.onConflictDoNothing).toHaveBeenCalledOnce();
    });

    it('updates only when updatedAt still matches the snapshot, yielding to a concurrent local write', async () => {
      const expected = new Date('2026-07-19T00:00:00Z');
      const chain = makeChain([]);
      const db = { update: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      const row = await repo.upsertAudioProgressGuarded(7, 10, 501, 1000, 100, expected);
      expect(row).toBeUndefined();
      expect(db.update).toHaveBeenCalledOnce();
      expect(someCall(eq, (c, v) => c === schema.audiobookProgress.updatedAt && v === expected)).toBe(true);
    });
  });

  describe('findAudioFilesInPlayOrderForBooks', () => {
    it('groups files per book and chunks the book ids at 500 per query', async () => {
      const chain = makeChain([
        { bookId: 10, id: 1, format: 'm4b', durationSeconds: 100 },
        { bookId: 10, id: 2, format: 'm4b', durationSeconds: 200 },
      ]);
      const db = { select: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      await expect(repo.findAudioFilesInPlayOrderForBooks([10])).resolves.toEqual(
        new Map([
          [
            10,
            [
              { id: 1, format: 'm4b', durationSeconds: 100 },
              { id: 2, format: 'm4b', durationSeconds: 200 },
            ],
          ],
        ]),
      );

      db.select.mockClear();
      await repo.findAudioFilesInPlayOrderForBooks(Array.from({ length: 501 }, (_, i) => i + 1));
      expect(db.select).toHaveBeenCalledTimes(2);
    });
  });

  describe('findBookStatesByAbsItemIds', () => {
    it('short-circuits for an empty list', async () => {
      const db = { select: vi.fn() };
      const repo = new AudiobookshelfRepository(db as never);

      await expect(repo.findBookStatesByAbsItemIds(7, [])).resolves.toEqual([]);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('returns the matching state rows scoped to the user', async () => {
      const row = { id: 1, userId: 7, absLibraryItemId: 'abs-1' };
      const chain = makeChain([row]);
      const db = { select: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      await expect(repo.findBookStatesByAbsItemIds(7, ['abs-1'])).resolves.toEqual([row]);
      expect(someCall(eq, (c, v) => c === audiobookshelfBookState.userId && v === 7)).toBe(true);
    });
  });
});
