import { Module } from '@nestjs/common';

import { AudioPlayOrderService } from './audio-play-order.service';
import { CommonModule } from '../../common/common.module';
import { AudiobookChaptersRepository } from './audiobook-chapters.repository';
import { AudiobookChaptersService } from './audiobook-chapters.service';

@Module({
  imports: [CommonModule],
  providers: [AudiobookChaptersRepository, AudiobookChaptersService, AudioPlayOrderService],
  exports: [AudiobookChaptersService, AudioPlayOrderService],
})
export class AudiobookChaptersModule {}
