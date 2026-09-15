import { Module } from '@nestjs/common';

import { AchievementModule } from '../achievement/achievement.module';
import { BookModule } from '../book/book.module';
import { AudiobookController } from './audiobook.controller';
import { AudiobookRepository } from './audiobook.repository';
import { AudiobookService } from './audiobook.service';

@Module({
  imports: [AchievementModule, BookModule],
  controllers: [AudiobookController],
  providers: [AudiobookRepository, AudiobookService],
})
export class AudiobookModule {}
