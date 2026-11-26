import { Module } from '@nestjs/common';

import { BookKnowledgeModule } from '../book-knowledge/book-knowledge.module';
import { BookModule } from '../book/book.module';
import { PositionConverterModule } from '../position-converter/position-converter.module';
import { ReadingHelpModule } from '../reading-help/reading-help.module';
import { StoryGuidesModule } from '../story-guides/story-guides.module';
import { BkXrayReaderController } from './bk-xray-reader.controller';
import { ForkStoryGuideContentController } from './fork-story-guide-content.controller';
import { ForkStoryRecapController } from './fork-story-recap.controller';
import { StoryRecapService } from './story-recap.service';

@Module({
  imports: [StoryGuidesModule, BookKnowledgeModule, BookModule, ReadingHelpModule, PositionConverterModule],
  controllers: [BkXrayReaderController, ForkStoryGuideContentController, ForkStoryRecapController],
  providers: [StoryRecapService],
})
export class ForkStoryGuideModule {}
