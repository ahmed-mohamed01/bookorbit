import type { RequestUser } from '../../common/types/request-user';
import type { BulkRunRow } from '../../db/schema';
import { BulkRunHandlerRegistry } from '../bulk-runs/bulk-run-handler.registry';
import { BookReExtractCoverBulkHandler } from './book-bulk-run-handlers';
import type { BulkCoverRefresher } from './bulk-cover-refresher';

const actor = { id: 5, isSuperuser: false, permissions: [] } as unknown as RequestUser;
const run = { kind: 'book-re-extract-cover', subjectIds: [1, 2, 3, 4], processed: 1 } as unknown as BulkRunRow;

function arrange(refresher?: BulkCoverRefresher) {
  const books = { reExtractCoverBulkItem: vi.fn().mockResolvedValue({ status: 'attempted', updated: false }) };
  return { books, handler: new BookReExtractCoverBulkHandler(new BulkRunHandlerRegistry(), books as never, refresher) };
}

describe('BULK_COVER_REFRESHER under the book-re-extract-cover bulk run', () => {
  it('runs upstream unchanged when no refresher is provided', async () => {
    const { books, handler } = arrange();

    const { state } = (await handler.prepare(run)) as { state: null };
    expect(state).toBeNull();
    await expect(handler.processItem(2, { run, actor, state })).resolves.toEqual({ outcome: 'succeeded', stats: undefined, event: { bookId: 2 } });
    expect(books.reExtractCoverBulkItem).toHaveBeenCalledWith(2, actor);
  });

  it('runs upstream unchanged for a refresher without a bulk-run hook', async () => {
    const { handler } = arrange({ bulkReExtractCover: vi.fn() });

    await expect(handler.prepare(run)).resolves.toEqual({ state: null });
  });

  it('prepares the hook with the books still to do', async () => {
    const prepareBulkRun = vi.fn().mockResolvedValue(null);
    const { handler } = arrange({ bulkReExtractCover: vi.fn(), prepareBulkRun });

    await handler.prepare(run);

    expect(prepareBulkRun).toHaveBeenCalledWith([2, 3, 4]);
  });

  it('takes the hook answer for a book it owns and hands the rest to upstream', async () => {
    const item = vi.fn((bookId: number) => Promise.resolve(bookId === 2 ? { status: 'attempted' as const, updated: true } : null));
    const { books, handler } = arrange({ bulkReExtractCover: vi.fn(), prepareBulkRun: vi.fn().mockResolvedValue(item) });
    const { state } = (await handler.prepare(run)) as { state: typeof item };

    await expect(handler.processItem(2, { run, actor, state })).resolves.toEqual({
      outcome: 'succeeded',
      stats: { updated: 1 },
      event: { bookId: 2 },
    });
    await expect(handler.processItem(3, { run, actor, state })).resolves.toEqual({ outcome: 'succeeded', stats: undefined, event: { bookId: 3 } });

    expect(item).toHaveBeenCalledWith(2, actor);
    expect(books.reExtractCoverBulkItem).toHaveBeenCalledTimes(1);
    expect(books.reExtractCoverBulkItem).toHaveBeenCalledWith(3, actor);
  });
});
