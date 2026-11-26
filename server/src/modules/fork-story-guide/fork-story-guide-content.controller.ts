import { Controller, Get, Headers, HttpStatus, Param, ParseIntPipe, Query, Res } from '@nestjs/common';
import type { StoryGuideContentMissing } from '@bookorbit/types';
import type { FastifyReply } from 'fastify';

import { InteractiveOnly } from '../../common/decorators/api-key-policy.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { StoryGuideContentQueryDto } from '../story-guides/dto/story-guide.dto';
import { StoryGuidesService } from '../story-guides/story-guides.service';
import { bkGuideContent } from './bk-pipeline/rewrite-bk-extras';

@Controller('story-guide-content/files/:fileId')
@InteractiveOnly()
export class ForkStoryGuideContentController {
  constructor(private readonly service: StoryGuidesService) {}

  @Get()
  async read(
    @Param('fileId', ParseIntPipe) fileId: number,
    @Query() query: StoryGuideContentQueryDto,
    @CurrentUser() user: RequestUser,
    @Res() reply: FastifyReply,
    @Headers('if-none-match') ifNoneMatch?: string,
  ): Promise<void> {
    const formats = [...new Set((query.format ?? '1').split(',').map(Number))];
    const content = await bkGuideContent(this.service, fileId, formats, user, ifNoneMatch);
    if (content.kind === 'missing') {
      const body: StoryGuideContentMissing = { reason: content.reason };
      reply.status(HttpStatus.NOT_FOUND).header('Cache-Control', 'private, no-cache').send(body);
      return;
    }
    reply.header('ETag', content.etag).header('Cache-Control', 'private, no-cache');
    if (content.kind === 'not-modified') {
      reply.status(HttpStatus.NOT_MODIFIED).send();
      return;
    }
    reply.send(content.body);
  }
}
