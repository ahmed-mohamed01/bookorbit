import { randomUUID } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';

import * as schema from '../src/db/schema';
import { AudiobookshelfRepository, type AbsBookAccessScope } from '../src/modules/audiobookshelf/audiobookshelf.repository';
import { audiobookshelfBookState, type NewAudiobookshelfBookState } from '../src/modules/audiobookshelf/schema/audiobookshelf.schema';
import { closeE2EContext, createE2EContext, seedLibrary, type E2EContext } from './e2e/app-harness';

const EXCLUDED_ABS_LIBRARY = 'abs-lib-excluded';

/**
 * The outbound Audiobookshelf position push is driven by SQL predicates (eligibility, pending
 * markers, and the "local row unchanged" CASE) that mocks cannot prove. These run them against the
 * real database the app boots with, where the ABS tables come from the boot-time schema bootstrap.
 */
describe('Audiobookshelf position push repository (e2e)', { timeout: 120_000 }, () => {
  let ctx!: E2EContext;
  let repo!: AudiobookshelfRepository;
  let userId!: number;
  let scope!: AbsBookAccessScope;
  let hiddenLibraryBookId!: number;
  const bookIds: number[] = [];
  const fileIds = new Map<number, number>();

  async function seedBook(libraryId: number, libraryFolderId: number): Promise<number> {
    const folderPath = `/e2e/abs-push/${randomUUID()}`;
    const [book] = await ctx.db.insert(schema.books).values({ libraryId, libraryFolderId, folderPath }).returning({ id: schema.books.id });
    const [file] = await ctx.db
      .insert(schema.bookFiles)
      .values({
        bookId: book!.id,
        libraryFolderId,
        absolutePath: `${folderPath}/book.m4b`,
        ino: BigInt(Math.floor(Math.random() * 1_000_000_000)),
        format: 'm4b',
        durationSeconds: 1000,
      })
      .returning({ id: schema.bookFiles.id });
    fileIds.set(book!.id, file!.id);
    return book!.id;
  }

  async function seedState(itemId: string, bookId: number | null, overrides: Partial<NewAudiobookshelfBookState> = {}): Promise<void> {
    await ctx.db.insert(audiobookshelfBookState).values({ userId, absLibraryItemId: itemId, bookId, ...overrides });
  }

  async function pendingAt(itemId: string): Promise<Date | null> {
    const [row] = await ctx.db
      .select({ pushPendingAt: audiobookshelfBookState.pushPendingAt })
      .from(audiobookshelfBookState)
      .where(and(eq(audiobookshelfBookState.userId, userId), eq(audiobookshelfBookState.absLibraryItemId, itemId)));
    return row!.pushPendingAt;
  }

  async function stateRow(itemId: string) {
    const [row] = await ctx.db
      .select()
      .from(audiobookshelfBookState)
      .where(and(eq(audiobookshelfBookState.userId, userId), eq(audiobookshelfBookState.absLibraryItemId, itemId)));
    return row!;
  }

  /** Writes the progress row with a microsecond timestamp, like the column default now() does. */
  async function writeProgressWithMicroseconds(bookId: number, updatedAt: string): Promise<Date> {
    await ctx.db.execute(sql`
      insert into audiobook_progress (user_id, book_id, current_file_id, position_seconds, percentage, captured_at, updated_at)
      values (${userId}, ${bookId}, ${fileIds.get(bookId)!}, 40, 4, ${updatedAt}::timestamptz, ${updatedAt}::timestamptz)
      on conflict (user_id, book_id) do update set position_seconds = excluded.position_seconds, updated_at = excluded.updated_at
    `);
    const progress = await repo.findAudioProgress(userId, bookId);
    return progress!.updatedAt;
  }

  beforeAll(async () => {
    ctx = await createE2EContext();
    repo = ctx.app.get(AudiobookshelfRepository);

    const [user] = await ctx.db
      .insert(schema.users)
      .values({ username: `abs-push-${randomUUID().slice(0, 8)}`, name: 'ABS push', passwordHash: 'unused' })
      .returning({ id: schema.users.id });
    userId = user!.id;

    const visible = await seedLibrary(ctx.db, { rootPath: `/e2e/abs-push-visible-${randomUUID()}`, mode: 'book_per_folder' });
    const hidden = await seedLibrary(ctx.db, { rootPath: `/e2e/abs-push-hidden-${randomUUID()}`, mode: 'book_per_folder' });
    scope = { libraryIds: [visible.libraryId] };
    for (let index = 0; index < 8; index += 1) bookIds.push(await seedBook(visible.libraryId, visible.libraryFolderId));
    hiddenLibraryBookId = await seedBook(hidden.libraryId, hidden.libraryFolderId);
  }, 90_000);

  afterAll(async () => {
    if (!ctx) return;
    if (userId) await ctx.db.delete(schema.users).where(eq(schema.users.id, userId));
    await closeE2EContext(ctx);
  });

  it('marks, finds and clears pending pushes only for rows the pull would also accept', async () => {
    const pending = new Date('2026-09-29T09:00:00.000Z');
    await seedState('eligible', bookIds[0]!, { absLibraryId: 'abs-lib-main' });
    await seedState('untagged-library', bookIds[1]!, { absLibraryId: null, pushPendingAt: pending });
    await seedState('needs-review', bookIds[2]!, { needsReview: true, pushPendingAt: pending });
    await seedState('match-error', bookIds[3]!, { matchError: 'ambiguous', pushPendingAt: pending });
    await seedState('sync-excluded', bookIds[4]!, { syncExcluded: true, pushPendingAt: pending });
    await seedState('manual-unlinked', bookIds[5]!, { manualUnlinked: true, pushPendingAt: pending });
    await seedState('excluded-library', bookIds[6]!, { absLibraryId: EXCLUDED_ABS_LIBRARY, pushPendingAt: pending });
    await seedState('no-library-access', hiddenLibraryBookId, { pushPendingAt: pending });

    await repo.markPositionPushPending(userId, 'eligible');
    expect(await pendingAt('eligible')).toBeInstanceOf(Date);

    const found = await repo.findPendingPositionPushes(userId, scope, [EXCLUDED_ABS_LIBRARY], 200);
    expect(found.map((row) => row.absLibraryItemId).sort()).toEqual(['eligible', 'untagged-library']);
    // Oldest marker first.
    expect(found[0]!.absLibraryItemId).toBe('untagged-library');
    await expect(repo.findPendingPositionPushes(userId, scope, [EXCLUDED_ABS_LIBRARY], 1)).resolves.toHaveLength(1);

    await expect(repo.findPushableBookStateByBookId(userId, bookIds[2]!, scope, [EXCLUDED_ABS_LIBRARY])).resolves.toBeUndefined();
    await expect(repo.findPushableBookStateByBookId(userId, bookIds[0]!, scope, [EXCLUDED_ABS_LIBRARY])).resolves.toMatchObject({
      absLibraryItemId: 'eligible',
    });
    await expect(repo.findPushableBookStateRow(userId, 'no-library-access', scope, [])).resolves.toBeUndefined();
    await expect(repo.findPushableBookStateRow(userId, 'excluded-library', scope, [])).resolves.toMatchObject({
      absLibraryItemId: 'excluded-library',
    });

    await repo.clearIneligiblePositionPushes(userId, scope, [EXCLUDED_ABS_LIBRARY]);
    for (const itemId of ['needs-review', 'match-error', 'sync-excluded', 'manual-unlinked', 'excluded-library', 'no-library-access']) {
      expect(await pendingAt(itemId)).toBeNull();
    }
    expect(await pendingAt('eligible')).toBeInstanceOf(Date);
    expect(await pendingAt('untagged-library')).toBeInstanceOf(Date);

    await repo.clearPositionPushPending(userId);
    expect(await pendingAt('eligible')).toBeNull();
    expect(await pendingAt('untagged-library')).toBeNull();
  });

  it('clears pending for an unchanged progress row even when the stored timestamp has microseconds', async () => {
    const bookId = bookIds[7]!;
    await seedState('micro-clear', bookId);
    await repo.markPositionPushPending(userId, 'micro-clear');
    const readBack = await writeProgressWithMicroseconds(bookId, '2026-09-29T10:00:00.123456Z');
    expect(readBack.getTime()).toBe(Date.parse('2026-09-29T10:00:00.123Z'));

    await repo.clearPositionPushPendingIfUnchanged(userId, 'micro-clear', bookId, readBack);

    expect(await pendingAt('micro-clear')).toBeNull();
  });

  it('keeps pending when the progress row changed after it was read', async () => {
    const bookId = bookIds[7]!;
    await repo.markPositionPushPending(userId, 'micro-clear');
    const readBack = await writeProgressWithMicroseconds(bookId, '2026-09-29T10:05:00.654321Z');
    await writeProgressWithMicroseconds(bookId, '2026-09-29T10:06:00.111111Z');

    await repo.clearPositionPushPendingIfUnchanged(userId, 'micro-clear', bookId, readBack);

    expect(await pendingAt('micro-clear')).toBeInstanceOf(Date);
  });

  it('completes a push and clears pending when the microsecond progress row is unchanged', async () => {
    const bookId = bookIds[7]!;
    await repo.markPositionPushPending(userId, 'micro-clear');
    const readBack = await writeProgressWithMicroseconds(bookId, '2026-09-29T11:00:00.987654Z');

    await repo.completePositionPush(userId, 'micro-clear', bookId, readBack, 424242);

    const row = await stateRow('micro-clear');
    expect(row.pushPendingAt).toBeNull();
    expect(row.lastSyncedPositionAbsUpdate).toBe(424242);
    expect(row.lastSyncedProgressAt?.getTime()).toBe(readBack.getTime());
  });

  it('completes a push but keeps pending when local progress was written in between', async () => {
    const bookId = bookIds[7]!;
    await repo.clearPositionPushPending(userId, 'micro-clear');
    const readBack = await writeProgressWithMicroseconds(bookId, '2026-09-29T12:00:00.222222Z');
    await writeProgressWithMicroseconds(bookId, '2026-09-29T12:00:05.333333Z');

    await repo.completePositionPush(userId, 'micro-clear', bookId, readBack, 525252);

    const row = await stateRow('micro-clear');
    expect(row.pushPendingAt).toBeInstanceOf(Date);
    expect(row.lastSyncedPositionAbsUpdate).toBe(525252);
    expect(row.lastSyncedProgressAt?.getTime()).toBe(readBack.getTime());
  });
});
