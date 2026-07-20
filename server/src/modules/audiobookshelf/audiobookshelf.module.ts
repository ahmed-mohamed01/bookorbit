import { Module } from '@nestjs/common';

import { AchievementModule } from '../achievement/achievement.module';
import { BookModule } from '../book/book.module';
import { LibraryModule } from '../library/library.module';
import { UserModule } from '../user/user.module';
import { UserBookStatusModule } from '../user-book-status/user-book-status.module';
import { AudiobookshelfMetadataModule } from './audiobookshelf-metadata.module';
import { AudiobookshelfBookStateService } from './audiobookshelf-book-state.service';
import { AudiobookshelfBooksController } from './audiobookshelf-books.controller';
import { AudiobookshelfClientService } from './audiobookshelf-client.service';
import { AudiobookshelfController } from './audiobookshelf.controller';
import { AudiobookshelfMatchService } from './audiobookshelf-match.service';
import { AudiobookshelfSchemaBootstrapService } from './audiobookshelf-schema-bootstrap.service';
import { AudiobookshelfSessionsService } from './audiobookshelf-sessions.service';
import { AudiobookshelfSettingsService } from './audiobookshelf-settings.service';
import { AudiobookshelfSyncSchedulerService } from './audiobookshelf-sync-scheduler.service';
import { AudiobookshelfSyncService } from './audiobookshelf-sync.service';

@Module({
  imports: [AchievementModule, BookModule, LibraryModule, UserModule, UserBookStatusModule, AudiobookshelfMetadataModule],
  controllers: [AudiobookshelfController, AudiobookshelfBooksController],
  providers: [
    AudiobookshelfClientService,
    AudiobookshelfSchemaBootstrapService,
    AudiobookshelfSettingsService,
    AudiobookshelfMatchService,
    AudiobookshelfBookStateService,
    AudiobookshelfSessionsService,
    AudiobookshelfSyncService,
    AudiobookshelfSyncSchedulerService,
  ],
  exports: [
    AudiobookshelfClientService,
    AudiobookshelfSettingsService,
    AudiobookshelfMatchService,
    AudiobookshelfSyncService,
    AudiobookshelfSessionsService,
  ],
})
export class AudiobookshelfModule {}
