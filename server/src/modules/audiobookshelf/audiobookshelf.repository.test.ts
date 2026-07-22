import { describe, it, expect, vi, beforeEach } from 'vitest';
import { and, asc, eq, gt, inArray, isNull, isNotNull } from 'drizzle-orm';

import { AudiobookshelfRepository, type AbsBookStateUpsert } from './audiobookshelf.repository';
import { audiobookshelfBookState, audiobookshelfUserSettings } from './schema/audiobookshelf.schema';
import * as schema from '../../db/schema';

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

    it('short-circuits for an empty list without touching the db', async () => {
      const db = { insert: vi.fn() };
      const repo = new AudiobookshelfRepository(db as never);

      await repo.bulkUpsertBookStates(7, []);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('resets manualUnlinked:false on both insert values and the conflict set, on the composite target', async () => {
      const chain = makeChain(undefined);
      const db = { insert: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      await repo.bulkUpsertBookStates(7, [makeRow('abs-1')]);

      const values = chain.values.mock.calls[0][0] as Array<Record<string, unknown>>;
      expect(values[0]).toMatchObject({ userId: 7, absLibraryItemId: 'abs-1', manualUnlinked: false });
      const conflictArg = chain.onConflictDoUpdate.mock.calls[0][0] as {
        target: unknown[];
        set: Record<string, unknown>;
      };
      expect(conflictArg.target).toEqual([audiobookshelfBookState.userId, audiobookshelfBookState.absLibraryItemId]);
      expect(conflictArg.set.manualUnlinked).toBe(false);
    });

    it('chunks the upsert at 500 rows per insert', async () => {
      const chain = makeChain(undefined);
      const db = { insert: vi.fn(() => chain) };
      const repo = new AudiobookshelfRepository(db as never);

      const rows = Array.from({ length: 501 }, (_, i) => makeRow(`abs-${i}`));
      await repo.bulkUpsertBookStates(7, rows);

      expect(db.insert).toHaveBeenCalledTimes(2);
      expect((chain.values.mock.calls[0][0] as unknown[]).length).toBe(500);
      expect((chain.values.mock.calls[1][0] as unknown[]).length).toBe(1);
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
