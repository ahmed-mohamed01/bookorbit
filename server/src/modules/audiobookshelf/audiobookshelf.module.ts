import { Module } from '@nestjs/common';

import { AudiobookshelfClientService } from './audiobookshelf-client.service';
import { AudiobookshelfController } from './audiobookshelf.controller';
import { AudiobookshelfRepository } from './audiobookshelf.repository';
import { AudiobookshelfSettingsService } from './audiobookshelf-settings.service';

@Module({
  controllers: [AudiobookshelfController],
  providers: [AudiobookshelfClientService, AudiobookshelfRepository, AudiobookshelfSettingsService],
  exports: [AudiobookshelfClientService, AudiobookshelfSettingsService],
})
export class AudiobookshelfModule {}
