import { Permission } from '@bookorbit/types';
import { Body, Controller, Delete, Get, Patch, Post } from '@nestjs/common';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { TestAudiobookshelfConnectionDto, UpsertAudiobookshelfSettingsDto } from './dto';
import { AudiobookshelfMatchService } from './audiobookshelf-match.service';
import { AudiobookshelfSettingsService } from './audiobookshelf-settings.service';
import { AudiobookshelfSyncService } from './audiobookshelf-sync.service';

@Controller('audiobookshelf')
@RequirePermission(Permission.AudiobookshelfSync)
export class AudiobookshelfController {
  constructor(
    private readonly settingsService: AudiobookshelfSettingsService,
    private readonly syncService: AudiobookshelfSyncService,
    private readonly matchService: AudiobookshelfMatchService,
  ) {}

  @Get('settings')
  getSettings(@CurrentUser() user: RequestUser) {
    return this.settingsService.getSettings(user.id);
  }

  @Get('libraries')
  getLibraries(@CurrentUser() user: RequestUser) {
    return this.settingsService.getLibraries(user);
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

  @Post('path-mappings/suggest')
  suggestPathMappings(@CurrentUser() user: RequestUser) {
    return this.matchService.suggestPathMappings(user);
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
