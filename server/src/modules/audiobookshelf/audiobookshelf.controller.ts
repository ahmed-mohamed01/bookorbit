import { Permission } from '@bookorbit/types';
import { Body, Controller, Delete, Get, Patch, Post } from '@nestjs/common';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { TestAudiobookshelfConnectionDto, UpsertAudiobookshelfSettingsDto } from './dto';
import { AudiobookshelfSettingsService } from './audiobookshelf-settings.service';
import { AudiobookshelfSyncService } from './audiobookshelf-sync.service';

@Controller('audiobookshelf')
@RequirePermission(Permission.AudiobookshelfSync)
export class AudiobookshelfController {
  constructor(
    private readonly settingsService: AudiobookshelfSettingsService,
    private readonly syncService: AudiobookshelfSyncService,
  ) {}

  @Get('settings')
  getSettings(@CurrentUser() user: RequestUser) {
    return this.settingsService.getSettings(user.id);
  }

  @Patch('settings')
  upsertSettings(@CurrentUser() user: RequestUser, @Body() dto: UpsertAudiobookshelfSettingsDto) {
    return this.settingsService.upsertSettings(user.id, dto);
  }

  @Delete('settings')
  disconnectUser(@CurrentUser() user: RequestUser) {
    return this.settingsService.disconnectUser(user.id);
  }

  @Post('test-connection')
  testConnection(@CurrentUser() user: RequestUser, @Body() dto: TestAudiobookshelfConnectionDto) {
    return this.settingsService.testConnection(user.id, dto);
  }

  @Post('sync')
  sync(@CurrentUser() user: RequestUser) {
    return this.syncService.sync(user);
  }

  @Post('full-resync')
  fullResync(@CurrentUser() user: RequestUser) {
    return this.syncService.fullResync(user);
  }
}
