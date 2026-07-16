import { Module } from '@nestjs/common';

import { BookModule } from '../book/book.module';
import { LibraryModule } from '../library/library.module';
import { AudiobookshelfBookStateService } from './audiobookshelf-book-state.service';
import { AudiobookshelfBooksController } from './audiobookshelf-books.controller';
import { AudiobookshelfClientService } from './audiobookshelf-client.service';
import { AudiobookshelfController } from './audiobookshelf.controller';
import { AudiobookshelfMatchService } from './audiobookshelf-match.service';
import { AudiobookshelfRepository } from './audiobookshelf.repository';
import { AudiobookshelfSettingsService } from './audiobookshelf-settings.service';

@Module({
  imports: [BookModule, LibraryModule],
  controllers: [AudiobookshelfController, AudiobookshelfBooksController],
  providers: [
    AudiobookshelfClientService,
    AudiobookshelfRepository,
    AudiobookshelfSettingsService,
    AudiobookshelfMatchService,
    AudiobookshelfBookStateService,
  ],
  exports: [AudiobookshelfClientService, AudiobookshelfSettingsService, AudiobookshelfMatchService],
})
export class AudiobookshelfModule {}
