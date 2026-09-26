import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Put } from '@nestjs/common';

import type {
  ReadAlongBuildResponse,
  ReadAlongStatusResponse,
  StorytellerConnectionTestResult,
  StorytellerExistingMatchesResponse,
  StorytellerSettings,
} from '@bookorbit/types';
import { Permission } from '@bookorbit/types';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { BuildReadAlongDto, TestStorytellerConnectionDto, UpsertStorytellerSettingsDto } from './dto';
import { StorytellerReadAlongStatusService } from './storyteller-read-along-status.service';
import { StorytellerSettingsService } from './storyteller-settings.service';

@Controller('storyteller')
export class StorytellerController {
  constructor(
    private readonly settingsService: StorytellerSettingsService,
    private readonly readAlongStatusService: StorytellerReadAlongStatusService,
  ) {}

  @Get('settings')
  @RequirePermission(Permission.ManageAppSettings)
  getSettings(): Promise<StorytellerSettings> {
    return this.settingsService.getSettings();
  }

  @Put('settings')
  @RequirePermission(Permission.ManageAppSettings)
  updateSettings(@Body() dto: UpsertStorytellerSettingsDto, @CurrentUser() user: RequestUser): Promise<StorytellerSettings> {
    return this.settingsService.upsertSettings(dto, user);
  }

  @Post('settings/test')
  @RequirePermission(Permission.ManageAppSettings)
  testConnection(@Body() dto: TestStorytellerConnectionDto, @CurrentUser() user: RequestUser): Promise<StorytellerConnectionTestResult> {
    return this.settingsService.testConnection(user, dto);
  }

  @Post('read-along/books/:bookId/build')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission(Permission.LibraryUpload)
  requestBuild(
    @Param('bookId', ParseIntPipe) bookId: number,
    @Body() dto: BuildReadAlongDto,
    @CurrentUser() user: RequestUser,
  ): Promise<ReadAlongBuildResponse> {
    return this.readAlongStatusService.requestBuild(bookId, user, dto);
  }

  /**
   * Deliberately the one route with no `@RequirePermission`: the read-along row renders for every
   * reader who can open the book, so gating it would blank the row for ordinary readers. Book access
   * is the gate, and what a reader may not see is masked inside the response instead.
   */
  @Get('read-along/books/:bookId/status')
  getStatus(@Param('bookId', ParseIntPipe) bookId: number, @CurrentUser() user: RequestUser): Promise<ReadAlongStatusResponse> {
    return this.readAlongStatusService.getStatus(bookId, user);
  }

  @Get('read-along/books/:bookId/existing')
  @RequirePermission(Permission.LibraryUpload)
  findExisting(@Param('bookId', ParseIntPipe) bookId: number, @CurrentUser() user: RequestUser): Promise<StorytellerExistingMatchesResponse> {
    return this.readAlongStatusService.findExisting(bookId, user);
  }
}
