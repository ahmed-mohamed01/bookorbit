import { Module } from '@nestjs/common';

import { BookModule } from '../../book/book.module';
import { LibraryModule } from '../../library/library.module';
import { EpubController } from './epub.controller';
import { EpubMediaStreamService } from './epub-media-stream.service';
import { EpubService } from './epub.service';
import { EpubIndexNarrationService } from './epub-index-narration.service';

@Module({
  imports: [BookModule, LibraryModule],
  controllers: [EpubController],
  // Fork: EpubIndexNarrationService reads plain EPUBs along from their timing index.
  providers: [EpubService, EpubMediaStreamService, EpubIndexNarrationService],
  exports: [EpubService],
})
export class EpubModule {}
