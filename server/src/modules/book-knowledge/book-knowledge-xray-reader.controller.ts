import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ResolvesMergedBook } from '../../common/decorators/resolves-merged-book.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { BookKnowledgeXrayService } from './book-knowledge-xray.service';

/** The stored whole-book X-Ray for a reader with access to the book; it is position-stamped and the viewer cuts it to the reader's place. */
@Controller('books/:bookId/knowledge/xray')
export class BookKnowledgeXrayReaderController {
  constructor(private readonly xray: BookKnowledgeXrayService) {}
  @Get()
  @ResolvesMergedBook({ params: ['bookId'] })
  payload(@Param('bookId', ParseIntPipe) bookId: number, @CurrentUser() user: RequestUser) {
    return this.xray.storedPayload(bookId, user);
  }
}
