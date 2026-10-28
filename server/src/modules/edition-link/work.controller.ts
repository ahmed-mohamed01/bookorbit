import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import {
  Permission,
  type AbsHistoryRebuildPreview,
  type AbsHistoryRebuildResult,
  type EditionLinkMatchDismissal,
  type EditionLinkMatchListResponse,
  type EditionLinkScanStatus,
  type EditionLinkSettings,
  type LinkAllStrongResult,
  type WorkForBook,
} from '@bookorbit/types';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { AddWorkMemberDto, ListMatchesQueryDto, StartMatchScanDto, UpdateEditionLinkSettingsDto } from './dto/work.dto';
import { EditionLinkService } from './edition-link.service';
import { WorkMatchService } from './work-match.service';
import { WorkStateService } from './work-state.service';
import { WorkService } from './work.service';

@Controller('edition-links')
export class WorkController {
  constructor(
    private readonly works: WorkService,
    private readonly links: EditionLinkService,
    private readonly matches: WorkMatchService,
    private readonly state: WorkStateService,
  ) {}

  @Get('work/:bookId')
  getWork(@CurrentUser() user: RequestUser, @Param('bookId', ParseIntPipe) bookId: number): Promise<WorkForBook> {
    return this.works.getWorkForBook(user, bookId);
  }

  @Post('work/:bookId/members')
  @RequirePermission(Permission.LibraryEditMetadata)
  addMember(@CurrentUser() user: RequestUser, @Param('bookId', ParseIntPipe) bookId: number, @Body() dto: AddWorkMemberDto): Promise<WorkForBook> {
    return this.works.addMember(user, bookId, dto.bookId);
  }

  @Delete('work/members/:bookId')
  @RequirePermission(Permission.LibraryEditMetadata)
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeMember(@CurrentUser() user: RequestUser, @Param('bookId', ParseIntPipe) bookId: number): Promise<void> {
    await this.links.unlink(user, bookId);
  }

  @Post('work/members/:bookId/primary')
  @RequirePermission(Permission.LibraryEditMetadata)
  setPrimary(@CurrentUser() user: RequestUser, @Param('bookId', ParseIntPipe) bookId: number): Promise<WorkForBook> {
    return this.works.setPrimary(user, bookId);
  }

  @Get('settings')
  getSettings(@CurrentUser() user: RequestUser): Promise<EditionLinkSettings> {
    return this.works.getSettings(user.id);
  }

  @Put('settings')
  updateSettings(@CurrentUser() user: RequestUser, @Body() dto: UpdateEditionLinkSettingsDto): Promise<EditionLinkSettings> {
    return this.works.updateSettings(user.id, dto);
  }

  @Post('matches/scans')
  @RequirePermission(Permission.LibraryEditMetadata)
  startScan(@CurrentUser() user: RequestUser, @Body() dto: StartMatchScanDto): Promise<EditionLinkScanStatus> {
    return this.matches.startScan(user, dto.libraryId);
  }

  @Get('matches/scans/active')
  getActiveScan(@CurrentUser() user: RequestUser): Promise<EditionLinkScanStatus> {
    return this.matches.getActiveScan(user);
  }

  @Get('matches')
  listMatches(@CurrentUser() user: RequestUser, @Query() query: ListMatchesQueryDto): Promise<EditionLinkMatchListResponse> {
    return this.matches.listMatches(user, { buckets: query.bucket ?? [], libraryId: query.libraryId, page: query.page, pageSize: query.pageSize });
  }

  @Post('matches/link-all-strong')
  @RequirePermission(Permission.LibraryEditMetadata)
  linkAllStrong(@CurrentUser() user: RequestUser): Promise<LinkAllStrongResult> {
    return this.matches.linkAllStrong(user);
  }

  @Get('matches/dismissals')
  listDismissals(@CurrentUser() user: RequestUser): Promise<EditionLinkMatchDismissal[]> {
    return this.matches.listDismissals(user);
  }

  @Delete('matches/dismissals/:bookIdA/:bookIdB')
  @RequirePermission(Permission.LibraryEditMetadata)
  @HttpCode(HttpStatus.NO_CONTENT)
  restoreDismissal(
    @CurrentUser() user: RequestUser,
    @Param('bookIdA', ParseIntPipe) bookIdA: number,
    @Param('bookIdB', ParseIntPipe) bookIdB: number,
  ): Promise<void> {
    return this.matches.restoreDismissal(user, bookIdA, bookIdB);
  }

  @Post('matches/:id/link')
  @RequirePermission(Permission.LibraryEditMetadata)
  @HttpCode(HttpStatus.NO_CONTENT)
  linkMatch(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.matches.linkMatch(user, id);
  }

  @Post('matches/:id/dismiss')
  @RequirePermission(Permission.LibraryEditMetadata)
  @HttpCode(HttpStatus.NO_CONTENT)
  dismissMatch(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.matches.dismiss(user, id);
  }

  @Post('audiobookshelf-history/preview')
  @RequirePermission(Permission.AudiobookshelfSync)
  @HttpCode(HttpStatus.OK)
  previewAbsHistory(@CurrentUser() user: RequestUser): Promise<AbsHistoryRebuildPreview> {
    return this.state.previewAbsHistory(user);
  }

  @Post('audiobookshelf-history/rebuild')
  @RequirePermission(Permission.AudiobookshelfSync)
  @HttpCode(HttpStatus.OK)
  rebuildAbsHistory(@CurrentUser() user: RequestUser): Promise<AbsHistoryRebuildResult> {
    return this.state.rebuildAbsHistory(user);
  }
}
