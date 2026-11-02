import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { Permission } from '@bookorbit/types';
import type {
  EditionSyncAdminSettings,
  EditionSyncAdminStatus,
  EditionSyncBookState,
  EditionSyncBookListResponse,
  EditionSyncClearUnusedResult,
  EditionSyncSettings,
} from '@bookorbit/types';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { EditionSyncBookListQueryDto, UpdateEditionSyncAdminSettingsDto, UpdateEditionSyncBookStateDto, UpsertEditionSyncSettingsDto } from './dto';
import { EditionSyncBookListService } from './edition-sync-book-list.service';
import { EditionSyncBookStateService } from './edition-sync-book-state.service';
import { EditionSyncQueueService } from './edition-sync-queue.service';
import { EditionSyncSchedulerService } from './edition-sync-scheduler.service';
import { EditionSyncSettingsService } from './edition-sync-settings.service';

// Method-level @RequirePermission replaces the class-level one (the guard uses getAllAndOverride),
// so the admin routes need manage_app_settings and not edition_sync.
@Controller('edition-sync')
@RequirePermission(Permission.EditionSync)
export class EditionSyncController {
  constructor(
    private readonly settings: EditionSyncSettingsService,
    private readonly bookState: EditionSyncBookStateService,
    private readonly scheduler: EditionSyncSchedulerService,
    private readonly queue: EditionSyncQueueService,
    private readonly bookList: EditionSyncBookListService,
  ) {}

  @Get('settings')
  getSettings(@CurrentUser() user: RequestUser): Promise<EditionSyncSettings> {
    return this.settings.getSettings(user);
  }

  @Patch('settings')
  upsertSettings(@CurrentUser() user: RequestUser, @Body() dto: UpsertEditionSyncSettingsDto): Promise<EditionSyncSettings> {
    return this.settings.upsertSettings(user, dto);
  }

  @Get('books')
  listBooks(@CurrentUser() user: RequestUser, @Query() query: EditionSyncBookListQueryDto): Promise<EditionSyncBookListResponse> {
    return this.bookList.list(user, query);
  }

  @Get('books/:bookId/state')
  getBookState(@CurrentUser() user: RequestUser, @Param('bookId', ParseIntPipe) bookId: number): Promise<EditionSyncBookState> {
    return this.bookState.getState(user, bookId);
  }

  @Patch('books/:bookId/state')
  updateBookState(
    @CurrentUser() user: RequestUser,
    @Param('bookId', ParseIntPipe) bookId: number,
    @Body() dto: UpdateEditionSyncBookStateDto,
  ): Promise<EditionSyncBookState> {
    return this.bookState.setSyncEnabled(user, bookId, dto.syncEnabled);
  }

  @Post('books/:bookId/run')
  @HttpCode(HttpStatus.OK)
  runBookNow(@CurrentUser() user: RequestUser, @Param('bookId', ParseIntPipe) bookId: number): Promise<EditionSyncBookState> {
    return this.bookState.runNow(user, bookId);
  }

  @Post('books/:bookId/retry')
  @HttpCode(HttpStatus.OK)
  retryBook(@CurrentUser() user: RequestUser, @Param('bookId', ParseIntPipe) bookId: number): Promise<EditionSyncBookState> {
    return this.bookState.retry(user, bookId);
  }

  @Get('admin/status')
  @RequirePermission(Permission.ManageAppSettings)
  getAdminStatus(): Promise<EditionSyncAdminStatus> {
    return this.scheduler.getAdminStatus();
  }

  @Get('admin/settings')
  @RequirePermission(Permission.ManageAppSettings)
  getAdminSettings(): Promise<EditionSyncAdminSettings> {
    return this.settings.getAdminSettings();
  }

  @Patch('admin/settings')
  @RequirePermission(Permission.ManageAppSettings)
  updateAdminSettings(@CurrentUser() user: RequestUser, @Body() dto: UpdateEditionSyncAdminSettingsDto): Promise<EditionSyncAdminSettings> {
    return this.settings.updateAdminSettings(user, dto);
  }

  @Post('admin/run')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.ManageAppSettings)
  startRun(): Promise<EditionSyncAdminStatus> {
    return this.scheduler.startManualRun();
  }

  @Post('admin/stop')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.ManageAppSettings)
  stopRun(): Promise<EditionSyncAdminStatus> {
    return this.scheduler.stop();
  }

  @Post('admin/clear-unused')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.ManageAppSettings)
  clearUnused(): Promise<EditionSyncClearUnusedResult> {
    return this.queue.clearUnused();
  }
}
