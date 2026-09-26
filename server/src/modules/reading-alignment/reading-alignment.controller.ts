import { Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { Permission } from '@bookorbit/types';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { BuildAlignmentQueryDto } from './dto';
import { ReadingAlignmentResolveService } from './reading-alignment-resolve.service';
import type { CrossFormatResume } from './reading-alignment-resolve.service';
import { ReadingAlignmentStatusService } from './reading-alignment-status.service';
import type { AlignmentBuildRequestResult, AlignmentStatusResult } from './reading-alignment-status.service';

@Controller('reading-alignment')
export class ReadingAlignmentController {
  constructor(
    private readonly resolveService: ReadingAlignmentResolveService,
    private readonly statusService: ReadingAlignmentStatusService,
  ) {}

  @Get('books/:bookId/cross-format-resume')
  getCrossFormatResume(@Param('bookId', ParseIntPipe) bookId: number, @CurrentUser() user: RequestUser): Promise<CrossFormatResume> {
    return this.resolveService.resolveResume(bookId, user);
  }

  @Post('books/:bookId/build')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission(Permission.LibraryEditMetadata)
  requestBuild(
    @Param('bookId', ParseIntPipe) bookId: number,
    @Query() query: BuildAlignmentQueryDto,
    @CurrentUser() user: RequestUser,
  ): Promise<AlignmentBuildRequestResult> {
    return this.statusService.requestBuild(bookId, user, query.force ?? false);
  }

  @Delete('books/:bookId/build')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(Permission.LibraryEditMetadata)
  cancelBuild(@Param('bookId', ParseIntPipe) bookId: number, @CurrentUser() user: RequestUser): Promise<void> {
    return this.statusService.cancelBuild(bookId, user);
  }

  @Get('books/:bookId/alignment')
  getAlignmentStatus(@Param('bookId', ParseIntPipe) bookId: number, @CurrentUser() user: RequestUser): Promise<AlignmentStatusResult> {
    return this.statusService.getStatus(bookId, user);
  }
}
