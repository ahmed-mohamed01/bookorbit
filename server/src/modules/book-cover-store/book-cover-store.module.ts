import { Module } from '@nestjs/common';

import { BookCoverPlaceholderSchemaBootstrapService } from './book-cover-placeholder-schema-bootstrap.service';
import { BookCoverEventsService } from './book-cover-events.service';
import { BookCoverStoreRepository } from './book-cover-store.repository';
import { BookCoverStore } from './book-cover-store.service';

@Module({
  providers: [BookCoverPlaceholderSchemaBootstrapService, BookCoverStoreRepository, BookCoverEventsService, BookCoverStore],
  exports: [BookCoverStoreRepository, BookCoverEventsService, BookCoverStore],
})
export class BookCoverStoreModule {}
