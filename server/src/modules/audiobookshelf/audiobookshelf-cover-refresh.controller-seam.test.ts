import type { RequestUser } from '../../common/types/request-user';
import { BookController } from '../book/book.controller';

describe('Audiobookshelf bulk cover refresher controller seam', () => {
  it('uses the registered extension for single-book cover refresh', async () => {
    const bookService = { bulkReExtractCover: vi.fn() };
    const bulkCoverRefresher = { bulkReExtractCover: vi.fn().mockResolvedValue({ processed: 1, updated: 1 }) };
    const controller = new BookController(bookService as never, {} as never, bulkCoverRefresher);
    const user = { id: 7 } as RequestUser;

    await expect(controller.reExtractCover(42, user)).resolves.toEqual({ processed: 1, updated: 1 });

    expect(bulkCoverRefresher.bulkReExtractCover).toHaveBeenCalledWith([42], user);
    expect(bookService.bulkReExtractCover).not.toHaveBeenCalled();
  });
});
