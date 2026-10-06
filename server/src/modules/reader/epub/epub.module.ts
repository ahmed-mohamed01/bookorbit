import { Module } from '@nestjs/common';

import { BookModule } from '../../book/book.module';
import { LibraryModule } from '../../library/library.module';
import { EpubController } from './epub.controller';
import { EpubMediaStreamService } from './epub-media-stream.service';
import { EpubService } from './epub.service';

@Module({
  imports: [BookModule, LibraryModule],
  controllers: [EpubController],
  providers: [EpubService, EpubMediaStreamService],
  exports: [EpubService],
})
export class EpubModule {}
