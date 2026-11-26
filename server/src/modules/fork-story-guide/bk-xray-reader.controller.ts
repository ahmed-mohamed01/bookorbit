import { Controller, Get, NotFoundException, Param, ParseIntPipe } from '@nestjs/common';
import type { BookKnowledgeXrayPayload } from '@bookorbit/types';

import { InteractiveOnly } from '../../common/decorators/api-key-policy.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ResolvesMergedBook } from '../../common/decorators/resolves-merged-book.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { BookService } from '../book/book.service';
import { BookKnowledgeService } from '../book-knowledge/book-knowledge.service';
import { StoryGuidesService } from '../story-guides/story-guides.service';
import { bkGuideContent } from './bk-pipeline/rewrite-bk-extras';

@Controller('books/:bookId/knowledge/xray')
@InteractiveOnly()
export class BkXrayReaderController {
  constructor(
    private readonly knowledge: BookKnowledgeService,
    private readonly guides: StoryGuidesService,
    private readonly books: BookService,
  ) {}

  @Get()
  @ResolvesMergedBook({ params: ['bookId'] })
  async payload(@Param('bookId', ParseIntPipe) bookId: number, @CurrentUser() user: RequestUser): Promise<BookKnowledgeXrayPayload> {
    await this.books.verifyBookAccess(bookId, user);
    const fileId = await this.knowledge.sourceFileId(bookId);
    if (fileId !== null) {
      const content = await bkGuideContent(this.guides, fileId, [1], user);
      // An upstream-built guide has no BK links, and the viewer reads them.
      if (content.kind === 'found' && Array.isArray((content.body as Partial<BookKnowledgeXrayPayload>).links))
        return content.body as BookKnowledgeXrayPayload;
    }
    throw new NotFoundException('No X-Ray is stored for this book');
  }
}
