import { AudiobookChaptersModule } from '../audiobook-chapters/audiobook-chapters.module';
import { Module } from '@nestjs/common';

import { AchievementModule } from '../achievement/achievement.module';
import { BookConsolidationModule } from '../book-consolidation/book-consolidation.module';
import { BookModule } from '../book/book.module';
import { JobsModule } from '../jobs/jobs.module';
import { LibraryModule } from '../library/library.module';
import { EpubModule } from '../reader/epub/epub.module';
import { ReadingAlignmentBookConsolidationParticipant } from './reading-alignment-book-consolidation.participant';
import { ReadingAlignmentBuildService } from './reading-alignment-build.service';
import { ReadingAlignmentPairService } from './reading-alignment-pair.service';
import { ReadingAlignmentResolveService } from './reading-alignment-resolve.service';
import { ReadingAlignmentSchemaBootstrapService } from './reading-alignment-schema-bootstrap.service';
import { ReadingAlignmentStatusService } from './reading-alignment-status.service';
import { ReadingAlignmentSyncService } from './reading-alignment-sync.service';
import { ReadingAlignmentController } from './reading-alignment.controller';
import { ReadingAlignmentJobPageRepository } from './reading-alignment-job-page.repository';
import { ReadingAlignmentJobSource } from './reading-alignment-job-source';
import { ReadingAlignmentRepository } from './reading-alignment.repository';
import { WhisperModelService } from './whisper-model.service';
import { WhisperService } from './whisper.service';

@Module({
  imports: [AudiobookChaptersModule, BookConsolidationModule, EpubModule, BookModule, JobsModule, LibraryModule, AchievementModule],
  controllers: [ReadingAlignmentController],
  providers: [
    ReadingAlignmentBookConsolidationParticipant,
    ReadingAlignmentRepository,
    ReadingAlignmentSchemaBootstrapService,
    WhisperModelService,
    WhisperService,
    ReadingAlignmentPairService,
    ReadingAlignmentBuildService,
    ReadingAlignmentResolveService,
    ReadingAlignmentStatusService,
    ReadingAlignmentSyncService,
    ReadingAlignmentJobPageRepository,
    ReadingAlignmentJobSource,
  ],
  exports: [ReadingAlignmentStatusService],
})
export class ReadingAlignmentModule {}
