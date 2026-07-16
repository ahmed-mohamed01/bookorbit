import { Module } from '@nestjs/common';

import { BookModule } from '../book/book.module';
import { LibraryModule } from '../library/library.module';
import { UserBookStatusModule } from '../user-book-status/user-book-status.module';
import { AudiobookshelfBookStateService } from './audiobookshelf-book-state.service';
import { AudiobookshelfBooksController } from './audiobookshelf-books.controller';
import { AudiobookshelfClientService } from './audiobookshelf-client.service';
import { AudiobookshelfController } from './audiobookshelf.controller';
import { AudiobookshelfMatchService } from './audiobookshelf-match.service';
import { AudiobookshelfRepository } from './audiobookshelf.repository';
import { AudiobookshelfSettingsService } from './audiobookshelf-settings.service';
import { AudiobookshelfSyncService } from './audiobookshelf-sync.service';

@Module({
  imports: [BookModule, LibraryModule, UserBookStatusModule],
  controllers: [AudiobookshelfController, AudiobookshelfBooksController],
  providers: [
    AudiobookshelfClientService,
    AudiobookshelfRepository,
    AudiobookshelfSettingsService,
    AudiobookshelfMatchService,
    AudiobookshelfBookStateService,
    AudiobookshelfSyncService,
  ],
  exports: [AudiobookshelfClientService, AudiobookshelfSettingsService, AudiobookshelfMatchService, AudiobookshelfSyncService],
})
export class AudiobookshelfModule {}
