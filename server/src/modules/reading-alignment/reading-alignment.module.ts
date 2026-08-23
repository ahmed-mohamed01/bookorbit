import { Module } from '@nestjs/common';

import { AchievementModule } from '../achievement/achievement.module';
import { BookModule } from '../book/book.module';
import { EditionLinkModule } from '../edition-link/edition-link.module';
import { LibraryModule } from '../library/library.module';
import { EpubModule } from '../reader/epub/epub.module';
import { UserModule } from '../user/user.module';
import { ReadingAlignmentBuildService } from './reading-alignment-build.service';
import { ReadingAlignmentPairService } from './reading-alignment-pair.service';
import { ReadingAlignmentResolveService } from './reading-alignment-resolve.service';
import { ReadingAlignmentSchemaBootstrapService } from './reading-alignment-schema-bootstrap.service';
import { ReadingAlignmentStatusService } from './reading-alignment-status.service';
import { ReadingAlignmentSyncService } from './reading-alignment-sync.service';
import { ReadingAlignmentController } from './reading-alignment.controller';
import { ReadingAlignmentRepository } from './reading-alignment.repository';
import { WhisperService } from './whisper.service';

@Module({
  imports: [EpubModule, BookModule, EditionLinkModule, LibraryModule, AchievementModule, UserModule],
  controllers: [ReadingAlignmentController],
  providers: [
    ReadingAlignmentRepository,
    ReadingAlignmentSchemaBootstrapService,
    WhisperService,
    ReadingAlignmentPairService,
    ReadingAlignmentBuildService,
    ReadingAlignmentResolveService,
    ReadingAlignmentStatusService,
    ReadingAlignmentSyncService,
  ],
})
export class ReadingAlignmentModule {}
