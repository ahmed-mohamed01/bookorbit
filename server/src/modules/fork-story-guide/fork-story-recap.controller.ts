import { Controller, Get, Headers, Param, ParseIntPipe, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsOptional } from 'class-validator';
import type { FastifyReply } from 'fastify';

import { InteractiveOnly } from '../../common/decorators/api-key-policy.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { StoryRecapService } from './story-recap.service';

class StoryRecapQueryDto {
  @IsOptional()
  @IsIn(['0', '1'])
  stop?: '0' | '1';
}

@Controller('story-guide-content/files/:fileId')
@InteractiveOnly()
export class ForkStoryRecapController {
  constructor(private readonly storyRecap: StoryRecapService) {}

  @Get('recap')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async recap(
    @Param('fileId', ParseIntPipe) fileId: number,
    @Query() query: StoryRecapQueryDto,
    @CurrentUser() user: RequestUser,
    @Res() reply: FastifyReply,
    @Headers('accept-language') acceptLanguage?: string,
  ): Promise<void> {
    const hangUp = new AbortController();
    const handleClose = () => {
      if (!reply.raw.writableEnded) hangUp.abort();
    };
    reply.raw.on('close', handleClose);
    try {
      const result = await this.storyRecap.recap(fileId, user, query.stop !== '0', acceptLanguage, hangUp.signal);
      if (!reply.raw.destroyed) reply.header('Cache-Control', 'private, no-store').send(result);
    } finally {
      reply.raw.off('close', handleClose);
    }
  }
}
