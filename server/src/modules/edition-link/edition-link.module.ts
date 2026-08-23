import { Module } from '@nestjs/common';

import { BookModule } from '../book/book.module';
import { LibraryModule } from '../library/library.module';
import { EditionLinkController } from './edition-link.controller';
import { EditionLinkRepository } from './edition-link.repository';
import { EditionLinkSchemaBootstrapService } from './edition-link-schema-bootstrap.service';
import { EditionLinkService } from './edition-link.service';

@Module({
  imports: [BookModule, LibraryModule],
  controllers: [EditionLinkController],
  providers: [EditionLinkRepository, EditionLinkSchemaBootstrapService, EditionLinkService],
  exports: [EditionLinkRepository],
})
export class EditionLinkModule {}
