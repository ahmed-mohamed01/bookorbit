import { Module } from '@nestjs/common';

import { AchievementModule } from '../achievement/achievement.module';
import { BookModule } from '../book/book.module';
import { LibraryModule } from '../library/library.module';
import { UserBookStatusModule } from '../user-book-status/user-book-status.module';
import { AudiobookshelfBookStateService } from './audiobookshelf-book-state.service';
import { AudiobookshelfBooksController } from './audiobookshelf-books.controller';
import { AudiobookshelfClientService } from './audiobookshelf-client.service';
import { AudiobookshelfController } from './audiobookshelf.controller';
import { AudiobookshelfMatchService } from './audiobookshelf-match.service';
import { AudiobookshelfRepository } from './audiobookshelf.repository';
import { AudiobookshelfSessionsService } from './audiobookshelf-sessions.service';
import { AudiobookshelfSettingsService } from './audiobookshelf-settings.service';
import { AudiobookshelfSyncService } from './audiobookshelf-sync.service';

@Module({
  imports: [AchievementModule, BookModule, LibraryModule, UserBookStatusModule],
  controllers: [AudiobookshelfController, AudiobookshelfBooksController],
  providers: [
    AudiobookshelfClientService,
    AudiobookshelfRepository,
    AudiobookshelfSettingsService,
    AudiobookshelfMatchService,
    AudiobookshelfBookStateService,
    AudiobookshelfSessionsService,
    AudiobookshelfSyncService,
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
