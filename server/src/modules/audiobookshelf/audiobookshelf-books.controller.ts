import { Permission } from '@bookorbit/types';
import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { AudiobookshelfBookStateService } from './audiobookshelf-book-state.service';
import { AudiobookshelfMatchService } from './audiobookshelf-match.service';
import { CleanupAudiobookshelfStaleDto, LinkAudiobookshelfBookDto, ListAudiobookshelfBookStatesDto, UpdateAudiobookshelfExclusionDto } from './dto';

// Twice the 40px rail stop, so the thumbnail stays sharp on high-density screens.
const AUDIOBOOKSHELF_COVER_THUMBNAIL_WIDTH = 80;

@Controller('audiobookshelf/books')
@RequirePermission(Permission.AudiobookshelfSync)
export class AudiobookshelfBooksController {
  constructor(
    private readonly bookStateService: AudiobookshelfBookStateService,
    private readonly matchService: AudiobookshelfMatchService,
  ) {}

  @Get()
  list(@CurrentUser() user: RequestUser, @Query() dto: ListAudiobookshelfBookStatesDto) {
    return this.bookStateService.list(user, dto);
  }

  @Get('for-book/:bookId')
  findForBook(@CurrentUser() user: RequestUser, @Param('bookId', ParseIntPipe) bookId: number) {
    return this.bookStateService.findPositionSyncLink(user, bookId);
  }

  @Get(':absLibraryItemId/live')
  getLive(@CurrentUser() user: RequestUser, @Param('absLibraryItemId') absLibraryItemId: string) {
    return this.bookStateService.getLiveSyncStatus(user, absLibraryItemId);
  }

  @Get(':absLibraryItemId/cover')
  async getCover(@CurrentUser() user: RequestUser, @Param('absLibraryItemId') absLibraryItemId: string, @Res() reply: FastifyReply) {
    const cover = await this.bookStateService.getCoverThumbnail(user, absLibraryItemId, AUDIOBOOKSHELF_COVER_THUMBNAIL_WIDTH);
    reply.header('Cache-Control', 'private, max-age=86400');
    reply.type(cover.contentType);
    reply.send(cover.body);
  }

  @Post('rescan')
  rescan(@CurrentUser() user: RequestUser) {
    return this.matchService.rescan(user);
  }

  @Post('cleanup-stale')
  cleanupStale(@CurrentUser() user: RequestUser, @Body() dto: CleanupAudiobookshelfStaleDto) {
    return this.matchService.cleanupStale(user, { includeManuallyUnlinked: dto.includeManuallyUnlinked ?? false });
  }

  @Post(':absLibraryItemId/confirm')
  confirm(@CurrentUser() user: RequestUser, @Param('absLibraryItemId') absLibraryItemId: string) {
    return this.bookStateService.confirm(user, absLibraryItemId);
  }

  @Patch(':absLibraryItemId/link')
  link(@CurrentUser() user: RequestUser, @Param('absLibraryItemId') absLibraryItemId: string, @Body() dto: LinkAudiobookshelfBookDto) {
    return this.bookStateService.link(user, absLibraryItemId, dto.bookId);
  }

  @Delete(':absLibraryItemId/link')
  unlink(@CurrentUser() user: RequestUser, @Param('absLibraryItemId') absLibraryItemId: string) {
    return this.bookStateService.unlink(user, absLibraryItemId);
  }

  @Patch(':absLibraryItemId/exclusion')
  setExclusion(@CurrentUser() user: RequestUser, @Param('absLibraryItemId') absLibraryItemId: string, @Body() dto: UpdateAudiobookshelfExclusionDto) {
    return this.bookStateService.setExclusion(user, absLibraryItemId, dto.syncExcluded);
  }
}
